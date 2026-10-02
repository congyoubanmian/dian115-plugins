//! 任务队列(KV 键 `tasks`)与 Telegram 回调 —— 下载状态机的持久层。
//!
//! 队列语义对照 sidecar `music-agent/app/server.mjs`:
//! - 入队去重按 `source + song_id + quality`: 同键的**进行中**任务直接复用
//!   (`server.mjs` 每次新建; 去重是宿主代下载版的补充);
//! - 并发上限由 `download::pump` 按 `settings.max_active` 执行, 取队列按
//!   `created_ms` 升序(对应 `pumpQueue` 的 `sort((a,b) => a.created - b.created)`);
//! - 命名规则 `"{singers} - {name}.{ext}"`, 非法字符 `\/:*?"<>|` 替换为 `_`
//!   (对应 `server.mjs:446` 的 `outPathFor`);
//! - 失败消息: 宿主任务/调用给出的错误文本原样落 `error`, 缺省补 `"失败"`
//!   (对应失败分支的 `r.error || '失败'`)。
//!
//! KV 走 [`crate::store`] 的 ETag 乐观锁 + 幂等键; 时间全部走 [`crate::clock`]。
//! pump 本体在 [`crate::download::pump`](状态机的跨模块入口)。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::clock;
use crate::download;
use crate::store::{self, PutIds};

/// 任务队列的 KV 键。
pub const TASKS_KEY: &str = "tasks";

/// 状态: 排队中, 等待 pump 取链并提交宿主下载。
pub const STATUS_QUEUED: &str = "queued";
/// 状态: 宿主下载任务已提交, 轮询 `job_ref` 中。
pub const STATUS_DOWNLOADING: &str = "downloading";
/// 状态: 暂存文件已定名, 等待/重试复制进目标目录。
pub const STATUS_COPYING: &str = "copying";
/// 状态: 已完成。
pub const STATUS_DONE: &str = "done";
/// 状态: 已失败(尝试次数用尽, 可经 Telegram 回调重试)。
pub const STATUS_FAILED: &str = "failed";

/// `state` 响应里返回的任务条数上限("最近 200 条")。
pub const STATE_TASKS_LIMIT: usize = 200;

/// 单次下载的最大尝试次数(失败重试 ≤3)。
pub const MAX_ATTEMPTS: u32 = 3;

/// 短 id 最大长度。Telegram `callback_data` 限 32 字节, `retry:<id>` 必须放得下;
/// 需求同时限定 ≤8 字符。
pub const MAX_TASK_ID_LEN: usize = 8;

/// 重试按钮的 callback_data 前缀。
pub const RETRY_PREFIX: &str = "retry:";

/// 非法文件名字符(sidecar `outPathFor` 的正则 `[\\/:*?"<>|]`)。
const ILLEGAL_NAME_CHARS: [char; 9] = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];

/// 短 id 的取值空间: 36^8, 保证 base36 结果不超过 8 字符。
const ID_SPACE: u64 = 2_821_109_907_456;

/// 一条下载任务(KV `tasks` 数组的元素)。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    /// 短 id(≤8 字符, base36), 同时用于暂存文件名 `<id>.part` 与 `retry:<id>`。
    #[serde(default)]
    pub id: String,
    /// 音乐来源: `netease` / `qq`。
    #[serde(default)]
    pub source: String,
    /// 歌曲在来源侧的标识(网易 id / QQ songmid)。
    #[serde(default)]
    pub song_id: String,
    /// 歌名。
    #[serde(default)]
    pub name: String,
    /// 歌手(多个用 `/` 连接, 与搜索结果一致)。
    #[serde(default)]
    pub singers: String,
    /// 专辑名。
    #[serde(default)]
    pub album: String,
    /// 请求音质(网易档位名; QQ 取链阶梯自有档位)。
    #[serde(default)]
    pub quality: String,
    /// 目标文件名 `"{singers} - {name}.{ext}"`(取链拿到真实扩展名后更新)。
    #[serde(default)]
    pub out_name: String,
    /// [`STATUS_QUEUED`] / [`STATUS_DOWNLOADING`] / [`STATUS_COPYING`] /
    /// [`STATUS_DONE`] / [`STATUS_FAILED`]。
    #[serde(default)]
    pub status: String,
    /// 宿主下载任务引用(下载阶段)。
    #[serde(default)]
    pub job_ref: String,
    /// 已开始的尝试次数(含复制重试), 上限 [`MAX_ATTEMPTS`]。
    #[serde(default)]
    pub attempts: u32,
    /// 重试轮次: 每次用户重试(Telegram 回调 / action `task-retry`)自增。
    ///
    /// [`retry`] 会把 `attempts` 归零, 所以 `attempts` 不能唯一标识"第几轮失败";
    /// 失败通知的 `dedupe_key` / 幂等键用 `retry_round` 区分不同轮次, 避免第二次
    /// 失败通知与上一轮逐字节相同而被宿主去重吞掉。
    #[serde(default)]
    pub retry_round: u32,
    /// 最近一次失败原因。
    #[serde(default)]
    pub error: String,
    /// 入队时间(Unix 毫秒)。
    #[serde(default)]
    pub created_ms: u64,
    /// 最近更新时间(Unix 毫秒)。
    #[serde(default)]
    pub updated_ms: u64,
}

impl Task {
    /// 是否占用下载并发槽(下载中 / 待复制)。
    pub fn is_slot(&self) -> bool {
        matches!(self.status.as_str(), STATUS_DOWNLOADING | STATUS_COPYING)
    }

    /// 是否已终态。
    pub fn is_finished(&self) -> bool {
        matches!(self.status.as_str(), STATUS_DONE | STATUS_FAILED)
    }

    /// 展示名(标题/按钮文案用): `"歌手 - 歌名"`, 歌手缺失时只用歌名。
    pub fn display_name(&self) -> String {
        if self.singers.is_empty() {
            self.name.clone()
        } else {
            format!("{} - {}", self.singers, self.name)
        }
    }
}

/// 新任务入参(action `download` 的补充字段)。
#[derive(Debug, Clone, Default)]
pub struct NewTask {
    pub source: String,
    pub song_id: String,
    pub name: String,
    pub singers: String,
    pub album: String,
    pub quality: String,
}

/// 入队结果。
#[derive(Debug, Clone)]
pub struct EnqueueOutcome {
    pub task: Task,
    /// true = 命中同 `source+song_id+quality` 的进行中任务, 未新建。
    pub deduped: bool,
}

/// 当前 Unix 毫秒。
pub fn now_ms() -> u64 {
    clock::now_unix_nanos() / 1_000_000
}

/// 从 KV `tasks` 读队列; 值非法时返回 `Err`(调用方决定是否继续, 避免静默丢队列)。
pub fn load_result() -> Result<Vec<Task>, String> {
    let (raw, ok) = store::get(TASKS_KEY);
    if !ok || raw.is_empty() {
        return Ok(Vec::new());
    }
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Document {
        List(Vec<Task>),
        Wrapped { tasks: Vec<Task> },
    }
    match serde_json::from_slice::<Document>(&raw) {
        Ok(Document::List(tasks)) | Ok(Document::Wrapped { tasks }) => Ok(tasks),
        Err(err) => Err(format!("任务队列解析失败: {err}")),
    }
}

/// 宽松读取(解析失败按空队列, 供 state 展示用)。
pub fn load() -> Vec<Task> {
    load_result().unwrap_or_default()
}

/// 覆盖写入队列(KV `tasks`, ETag 乐观锁 + 幂等键)。
pub fn save(ids: &mut PutIds, tasks: &[Task]) -> Result<(), String> {
    store::put_json(ids, TASKS_KEY, &tasks).map_err(|err| err.to_string())
}

// ─────────────────────────── 命名 ───────────────────────────

/// 组件清洗: `\/:*?"<>|` → `_`, 再 trim(对齐 `server.mjs` 的 `safe()` 实现)。
pub fn sanitize_component(text: &str) -> String {
    text.chars()
        .map(|ch| if ILLEGAL_NAME_CHARS.contains(&ch) { '_' } else { ch })
        .collect::<String>()
        .trim()
        .to_string()
}

/// 目标文件名 `"{singers} - {name}.{ext}"`(sidecar `outPathFor` 的简化形态:
/// 需求只要求这一条命名规则, 不含 QQ 的 `[quality]` 后缀)。
///
/// - 歌手清洗后为空 → `未知`(对齐 sidecar 的 `safe(t.singers) || '未知'`);
/// - 歌名清洗后为空 → `未知`(防御性, 避免产出 `"歌手 - .flac"`);
/// - 扩展名缺失 → `flac`(与取链失败时的兜底一致)。
pub fn out_name(singers: &str, name: &str, ext: &str) -> String {
    let singers = sanitize_component(singers);
    let name = sanitize_component(name);
    let singers = if singers.is_empty() { "未知".to_string() } else { singers };
    let name = if name.is_empty() { "未知".to_string() } else { name };
    let ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    let ext = if ext.is_empty() { "flac".to_string() } else { ext };
    format!("{singers} - {name}.{ext}")
}

// ─────────────────────────── 短 id ───────────────────────────

/// FNV-1a 64 位(无依赖的稳定散列)。
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Go `strconv.FormatInt(v, 36)` 的小写 base36。
fn base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut buf = Vec::with_capacity(13);
    while value > 0 {
        buf.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    buf.reverse();
    String::from_utf8(buf).unwrap_or_else(|_| "0".to_string())
}

/// 由种子得到 ≤8 字符的 base36 短 id。
pub fn short_id(seed: &str) -> String {
    base36(fnv1a64(seed.as_bytes()) % ID_SPACE)
}

/// 分配一个队列内唯一的短 id: 同种子碰撞时追加 `#n` 重散列。
pub fn allocate_id(existing: &[Task], seed: &str) -> String {
    for attempt in 0..64u32 {
        let probe = if attempt == 0 { seed.to_string() } else { format!("{seed}#{attempt}") };
        let id = short_id(&probe);
        if !existing.iter().any(|task| task.id == id) {
            return id;
        }
    }
    // 极端碰撞(几乎不可能): 用时间再加一层扰动。
    short_id(&format!("{seed}#{}", clock::now_unix_nanos()))
}

// ─────────────────────────── 入队 / 重试 / 清理 ───────────────────────────

/// 入队(去重: 同 `source+song_id+quality` 的 queued/downloading/copying 任务直接复用)。
pub fn enqueue(ids: &mut PutIds, request: &NewTask) -> Result<EnqueueOutcome, String> {
    if request.source.trim().is_empty() {
        return Err("缺少音乐来源".to_string());
    }
    if request.song_id.trim().is_empty() {
        return Err("缺少歌曲标识".to_string());
    }
    if request.quality.trim().is_empty() {
        return Err("缺少音质".to_string());
    }
    let mut tasks = load_result()?;

    if let Some(existing) = tasks.iter().find(|task| {
        task.source == request.source
            && task.song_id == request.song_id
            && task.quality == request.quality
            && !task.is_finished()
    }) {
        return Ok(EnqueueOutcome { task: existing.clone(), deduped: true });
    }

    let millis = now_ms();
    let seed = format!("{}|{}|{}|{}", request.source, request.song_id, request.quality, millis);
    let id = allocate_id(&tasks, &seed);
    let task = Task {
        id,
        source: request.source.clone(),
        song_id: request.song_id.clone(),
        name: request.name.clone(),
        singers: request.singers.clone(),
        album: request.album.clone(),
        quality: request.quality.clone(),
        // 真实扩展名要等取链才知道; 这里先按 flac 兜底, pump 取链后会用真实扩展名更新。
        out_name: out_name(&request.singers, &request.name, "flac"),
        status: STATUS_QUEUED.to_string(),
        created_ms: millis,
        updated_ms: millis,
        ..Task::default()
    };
    tasks.push(task.clone());
    save(ids, &tasks)?;
    Ok(EnqueueOutcome { task, deduped: false })
}

/// 失败任务重新排队(Telegram `retry:<id>` 与 action `task-retry` 共用)。
///
/// 重置 `attempts`, 让重试拥有完整的 [`MAX_ATTEMPTS`] 次机会。
pub fn retry(ids: &mut PutIds, task_id: &str) -> Result<Value, String> {
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return Err("缺少任务 id".to_string());
    }
    let mut tasks = load_result()?;
    let index = match tasks.iter().position(|task| task.id == task_id) {
        Some(index) => index,
        None => return Err(format!("任务不存在: {task_id}")),
    };
    if tasks[index].status != STATUS_FAILED {
        let status = tasks[index].status.clone();
        return Ok(json!({
            "task_id": task_id,
            "status": status,
            "message": "任务不在失败态, 无需重试",
        }));
    }
    let task = &mut tasks[index];
    task.status = STATUS_QUEUED.to_string();
    task.attempts = 0;
    task.retry_round = task.retry_round.saturating_add(1);
    task.error.clear();
    task.job_ref.clear();
    task.updated_ms = now_ms();
    let status = task.status.clone();
    save(ids, &tasks)?;
    Ok(json!({"task_id": task_id, "status": status, "message": "已重新排队"}))
}

/// 清掉已终态(done/failed)的任务, 返回清理条数。
pub fn clear_finished(ids: &mut PutIds) -> Result<usize, String> {
    let mut tasks = load_result()?;
    let before = tasks.len();
    tasks.retain(|task| !task.is_finished());
    let removed = before - tasks.len();
    if removed > 0 {
        save(ids, &tasks)?;
    }
    Ok(removed)
}

// ─────────────────────────── 展示 / 回调 / pump ───────────────────────────

/// `state` 响应里的任务列表: 按创建时间倒序, 最近 [`STATE_TASKS_LIMIT`] 条。
pub fn state_view() -> Vec<Value> {
    let mut tasks = load();
    tasks.sort_by(|left, right| {
        right.created_ms.cmp(&left.created_ms).then_with(|| right.id.cmp(&left.id))
    });
    tasks.truncate(STATE_TASKS_LIMIT);
    tasks.into_iter().map(|task| serde_json::to_value(task).unwrap_or(Value::Null)).collect()
}

/// 从 `telegram.callback` 的 data 里提取按钮回调值。
///
/// 宿主投递形态(new-hostcall §12): `{"callback":{"data":"retry:<id>"}, "message":{...}}`;
/// 兼容 `callback_query.data` / 顶层 `data` / `callback_data` 几种写法。
pub fn extract_callback_data(data: &Value) -> Option<String> {
    let candidates = [
        data.get("callback").and_then(|value| value.get("data")),
        data.get("callback_query").and_then(|value| value.get("data")),
        data.get("data"),
        data.get("callback_data"),
    ];
    candidates
        .into_iter()
        .flatten()
        .find_map(Value::as_str)
        .map(str::to_string)
}

/// Telegram 回调事件入口(`event` op, topic = `telegram.callback`)。
///
/// - `retry:<id>` → 失败任务重新排队, 返回 `{handled, answer, alert}`;
/// - 其他前缀 → `{handled:false}`(不是本插件的按钮);
/// - 缺少回调值 / 存储不可读 → `Err`, 由 runtime 映射成 `accepted:false` 让宿主重投。
pub fn on_telegram_callback(ids: &mut PutIds, data: &Value) -> Result<Value, String> {
    let raw = extract_callback_data(data)
        .ok_or_else(|| "telegram.callback 缺少 callback.data".to_string())?;
    let Some(task_id) = raw.strip_prefix(RETRY_PREFIX) else {
        return Ok(json!({"handled": false}));
    };
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return Err("重试回调缺少任务 id".to_string());
    }
    let mut tasks = load_result()?;
    let Some(index) = tasks.iter().position(|task| task.id == task_id) else {
        // 任务被清理或不是本实例的任务: 静默确认, 避免宿主无限重投。
        return Ok(json!({"handled": true, "answer": "任务不存在或已被清理", "alert": false}));
    };
    if tasks[index].status != STATUS_FAILED {
        let status = tasks[index].status.clone();
        return Ok(json!({
            "handled": true,
            "answer": format!("任务状态为 {status}, 无需重试"),
            "alert": false,
        }));
    }
    let task = &mut tasks[index];
    task.status = STATUS_QUEUED.to_string();
    task.attempts = 0;
    task.retry_round = task.retry_round.saturating_add(1);
    task.error.clear();
    task.job_ref.clear();
    task.updated_ms = now_ms();
    let name = task.display_name();
    save(ids, &tasks)?;
    Ok(json!({
        "handled": true,
        "answer": format!("已重新排队: {name}"),
        "alert": false,
        "task_id": task_id,
    }))
}

/// 推进 KV 任务队列(定时 job `queue-pump` / action `queue-pump` 的落地函数)。
pub fn queue_pump(ids: &mut PutIds) -> Result<Value, String> {
    download::pump(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::{HostCallRequest, HostCallResponse, HostError};
    use base64::Engine as _;
    use std::cell::RefCell;
    use std::collections::{BTreeMap, HashMap};

    thread_local! {
        /// 测试用 KV: 键 → (原始值, revision)。
        static FAKE_KV: RefCell<HashMap<String, (Vec<u8>, u64)>> = RefCell::new(HashMap::new());
    }

    /// 装一个只处理 `/api/plugin-runtime/storage/:key` 的宿主替身。
    fn install_fake_kv_host() {
        FAKE_KV.with(|kv| kv.borrow_mut().clear());
        crate::host::testhost::install(Box::new(|request: &HostCallRequest| {
            let key = request
                .path
                .strip_prefix("/api/plugin-runtime/storage/")
                .unwrap_or("")
                .to_string();
            match request.method.as_str() {
                "GET" => {
                    let found = FAKE_KV.with(|kv| kv.borrow().get(&key).cloned());
                    match found {
                        Some((value, revision)) => Ok(HostCallResponse {
                            status: 200,
                            headers: etag_headers(revision),
                            body_base64: base64::engine::general_purpose::STANDARD_NO_PAD
                                .encode(&value),
                        }),
                        None => Ok(HostCallResponse {
                            status: 404,
                            ..HostCallResponse::default()
                        }),
                    }
                }
                "PUT" => {
                    // 幂等键约束: 16~128 个可打印 ASCII。
                    let idem = request.headers.get("idempotency-key").cloned().unwrap_or_default();
                    if !(16..=128).contains(&idem.len())
                        || !idem.bytes().all(|byte| byte.is_ascii_graphic())
                    {
                        return Ok(HostCallResponse {
                            status: 400,
                            body_base64: base64::engine::general_purpose::STANDARD_NO_PAD
                                .encode(br#"{"error":"bad idempotency key"}"#),
                            ..HostCallResponse::default()
                        });
                    }
                    let raw = base64::engine::general_purpose::STANDARD_NO_PAD
                        .decode(&request.body_base64)
                        .unwrap_or_default();
                    let parsed: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
                    let value = serde_json::to_vec(&parsed["value"]).unwrap_or_default();
                    let current = FAKE_KV.with(|kv| kv.borrow().get(&key).cloned());
                    if let Some(if_match) = request.headers.get("if-match") {
                        let matches = match &current {
                            Some((_, revision)) => if_match == &format!("\"pkv_{revision}\""),
                            None => false,
                        };
                        if !matches {
                            return Ok(HostCallResponse {
                                status: 412,
                                ..HostCallResponse::default()
                            });
                        }
                    }
                    let revision = current.map(|(_, revision)| revision).unwrap_or(0) + 1;
                    FAKE_KV.with(|kv| kv.borrow_mut().insert(key.clone(), (value, revision)));
                    Ok(HostCallResponse {
                        status: 200,
                        headers: etag_headers(revision),
                        ..HostCallResponse::default()
                    })
                }
                other => Err(HostError::new(format!("unexpected method: {other}"))),
            }
        }));
    }

    fn etag_headers(revision: u64) -> BTreeMap<String, Vec<String>> {
        let mut headers = BTreeMap::new();
        headers.insert("ETag".to_string(), vec![format!("\"pkv_{revision}\"")]);
        headers
    }

    fn request(source: &str, song_id: &str, quality: &str) -> NewTask {
        NewTask {
            source: source.to_string(),
            song_id: song_id.to_string(),
            name: "歌/名".to_string(),
            singers: "歌手A".to_string(),
            album: "专辑".to_string(),
            quality: quality.to_string(),
        }
    }

    #[test]
    fn out_name_follows_sidecar_rules() {
        assert_eq!(out_name("周杰伦", "晴天", "flac"), "周杰伦 - 晴天.flac");
        assert_eq!(out_name("A/B:C*?\"<>|D", "E\\F", "FLAC"), "A_B_C______D - E_F.flac");
        assert_eq!(out_name("", "晴天", ""), "未知 - 晴天.flac");
        assert_eq!(out_name("  周杰伦  ", "  晴天  ", ".mp3"), "周杰伦 - 晴天.mp3");
        assert_eq!(out_name("周杰伦", "", "flac"), "周杰伦 - 未知.flac");
    }

    #[test]
    fn short_ids_are_short_safe_and_unique() {
        let tasks = vec![
            Task { id: short_id("seed"), ..Task::default() },
            Task { id: short_id("seed#1"), ..Task::default() },
        ];
        let id = allocate_id(&tasks, "seed");
        assert!(id.len() <= MAX_TASK_ID_LEN, "id 超长: {id}");
        assert!(id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'z').contains(&byte)));
        assert_ne!(id, tasks[0].id, "必须绕开已有 id");
        assert_ne!(id, tasks[1].id, "必须绕开已有 id");
        assert!(format!("retry:{id}").len() <= 32, "callback_data 限 32 字节");
    }

    #[test]
    fn enqueue_dedupes_active_and_allows_new_after_finish() {
        install_fake_kv_host();
        let mut ids = PutIds::new();
        let first = enqueue(&mut ids, &request("netease", "123", "lossless")).unwrap();
        assert!(!first.deduped);
        let again = enqueue(&mut ids, &request("netease", "123", "lossless")).unwrap();
        assert!(again.deduped, "进行中任务必须去重");
        assert_eq!(again.task.id, first.task.id);

        // 结束后(即使失败)再次入队应新建: 失败任务靠 retry 回队, 不靠重复入队。
        let mut tasks = load();
        tasks[0].status = STATUS_FAILED.to_string();
        save(&mut ids, &tasks).unwrap();
        let third = enqueue(&mut ids, &request("netease", "123", "lossless")).unwrap();
        assert!(!third.deduped);
        assert_ne!(third.task.id, first.task.id);
        assert_eq!(load().len(), 2);
    }

    #[test]
    fn retry_resets_failed_task_only() {
        install_fake_kv_host();
        let mut ids = PutIds::new();
        let outcome = enqueue(&mut ids, &request("qq", "mid-1", "flac")).unwrap();
        let id = outcome.task.id.clone();

        // 非失败态: 不改状态。
        let value = retry(&mut ids, &id).unwrap();
        assert_eq!(value["status"], STATUS_QUEUED);
        assert_eq!(value["message"], "任务不在失败态, 无需重试");

        let mut tasks = load();
        tasks[0].status = STATUS_FAILED.to_string();
        tasks[0].attempts = MAX_ATTEMPTS;
        tasks[0].error = "boom".to_string();
        save(&mut ids, &tasks).unwrap();

        let value = retry(&mut ids, &id).unwrap();
        assert_eq!(value["message"], "已重新排队");
        let tasks = load();
        assert_eq!(tasks[0].status, STATUS_QUEUED);
        assert_eq!(tasks[0].attempts, 0);
        assert_eq!(tasks[0].error, "");
        assert!(retry(&mut ids, "nope").is_err());
    }

    #[test]
    fn telegram_callback_requeues_failed_task() {
        install_fake_kv_host();
        let mut ids = PutIds::new();
        let outcome = enqueue(&mut ids, &request("netease", "9", "jymaster")).unwrap();
        let id = outcome.task.id.clone();
        let mut tasks = load();
        tasks[0].status = STATUS_FAILED.to_string();
        tasks[0].attempts = MAX_ATTEMPTS;
        save(&mut ids, &tasks).unwrap();

        // §12 的宿主投递形状。
        let payload = json!({
            "callback": {"data": format!("retry:{id}")},
            "message": {"message_id": 123, "chat_id": 456, "chat_type": "private", "user_id": 789, "date": 1759000000}
        });
        let value = on_telegram_callback(&mut ids, &payload).unwrap();
        assert_eq!(value["handled"], true);
        assert_eq!(value["alert"], false);
        assert_eq!(value["task_id"], id);
        let tasks = load();
        assert_eq!(tasks[0].status, STATUS_QUEUED);
        assert_eq!(tasks[0].attempts, 0);

        // 成功态任务不再重试。
        let mut tasks = load();
        tasks[0].status = STATUS_DONE.to_string();
        save(&mut ids, &tasks).unwrap();
        let value = on_telegram_callback(&mut ids, &payload).unwrap();
        assert_eq!(value["handled"], true);
        assert!(value["answer"].as_str().unwrap().contains("无需重试"));

        // 不认识的按钮: 不是本插件处理。
        let value = on_telegram_callback(&mut ids, &json!({"callback": {"data": "other:x"}})).unwrap();
        assert_eq!(value["handled"], false);

        // 缺 data: 失败(宿主可重投)。
        assert!(on_telegram_callback(&mut ids, &json!({"message": {}})).is_err());
        // 未知任务 id: 静默确认, 不触发无限重投。
        let value = on_telegram_callback(&mut ids, &json!({"callback": {"data": "retry:zzzz"}})).unwrap();
        assert_eq!(value["handled"], true);
        assert!(value["answer"].as_str().unwrap().contains("任务不存在"));
    }

    #[test]
    fn state_view_is_newest_first_and_capped() {
        install_fake_kv_host();
        let mut ids = PutIds::new();
        let mut tasks: Vec<Task> = (0..STATE_TASKS_LIMIT + 1)
            .map(|index| Task {
                id: short_id(&format!("t{index}")),
                status: STATUS_QUEUED.to_string(),
                created_ms: index as u64,
                ..Task::default()
            })
            .collect();
        save(&mut ids, &tasks).unwrap();
        let view = state_view();
        assert_eq!(view.len(), STATE_TASKS_LIMIT);
        assert_eq!(view[0]["created_ms"], STATE_TASKS_LIMIT as u64);
        // 队列本身不被 state_view 改写。
        tasks.sort_by(|left, right| left.created_ms.cmp(&right.created_ms));
        assert_eq!(load().len(), STATE_TASKS_LIMIT + 1);
    }

    #[test]
    fn failed_document_surfaces_error() {
        install_fake_kv_host();
        let mut ids = PutIds::new();
        // 直接塞一个非法值。
        store::put(&mut ids, TASKS_KEY, b"not json").unwrap();
        assert!(load_result().is_err());
        assert!(load().is_empty());
    }
}
