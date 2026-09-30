//! 运行时(对照 Go `main.go:193` 的 `runtime` 结构)。
//!
//! 本文件是**冻结的接线层**, 并行移植阶段不得修改:
//! - 状态文档的加载 [`Runtime::load_all`]: 三态(loaded/fresh/unavailable)、404 两次确认、
//!   加载失败禁止落盘、账号键覆盖、旧版分键迁移、`diag` 面包屑;
//! - 落盘 [`Runtime::persist_all`]: 只保留最近 40 条日志、超过 4MiB 放弃、失败期间拒绝写;
//! - 设置写入 [`Runtime::settings_update`]: 榜单合并保存(空对象忽略)、账号字段 trim +
//!   解密缓存作废 + 独立 `account` 键;
//! - `state` 读取: 把内存里的真实状态按 Go 的字段/裁剪规则吐给宿主;
//! - **action 分发表**([`Runtime::action`], Go `main.go:1624`)与 **job 分发表**
//!   ([`Runtime::job`], Go `main.go:2022`): 每个动作/任务都已挂到最终函数
//!   (骨架模块里是 `todo!()`, 由三路工程师填体); 只依赖接线的最小动作
//!   (`observe-remove`/`blacklist-add`/`blacklist-remove`/`open-source`/`send-test`)
//!   在本文件内已实现;
//! - **共享出站 HTTP**([`Runtime::http_get`], Go `main.go:565`): 榜单/海报/CookieCloud
//!   都要用的带豆瓣 Referer 的 GET, 一次性实现, 三路直接调用。
//!
//! 与 Go 的差异(逐条记录在阶段结果里):
//! - Go 用 `sync.Mutex` 保护状态: wasip1 单线程下它其实不参与任何并发(真正的并发只在
//!   `dian115:process@1` 进程模式里)。wasm 插件是单线程 reactor, 这里用 `&mut self`
//!   表达同一约束, 不引入锁。
//! - Go 的日志/历史用 `append` 就地扩容, 这里是 `Vec`, 语义相同。
//! - `newRuntime` 里"全新安装写默认配置"的那段在 Go 里于 `loadAll` 之后**不可达**
//!   (loadAll 一定把 Lists 补成默认值), 属于死代码, 未移植。
//! - Go 的 `hostCall` 只是 `wasmHostCall` 的转发, 这里直接用 [`crate::host::call`]。

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use crate::clock;
use crate::host::{self, HostCallRequest};
use crate::model::{
    self, BlackState, CookieCache, HistoryEntry, LogEntry, PersistedState, Queue, Settings,
    Snapshot, Stats, WishInfo, WishItem,
};
use crate::protocol::OpError;
use crate::raw::{self, RawPayload};
use crate::store::{self, LoadResult, PutIds};
use crate::util;

/// 持久化预算(Go `main.go:25` `maxPersistBytes`): 单键超过这个大小就放弃本次落盘。
pub const MAX_PERSIST_BYTES: usize = 4 << 20;
/// 落盘时只保留最近多少条日志(Go `main.go:26` `persistLogLimit`)。
pub const PERSIST_LOG_LIMIT: usize = 40;
/// 单条日志长度上限(Go `main.go:27` `logMessageLimit`)。
pub const LOG_MESSAGE_LIMIT: usize = 400;
/// 状态响应里历史/日志的裁剪上限(Go `main.go:1540` 的 30/50)。
pub const STATE_HISTORY_LIMIT: usize = 30;
pub const STATE_LOGS_LIMIT: usize = 50;

/// 运行时状态。
#[derive(Debug, Default)]
pub struct Runtime {
    // ── 状态文档(Go `persistedState` 的内存形态) ──
    pub(crate) settings: Settings,
    pub(crate) snapshot: Snapshot,
    pub(crate) queue: Queue,
    /// Go 的 `[]HistoryEntry`: nil → `null`, 空 → `[]`(靠 [`model::GoSlice`] 表达)。
    pub(crate) history: model::GoSlice<HistoryEntry>,
    pub(crate) logs: model::GoSlice<LogEntry>,
    pub(crate) stats: Stats,
    pub(crate) black_state: BlackState,
    pub(crate) wish: Option<Vec<WishItem>>,
    pub(crate) wish_seen: Option<BTreeMap<String, bool>>,
    pub(crate) wish_info: WishInfo,
    pub(crate) cookie: CookieCache,
    /// 已删除不重订的墓碑集(功能 3; 键 = `douban_ref`)。判定/读写在本文件里只做
    /// 接线(读文档/写文档/清空), 全部语义在 [`crate::filter`]。
    pub(crate) no_resub: crate::filter::NoResubMap,
    /// 上次墓碑扫描时间(RFC3339; 功能 3 的节流字段, 落在状态文档新键
    /// `no_resub_scan_at` 上, 见 [`crate::filter::NO_RESUB_SCAN_MIN_INTERVAL_NANOS`])。
    pub(crate) no_resub_scan_at: String,

    // ── 运行期字段 ──
    revision: u64,
    last_status: String,
    last_message: String,
    /// 最近一次榜单抓取时间(Go `runtime.lastRun`, `main.go:1228`): `refreshNow` 写。
    pub(crate) last_run: String,
    /// 刷新互斥(Go `runtime.refreshing`, `main.go:1147`): 防重入, [`crate::charts::Runtime::refresh_now`] 读写。
    pub(crate) refreshing: bool,
    /// 后台任务标志(Go `runtime.deepRefresh`, `main.go:209`): 预算 8 分钟, 允许逐条补海报。
    /// 由 [`Runtime::job`] 置位、[`crate::charts`] 与 [`crate::wish`] 读取。
    pub(crate) deep_refresh: bool,
    /// 海报 dataURL 缓存(Go `runtime.posterCache`, `main.go:213`): 不落盘, [`crate::poster`] 独占。
    pub(crate) poster_cache: BTreeMap<String, String>,

    /// 宿主存储是否成功加载过(或确认为全新安装)。
    /// `false` 期间 `persist_all` 不落盘, 防止默认值覆盖用户配置。
    storage_ok: bool,
    load_warned: bool,
    /// `ensure_loaded` 闸门: 对应 Go `wasm.go:67` 的 `guestRT == nil`(整个 worker 会话只加载一次)。
    loaded: bool,
    /// PUT 幂等键序列。
    put_ids: PutIds,
}

/// 豆瓣网页抓取的桌面 UA(Go `main.go:571` 的字面量, `httpGet` 固定带它)。
pub const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/// Go `httpGet`/`httpGetWithCookie` 的返回值三元组 `(body, status, err)`。
///
/// Go 在**出错时也返回 status**(host.call 失败是 0, HTTP >= 400 是那个状态码),
/// 调用方的错误文案与分支都依赖它(`wish.go:169` 的 `"HTTP %d: %w"`、
/// `cookiecloud.go:40` 的 `status == 200 && ...`), 因此这里保留三态而不是 `Result`:
///
/// ```
/// let got = runtime.http_get(url, accept);
/// if let Some(err) = got.error { return Err(err); }
/// let body = got.body;
/// ```
///
/// 只需 `?` 的调用方用 [`HttpResult::into_result`]。
#[derive(Debug, Clone)]
pub struct HttpResult {
    /// 已按 `decodeBody` 解出的响应体; 失败时为空(Go 的 `nil`)。
    pub body: Vec<u8>,
    /// HTTP 状态码; host.call 失败时为 0(Go 的零值)。
    pub status: i32,
    /// `None` 表示成功; 否则是 Go 那句错误的原文(`HTTP 404` / host.call 的错误串)。
    pub error: Option<OpError>,
}

impl HttpResult {
    /// 成功 → `Ok((body, status))`; 失败 → `Err(error)`(丢弃 status, 文案与 Go 一致)。
    pub fn into_result(self) -> Result<(Vec<u8>, i32), OpError> {
        match self.error {
            Some(error) => Err(error),
            None => Ok((self.body, self.status)),
        }
    }
}

impl Runtime {
    /// 静态构造: 供 wasm 入口的 `static RUNTIME` 使用(不能有堆分配)。
    pub const fn new() -> Self {
        Runtime {
            settings: Settings::EMPTY,
            snapshot: Snapshot::EMPTY,
            queue: Queue::EMPTY,
            history: None,
            logs: None,
            stats: Stats::EMPTY,
            black_state: BlackState::EMPTY,
            wish: None,
            wish_seen: None,
            wish_info: WishInfo::EMPTY,
            cookie: CookieCache::EMPTY,
            no_resub: None,
            no_resub_scan_at: String::new(),
            revision: 0,
            last_status: String::new(),
            last_message: String::new(),
            last_run: String::new(),
            refreshing: false,
            deep_refresh: false,
            poster_cache: BTreeMap::new(),
            storage_ok: false,
            load_warned: false,
            loaded: false,
            put_ids: PutIds::new(),
        }
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// 宿主存储是否已成功加载(或确认全新安装)。`false` 期间一切落盘都被拒绝。
    pub fn storage_ok(&self) -> bool {
        self.storage_ok
    }

    // ─────────────────────────── 加载 ───────────────────────────

    /// 首次业务调用时加载宿主存储 —— Go `wasm.go:67` `ensureGuest()`。
    ///
    /// 初始化握手(`runtime.initialize`)期间**不能**走这里: 宿主禁止那时的 host.call 重入。
    pub fn ensure_loaded(&mut self) {
        if self.loaded {
            return;
        }
        self.loaded = true;
        self.load_all();
    }

    /// 加载整份状态(Go `main.go:292` `loadAll`)。
    pub fn load_all(&mut self) {
        let (raw, load_result) = store::load_state_with_retry();
        let raw = raw.unwrap_or_default();

        // 不变量: 只有"成功解析出已有状态"或"404 两次确认的全新安装"才允许落盘。
        let mut restored = false;
        if !raw.is_empty() {
            if let Some(document) = PersistedState::parse(&raw) {
                // Go: doc.Settings.Lists != nil —— 缺失/null 的 lists 说明这不是本插件的状态
                if document.is_recognizable() {
                    restored = true;
                    self.apply_document(document);
                }
            }
        }
        self.storage_ok = restored || load_result == LoadResult::Fresh;

        if restored {
            // 文档已套用
        } else if load_result == LoadResult::Unavailable {
            // 状态不确定: 内存里的默认值仅供展示, storage_ok=false 挡住一切落盘
        } else if self.settings.lists.is_none() {
            // 迁移旧的分键持久化格式(每个键一次读取)
            self.load_legacy_keys();
        }
        if self.settings.lists.is_none() {
            self.settings = model::default_settings();
        }
        if self.stats.by_list.is_none() {
            self.stats.by_list = Some(BTreeMap::new());
        }
        let (account_bytes, overlay) = self.load_account_overlay();
        self.normalize_settings();
        self.trace_detail(
            "load",
            &[
                ("state_bytes", Value::from(raw.len())),
                ("state_result", Value::from(load_result.name())),
                ("restored", Value::from(restored)),
                ("account_bytes", Value::from(account_bytes)),
                ("overlay", Value::from(overlay)),
            ],
        );
    }

    fn apply_document(&mut self, document: PersistedState) {
        self.settings = document.settings;
        self.snapshot = document.snapshot;
        self.queue = document.queue;
        self.history = document.history;
        self.logs = document.logs;
        self.stats = document.stats;
        self.black_state = document.blackstate;
        self.wish = document.wish;
        self.wish_seen = document.wish_seen;
        self.wish_info = document.wish_info;
        self.cookie = document.cookie;
        self.no_resub = document.no_resub;
        self.no_resub_scan_at = document.no_resub_scan_at;
    }

    /// 旧版分键持久化迁移(Go `main.go:317` 的 `loadJSON` 系列)。
    fn load_legacy_keys(&mut self) {
        if let Some(value) = load_json::<Settings>("settings") {
            self.settings = value;
        }
        if let Some(value) = load_json::<Snapshot>("snapshot") {
            self.snapshot = value;
        }
        if let Some(value) = load_json::<Queue>("queue") {
            self.queue = value;
        }
        if let Some(value) = load_json::<model::GoSlice<HistoryEntry>>("history") {
            self.history = value;
        }
        if let Some(value) = load_json::<model::GoSlice<LogEntry>>("logs") {
            self.logs = value;
        }
        if let Some(value) = load_json::<Stats>("stats") {
            self.stats = value;
        }
        if let Some(value) = load_json::<BlackState>("blackstate") {
            self.black_state = value;
        }
    }

    /// 用独立账号键覆盖 settings 的账号字段(Go `main.go:352` `loadAccountOverlay`)。
    ///
    /// 只覆盖**非空**字段: 账号键里没填的项不能把状态文档里的值抹掉。
    /// 返回 `(读到的字节数, 是否真的套用了覆盖)` —— 供诊断面包屑使用。
    pub fn load_account_overlay(&mut self) -> (usize, bool) {
        let (raw, ok) = store::get(store::ACCOUNT_KEY);
        if !ok || raw.is_empty() {
            return (raw.len(), false);
        }
        let account: Settings = match model::decode(&raw) {
            Some(account) => account,
            None => return (raw.len(), false),
        };
        let applied = account.has_account_fields();
        if !account.cookiecloud_url.is_empty() {
            self.settings.cookiecloud_url = account.cookiecloud_url;
        }
        if !account.cookiecloud_uuid.is_empty() {
            self.settings.cookiecloud_uuid = account.cookiecloud_uuid;
        }
        if !account.cookiecloud_key.is_empty() {
            self.settings.cookiecloud_key = account.cookiecloud_key;
        }
        if !account.manual_cookie.is_empty() {
            self.settings.manual_cookie = account.manual_cookie;
        }
        if account.wish_sync_enabled {
            self.settings.wish_sync_enabled = true;
        }
        (raw.len(), applied)
    }

    /// 只在 settingsUpdate 时写账号键(Go `main.go:382` `saveAccount`)。
    pub fn save_account(&mut self) {
        let account = Settings {
            cookiecloud_url: self.settings.cookiecloud_url.clone(),
            cookiecloud_uuid: self.settings.cookiecloud_uuid.clone(),
            cookiecloud_key: self.settings.cookiecloud_key.clone(),
            manual_cookie: self.settings.manual_cookie.clone(),
            wish_sync_enabled: self.settings.wish_sync_enabled,
            ..Settings::EMPTY
        };
        if let Ok(raw) = serde_json::to_vec(&account) {
            let _ = store::put(&mut self.put_ids, store::ACCOUNT_KEY, &raw);
        }
    }

    /// 设置防呆(Go `main.go:401` `normalizeSettingsLocked`): 即将上映强制 coming_html 来源,
    /// 并把缺失的榜单键从默认配置补回(状态未加载时保存会丢键)。
    pub fn normalize_settings(&mut self) {
        let defaults = model::default_settings();
        let mut lists = self.settings.lists.take().unwrap_or_default();
        if let Some(default_lists) = defaults.lists {
            for (key, config) in default_lists {
                lists.entry(key).or_insert(config);
            }
        }
        let mut upcoming = lists.get(list_upcoming()).cloned().unwrap_or_default();
        if upcoming.source != "coming_html" || upcoming.kind != "movie" {
            upcoming.source = "coming_html".to_string();
            upcoming.kind = "movie".to_string();
            upcoming.sort = String::new();
            upcoming.tag = String::new();
            if upcoming.limit <= 0 {
                upcoming.limit = 20;
            }
            upcoming.enabled = true;
            lists.insert(list_upcoming().to_string(), upcoming);
        }
        self.settings.lists = Some(lists);
    }

    // ─────────────────────────── 落盘 ───────────────────────────

    /// 落盘整份状态(Go `main.go:424` `persistAll`)。
    pub fn persist_all(&mut self) {
        if !self.storage_ok {
            let (raw, load_result) = store::load_state_with_retry();
            if load_result == LoadResult::Loaded {
                let document = raw.as_deref().and_then(PersistedState::parse);
                match document {
                    Some(document) if document.is_recognizable() => {
                        if self.settings.lists.is_none() {
                            self.settings = document.settings;
                        }
                        self.storage_ok = true;
                    }
                    _ => {
                        // 读到了值, 但它不是本插件的状态文档(响应格式变化/值损坏)。
                        // 继续落盘就会用内存里的默认值覆盖宿主里已有数据 —— 2026-09-28 的
                        // 实际事故就是宿主信封格式变化触发了这条路径。
                        if !self.load_warned {
                            self.load_warned = true;
                            self.log(
                                "warning",
                                "宿主存储内容无法识别, 本次改动暂不落盘(避免覆盖已有数据)",
                            );
                        }
                        return;
                    }
                }
            } else if load_result == LoadResult::Fresh {
                self.storage_ok = true;
            } else {
                if !self.load_warned {
                    self.load_warned = true;
                    self.log(
                        "warning",
                        "宿主存储持续不可读, 本次改动暂不落盘(避免覆盖已有配置)",
                    );
                }
                return;
            }
        }

        // 大对象序列化会把线性内存顶到宿主限额, 因此只保留最近少量日志。
        // Go `main.go:464`: `logTail := make([]LogEntry, 0, persistLogLimit)` ——
        // r.logs 是 nil 时(log 从没写过、archive 之后)落盘文档里也是 `[]`, 不是 `null`。
        let mut log_tail: Vec<LogEntry> = Vec::with_capacity(PERSIST_LOG_LIMIT);
        if let Some(logs) = &self.logs {
            if !logs.is_empty() {
                let start = logs.len().saturating_sub(PERSIST_LOG_LIMIT);
                log_tail.extend_from_slice(&logs[start..]);
            }
        }
        let document = PersistedState {
            settings: self.settings.clone(),
            snapshot: self.snapshot.clone(),
            queue: self.queue.clone(),
            history: self.history.clone(),
            logs: Some(log_tail),
            stats: self.stats.clone(),
            blackstate: self.black_state.clone(),
            wish: self.wish.clone(),
            wish_seen: self.wish_seen.clone(),
            wish_info: self.wish_info.clone(),
            cookie: self.cookie.clone(),
            no_resub: self.no_resub.clone(),
            no_resub_scan_at: self.no_resub_scan_at.clone(),
        };
        let data = match serde_json::to_vec(&document) {
            Ok(data) => data,
            Err(err) => {
                let message = format!("持久化失败: marshal:{err}");
                self.log("warning", &message);
                return;
            }
        };
        if data.len() > MAX_PERSIST_BYTES {
            let message = format!("持久化跳过: 状态过大 {}B", data.len());
            self.log("warning", &message);
            return;
        }
        if let Err(err) = store::put(&mut self.put_ids, store::STATE_KEY, &data) {
            let message = format!("持久化失败: {err}");
            self.log("warning", &message);
        }
    }

    // ─────────────────────────── 运行期辅助 ───────────────────────────

    /// 写一条运行日志(Go `main.go:1077` `log`)。
    pub fn log(&mut self, level: &str, message: &str) {
        let mut message = message.to_string();
        if message.len() > LOG_MESSAGE_LIMIT {
            // Go 逐字节回退到合法 UTF-8 边界后追加 "…(截断)"
            let mut cut = LOG_MESSAGE_LIMIT;
            while cut > 0 && !message.is_char_boundary(cut) {
                cut -= 1;
            }
            message = format!("{}…(截断)", &message[..cut]);
        }
        let logs = self.logs.get_or_insert_with(Vec::new); // Go: append(nil, x) → 非 nil
        logs.push(LogEntry {
            at: clock::now_rfc3339(),
            level: level.to_string(),
            message,
        });
        let max = self.settings.max_logs;
        if max > 0 && self.logs.as_ref().map_or(0, |logs| logs.len()) > max as usize {
            let logs = self.logs.as_mut().expect("上面刚判断过非空");
            let cut = logs.len() - max as usize;
            logs.drain(..cut);
        }
        self.revision += 1;
    }

    /// 写一条极轻量的诊断面包屑(单键覆盖写, Go `main.go:1103` `traceDetail`)。
    ///
    /// 宿主若在某次 host.call 期间直接杀掉 worker(不留 panic 输出), 事后仍可从
    /// `plugin_kv` 的 `diag` 键看出最后成功执行到哪一步。
    pub fn trace_detail(&mut self, step: &str, extra: &[(&str, Value)]) {
        let mut payload = Map::new();
        payload.insert("at".to_string(), Value::String(clock::now_rfc3339()));
        payload.insert("step".to_string(), Value::String(step.to_string()));
        for (key, value) in extra {
            payload.insert((*key).to_string(), value.clone());
        }
        if let Ok(data) = serde_json::to_vec(&Value::Object(payload)) {
            let _ = store::put(&mut self.put_ids, store::DIAG_KEY, &data);
        }
    }

    /// [`Runtime::trace_detail`] 的无附加字段形式(Go `main.go:1098` `trace`)。
    pub fn trace(&mut self, step: &str) {
        self.trace_detail(step, &[]);
    }

    pub fn bump(&mut self, status: &str, message: &str) {
        self.revision += 1;
        self.last_status = status.to_string();
        self.last_message = message.to_string();
    }

    /// 仅递增状态版本号, 用于任意状态变更后让宿主感知。
    pub fn touch(&mut self) {
        self.revision += 1;
    }

    // ─────────────────────────── 出站 HTTP(三路共用) ───────────────────────────

    /// 豆瓣网页/接口 GET(Go `main.go:565` `httpGet`)。**已实现, 三路直接调用。**
    ///
    /// 固定带 `user-agent`(桌面 Chrome)与 `referer: https://movie.douban.com/` ——
    /// 豆瓣图片 CDN 防盗链: 少了 Referer 会返回 418。
    /// 语义与 Go 逐条一致: host.call 失败 → `status=0` + err; `status >= 400` →
    /// 空 body + `HTTP <status>`; `decodeBody` 失败 → 空 body + 解码错误。
    pub fn http_get(&self, url: &str, accept: &str) -> HttpResult {
        let request = HostCallRequest::new("GET", url)
            .with_header("accept", accept)
            .with_header("user-agent", BROWSER_USER_AGENT)
            .with_header("referer", "https://movie.douban.com/");
        let response = match host::call(&request) {
            Ok(response) => response,
            Err(err) => {
                return HttpResult {
                    body: Vec::new(),
                    status: 0,
                    error: Some(OpError::new(err.0)),
                };
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
            Ok(body) => HttpResult {
                body,
                status: response.status,
                error: None,
            },
            Err(err) => HttpResult {
                body: Vec::new(),
                status: response.status,
                error: Some(OpError::new(err.0)),
            },
        }
    }

    /// 按豆瓣 ref 找回条目链接(Go `main.go:1989` `findSourceURL`)。**已实现。**
    ///
    /// 先查榜单快照, 再查观察队列; 都没有返回空串。
    /// Go 遍历 `map` 是随机序(同一条目出现在多个榜单时会取到不同的 URL), 这里按
    /// 榜单键的字典序取第一个 —— 结果确定且与 Go 的常见情形一致。
    pub fn find_source_url(&self, douban_ref: &str) -> String {
        if let Some(lists) = &self.snapshot.lists {
            for items in lists.values() {
                for item in items.iter().flatten() {
                    if item.douban_ref == douban_ref {
                        return item.url.clone();
                    }
                }
            }
        }
        if let Some(items) = &self.queue.items {
            for item in items {
                if item.douban_ref == douban_ref {
                    return item.url.clone();
                }
            }
        }
        String::new()
    }

    // ─────────────────────────── 协议入口 ───────────────────────────

    /// 对应 Go `main.go:1513` `stateResult`。
    pub fn state(&mut self, payload: RawPayload<'_>) -> Result<Value, OpError> {
        let obj = payload.as_object().map_err(|_| invalid_state())?;
        // Go 会解析 view(当前未使用)与 if_none_match; 类型不符都算 payload 非法。
        let _view = raw::string_field(obj, "view").map_err(|_| invalid_state())?;
        let if_none_match = raw::string_field(obj, "if_none_match").map_err(|_| invalid_state())?;

        let version = format!("state-v{}", self.revision);
        let etag = format!("\"{version}\"");
        if if_none_match == etag {
            return Ok(json!({"not_modified": true, "etag": etag}));
        }
        Ok(json!({
            "state_version": version,
            "etag": etag,
            "state": sanitize_state(self.state_doc()),
        }))
    }

    /// 宿主 state 响应里的 `state` 字段(Go `main.go:1546` 的 map 组装)。
    ///
    /// 注意 Go 会先 `json.Marshal` 再 `Unmarshal` 成 `map[string]any` 才净化, 所以最终
    /// 响应里**所有**对象的键都是字典序 —— 这里用 `serde_json::Value`(BTreeMap)组装,
    /// 天然一致。
    /// state 响应的 settings 视图脱敏(2026-09-30 宿主新校验):
    /// 宿主递归拒绝包含 "cookie" 的 key(process-runtime-v1.md §4, 防密钥经状态通道
    /// 传到 UI/日志)。凭据字段一律不回显: URL/UUID 改名预填, 密钥/手动 cookie 只回
    /// "已配置"布尔。持久化存储(plugin_kv)不受此限制, 字段原名保留。
    pub(crate) fn sanitize_settings_view(settings: &model::Settings) -> Value {
        let mut value = to_value(settings);
        if let Some(obj) = value.as_object_mut() {
            let url = obj
                .get("cookiecloud_url")
                .cloned()
                .unwrap_or(Value::String(String::new()));
            let uuid = obj
                .get("cookiecloud_uuid")
                .cloned()
                .unwrap_or(Value::String(String::new()));
            let key_set = obj
                .get("cookiecloud_key")
                .and_then(|v| v.as_str())
                .map_or(false, |s| !s.is_empty());
            let manual_set = obj
                .get("manual_cookie")
                .and_then(|v| v.as_str())
                .map_or(false, |s| !s.is_empty());
            obj.remove("cookiecloud_url");
            obj.remove("cookiecloud_uuid");
            obj.remove("cookiecloud_key");
            obj.remove("manual_cookie");
            obj.insert("cc_url".to_string(), url);
            obj.insert("cc_uuid".to_string(), uuid);
            obj.insert("cc_key_set".to_string(), Value::Bool(key_set));
            obj.insert("cc_manual_set".to_string(), Value::Bool(manual_set));
        }
        value
    }

    pub(crate) fn state_doc(&self) -> Value {
        // Go cloneSettings: Lists 保证非 nil 空 map, Blacklist/SubscribeSources 保持原样
        let mut settings = self.settings.clone();
        settings.lists = Some(settings.lists.clone().unwrap_or_default());
        // Go cloneSettings 用 `append([]string(nil), ...)`: nil 与空切片都得到 nil(→ null)
        settings.blacklist = go_copy_seq(&settings.blacklist);
        settings.subscribe_source_filter = go_copy_seq(&settings.subscribe_source_filter);
        // Go cloneSnapshot: Lists 保证非 nil, 每个榜单同样走 `append([]ChartItem(nil), ...)`
        let snapshot = Snapshot {
            fetched_at: self.snapshot.fetched_at.clone(),
            lists: Some(
                self.snapshot
                    .lists
                    .clone()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(key, items)| (key, go_copy_seq(&items)))
                    .collect(),
            ),
        };
        // Go `make([]HistoryEntry, len(...)) + copy` → 结果永远非 nil(空也是 [])
        let history: Vec<HistoryEntry> = self
            .history
            .clone()
            .unwrap_or_default()
            .into_iter()
            .take(STATE_HISTORY_LIMIT)
            .collect();
        let logs: Vec<LogEntry> = self
            .logs
            .clone()
            .unwrap_or_default()
            .into_iter()
            .take(STATE_LOGS_LIMIT)
            .collect();
        // Go: make([]WishItem, len(r.wish)) —— 空也是 []
        let wish: Vec<WishItem> = self.wish.clone().unwrap_or_default();

        let mut state = Map::new();
        state.insert(
            "status".to_string(),
            Value::String(self.last_status.clone()),
        );
        state.insert(
            "last_message".to_string(),
            Value::String(self.last_message.clone()),
        );
        state.insert("last_run".to_string(), Value::String(self.last_run.clone()));
        state.insert("revision".to_string(), Value::from(self.revision));
        state.insert("snapshot".to_string(), to_value(&snapshot));
        state.insert("blacklist".to_string(), to_value(&self.black_state));
        state.insert("observe_queue".to_string(), {
            let mut queue = Map::new();
            // Go cloneQueue 的 `append([]QueueItem(nil), ...)` → 空也是 null
            queue.insert(
                "items".to_string(),
                to_value(&go_copy_seq(&self.queue.items)),
            );
            Value::Object(queue)
        });
        state.insert("history".to_string(), to_value(&history));
        state.insert("logs".to_string(), to_value(&logs));
        state.insert("stats".to_string(), to_value(&self.stats));
        state.insert(
            "settings".to_string(),
            Runtime::sanitize_settings_view(&settings),
        );
        state.insert("wish".to_string(), to_value(&wish));
        state.insert("wish_info".to_string(), to_value(&self.wish_info));
        // 功能 3: 墓碑集暴露给 UI(state 响应只有这里能给前端看; 空表 → null)。
        state.insert("no_resub".to_string(), to_value(&self.no_resub));
        Value::Object(state)
    }

    /// 对应 Go `main.go:1614` `action` —— **分发表已冻结**, 每个动作都挂到最终函数。
    ///
    /// | action id | 落地函数 | 归属 |
    /// |-----------|----------|------|
    /// | `refresh` | [`crate::charts::Runtime::refresh_now`] | 路 1 |
    /// | `subscribe` | [`crate::subscribe::Runtime::subscribe_from_snapshot`] | 路 3 |
    /// | `subscribe-now` | [`crate::subscribe::Runtime::subscribe_queue_now`] | 路 3 |
    /// | `observe-remove` / `blacklist-add` / `blacklist-remove` / `open-source` / `send-test` | 本文件(接线级, 已实现) | — |
    /// | `settings-update` / `archive` | 本文件(存储层阶段已实现) | — |
    /// | `get-poster` | [`crate::poster::Runtime::get_poster`] | 路 1 |
    /// | `cookiecloud-test` | [`crate::wish::Runtime::action_cookie_cloud_test`] | 路 2 |
    /// | `wish-sync` | [`crate::wish::Runtime::action_wish_sync`] | 路 2 |
    /// | `no-resub-clear` | [`crate::filter::Runtime::action_no_resub_clear`] | 功能 3 |
    /// | 其他 | Go `main.go:1712` 的 `unknown_action` | — |
    ///
    /// 业务失败是**正常 result**(`{"status":"failed",...}`), 不是 JSON-RPC error;
    /// 只有 payload 本身非法(`invalid action payload`)才走 `-32602`。
    pub fn action(
        &mut self,
        invocation_id: &str,
        payload: RawPayload<'_>,
    ) -> Result<Value, OpError> {
        let obj = payload.as_object().map_err(|_| invalid_action())?;
        let id = raw::string_field(obj, "id").map_err(|_| invalid_action())?;
        if id.is_empty() {
            return Err(invalid_action());
        }
        // Go `_ = json.Unmarshal(payload.Input, &input)`: 解不出来(缺失/类型不符)就是空 map
        let input: Map<String, Value> = match obj.and_then(|map| map.get("input")) {
            Some(Value::Object(input)) => input.clone(),
            _ => Map::new(),
        };
        // Go `input["douban_ref"].(string)`: 类型断言失败就是 ""(非字符串/缺失都算)
        let douban_ref = input
            .get("douban_ref")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        match id.as_str() {
            "refresh" => {
                // Go `main.go:1625`: wasip1 单线程, 同步执行(不能起 goroutine)
                if let Err(err) = self.refresh_now(invocation_id) {
                    self.log("error", &format!("手动刷新失败: {err}"));
                    self.bump("failed", &format!("手动刷新失败: {err}"));
                    return Ok(
                        json!({"status": "failed", "message": format!("手动刷新失败: {err}")}),
                    );
                }
                Ok(json!({"status": "succeeded", "message": "榜单刷新完成"}))
            }
            "subscribe" => {
                if douban_ref.is_empty() {
                    return Ok(json!({"status": "failed", "message": "缺少 douban_ref"}));
                }
                self.subscribe_from_snapshot(invocation_id, &douban_ref)
            }
            "subscribe-now" => {
                if douban_ref.is_empty() {
                    return Ok(json!({"status": "failed", "message": "缺少 douban_ref"}));
                }
                self.subscribe_queue_now(invocation_id, &douban_ref)
            }
            "observe-remove" => {
                // Go `main.go:1648`: 原地过滤(`kept := Items[:0]`), 顺序不变;
                // nil 队列保持 nil, 非 nil 队列即使清空也仍是 `[]`
                let kept = self.queue.items.as_ref().map(|items| {
                    items
                        .iter()
                        .filter(|item| item.douban_ref != douban_ref)
                        .cloned()
                        .collect()
                });
                self.queue.items = kept;
                self.persist_all();
                self.bump("succeeded", "已从观察队列移除");
                Ok(json!({"status": "succeeded", "message": "已从观察队列移除"}))
            }
            "blacklist-add" => {
                let keyword = util::string_val(input.get("keyword")).trim().to_string();
                if keyword.is_empty() {
                    return Ok(json!({"status": "failed", "message": "关键词不能为空"}));
                }
                let blacklist = self.settings.blacklist.get_or_insert_with(Vec::new);
                if blacklist.iter().any(|existing| existing == &keyword) {
                    // Go `main.go:1668`: 已存在时不落盘也不改状态
                    return Ok(json!({"status": "succeeded", "message": "关键词已存在"}));
                }
                blacklist.push(keyword.clone());
                self.persist_all();
                self.bump("succeeded", &format!("已添加黑名单关键词：{keyword}"));
                Ok(
                    json!({"status": "succeeded", "message": format!("已添加黑名单关键词：{keyword}")}),
                )
            }
            "blacklist-remove" => {
                let keyword = util::string_val(input.get("keyword")).trim().to_string();
                // Go `main.go:1679`: 与添加不同, 这里不校验空关键词(nil 队列仍保持 nil)
                let kept = self.settings.blacklist.as_ref().map(|items| {
                    items
                        .iter()
                        .filter(|item| *item != &keyword)
                        .cloned()
                        .collect()
                });
                self.settings.blacklist = kept;
                self.persist_all();
                self.bump("succeeded", &format!("已移除黑名单关键词：{keyword}"));
                Ok(
                    json!({"status": "succeeded", "message": format!("已移除黑名单关键词：{keyword}")}),
                )
            }
            "settings-update" => Ok(self.settings_update(&input)),
            "archive" => Ok(self.archive()),
            "open-source" => {
                let url = self.find_source_url(&douban_ref);
                if url.is_empty() {
                    return Ok(json!({"status": "failed", "message": "未找到对应豆瓣条目"}));
                }
                Ok(json!({"status": "succeeded", "message": "豆瓣来源已生成", "url": url}))
            }
            "send-test" => {
                // Go `main.go:1701`: 宿主 /api/notifications/plugin 拒绝所有插件通知 payload
                Ok(json!({
                    "status": "skipped",
                    "message": "通知功能已停用（宿主通知通道不可用），不会发送 Telegram 消息"
                }))
            }
            "get-poster" => self.get_poster(&input),
            "cookiecloud-test" => self.action_cookie_cloud_test(),
            "wish-sync" => self.action_wish_sync(invocation_id),
            // 功能 3: 清空"已删除不重订"墓碑集(落地函数在 `filter.rs`)。
            "no-resub-clear" => Ok(self.action_no_resub_clear()),
            _ => Ok(json!({"status": "failed", "code": "unknown_action", "message": "未知动作"})),
        }
    }

    /// 对应 Go `main.go:2007` `job` —— **分发表已冻结**。
    ///
    /// 进入任务前把 `self.deep_refresh` 置位(后台预算 8 分钟, 允许逐条补海报),
    /// 结束时复位(Go 用 `defer`, 这里顺序置回)。
    ///
    /// | job id | 落地函数 | 归属 |
    /// |--------|----------|------|
    /// | `refresh-charts` | [`crate::charts::Runtime::refresh_now`] | 路 1 |
    /// | `wish-sync` | [`crate::wish::Runtime::sync_wish_list`] + [`crate::subscribe::Runtime::process_due`] | 路 2 / 路 3 |
    /// | 其他 | Go `main.go:2043` 的"未声明的任务" | — |
    ///
    /// 注意与 `state`/`action` 不同: job 的提示语是**正常 result**, 不是 JSON-RPC error。
    pub fn job(&mut self, invocation_id: &str, payload: RawPayload<'_>) -> Result<Value, OpError> {
        self.deep_refresh = true;
        let result = self.job_dispatch(invocation_id, payload);
        self.deep_refresh = false;
        result
    }

    /// [`Runtime::job`] 的分发表本体(Go `main.go:2016` 起的 switch)。
    fn job_dispatch(
        &mut self,
        invocation_id: &str,
        payload: RawPayload<'_>,
    ) -> Result<Value, OpError> {
        let obj = match payload.as_object() {
            Ok(obj) => obj,
            // Go: `json.Unmarshal(raw, &payload) != nil` → "任务参数无效"
            Err(_) => return Ok(json!({"status": "skipped", "message": "任务参数无效"})),
        };
        let id = match raw::string_field(obj, "id") {
            Ok(id) => id,
            Err(_) => return Ok(json!({"status": "skipped", "message": "任务参数无效"})),
        };
        match id.as_str() {
            "refresh-charts" => {
                if let Err(err) = self.refresh_now(invocation_id) {
                    self.log("error", &format!("定时刷新失败: {err}"));
                    self.bump("failed", &format!("定时刷新失败: {err}"));
                    return Ok(
                        json!({"status": "skipped", "message": format!("定时刷新失败: {err}")}),
                    );
                }
                Ok(json!({"status": "accepted", "message": "榜单定时刷新完成"}))
            }
            "wish-sync" => {
                // Go `main.go:2030`: 轻量后台任务 —— 刷 cookie 缓存 + 想看同步(含订阅)
                // + 到期观察条目订阅。订阅类操作只能活在后台预算里。
                let settings = self.settings.clone();
                if settings.wish_sync_enabled {
                    self.sync_wish_list(invocation_id, true);
                }
                let _ = self.process_due(invocation_id, &settings);
                // [功能2/3] 墓碑判定(模块头"判定流程"第 6 条): 到期条目处理完之后扫一次
                //   历史, 把"订阅成功过但宿主池已查不到"的条目写进墓碑集;
                //   节流 >= 6 小时(`no_resub_scan_at` 落在状态文档新键上)。
                if self.no_resub_scan_due() {
                    self.resolve_no_resub_from_history();
                    self.no_resub_scan_at = clock::now_rfc3339();
                }
                self.persist_all();
                Ok(json!({"status": "accepted", "message": "想看与到期订阅已处理"}))
            }
            _ => Ok(json!({"status": "skipped", "message": "未声明的任务"})),
        }
    }

    /// 对应 Go `main.go:2047` `event`: 只认有 topic 的事件, 原样收下 data。
    pub fn event(&mut self, payload: RawPayload<'_>) -> Result<Value, OpError> {
        let obj = payload.as_object().map_err(|_| invalid_event())?;
        let topic = raw::string_field(obj, "topic").map_err(|_| invalid_event())?;
        if topic.is_empty() {
            return Err(invalid_event());
        }
        Ok(json!({"accepted": true}))
    }

    // ─────────────────────────── 设置更新 ───────────────────────────

    /// 对应 Go `main.go:1898` `settingsUpdate`。
    pub fn settings_update(&mut self, patch: &Map<String, Value>) -> Value {
        let mut old = self.settings.clone();

        if let Some(value) = patch.get("lists") {
            if let Ok(lists) =
                serde_json::from_value::<BTreeMap<String, model::ListConfig>>(value.clone())
            {
                // 合并而不是整块替换: UI 在插件状态未加载时保存会送来缺键甚至空的 lists,
                // 整块替换会静默清掉用户的榜单配置(2026-09-29 实际发生)。空对象直接忽略。
                if !lists.is_empty() {
                    let mut merged = old.lists.clone().unwrap_or_default();
                    for (key, config) in lists {
                        merged.insert(key, config);
                    }
                    old.lists = Some(merged);
                }
            }
        }
        if let Some(value) = patch.get("blacklist") {
            // Go: `var bl []string; json.Unmarshal(v, &bl)` —— null 解成 nil(清空),
            // 类型不符则整块忽略。
            match value {
                Value::Null => old.blacklist = None,
                _ => {
                    if let Ok(blacklist) = serde_json::from_value::<Vec<String>>(value.clone()) {
                        old.blacklist = Some(blacklist);
                    }
                }
            }
        }
        // 账号字段: trim 后写入; 任一账号字段变化都要作废解密缓存。
        // 新版 UI 不回显凭据, 用 cc_* 字段: URL/UUID 直接写;
        // cc_key/cc_manual 留空 = 保持已存值(密钥不再经浏览器往返)。
        let mut account_changed = false;
        // 旧字段名先应用, cc_* 后应用(两者同时出现时以 cc_* 为准)
        for (key, target) in [
            ("cookiecloud_url", &mut old.cookiecloud_url),
            ("cookiecloud_uuid", &mut old.cookiecloud_uuid),
            ("cookiecloud_key", &mut old.cookiecloud_key),
            ("manual_cookie", &mut old.manual_cookie),
        ] {
            if let Some(Value::String(text)) = patch.get(key) {
                *target = text.trim().to_string();
                account_changed = true;
            }
        }
        for (key, target, keep_if_empty) in [
            ("cc_url", &mut old.cookiecloud_url, false),
            ("cc_uuid", &mut old.cookiecloud_uuid, false),
            ("cc_key", &mut old.cookiecloud_key, true),
            ("cc_manual", &mut old.manual_cookie, true),
        ] {
            if let Some(Value::String(text)) = patch.get(key) {
                let trimmed = text.trim().to_string();
                if !keep_if_empty || !trimmed.is_empty() {
                    *target = trimmed;
                }
                account_changed = true;
            }
        }
        if account_changed {
            self.cookie = CookieCache::EMPTY;
        }
        if let Some(value) = patch.get("wish_sync_enabled") {
            if let Some(flag) = value.as_bool() {
                old.wish_sync_enabled = flag;
            }
        }
        if let Some(value) = patch.get("observe_period_hours") {
            if let Some(hours) = value.as_f64() {
                old.observe_period_hours = hours as i64;
            }
        }
        if let Some(value) = patch.get("auto_subscribe") {
            if let Some(flag) = value.as_bool() {
                old.auto_subscribe = flag;
            }
        }
        if let Some(value) = patch.get("notify_on_subscribe") {
            if let Some(flag) = value.as_bool() {
                old.notify_on_subscribe = flag;
            }
        }
        // 功能 2: 订阅过滤器三项。数值只在"非负有限"时接受(负数当脏数据忽略);
        // `regions` 与 blacklist 同款语义: `null` 清空(nil), 类型不符整块忽略,
        // 数组逐项 trim 后丢弃空项(空数组 = 不限)。
        if let Some(value) = patch.get("min_rating") {
            if let Some(rate) = value.as_f64() {
                if rate.is_finite() && rate >= 0.0 {
                    old.min_rating = rate;
                }
            }
        }
        if let Some(value) = patch.get("min_year") {
            if let Some(year) = value.as_f64() {
                // 数值非法时忽略(契约): 除"非负有限"外还要落在 i32 里 —— 越界数值
                // (如直连 settings-update 传 3e9)经 `as i32` 会饱和成 i32::MAX,
                // 等于给所有条目加了不可能通过的年份过滤且无任何报错。
                if year.is_finite() && year >= 0.0 && year <= i32::MAX as f64 {
                    old.min_year = year as i32;
                }
            }
        }
        if let Some(value) = patch.get("regions") {
            match value {
                Value::Null => old.regions = None,
                _ => {
                    if let Ok(regions) = serde_json::from_value::<Vec<String>>(value.clone()) {
                        old.regions = Some(
                            regions
                                .into_iter()
                                .map(|region| region.trim().to_string())
                                .filter(|region| !region.is_empty())
                                .collect(),
                        );
                    }
                }
            }
        }
        if let Some(value) = patch.get("subscribe_source_filter") {
            match value {
                Value::Null => old.subscribe_source_filter = None,
                _ => {
                    if let Ok(sources) = serde_json::from_value::<Vec<String>>(value.clone()) {
                        old.subscribe_source_filter = Some(sources);
                    }
                }
            }
        }

        self.settings = old;
        self.normalize_settings();
        self.persist_all();
        self.save_account();
        self.bump("succeeded", "设置已保存");
        json!({"status": "succeeded", "message": "设置已保存"})
    }

    /// 对应 Go `main.go:1977` `archive`: 清历史/日志/黑名单命中, 重置统计后落盘。
    ///
    /// **功能 3 明确不清 `no_resub` 墓碑集**: 历史会被归档抹掉, 但"用户删过这个订阅"是
    /// 独立于历史的事实, 跟着归档消失就会在下一轮自动重订 —— 要清只能走 action
    /// `no-resub-clear`(见 [`crate::filter`] 的"池消费式"说明)。
    pub fn archive(&mut self) -> Value {
        self.history = None; // Go: r.history = nil
        self.logs = None; // Go: r.logs = nil
        self.black_state = BlackState {
            keywords: self.black_state.keywords.clone(),
            hits: 0,
            recent: None,
        };
        self.stats = Stats {
            total: 0,
            month_new: 0,
            month: String::new(),
            by_list: Some(BTreeMap::new()),
            last_archive_at: clock::now_rfc3339(),
        };
        self.persist_all();
        self.bump("succeeded", "已归档历史与日志");
        json!({"status": "succeeded", "message": "已归档历史与日志"})
    }
}

/// 榜单键 `upcoming`(Go `main.go:81` `listUpcoming`)。
pub(crate) fn list_upcoming() -> &'static str {
    "upcoming"
}

/// Go `loadJSON`: 键存在就解, 解不出来保持原值。
fn load_json<T: serde::de::DeserializeOwned>(key: &str) -> Option<T> {
    let (raw, ok) = store::get(key);
    if !ok {
        return None;
    }
    model::decode(&raw)
}

fn to_value<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// Go `append([]T(nil), value...)` 的等价物: **nil 与空切片都得到 nil**(→ `null`)。
///
/// 状态响应里的 `cloneSettings`/`cloneSnapshot`/`cloneQueue` 都走这条路径, 所以那里的
/// "空"是 `null`; 而 `history`/`logs`/`wish` 用的是 `make([]T, n)`, 空就是 `[]`。
/// 存储文档里的 `[]` 与 `null` 则保持原样 —— 这是两回事。
fn go_copy_seq<T: Clone>(value: &model::GoSlice<T>) -> model::GoSlice<T> {
    value.as_ref().filter(|items| !items.is_empty()).cloned()
}

fn invalid_state() -> OpError {
    OpError::new("invalid state payload")
}

fn invalid_action() -> OpError {
    OpError::new("invalid action payload")
}

fn invalid_event() -> OpError {
    OpError::new("invalid event payload")
}

/// 对应 Go `main.go:1577` `sanitizeState`: 递归清除任何会被宿主判定为"绝对路径"的字符串
/// (豆瓣封面是相对路径 `/pXXX.jpg`, 直接混进 state 会被宿主安全过滤以 502 拒绝整个响应)。
pub fn sanitize_state(value: Value) -> Value {
    match value {
        Value::String(s) => {
            if looks_like_abs_path(&s) {
                Value::String(String::new())
            } else {
                Value::String(s)
            }
        }
        Value::Array(items) => Value::Array(items.into_iter().map(sanitize_state).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (k, sanitize_state(v)))
                .collect(),
        ),
        other => other,
    }
}

/// 对应 Go `main.go:1599` `looksLikeAbsPath`。
pub fn looks_like_abs_path(s: &str) -> bool {
    s.len() >= 2 && s.starts_with('/') && !s.starts_with("//")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{EnvelopeStyle, FakeHost};

    /// 夹具里的 time 常量: `2026-09-29T10:00:09Z`。
    const FIXED_NOW: u64 = 1_790_676_009_000_000_000;

    fn fixture_host() -> FakeHost {
        let host = FakeHost::new();
        host.set(store::STATE_KEY, crate::fixtures::STATE);
        host
    }

    fn fixed_clock() {
        clock::testhooks::set_now(Some(FIXED_NOW));
    }

    /// diag 面包屑的 JSON 体(从 `{"value": ...}` 请求体里解出)。
    ///
    /// 宿主可用时直接读已落盘的 body; 宿主不可读(`fail_all`)时 PUT 拿不到响应,
    /// 就从"尝试过的请求"里把请求体解回来 —— 面包屑恰恰是那种场景下唯一的证据。
    fn diag_body(host: &FakeHost) -> Value {
        let raw = match host.last_put_body(store::DIAG_KEY) {
            Some(raw) => raw,
            None => {
                let request = host
                    .requests()
                    .into_iter()
                    .rev()
                    .find(|request| request.method == "PUT" && request.path.ends_with("/diag"))
                    .expect("必须尝试写过 diag");
                crate::store::decode_body(&crate::host::HostCallResponse {
                    status: 200,
                    headers: Default::default(),
                    body_base64: request.body_base64,
                })
                .expect("diag 请求体必须能解码")
            }
        };
        let parsed: Value = serde_json::from_slice(&raw).unwrap();
        parsed["value"].clone()
    }

    fn state_body(host: &FakeHost) -> Value {
        let raw = host
            .last_put_body(store::STATE_KEY)
            .expect("必须写过 state");
        let parsed: Value = serde_json::from_slice(&raw).unwrap();
        parsed["value"].clone()
    }

    /// 日志文本(Go 的 nil slice 语义: `None` 表示一条都还没有)。
    fn log_messages(runtime: &Runtime) -> Vec<String> {
        runtime
            .logs
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|entry| entry.message)
            .collect()
    }

    #[test]
    fn load_all_restores_fixture_from_host_envelope() {
        fixed_clock();
        let host = fixture_host();
        let _guard = host.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();

        assert!(runtime.storage_ok(), "读到状态文档后必须允许落盘");
        assert_eq!(runtime.settings.lists.as_ref().unwrap().len(), 5);
        assert_eq!(runtime.queue.items.as_ref().unwrap().len(), 109);
        assert_eq!(runtime.wish.as_ref().unwrap().len(), 3);
        assert_eq!(runtime.wish_info.uid, "123456789");
        assert_eq!(runtime.logs.as_ref().unwrap().len(), 40);
        // 账号键不存在 → 不覆盖
        assert_eq!(runtime.settings.cookiecloud_uuid, "uuid-test");
        assert!(runtime.settings.wish_sync_enabled);

        // 面包屑: {at, step, state_bytes, state_result, restored, account_bytes, overlay}
        let diag = diag_body(&host);
        assert_eq!(diag["step"], "load");
        assert_eq!(diag["at"], "2026-09-29T10:00:09Z");
        assert_eq!(diag["state_result"], "loaded");
        assert_eq!(diag["restored"], true);
        assert_eq!(diag["state_bytes"], crate::fixtures::STATE.len());
        assert_eq!(diag["account_bytes"], 0);
        assert_eq!(diag["overlay"], false);
        assert_eq!(
            diag.as_object().unwrap().len(),
            7,
            "字段集合必须恰好是这 7 个: {diag}"
        );

        // state() 必须把这些数据如实吐出来(键名/裁剪与 Go 一致)
        let state = runtime.state(RawPayload::Null).unwrap();
        assert_eq!(state["state_version"], "state-v0");
        assert_eq!(state["etag"], "\"state-v0\"");
        let doc = &state["state"];
        assert_eq!(doc["settings"]["lists"]["hot"]["tag"], "热门");
        assert_eq!(doc["observe_queue"]["items"].as_array().unwrap().len(), 109);
        assert_eq!(doc["history"].as_array().unwrap().len(), 3);
        assert_eq!(doc["logs"].as_array().unwrap().len(), 40);
        assert_eq!(doc["stats"]["by_list"]["wish"], 3);
        assert_eq!(doc["wish"].as_array().unwrap().len(), 3);
        assert_eq!(doc["blacklist"]["keywords"], Value::Null);
        // 夹具里的 uid 是脱敏值
        assert_eq!(doc["wish_info"]["uid"], "123456789");
    }

    #[test]
    fn load_all_restores_fixture_from_legacy_flat_and_bare() {
        for style in [EnvelopeStyle::LegacyFlat, EnvelopeStyle::Bare] {
            fixed_clock();
            let host = fixture_host();
            host.envelope_style(style);
            let _guard = host.install();
            let mut runtime = Runtime::new();
            runtime.ensure_loaded();
            assert!(runtime.storage_ok(), "{style:?} 也必须能加载");
            assert_eq!(
                runtime.settings.lists.as_ref().unwrap().len(),
                5,
                "{style:?} 必须还原 lists"
            );
            assert_eq!(diag_body(&host)["state_result"], "loaded", "{style:?}");
            assert_eq!(diag_body(&host)["restored"], true, "{style:?}");
        }
    }

    /// 宿主响应是补 padding 的 base64 时同样要能加载(ask 第 1 条)。
    #[test]
    fn load_all_works_with_padded_base64_responses() {
        fixed_clock();
        let host = fixture_host();
        host.base64_padded(true);
        let _guard = host.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        assert!(runtime.storage_ok());
        assert_eq!(runtime.queue.items.as_ref().unwrap().len(), 109);
    }

    #[test]
    fn load_all_fresh_install_keeps_storage_writable_and_does_not_write() {
        fixed_clock();
        let host = FakeHost::new();
        host.get_status(404);
        let _guard = host.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();

        assert!(runtime.storage_ok(), "404 两次确认 = 全新安装, 允许落盘");
        assert_eq!(
            runtime.settings.lists.as_ref().unwrap().len(),
            5,
            "默认榜单"
        );
        assert_eq!(runtime.settings.max_logs, 200);
        assert_eq!(runtime.stats.by_list, Some(BTreeMap::new()));
        // 加载本身不写 state 键(只写 diag 面包屑)
        assert_eq!(host.puts().len(), 1);
        assert_eq!(host.puts()[0].key, "diag");
        let diag = diag_body(&host);
        assert_eq!(diag["state_result"], "fresh");
        assert_eq!(diag["restored"], false);
        assert_eq!(diag["state_bytes"], 0);
    }

    #[test]
    fn load_all_unavailable_forbids_persist() {
        fixed_clock();
        let host = FakeHost::new();
        host.fail_all(true);
        let _guard = host.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();

        assert!(!runtime.storage_ok(), "读不到状态时必须禁止落盘");
        let diag = diag_body(&host);
        assert_eq!(diag["state_result"], "unavailable");
        assert_eq!(diag["restored"], false);

        // 此时保存设置: 状态键绝不能写(默认值覆盖用户配置的事故路径)
        let host = FakeHost::new();
        host.fail_all(true);
        let _guard = host.install();
        let mut patch = Map::new();
        patch.insert(
            "lists".to_string(),
            json!({"hot": {"source": "subjects_json"}}),
        );
        let result = runtime.settings_update(&patch);
        assert_eq!(result["status"], "succeeded");
        let attempted_puts: Vec<String> = host
            .requests()
            .iter()
            .filter(|request| request.method == "PUT")
            .map(|request| request.path.clone())
            .collect();
        assert!(
            attempted_puts.iter().all(|path| !path.ends_with("/state")),
            "加载失败期间禁止写状态键, 实际尝试: {attempted_puts:?}"
        );
        let messages = log_messages(&runtime);
        assert!(
            messages
                .iter()
                .any(|message| message.contains("宿主存储持续不可读")),
            "必须留下警告日志: {messages:?}"
        );
    }

    /// 2026-09-28 事故回归: 状态键读回来的值不是本插件的状态文档时,
    /// persistAll 必须**放弃写入**而不是用默认值覆盖。
    #[test]
    fn persist_all_refuses_to_overwrite_unrecognized_document() {
        fixed_clock();
        let host = FakeHost::new();
        // 宿主信封格式变化: 值是合法 JSON, 但里面没有本插件的状态
        host.set(store::STATE_KEY, br#"{"data":{"unexpected":true}}"#);
        let _guard = host.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        assert!(!runtime.storage_ok(), "解不出状态文档 → 不能落盘");
        // loadAll 的 legacy 迁移会尝试读旧键(不存在 → 404), 于是退回默认配置
        assert_eq!(runtime.settings.lists.as_ref().unwrap().len(), 5);

        let host = FakeHost::new();
        host.set(store::STATE_KEY, br#"{"data":{"unexpected":true}}"#);
        let _guard = host.install();
        runtime.persist_all();
        assert!(
            host.puts()
                .iter()
                .all(|record| record.key != store::STATE_KEY),
            "无法识别的状态文档绝不能被覆盖: {:?}",
            host.puts()
                .iter()
                .map(|r| r.key.clone())
                .collect::<Vec<_>>()
        );
        let messages = log_messages(&runtime);
        assert!(
            messages
                .iter()
                .any(|message| message.contains("宿主存储内容无法识别")),
            "{messages:?}"
        );
        assert!(runtime.load_warned, "警告只提示一次");
    }

    #[test]
    fn persist_all_recovers_when_storage_becomes_readable() {
        fixed_clock();
        // ① 先让宿主不可读
        let host = FakeHost::new();
        host.fail_all(true);
        let _guard = host.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        assert!(!runtime.storage_ok());

        // ② 宿主恢复: 已有一份可识别的状态文档
        let host = FakeHost::new();
        host.set(store::STATE_KEY, crate::fixtures::STATE);
        let _guard = host.install();
        runtime.persist_all();
        assert!(runtime.storage_ok(), "重新读到状态后恢复落盘能力");
        assert!(!host.puts().is_empty(), "恢复后必须真的写入");
        let written = state_body(&host);
        assert_eq!(written["settings"]["lists"].as_object().unwrap().len(), 5);
        // Go persistAll 的这条恢复路径只套用 settings(`if r.settings.Lists == nil`),
        // 不重建快照/队列 —— 内存里从没加载过 queue, 落盘就是零值(`items: null`)
        assert_eq!(written["queue"]["items"], Value::Null);
    }

    #[test]
    fn persist_all_skips_oversized_document() {
        fixed_clock();
        let host = fixture_host();
        let _guard = host.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        // 塞一条超过 4MiB 的日志(Go 的 maxPersistBytes 预算)
        runtime.logs.get_or_insert_with(Vec::new).push(LogEntry {
            at: "2026-09-29T10:00:09Z".to_string(),
            level: "info".to_string(),
            message: "x".repeat(MAX_PERSIST_BYTES + 1024),
        });
        let host = FakeHost::new();
        host.set(store::STATE_KEY, crate::fixtures::STATE);
        let _guard = host.install();
        runtime.persist_all();
        // 用"尝试过的请求"判定, 避免 puts() 为空时断言变成空真
        let attempted_state_puts = host
            .requests()
            .iter()
            .filter(|request| request.method == "PUT" && request.path.ends_with("/state"))
            .count();
        assert_eq!(attempted_state_puts, 0, "超过 4MiB 必须放弃落盘");
        let messages = log_messages(&runtime);
        assert!(
            messages
                .iter()
                .any(|message| message.starts_with("持久化跳过: 状态过大")),
            "{messages:?}"
        );
    }

    #[test]
    fn account_overlay_only_covers_non_empty_fields() {
        fixed_clock();
        let host = fixture_host();
        // 账号键只填了 uuid + 开启想看; 状态文档里的 cookiecloud_url/key 必须保留
        host.set(
            store::ACCOUNT_KEY,
            br#"{"cookiecloud_uuid":"uuid-account","cookiecloud_url":"","cookiecloud_key":"","wish_sync_enabled":false,"lists":null,"blacklist":null}"#,
        );
        let _guard = host.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();

        assert_eq!(runtime.settings.cookiecloud_uuid, "uuid-account");
        assert_eq!(runtime.settings.cookiecloud_url, "http://127.0.0.1:8088");
        assert_eq!(runtime.settings.cookiecloud_key, "key-test");
        assert!(
            runtime.settings.wish_sync_enabled,
            "false 不能把 true 覆盖掉"
        );

        let diag = diag_body(&host);
        assert_eq!(diag["overlay"], true);
        assert_eq!(
            diag["account_bytes"],
            Value::from(133usize),
            "account_bytes 必须是读到的字节数: {diag}"
        );
    }

    #[test]
    fn account_overlay_ignores_empty_account_document() {
        fixed_clock();
        let host = fixture_host();
        host.set(
            store::ACCOUNT_KEY,
            br#"{"lists":null,"wish_sync_enabled":false}"#,
        );
        let _guard = host.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        assert_eq!(
            runtime.settings.cookiecloud_uuid, "uuid-test",
            "空账号键不覆盖"
        );
        let diag = diag_body(&host);
        assert_eq!(diag["overlay"], false);
    }

    #[test]
    fn save_account_writes_only_account_fields() {
        fixed_clock();
        let host = fixture_host();
        let _guard = host.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        runtime.save_account();

        let raw = host
            .last_put_body(store::ACCOUNT_KEY)
            .expect("必须写 account 键");
        let parsed: Value = serde_json::from_slice(&raw).unwrap();
        let account = &parsed["value"];
        assert_eq!(account["cookiecloud_url"], "http://127.0.0.1:8088");
        assert_eq!(account["cookiecloud_uuid"], "uuid-test");
        assert_eq!(account["cookiecloud_key"], "key-test");
        assert_eq!(account["wish_sync_enabled"], true);
        // Go 把整个 Settings 结构体序列化进 account 键, 其余字段是零值
        assert_eq!(account["lists"], Value::Null);
        assert_eq!(account["blacklist"], Value::Null);
        assert_eq!(account["observe_period_hours"], 0);
        assert!(
            account.get("manual_cookie").is_none(),
            "空字符串带 omitempty"
        );
    }

    #[test]
    fn settings_update_merges_lists_and_keeps_user_config() {
        fixed_clock();
        let host = fixture_host();
        let _guard = host.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let before = runtime.settings.lists.clone().unwrap();

        // ① 正常补丁: 只改 hot 的 limit, 其他键必须保留
        let patch: Map<String, Value> = serde_json::from_str(
            r#"{"lists":{"hot":{"source":"subjects_json","type":"movie","tag":"热门","sort":"recommend","limit":5,"enabled":true}},
                "blacklist":["烂片","注水"],
                "cookiecloud_url":"  http://127.0.0.1:9000  ",
                "cookiecloud_uuid":"uuid-new",
                "cookiecloud_key":"key-new",
                "manual_cookie":"  ",
                "wish_sync_enabled":true,
                "observe_period_hours":12,
                "auto_subscribe":false,
                "notify_on_subscribe":false,
                "subscribe_source_filter":["wish"]}"#,
        )
        .unwrap();
        runtime.cookie = CookieCache {
            header: "old".into(),
            uid: "1".into(),
            source: "manual".into(),
            fetched_at: "2026-09-29T00:00:00Z".into(),
        };
        let result = runtime.settings_update(&patch);
        assert_eq!(
            result,
            json!({"status": "succeeded", "message": "设置已保存"})
        );

        let lists = runtime.settings.lists.clone().unwrap();
        assert_eq!(lists["hot"].limit, 5);
        assert_eq!(
            lists["cn_wom"], before["cn_wom"],
            "未提交的榜单键必须原样保留"
        );
        assert_eq!(lists["upcoming"].source, "coming_html");
        assert_eq!(
            runtime.settings.blacklist,
            Some(vec!["烂片".to_string(), "注水".to_string()])
        );
        assert_eq!(
            runtime.settings.cookiecloud_url, "http://127.0.0.1:9000",
            "账号字段要 trim"
        );
        assert_eq!(runtime.settings.cookiecloud_uuid, "uuid-new");
        assert_eq!(runtime.settings.cookiecloud_key, "key-new");
        assert_eq!(runtime.settings.manual_cookie, "");
        assert_eq!(runtime.settings.observe_period_hours, 12);
        assert!(!runtime.settings.auto_subscribe && !runtime.settings.notify_on_subscribe);
        assert_eq!(
            runtime.settings.subscribe_source_filter,
            Some(vec!["wish".to_string()])
        );
        assert_eq!(
            runtime.cookie,
            CookieCache::EMPTY,
            "账号配置变化必须作废解密缓存"
        );
        assert_eq!(runtime.last_status, "succeeded");
        assert_eq!(runtime.last_message, "设置已保存");

        // 两个键都要落盘: 状态键(整份文档) + 账号键(只有账号字段)
        let state = state_body(&host);
        assert_eq!(state["settings"]["lists"]["hot"]["limit"], 5);
        let account = {
            let raw = host.last_put_body(store::ACCOUNT_KEY).unwrap();
            let parsed: Value = serde_json::from_slice(&raw).unwrap();
            parsed["value"].clone()
        };
        assert_eq!(account["cookiecloud_url"], "http://127.0.0.1:9000");
        assert_eq!(
            account["subscribe_source_filter"],
            Value::Null,
            "账号键只放账号字段"
        );
    }

    /// 评审修复回归: `min_year` 越界数值(直连 settings-update 传 3e9)必须按
    /// "数值非法时忽略", 不能经 `as i32` 饱和成 `i32::MAX` —— 那等于给所有条目加了
    /// 不可能通过的年份过滤且无任何报错(UI 的 :max=3000 只挡住正常路径)。
    #[test]
    fn settings_update_ignores_out_of_range_min_year() {
        fixed_clock();
        let host = fixture_host();
        let _guard = host.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();

        // 合法值生效
        let patch: Map<String, Value> =
            serde_json::from_str(r#"{"min_year":2020,"min_rating":6.5}"#).unwrap();
        assert_eq!(runtime.settings_update(&patch)["status"], "succeeded");
        assert_eq!(runtime.settings.min_year, 2020);
        assert_eq!(runtime.settings.min_rating, 6.5);

        // 越界(3e9 会饱和)→ 忽略, 原值保持
        let patch: Map<String, Value> = serde_json::from_str(r#"{"min_year":3e9}"#).unwrap();
        assert_eq!(runtime.settings_update(&patch)["status"], "succeeded");
        assert_eq!(
            runtime.settings.min_year, 2020,
            "越界数值必须忽略, 不能饱和成 i32::MAX"
        );

        // 负数 → 同样忽略
        let patch: Map<String, Value> = serde_json::from_str(r#"{"min_year":-1}"#).unwrap();
        let _ = runtime.settings_update(&patch);
        assert_eq!(runtime.settings.min_year, 2020);
    }

    /// 2026-09-29 事故回归: UI 在状态未加载时保存, 送来空的 / 缺键的 lists,
    /// 不能清掉用户已有榜单配置; 缺的键要从默认配置补回。
    #[test]
    fn settings_update_ignores_empty_lists_and_restores_missing_keys() {
        fixed_clock();
        let host = fixture_host();
        let _guard = host.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        {
            let lists = runtime.settings.lists.as_mut().unwrap();
            // 用户改过 hot 的 limit, 并且当时只有部分榜单键(模拟"状态未加载时保存")
            lists.get_mut("hot").unwrap().limit = 5;
            lists.remove("cn_wom");
            lists.remove("movie_wom");
        }

        let empty: Map<String, Value> = serde_json::from_str(r#"{"lists":{}}"#).unwrap();
        runtime.settings_update(&empty);
        let lists = runtime.settings.lists.clone().unwrap();
        assert_eq!(
            lists["hot"].limit, 5,
            "空 lists 必须被忽略, 用户配置不能被默认值冲掉"
        );
        assert!(
            lists.contains_key("cn_wom"),
            "缺失的榜单键必须从默认配置补回"
        );
        assert_eq!(lists.len(), 5);

        let patch: Map<String, Value> =
            serde_json::from_str(r#"{"lists":{"upcoming":{"source":"subjects_json","type":"movie","limit":5,"enabled":true}}}"#)
                .unwrap();
        runtime.settings_update(&patch);
        let lists = runtime.settings.lists.clone().unwrap();
        assert_eq!(lists.len(), 5, "缺失的榜单键必须从默认配置补回: {lists:?}");
        assert_eq!(lists["hot"].tag, "热门");
        assert_eq!(
            lists["upcoming"].source, "coming_html",
            "upcoming 强制 coming_html"
        );
        assert_eq!(lists["upcoming"].limit, 5, "用户 limit 必须保留");
    }

    #[test]
    fn normalize_settings_restores_missing_keys() {
        let mut runtime = Runtime::new();
        runtime.settings = Settings {
            lists: Some(BTreeMap::from([(
                "upcoming".to_string(),
                model::ListConfig {
                    source: "wrong".into(),
                    limit: 5,
                    enabled: true,
                    ..Default::default()
                },
            )])),
            ..Settings::EMPTY
        };
        runtime.normalize_settings();
        let lists = runtime.settings.lists.clone().unwrap();
        for key in ["upcoming", "hot", "cn_wom", "global_wom", "movie_wom"] {
            assert!(lists.contains_key(key), "缺 {key}");
        }
        assert_eq!(lists["hot"].tag, "热门");
        assert_eq!(lists["upcoming"].source, "coming_html");
        assert_eq!(lists["upcoming"].limit, 5, "用户值必须保留");
        assert!(lists["upcoming"].enabled);
    }

    #[test]
    fn archive_resets_history_and_stats_then_persists() {
        fixed_clock();
        let host = fixture_host();
        let _guard = host.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let result = runtime.archive();
        assert_eq!(
            result,
            json!({"status": "succeeded", "message": "已归档历史与日志"})
        );
        assert!(
            runtime.history.is_none() && runtime.logs.is_none(),
            "archive 后 Go 里是 nil"
        );
        assert_eq!(runtime.stats.total, 0);
        assert_eq!(runtime.stats.last_archive_at, "2026-09-29T10:00:09Z");
        assert_eq!(runtime.black_state.keywords, None);

        let state = state_body(&host);
        // history 归档后被置 nil → 落盘是 null; logs 走 Go 的
        // `make([]LogEntry, 0, persistLogLimit)`(main.go:464), 永远是数组 —— 空就写 []
        assert_eq!(state["history"], Value::Null);
        assert_eq!(state["logs"], json!([]));
        assert_eq!(state["stats"]["last_archive_at"], "2026-09-29T10:00:09Z");
    }

    #[test]
    fn log_truncates_at_400_bytes_with_suffix() {
        let mut runtime = Runtime::new();
        let long = "x".repeat(500);
        runtime.log("warning", &long);
        let logs = runtime.logs.as_ref().unwrap();
        assert_eq!(logs[0].message.len(), LOG_MESSAGE_LIMIT + "…(截断)".len());
        assert!(logs[0].message.ends_with("…(截断)"));
        // 多字节字符被截断在中间时, 回退到合法边界(Go 的 utf8.ValidString 循环)
        let mut runtime = Runtime::new();
        runtime.log("warning", &"汉".repeat(200));
        let logs = runtime.logs.as_ref().unwrap();
        assert!(logs[0].message.ends_with("…(截断)"));
        assert!(logs[0].message.is_char_boundary(logs[0].message.len()));
        // max_logs 裁剪
        let mut runtime = Runtime::new();
        runtime.settings.max_logs = 3;
        for index in 0..10 {
            runtime.log("info", &format!("第{index}条"));
        }
        let logs = runtime.logs.as_ref().unwrap();
        assert_eq!(logs.len(), 3);
        assert_eq!(logs[2].message, "第9条");
        assert_eq!(runtime.revision, 10, "每条日志各 +1");
    }

    #[test]
    fn state_doc_shapes_match_go() {
        let mut runtime = Runtime::new();
        runtime.settings = model::default_settings();
        runtime.stats.by_list = Some(BTreeMap::new());
        let doc = runtime.state_doc();
        // settings.lists 是 {} 而不是 null(Go cloneSettings 的 make)
        assert!(doc["settings"]["lists"].is_object());
        assert_eq!(
            doc["snapshot"]["lists"],
            json!({}),
            "cloneSnapshot 的 make(map)"
        );
        assert_eq!(
            doc["observe_queue"]["items"],
            Value::Null,
            "nil 队列 → null"
        );
        assert_eq!(doc["history"], json!([]));
        assert_eq!(doc["logs"], json!([]));
        assert_eq!(doc["wish"], json!([]));
        assert_eq!(doc["blacklist"]["keywords"], Value::Null);
        assert_eq!(
            doc["stats"]["by_list"],
            json!({}),
            "loadAll 会把 by_list 补成 {{}}"
        );
        // Go 的 state 响应经过 map 往返, 所有键都是字典序
        let keys: Vec<&str> = doc
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let mut sorted = keys.clone();
        sorted.sort_unstable();
        assert_eq!(
            keys, sorted,
            "state 响应的键序必须是字典序(Go 的 map 序列化)"
        );
        assert_eq!(
            keys,
            vec![
                "blacklist",
                "history",
                "last_message",
                "last_run",
                "logs",
                "no_resub",
                "observe_queue",
                "revision",
                "settings",
                "snapshot",
                "stats",
                "status",
                "wish",
                "wish_info"
            ]
        );

        // `append([]T(nil), 空切片...)` 在 Go 里退化成 nil: 状态响应里是 null, 不是 []
        runtime.settings.blacklist = Some(Vec::new());
        runtime.settings.subscribe_source_filter = Some(Vec::new());
        runtime.queue.items = Some(Vec::new());
        runtime.snapshot.lists = Some(BTreeMap::from([("hot".to_string(), Some(Vec::new()))]));
        let doc = runtime.state_doc();
        assert_eq!(
            doc["settings"]["blacklist"],
            Value::Null,
            "cloneSettings 的 append(nil)"
        );
        assert_eq!(doc["settings"]["subscribe_source_filter"], Value::Null);
        assert_eq!(
            doc["observe_queue"]["items"],
            Value::Null,
            "cloneQueue 的 append(nil)"
        );
        assert_eq!(
            doc["snapshot"]["lists"]["hot"],
            Value::Null,
            "cloneSnapshot 的 append(nil)"
        );
    }

    #[test]
    fn state_doc_truncates_history_and_logs() {
        let mut runtime = Runtime::new();
        runtime.settings = model::default_settings();
        for index in 0..80 {
            runtime.logs.get_or_insert_with(Vec::new).push(LogEntry {
                at: String::new(),
                level: "info".into(),
                message: format!("l{index}"),
            });
        }
        for index in 0..40 {
            runtime
                .history
                .get_or_insert_with(Vec::new)
                .push(HistoryEntry {
                    douban_ref: format!("r{index}"),
                    ..Default::default()
                });
        }
        let doc = runtime.state_doc();
        assert_eq!(doc["logs"].as_array().unwrap().len(), STATE_LOGS_LIMIT);
        assert_eq!(
            doc["logs"][0]["message"], "l0",
            "取前 50 条(Go 的 logs[:50])"
        );
        assert_eq!(
            doc["history"].as_array().unwrap().len(),
            STATE_HISTORY_LIMIT
        );
    }

    /// 端到端: 经协议分发走一次 settings-update(覆盖 action 分派与两个键的写入)。
    #[test]
    fn settings_update_through_dispatch() {
        fixed_clock();
        let host = fixture_host();
        let _guard = host.install();
        let mut runtime = Runtime::new();
        let request = br#"{"method":"runtime.invoke","params":{"envelope":{"op":"action","invocation_id":"inv_1","payload":{"id":"settings-update","input":{"lists":{"movie_wom":{"source":"chart_html","type":"movie","tag":"","sort":"","limit":10,"enabled":false}}}}}}}"#;
        let response = crate::protocol::dispatch(&mut runtime, request);
        let parsed: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(
            parsed["result"],
            json!({"status": "succeeded", "message": "设置已保存"})
        );
        assert_eq!(
            runtime.settings.lists.as_ref().unwrap()["movie_wom"].limit,
            10
        );
        assert!(host.last_put_body(store::STATE_KEY).is_some());
        assert!(host.last_put_body(store::ACCOUNT_KEY).is_some());
        assert!(host.last_put_body(store::DIAG_KEY).is_some());
    }

    /// 冻结的出站 HTTP(Go `main.go:565`): 请求形态与三种失败分支。
    #[test]
    fn http_get_shapes_match_go() {
        let runtime = Runtime::new();

        // 成功(此处用 200 + 空体): 头必须带豆瓣 Referer 与桌面 UA
        let host = FakeHost::new();
        host.get_status(200);
        let _guard = host.install();
        let got = runtime.http_get("https://movie.douban.com/chart", "text/html");
        assert_eq!(got.status, 200);
        assert!(got.error.is_none());
        assert!(
            got.body.is_empty(),
            "200 + 空 body_base64 → 空 body(Go 的 decodeBody 返回 nil, nil)"
        );
        let request = host.requests().pop().expect("必须发出 host.call");
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "https://movie.douban.com/chart");
        assert_eq!(
            request.headers.get("accept").map(String::as_str),
            Some("text/html")
        );
        assert_eq!(
            request.headers.get("referer").map(String::as_str),
            Some("https://movie.douban.com/"),
            "豆瓣图片 CDN 防盗链: 少了 Referer 会 418"
        );
        assert_eq!(
            request.headers.get("user-agent").map(String::as_str),
            Some(BROWSER_USER_AGENT)
        );

        // HTTP >= 400 → 空 body + "HTTP 404", status 一并保留(Go 返回 (nil, 404, err))
        let host = FakeHost::new();
        let _guard = host.install();
        let got = runtime.http_get("https://movie.douban.com/nope", "text/html");
        assert_eq!(got.status, 404);
        assert_eq!(got.error.as_ref().map(OpError::message), Some("HTTP 404"));
        assert!(got.body.is_empty());

        // host.call 失败 → status 0(Go 的零值) + 原始错误串
        let host = FakeHost::new();
        host.fail_all(true);
        let _guard = host.install();
        let got = runtime.http_get("https://movie.douban.com/chart", "text/html");
        assert_eq!(got.status, 0);
        assert_eq!(
            got.error.as_ref().map(OpError::message),
            Some("host_call 返回长度 0")
        );
        assert!(runtime
            .http_get("https://x/", "text/html")
            .into_result()
            .is_err());
    }

    /// 接线级动作(不依赖骨架模块): 黑名单增删(Go `main.go:1659` 起)。
    #[test]
    fn action_blacklist_add_and_remove() {
        fixed_clock();
        let host = fixture_host();
        let _guard = host.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        assert_eq!(
            runtime.settings.blacklist,
            Some(Vec::new()),
            "夹具里 blacklist 是 []"
        );

        // 空关键词(缺失 / 纯空白) → 失败, 不落盘
        for input in [json!({}), json!({"keyword": "   "})] {
            let payload = json!({"id": "blacklist-add", "input": input});
            let result = runtime
                .action("inv_1", RawPayload::Value(&payload))
                .unwrap();
            assert_eq!(
                result,
                json!({"status": "failed", "message": "关键词不能为空"}),
                "input={input}"
            );
        }
        assert!(runtime.settings.blacklist.as_ref().unwrap().is_empty());

        // 添加: trim 后写入 + 落盘 + bump
        let payload = json!({"id": "blacklist-add", "input": {"keyword": " 烂片 "}});
        let result = runtime
            .action("inv_1", RawPayload::Value(&payload))
            .unwrap();
        assert_eq!(
            result,
            json!({"status": "succeeded", "message": "已添加黑名单关键词：烂片"})
        );
        assert_eq!(runtime.settings.blacklist, Some(vec!["烂片".to_string()]));
        assert_eq!(runtime.last_status, "succeeded");
        assert_eq!(state_body(&host)["settings"]["blacklist"], json!(["烂片"]));

        // 重复添加 → "关键词已存在", 不重复入列
        let result = runtime
            .action("inv_1", RawPayload::Value(&payload))
            .unwrap();
        assert_eq!(
            result,
            json!({"status": "succeeded", "message": "关键词已存在"})
        );
        assert_eq!(runtime.settings.blacklist.as_ref().unwrap().len(), 1);

        // 移除: 过滤该关键词; Go 的 `kept := s[:0]` 留下的是非 nil 空切片 → `[]`
        let payload = json!({"id": "blacklist-remove", "input": {"keyword": "烂片"}});
        let result = runtime
            .action("inv_1", RawPayload::Value(&payload))
            .unwrap();
        assert_eq!(
            result,
            json!({"status": "succeeded", "message": "已移除黑名单关键词：烂片"})
        );
        assert_eq!(runtime.settings.blacklist, Some(Vec::<String>::new()));
        assert_eq!(state_body(&host)["settings"]["blacklist"], json!([]));
    }

    /// 接线级动作: 观察队列移除 / 豆瓣来源 / 已停用的通知(Go `main.go:1645`-`1704`)。
    #[test]
    fn action_observe_remove_open_source_and_send_test() {
        fixed_clock();
        let host = fixture_host();
        let _guard = host.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();

        // observe-remove: 只去掉目标条目, 其余顺序不变
        let before: Vec<String> = runtime
            .queue
            .items
            .as_ref()
            .unwrap()
            .iter()
            .map(|item| item.douban_ref.clone())
            .collect();
        let target = before[0].clone();
        let payload = json!({"id": "observe-remove", "input": {"douban_ref": target}});
        let result = runtime
            .action("inv_1", RawPayload::Value(&payload))
            .unwrap();
        assert_eq!(
            result,
            json!({"status": "succeeded", "message": "已从观察队列移除"})
        );
        let after: Vec<String> = runtime
            .queue
            .items
            .as_ref()
            .unwrap()
            .iter()
            .map(|item| item.douban_ref.clone())
            .collect();
        assert_eq!(after.len(), before.len() - 1);
        assert_eq!(after, before[1..].to_vec(), "过滤要保持原顺序");

        // open-source: 命中快照条目 → 带 url
        let (douban_ref, url) = runtime
            .snapshot
            .lists
            .as_ref()
            .unwrap()
            .values()
            .flat_map(|items| items.iter().flatten())
            .find(|item| !item.url.is_empty())
            .map(|item| (item.douban_ref.clone(), item.url.clone()))
            .expect("夹具里必须有带 URL 的榜单条目");
        let payload = json!({"id": "open-source", "input": {"douban_ref": douban_ref}});
        let result = runtime
            .action("inv_1", RawPayload::Value(&payload))
            .unwrap();
        assert_eq!(
            result,
            json!({"status": "succeeded", "message": "豆瓣来源已生成", "url": url})
        );

        // 未命中 → failed
        let payload = json!({"id": "open-source", "input": {"douban_ref": "db:subj:00000000"}});
        let result = runtime
            .action("inv_1", RawPayload::Value(&payload))
            .unwrap();
        assert_eq!(
            result,
            json!({"status": "failed", "message": "未找到对应豆瓣条目"})
        );

        // send-test: 通知通道被宿主禁用, 只回提示
        let payload = json!({"id": "send-test"});
        let result = runtime
            .action("inv_1", RawPayload::Value(&payload))
            .unwrap();
        assert_eq!(result["status"], "skipped");
        assert!(
            result["message"]
                .as_str()
                .unwrap()
                .contains("通知功能已停用"),
            "{result}"
        );

        // 未知动作: Go `main.go:1712`
        let payload = json!({"id": "teleport"});
        let result = runtime
            .action("inv_1", RawPayload::Value(&payload))
            .unwrap();
        assert_eq!(
            result,
            json!({"status": "failed", "code": "unknown_action", "message": "未知动作"})
        );
    }

    /// 接线级动作的 payload 契约: id 缺失/类型不符 → `-32602`; input 不是对象 → 空 map。
    #[test]
    fn action_payload_contract() {
        let mut runtime = Runtime::new();
        for payload in [
            json!(null),
            json!([1]),
            json!("x"),
            json!({}),
            json!({"id": ""}),
            json!({"id": 7}),
        ] {
            let err = runtime
                .action("inv_1", RawPayload::Value(&payload))
                .unwrap_err();
            assert_eq!(err.message(), "invalid action payload", "payload={payload}");
        }
        // input 类型不符 → Go 的 `json.Unmarshal` 失败 → 空 map → "关键词不能为空"
        let payload = json!({"id": "blacklist-add", "input": [1, 2]});
        let result = runtime
            .action("inv_1", RawPayload::Value(&payload))
            .unwrap();
        assert_eq!(
            result,
            json!({"status": "failed", "message": "关键词不能为空"})
        );
    }

    /// job 分发表的外壳: 参数非法与未声明任务的提示语(Go `main.go:2016`/`2043`)。
    #[test]
    fn job_payload_contract() {
        let mut runtime = Runtime::new();
        // payload 的值不是对象(数组/字符串/null 字面量/id 类型不符) → Go 的 json.Unmarshal 失败
        // → "任务参数无效"。注意: 协议层收到 JSON 字面量 `null` 时走的是 `RawPayload::Null`
        // (解成零值结构体 → 空 id → "未声明的任务", 见 raw.rs), 这里直接构造 `Value(&null)`
        // 覆盖的是"值存在但不是对象"的那条失败分支。
        for payload in [json!(null), json!([1]), json!("x"), json!({"id": 7})] {
            let result = runtime.job("inv_1", RawPayload::Value(&payload)).unwrap();
            assert_eq!(
                result,
                json!({"status": "skipped", "message": "任务参数无效"}),
                "payload={payload}"
            );
        }
        // 解得出但 ID 为空(空对象/未知 id) → Go 的 default 分支
        for payload in [json!({}), json!({"id": "no-such-job"})] {
            let result = runtime.job("inv_1", RawPayload::Value(&payload)).unwrap();
            assert_eq!(
                result,
                json!({"status": "skipped", "message": "未声明的任务"}),
                "payload={payload}"
            );
        }
        assert!(
            !runtime.deep_refresh,
            "job 结束必须复位 deepRefresh(Go 的 defer)"
        );
    }
}

#[cfg(test)]
mod host_forbidden_field_tests {
    use super::*;

    /// 宿主(2026-09-30)递归拒绝 state 响应中包含 "cookie" 的 key、
    /// 以及 password/token/secret 类 key。整棵 state 树必须干净。
    fn assert_no_forbidden_keys(value: &Value, path: &str) {
        match value {
            Value::Object(map) => {
                for (key, inner) in map {
                    let lower = key.to_lowercase();
                    assert!(
                        !lower.contains("cookie")
                            && !lower.contains("password")
                            && !lower.contains("secret")
                            && !lower.contains("token")
                            && !lower.contains("authorization"),
                        "state 里出现宿主禁用 key: {path}.{key}"
                    );
                    assert_no_forbidden_keys(inner, &format!("{path}.{key}"));
                }
            }
            Value::Array(items) => {
                for (i, inner) in items.iter().enumerate() {
                    assert_no_forbidden_keys(inner, &format!("{path}[{i}]"));
                }
            }
            _ => {}
        }
    }

    #[test]
    fn state_doc_contains_no_host_forbidden_keys() {
        let mut rt = Runtime::default();
        rt.settings = model::Settings {
            cookiecloud_url: "http://127.0.0.1:8088".into(),
            cookiecloud_uuid: "uuid-x".into(),
            cookiecloud_key: "secret-key".into(),
            manual_cookie: "dbcl2=1:abc".into(),
            wish_sync_enabled: true,
            ..model::default_settings()
        };
        let state = rt.state_doc();
        assert_no_forbidden_keys(&state, "$");
        let settings = state["settings"].as_object().unwrap();
        assert_eq!(settings["cc_url"], json!("http://127.0.0.1:8088"));
        assert_eq!(settings["cc_uuid"], json!("uuid-x"));
        assert_eq!(settings["cc_key_set"], json!(true));
        assert_eq!(settings["cc_manual_set"], json!(true));
        assert!(settings.get("cookiecloud_key").is_none());
    }

    #[test]
    fn settings_update_cc_key_empty_keeps_stored_value() {
        let mut rt = Runtime::default();
        rt.settings.cookiecloud_key = "stored-secret".into();
        rt.settings_update(
            &serde_json::from_str::<Map<String, Value>>(
                r#"{"cc_key":"","cc_url":" http://x ","cc_uuid":"u1"}"#,
            )
            .unwrap(),
        );
        assert_eq!(
            rt.settings.cookiecloud_key, "stored-secret",
            "空 cc_key 必须保持原值"
        );
        assert_eq!(rt.settings.cookiecloud_url, "http://x");
        assert_eq!(rt.settings.cookiecloud_uuid, "u1");
        // 显式给新值则覆盖
        rt.settings_update(
            &serde_json::from_str::<Map<String, Value>>(r#"{"cc_key":"new"}"#).unwrap(),
        );
        assert_eq!(rt.settings.cookiecloud_key, "new");
    }
}
