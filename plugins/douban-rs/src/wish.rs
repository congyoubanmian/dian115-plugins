//! 豆瓣「想看」同步(整份 `wish.go` 的移植): 从 CookieCloud 或手动粘贴的 cookie 拉取用户的
//! `kind=mark` 列表(电影 + 剧集), 新条目走既有 TMDB 匹配 + 聚合订阅链路。
//!
//! # 路 2(CookieCloud 与想看)的名下文件
//!
//! 本文件与 [`crate::cookiecloud`] 属于同一路: **并行阶段只填这两个文件里的函数体**。
//! 冻结文件(任何一路都不得修改): `lib.rs`、`runtime.rs`、`protocol.rs`、`host.rs`、
//! `store.rs`、`model.rs`、`raw.rs`、`util.rs`、`clock.rs`、`Cargo.toml`。
//! 另外两路的名下文件: 路 1 = `charts.rs` + `poster.rs`, 路 3 = `subscribe.rs`。
//!
//! # 已冻结的调用点
//!
//! - `runtime.rs::action` 的 `wish-sync` → [`Runtime::action_wish_sync`];
//!   `cookiecloud-test` → [`Runtime::action_cookie_cloud_test`]
//! - `runtime.rs::job` 的 `wish-sync` → [`Runtime::sync_wish_list`](第二参数 `true`)
//! - [`crate::charts::Runtime::refresh_now`] 尾部 → [`Runtime::sync_wish_list`]
//! - [`Runtime::douban_cookie`] → [`crate::cookiecloud::Runtime::cookie_cloud_pull`]
//! - [`Runtime::sync_wish_list`] 的 `subscribe_inline` 分支 →
//!   [`crate::subscribe::Runtime::subscribe_queue_item`]
//!
//! # 实现要点(照抄时对照)
//!
//! - 状态结构体 [`WishItem`]/[`crate::model::WishInfo`]/`CookieCache` 已在 `model.rs`(**存储层**)定义好,
//!   这里**不要重复定义** —— 它们同时是持久化文档的字段。
//! - 解析中间结构(Go 的 `wishInterest`/`wishFlexString`)放在本文件并 `pub`:
//!   豆瓣 rexxar 接口的 `subject.id` 时而字符串时而数字, [`WishFlexString`] 必须两种都收;
//!   `subject.year` 可能缺失或是 `null`(夹具 `wish_tv.json` 里那条 book 就没有 `year` 键),
//!   用 [`crate::model::decode`] 解码才有 Go 的"缺失/null → 零值"语义。
//! - 只收 `type` 是 `movie`/`tv` 的条目: 实测 `type=tv` 的响应里混进了 movie 和 book
//!   (夹具里就有那条 book), 书目拿去 TMDB 匹配会订阅到同名电影。
//! - cookie 缓存 TTL 45 分钟, 新鲜度判定用 [`cookie_cache_fresh`]; 它读
//!   [`crate::clock::now_unix_nanos`] 与 [`crate::clock::parse_rfc3339`],
//!   本机测试可用 `clock::testhooks::set_now` 固定时间(`pub(crate)`, 同 crate 可见)。
//! - 时间加法的口径: `due = 现在 + observe_period_hours` 用纳秒算术
//!   (`clock::rfc3339(now_nanos + hours * 3_600_000_000_000)`)。
//! - 拉列表用 [`Runtime::http_get_with_cookie`](`wish.go:334`): 它带 iPhone UA 与
//!   `referer: https://m.douban.com/mine/wish/` —— 与 [`Runtime::http_get`] 的
//!   桌面 UA 不同, 是 m 站接口要求的登录态形态。
//! - Go `wish.go:305` 那段"自动订阅开着就立即到期"的写法很绕: `due` 先取现在,
//!   `auto_subscribe` 为真时**不改**, 为假时才加观察期。照抄即可。

use crate::clock;
use crate::host::HostCallRequest;
use crate::model::{CookieCache, QueueItem, WishItem};
use crate::protocol::OpError;
use crate::runtime::{HttpResult, Runtime};
use crate::store;

/// cookie 缓存 TTL(Go `wish.go:45` `cookieCacheTTL`): 45 分钟。
pub const COOKIE_CACHE_TTL_MS: u64 = 45 * 60 * 1_000;
/// 想看列表分页大小(Go `wish.go:161` 的 `pageSize`)。
pub const WISH_PAGE_SIZE: i64 = 50;
/// 想看列表最多翻几页(Go `wish.go:162` 的 `maxPages`)。
pub const WISH_MAX_PAGES: i64 = 4;
/// 想看接口的 UA(Go `wish.go:340` 的字面量, iPhone Safari)。
pub const WISH_USER_AGENT: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

/// 想看接口的响应(Go `wish.go:171` 的匿名结构)。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct InterestsResponse {
    pub interests: Vec<WishInterest>,
    pub total: i64,
}

/// 单条兴趣(Go `wish.go:147` `wishInterest`)。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct WishInterest {
    pub subject: WishSubject,
}

/// 兴趣里的条目(Go `wish.go:148` 的匿名结构)。`year` 可能缺失或是 `null`。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct WishSubject {
    pub id: WishFlexString,
    pub title: String,
    pub year: String,
    /// movie | tv | book | music ...(只收影视)
    #[serde(rename = "type")]
    pub kind: String,
    pub pic: WishPic,
}

/// 条目图片(Go `wish.go:153` 的匿名结构), 只取 `large`。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct WishPic {
    pub large: String,
}

/// Go `wish.go:127` `wishFlexString`: 豆瓣 rexxar 的 `subject.id` 时而给字符串
/// (`"36808876"`), 时而给数字(`12345`) —— 两种都要收成字符串。
///
/// `null`/空 → 空串(Go 的 `UnmarshalJSON` 分支); 数字按原文收(不引号化, 与 Go 的
/// `string(b)` 一致 —— 本插件只用它拼 `douban_ref`, 数值型不会有小数/指数形态)。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WishFlexString(pub String);

impl WishFlexString {
    /// 取内部的 ref 文本。
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> serde::Deserialize<'de> for WishFlexString {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::Deserialize as _;
        // Go 的 `UnmarshalJSON` 先解成 json.RawMessage: 字符串原样, 数字/布尔取原文。
        let value = serde_json::Value::deserialize(deserializer)?;
        let text = match value {
            serde_json::Value::Null => String::new(),
            serde_json::Value::String(text) => text,
            serde_json::Value::Number(number) => number.to_string(),
            serde_json::Value::Bool(flag) => flag.to_string(),
            other => serde_json::to_string(&other).unwrap_or_default(),
        };
        Ok(WishFlexString(text))
    }
}

/// Go `wish.go:48` `cookieCacheFresh`: `header`/`uid` 都非空且 `fetched_at` 在
/// [`COOKIE_CACHE_TTL_MS`] 之内。
///
/// `fetched_at` 解析失败(空串/脏数据)一律算不新鲜 —— 与 Go 的
/// `err == nil && time.Since(t) < ttl` 一致。
pub fn cookie_cache_fresh(cache: &CookieCache) -> bool {
    if cache.header.is_empty() || cache.uid.is_empty() {
        return false;
    }
    let fetched_at = match clock::parse_rfc3339(&cache.fetched_at) {
        Some(nanos) => nanos,
        None => return false,
    };
    // Go 的 time.Since 是"现在 - 过去", 时间戳在未来时为负 → 仍算新鲜。
    let elapsed = i128::from(clock::now_unix_nanos()) - i128::from(fetched_at);
    elapsed < i128::from(COOKIE_CACHE_TTL_MS) * 1_000_000
}

/// Go `wish.go:99` `parseManualCookie`: 接受整段 cookie 头, 也接受仅 `dbcl2=xxx`;
/// 没有 `=` 或没有 `dbcl2` 时返回 `("", "")`。
///
/// 返回 `(header, uid)`: header 是**原样 trim 过的整段输入**(Go 直接透传 raw),
/// uid 是 `dbcl2` 冒号前的部分。
pub fn parse_manual_cookie(raw: &str) -> (String, String) {
    let raw = raw.trim();
    if raw.is_empty() {
        return (String::new(), String::new());
    }
    if !raw.contains('=') {
        return (String::new(), String::new());
    }
    let mut dbcl2 = "";
    for part in raw.split(';') {
        let mut kv = part.trim().splitn(2, '=');
        let name = kv.next().unwrap_or("");
        let value = match kv.next() {
            Some(value) => value,
            None => continue,
        };
        if name == "dbcl2" {
            dbcl2 = value;
        }
    }
    if dbcl2.is_empty() {
        // 只给了 dbcl2 值本身(含冒号)
        return (String::new(), String::new());
    }
    let uid = dbcl2.splitn(2, ':').next().unwrap_or("").to_string();
    (raw.to_string(), uid)
}

/// Go `wish.go:188` `wishItemsFromInterests`: 兴趣条目 → [`WishItem`]。
///
/// 纯函数(夹具 `wish_movie.json` / `wish_tv.json` 就是它的回归样本):
/// `id` trim 后为空跳过; `type` 不是 `movie`/`tv` 跳过; 其余映射
/// `douban_ref/title/year/type/poster_url`(`added_at` 由调用方补时间戳)。
pub fn wish_items_from_interests(interests: &[WishInterest]) -> Vec<WishItem> {
    let mut items: Vec<WishItem> = Vec::new();
    for interest in interests {
        let id = interest.subject.id.as_str().trim();
        if id.is_empty() {
            continue;
        }
        // 只收影视条目: 豆瓣"想看"混着书/音乐(实测 type=tv 的响应里混进了
        // movie 和 book), 书目拿去 TMDB 匹配会订阅到同名电影。
        let kind = interest.subject.kind.as_str();
        if kind != "movie" && kind != "tv" {
            continue;
        }
        items.push(WishItem {
            douban_ref: id.to_string(),
            title: interest.subject.title.clone(),
            year: interest.subject.year.clone(),
            kind: kind.to_string(),
            poster_url: interest.subject.pic.large.clone(),
            added_at: String::new(),
        });
    }
    items
}

impl Runtime {
    /// Go `wish.go:58` `doubanCookie`: 优先 CookieCloud(带 45 分钟 TTL 缓存), 失败回退
    /// 手动粘贴的 cookie。返回 `(header, uid, source)`, source 是 `cookiecloud` | `manual`。
    ///
    /// 分支与文案逐条对齐: 缓存新鲜直接返回 → 拉取成功写缓存; 拉取成功但没有豆瓣
    /// 登录态 → `CookieCloud 同步数据里没有豆瓣登录 cookie（浏览器需登录 douban.com）`;
    /// 拉取失败但有手动 cookie → 回退 manual; 都没有 →
    /// `未配置 CookieCloud 或手动豆瓣 cookie` 等文案。
    ///
    /// 成功时会把缓存写进 `self.cookie`(前台动作靠它避免重复解密)。
    pub fn douban_cookie(&mut self) -> Result<(String, String, String), OpError> {
        let settings = self.settings.clone();
        let cached = self.cookie.clone();
        if !settings.cookiecloud_url.is_empty()
            && !settings.cookiecloud_uuid.is_empty()
            && !settings.cookiecloud_key.is_empty()
        {
            if cookie_cache_fresh(&cached) {
                return Ok((cached.header, cached.uid, cached.source));
            }
            match self.cookie_cloud_pull(
                &settings.cookiecloud_url,
                &settings.cookiecloud_uuid,
                &settings.cookiecloud_key,
            ) {
                Ok(data) => {
                    let (header, uid, _count) =
                        crate::cookiecloud::douban_cookie_from_cloud(&data);
                    if !header.is_empty() {
                        self.cookie = CookieCache {
                            header: header.clone(),
                            uid: uid.clone(),
                            source: "cookiecloud".to_string(),
                            fetched_at: clock::now_rfc3339(),
                        };
                        return Ok((header, uid, "cookiecloud".to_string()));
                    }
                    return Err(OpError::new(
                        "CookieCloud 同步数据里没有豆瓣登录 cookie（浏览器需登录 douban.com）",
                    ));
                }
                Err(err) => {
                    if settings.manual_cookie.is_empty() {
                        return Err(OpError::new(format!(
                            "CookieCloud 拉取失败: {}",
                            err.message()
                        )));
                    }
                    // CookieCloud 失败但填了手动 cookie → 回退
                    let (header, uid) = parse_manual_cookie(&settings.manual_cookie);
                    if !header.is_empty() {
                        return Ok((header, uid, "manual".to_string()));
                    }
                    return Err(OpError::new(format!(
                        "CookieCloud 拉取失败: {}；手动 cookie 也无效",
                        err.message()
                    )));
                }
            }
        }
        if !settings.manual_cookie.is_empty() {
            let (header, uid) = parse_manual_cookie(&settings.manual_cookie);
            if !header.is_empty() {
                return Ok((header, uid, "manual".to_string()));
            }
            return Err(OpError::new("手动 cookie 里缺少 dbcl2"));
        }
        Err(OpError::new("未配置 CookieCloud 或手动豆瓣 cookie"))
    }

    /// Go `wish.go:160` `fetchWish`: 拉取单类型想看列表(分页, 上限 [`WISH_MAX_PAGES`] 页,
    /// 每页 [`WISH_PAGE_SIZE`] 条)。
    ///
    /// 翻页终止条件与 Go 一致: 本页不足 `pageSize` 或**累计已收条目数** >= `total`
    /// (注意 Go 比较的是过滤后的 `items` 数, 不是 `interests` 数)。
    /// URL: `https://m.douban.com/rexxar/api/v2/user/<uid>/interests?kind=mark&type=<t>&start=<n>&limit=<n>`。
    /// 请求出错时的文案是 `HTTP <status>: <err>`(status 取 [`crate::runtime::HttpResult::status`])。
    pub fn fetch_wish(
        &self,
        header: &str,
        uid: &str,
        want_type: &str,
    ) -> Result<Vec<WishItem>, OpError> {
        let mut items: Vec<WishItem> = Vec::new();
        for page in 0..WISH_MAX_PAGES {
            let url = format!(
                "https://m.douban.com/rexxar/api/v2/user/{uid}/interests?kind=mark&type={want_type}&start={}&limit={}",
                page * WISH_PAGE_SIZE,
                WISH_PAGE_SIZE
            );
            let got = self.http_get_with_cookie(&url, header);
            if let Some(err) = got.error {
                return Err(OpError::new(format!("HTTP {}: {}", got.status, err.message())));
            }
            let parsed: InterestsResponse = match crate::model::decode(&got.body) {
                Some(parsed) => parsed,
                None => {
                    return Err(OpError::new(format!(
                        "响应解析失败: {}",
                        decode_error_text(&got.body)
                    )))
                }
            };
            items.extend(wish_items_from_interests(&parsed.interests));
            if (parsed.interests.len() as i64) < WISH_PAGE_SIZE
                || (items.len() as i64) >= parsed.total
            {
                break;
            }
        }
        Ok(items)
    }

    /// Go `wish.go:334` `httpGetWithCookie`: 带 cookie 的 m 站 GET。
    ///
    /// 头与 Go 一致: `accept: application/json` + [`WISH_USER_AGENT`] +
    /// `referer: https://m.douban.com/mine/wish/` + `cookie: <header>`。
    /// 返回值语义同 [`crate::runtime::HttpResult`](Go 的 `(body, status, err)`)。
    pub fn http_get_with_cookie(&self, full_url: &str, cookie: &str) -> HttpResult {
        let request = HostCallRequest::new("GET", full_url)
            .with_header("accept", "application/json")
            .with_header("user-agent", WISH_USER_AGENT)
            .with_header("referer", "https://m.douban.com/mine/wish/")
            .with_header("cookie", cookie);
        let response = match crate::host::call(&request) {
            Ok(response) => response,
            Err(err) => {
                return HttpResult { body: Vec::new(), status: 0, error: Some(OpError::new(err.0)) }
            }
        };
        if response.status >= 400 {
            return HttpResult {
                body: Vec::new(),
                status: response.status,
                error: Some(OpError::new(format!("HTTP {}", response.status))),
            };
        }
        match store::decode_body(&response) {
            Ok(body) => HttpResult { body, status: response.status, error: None },
            Err(err) => HttpResult {
                body: Vec::new(),
                status: response.status,
                error: Some(OpError::new(err.0)),
            },
        }
    }

    /// Go `wish.go:215` `syncWishList`: 全量同步想看, 已处理的跳过。
    ///
    /// `subscribe_inline = false`(前台动作, ~10s 硬预算)只拉列表 + 入队, 订阅交给后台
    /// 任务; `true`(后台 job)时立刻订阅。流程与文案:
    /// - 未开启 [`crate::model::Settings::wish_sync_enabled`] → 直接返回;
    /// - 取 cookie 失败 → `wish_info` 记 `failed` + 原因, `log("warning", "想看同步跳过: ...")`;
    /// - `movie`/`tv` 各拉一次, 按 `douban_ref` 去重(movie/tv 响应会重叠), 失败时
    ///   `last_error` 记 `<type> 拉取失败: ...`;
    /// - 全失败且一条都没拉到 → 落盘后返回;
    /// - 新条目: `subscribe_inline && auto_subscribe` 时直接
    ///   [`crate::subscribe::Runtime::subscribe_queue_item`], 否则入观察队列
    ///   (`auto_subscribe` 为真时 `due_at` = 现在, 为假时 = 现在 + `observe_period_hours`);
    /// - 收尾: 写 `self.wish`/`self.wish_seen`/`self.wish_info`, `touch()` 让版本号 +1,
    ///   新增 > 0 时 `log("info", "想看同步完成: 共 N 条, 新增 M (已自动订阅/已入观察队列)")`。
    ///
    /// 注意: 入队/订阅用的是**局部构建**的 [`crate::model::QueueItem`] ——
    /// `subscribe_queue_item` 要 `&mut self`, 不能同时借 `self.queue.items`。
    pub fn sync_wish_list(&mut self, invocation_id: &str, subscribe_inline: bool) {
        let settings = self.settings.clone();
        let mut info = self.wish_info.clone();
        let mut seen = self.wish_seen.clone().unwrap_or_default();
        if !settings.wish_sync_enabled {
            return;
        }

        let (header, uid, source) = match self.douban_cookie() {
            Ok(cookie) => cookie,
            Err(err) => {
                info.last_status = "failed".to_string();
                info.last_error = err.message().to_string();
                info.last_sync = clock::now_rfc3339();
                self.wish_info = info;
                self.log("warning", &format!("想看同步跳过: {}", err.message()));
                return;
            }
        };
        info.enabled = true;
        info.uid = uid.clone();
        info.source = source;
        info.last_error = String::new();

        let mut all: Vec<WishItem> = Vec::new();
        let mut merged: std::collections::BTreeMap<String, bool> = std::collections::BTreeMap::new();
        for want_type in ["movie", "tv"] {
            match self.fetch_wish(&header, &uid, want_type) {
                Ok(items) => {
                    // movie/tv 两个查询的响应会重叠(豆瓣对 type 过滤不严格), 按条目去重。
                    for mut item in items {
                        if merged.contains_key(&item.douban_ref) {
                            continue;
                        }
                        merged.insert(item.douban_ref.clone(), true);
                        item.added_at = clock::now_rfc3339();
                        all.push(item);
                    }
                }
                Err(err) => {
                    info.last_status = "failed".to_string();
                    info.last_error = format!("{want_type} 拉取失败: {}", err.message());
                    self.log("warning", &format!("想看({want_type})拉取失败: {}", err.message()));
                }
            }
        }
        if all.is_empty() && info.last_status == "failed" {
            info.last_sync = clock::now_rfc3339();
            self.wish_info = info;
            self.persist_all();
            return;
        }

        let mut new_count: i64 = 0;
        for item in &all {
            if seen.get(&item.douban_ref).copied().unwrap_or(false) {
                continue;
            }
            new_count += 1;
            seen.insert(item.douban_ref.clone(), true);
            if subscribe_inline && settings.auto_subscribe {
                let queued = QueueItem {
                    douban_ref: item.douban_ref.clone(),
                    title: item.title.clone(),
                    list: "wish".to_string(),
                    poster_url: item.poster_url.clone(),
                    url: format!("https://www.douban.com/subject/{}/", item.douban_ref),
                    entered_at: clock::now_rfc3339(),
                    state: "observing".to_string(),
                    ..QueueItem::default()
                };
                let _ = self.subscribe_queue_item(invocation_id, &queued, &settings);
            } else {
                // 前台(或未开自动订阅): 只入观察队列, 到期时间=现在,
                // 由后台任务(wish-sync 每30分钟)接手订阅。
                let duplicate = self
                    .queue
                    .items
                    .as_ref()
                    .map_or(false, |items| items.iter().any(|entry| entry.douban_ref == item.douban_ref));
                if !duplicate {
                    let mut due_at = clock::now_rfc3339();
                    if !settings.auto_subscribe {
                        // 自动订阅开着: 到期立即订(后台接手), 不再等观察期。
                        let now_nanos = clock::now_unix_nanos();
                        let shifted = i128::from(now_nanos)
                            + i128::from(settings.observe_period_hours) * 3_600_000_000_000i128;
                        if shifted > 0 {
                            due_at = clock::rfc3339(shifted as u64);
                        }
                    }
                    let items = self.queue.items.get_or_insert_with(Vec::new);
                    items.push(QueueItem {
                        douban_ref: item.douban_ref.clone(),
                        title: item.title.clone(),
                        list: "wish".to_string(),
                        poster_url: item.poster_url.clone(),
                        url: format!("https://www.douban.com/subject/{}/", item.douban_ref),
                        entered_at: clock::now_rfc3339(),
                        due_at,
                        state: "observing".to_string(),
                        ..QueueItem::default()
                    });
                }
            }
        }

        let count = all.len();
        info.last_sync = clock::now_rfc3339();
        info.last_count = count as i64;
        info.last_new = new_count;
        info.last_status = "succeeded".to_string();
        self.wish = Some(all);
        self.wish_seen = Some(seen);
        self.wish_info = info;
        self.touch();
        if new_count > 0 {
            let suffix = if settings.auto_subscribe { "自动订阅" } else { "入观察队列" };
            self.log(
                "info",
                &format!("想看同步完成: 共 {count} 条, 新增 {new_count} (已{suffix})"),
            );
        }
    }

    /// Go `wish.go:359` `actionCookieCloudTest` —— action `cookiecloud-test`。
    ///
    /// 三个失败分支都是**正常 result**(`{"status":"failed","message":...}`):
    /// 配置不全 → `请先填写 CookieCloud 地址/UUID/密钥并保存`;
    /// 拉取失败 → 错误原文; 解密成功但没 `dbcl2` →
    /// `解密成功(同步 N 个域名, 豆瓣 cookie M 个)，但没有 dbcl2——浏览器需要登录 douban.com`。
    /// 成功 → `{"status":"succeeded","message":"连接成功：同步 N 个域名，豆瓣登录有效 (uid=<uid>)","uid":"<uid>"}`,
    /// 并**顺便预热** `self.cookie` 缓存 + `persist_all()`。
    pub fn action_cookie_cloud_test(&mut self) -> Result<serde_json::Value, OpError> {
        let settings = self.settings.clone();
        if settings.cookiecloud_url.is_empty()
            || settings.cookiecloud_uuid.is_empty()
            || settings.cookiecloud_key.is_empty()
        {
            return Ok(serde_json::json!({
                "status": "failed",
                "message": "请先填写 CookieCloud 地址/UUID/密钥并保存",
            }));
        }
        let data = match self.cookie_cloud_pull(
            &settings.cookiecloud_url,
            &settings.cookiecloud_uuid,
            &settings.cookiecloud_key,
        ) {
            Ok(data) => data,
            Err(err) => {
                return Ok(serde_json::json!({"status": "failed", "message": err.message()}))
            }
        };
        let (header, uid, count) = crate::cookiecloud::douban_cookie_from_cloud(&data);
        if header.is_empty() {
            return Ok(serde_json::json!({
                "status": "failed",
                "message": format!(
                    "解密成功(同步 {} 个域名, 豆瓣 cookie {} 个)，但没有 dbcl2——浏览器需要登录 douban.com",
                    data.len(),
                    count
                ),
            }));
        }
        // 测试成功顺便热身解密缓存, 后续前台同步直接复用
        self.cookie = CookieCache {
            header: header.clone(),
            uid: uid.clone(),
            source: "cookiecloud".to_string(),
            fetched_at: clock::now_rfc3339(),
        };
        self.persist_all();
        Ok(serde_json::json!({
            "status": "succeeded",
            "message": format!("连接成功：同步 {} 个域名，豆瓣登录有效 (uid={})", data.len(), uid),
            "uid": uid,
        }))
    }

    /// Go `wish.go:389` `actionWishSync` —— action `wish-sync`。
    ///
    /// 未开启想看同步 → `{"status":"failed","message":"请先在设置中开启「同步我的想看」"}`;
    /// 同步用第二参数 `self.deep_refresh`(前台只入队、后台才订阅);
    /// 同步失败 → `{"status":"failed","message":<last_error>}`;
    /// 后台成功 → `想看同步完成：共 N 条，新增 M`;
    /// 前台成功 → `想看已同步：共 N 条，新增 M 条已入队；订阅由后台任务自动完成（每 30 分钟检查）`。
    pub fn action_wish_sync(&mut self, invocation_id: &str) -> Result<serde_json::Value, OpError> {
        let enabled = self.settings.wish_sync_enabled;
        let background = self.deep_refresh;
        if !enabled {
            return Ok(serde_json::json!({
                "status": "failed",
                "message": "请先在设置中开启「同步我的想看」",
            }));
        }
        self.sync_wish_list(invocation_id, background);
        let info = self.wish_info.clone();
        if info.last_status != "succeeded" {
            return Ok(serde_json::json!({"status": "failed", "message": info.last_error}));
        }
        if background {
            return Ok(serde_json::json!({
                "status": "succeeded",
                "message": format!("想看同步完成：共 {} 条，新增 {}", info.last_count, info.last_new),
            }));
        }
        Ok(serde_json::json!({
            "status": "succeeded",
            "message": format!(
                "想看已同步：共 {} 条，新增 {} 条已入队；订阅由后台任务自动完成（每 30 分钟检查）",
                info.last_count, info.last_new
            ),
        }))
    }
}

/// 解码失败时回显 serde 的错误文本(Go 那边是 `json.Unmarshal` 的 `%v`)。
fn decode_error_text(raw: &[u8]) -> String {
    match serde_json::from_slice::<InterestsResponse>(raw) {
        Ok(_) => "类型不符".to_string(),
        Err(err) => err.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cookiecloud::test_support::{Route, TestHost};
    use crate::model::CookieCache;
    use serde_json::{json, Value};

    /// 夹具里的时间常量: `2026-09-29T10:00:09Z`。
    const FIXED_NOW: u64 = 1_790_676_009_000_000_000;
    /// 脱敏构造的解密回归向量(与 `tests/cookiecloud_vectors.rs` 共用)。
    const CC_VECTORS: &[u8] = include_bytes!("../tests/fixtures/cookiecloud_vectors.json");

    fn fixed_clock() {
        clock::testhooks::set_now(Some(FIXED_NOW));
    }

    fn cc_vector(name: &str) -> Value {
        let doc: Value = serde_json::from_slice(CC_VECTORS).expect("向量夹具必须能解");
        doc["vectors"]
            .as_array()
            .expect("vectors 必须是数组")
            .iter()
            .find(|vector| vector["name"] == name)
            .unwrap_or_else(|| panic!("夹具里没有向量 {name}"))
            .clone()
    }

    /// CookieCloud 的 `/get/{uuid}` 响应体。
    fn cc_pull_body(name: &str) -> String {
        let vector = cc_vector(name);
        json!({"encrypted": vector["encrypted"], "crypto_type": vector["crypto_type"]}).to_string()
    }

    /// 让 `douban_cookie` 走"CookieCloud 缓存新鲜"的路径(不发任何请求)。
    fn warm_cookie(runtime: &mut Runtime) {
        runtime.settings.cookiecloud_url = "http://127.0.0.1:8088".to_string();
        runtime.settings.cookiecloud_uuid = "cc-test-uuid".to_string();
        runtime.settings.cookiecloud_key = "cc-test-pass".to_string();
        runtime.cookie = CookieCache {
            header: "dbcl2=123456789:testToken; ck=testCk".to_string(),
            uid: "123456789".to_string(),
            source: "cookiecloud".to_string(),
            fetched_at: clock::rfc3339(FIXED_NOW),
        };
    }

    fn fixture_routes() -> Vec<Route> {
        vec![
            Route::json(
                "GET",
                "https://m.douban.com/rexxar/api/v2/user/123456789/interests?kind=mark&type=movie",
                std::str::from_utf8(crate::fixtures::WISH_MOVIE).unwrap(),
            ),
            Route::json(
                "GET",
                "https://m.douban.com/rexxar/api/v2/user/123456789/interests?kind=mark&type=tv",
                std::str::from_utf8(crate::fixtures::WISH_TV).unwrap(),
            ),
        ]
    }

    #[test]
    fn wish_flex_string_accepts_str_number_and_null() {
        #[derive(serde::Deserialize)]
        struct Holder {
            id: WishFlexString,
        }
        let text: Holder = serde_json::from_str(r#"{"id":"36808876"}"#).unwrap();
        assert_eq!(text.id.as_str(), "36808876");
        let number: Holder = serde_json::from_str(r#"{"id":12345}"#).unwrap();
        assert_eq!(number.id.as_str(), "12345", "数字 id 要收成不带引号的原文");
        let big: Holder = serde_json::from_str(r#"{"id":4935623109}"#).unwrap();
        assert_eq!(big.id.as_str(), "4935623109");
        let null: Holder = serde_json::from_str(r#"{"id":null}"#).unwrap();
        assert_eq!(null.id.as_str(), "", "null → 空串(Go 的 UnmarshalJSON 分支)");

        // 字段缺失走 serde(default) → 空串
        let missing: WishSubject = serde_json::from_str(r#"{"title":"某剧集"}"#).unwrap();
        assert_eq!(missing.id.as_str(), "");
        assert_eq!(missing.title, "某剧集");
        assert_eq!(missing.kind, "");

        // 数字型 id 在完整条目里也要能一路映射到 douban_ref
        let interest: WishInterest =
            serde_json::from_str(r#"{"subject":{"id":12345,"title":"某剧集","year":"2026","type":"tv","pic":{}}}"#)
                .unwrap();
        let items = wish_items_from_interests(&[interest]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].douban_ref, "12345");
        assert_eq!(items[0].kind, "tv");
    }

    #[test]
    fn wish_items_from_fixtures_filter_and_map() {
        // movie 夹具: 3 条全是 movie
        let movie: InterestsResponse = crate::model::decode(crate::fixtures::WISH_MOVIE).unwrap();
        assert_eq!(movie.total, 3);
        let items = wish_items_from_interests(&movie.interests);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].douban_ref, "36808876");
        assert_eq!(items[0].title, "奥德赛");
        assert_eq!(items[0].year, "2026");
        assert_eq!(items[0].kind, "movie");
        assert!(items[0].poster_url.starts_with("https://img"));
        assert!(items[0].added_at.is_empty(), "added_at 由调用方补时间戳");

        // tv 夹具: 4 条里混着 1 条 book, 且它的 year 键缺失(要靠 serde(default)/strip_nulls 兜底)
        let tv: InterestsResponse = crate::model::decode(crate::fixtures::WISH_TV).unwrap();
        assert_eq!(tv.total, 4);
        assert_eq!(tv.interests.len(), 4);
        let items = wish_items_from_interests(&tv.interests);
        assert_eq!(items.len(), 3, "book 必须被滤掉");
        assert!(items.iter().all(|item| item.kind == "movie" || item.kind == "tv"));
        assert!(!items.iter().any(|item| item.douban_ref == "26968034"), "书目不得进列表");

        // id 为空白 → 跳过
        let blank: WishInterest =
            serde_json::from_str(r#"{"subject":{"id":"  ","title":"x","type":"movie"}}"#).unwrap();
        assert!(wish_items_from_interests(&[blank]).is_empty());
    }

    #[test]
    fn parse_manual_cookie_cases() {
        let (header, uid) = parse_manual_cookie("  dbcl2=123456789:tok; ck=abc  ");
        assert_eq!(header, "dbcl2=123456789:tok; ck=abc", "header 是 trim 后的整段原文");
        assert_eq!(uid, "123456789");

        let (header, uid) = parse_manual_cookie("dbcl2=999:tok");
        assert_eq!((header.as_str(), uid.as_str()), ("dbcl2=999:tok", "999"));

        // 没有 = / 没有 dbcl2 / 只有 dbcl2 值本身 → 都是空
        assert_eq!(parse_manual_cookie("").0, "");
        assert_eq!(parse_manual_cookie("no-equals").0, "");
        assert_eq!(parse_manual_cookie("ck=abc").0, "");
        assert_eq!(parse_manual_cookie("123456789:tok").0, "");
        // dbcl2 空值 → 也算没有
        assert_eq!(parse_manual_cookie("dbcl2=;ck=x").0, "");
        // dbcl2 没有冒号时 uid 就是整段
        assert_eq!(parse_manual_cookie("dbcl2=999").1, "999");
    }

    #[test]
    fn cookie_cache_fresh_ttl_is_45_minutes() {
        clock::testhooks::set_now(Some(FIXED_NOW));
        let fresh = |offset_minutes: i64| CookieCache {
            header: "dbcl2=x".to_string(),
            uid: "1".to_string(),
            source: "cookiecloud".to_string(),
            fetched_at: clock::rfc3339((FIXED_NOW as i64 - offset_minutes * 60 * 1_000_000_000) as u64),
        };
        assert!(cookie_cache_fresh(&fresh(0)));
        assert!(cookie_cache_fresh(&fresh(44)), "44 分钟内必须新鲜");
        assert!(!cookie_cache_fresh(&fresh(45)), "45 分钟整已过期(Go 是严格小于)");
        assert!(!cookie_cache_fresh(&fresh(60)));
        // 空字段 / 脏时间戳 → 不新鲜
        assert!(!cookie_cache_fresh(&CookieCache::EMPTY));
        let mut broken = fresh(1);
        broken.fetched_at = "garbage".to_string();
        assert!(!cookie_cache_fresh(&broken));
        let mut no_uid = fresh(1);
        no_uid.uid = String::new();
        assert!(!cookie_cache_fresh(&no_uid));
        // 时间戳在未来(时钟回拨)→ Go 的 time.Since 为负, 仍算新鲜
        let future = CookieCache {
            fetched_at: clock::rfc3339(FIXED_NOW + 60 * 1_000_000_000),
            ..fresh(1)
        };
        assert!(cookie_cache_fresh(&future));
        clock::testhooks::set_now(None);
    }

    /// 分页: 满页继续翻, 不足页停; `type=tv` 与 `type=movie` 各拉一次。
    #[test]
    fn fetch_wish_pages_and_request_shape() {
        fixed_clock();
        fn interests_json(count: usize, total: i64, kind: &str, first_id: i64) -> String {
            let items: Vec<Value> = (0..count)
                .map(|index| {
                    json!({"subject": {
                        "id": format!("{}", first_id + index as i64),
                        "title": format!("片{index}"),
                        "year": "2026",
                        "type": kind,
                        "pic": {"large": "https://img.example/x.jpg"}
                    }})
                })
                .collect();
            json!({"interests": items, "total": total}).to_string()
        }
        let movie_base = "https://m.douban.com/rexxar/api/v2/user/123456789/interests?kind=mark&type=movie";
        let tv_base = "https://m.douban.com/rexxar/api/v2/user/123456789/interests?kind=mark&type=tv";
        let host = TestHost::install(vec![
            Route::json("GET", &format!("{movie_base}&start=0"), &interests_json(50, 52, "movie", 1000)),
            Route::json("GET", &format!("{movie_base}&start=50"), &interests_json(2, 52, "movie", 2000)),
            Route::json("GET", &format!("{tv_base}&start=0"), &interests_json(1, 1, "tv", 3000)),
        ]);
        let runtime = Runtime::new();
        let items = runtime.fetch_wish("dbcl2=123456789:t", "123456789", "movie").unwrap();
        assert_eq!(items.len(), 52, "50 + 2 条, 两页都要拉");
        assert_eq!(items[0].douban_ref, "1000");
        assert_eq!(items[51].douban_ref, "2001");
        assert_eq!(host.count("GET", movie_base), 2);

        let request = host.requests().pop().unwrap();
        assert_eq!(request.headers.get("accept").map(String::as_str), Some("application/json"));
        assert_eq!(request.headers.get("user-agent").map(String::as_str), Some(WISH_USER_AGENT));
        assert_eq!(
            request.headers.get("referer").map(String::as_str),
            Some("https://m.douban.com/mine/wish/"),
            "m 站接口要求登录态 referer"
        );
        assert_eq!(request.headers.get("cookie").map(String::as_str), Some("dbcl2=123456789:t"));
        assert!(WISH_USER_AGENT.contains("iPhone"), "移动 UA");

        // 单页就够: 1 条 < pageSize → 不再翻页
        let tv = runtime.fetch_wish("dbcl2=123456789:t", "123456789", "tv").unwrap();
        assert_eq!(tv.len(), 1);
        assert_eq!(tv[0].kind, "tv");
        assert_eq!(host.count("GET", tv_base), 1);
    }

    #[test]
    fn fetch_wish_error_texts_match_go() {
        let base = "https://m.douban.com/rexxar/api/v2/user/123456789/interests";
        // HTTP >= 400 → Go 的 "HTTP %d: %w" 双重前缀
        let _host = TestHost::install(vec![Route::new("GET", base, 500, b"")]);
        let runtime = Runtime::new();
        let err = runtime.fetch_wish("c", "123456789", "movie").unwrap_err();
        assert_eq!(err.message(), "HTTP 500: HTTP 500");
        drop(_host);

        // host.call 失败 → status 0
        let _host = TestHost::install(vec![Route::fail("GET", base)]);
        let runtime = Runtime::new();
        let err = runtime.fetch_wish("c", "123456789", "movie").unwrap_err();
        assert_eq!(err.message(), "HTTP 0: host_call 返回长度 0");
        drop(_host);

        // 响应解析失败
        let _host = TestHost::install(vec![Route::json("GET", base, "not json")]);
        let runtime = Runtime::new();
        let err = runtime.fetch_wish("c", "123456789", "movie").unwrap_err();
        assert!(err.message().starts_with("响应解析失败: "), "实际: {err}");
        drop(_host);

        // 类型不符: interests 是字符串(Go 的 json.Unmarshal 会报错)
        let _host = TestHost::install(vec![Route::json("GET", base, r#"{"interests":"nope"}"#)]);
        let runtime = Runtime::new();
        assert!(runtime.fetch_wish("c", "123456789", "movie").is_err());
    }

    #[test]
    fn douban_cookie_uses_cookiecloud_and_caches() {
        fixed_clock();
        let host = TestHost::install(vec![Route::json(
            "GET",
            "http://127.0.0.1:8088/get/cc-test-uuid",
            &cc_pull_body("legacy_modern_array"),
        )]);
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        runtime.settings.cookiecloud_url = "http://127.0.0.1:8088".to_string();
        runtime.settings.cookiecloud_uuid = "cc-test-uuid".to_string();
        runtime.settings.cookiecloud_key = "cc-test-pass".to_string();

        let (header, uid, source) = runtime.douban_cookie().unwrap();
        assert_eq!(uid, "123456789");
        assert_eq!(source, "cookiecloud");
        assert!(header.contains("dbcl2=123456789:fakeTokenAbCdEf"), "实际: {header}");
        // 缓存已写入状态文档的 cookie 字段
        assert_eq!(runtime.cookie.uid, "123456789");
        assert_eq!(runtime.cookie.source, "cookiecloud");
        assert_eq!(runtime.cookie.fetched_at, "2026-09-29T10:00:09Z");
        assert_eq!(host.count("GET", "http://127.0.0.1:8088/get/"), 1);

        // 第二次: 45 分钟 TTL 内直接命中缓存, 不再拉取
        let (header2, uid2, source2) = runtime.douban_cookie().unwrap();
        assert_eq!(host.count("GET", "http://127.0.0.1:8088/get/"), 1, "缓存新鲜时不得再拉");
        assert_eq!(
            (header2.as_str(), uid2.as_str(), source2.as_str()),
            (header.as_str(), "123456789", "cookiecloud")
        );

        // TTL 过期 → 重新拉取(Go 的 45 分钟)
        clock::testhooks::set_now(Some(FIXED_NOW + 46 * 60 * 1_000_000_000));
        let _ = runtime.douban_cookie().unwrap();
        assert_eq!(host.count("GET", "http://127.0.0.1:8088/get/"), 2, "过期后必须重新拉取");
        clock::testhooks::set_now(None);
    }

    #[test]
    fn douban_cookie_fallback_and_error_texts() {
        fixed_clock();
        // ① 未配置任何 cookie 来源
        let mut runtime = Runtime::new();
        assert_eq!(
            runtime.douban_cookie().unwrap_err().message(),
            "未配置 CookieCloud 或手动豆瓣 cookie"
        );

        // ② 只配了手动 cookie
        runtime.settings.manual_cookie = "  dbcl2=123456789:manual; ck=m  ".to_string();
        let (header, uid, source) = runtime.douban_cookie().unwrap();
        assert_eq!(header, "dbcl2=123456789:manual; ck=m");
        assert_eq!(uid, "123456789");
        assert_eq!(source, "manual");

        // ③ 手动 cookie 没有 dbcl2
        let mut runtime = Runtime::new();
        runtime.settings.manual_cookie = "ck=abc".to_string();
        assert_eq!(runtime.douban_cookie().unwrap_err().message(), "手动 cookie 里缺少 dbcl2");

        // ④ CookieCloud 拉取失败 + 无手动 cookie
        let _host = TestHost::install(vec![Route::fail("GET", "http://127.0.0.1:8088/get/")]);
        let mut runtime = Runtime::new();
        runtime.settings.cookiecloud_url = "http://127.0.0.1:8088".to_string();
        runtime.settings.cookiecloud_uuid = "cc-test-uuid".to_string();
        runtime.settings.cookiecloud_key = "cc-test-pass".to_string();
        assert_eq!(
            runtime.douban_cookie().unwrap_err().message(),
            "CookieCloud 拉取失败: CookieCloud 不可达: host_call 返回长度 0"
        );
        drop(_host);

        // ⑤ CookieCloud 失败 + 手动 cookie 有效 → 回退 manual
        let _host = TestHost::install(vec![Route::fail("GET", "http://127.0.0.1:8088/get/")]);
        let mut runtime = Runtime::new();
        runtime.settings.cookiecloud_url = "http://127.0.0.1:8088".to_string();
        runtime.settings.cookiecloud_uuid = "cc-test-uuid".to_string();
        runtime.settings.cookiecloud_key = "cc-test-pass".to_string();
        runtime.settings.manual_cookie = "dbcl2=123456789:manual".to_string();
        let (header, uid, source) = runtime.douban_cookie().unwrap();
        assert_eq!(
            (header.as_str(), uid.as_str(), source.as_str()),
            ("dbcl2=123456789:manual", "123456789", "manual")
        );
        drop(_host);

        // ⑥ CookieCloud 失败 + 手动 cookie 也无效
        let _host = TestHost::install(vec![Route::fail("GET", "http://127.0.0.1:8088/get/")]);
        let mut runtime = Runtime::new();
        runtime.settings.cookiecloud_url = "http://127.0.0.1:8088".to_string();
        runtime.settings.cookiecloud_uuid = "cc-test-uuid".to_string();
        runtime.settings.cookiecloud_key = "cc-test-pass".to_string();
        runtime.settings.manual_cookie = "ck=abc".to_string();
        assert_eq!(
            runtime.douban_cookie().unwrap_err().message(),
            "CookieCloud 拉取失败: CookieCloud 不可达: host_call 返回长度 0；手动 cookie 也无效"
        );
        drop(_host);

        // ⑦ 解密成功但没有豆瓣登录态
        let _host = TestHost::install(vec![Route::json(
            "GET",
            "http://127.0.0.1:8088/get/cc-test-uuid",
            &cc_pull_body("legacy_no_douban"),
        )]);
        let mut runtime = Runtime::new();
        runtime.settings.cookiecloud_url = "http://127.0.0.1:8088".to_string();
        runtime.settings.cookiecloud_uuid = "cc-test-uuid".to_string();
        runtime.settings.cookiecloud_key = "cc-test-pass".to_string();
        assert_eq!(
            runtime.douban_cookie().unwrap_err().message(),
            "CookieCloud 同步数据里没有豆瓣登录 cookie（浏览器需登录 douban.com）"
        );
    }

    #[test]
    fn sync_wish_list_enqueues_with_observe_period() {
        fixed_clock();
        let host = TestHost::install(fixture_routes());
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        warm_cookie(&mut runtime);
        runtime.settings.wish_sync_enabled = true;
        runtime.settings.auto_subscribe = false;
        runtime.settings.observe_period_hours = 5;

        runtime.sync_wish_list("invocation_0001", false);

        let info = runtime.wish_info.clone();
        assert_eq!(info.last_status, "succeeded");
        assert_eq!(info.last_error, "");
        assert!(info.enabled);
        assert_eq!(info.uid, "123456789");
        assert_eq!(info.source, "cookiecloud");
        assert_eq!(info.last_sync, "2026-09-29T10:00:09Z");
        assert_eq!((info.last_count, info.last_new), (3, 3));

        // movie + tv 两个查询重叠的 3 条被去重
        let wish = runtime.wish.clone().unwrap();
        assert_eq!(wish.len(), 3);
        assert_eq!(
            wish.iter().map(|item| item.douban_ref.as_str()).collect::<Vec<_>>(),
            vec!["36808876", "36809864", "35653205"]
        );
        assert_eq!(wish[0].added_at, "2026-09-29T10:00:09Z");
        assert_eq!(runtime.wish_seen.as_ref().unwrap().len(), 3);
        assert_eq!(host.count("GET", "https://m.douban.com/rexxar/api/v2/user/123456789/interests"), 2);

        // 入观察队列: 3 条, 到期 = 现在 + 观察期(未开自动订阅)
        let queue = runtime.queue.items.clone().unwrap();
        assert_eq!(queue.len(), 3);
        assert_eq!(queue[0].douban_ref, "36808876");
        assert_eq!(queue[0].list, "wish");
        assert_eq!(queue[0].state, "observing");
        assert_eq!(queue[0].entered_at, "2026-09-29T10:00:09Z");
        assert_eq!(queue[0].due_at, "2026-09-29T15:00:09Z", "24h 观察期换成 5h");
        assert_eq!(queue[0].url, "https://www.douban.com/subject/36808876/");
        assert_eq!(queue[0].poster_url, wish[0].poster_url);

        let messages: Vec<String> = runtime
            .logs
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|entry| entry.message)
            .collect();
        assert!(
            messages.contains(&"想看同步完成: 共 3 条, 新增 3 (已入观察队列)".to_string()),
            "{messages:?}"
        );

        // 第二次同步: 都见过了 → 不新增, 队列不重复入队
        runtime.sync_wish_list("invocation_0001", false);
        assert_eq!((runtime.wish_info.last_count, runtime.wish_info.last_new), (3, 0));
        assert_eq!(runtime.queue.items.as_ref().unwrap().len(), 3, "已见条目不得重复入队");

        // 自动订阅开启: 到期时间就是现在(Go 的"立即到期"写法)
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        warm_cookie(&mut runtime);
        runtime.settings.wish_sync_enabled = true;
        runtime.settings.auto_subscribe = true;
        runtime.settings.observe_period_hours = 24;
        runtime.sync_wish_list("invocation_0001", false);
        assert_eq!(runtime.queue.items.as_ref().unwrap()[0].due_at, "2026-09-29T10:00:09Z");
    }

    /// 后台内联订阅: 新条目直接走 TMDB 匹配 + 聚合订阅, 不入队。
    #[test]
    fn sync_wish_list_inline_subscribes() {
        fixed_clock();
        let mut routes = fixture_routes();
        routes.push(Route::json(
            "GET",
            "/api/tmdb/search",
            r#"{"results":[{"id":11,"title":"奥德赛","media_type":"movie","vote_average":7.5},{"id":22,"title":"南京照相馆","media_type":"movie","vote_average":7.5},{"id":33,"title":"人生路不熟","media_type":"movie","vote_average":7.5}]}"#,
        ));
        routes.push(Route::json("GET", "/api/subscribe/pool/intents", r#"{"code":"ok","data":[]}"#));
        routes.push(Route::json(
            "POST",
            "/api/subscribe/pool/intents",
            r#"{"code":"ok","data":{"id":171}}"#,
        ));
        let host = TestHost::install(routes);

        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        warm_cookie(&mut runtime);
        runtime.settings.wish_sync_enabled = true;
        runtime.settings.auto_subscribe = true;
        runtime.sync_wish_list("invocation_0001", true);

        assert_eq!((runtime.wish_info.last_count, runtime.wish_info.last_new), (3, 3));
        assert!(runtime.queue.items.is_none(), "内联订阅不额外入队");
        let history = runtime.history.clone().unwrap();
        assert_eq!(history.len(), 3);
        assert!(history.iter().all(|entry| entry.result == "succeeded" && entry.action == "subscribe"));
        assert_eq!(history[0].intent_id, 171);
        let mut titles: Vec<String> = history.iter().map(|entry| entry.title.clone()).collect();
        titles.sort();
        assert_eq!(titles, vec!["人生路不熟", "南京照相馆", "奥德赛"]);
        assert_eq!(runtime.stats.total, 3);
        assert_eq!(runtime.stats.by_list.as_ref().unwrap().get("wish"), Some(&3));
        assert_eq!(host.count("POST", "/api/subscribe/pool/intents"), 3);

        // 幂等键与请求体照抄 Go
        let request = host
            .requests()
            .into_iter()
            .find(|request| request.method == "POST")
            .expect("必须发过 POST");
        let key = request.headers.get("idempotency-key").cloned().unwrap_or_default();
        assert!(
            key.starts_with("dc-sub-invocation_0001-"),
            "幂等键规则: dc-sub-<safeKey(invocationID)>-<tmdbID>, 实际 {key}"
        );
        let raw = crate::store::decode_body(&crate::host::HostCallResponse {
            status: 200,
            headers: Default::default(),
            body_base64: request.body_base64,
        })
        .unwrap();
        let body: Value = serde_json::from_slice(&raw).unwrap();
        assert_eq!(body["season"], 0, "电影 season=0");
        assert_eq!(body["episode_scope_mode"], "follow");
        assert_eq!(body["media_type"], "movie");

        let messages: Vec<String> = runtime
            .logs
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|entry| entry.message)
            .collect();
        assert!(
            messages.contains(&"想看同步完成: 共 3 条, 新增 3 (已自动订阅)".to_string()),
            "{messages:?}"
        );
    }

    #[test]
    fn sync_wish_list_failure_paths() {
        fixed_clock();
        // ① 未开启: 什么都不做(不取 cookie, 不记失败)
        let mut runtime = Runtime::new();
        runtime.sync_wish_list("invocation_0001", false);
        assert_eq!(runtime.wish_info.last_status, "");
        assert!(runtime.logs.is_none());

        // ② 两种类型都拉取失败 → failed + 最后一条原因, 落盘后返回
        let host = TestHost::install(vec![Route::new(
            "GET",
            "https://m.douban.com/rexxar/api/v2/user/123456789/interests",
            500,
            b"",
        )]);
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        warm_cookie(&mut runtime);
        runtime.settings.wish_sync_enabled = true;
        runtime.sync_wish_list("invocation_0001", false);
        assert_eq!(runtime.wish_info.last_status, "failed");
        assert_eq!(runtime.wish_info.last_error, "tv 拉取失败: HTTP 500: HTTP 500");
        assert_eq!(runtime.wish_info.last_sync, "2026-09-29T10:00:09Z");
        assert!(runtime.wish.is_none(), "全失败时不动 wish 列表");
        assert!(runtime.queue.items.is_none());
        assert!(host.count("PUT", "/api/plugin-runtime/storage/state") >= 1, "全失败也要落盘");
        let messages: Vec<String> = runtime
            .logs
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|entry| entry.message)
            .collect();
        assert!(messages.iter().any(|message| message.starts_with("想看(movie)拉取失败: ")), "{messages:?}");
        assert!(messages.iter().any(|message| message.starts_with("想看(tv)拉取失败: ")), "{messages:?}");
        drop(host);

        // ③ 部分失败: 仍按成功收尾(tv 夹具里 3 条影视)
        let _host = TestHost::install(vec![
            Route::new(
                "GET",
                "https://m.douban.com/rexxar/api/v2/user/123456789/interests?kind=mark&type=movie",
                500,
                b"",
            ),
            Route::json(
                "GET",
                "https://m.douban.com/rexxar/api/v2/user/123456789/interests?kind=mark&type=tv",
                std::str::from_utf8(crate::fixtures::WISH_TV).unwrap(),
            ),
        ]);
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        warm_cookie(&mut runtime);
        runtime.settings.wish_sync_enabled = true;
        runtime.settings.auto_subscribe = false;
        runtime.sync_wish_list("invocation_0001", false);
        assert_eq!(runtime.wish_info.last_status, "succeeded", "拉到一个列表就继续收尾");
        assert_eq!((runtime.wish_info.last_count, runtime.wish_info.last_new), (3, 3));
        drop(_host);

        // ④ 取 cookie 失败 → failed + 原因, 且写一条 warning 日志
        let mut runtime = Runtime::new();
        runtime.settings.wish_sync_enabled = true;
        runtime.sync_wish_list("invocation_0001", false);
        assert_eq!(runtime.wish_info.last_status, "failed");
        assert_eq!(runtime.wish_info.last_error, "未配置 CookieCloud 或手动豆瓣 cookie");
        let messages: Vec<String> = runtime
            .logs
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|entry| entry.message)
            .collect();
        assert!(
            messages.contains(&"想看同步跳过: 未配置 CookieCloud 或手动豆瓣 cookie".to_string()),
            "{messages:?}"
        );
    }

    #[test]
    fn action_cookie_cloud_test_reports_and_warms_cache() {
        fixed_clock();
        // ① 配置不全
        let _host = TestHost::install(vec![]);
        let mut runtime = Runtime::new();
        assert_eq!(
            runtime.action_cookie_cloud_test().unwrap(),
            json!({"status": "failed", "message": "请先填写 CookieCloud 地址/UUID/密钥并保存"})
        );
        drop(_host);

        // ② 成功: 预热缓存 + 落盘
        let host = TestHost::install(vec![Route::json(
            "GET",
            "http://127.0.0.1:8088/get/cc-test-uuid",
            &cc_pull_body("legacy_modern_array"),
        )]);
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        runtime.settings.cookiecloud_url = "http://127.0.0.1:8088".to_string();
        runtime.settings.cookiecloud_uuid = "cc-test-uuid".to_string();
        runtime.settings.cookiecloud_key = "cc-test-pass".to_string();
        let result = runtime.action_cookie_cloud_test().unwrap();
        assert_eq!(
            result,
            json!({
                "status": "succeeded",
                "message": "连接成功：同步 2 个域名，豆瓣登录有效 (uid=123456789)",
                "uid": "123456789"
            })
        );
        assert_eq!(runtime.cookie.uid, "123456789");
        assert_eq!(runtime.cookie.source, "cookiecloud");
        assert!(runtime.cookie.header.contains("dbcl2=123456789:fakeTokenAbCdEf"));
        assert!(host.count("PUT", "/api/plugin-runtime/storage/state") >= 1, "测试成功要落盘缓存");
        drop(host);

        // ③ 解密成功但没有 dbcl2
        let _host = TestHost::install(vec![Route::json(
            "GET",
            "http://127.0.0.1:8088/get/cc-test-uuid",
            &cc_pull_body("legacy_no_douban"),
        )]);
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        runtime.settings.cookiecloud_url = "http://127.0.0.1:8088".to_string();
        runtime.settings.cookiecloud_uuid = "cc-test-uuid".to_string();
        runtime.settings.cookiecloud_key = "cc-test-pass".to_string();
        assert_eq!(
            runtime.action_cookie_cloud_test().unwrap(),
            json!({
                "status": "failed",
                "message": "解密成功(同步 1 个域名, 豆瓣 cookie 0 个)，但没有 dbcl2——浏览器需要登录 douban.com"
            })
        );
        assert_eq!(runtime.cookie, CookieCache::EMPTY, "失败不预热缓存");
        drop(_host);

        // ④ 拉取失败 → 错误原文
        let _host = TestHost::install(vec![Route::fail("GET", "http://127.0.0.1:8088/get/")]);
        let mut runtime = Runtime::new();
        runtime.settings.cookiecloud_url = "http://127.0.0.1:8088".to_string();
        runtime.settings.cookiecloud_uuid = "cc-test-uuid".to_string();
        runtime.settings.cookiecloud_key = "cc-test-pass".to_string();
        assert_eq!(
            runtime.action_cookie_cloud_test().unwrap(),
            json!({"status": "failed", "message": "CookieCloud 不可达: host_call 返回长度 0"})
        );
    }

    #[test]
    fn action_wish_sync_messages() {
        fixed_clock();
        // 未开启
        let _host = TestHost::install(vec![]);
        let mut runtime = Runtime::new();
        assert_eq!(
            runtime.action_wish_sync("invocation_0001").unwrap(),
            json!({"status": "failed", "message": "请先在设置中开启「同步我的想看」"})
        );
        drop(_host);

        // 前台成功(只入队)
        let _host = TestHost::install(fixture_routes());
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        warm_cookie(&mut runtime);
        runtime.settings.wish_sync_enabled = true;
        runtime.settings.auto_subscribe = false;
        assert_eq!(
            runtime.action_wish_sync("invocation_0001").unwrap(),
            json!({
                "status": "succeeded",
                "message": "想看已同步：共 3 条，新增 3 条已入队；订阅由后台任务自动完成（每 30 分钟检查）"
            })
        );
        drop(_host);

        // 后台成功(deep_refresh 由 job 置位, 这里直接置)
        let _host = TestHost::install(fixture_routes());
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        warm_cookie(&mut runtime);
        runtime.settings.wish_sync_enabled = true;
        runtime.settings.auto_subscribe = false;
        runtime.deep_refresh = true;
        assert_eq!(
            runtime.action_wish_sync("invocation_0001").unwrap(),
            json!({"status": "succeeded", "message": "想看同步完成：共 3 条，新增 3"})
        );
        drop(_host);

        // 同步失败 → failed + last_error 原文
        let mut runtime = Runtime::new();
        runtime.settings.wish_sync_enabled = true;
        assert_eq!(
            runtime.action_wish_sync("invocation_0001").unwrap(),
            json!({"status": "failed", "message": "未配置 CookieCloud 或手动豆瓣 cookie"})
        );
    }

    /// 冻结调用点: job 的 `wish-sync` 必须只返回 accepted, 且真的同步了想看。
    #[test]
    fn wish_sync_job_through_dispatch_returns_accepted() {
        fixed_clock();
        let _host = TestHost::install(fixture_routes());
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        warm_cookie(&mut runtime);
        runtime.settings.wish_sync_enabled = true;
        runtime.settings.auto_subscribe = false;
        let payload = json!({"id": "wish-sync"});
        let result = runtime
            .job("invocation_0001", crate::raw::RawPayload::Value(&payload))
            .unwrap();
        assert_eq!(result["status"], "accepted");
        assert_eq!(result["message"], "想看与到期订阅已处理");
        assert_eq!(runtime.wish_info.last_status, "succeeded");
        assert_eq!(runtime.wish_info.last_new, 3);
        assert!(!runtime.deep_refresh, "job 结束必须复位 deepRefresh");

        // 未开启想看同步时 job 也返回 accepted(只是不做事)
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let result = runtime
            .job("invocation_0001", crate::raw::RawPayload::Value(&payload))
            .unwrap();
        assert_eq!(result["status"], "accepted");
    }
}

