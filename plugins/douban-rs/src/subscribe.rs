//! TMDB 匹配与聚合订阅(Go `main.go:822` 起的 TMDB 段 + `main.go:929` 订阅请求 +
//! `main.go:1333` `processDue` + `main.go:1385` `subscribeQueueItem` + `main.go:1397`
//! `doSubscribe` + `main.go:1720` 的 `subscribe`/`subscribe-now` 两个动作 +
//! `main.go:1115` `addHistory`)。
//!
//! # 路 3(TMDB 匹配与聚合订阅)的名下文件
//!
//! 本文件是这一路的唯一文件: **并行阶段只填这里的函数体**。
//! 冻结文件(任何一路都不得修改): `lib.rs`、`runtime.rs`、`protocol.rs`、`host.rs`、
//! `store.rs`、`model.rs`、`raw.rs`、`util.rs`、`clock.rs`、`Cargo.toml`。
//! 另外两路的名下文件: 路 1 = `charts.rs` + `poster.rs`, 路 2 = `cookiecloud.rs` + `wish.rs`。
//!
//! # 第二轮(rs-0.2.0): 两路并行时本文件的共享面(冻结, 互不重叠)
//!
//! 本文件是功能 1 与功能 2/3 两路**唯一共享**的文件, 但两路各占一条线, 合并无需解冲突:
//!
//! | 路 | 只动这里 | 加的标记 |
//! |----|----------|----------|
//! | 功能 1(TMDB 匹配增强) | [`Runtime::subscribe_queue_item`] 与 [`Runtime::subscribe_from_snapshot`] 里 `tmdb_search → match_tmdb → 阈值判定` 的**函数体** | `// [功能1]` |
//! | 功能 2/3(过滤器 + 墓碑集) | **订阅入口**的前置守卫调用(见下表), 以及 [`Runtime::process_due`] 保留循环里对 `filtered`/`no_resub` 终态的 `keep` | `// [功能2/3]` |
//!
//! 两路都**不改**本文件的任何签名、不加减参数; 功能 1 的实现全部在
//! [`crate::subject`](`rexxar_subject_detail` + 回退候选顺序), 功能 2/3 的实现全部在
//! [`crate::filter`](`can_subscribe` / `no_resub_guard` / 墓碑读写)。
//!
//! ## 功能 2/3 的入口守卫(冻结的调用矩阵)
//!
//! | 本文件里的入口 | 触发 | 过滤 | 墓碑 | 备注 |
//! |----------------|------|------|------|------|
//! | [`Runtime::process_due`](chart 到期 / wish 到期) | 自动 | ✔ | ✔ 拦截 | 被拦条目 `state = filtered` / `no_resub`, 终态保留 |
//! | [`Runtime::subscribe_queue_now`](action `subscribe-now`) | 手动 | ✔ | ✘ 不拦 | 响应里带 [`crate::filter::NO_RESUB_CONFIRM_TEXT`] |
//! | [`Runtime::subscribe_from_snapshot`](action `subscribe`) | 手动 | ✘ | ✘ 不拦 | 仅带确认文案 |
//! | `wish.rs::sync_wish_list` 内联订阅(路 2/3 名下) | 自动 | ✔ | ✔ 拦截 | 不经过本文件 |
//!
//! `needs_review` 与 `filtered` 的分工: **过滤/墓碑是明确判定, 不是"需要人看"** ——
//! 两者都不再进 `needs_review`, 避免把"用户设定的过滤器起了作用"报成故障。
//!
//! # 已冻结的调用点
//!
//! - `runtime.rs::action` 的 `subscribe` → [`Runtime::subscribe_from_snapshot`];
//!   `subscribe-now` → [`Runtime::subscribe_queue_now`]
//! - `runtime.rs::job` 的 `wish-sync` → [`Runtime::process_due`]
//! - [`crate::charts::Runtime::refresh_now`] → [`Runtime::process_due`](仅 `deep_refresh`)
//! - [`crate::wish::Runtime::sync_wish_list`] → [`Runtime::subscribe_queue_item`]
//! - 本文件内: `process_due` → `subscribe_queue_item` → `do_subscribe` → `host_intent_exists` /
//!   `create_subscription` / `add_history_and_log`
//!
//! # 借用契约(照抄时怎么改)
//!
//! Go 直接按下标改切片, Rust 里 `&mut self` 不能与 `&self.queue.items` 并存:
//!
//! - `process_due`: 先 `let items = self.queue.items.take()`, 逐条用**局部** `QueueItem`
//!   调 `subscribe_queue_item`, 最后把保留的条目写回 `self.queue.items`(Go 也是重建 `kept`);
//! - `do_subscribe` 回填队列: 先复制出局部 `q`(传参用的那个), 再 `&mut self.queue.items`
//!   按 `douban_ref` 找条目改 —— 不要一边持有 `q: &QueueItem` 一边改队列;
//! - `subscribe_from_snapshot`: 从 `self.snapshot` 里找到条目后先 clone 成局部
//!   `QueueItem` 再动 `&mut self`;
//! - `process_due` 要的 `Settings` 由调用方(`runtime.rs` 的 job)克隆好传进来, 本文件内
//!   需要时同样先 `self.settings.clone()`。
//!
//! # 实现要点(照抄时对照)
//!
//! - **宿主接口**(不要自己拼别的路径):
//!   - `GET /api/subscribe/pool/intents?limit=200` → [`Runtime::host_intent_exists`]
//!     (失败一律当成"不存在", 不阻塞订阅);
//!   - `POST /api/subscribe/pool/intents` → [`Runtime::create_subscription`],
//!     body 是 [`PoolIntentCreateRequest`] 的 JSON, `body_base64` 用
//!     [`crate::host::encode_body_base64`](不补 padding), `idempotency-key` 是
//!     `dc-sub-<safeKey(invocation_id)>-<tmdb_id>`;
//!   - `GET /api/tmdb/search?q=<query>` → [`Runtime::tmdb_search`]
//!     (accept: `application/json`; 失败文案 `TMDB 搜索失败 HTTP <status>`)。
//! - **置信度**: [`match_tmdb`] 的评分口径照抄 Go(标题/原名完全相同 +0.7, 互相包含 +0.4,
//!   media_type 相符 +0.25, 评分 >= 6 再 +0.05; 没有任何标题命中就跳过该候选)。
//!   阈值 [`CONFIDENCE_THRESHOLD`] = 0.5: 低于它或 `id == 0` 一律 `needs_review`。
//! - **到期判定**: [`Runtime::process_due`] 里 `due_at` 解析失败按"已到期"处理(Go 的
//!   `err == nil && dueAt.After(now)` 取反), 时间用 [`crate::clock::now_unix_nanos`]
//!   与 [`crate::clock::parse_rfc3339`]; `state == "needs_review"` 的条目永远保留。
//! - **失败重试**: 失败且 `attempt < 3` → 保留为 `needs_review`(`last_error` 记原因);
//!   否则写一条 `result: "failed"` 的历史并从队列里丢掉。注意 Go 里 `attempt` 不会自增
//!   (只在历史里体现), 照抄即可。
//! - **历史与统计**: [`Runtime::add_history`] 前插历史、按 `max_history` 截断,
//!   并对"订阅成功"累计 `stats.total` / `month_new` / `by_list`(月份用
//!   [`crate::clock::current_month`]); `touch()` 让版本号 +1。
//! - **去重**: `do_subscribe` 先问宿主是否已有同类 intent, 命中则把队列条目标成
//!   `subscribed` 并写一条"已存在同类聚合订阅，跳过重复创建"的历史。
//! - **通知**: Go 的发送通知在 `main.go:1438` 被显式停用(宿主拒绝插件通知 payload),
//!   不要实现任何通知调用。
//! - 提示语里的数字格式化照抄 Go: 置信度 `TMDB 匹配置信不足 (%.2f)`(两位小数),
//!   `订阅成功` / `创建聚合订阅失败: <err>` / `TMDB 搜索失败: <err>`。

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::clock;
use crate::host::{self, encode_body_base64, HostCallRequest};
use crate::model::{HistoryEntry, QueueItem, Settings};
use crate::protocol::OpError;
use crate::runtime::Runtime;
use crate::store;

/// 匹配置信度阈值(Go `main.go:1391` / `main.go:1745` 的 `0.5`)。
pub const CONFIDENCE_THRESHOLD: f64 = 0.5;
/// 失败重试上限(Go `main.go:1366` 的 `q.Attempt < 3`)。
pub const MAX_ATTEMPT: i64 = 3;

/// TMDB 条目(Go `main.go:822` `TmdbItem`)。
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(default)]
pub struct TmdbItem {
    pub id: i64,
    pub title: String,
    pub name: String,
    pub original_title: String,
    pub original_name: String,
    pub media_type: String,
    pub release_date: String,
    pub first_air_date: String,
    pub poster_path: String,
    pub backdrop_path: String,
    pub vote_average: f64,
}

/// `tmdb/search` 的响应(Go `main.go:836` `tmdbSearchResult`)。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct TmdbSearchResult {
    pub results: Vec<TmdbItem>,
}

/// `POST /api/subscribe/pool/intents` 的请求体(Go `main.go:929` `poolIntentCreateRequest`)。
///
/// 字段顺序就是 Go 结构体顺序, **不要重排**: 该 body 会被 base64 后发出, 宿主侧可能
/// 对请求体做指纹。
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct PoolIntentCreateRequest {
    pub tmdb_id: i64,
    pub media_type: String,
    pub season: i64,
    pub title: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub year: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub poster_path: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub backdrop_path: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub enabled_sources: Vec<String>,
    pub episode_scope_mode: String,
}

/// 创建订阅的响应(Go `main.go:941` `poolIntentResult`)。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct PoolIntentResult {
    pub code: String,
    pub data: PoolIntentData,
}

/// 创建订阅响应里的 `data`(Go `main.go:943` 的匿名结构)。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct PoolIntentData {
    pub id: i64,
}

/// 已有订阅列表的响应(Go `main.go:948` `poolIntentListResult`)。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct PoolIntentListResult {
    pub code: String,
    pub data: Vec<PoolIntentEntry>,
}

/// 宿主订阅池列表查询的单次条数上限(Go `main.go:960` 同款 `?limit=200`)。
///
/// 墓碑判定([`crate::filter::Runtime::resolve_no_resub_from_history`])依赖该查询的
/// **完整性**: 返回条数达到上限时无法证明"池里真的没有", 必须跳过判定(宁可漏判
/// 不可误判), 否则第 201 条起的订阅会被误写成持久墓碑。
pub(crate) const HOST_POOL_INTENTS_LIMIT: usize = 200;

/// `GET /api/subscribe/pool/intents?limit=<上限>` 的请求路径(两处调用共用, 防 drift)。
pub(crate) fn pool_intents_path() -> String {
    format!("/api/subscribe/pool/intents?limit={HOST_POOL_INTENTS_LIMIT}")
}

/// 已有订阅条目(Go `main.go:950` 的匿名结构)。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct PoolIntentEntry {
    pub id: i64,
    pub tmdb_id: i64,
    pub media_type: String,
    pub title: String,
    pub state: String,
}

/// Go `main.go:860` `normalizeTitle`: 小写 + trim + 全角标点与间隔号折算成半角/空格,
/// 用于标题比较(`（`→`(`, `）`→`)`, `：`→`:`, `·`→空格, `，`→`,`, `。`/`！`/`？` 直接删)。
pub fn normalize_title(text: &str) -> String {
    // Go: strings.ToLower → TrimSpace → NewReplacer(...).Replace
    let lowered = text.to_lowercase();
    let trimmed = lowered.trim();
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        match ch {
            '（' => out.push('('),
            '）' => out.push(')'),
            '：' => out.push(':'),
            '·' => out.push(' '),
            '，' => out.push(','),
            '。' | '！' | '？' => {}
            other => out.push(other),
        }
    }
    out
}

/// Go `main.go:867` `matchTMDB`: 返回最佳候选与置信度(0..1)。
///
/// `res` 为 `None` 或 `results` 为空 → `(TmdbItem::default(), 0.0)`(Go 传的是 nil 指针)。
/// 一个候选都没有标题命中时 `best` 保持第一个候选但分数为 0(Go 的 `bestScore` 从 -1 起)。
pub fn match_tmdb(res: Option<&TmdbSearchResult>, query: &str, want_type: &str) -> (TmdbItem, f64) {
    let results = match res {
        Some(result) if !result.results.is_empty() => &result.results,
        _ => return (TmdbItem::default(), 0.0),
    };
    let q = normalize_title(query);
    let mut best = results[0].clone();
    let mut best_score = -1.0f64;
    for candidate in results {
        let mut score = 0.0f64;
        let mut matched = false;
        // Go 的 titles := []string{Title, Name, OriginalTitle, OriginalName}
        for raw in [
            &candidate.title,
            &candidate.name,
            &candidate.original_title,
            &candidate.original_name,
        ] {
            let title = normalize_title(raw);
            if title == q {
                score += 0.7;
                matched = true;
            } else if !title.is_empty()
                && (title.contains(q.as_str()) || q.contains(title.as_str()))
            {
                score += 0.4;
                matched = true;
            }
        }
        if !matched {
            continue;
        }
        if !want_type.is_empty() && candidate.media_type == want_type {
            score += 0.25;
        }
        if candidate.vote_average >= 6.0 {
            score += 0.05;
        }
        if score > best_score {
            best_score = score;
            best = candidate.clone();
        }
    }
    if best_score < 0.0 {
        best_score = 0.0;
    }
    (best, best_score)
}

/// Go `main.go:908` `tmdbTitle`: `title` 为空时退回 `name`。
pub fn tmdb_title(item: &TmdbItem) -> String {
    if !item.title.is_empty() {
        return item.title.clone();
    }
    item.name.clone()
}

/// Go `main.go:915` `tmdbYear`: 取 `release_date` 前 4 位, 没有就取 `first_air_date` 前 4 位。
pub fn tmdb_year(item: &TmdbItem) -> String {
    // Go 切的是前 4 个 **字节**(`s[:4]`); 非 ASCII 文本可能切在字符中间, Go 会切出
    // 半个字符(Rust 里不允许), 这里退化成不取 —— 日期恒为 ASCII, 实际到不了。
    if item.release_date.len() >= 4 && item.release_date.is_char_boundary(4) {
        return item.release_date[..4].to_string();
    }
    if item.first_air_date.len() >= 4 && item.first_air_date.is_char_boundary(4) {
        return item.first_air_date[..4].to_string();
    }
    String::new()
}

/// Go `main.go:1029` `safeKey`: 只保留 `[A-Za-z0-9_-]`, 结果为空(或输入为空)时给 `unknown`
/// —— 它进 `idempotency-key`, 必须全是可打印 ASCII。
pub fn safe_key(text: &str) -> String {
    if text.is_empty() {
        return "unknown".to_string();
    }
    let filtered: String = text
        .chars()
        .filter(|ch| matches!(ch, 'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_'))
        .collect();
    if filtered.is_empty() {
        return "unknown".to_string();
    }
    filtered
}

impl Runtime {
    /// Go `main.go:840` `tmdbSearch`: `GET /api/tmdb/search?q=<query>`(accept JSON)。
    /// `status >= 400` → `TMDB 搜索失败 HTTP <status>`; 响应解析失败 → 错误原文。
    pub fn tmdb_search(&self, query: &str) -> Result<TmdbSearchResult, OpError> {
        let path = format!("/api/tmdb/search?q={}", query_escape(query));
        let request = HostCallRequest::new("GET", path).with_header("accept", "application/json");
        let response = match host::call(&request) {
            Ok(response) => response,
            Err(err) => return Err(OpError::new(err.0)),
        };
        if response.status >= 400 {
            return Err(OpError::new(format!(
                "TMDB 搜索失败 HTTP {}",
                response.status
            )));
        }
        let body = match store::decode_body(&response) {
            Ok(body) => body,
            Err(err) => return Err(OpError::new(err.0)),
        };
        match serde_json::from_slice::<TmdbSearchResult>(&body) {
            Ok(out) => Ok(out),
            Err(err) => {
                // Go 的 json.Unmarshal 遇到 `null` 会解成零值结构体(不报错)。
                if matches!(serde_json::from_slice::<Value>(&body), Ok(Value::Null)) {
                    return Ok(TmdbSearchResult::default());
                }
                Err(OpError::new(err.to_string()))
            }
        }
    }

    // ─────────────────────── [功能1] 匹配增强 ───────────────────────

    /// [功能1] 匹配增强的唯一新入口: 标题直配失败时用豆瓣详情回退重搜。
    ///
    /// 契约(骨架注释原样保留, 括号内为落地说明):
    /// - 入参 `query` 是豆瓣标题(与现在的直配一致), `douban_ref` 用于取 rexxar 详情
    ///   (两种形态都收: `db:subj:36808876` / `36808876`, 取末段数字);
    /// - 返回 `(best, confidence, fallback_hit)`:
    ///   - 直配成功 → `(item, conf, None)`;
    ///   - 回退命中 → `(item, conf, Some(命中的候选名))`, 调用方记回退日志后照常走
    ///     `do_subscribe`(命中不再是 `needs_review`);
    ///   - 回退也失败 → `(直配的 best, conf, None)`(不吞直配结果, 不新增错误分支);
    /// - `tmdb_search` 的 Err 原样上抛(直配那一次的失败语义不变, 回退期间的 Err 忽略);
    /// - 回退候选与判定阈值: [`crate::subject::SubjectDetail::fallback_titles`] +
    ///   [`CONFIDENCE_THRESHOLD`], 每个候选一次 `tmdb_search` + 一次 [`match_tmdb`],
    ///   取置信度最高者; `want_type` 仍传空串(与现有直配一致, 不计 media_type 加分)。
    ///
    /// 落地取舍(已在 deviations 记录):
    /// - **匹配查询用候选名本身**(契约 ② 的 "或候选名"): 搜什么就拿什么评分, 才能验证
    ///   这次搜索真的命中了该候选 —— 用豆瓣标题评分会让 aka 回退形同虚设(豆瓣标题
    ///   直配已经失败过一次)。
    /// - **`kind` 透传给 rexxar**(评审修复: 原先固定传空串 → 一律按 `movie` 路径取,
    ///   而 rexxar 对 `movie/<剧id>` 实测回 301, 剧集条目详情恒为 `None`, 全部享受
    ///   不到原名/aka 回退): 调用方传条目已知的类型(`QueueItem::media_type`, 入队时
    ///   由 wish 条目的 `type` / 榜单配置的 `kind` 填上; 快照订阅按榜单配置查);
    ///   传空串/未知值时 [`crate::subject::Runtime::rexxar_subject_detail`] 按
    ///   `movie` 取, 与旧行为一致。
    pub fn match_tmdb_with_detail_fallback(
        &self,
        query: &str,
        douban_ref: &str,
        kind: &str,
    ) -> Result<(TmdbItem, f64, Option<String>), OpError> {
        // 直配: 与既有路径逐字一致(want_type 空串); Err 原样上抛
        let res = self.tmdb_search(query)?;
        let (best, confidence) = match_tmdb(Some(&res), query, "");
        if confidence >= CONFIDENCE_THRESHOLD && best.id != 0 {
            return Ok((best, confidence, None));
        }
        // 失配 → rexxar 详情回退。取不到数字 id / 详情没取到 / 没有可用候选 →
        // 保持直配结果(不吞直配结果, 不重复搜原标题)。
        let subject_id = crate::subject::douban_subject_id(douban_ref);
        if subject_id.is_empty() {
            return Ok((best, confidence, None));
        }
        let Some(detail) = self.rexxar_subject_detail(kind, &subject_id) else {
            return Ok((best, confidence, None));
        };
        // 候选顺序 original_title → aka(去空去重), 每个候选一次完整搜索 + 评估;
        // 单个候选失败(host.call 失败 / HTTP >= 400)不阻断, 继续下一个。
        let mut hit: Option<(TmdbItem, f64, String)> = None;
        for candidate in detail.fallback_titles() {
            let Ok(candidate_res) = self.tmdb_search(&candidate) else {
                continue;
            };
            let (item, candidate_confidence) = match_tmdb(Some(&candidate_res), &candidate, "");
            if candidate_confidence < CONFIDENCE_THRESHOLD || item.id == 0 {
                continue;
            }
            let better = hit.as_ref().map_or(true, |(_, best_confidence, _)| {
                candidate_confidence > *best_confidence
            });
            if better {
                hit = Some((item, candidate_confidence, candidate));
            }
        }
        Ok(match hit {
            Some((item, hit_confidence, candidate)) => (item, hit_confidence, Some(candidate)),
            None => (best, confidence, None),
        })
    }

    /// Go `main.go:959` `hostIntentExists`: 宿主是否已有同 `(tmdb_id, media_type)` 的聚合
    /// 订阅。任何失败(host 错误 / HTTP >= 400 / 解析失败)都返回 `(false, 0)`。
    pub fn host_intent_exists(&self, tmdb_id: i64, media_type: &str) -> (bool, i64) {
        let request = HostCallRequest::new("GET", &pool_intents_path())
            .with_header("accept", "application/json");
        let response = match host::call(&request) {
            Ok(response) => response,
            Err(_) => return (false, 0),
        };
        if response.status >= 400 {
            return (false, 0);
        }
        let body = match store::decode_body(&response) {
            Ok(body) => body,
            Err(_) => return (false, 0),
        };
        let out: PoolIntentListResult = match crate::model::decode(&body) {
            Some(out) => out,
            None => return (false, 0),
        };
        for entry in &out.data {
            if entry.tmdb_id == tmdb_id && (media_type.is_empty() || entry.media_type == media_type)
            {
                return (true, entry.id);
            }
        }
        (false, 0)
    }

    /// Go `main.go:980` `createSubscription`: 创建聚合订阅, 返回 intent id。
    ///
    /// - `item.id == 0` → `TMDB 条目无效`;
    /// - `season`: 电影(`item.media_type == "movie"` 或 `want_type == "movie"`)为 0, 其余 1;
    /// - `media_type` 为空时回落到 `want_type`;
    /// - `enabled_sources` 取 `self.settings.subscribe_source_filter`(`main.go:996`);
    /// - HTTP >= 400 → `创建订阅失败 HTTP <status>`; `code != "ok"` →
    ///   `创建订阅返回异常 code="<code>"`(Go 的 `%q`)。
    pub fn create_subscription(
        &self,
        invocation_id: &str,
        item: &TmdbItem,
        want_type: &str,
        title: &str,
        year: &str,
    ) -> Result<i64, OpError> {
        if item.id == 0 {
            return Err(OpError::new("TMDB 条目无效"));
        }
        let season = if item.media_type == "movie" || want_type == "movie" {
            0
        } else {
            1
        };
        let mut body = PoolIntentCreateRequest {
            tmdb_id: item.id,
            media_type: item.media_type.clone(),
            season,
            title: title.to_string(),
            year: year.to_string(),
            poster_path: item.poster_path.clone(),
            backdrop_path: item.backdrop_path.clone(),
            // Go: EnabledSources: r.settings.SubscribeSources(omitempty: nil 与空都省略)
            enabled_sources: self
                .settings
                .subscribe_source_filter
                .clone()
                .unwrap_or_default(),
            episode_scope_mode: "follow".to_string(),
        };
        if body.media_type.is_empty() {
            body.media_type = want_type.to_string();
        }
        let raw = match serde_json::to_vec(&body) {
            Ok(raw) => raw,
            Err(err) => return Err(OpError::new(err.to_string())),
        };
        let request = HostCallRequest::new("POST", "/api/subscribe/pool/intents")
            .with_header("content-type", "application/json")
            .with_header("accept", "application/json")
            .with_header(
                "idempotency-key",
                format!("dc-sub-{}-{}", safe_key(invocation_id), item.id),
            )
            .with_body_base64(encode_body_base64(&raw));
        let response = match host::call(&request) {
            Ok(response) => response,
            Err(err) => return Err(OpError::new(err.0)),
        };
        if response.status >= 400 {
            return Err(OpError::new(format!(
                "创建订阅失败 HTTP {}",
                response.status
            )));
        }
        let body = match store::decode_body(&response) {
            Ok(body) => body,
            Err(err) => return Err(OpError::new(err.0)),
        };
        let out: PoolIntentResult = match crate::model::decode(&body) {
            Some(out) => out,
            None => {
                return Err(OpError::new(match serde_json::from_slice::<Value>(&body) {
                    Err(err) => err.to_string(),
                    Ok(_) => "创建订阅响应解析失败".to_string(),
                }))
            }
        };
        if out.code != "ok" {
            // Go 的 `%q`: 字符串按 Go 字面量转义(等价于 Rust 的 `{:?}`)
            return Err(OpError::new(format!(
                "创建订阅返回异常 code={:?}",
                out.code
            )));
        }
        Ok(out.data.id)
    }

    /// Go `main.go:1334` `processDue`: 处理到期条目 —— TMDB 匹配 → 创建聚合订阅。
    ///
    /// 返回 `(subscribed, needs_review, errMsg)`; Go 的 `errMsg` 永远返回空串
    /// (`main.go:1381`), 保留三元组是为了让 `refreshNow` 的摘要拼法逐字一致。
    ///
    /// 留在队列里的条目 = `state == "needs_review"` 的 + 未到期的 + 订阅失败但
    /// `attempt < `[`MAX_ATTEMPT`] 的(标成 `needs_review` 并记 `last_error`)。
    pub fn process_due(&mut self, invocation_id: &str, settings: &Settings) -> (i64, i64, String) {
        let now = clock::now_unix_nanos();
        // Go: keep := []QueueItem{} —— 结果永远是**非 nil** 切片(空也是 `[]`)
        let mut keep: Vec<QueueItem> = Vec::new();
        let mut due: Vec<QueueItem> = Vec::new();
        for item in self.queue.items.take().unwrap_or_default() {
            // [功能2/3] 被过滤 / 被墓碑拦下的条目是**终态**, 与本分支同样直接保留,
            //   不要掉进下面的到期判定(否则每轮 wish-sync 都会重新订阅/重新计数)。
            if item.state == "needs_review"
                || item.state == crate::filter::FILTERED_QUEUE_STATE
                || item.state == crate::filter::NO_RESUB_QUEUE_STATE
            {
                keep.push(item);
                continue;
            }
            // Go: `dueAt, err := time.Parse(...)`; 解析失败按已到期处理
            if let Some(due_at) = clock::parse_rfc3339(&item.due_at) {
                if due_at > now {
                    keep.push(item);
                    continue;
                }
            }
            due.push(item);
        }

        let mut subscribed: i64 = 0;
        let mut needs_review: i64 = 0;
        for q in due {
            // [功能2/3] 自动路径的两道前置守卫(顺序固定: 墓碑先于过滤):
            //   ① `self.no_resub_guard(&cand)` → `Some(message)` 时把该条目标成
            //      `crate::filter::NO_RESUB_QUEUE_STATE` 后 `keep.push`, `continue`(永不重订);
            //   ② `self.can_subscribe(&cand)` → `!allowed` 时走
            //      `self.mark_queue_item_filtered(...)`, 同样 `keep` + `continue`。
            //   评分来自入队时带上的 `QueueItem::rating`(chart 的 `rate`/wish 的
            //   `subject.rating.value`, 见 `charts.rs`/`wish.rs` 的入队点);
            //   地区判定此刻还没有 rexxar 详情(`countries = None`)→ 按 deviations 第 1 条
            //   降级放行并记 warning。
            let rating = crate::filter::Runtime::queue_item_rating(&q);
            let cand = crate::filter::SubscriptionCandidate::from_queue_item(&q, rating);
            if let Some(message) = self.no_resub_guard(&cand) {
                let mut kept = q.clone();
                kept.state = crate::filter::NO_RESUB_QUEUE_STATE.to_string();
                kept.last_error = message.clone();
                self.log("info", &message);
                keep.push(kept);
                continue;
            }
            let decision = self.can_subscribe(&cand);
            if !decision.allowed {
                let reason = decision.reason.clone().unwrap_or_default();
                // 队列此刻已被 `take()` 走, 这里只落日志; 终态标在保留下来的副本上
                self.mark_queue_item_filtered(&q.douban_ref, &reason);
                let mut kept = q.clone();
                kept.state = crate::filter::FILTERED_QUEUE_STATE.to_string();
                kept.last_error = reason;
                keep.push(kept);
                continue;
            }
            if decision.region_skipped {
                self.log("warning", &crate::filter::region_degraded_log(&q.title));
            }
            // [功能1] 本循环体**不动**: 匹配回退在 `subscribe_queue_item` 内部。
            let (status, _intent_id, message) =
                self.subscribe_queue_item(invocation_id, &q, settings);
            match status.as_str() {
                "succeeded" => {
                    subscribed += 1;
                    continue;
                }
                // Go 里 needs_review 的到期条目**不再留在队列**(只有开头的 state 判定保留)
                "needs_review" => {
                    needs_review += 1;
                    continue;
                }
                _ => {}
            }
            // failed 且未达重试上限 -> 保留为 needs_review
            if q.attempt < MAX_ATTEMPT {
                let mut kept = q.clone();
                kept.state = "needs_review".to_string();
                kept.last_error = message;
                keep.push(kept);
                needs_review += 1;
            } else {
                self.add_history(HistoryEntry {
                    douban_ref: q.douban_ref.clone(),
                    title: q.title.clone(),
                    list: q.list.clone(),
                    action: "subscribe".to_string(),
                    result: "failed".to_string(),
                    message,
                    tmdb_ref: q.tmdb_ref.clone(),
                    ..HistoryEntry::default()
                });
            }
        }
        self.queue.items = Some(keep);
        (subscribed, needs_review, String::new())
    }

    /// Go `main.go:1385` `subscribeQueueItem`: 匹配并订阅单个队列条目。
    ///
    /// 返回 `(status, intent_id, message)`, status 是 `succeeded` | `needs_review` | `failed`:
    /// - TMDB 搜索失败 → `failed` + `TMDB 搜索失败: <err>`;
    /// - 置信度 < [`CONFIDENCE_THRESHOLD`] 或 `id == 0` → `needs_review` +
    ///   `TMDB 匹配置信不足 (0.42)`(两位小数);
    /// - 否则交给 [`Runtime::do_subscribe`]。
    pub fn subscribe_queue_item(
        &mut self,
        invocation_id: &str,
        q: &QueueItem,
        settings: &Settings,
    ) -> (String, i64, String) {
        // [功能1] 匹配增强(只改本函数体, 签名不变): 直配 + rexxar 详情回退
        //   (original_title → aka, 取过阈值者)都在 `match_tmdb_with_detail_fallback` 里;
        //   它的 Err 只可能是直配那次 `tmdb_search` 失败, 按原语义返回 failed。
        //   `kind` 传队列条目入队时带上的 `media_type`(wish 条目的 `type` / 榜单配置
        //   的 `kind`; 旧文档/未知时为空串 → 按 movie 取, 与旧行为一致)。
        let (item, confidence, fallback_hit) =
            match self.match_tmdb_with_detail_fallback(&q.title, &q.douban_ref, &q.media_type) {
                Ok(out) => out,
                Err(err) => {
                    return (
                        "failed".to_string(),
                        0,
                        format!("TMDB 搜索失败: {}", err.message()),
                    )
                }
            };
        // [功能1] 回退命中: 记一条回退日志(含候选名)后照常走 do_subscribe ——
        //   命中回退不再是 needs_review; 未命中时 message 保持 `TMDB 匹配置信不足 ({:.2})`。
        if let Some(candidate) = &fallback_hit {
            self.log(
                "info",
                &format!("TMDB 回退匹配: {} 经 {} 命中", q.title, candidate),
            );
        }
        if confidence < CONFIDENCE_THRESHOLD || item.id == 0 {
            return (
                "needs_review".to_string(),
                0,
                format!("TMDB 匹配置信不足 ({:.2})", confidence),
            );
        }
        self.do_subscribe(invocation_id, q, &item, settings)
    }

    /// Go `main.go:1397` `doSubscribe`: 宿主去重 → 创建订阅 → 写历史 → 回填队列。
    ///
    /// 成功路径会把队列里同 `douban_ref` 的条目标成 `subscribed`(`tmdb_ref` =
    /// `tmdb:<media_type>:<id>`, 并补 `media_type`/`year`/`poster_path`)。
    /// 历史条目: 去重命中写"已存在同类聚合订阅，跳过重复创建", 新建成功写"订阅成功"。
    pub fn do_subscribe(
        &mut self,
        invocation_id: &str,
        q: &QueueItem,
        item: &TmdbItem,
        _settings: &Settings,
    ) -> (String, i64, String) {
        let tmdb_ref = format!("tmdb:{}:{}", item.media_type, item.id);
        // 宿主侧去重
        let (exists, existing_id) = self.host_intent_exists(item.id, &item.media_type);
        if exists {
            if let Some(items) = self.queue.items.as_mut() {
                for entry in items.iter_mut() {
                    if entry.douban_ref == q.douban_ref {
                        entry.state = "subscribed".to_string();
                        entry.tmdb_ref = tmdb_ref.clone();
                    }
                }
            }
            self.add_history_and_log(
                HistoryEntry {
                    douban_ref: q.douban_ref.clone(),
                    tmdb_ref,
                    title: q.title.clone(),
                    list: q.list.clone(),
                    action: "subscribe".to_string(),
                    result: "succeeded".to_string(),
                    message: "已存在同类聚合订阅，跳过重复创建".to_string(),
                    intent_id: existing_id,
                    ..HistoryEntry::default()
                },
                &format!("已存在订阅，跳过：{}", q.title),
            );
            return ("succeeded".to_string(), existing_id, String::new());
        }
        let title = tmdb_title(item);
        let year = tmdb_year(item);
        // Go: createSubscription(invocationID, item, "", title, year) —— wantType 空串
        let intent_id = match self.create_subscription(invocation_id, item, "", &title, &year) {
            Ok(id) => id,
            Err(err) => {
                return (
                    "failed".to_string(),
                    0,
                    format!("创建聚合订阅失败: {}", err.message()),
                )
            }
        };
        self.add_history_and_log(
            HistoryEntry {
                douban_ref: q.douban_ref.clone(),
                tmdb_ref: tmdb_ref.clone(),
                title: q.title.clone(),
                list: q.list.clone(),
                action: "subscribe".to_string(),
                result: "succeeded".to_string(),
                message: "订阅成功".to_string(),
                intent_id,
                ..HistoryEntry::default()
            },
            &format!("已创建聚合订阅：{}", q.title),
        );
        if let Some(items) = self.queue.items.as_mut() {
            for entry in items.iter_mut() {
                if entry.douban_ref == q.douban_ref {
                    entry.state = "subscribed".to_string();
                    entry.tmdb_ref = tmdb_ref.clone();
                    entry.media_type = item.media_type.clone();
                    entry.year = year.clone();
                    entry.poster_path = item.poster_path.clone();
                }
            }
        }
        // 通知功能已停用（宿主 /api/notifications/plugin 拒绝所有插件通知 payload）
        ("succeeded".to_string(), intent_id, String::new())
    }

    /// Go `main.go:1720` `subscribeFromSnapshot` —— action `subscribe`(榜单条目立即订阅)。
    ///
    /// 在 [`crate::model::Snapshot`] 里找 `douban_ref`, 找不到 →
    /// `{"status":"failed","message":"榜单快照中未找到该条目"}`; 匹配不足 →
    /// `{"status":"failed","message":"TMDB 匹配置信不足 (0.42)，无法自动订阅"}`;
    /// 成功 → `{"status":"succeeded","message":"订阅成功","intent_id":<id>}`。
    /// 失败时写一条 `result: "failed"` 的历史并 `persist_all()`。
    ///
    /// 注意 Go 里构造的是**局部** [`QueueItem`](`DoubanRef`/`Title`/`URL`,
    /// `List` 为空): `do_subscribe` 只用它的 ref 回填队列, 所以 `List` 为空不是 bug。
    pub fn subscribe_from_snapshot(
        &mut self,
        invocation_id: &str,
        douban_ref: &str,
    ) -> Result<Value, OpError> {
        // Go 遍历 map[string][]ChartItem(随机序)取第一个命中; 这里按榜单键字典序取第一个。
        // 连同榜单键一起取出: 匹配回退要按该榜单配置的 `kind` 走 rexxar 的 movie/tv 路径。
        let found = self.snapshot.lists.as_ref().and_then(|lists| {
            lists.iter().find_map(|(key, items)| {
                let item = items
                    .as_ref()?
                    .iter()
                    .find(|item| item.douban_ref == douban_ref)?;
                Some((key.clone(), item.clone()))
            })
        });
        let settings = self.settings.clone();
        let (found_list, found) = match found {
            Some(found) => found,
            None => return Ok(json!({"status": "failed", "message": "榜单快照中未找到该条目"})),
        };
        // 条目类型: 该榜单配置里配的 `kind`(movie/tv; 配置缺失/为空 → 空串, 按 movie 取)
        let found_kind = settings
            .lists
            .as_ref()
            .and_then(|lists| lists.get(&found_list))
            .map(|config| config.kind.clone())
            .unwrap_or_default();
        // [功能1] 匹配增强的第二个改动点(只改本函数体): 与 `subscribe_queue_item` 同一套
        //   回退(详情候选 → 重搜 → 取最高置信度), 失败文案保持
        //   `TMDB 匹配置信不足 ({:.2})，无法自动订阅`。
        // [功能2/3] action `subscribe` 是**手动**入口(不在契约的自动路径清单里):
        //   不加 `can_subscribe`/`no_resub_guard` 守卫; 成功路径的响应里额外带
        //   `self.no_resub_confirmation(&found.douban_ref)` 给的确认文案(有则填)。
        let (item, confidence, fallback_hit) = match self.match_tmdb_with_detail_fallback(
            &found.title,
            &found.douban_ref,
            &found_kind,
        ) {
            Ok(out) => out,
            Err(err) => {
                return Ok(json!({
                    "status": "failed",
                    "message": format!("TMDB 搜索失败: {}", err.message()),
                }))
            }
        };
        // [功能1] 回退命中: 记一条回退日志(含候选名)后照常走 do_subscribe
        if let Some(candidate) = &fallback_hit {
            self.log(
                "info",
                &format!("TMDB 回退匹配: {} 经 {} 命中", found.title, candidate),
            );
        }
        if confidence < CONFIDENCE_THRESHOLD || item.id == 0 {
            return Ok(json!({
                "status": "failed",
                "message": format!("TMDB 匹配置信不足 ({:.2})，无法自动订阅", confidence),
            }));
        }
        let q = QueueItem {
            douban_ref: found.douban_ref.clone(),
            title: found.title.clone(),
            url: found.url.clone(),
            ..QueueItem::default()
        };
        let (status, intent_id, message) = self.do_subscribe(invocation_id, &q, &item, &settings);
        if status == "succeeded" {
            if let Some(items) = self.queue.items.as_mut() {
                for entry in items.iter_mut() {
                    if entry.douban_ref == q.douban_ref {
                        entry.state = "subscribed".to_string();
                    }
                }
            }
            self.persist_all();
            // [功能2/3] 手动入口不拦墓碑, 只在响应里带确认文案(有墓碑时; UI 据此提示)
            let mut payload =
                json!({"status": "succeeded", "message": "订阅成功", "intent_id": intent_id});
            if let Some(text) = self.no_resub_confirmation(&q.douban_ref) {
                payload["no_resub_confirm"] = Value::String(text);
            }
            return Ok(payload);
        }
        self.add_history_and_log(
            HistoryEntry {
                douban_ref: q.douban_ref.clone(),
                title: q.title.clone(),
                list: q.list.clone(),
                action: "subscribe".to_string(),
                result: "failed".to_string(),
                message: message.clone(),
                ..HistoryEntry::default()
            },
            &format!("订阅失败：{} ({})", q.title, message),
        );
        self.persist_all();
        Ok(json!({"status": "failed", "message": message}))
    }

    /// Go `main.go:1769` `subscribeQueueNow` —— action `subscribe-now`(队列条目立即订阅)。
    ///
    /// 队列里找不到 → `{"status":"failed","message":"观察队列中未找到该条目"}`;
    /// 成功 → `{"status":"succeeded","message":"订阅成功","intent_id":<id>}`;
    /// `needs_review` → 历史记 `result: "needs_review"`、队列标 `needs_review` 并记
    /// `last_error`, 返回 `{"status":"failed","message":<msg>}`;
    /// `failed` → 历史记 `result: "failed"` 并返回 failed。
    pub fn subscribe_queue_now(
        &mut self,
        invocation_id: &str,
        douban_ref: &str,
    ) -> Result<Value, OpError> {
        let found = self
            .queue
            .items
            .as_ref()
            .and_then(|items| items.iter().find(|item| item.douban_ref == douban_ref))
            .cloned();
        let settings = self.settings.clone();
        let q = match found {
            Some(q) => q,
            None => return Ok(json!({"status": "failed", "message": "观察队列中未找到该条目"})),
        };
        // [功能2/3] action `subscribe-now` 是**手动**入口: 不过墓碑守卫(手动必须能订),
        //   但这里是唯一"手动 + 需要过滤判定"的入口 —— 在 `subscribe_queue_item` 之前
        //   应用 [`crate::filter::Runtime::can_subscribe`]; `!allowed` 时 →
        //   `mark_queue_item_filtered` + 返回 `{"status":"failed","message":"<reason>"}`
        //   (与 needs_review 分支同构, 但**不写 needs_review 历史**, 队列标 `filtered`)。
        //   地区判定降级(deviations 第 1 条)同样记 warning。
        let rating = crate::filter::Runtime::queue_item_rating(&q);
        let cand = crate::filter::SubscriptionCandidate::from_queue_item(&q, rating);
        let decision = self.can_subscribe(&cand);
        if !decision.allowed {
            let reason = decision.reason.clone().unwrap_or_default();
            self.mark_queue_item_filtered(&douban_ref, &reason);
            self.persist_all();
            return Ok(json!({"status": "failed", "message": reason}));
        }
        if decision.region_skipped {
            self.log("warning", &crate::filter::region_degraded_log(&q.title));
        }
        // [功能1] 本函数体不动。
        let (status, intent_id, message) = self.subscribe_queue_item(invocation_id, &q, &settings);
        if status == "succeeded" {
            if let Some(items) = self.queue.items.as_mut() {
                for entry in items.iter_mut() {
                    if entry.douban_ref == douban_ref {
                        entry.state = "subscribed".to_string();
                    }
                }
            }
            self.persist_all();
            // [功能2/3] 手动入口不拦墓碑, 只在响应里带确认文案(有墓碑时; UI 据此提示)
            let mut payload =
                json!({"status": "succeeded", "message": "订阅成功", "intent_id": intent_id});
            if let Some(text) = self.no_resub_confirmation(&douban_ref) {
                payload["no_resub_confirm"] = Value::String(text);
            }
            return Ok(payload);
        }
        if status == "needs_review" {
            self.add_history_and_log(
                HistoryEntry {
                    douban_ref: q.douban_ref.clone(),
                    title: q.title.clone(),
                    list: q.list.clone(),
                    action: "subscribe".to_string(),
                    result: "needs_review".to_string(),
                    message: message.clone(),
                    ..HistoryEntry::default()
                },
                &format!("TMDB 匹配待确认：{} ({})", q.title, message),
            );
            if let Some(items) = self.queue.items.as_mut() {
                for entry in items.iter_mut() {
                    if entry.douban_ref == douban_ref {
                        entry.state = "needs_review".to_string();
                        entry.last_error = message.clone();
                    }
                }
            }
            self.persist_all();
            return Ok(json!({"status": "failed", "message": message}));
        }
        self.add_history_and_log(
            HistoryEntry {
                douban_ref: q.douban_ref.clone(),
                title: q.title.clone(),
                list: q.list.clone(),
                action: "subscribe".to_string(),
                result: "failed".to_string(),
                message: message.clone(),
                ..HistoryEntry::default()
            },
            &format!("订阅失败：{} ({})", q.title, message),
        );
        self.persist_all();
        Ok(json!({"status": "failed", "message": message}))
    }

    /// Go `main.go:1115` `addHistory`: 前插一条历史(`created_at` 取现在), 按
    /// `settings.max_history` 截断, 并累计订阅统计。
    ///
    /// 统计口径: 只有 `result == "succeeded" && action == "subscribe"` 才计数;
    /// 月份变化时先把 `month_new` 归零再 +1; `by_list` 按 `List` 累加(为 nil 时先建空表)。
    pub fn add_history(&mut self, mut entry: HistoryEntry) {
        entry.created_at = clock::now_rfc3339();
        {
            let history = self.history.get_or_insert_with(Vec::new);
            // Go: r.history = append([]HistoryEntry{entry}, r.history...)
            history.insert(0, entry.clone());
            let max = self.settings.max_history;
            if max > 0 && history.len() > max as usize {
                history.truncate(max as usize);
            }
        }
        if entry.result == "succeeded" && entry.action == "subscribe" {
            self.stats.total += 1;
            let month = clock::current_month();
            if self.stats.month != month {
                self.stats.month = month;
                self.stats.month_new = 0;
            }
            self.stats.month_new += 1;
            let by_list = self.stats.by_list.get_or_insert_with(BTreeMap::new);
            *by_list.entry(entry.list.clone()).or_insert(0) += 1;
        }
        self.touch();
    }

    /// Go `main.go:1139` `addHistoryAndLog`: 先 [`Runtime::add_history`] 再
    /// `log("info", log_message)`。
    pub fn add_history_and_log(&mut self, entry: HistoryEntry, log_message: &str) {
        self.add_history(entry);
        self.log("info", log_message);
    }
}

/// Go `url.QueryEscape`(encodeQueryComponent 模式): 未保留字符 `A-Za-z0-9-_.~` 原样,
/// 空格变 `+`, 其余按 UTF-8 字节 `%XX`(大写十六进制)。
///
/// 与 [`crate::cookiecloud`] 的 `path_escape` 不同: 这里 `$&+:=@` 也要转义, 而空格是 `+`。
fn query_escape(text: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        let keep = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~');
        if keep {
            out.push(*byte as char);
        } else if *byte == b' ' {
            out.push('+');
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cookiecloud::test_support::{Route, TestHost};

    /// 夹具里的时间常量: `2026-09-29T10:00:09Z`。
    const FIXED_NOW: u64 = 1_790_676_009_000_000_000;

    fn fixed_clock() {
        clock::testhooks::set_now(Some(FIXED_NOW));
    }

    fn tmdb_item(id: i64, title: &str, media_type: &str, vote: f64) -> TmdbItem {
        TmdbItem {
            id,
            title: title.to_string(),
            media_type: media_type.to_string(),
            vote_average: vote,
            ..TmdbItem::default()
        }
    }

    fn search_body(items: &[TmdbItem]) -> String {
        serde_json::to_string(&json!({"results": items})).unwrap()
    }

    /// 一个「立刻就能订阅成功」的假宿主: TMDB 搜索 + 订阅池(空列表 + 创建成功)。
    fn subscribe_host(search: &str, intent_id: i64) -> TestHost {
        TestHost::install(vec![
            Route::json("GET", "/api/tmdb/search", search),
            Route::json(
                "GET",
                "/api/subscribe/pool/intents",
                r#"{"code":"ok","data":[]}"#,
            ),
            Route::json(
                "POST",
                "/api/subscribe/pool/intents",
                &format!(r#"{{"code":"ok","data":{{"id":{intent_id}}}}}"#),
            ),
        ])
    }

    #[test]
    fn normalize_title_folds_fullwidth_punctuation() {
        assert_eq!(normalize_title("  奥德赛 (2026)  "), "奥德赛 (2026)");
        assert_eq!(normalize_title("奥德赛（2026）"), "奥德赛(2026)");
        assert_eq!(normalize_title("人生路不熟·测试"), "人生路不熟 测试");
        assert_eq!(normalize_title("A：B，C。D！E？"), "a:b,cde");
        assert_eq!(normalize_title("Oppenheimer"), "oppenheimer");
        // Go 是先 TrimSpace 再替换: 间隔号折成的空格不会被 trim 掉
        assert_eq!(normalize_title("片名·"), "片名 ");
        assert_eq!(normalize_title(""), "");
    }

    #[test]
    fn safe_key_filters_and_falls_back() {
        assert_eq!(safe_key("inv_1"), "inv_1");
        assert_eq!(safe_key("inv 1!x"), "inv1x");
        assert_eq!(safe_key("a-b_c.d"), "a-b_cd");
        assert_eq!(safe_key(""), "unknown", "空输入 → unknown");
        assert_eq!(safe_key("中文"), "unknown", "过滤后为空 → unknown");
    }

    #[test]
    fn match_tmdb_scoring_matches_go() {
        let exact = tmdb_item(1, "奥德赛", "movie", 7.5);
        let partial = tmdb_item(2, "奥德赛 (2026)", "tv", 3.0);
        let unrelated = tmdb_item(3, "别的电影", "movie", 9.0);
        let res = TmdbSearchResult {
            results: vec![partial.clone(), exact.clone(), unrelated],
        };

        // 完全相同 + media_type 相符 + 评分 >= 6 → 1.0
        let (best, score) = match_tmdb(Some(&res), "奥德赛", "movie");
        assert_eq!(best.id, 1, "最高分必须是标题完全相同的那条");
        assert!((score - 1.0).abs() < 1e-9, "实际 {score}");

        // wantType 空串 → 没有 media_type 加分: 0.7 + 0.05 = 0.75
        let (best, score) = match_tmdb(Some(&res), "奥德赛", "");
        assert_eq!(best.id, 1);
        assert!((score - 0.75).abs() < 1e-9, "实际 {score}");

        // 互相包含 +0.4: "奥德赛" 含于 "奥德赛 (2026)"; media_type 不符(tv vs movie)
        // 且评分 < 6 → 只有 0.4(Go `main.go:891` 的类型加分要求 `it.MediaType == wantType`)
        let only_partial = TmdbSearchResult {
            results: vec![partial.clone()],
        };
        let (best, score) = match_tmdb(Some(&only_partial), "奥德赛", "movie");
        assert_eq!(best.id, 2);
        assert!((score - 0.4).abs() < 1e-9, "0.4(包含), 实际 {score}");

        // 全角/大小写折算后视为相同: 查询里的全角括号折成半角后与候选标题逐字相同
        // → exact 0.7 + media_type 相符 0.25 = 0.95(评分 < 6 无加分)。
        // (注意 `res` 里 id=2 的标题是 "奥德赛 (2026)" —— 带空格, normalizeTitle 不删
        // 内部空格, Go 那边同样只折全角标点/trim 两端, 所以它不会命中这个查询。)
        let folded = TmdbSearchResult {
            results: vec![tmdb_item(4, "奥德赛(2026)", "tv", 3.0)],
        };
        let (best, score) = match_tmdb(Some(&folded), "奥德赛（2026）", "tv");
        assert_eq!(best.id, 4);
        assert!((score - 0.95).abs() < 1e-9, "0.7 + 0.25, 实际 {score}");

        // 没有任何标题命中 → 返回第一个候选 + 0 分(Go 的 bestScore 从 -1 起)
        let (best, score) = match_tmdb(Some(&res), "完全不存在的片名", "movie");
        assert_eq!(best.id, 2, "无命中时 best 是第一个候选");
        assert!((score - 0.0).abs() < 1e-9, "实际 {score}");

        // None / 空结果 → 零值 + 0
        assert_eq!(match_tmdb(None, "x", "movie"), (TmdbItem::default(), 0.0));
        let empty = TmdbSearchResult { results: vec![] };
        assert_eq!(
            match_tmdb(Some(&empty), "x", "movie"),
            (TmdbItem::default(), 0.0)
        );
    }

    #[test]
    fn tmdb_title_and_year_match_go() {
        let mut item = tmdb_item(1, "奥德赛", "movie", 0.0);
        item.release_date = "2026-08-14".to_string();
        assert_eq!(tmdb_title(&item), "奥德赛");
        assert_eq!(tmdb_year(&item), "2026");

        // 没有 title → 退回 name; 没有 release_date → 取 first_air_date
        let mut tv = tmdb_item(2, "", "tv", 0.0);
        tv.name = "某剧".to_string();
        tv.first_air_date = "2025-01-01".to_string();
        assert_eq!(tmdb_title(&tv), "某剧");
        assert_eq!(tmdb_year(&tv), "2025");

        // 都没有 → 空串
        let bare = TmdbItem::default();
        assert_eq!(tmdb_title(&bare), "");
        assert_eq!(tmdb_year(&bare), "");
        // 短日期(不足 4 位)不取
        let mut short = tmdb_item(3, "x", "movie", 0.0);
        short.release_date = "20".to_string();
        assert_eq!(tmdb_year(&short), "");
    }

    #[test]
    fn query_escape_matches_go_query_escape() {
        assert_eq!(query_escape("奥德赛"), "%E5%A5%A5%E5%BE%B7%E8%B5%9B");
        assert_eq!(query_escape("a b"), "a+b", "空格 → +");
        assert_eq!(query_escape("a:b&c=d"), "a%3Ab%26c%3Dd");
        assert_eq!(query_escape("-_.~"), "-_.~");
        assert_eq!(query_escape("A1"), "A1");
    }

    #[test]
    fn tmdb_search_shape_and_error_branches() {
        fixed_clock();
        let host = TestHost::install(vec![Route::json(
            "GET",
            "/api/tmdb/search",
            r#"{"results":[{"id":1077295,"title":"奥德赛","media_type":"movie","vote_average":7.4}]}"#,
        )]);
        let runtime = Runtime::new();
        let out = runtime.tmdb_search("奥德赛").unwrap();
        assert_eq!(out.results.len(), 1);
        assert_eq!(out.results[0].id, 1077295);
        let request = host.requests().pop().unwrap();
        assert_eq!(request.method, "GET");
        assert_eq!(
            request.path, "/api/tmdb/search?q=%E5%A5%A5%E5%BE%B7%E8%B5%9B",
            "路径必须是 QueryEscape 后的形态"
        );
        assert_eq!(
            request.headers.get("accept").map(String::as_str),
            Some("application/json")
        );
        drop(host);

        // HTTP >= 400 → `TMDB 搜索失败 HTTP <status>`
        let _host = TestHost::install(vec![Route::new("GET", "/api/tmdb/search", 500, b"")]);
        let runtime = Runtime::new();
        assert_eq!(
            runtime.tmdb_search("x").unwrap_err().message(),
            "TMDB 搜索失败 HTTP 500"
        );
        drop(_host);

        // host.call 失败 → 原始错误串
        let _host = TestHost::install(vec![Route::fail("GET", "/api/tmdb/search")]);
        let runtime = Runtime::new();
        assert_eq!(
            runtime.tmdb_search("x").unwrap_err().message(),
            "host_call 返回长度 0"
        );
        drop(_host);

        // 响应不是 JSON → serde 的错误原文(Go 是 json.Unmarshal 的错误)
        let _host = TestHost::install(vec![Route::json("GET", "/api/tmdb/search", "not json")]);
        let runtime = Runtime::new();
        assert!(runtime
            .tmdb_search("x")
            .unwrap_err()
            .message()
            .contains("expected"));
        drop(_host);

        // Go 的 json.Unmarshal 对 `null` 解成零值结构体, 不报错
        let _host = TestHost::install(vec![Route::json("GET", "/api/tmdb/search", "null")]);
        let runtime = Runtime::new();
        assert!(runtime.tmdb_search("x").unwrap().results.is_empty());
    }

    #[test]
    fn host_intent_exists_reads_pool_and_swallows_failures() {
        let host = TestHost::install(vec![Route::json(
            "GET",
            "/api/subscribe/pool/intents",
            r#"{"code":"ok","data":[{"id":171,"tmdb_id":1077295,"media_type":"movie","title":"奥德赛","state":"active"}]}"#,
        )]);
        let runtime = Runtime::new();
        assert_eq!(runtime.host_intent_exists(1077295, "movie"), (true, 171));
        assert_eq!(
            host.last_path("GET", "/api/subscribe/pool/intents")
                .as_deref(),
            Some("/api/subscribe/pool/intents?limit=200")
        );
        // media_type 不符 / tmdb_id 不符 → 不存在
        assert_eq!(runtime.host_intent_exists(1077295, "tv"), (false, 0));
        assert_eq!(runtime.host_intent_exists(999, "movie"), (false, 0));
        // media_type 传空串 → 只要 tmdb_id 命中就算存在(Go 的条件)
        assert_eq!(runtime.host_intent_exists(1077295, ""), (true, 171));
        drop(host);

        // 任何失败都当"不存在"
        for route in [
            Route::new("GET", "/api/subscribe/pool/intents", 500, b""),
            Route::fail("GET", "/api/subscribe/pool/intents"),
            Route::json("GET", "/api/subscribe/pool/intents", "not json"),
        ] {
            let _host = TestHost::install(vec![route]);
            let runtime = Runtime::new();
            assert_eq!(runtime.host_intent_exists(1077295, "movie"), (false, 0));
        }
    }

    #[test]
    fn create_subscription_body_and_idempotency_key_match_go() {
        fixed_clock();
        let host = TestHost::install(vec![Route::json(
            "POST",
            "/api/subscribe/pool/intents",
            r#"{"code":"ok","data":{"id":171}}"#,
        )]);
        let mut runtime = Runtime::new();
        runtime.settings = Settings {
            subscribe_source_filter: Some(vec!["wish".to_string()]),
            ..Settings::EMPTY
        };
        let item = TmdbItem {
            id: 1077295,
            media_type: "movie".to_string(),
            poster_path: "/p1.jpg".to_string(),
            backdrop_path: "/b1.jpg".to_string(),
            ..TmdbItem::default()
        };
        let intent_id = runtime
            .create_subscription("invocation_0001", &item, "", "奥德赛", "2026")
            .unwrap();
        assert_eq!(intent_id, 171);

        let request = host.requests().pop().unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/api/subscribe/pool/intents");
        assert_eq!(
            request.headers.get("idempotency-key").map(String::as_str),
            Some("dc-sub-invocation_0001-1077295"),
            "幂等键规则照抄 Go: dc-sub-<safeKey(invocationID)>-<tmdbID>"
        );
        assert_eq!(
            request.headers.get("content-type").map(String::as_str),
            Some("application/json")
        );
        let raw = crate::store::decode_body(&crate::host::HostCallResponse {
            status: 200,
            headers: Default::default(),
            body_base64: request.body_base64,
        })
        .unwrap();
        let body: Value = serde_json::from_slice(&raw).unwrap();
        assert_eq!(
            body,
            json!({
                "tmdb_id": 1077295,
                "media_type": "movie",
                "season": 0,
                "title": "奥德赛",
                "year": "2026",
                "poster_path": "/p1.jpg",
                "backdrop_path": "/b1.jpg",
                "enabled_sources": ["wish"],
                "episode_scope_mode": "follow"
            })
        );
        // 字段顺序必须与 Go 结构体一致(宿主可能对 body 做指纹)
        let text = std::str::from_utf8(&raw).unwrap();
        let order: Vec<usize> = [
            "\"tmdb_id\"",
            "\"media_type\"",
            "\"season\"",
            "\"title\"",
            "\"year\"",
            "\"poster_path\"",
            "\"backdrop_path\"",
            "\"enabled_sources\"",
            "\"episode_scope_mode\"",
        ]
        .iter()
        .map(|key| text.find(key).expect("字段必须在 body 里"))
        .collect();
        let mut sorted = order.clone();
        sorted.sort_unstable();
        assert_eq!(order, sorted, "字段顺序必须与 Go 一致: {text}");
        // body_base64 不补 padding
        assert!(!text.is_empty());
    }

    #[test]
    fn create_subscription_error_branches_match_go() {
        // item.id == 0 → TMDB 条目无效(不发任何请求)
        let host = TestHost::install(vec![]);
        let runtime = Runtime::new();
        assert_eq!(
            runtime
                .create_subscription("inv", &TmdbItem::default(), "movie", "x", "2026")
                .unwrap_err()
                .message(),
            "TMDB 条目无效"
        );
        assert!(host.requests().is_empty());
        drop(host);

        let item = tmdb_item(1, "x", "tv", 0.0);
        // HTTP >= 400
        let _host = TestHost::install(vec![Route::new(
            "POST",
            "/api/subscribe/pool/intents",
            502,
            b"",
        )]);
        let runtime = Runtime::new();
        assert_eq!(
            runtime
                .create_subscription("inv", &item, "", "x", "")
                .unwrap_err()
                .message(),
            "创建订阅失败 HTTP 502"
        );
        drop(_host);

        // code != ok → Go 的 `%q`
        let _host = TestHost::install(vec![Route::json(
            "POST",
            "/api/subscribe/pool/intents",
            r#"{"code":"duplicate","data":{}}"#,
        )]);
        let runtime = Runtime::new();
        assert_eq!(
            runtime
                .create_subscription("inv", &item, "", "x", "")
                .unwrap_err()
                .message(),
            r#"创建订阅返回异常 code="duplicate""#
        );
        drop(_host);

        // 电视剧: season = 1, media_type 为空时回落 wantType
        let host = TestHost::install(vec![Route::json(
            "POST",
            "/api/subscribe/pool/intents",
            r#"{"code":"ok","data":{"id":7}}"#,
        )]);
        let runtime = Runtime::new();
        let mut tv = item.clone();
        tv.media_type = String::new();
        assert_eq!(
            runtime
                .create_subscription("inv", &tv, "tv", "某剧", "")
                .unwrap(),
            7
        );
        let request = host.requests().pop().unwrap();
        let raw = crate::store::decode_body(&crate::host::HostCallResponse {
            status: 200,
            headers: Default::default(),
            body_base64: request.body_base64,
        })
        .unwrap();
        let body: Value = serde_json::from_slice(&raw).unwrap();
        assert_eq!(body["season"], 1);
        assert_eq!(body["media_type"], "tv");
        assert_eq!(body.get("year"), None, "空 year 带 omitempty");
        assert_eq!(
            body.get("enabled_sources"),
            None,
            "nil subscribe_source_filter 省略"
        );
    }

    #[test]
    fn subscribe_queue_item_reports_needs_review_below_threshold() {
        fixed_clock();
        // TMDB 只有不相关的结果 → 置信度 0 → needs_review(两位小数)
        let _host = subscribe_host(&search_body(&[tmdb_item(9, "别的电影", "movie", 8.0)]), 1);
        let mut runtime = Runtime::new();
        let q = QueueItem {
            douban_ref: "36808876".to_string(),
            title: "奥德赛".to_string(),
            list: "wish".to_string(),
            ..QueueItem::default()
        };
        let settings = Settings::EMPTY;
        let (status, intent_id, message) = runtime.subscribe_queue_item("inv", &q, &settings);
        assert_eq!(status, "needs_review");
        assert_eq!(intent_id, 0);
        assert_eq!(message, "TMDB 匹配置信不足 (0.00)");
        assert!(
            runtime.history.is_none(),
            "needs_review 由调用方写历史, 这里不写"
        );
        drop(_host);

        // TMDB 搜索失败 → failed + 文案
        let _host = TestHost::install(vec![Route::fail("GET", "/api/tmdb/search")]);
        let mut runtime = Runtime::new();
        let (status, _, message) = runtime.subscribe_queue_item("inv", &q, &settings);
        assert_eq!(status, "failed");
        assert_eq!(message, "TMDB 搜索失败: host_call 返回长度 0");
        drop(_host);

        // 命中 → succeeded, 走 do_subscribe
        let host = subscribe_host(
            &search_body(&[tmdb_item(1077295, "奥德赛", "movie", 7.4)]),
            171,
        );
        let mut runtime = Runtime::new();
        let (status, intent_id, message) =
            runtime.subscribe_queue_item("invocation_0001", &q, &settings);
        assert_eq!(
            (status.as_str(), intent_id, message.as_str()),
            ("succeeded", 171, "")
        );
        assert_eq!(host.count("POST", "/api/subscribe/pool/intents"), 1);
        assert_eq!(runtime.stats.total, 1);
        assert_eq!(
            runtime.stats.by_list.as_ref().unwrap().get("wish"),
            Some(&1)
        );
        let history = runtime.history.as_ref().unwrap();
        assert_eq!(history[0].message, "订阅成功");
        assert_eq!(history[0].intent_id, 171);
        assert_eq!(history[0].tmdb_ref, "tmdb:movie:1077295");
        assert_eq!(history[0].list, "wish");
    }

    #[test]
    fn do_subscribe_marks_queue_and_skips_existing_intent() {
        fixed_clock();
        // 宿主已有同类订阅 → 不创建, 但仍算 succeeded 并写去重历史
        let host = TestHost::install(vec![Route::json(
            "GET",
            "/api/subscribe/pool/intents",
            r#"{"code":"ok","data":[{"id":171,"tmdb_id":1077295,"media_type":"movie"}]}"#,
        )]);
        let mut runtime = Runtime::new();
        runtime.queue.items = Some(vec![QueueItem {
            douban_ref: "36808876".to_string(),
            title: "奥德赛".to_string(),
            list: "wish".to_string(),
            state: "observing".to_string(),
            ..QueueItem::default()
        }]);
        let q = runtime.queue.items.as_ref().unwrap()[0].clone();
        let item = tmdb_item(1077295, "奥德赛", "movie", 7.4);
        let (status, intent_id, message) =
            runtime.do_subscribe("invocation_0001", &q, &item, &Settings::EMPTY);
        assert_eq!(
            (status.as_str(), intent_id, message.as_str()),
            ("succeeded", 171, "")
        );
        assert_eq!(
            host.count("POST", "/api/subscribe/pool/intents"),
            0,
            "去重命中时不得创建"
        );
        let queued = &runtime.queue.items.as_ref().unwrap()[0];
        assert_eq!(queued.state, "subscribed");
        assert_eq!(queued.tmdb_ref, "tmdb:movie:1077295");
        assert_eq!(queued.media_type, "", "去重路径不补 media_type(与 Go 一致)");
        let history = runtime.history.as_ref().unwrap();
        assert_eq!(history[0].message, "已存在同类聚合订阅，跳过重复创建");
        assert_eq!(
            runtime.logs.as_ref().unwrap()[0].message,
            "已存在订阅，跳过：奥德赛"
        );
        drop(host);

        // 新建成功 → 回填 media_type/year/poster_path
        let host = subscribe_host(&search_body(&[tmdb_item(1, "x", "movie", 0.0)]), 171);
        let mut runtime = Runtime::new();
        runtime.queue.items = Some(vec![QueueItem {
            douban_ref: "36808876".to_string(),
            title: "奥德赛".to_string(),
            list: "wish".to_string(),
            state: "observing".to_string(),
            ..QueueItem::default()
        }]);
        let q = runtime.queue.items.as_ref().unwrap()[0].clone();
        let mut item = tmdb_item(1077295, "奥德赛", "movie", 7.4);
        item.poster_path = "/p1.jpg".to_string();
        item.release_date = "2026-08-14".to_string();
        let (status, intent_id, _) =
            runtime.do_subscribe("invocation_0001", &q, &item, &Settings::EMPTY);
        assert_eq!((status.as_str(), intent_id), ("succeeded", 171));
        let queued = &runtime.queue.items.as_ref().unwrap()[0];
        assert_eq!(queued.state, "subscribed");
        assert_eq!(queued.tmdb_ref, "tmdb:movie:1077295");
        assert_eq!(queued.media_type, "movie");
        assert_eq!(queued.year, "2026");
        assert_eq!(queued.poster_path, "/p1.jpg");
        assert_eq!(
            runtime.logs.as_ref().unwrap()[0].message,
            "已创建聚合订阅：奥德赛"
        );
        drop(host);

        // 创建失败 → failed + `创建聚合订阅失败: ...`
        let _host = TestHost::install(vec![
            Route::json(
                "GET",
                "/api/subscribe/pool/intents",
                r#"{"code":"ok","data":[]}"#,
            ),
            Route::new("POST", "/api/subscribe/pool/intents", 502, b""),
        ]);
        let mut runtime = Runtime::new();
        let (status, intent_id, message) =
            runtime.do_subscribe("invocation_0001", &q, &item, &Settings::EMPTY);
        assert_eq!(status, "failed");
        assert_eq!(intent_id, 0);
        assert_eq!(message, "创建聚合订阅失败: 创建订阅失败 HTTP 502");
    }

    #[test]
    fn process_due_keeps_and_drops_like_go() {
        fixed_clock();
        let search = search_body(&[tmdb_item(1077295, "奥德赛", "movie", 7.4)]);
        let host = subscribe_host(&search, 171);
        let mut runtime = Runtime::new();
        let past = "2026-09-29T09:00:00Z".to_string();
        let future = "2026-09-30T10:00:00Z".to_string();
        runtime.queue.items = Some(vec![
            QueueItem {
                douban_ref: "due-ok".into(),
                title: "奥德赛".into(),
                list: "wish".into(),
                state: "observing".into(),
                due_at: past.clone(),
                ..QueueItem::default()
            },
            QueueItem {
                douban_ref: "not-due".into(),
                title: "奥德赛".into(),
                list: "wish".into(),
                state: "observing".into(),
                due_at: future,
                ..QueueItem::default()
            },
            QueueItem {
                douban_ref: "review".into(),
                title: "奥德赛".into(),
                list: "wish".into(),
                state: "needs_review".into(),
                due_at: past.clone(),
                ..QueueItem::default()
            },
            QueueItem {
                douban_ref: "bad-date".into(),
                title: "奥德赛".into(),
                list: "wish".into(),
                state: "observing".into(),
                due_at: "garbage".into(),
                ..QueueItem::default()
            },
        ]);
        let (subscribed, needs_review, err) =
            runtime.process_due("invocation_0001", &Settings::EMPTY);
        assert_eq!(
            (subscribed, needs_review, err.as_str()),
            (2, 0, ""),
            "垃圾 due_at 按已到期处理"
        );
        assert_eq!(host.count("POST", "/api/subscribe/pool/intents"), 2);
        let kept: Vec<String> = runtime
            .queue
            .items
            .as_ref()
            .unwrap()
            .iter()
            .map(|item| item.douban_ref.clone())
            .collect();
        assert_eq!(
            kept,
            vec!["not-due".to_string(), "review".to_string()],
            "未到期与 needs_review 保留"
        );
        // 订阅成功的两条都写了历史
        assert_eq!(runtime.stats.total, 2);
        drop(host);

        // 失败 + attempt < 3 → 保留为 needs_review 并记 last_error(attempt 不自增)
        let _host = TestHost::install(vec![Route::fail("GET", "/api/tmdb/search")]);
        let mut runtime = Runtime::new();
        runtime.queue.items = Some(vec![QueueItem {
            douban_ref: "retry".into(),
            title: "奥德赛".into(),
            list: "wish".into(),
            state: "observing".into(),
            due_at: "2026-09-29T09:00:00Z".into(),
            attempt: 1,
            ..QueueItem::default()
        }]);
        let (subscribed, needs_review, _) = runtime.process_due("inv", &Settings::EMPTY);
        assert_eq!((subscribed, needs_review), (0, 1));
        let kept = runtime.queue.items.as_ref().unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].state, "needs_review");
        assert_eq!(kept[0].attempt, 1, "Go 的 attempt 不自增");
        assert_eq!(kept[0].last_error, "TMDB 搜索失败: host_call 返回长度 0");
        drop(_host);

        // 失败 + attempt >= 3 → 丢弃并写 result: failed 的历史
        let _host = TestHost::install(vec![Route::fail("GET", "/api/tmdb/search")]);
        let mut runtime = Runtime::new();
        runtime.queue.items = Some(vec![QueueItem {
            douban_ref: "dead".into(),
            title: "奥德赛".into(),
            list: "wish".into(),
            state: "observing".into(),
            due_at: "2026-09-29T09:00:00Z".into(),
            attempt: 3,
            ..QueueItem::default()
        }]);
        let (subscribed, needs_review, _) = runtime.process_due("inv", &Settings::EMPTY);
        assert_eq!((subscribed, needs_review), (0, 0));
        assert!(runtime.queue.items.as_ref().unwrap().is_empty());
        let history = runtime.history.as_ref().unwrap();
        assert_eq!(history[0].result, "failed");
        assert_eq!(history[0].douban_ref, "dead");
        assert_eq!(history[0].action, "subscribe");
        // 失败历史不计入统计
        assert_eq!(runtime.stats.total, 0);
        drop(_host);

        // 空队列: Go 的 keep 是非 nil 切片 → items 变 [] (不是 null)
        let mut runtime = Runtime::new();
        runtime.queue.items = None;
        let _ = runtime.process_due("inv", &Settings::EMPTY);
        assert_eq!(runtime.queue.items, Some(Vec::new()));
    }

    #[test]
    fn subscribe_from_snapshot_action_paths() {
        fixed_clock();
        let search = search_body(&[tmdb_item(1077295, "奥德赛", "movie", 7.4)]);
        let host = subscribe_host(&search, 171);
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        runtime.snapshot.lists = Some(BTreeMap::from([(
            "hot".to_string(),
            Some(vec![crate::model::ChartItem {
                douban_ref: "36808876".to_string(),
                title: "奥德赛".to_string(),
                url: "https://movie.douban.com/subject/36808876/".to_string(),
                ..crate::model::ChartItem::default()
            }]),
        )]));

        // 未命中 → failed(不发 TMDB 请求, 不落盘)
        let result = runtime
            .subscribe_from_snapshot("invocation_0001", "nope")
            .unwrap();
        assert_eq!(
            result,
            json!({"status": "failed", "message": "榜单快照中未找到该条目"})
        );
        assert_eq!(host.count("GET", "/api/tmdb/search"), 0);

        // 命中 → succeeded + intent_id + 落盘
        let result = runtime
            .subscribe_from_snapshot("invocation_0001", "36808876")
            .unwrap();
        assert_eq!(
            result,
            json!({"status": "succeeded", "message": "订阅成功", "intent_id": 171})
        );
        assert!(
            host.count("PUT", "/api/plugin-runtime/storage/state") >= 1,
            "成功路径要 persist_all"
        );
        let history = runtime.history.as_ref().unwrap();
        assert_eq!(history[0].title, "奥德赛");
        assert_eq!(history[0].list, "", "Go 里局部 QueueItem 的 List 为空");
        drop(host);

        // 置信不足 → failed 文案 + 写 failed 历史 + 落盘
        let host = subscribe_host(&search_body(&[tmdb_item(9, "别的电影", "movie", 8.0)]), 171);
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        runtime.snapshot.lists = Some(BTreeMap::from([(
            "hot".to_string(),
            Some(vec![crate::model::ChartItem {
                douban_ref: "36808876".to_string(),
                title: "奥德赛".to_string(),
                ..crate::model::ChartItem::default()
            }]),
        )]));
        let result = runtime
            .subscribe_from_snapshot("invocation_0001", "36808876")
            .unwrap();
        assert_eq!(
            result,
            json!({"status": "failed", "message": "TMDB 匹配置信不足 (0.00)，无法自动订阅"})
        );
        assert_eq!(host.count("POST", "/api/subscribe/pool/intents"), 0);
        assert!(
            runtime.history.is_none(),
            "置信不足在 do_subscribe 之前就返回, 不写历史"
        );
    }

    #[test]
    fn subscribe_queue_now_action_paths() {
        fixed_clock();
        let search = search_body(&[tmdb_item(1077295, "奥德赛", "movie", 7.4)]);
        let host = subscribe_host(&search, 171);
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        // 队列里找不到
        let result = runtime
            .subscribe_queue_now("invocation_0001", "nope")
            .unwrap();
        assert_eq!(
            result,
            json!({"status": "failed", "message": "观察队列中未找到该条目"})
        );

        runtime.queue.items = Some(vec![QueueItem {
            douban_ref: "36808876".to_string(),
            title: "奥德赛".to_string(),
            list: "wish".to_string(),
            state: "observing".to_string(),
            ..QueueItem::default()
        }]);
        let result = runtime
            .subscribe_queue_now("invocation_0001", "36808876")
            .unwrap();
        assert_eq!(
            result,
            json!({"status": "succeeded", "message": "订阅成功", "intent_id": 171})
        );
        assert_eq!(runtime.queue.items.as_ref().unwrap()[0].state, "subscribed");
        drop(host);

        // needs_review → 历史记 needs_review, 队列标 needs_review + last_error, 返回 failed
        let host = subscribe_host(&search_body(&[tmdb_item(9, "别的电影", "movie", 8.0)]), 171);
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        runtime.queue.items = Some(vec![QueueItem {
            douban_ref: "36808876".to_string(),
            title: "奥德赛".to_string(),
            list: "wish".to_string(),
            state: "observing".to_string(),
            ..QueueItem::default()
        }]);
        let result = runtime
            .subscribe_queue_now("invocation_0001", "36808876")
            .unwrap();
        assert_eq!(
            result,
            json!({"status": "failed", "message": "TMDB 匹配置信不足 (0.00)"})
        );
        let queued = &runtime.queue.items.as_ref().unwrap()[0];
        assert_eq!(queued.state, "needs_review");
        assert_eq!(queued.last_error, "TMDB 匹配置信不足 (0.00)");
        let history = runtime.history.as_ref().unwrap();
        assert_eq!(history[0].result, "needs_review");
        assert_eq!(
            runtime.logs.as_ref().unwrap()[0].message,
            "TMDB 匹配待确认：奥德赛 (TMDB 匹配置信不足 (0.00))"
        );
        assert_eq!(runtime.stats.total, 0, "needs_review 不计统计");
        drop(host);

        // failed → 历史记 failed
        let _host = TestHost::install(vec![Route::fail("GET", "/api/tmdb/search")]);
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        runtime.queue.items = Some(vec![QueueItem {
            douban_ref: "36808876".to_string(),
            title: "奥德赛".to_string(),
            list: "wish".to_string(),
            state: "observing".to_string(),
            ..QueueItem::default()
        }]);
        let result = runtime
            .subscribe_queue_now("invocation_0001", "36808876")
            .unwrap();
        assert_eq!(
            result,
            json!({"status": "failed", "message": "TMDB 搜索失败: host_call 返回长度 0"})
        );
        let history = runtime.history.as_ref().unwrap();
        assert_eq!(history[0].result, "failed");
    }

    #[test]
    fn add_history_prepends_truncates_and_counts_stats() {
        fixed_clock();
        let mut runtime = Runtime::new();
        runtime.settings.max_history = 2;
        runtime.add_history(HistoryEntry {
            douban_ref: "a".into(),
            list: "wish".into(),
            action: "subscribe".into(),
            result: "succeeded".into(),
            ..HistoryEntry::default()
        });
        runtime.add_history(HistoryEntry {
            douban_ref: "b".into(),
            list: "hot".into(),
            action: "subscribe".into(),
            result: "succeeded".into(),
            ..HistoryEntry::default()
        });
        runtime.add_history(HistoryEntry {
            douban_ref: "c".into(),
            list: "wish".into(),
            action: "subscribe".into(),
            result: "failed".into(),
            ..HistoryEntry::default()
        });
        // 前插 + 按 max_history 截断: 只剩 c, b
        let history = runtime.history.as_ref().unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].douban_ref, "c");
        assert_eq!(history[1].douban_ref, "b");
        assert_eq!(
            history[0].created_at, "2026-09-29T10:00:09Z",
            "created_at 取现在"
        );
        // failed 不计数
        assert_eq!(runtime.stats.total, 2);
        assert_eq!(runtime.stats.month, "2026-09");
        assert_eq!(runtime.stats.month_new, 2);
        assert_eq!(
            runtime.stats.by_list.as_ref().unwrap().get("wish"),
            Some(&1)
        );
        assert_eq!(runtime.stats.by_list.as_ref().unwrap().get("hot"), Some(&1));
        // 版本号: 每条历史 +1
        assert_eq!(runtime.revision(), 3);

        // 月份变化时 month_new 归零再加
        let mut runtime = Runtime::new();
        runtime.stats.month = "2026-08".to_string();
        runtime.stats.month_new = 40;
        runtime.add_history(HistoryEntry {
            list: "wish".into(),
            action: "subscribe".into(),
            result: "succeeded".into(),
            ..HistoryEntry::default()
        });
        assert_eq!(runtime.stats.month, "2026-09");
        assert_eq!(runtime.stats.month_new, 1);
        // 非 subscribe 动作不计数
        runtime.add_history(HistoryEntry {
            action: "skip".into(),
            result: "succeeded".into(),
            ..HistoryEntry::default()
        });
        assert_eq!(runtime.stats.total, 1);
    }

    // ─────────────────────── [功能1] 匹配增强 ───────────────────────

    /// rexxar 详情路由: 用脱敏 tv 夹具应答 `m.douban.com/rexxar/api/v2/` 下的请求。
    /// (TestHost 按 `path.starts_with(prefix)` 匹配, 外部请求带完整 URL, 前缀要含域名。)
    fn rexxar_tv_route() -> Route {
        Route::json(
            "GET",
            "https://m.douban.com/rexxar/api/v2/",
            std::str::from_utf8(crate::fixtures::SUBJECT_DETAIL_TV).unwrap(),
        )
    }

    /// 直配(搜豆瓣标题"列奥纳多")只搜到不相关条目。
    fn direct_miss_route() -> Route {
        Route::json(
            "GET",
            &format!("/api/tmdb/search?q={}", query_escape("列奥纳多")),
            &search_body(&[tmdb_item(9, "别的剧", "tv", 8.0)]),
        )
    }

    /// 订阅池: 列表为空 + 创建返回 id=171。
    fn pool_routes() -> Vec<Route> {
        vec![
            Route::json(
                "GET",
                "/api/subscribe/pool/intents",
                r#"{"code":"ok","data":[]}"#,
            ),
            Route::json(
                "POST",
                "/api/subscribe/pool/intents",
                r#"{"code":"ok","data":{"id":171}}"#,
            ),
        ]
    }

    fn leonardo_queue_item() -> QueueItem {
        QueueItem {
            douban_ref: "db:subj:34862797".to_string(),
            title: "列奥纳多".to_string(),
            list: "wish".to_string(),
            // [功能1] 入队带上条目类型(评审修复): 匹配回退按它走 rexxar 的 tv 路径
            media_type: "tv".to_string(),
            ..QueueItem::default()
        }
    }

    /// 回退路径一(包装函数层): 原标题直配失配 → rexxar 详情 → original_title 命中。
    #[test]
    fn match_tmdb_with_detail_fallback_hits_via_original_title() {
        let host = TestHost::install(vec![
            direct_miss_route(),
            rexxar_tv_route(),
            // 原名 "Leonardo" 命中: 完全相同 0.7 + 评分 >= 6 加 0.05
            Route::json(
                "GET",
                "/api/tmdb/search?q=Leonardo",
                &search_body(&[tmdb_item(128007, "Leonardo", "tv", 7.8)]),
            ),
        ]);
        let runtime = Runtime::new();
        let (item, confidence, fallback_hit) = runtime
            .match_tmdb_with_detail_fallback("列奥纳多", "db:subj:34862797", "tv")
            .expect("直配搜索成功, 不该 Err");
        assert_eq!(item.id, 128007);
        assert!(
            (confidence - 0.75).abs() < 1e-9,
            "0.7 + 0.05, 实际 {confidence}"
        );
        assert_eq!(fallback_hit.as_deref(), Some("Leonardo"));

        // 请求顺序: 直配 → rexxar 详情 → 原名重搜; 之后 aka 候选继续逐个搜索
        // (取置信度最高者), 未注册路由 404 被忽略。
        let paths: Vec<String> = host.requests().iter().map(|r| r.path.clone()).collect();
        assert_eq!(
            paths[0],
            format!("/api/tmdb/search?q={}", query_escape("列奥纳多"))
        );
        assert_eq!(
            paths[1], "https://m.douban.com/rexxar/api/v2/tv/34862797",
            "kind 传 tv → tv 路径(评审修复前固定 movie 路径, 剧集详情恒取不到)"
        );
        assert_eq!(paths[2], "/api/tmdb/search?q=Leonardo");
        assert_eq!(paths.len(), 6, "直配 1 + rexxar 1 + 原名/aka 4 个候选各 1");
    }

    /// 回退路径二(包装函数层): 原名也没命中 → aka 列表按序重搜, aka[0] 命中。
    #[test]
    fn match_tmdb_with_detail_fallback_hits_via_aka() {
        let host = TestHost::install(vec![
            direct_miss_route(),
            rexxar_tv_route(),
            // 原名 "Leonardo" 搜到不相关条目 → 0 分
            Route::json(
                "GET",
                "/api/tmdb/search?q=Leonardo",
                &search_body(&[tmdb_item(8, "别的电影", "movie", 9.0)]),
            ),
            // aka[0] "莱昂纳多" 命中
            Route::json(
                "GET",
                &format!("/api/tmdb/search?q={}", query_escape("莱昂纳多")),
                &search_body(&[tmdb_item(128007, "莱昂纳多", "tv", 7.8)]),
            ),
        ]);
        let runtime = Runtime::new();
        let (item, confidence, fallback_hit) = runtime
            .match_tmdb_with_detail_fallback("列奥纳多", "34862797", "tv")
            .expect("直配搜索成功, 不该 Err");
        assert_eq!(item.id, 128007);
        assert_eq!(
            fallback_hit.as_deref(),
            Some("莱昂纳多"),
            "命中的候选名是 aka[0]"
        );
        assert!(
            (confidence - 0.75).abs() < 1e-9,
            "0.7 + 0.05, 实际 {confidence}"
        );

        // 顺序: 直配 → rexxar → 原名(未中) → aka[0](命中)
        let paths: Vec<String> = host.requests().iter().map(|r| r.path.clone()).collect();
        assert_eq!(paths[2], "/api/tmdb/search?q=Leonardo");
        assert_eq!(
            paths[3],
            format!("/api/tmdb/search?q={}", query_escape("莱昂纳多"))
        );
    }

    /// 回退也全失配 → 返回**直配**结果(不吞直配结果, 不新增错误分支)。
    #[test]
    fn match_tmdb_with_detail_fallback_all_miss_returns_direct_result() {
        let host = TestHost::install(vec![
            direct_miss_route(),
            rexxar_tv_route(),
            Route::json(
                "GET",
                "/api/tmdb/search?q=Leonardo",
                &search_body(&[tmdb_item(8, "别的电影", "movie", 9.0)]),
            ),
        ]);
        let runtime = Runtime::new();
        let (item, confidence, fallback_hit) = runtime
            .match_tmdb_with_detail_fallback("列奥纳多", "34862797", "tv")
            .expect("直配搜索成功, 不该 Err");
        assert_eq!(fallback_hit, None);
        assert!((confidence - 0.0).abs() < 1e-9, "回退失败时返回直配置信度");
        assert_eq!(item.id, 9, "不吞直配结果: best 是直配结果的第一个候选");
        // 直配 1 次 + 4 个候选各 1 次(其中部分 404/不相关)
        assert_eq!(host.count("GET", "/api/tmdb/search"), 5);
    }

    /// 详情没取到 / 取不到数字 id → 不发起任何候选搜索, 直接按直配结果判定。
    #[test]
    fn match_tmdb_with_detail_fallback_without_detail_skips_candidates() {
        // rexxar 404 → 没有详情 → 只有直配一次搜索
        let host = TestHost::install(vec![Route::json(
            "GET",
            "/api/tmdb/search",
            &search_body(&[tmdb_item(9, "别的剧", "tv", 8.0)]),
        )]);
        let runtime = Runtime::new();
        let (_, confidence, fallback_hit) = runtime
            .match_tmdb_with_detail_fallback("列奥纳多", "db:subj:34862797", "tv")
            .unwrap();
        assert_eq!(fallback_hit, None);
        assert!((confidence - 0.0).abs() < 1e-9);
        assert_eq!(host.count("GET", "/api/tmdb/search"), 1);
        assert_eq!(
            host.count("GET", "https://m.douban.com/rexxar/"),
            1,
            "rexxar 试过一次"
        );
        drop(host);

        // douban_ref 取不到数字 id → 连 rexxar 都不发
        let host = TestHost::install(vec![Route::json(
            "GET",
            "/api/tmdb/search",
            &search_body(&[tmdb_item(9, "别的剧", "tv", 8.0)]),
        )]);
        let runtime = Runtime::new();
        let (_, _, fallback_hit) = runtime
            .match_tmdb_with_detail_fallback("列奥纳多", "https://movie.douban.com/subject/1/", "")
            .unwrap();
        assert_eq!(fallback_hit, None);
        assert_eq!(host.requests().len(), 1, "只有直配一次, 不发 rexxar");
    }

    /// 三条路径之一(队列入口): 原标题失配 → 原名回退命中 → 订阅成功 + 回退日志。
    #[test]
    fn subscribe_queue_item_falls_back_via_original_title() {
        fixed_clock();
        let mut routes = vec![
            direct_miss_route(),
            rexxar_tv_route(),
            Route::json(
                "GET",
                "/api/tmdb/search?q=Leonardo",
                &search_body(&[tmdb_item(128007, "Leonardo", "tv", 7.8)]),
            ),
        ];
        routes.extend(pool_routes());
        let host = TestHost::install(routes);
        let mut runtime = Runtime::new();

        let q = leonardo_queue_item();
        let (status, intent_id, message) =
            runtime.subscribe_queue_item("invocation_0001", &q, &Settings::EMPTY);
        assert_eq!(
            (status.as_str(), intent_id, message.as_str()),
            ("succeeded", 171, "")
        );
        assert_eq!(host.count("POST", "/api/subscribe/pool/intents"), 1);
        let history = runtime.history.as_ref().unwrap();
        assert_eq!(history[0].message, "订阅成功");
        assert_eq!(history[0].tmdb_ref, "tmdb:tv:128007");
        // 回退日志: `TMDB 回退匹配: <条目> 经 <候选名> 命中`, 在订阅日志之前
        let logs = runtime.logs.as_ref().unwrap();
        assert_eq!(logs[0].level, "info");
        assert_eq!(logs[0].message, "TMDB 回退匹配: 列奥纳多 经 Leonardo 命中");
        assert_eq!(logs[1].message, "已创建聚合订阅：列奥纳多");
    }

    /// 三条路径之二(队列入口): 原名失配 → aka[0] 命中 → 订阅成功 + 回退日志。
    #[test]
    fn subscribe_queue_item_falls_back_via_aka() {
        fixed_clock();
        let mut routes = vec![
            direct_miss_route(),
            rexxar_tv_route(),
            Route::json(
                "GET",
                "/api/tmdb/search?q=Leonardo",
                &search_body(&[tmdb_item(8, "别的电影", "movie", 9.0)]),
            ),
            Route::json(
                "GET",
                &format!("/api/tmdb/search?q={}", query_escape("莱昂纳多")),
                &search_body(&[tmdb_item(128007, "莱昂纳多", "tv", 7.8)]),
            ),
        ];
        routes.extend(pool_routes());
        let host = TestHost::install(routes);
        let mut runtime = Runtime::new();

        let q = leonardo_queue_item();
        let (status, intent_id, _) =
            runtime.subscribe_queue_item("invocation_0001", &q, &Settings::EMPTY);
        assert_eq!((status.as_str(), intent_id), ("succeeded", 171));
        assert_eq!(host.count("POST", "/api/subscribe/pool/intents"), 1);
        let logs = runtime.logs.as_ref().unwrap();
        assert_eq!(logs[0].message, "TMDB 回退匹配: 列奥纳多 经 莱昂纳多 命中");
        let history = runtime.history.as_ref().unwrap();
        assert_eq!(history[0].tmdb_ref, "tmdb:tv:128007");
        assert_eq!(runtime.stats.total, 1, "回退命中的订阅照常计入统计");
    }

    /// 三条路径之三(队列入口): 直配与全部回退候选都失配 → 保持 needs_review,
    /// message 用**直配**置信度; 不写历史、不记回退日志、不创建订阅。
    #[test]
    fn subscribe_queue_item_needs_review_when_all_fallbacks_miss() {
        fixed_clock();
        let host = TestHost::install(vec![
            direct_miss_route(),
            rexxar_tv_route(),
            Route::json(
                "GET",
                "/api/tmdb/search?q=Leonardo",
                &search_body(&[tmdb_item(8, "别的电影", "movie", 9.0)]),
            ),
            // aka[0] 搜到不相关条目; 其余 aka 未注册(404)同样忽略
            Route::json(
                "GET",
                &format!("/api/tmdb/search?q={}", query_escape("莱昂纳多")),
                &search_body(&[tmdb_item(7, "又一部别的", "movie", 9.0)]),
            ),
        ]);
        let mut runtime = Runtime::new();

        let q = leonardo_queue_item();
        let (status, intent_id, message) =
            runtime.subscribe_queue_item("inv", &q, &Settings::EMPTY);
        assert_eq!(status, "needs_review");
        assert_eq!(intent_id, 0);
        assert_eq!(message, "TMDB 匹配置信不足 (0.00)");
        assert_eq!(host.count("POST", "/api/subscribe/pool/intents"), 0);
        assert!(
            runtime.history.is_none(),
            "needs_review 由调用方写历史, 这里不写"
        );
        assert!(runtime.logs.is_none(), "回退失败不记回退日志");
    }

    /// 快照订阅入口同样接线: 原标题失配 → 原名回退命中 → succeeded + 回退日志。
    #[test]
    fn subscribe_from_snapshot_falls_back_via_original_title() {
        fixed_clock();
        let mut routes = vec![
            direct_miss_route(),
            rexxar_tv_route(),
            Route::json(
                "GET",
                "/api/tmdb/search?q=Leonardo",
                &search_body(&[tmdb_item(128007, "Leonardo", "tv", 7.8)]),
            ),
        ];
        routes.extend(pool_routes());
        let host = TestHost::install(routes);
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        // 列奥纳多是剧集: 快照条目放进 tv 榜单(cn_wom 默认 kind=tv), 匹配回退才会走
        // rexxar 的 tv 路径取到详情(评审修复前固定 movie 路径 → 详情恒 None)。
        runtime.snapshot.lists = Some(BTreeMap::from([(
            "cn_wom".to_string(),
            Some(vec![crate::model::ChartItem {
                douban_ref: "34862797".to_string(),
                title: "列奥纳多".to_string(),
                ..crate::model::ChartItem::default()
            }]),
        )]));

        let result = runtime
            .subscribe_from_snapshot("invocation_0001", "34862797")
            .unwrap();
        assert_eq!(
            result,
            json!({"status": "succeeded", "message": "订阅成功", "intent_id": 171})
        );
        assert_eq!(host.count("POST", "/api/subscribe/pool/intents"), 1);
        let logs = runtime.logs.as_ref().unwrap();
        assert_eq!(logs[0].message, "TMDB 回退匹配: 列奥纳多 经 Leonardo 命中");
        drop(host);

        // 快照入口的回退全失配 → failed 文案保持 `，无法自动订阅` 后缀
        let _host = TestHost::install(vec![direct_miss_route(), rexxar_tv_route()]);
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        runtime.snapshot.lists = Some(BTreeMap::from([(
            "cn_wom".to_string(),
            Some(vec![crate::model::ChartItem {
                douban_ref: "34862797".to_string(),
                title: "列奥纳多".to_string(),
                ..crate::model::ChartItem::default()
            }]),
        )]));
        let result = runtime
            .subscribe_from_snapshot("invocation_0001", "34862797")
            .unwrap();
        assert_eq!(
            result,
            json!({"status": "failed", "message": "TMDB 匹配置信不足 (0.00)，无法自动订阅"})
        );
    }
}
