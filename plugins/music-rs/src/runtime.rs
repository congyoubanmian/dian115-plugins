//! 运行时骨架(从 douban-rs `src/runtime.rs` 剥离豆瓣业务后的最小接线层)。
//!
//! 保留的部分:
//! - **状态文档的加载与落盘**: 三态(loaded/fresh/unavailable)、404 两次确认、
//!   加载失败禁止落盘、超预算放弃落盘、日志尾部截断; 全部经 [`crate::store`] 的
//!   ETag 乐观锁 + 幂等键写入;
//! - **op 入口**: [`Runtime::state`](Go `stateResult`)/[`Runtime::action`]/
//!   [`Runtime::job`]/[`Runtime::event`] 四个分发入口的形状与 douban-rs 一致;
//! - **action/job 分发表骨架**: 已挂到 [`crate::netease`]/[`crate::qq`]/
//!   [`crate::download`]/[`crate::tasks`] 的空桩函数(后续阶段填体);
//! - **telegram.callback 事件入口**: 交给 [`crate::tasks::on_telegram_callback`]。
//!
//! 剥离掉的部分(豆瓣业务): 榜单/海报/TMDB/订阅/黑名单/观察队列/CookieCloud 想看的
//! 全部字段与函数; 账号独立键的迁移与覆盖; 旧版分键持久化迁移。
//!
//! 与 douban-rs 一致的两条约定:
//! - wasm 是单线程 reactor, 用 `&mut self` 表达互斥, 不引入锁;
//! - 业务失败是**正常 result**(`{"status":"failed",...}`), 只有 payload 本身非法
//!   才走 `-32602`(`invalid state/action/job/event payload`)。

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::protocol::OpError;
use crate::raw::{self, RawPayload};
use crate::store::{self, LoadResult, PutIds};
use crate::util;
use crate::{cookiecloud, download, netease, qq, tasks};

/// 当前状态文档的 schema 版本。识别"这是不是本插件的状态文档"就靠它。
pub const STATE_SCHEMA: u32 = 1;
/// 持久化预算: 单键超过这个大小就放弃本次落盘。
pub const MAX_PERSIST_BYTES: usize = 4 << 20;
/// 落盘时只保留最近多少条日志。
pub const PERSIST_LOG_LIMIT: usize = 40;
/// 单条日志长度上限(字节)。
pub const LOG_MESSAGE_LIMIT: usize = 400;
/// 状态响应里日志的裁剪上限。
pub const STATE_LOGS_LIMIT: usize = 50;

/// 一条运行日志。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    #[serde(default)]
    pub at: String,
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub message: String,
}

/// 持久化状态文档(`state` 单键)。
///
/// `schema` 用于识别归属: 宿主里可能残留旧插件/别的插件的值, schema 对不上时
/// 一律禁止覆盖([`PersistedState::is_recognizable`])。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PersistedState {
    /// 文档 schema 版本; 缺失按 0 处理(→ 不可识别)。
    #[serde(default)]
    pub schema: u32,
    /// 日志尾部(落盘时裁剪到 [`PERSIST_LOG_LIMIT`])。
    #[serde(default)]
    pub logs: Option<Vec<LogEntry>>,
    /// KV 任务队列(结构由后续阶段定义, 骨架阶段只做透明存取)。
    #[serde(default)]
    pub tasks: Option<Vec<Value>>,
    /// 设置(音质偏好/通知开关等, 后续阶段定义)。
    #[serde(default)]
    pub settings: Option<Map<String, Value>>,
}

impl PersistedState {
    /// 静态构造: 供 [`Runtime::new`] 的 const 上下文使用。
    pub const EMPTY: PersistedState = PersistedState {
        schema: STATE_SCHEMA,
        logs: None,
        tasks: None,
        settings: None,
    };

    /// 解析状态文档; 非法 JSON / 类型不符 → `None`(调用方按不可识别处理)。
    pub fn parse(raw: &[u8]) -> Option<PersistedState> {
        serde_json::from_slice(raw).ok()
    }

    /// 是否是本插件写出来的状态文档。
    pub fn is_recognizable(&self) -> bool {
        self.schema == STATE_SCHEMA
    }

    /// 是否还没有任何实际数据(全新安装的默认值形态)。
    pub fn is_pristine(&self) -> bool {
        self.logs.is_none() && self.tasks.is_none() && self.settings.is_none()
    }
}

/// 运行时状态。
#[derive(Debug, Default)]
pub struct Runtime {
    /// 内存中的状态文档。
    pub state: PersistedState,
    revision: u64,
    last_status: String,
    last_message: String,
    /// 宿主存储是否成功加载过(或确认为全新安装)。
    /// `false` 期间 `persist_all` 不落盘, 防止默认值覆盖用户数据。
    storage_ok: bool,
    load_warned: bool,
    /// `ensure_loaded` 闸门: 整个 worker 会话只加载一次。
    loaded: bool,
    /// PUT 幂等键序列。
    put_ids: PutIds,
}

impl Runtime {
    /// 静态构造: 供 wasm 入口的 `static RUNTIME` 使用(不能有堆分配)。
    pub const fn new() -> Self {
        Runtime {
            state: PersistedState::EMPTY,
            revision: 0,
            last_status: String::new(),
            last_message: String::new(),
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

    // ─────────────────────────── 加载与落盘 ───────────────────────────

    /// 首次业务调用时加载宿主存储。
    ///
    /// 初始化握手(`runtime.initialize`)期间**不能**走这里: 宿主禁止那时的 host.call 重入。
    pub fn ensure_loaded(&mut self) {
        if self.loaded {
            return;
        }
        self.loaded = true;
        self.load_all();
    }

    /// 加载整份状态文档。
    pub fn load_all(&mut self) {
        let (raw, load_result) = store::load_state_with_retry();
        let raw = raw.unwrap_or_default();

        // 不变量: 只有"成功解析出本插件的状态文档"或"404 两次确认的全新安装"才允许落盘。
        let mut restored = false;
        if !raw.is_empty() {
            if let Some(document) = PersistedState::parse(&raw) {
                if document.is_recognizable() {
                    restored = true;
                    self.state = document;
                }
            }
        }
        self.storage_ok = restored || load_result == LoadResult::Fresh;

        if !restored && load_result == LoadResult::Unavailable {
            // 状态不确定: 内存里的默认值仅供展示, storage_ok=false 挡住一切落盘
        }
        self.trace_detail(
            "load",
            &[
                ("state_bytes", Value::from(raw.len())),
                ("state_result", Value::from(load_result.name())),
                ("restored", Value::from(restored)),
            ],
        );
    }

    /// 落盘整份状态文档(经 ETag 乐观锁 + 幂等键)。
    pub fn persist_all(&mut self) {
        if !self.storage_ok {
            let (raw, load_result) = store::load_state_with_retry();
            if load_result == LoadResult::Loaded {
                match raw.as_deref().and_then(PersistedState::parse) {
                    Some(document) if document.is_recognizable() => {
                        // 恢复期间只补空档: 内存里已有数据时不覆盖。
                        if self.state.is_pristine() {
                            self.state = document;
                        }
                        self.storage_ok = true;
                    }
                    _ => {
                        // 读到了值, 但它不是本插件的状态文档(响应格式变化/值损坏)。
                        // 继续落盘就会用内存里的默认值覆盖宿主里已有数据, 因此拒绝。
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
        let mut document = self.state.clone();
        let mut log_tail: Vec<LogEntry> = Vec::with_capacity(PERSIST_LOG_LIMIT);
        if let Some(logs) = &self.state.logs {
            if !logs.is_empty() {
                let start = logs.len().saturating_sub(PERSIST_LOG_LIMIT);
                log_tail.extend_from_slice(&logs[start..]);
            }
        }
        document.logs = Some(log_tail);
        document.schema = STATE_SCHEMA;

        let data = match serde_json::to_vec(&document) {
            Ok(data) => data,
            Err(err) => {
                self.log("warning", &format!("持久化失败: marshal:{err}"));
                return;
            }
        };
        if data.len() > MAX_PERSIST_BYTES {
            self.log(
                "warning",
                &format!("状态文档 {} 字节超过上限, 本次改动暂不落盘", data.len()),
            );
            return;
        }
        if let Err(err) = store::put(&mut self.put_ids, store::STATE_KEY, &data) {
            self.log("warning", &format!("持久化失败: {err}"));
        }
    }

    /// 写一条运行日志(长度按 [`LOG_MESSAGE_LIMIT`] 字节截断)。
    pub fn log(&mut self, level: &str, message: &str) {
        let message = if message.len() > LOG_MESSAGE_LIMIT {
            format!("{}...(truncated)", util::trunc(message.as_bytes()))
        } else {
            message.to_string()
        };
        let entry = LogEntry {
            at: crate::clock::now_rfc3339(),
            level: level.to_string(),
            message,
        };
        let logs = self.state.logs.get_or_insert_with(Vec::new);
        logs.push(entry);
        let overflow = logs.len().saturating_sub(PERSIST_LOG_LIMIT);
        if overflow > 0 {
            logs.drain(..overflow);
        }
        self.revision += 1;
    }

    /// 诊断面包屑(落 `diag` 键, 失败忽略 —— 诊断不能影响主流程)。
    pub fn trace(&mut self, step: &str) {
        self.trace_detail(step, &[]);
    }

    /// 带字段的诊断面包屑。
    pub fn trace_detail(&mut self, step: &str, extra: &[(&str, Value)]) {
        let mut event = Map::new();
        event.insert("at".to_string(), Value::String(crate::clock::now_rfc3339()));
        event.insert("step".to_string(), Value::String(step.to_string()));
        for (key, value) in extra {
            event.insert((*key).to_string(), value.clone());
        }
        let payload = Value::Object(event).to_string();
        let _ = store::put(&mut self.put_ids, store::DIAG_KEY, payload.as_bytes());
    }

    /// 更新状态栏并推进 revision。
    pub fn bump(&mut self, status: &str, message: &str) {
        self.last_status = status.to_string();
        self.last_message = message.to_string();
        self.revision += 1;
    }

    // ─────────────────────────── 协议入口 ───────────────────────────

    /// 对应 Go `stateResult`。
    pub fn state(&mut self, payload: RawPayload<'_>) -> Result<Value, OpError> {
        let obj = payload.as_object().map_err(|_| invalid_state())?;
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

    /// 宿主 state 响应里的 `state` 字段。
    ///
    /// 设置与任务队列各自存放在 KV `settings` / `tasks` 键上(见 [`crate::download`] /
    /// [`crate::tasks`] 的模块说明), 这里做实时汇总: 每次 state 调用都重新读取,
    /// 保证 UI 看到最新队列; 状态文档键 `state` 只保留日志与 revision。
    pub(crate) fn state_doc(&self) -> Value {
        let all_logs = self.state.logs.clone().unwrap_or_default();
        let log_start = all_logs.len().saturating_sub(STATE_LOGS_LIMIT);
        let logs: Vec<LogEntry> = all_logs[log_start..].to_vec();

        let mut state = Map::new();
        state.insert("status".to_string(), Value::String(self.last_status.clone()));
        state.insert("last_message".to_string(), Value::String(self.last_message.clone()));
        state.insert("revision".to_string(), Value::from(self.revision));
        state.insert("schema".to_string(), Value::from(self.state.schema));
        state.insert("settings".to_string(), download::settings_doc());
        state.insert("tasks".to_string(), Value::Array(tasks::state_view()));
        state.insert("login".to_string(), login_summary());
        state.insert("roots".to_string(), download::state_probe());
        state.insert("logs".to_string(), serde_json::to_value(logs).unwrap_or(Value::Array(vec![])));
        Value::Object(state)
    }

    /// action 分发表。
    ///
    /// action id 与落地函数:
    ///
    /// | action id | 参数 | 落地函数 |
    /// |-----------|------|----------|
    /// | `search` | `source` / `query` / `page` | [`crate::netease::search`] / [`crate::qq::search`] |
    /// | `song-url` | `source` / `song_id` / `level` | [`crate::netease::song_url`] / [`crate::qq::song_url`] |
    /// | `playlists` | `source` | [`crate::netease::playlists`](仅网易云; 其他来源报"该来源暂不支持歌单") |
    /// | `playlist-songs` | `source` / `id` / `page` / `page_size` | [`crate::netease::playlist_songs`](仅网易云; `page_size` 缺省 100) |
    /// | `playlist-queue-all` | `source` / `id` / `quality` / `batch_pages` / `next_page` | [`crate::download::playlist_queue_all`](整单入队: 每批一次 v6 全量索引 + 每页 100 首切片走 v3 详情与索引去重; `batch_pages` 缺省 5 上限 10; `next_page` 缺省 1 作为续批游标; 页面失败是业务 failed 并回传 `next_page`) |
    /// | `qr-create` | `source` | [`crate::netease::qr_create`] / [`crate::qq::qr_create`](QQ 返回 [`crate::qq::QR_UNAVAILABLE`]) |
    /// | `qr-poll` | `source` / `key` | [`crate::netease::qr_poll`] / [`crate::qq::qr_poll`] |
    /// | `qq-cookie-paste` | `cookie`(浏览器复制的 Cookie 头) | [`crate::qq::save_cookie_string`] |
    /// | `netease-cookie-paste` | `cookie`(浏览器复制的 Cookie 头) | [`crate::netease::save_cookie_string`] |
    /// | `cookiecloud-sync` | —(URL/UUID/口令从 KV 设置取) | [`crate::cookiecloud::action_cookiecloud_sync`] |
    /// | `login-status` | `source` | [`crate::netease::login_status`] / [`crate::qq::login_status`] |
    /// | `download` | `source` / `song_id` / `name` / `singers` / `album` / `level` | [`crate::download::request_download`] |
    /// | `settings-update` | `input` 对象(可含 `qq_cookie`/`netease_cookie`) | [`crate::download::settings_update`] + [`crate::qq::save_cookie_string`]; 保存结果回填 `qq_login`/`netease_login` 键(响应键名不含 "cookie" 子串, 见 `settings-update` 分支注释) |
    /// | `task-retry` | `id` | [`crate::tasks::retry`](/读 `task.<id>` 重置排队) |
    /// | `task-clear` | — | [`crate::tasks::clear_finished`](/遍历索引删完结分片) |
    /// | `archive` | — | [`crate::tasks::clear_finished`] + 清日志 |
    /// | `queue-pump` | — | [`crate::tasks::queue_pump`](前台手动推进) |
    /// | `pump` | — | [`crate::tasks::queue_pump`](/0.3.12: 与 job `queuePump` 同一入口的手动快进) |
    /// | 其他 | — | `unknown_action` |
    ///
    /// 业务失败是**正常 result**, 不是 JSON-RPC error; 只有 payload 本身非法
    /// (`invalid action payload`)才走 `-32602`。
    pub fn action(&mut self, _invocation_id: &str, payload: RawPayload<'_>) -> Result<Value, OpError> {
        let obj = payload.as_object().map_err(|_| invalid_action())?;
        let id = raw::string_field(obj, "id").map_err(|_| invalid_action())?;
        if id.is_empty() {
            return Err(invalid_action());
        }
        let input: Map<String, Value> = match obj.and_then(|map| map.get("input")) {
            Some(Value::Object(input)) => input.clone(),
            _ => Map::new(),
        };
        let source = input_str(&input, "source");

        match id.as_str() {
            "search" => Ok(action_result(search(&source, &input_str(&input, "query"), input_u32(&input, "page", 1)))),
            "song-url" => Ok(action_result(song_url(
                &source,
                &input_str(&input, "song_id"),
                &input_str(&input, "level"),
            ))),
            "playlists" => Ok(action_result(playlists(&source))),
            "playlist-songs" => Ok(action_result(playlist_songs(
                &source,
                &input_str(&input, "id"),
                input_u32(&input, "page", 1),
                input_u32(&input, "page_size", 100),
            ))),
            "playlist-queue-all" => {
                // 0.3.14: 整单全量入队(每页 100 首, 走索引去重)。页面级失败是业务
                // failed, 响应自带已入队计数与 `next_page`; 这里直接把函数产出的
                // action result 返回, 不再经 action_result 二次包裹(会丢部分数据)。
                // `next_page` 是续批游标: 大歌单分多批时把上一批返回的 next_page 传回来,
                // 从该页继续, 不会重复处理已经入队的页。
                let outcome = download::playlist_queue_all(
                    &mut self.put_ids,
                    &download::PlaylistQueueRequest {
                        source: source.clone(),
                        playlist_id: input_str(&input, "id"),
                        quality: input_str(&input, "quality"),
                        batch_pages: input_u32(
                            &input,
                            "batch_pages",
                            download::PLAYLIST_QUEUE_DEFAULT_PAGES,
                        ),
                        next_page: input_u32(&input, "next_page", 1),
                    },
                );
                if outcome["status"] == "succeeded" {
                    let data = &outcome["data"];
                    self.bump(
                        "succeeded",
                        &format!(
                            "歌单入队: 新增 {} 首, 去重 {} 首",
                            data["queued"], data["deduped"]
                        ),
                    );
                } else if outcome["status"] == "skipped" {
                    // 0.3.15: 队列操作互斥把本批挡下 —— 什么都没做, 提示稍后再试,
                    // 不当失败(不写 error, 续批游标停在请求的起始页)。
                    let message = outcome["message"]
                        .as_str()
                        .unwrap_or("队列操作正在进行, 请稍后再试");
                    self.bump("skipped", message);
                } else {
                    self.bump("failed", &format!("歌单入队失败: {}", outcome["message"]));
                }
                Ok(outcome)
            }
            "qr-create" => Ok(action_result(qr_create(&source))),
            "qr-poll" => Ok(action_result(qr_poll(&source, &input_str(&input, "key")))),
            "login-status" => Ok(action_result(login_status(&source))),
            "download" => {
                // `level` 优先, 兼容前端传 `quality`; 都为空时用 KV 设置里的默认音质。
                let level = {
                    let explicit = input_str(&input, "level");
                    if explicit.is_empty() { input_str(&input, "quality") } else { explicit }
                };
                let outcome = download::request_download(
                    &mut self.put_ids,
                    &download::DownloadRequest {
                        source: source.clone(),
                        song_id: input_str(&input, "song_id"),
                        name: input_str(&input, "name"),
                        singers: input_str(&input, "singers"),
                        album: input_str(&input, "album"),
                        level,
                    },
                );
                match &outcome {
                    // 0.3.15: 被队列操作互斥跳过时不能报"已加入下载队列"(其实没入队)。
                    Ok(value) if value.get("skipped").and_then(Value::as_str).is_some() => {
                        let message = value
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("队列操作正在进行, 请稍后再试");
                        self.bump("skipped", message);
                    }
                    Ok(_) => self.bump("succeeded", "已加入下载队列"),
                    Err(_) => {}
                }
                Ok(action_result(outcome))
            }
            "settings-update" => {
                // 可选的 `qq_cookie` / `netease_cookie`(输入键不受宿主校验): 宿主剥离
                // 外部响应的 set-cookie(host-call-v2.md §3), 扫码成功也拿不到登录
                // Cookie, 允许粘贴随设置一起入库。
                // 保存结果回填到 `qq_login` / `netease_login` 键 —— 宿主(2026-09-30)
                // 递归拒绝 action 响应里键名含 "cookie" 子串的整个响应(见
                // [`crate::cookiecloud`] 模块头), 键名不能沿用输入里的 `*_cookie`;
                // 值侧只有 saved/logged_in/uin/has_key 等布尔与账号标识, 不回显凭据。
                let pasted_qq = input.get("qq_cookie").and_then(Value::as_str).map(str::to_string);
                let pasted_ne =
                    input.get("netease_cookie").and_then(Value::as_str).map(str::to_string);
                let mut value = self.settings_update(&input);
                if let Some(raw) = pasted_qq {
                    value["qq_login"] = match qq::save_cookie_string(&raw) {
                        Ok(info) => {
                            self.bump("succeeded", "QQ cookie 已保存");
                            info
                        }
                        Err(err) => {
                            self.bump("failed", &format!("QQ cookie 保存失败: {err}"));
                            json!({"status": "failed", "message": err})
                        }
                    };
                }
                if let Some(raw) = pasted_ne {
                    value["netease_login"] = match netease::save_cookie_string(&raw) {
                        Ok(info) => {
                            self.bump("succeeded", "网易云 cookie 已保存");
                            info
                        }
                        Err(err) => {
                            self.bump("failed", &format!("网易云 cookie 保存失败: {err}"));
                            json!({"status": "failed", "message": err})
                        }
                    };
                }
                Ok(value)
            }
            "qq-cookie-paste" => {
                let outcome = qq::save_cookie_string(&input_str(&input, "cookie"));
                if outcome.is_ok() {
                    self.bump("succeeded", "QQ cookie 已保存");
                }
                Ok(action_result(outcome))
            }
            "netease-cookie-paste" => {
                let outcome = netease::save_cookie_string(&input_str(&input, "cookie"));
                if outcome.is_ok() {
                    self.bump("succeeded", "网易云 cookie 已保存");
                }
                Ok(action_result(outcome))
            }
            "cookiecloud-sync" => {
                // 无入参: URL/UUID/口令都从 KV 设置里取(cookiecloud.rs)。
                // 结果键名避开宿主 2026-09-30 的 "cookie" 键名校验(见 cookiecloud.rs)。
                let outcome = cookiecloud::action_cookiecloud_sync();
                match &outcome {
                    Ok(value) => {
                        let netease_logged = value["netease"]["logged_in"].as_bool().unwrap_or(false);
                        let qq_logged = value["qq"]["logged_in"].as_bool().unwrap_or(false);
                        self.bump(
                            "succeeded",
                            &format!(
                                "已从 CookieCloud 同步登录态(网易云 {}, QQ {})",
                                if netease_logged { "已登录" } else { "未登录" },
                                if qq_logged { "已登录" } else { "未登录" },
                            ),
                        );
                    }
                    Err(err) => self.bump("failed", &format!("CookieCloud 同步失败: {err}")),
                }
                Ok(action_result(outcome))
            }
            "task-retry" => {
                let outcome = tasks::retry(&mut self.put_ids, &input_str(&input, "id"));
                if outcome.is_ok() {
                    self.bump("succeeded", "任务已重新排队");
                }
                Ok(action_result(outcome))
            }
            "task-clear" => {
                let outcome = tasks::clear_finished(&mut self.put_ids)
                    .map(|removed| json!({"removed": removed}));
                if outcome.is_ok() {
                    self.bump("succeeded", "已清理完成任务");
                }
                Ok(action_result(outcome))
            }
            "archive" => Ok(self.archive()),
            "queue-pump" | "pump" => {
                // 0.3.12: `pump` 是给 UI 的手动快进入口, 与定时 job `queuePump`
                // 走**同一个**函数(`tasks::queue_pump` → `download::pump`) ——
                // 单次调用只新开 1 首下载, 所以 UI 连点几次是安全的吞吐兜底。
                // 0.3.15: 与另一个队列操作(cron/入队)撞车时 `pump` 直接返回 skipped,
                // 这里同样把状态栏标成"已跳过", 不报"已推进"。
                let outcome = tasks::queue_pump(&mut self.put_ids);
                match &outcome {
                    Ok(value) if value.get("skipped").and_then(Value::as_str).is_some() => {
                        let message = value
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("队列操作正在进行, 请稍后再试");
                        self.bump("skipped", message);
                    }
                    Ok(_) => self.bump("succeeded", "任务队列已推进"),
                    Err(_) => {}
                }
                Ok(action_result(outcome))
            }
            _ => Ok(json!({"status": "failed", "code": "unknown_action", "message": "未知动作"})),
        }
    }

    /// job 分发表骨架。
    ///
    /// | job id | 落地函数 |
    /// |--------|----------|
    /// | `queue-pump` | [`crate::tasks::queue_pump`](manifest `jobs[].handler = "queuePump"`) |
    /// | 其他 | `"未声明的任务"` |
    pub fn job(&mut self, _invocation_id: &str, payload: RawPayload<'_>) -> Result<Value, OpError> {
        let obj = match payload.as_object() {
            Ok(obj) => obj,
            // 参数无效是正常 result(不是 JSON-RPC error)
            Err(_) => return Ok(json!({"status": "skipped", "message": "任务参数无效"})),
        };
        let id = match raw::string_field(obj, "id") {
            Ok(id) => id,
            Err(_) => return Ok(json!({"status": "skipped", "message": "任务参数无效"})),
        };
        match id.as_str() {
            "queue-pump" => match tasks::queue_pump(&mut self.put_ids) {
                Ok(value) => {
                    self.persist_all();
                    Ok(json!({"status": "accepted", "message": "任务队列已推进", "result": value}))
                }
                Err(err) => Ok(json!({"status": "skipped", "message": err})),
            },
            _ => Ok(json!({"status": "skipped", "message": "未声明的任务"})),
        }
    }

    /// 事件入口: 只认有 topic 的事件; `telegram.callback` 交给 [`crate::tasks`]。
    pub fn event(&mut self, payload: RawPayload<'_>) -> Result<Value, OpError> {
        let obj = payload.as_object().map_err(|_| invalid_event())?;
        let topic = raw::string_field(obj, "topic").map_err(|_| invalid_event())?;
        if topic.is_empty() {
            return Err(invalid_event());
        }
        if topic == crate::TELEGRAM_CALLBACK_TOPIC {
            let data = obj.and_then(|map| map.get("data")).cloned().unwrap_or(Value::Null);
            return match tasks::on_telegram_callback(&mut self.put_ids, &data) {
                Ok(value) => {
                    // 状态里的任务列表每次 state 都重读, 但 revision 要推进,
                    // 否则带 if_none_match 的 UI 会一直拿到 not_modified。
                    self.bump("succeeded", "Telegram 回调已处理");
                    Ok(json!({"accepted": true, "result": value}))
                }
                // 失败 → accepted:false, 宿主按重试策略再投递
                Err(err) => Ok(json!({"accepted": false, "message": err})),
            };
        }
        Ok(json!({"accepted": true}))
    }

    /// 设置合并(action `settings-update`): 写 KV `settings`(ETag 乐观锁 + 幂等键)。
    pub fn settings_update(&mut self, patch: &Map<String, Value>) -> Value {
        match download::settings_update(&mut self.put_ids, patch) {
            Ok(settings) => {
                self.bump("succeeded", "设置已保存");
                json!({"status": "succeeded", "message": "设置已保存", "settings": settings})
            }
            Err(err) => {
                self.bump("failed", &format!("设置保存失败: {err}"));
                json!({"status": "failed", "message": err})
            }
        }
    }

    /// action `archive`: 清掉已终态任务并清空日志(对应 Go 版 music-dl 的 `archive`)。
    pub fn archive(&mut self) -> Value {
        match tasks::clear_finished(&mut self.put_ids) {
            Ok(removed) => {
                self.state.logs = Some(Vec::new());
                self.persist_all();
                self.bump("succeeded", "已归档");
                json!({"status": "succeeded", "message": "已归档", "removed": removed})
            }
            Err(err) => json!({"status": "failed", "message": err}),
        }
    }
}

/// 登录态摘要(state 响应用; 只回布尔与账号标识, 绝不回显 cookie 值)。
fn login_summary() -> Value {
    let netease =
        netease::login_status().unwrap_or_else(|err| json!({"logged_in": false, "error": err}));
    let qq = qq::login_status().unwrap_or_else(|err| json!({"logged_in": false, "error": err}));
    json!({"netease": netease, "qq": qq})
}

/// 递归清除任何会被宿主判定为"绝对路径"的字符串(与 douban-rs 的 sanitize_state 同一宿主
/// 行为): 宿主安全过滤遇到以 "/" 开头的字符串会把**整个 state 响应**以 502 拒绝,
/// 表现为 UI 一直报 runtime_protocol_error。settings/roots 等已知路径字段在
/// [`crate::download::display_path`] 里已转成无斜杠形态, 这里是兜底 —— 主要兜住
/// 任务 error、日志消息等运行期才产生、可能混入绝对路径的字符串。
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

/// 与 douban-rs `looksLikeAbsPath` 一致: len>=2 且以 "/" 开头但不以 "//" 开头。
pub fn looks_like_abs_path(s: &str) -> bool {
    s.len() >= 2 && s.starts_with('/') && !s.starts_with("//")
}

/// 取字符串参数(缺失/非字符串 → 空串, 骨架阶段不做严格类型校验)。
fn input_str(input: &Map<String, Value>, key: &str) -> String {
    input.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// 取 u32 参数(缺失/类型不符 → fallback)。
fn input_u32(input: &Map<String, Value>, key: &str, fallback: u32) -> u32 {
    input.get(key).and_then(Value::as_u64).map(|value| value as u32).unwrap_or(fallback)
}

/// 按来源路由搜索(空桩; 未知来源是业务失败, 不是协议错误)。
fn search(source: &str, query: &str, page: u32) -> Result<Value, String> {
    match source {
        "netease" => netease::search(query, page),
        "qq" => qq::search(query, page),
        _ => Err(format!("未知音乐源: {source}")),
    }
}

/// 按来源路由取链(空桩)。
fn song_url(source: &str, song_id: &str, level: &str) -> Result<Value, String> {
    match source {
        "netease" => netease::song_url(song_id, level)
            .map(|song| serde_json::to_value(song).unwrap_or(Value::Null)),
        "qq" => qq::song_url(song_id, level)
            .map(|song| serde_json::to_value(song).unwrap_or(Value::Null)),
        _ => Err(format!("未知音乐源: {source}")),
    }
}

/// 按来源路由扫码创建(空桩)。
fn qr_create(source: &str) -> Result<Value, String> {
    match source {
        "netease" => netease::qr_create(),
        "qq" => qq::qr_create(),
        _ => Err(format!("未知音乐源: {source}")),
    }
}

/// 按来源路由扫码轮询(空桩)。
fn qr_poll(source: &str, key: &str) -> Result<Value, String> {
    match source {
        "netease" => netease::qr_poll(key),
        "qq" => qq::qr_poll(key),
        _ => Err(format!("未知音乐源: {source}")),
    }
}

/// 按来源路由登录态查询(空桩)。
fn login_status(source: &str) -> Result<Value, String> {
    match source {
        "netease" => netease::login_status(),
        "qq" => qq::login_status(),
        _ => Err(format!("未知音乐源: {source}")),
    }
}

/// 按来源路由歌单列表(仅网易云; 其他来源是业务失败, 不是协议错误)。
fn playlists(source: &str) -> Result<Value, String> {
    match source {
        "netease" => netease::playlists(),
        _ => Err("该来源暂不支持歌单，先支持网易云".to_string()),
    }
}

/// 按来源路由歌单歌曲页(仅网易云; 其他来源是业务失败, 不是协议错误)。
fn playlist_songs(source: &str, id: &str, page: u32, page_size: u32) -> Result<Value, String> {
    match source {
        "netease" => netease::playlist_songs(id, page, page_size),
        _ => Err("该来源暂不支持歌单，先支持网易云".to_string()),
    }
}

/// 空桩返回值 → action 的 result 形状: `Ok` → succeeded, `Err` → failed。
///
/// 0.3.15: 队列操作互斥(`download` 入队 / `pump`)在忙时返回带 `skipped` 的 Ok ——
/// 那是"什么都没做, 稍后再试", 既不是成功也不是失败: 状态给 `skipped`, 让 UI
/// 提示而不是误报"已加入队列"/"已推进"。
fn action_result(outcome: Result<Value, String>) -> Value {
    match outcome {
        Ok(value) => {
            if let Some(reason) = value.get("skipped").and_then(Value::as_str) {
                let message = value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("队列操作正在进行, 请稍后再试");
                return json!({
                    "status": "skipped",
                    "skipped": reason,
                    "message": message,
                    "data": value,
                });
            }
            json!({"status": "succeeded", "data": value})
        }
        Err(message) => json!({"status": "failed", "message": message}),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::raw::RawPayload;

    /// `playlist-queue-all` 已挂在分发表上: 非网易云来源是**业务 failed**(不是
    /// `unknown_action`), 且不触碰存储(校验在取页之前返回)。
    #[test]
    fn playlist_queue_all_action_is_wired() {
        let mut runtime = Runtime::new();
        let payload_value = json!({
            "id": "playlist-queue-all",
            "input": {"source": "qq", "id": "42", "quality": "lossless", "batch_pages": 5}
        });
        let result = runtime.action("inv-1", RawPayload::Value(&payload_value)).unwrap();
        assert_ne!(result["code"], "unknown_action", "action 未挂载: {result}");
        assert_eq!(result["status"], "failed");
        assert!(
            result["message"].as_str().unwrap().contains("暂不支持歌单"),
            "{result}"
        );
    }

    /// 未知 action 仍然是 `unknown_action`(挂载没有把兜底分支吃掉)。
    #[test]
    fn unknown_action_still_falls_through() {
        let mut runtime = Runtime::new();
        let payload_value = json!({"id": "no-such-action"});
        let result = runtime.action("inv-2", RawPayload::Value(&payload_value)).unwrap();
        assert_eq!(result["code"], "unknown_action");
    }

    /// 续批游标 `next_page` 从 action 入参透传到取页: 本机无宿主网络, 第 6 页取歌必然
    /// 失败, 失败响应里的 `next_page` 应恰是请求的起始页(而不是硬编码的 1)。
    #[test]
    fn playlist_queue_all_action_passes_next_page() {
        let mut runtime = Runtime::new();
        let payload_value = json!({
            "id": "playlist-queue-all",
            "input": {"source": "netease", "id": "42", "quality": "lossless", "batch_pages": 5, "next_page": 6}
        });
        let result = runtime.action("inv-3", RawPayload::Value(&payload_value)).unwrap();
        assert_eq!(result["status"], "failed", "无宿主网络应取页失败: {result}");
        assert_eq!(
            result["data"]["next_page"], 6,
            "续批游标应透传到取页起点: {result}"
        );
    }
}
