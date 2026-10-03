//! 任务队列(**KV 分片**: `tasks.idx` + `task.<id>`)与 Telegram 回调 —— 下载状态机的持久层。
//!
//! # 为什么分片(0.3.12)
//!
//! 旧实现把整条队列放在单个 KV 键 `tasks` 里, [`crate::download::pump`] 一次把
//! **全部**任务(真机上 40+ 条)读进 `Vec<Task>` 落盘。manifest 限 `memory_mb=128`
//! 且不得放宽, 真机表现为 wasm 被 SIGKILL(收尾未执行), 因此改成「单曲加载-处理-释放」:
//!
//! - `tasks.idx`: 紧凑数组 `[{id,status,source,song_id,name,singers,quality,error,updated_ms}]`,
//!   **UI state 的唯一数据源**(只截最近 [`STATE_TASKS_LIMIT`] 条)。一条约 180~290 字节,
//!   200 条上限 → 几十 KB, 与整条队列的完整记录(每条含 `job_ref`/`staged_path` 等)
//! 差两个数量级。0.3.14 起额外带 `source`/`song_id`(入队去重所需的最小字段), 因此
//! 单条比 0.3.12 略大, 但仍是常数上界, 见 `download::tests::audit_measured_index_and_record_sizes`。
//! - `task.<id>`: 完整 [`Task`] 记录, **只在推进那一条时**读进来, 处理完立刻 drop。
//!
//! pump 的一次调用因此只同时持有: `idx` + 在途任务条数(稳态 `<= settings.max_active`;
//! 轮询阶段按索引里 `downloading`/`copying` 的条目逐条处理, **不按 `max_active` 截断**)
//! + 一首歌的取链工作集, **与总队列长度无关**。
//!
//! # 迁移
//!
//! [`ensure_migrated`](self) 在 pump 开头检查: 旧键 `tasks` 还在 → 逐条写入
//! `task.<id>`, 建 `tasks.idx`, 再删掉旧键。解析失败时**保留旧键**并返回 `Err`
//! (宁可停住也不静默丢队列)。
//!
//! # 不变的部分
//!
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
use crate::util;

/// 旧版单键队列(KV `tasks`)。0.3.12 起只用于**迁移探测**: 内容被拆进
/// [`TASKS_IDX_KEY`] + [`TASK_KEY_PREFIX`], 迁移成功后删掉。
pub const TASKS_KEY: &str = "tasks";

/// 队列索引键(KV `tasks.idx`): 紧凑数组, UI state 的唯一数据源。
pub const TASKS_IDX_KEY: &str = "tasks.idx";

/// 单条完整任务记录的键前缀(KV `task.<id>`)。
///
/// **分隔符是 `.` 不是 `:`**: 宿主 storage 键有正则约束
/// `^[A-Za-z0-9](?:[A-Za-z0-9]|[._-](?=[A-Za-z0-9]))*$`(见
/// `docs-ref/openapi64.yaml:2216`), 只允许 `[A-Za-z0-9._-]`, `:` 会被 400 拒。
/// `.` 后面必须紧跟字母数字, 而短 id(base36)恒满足。
pub const TASK_KEY_PREFIX: &str = "task.";

/// 索引里 `error` 字段的字节上限(120B): 错误文本可能整段是宿主 HTTP 响应体,
/// 索引必须比完整记录小一个数量级, 否则省内存的意义就没了。
pub const IDX_ERROR_LIMIT: usize = 120;

/// 一条任务的完整记录所在的 KV 键。
pub fn task_key(task_id: &str) -> String {
    format!("{TASK_KEY_PREFIX}{task_id}")
}

/// 键名是否满足宿主的 storage 键正则(测试里对真实键名逐个校验)。
///
/// 宿主约束(openapi64.yaml `storage/{key}` 的 `key` 参数):
/// `^[A-Za-z0-9](?:[A-Za-z0-9]|[._-](?=[A-Za-z0-9]))*$`, 长度 1~160。
/// 注意**分隔符后必须紧跟字母数字**(`[._-]` 是"前瞻"用法, 不是可结尾的字符)。
pub fn key_is_host_safe(key: &str) -> bool {
    if key.is_empty() || key.len() > 160 {
        return false;
    }
    let bytes = key.as_bytes();
    if !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate().skip(1) {
        if byte.is_ascii_alphanumeric() {
            continue;
        }
        // 分隔符: 必须是 [._-] 且下一个字符是字母数字。
        if !matches!(byte, b'.' | b'_' | b'-') {
            return false;
        }
        match bytes.get(index + 1) {
            Some(next) if next.is_ascii_alphanumeric() => {}
            _ => return false,
        }
    }
    true
}

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
    /// 0.3.8: 下载 job 上报的暂存文件绝对路径(rename/copy 的锚点)。
    #[serde(default)]
    pub staged_path: String,
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

/// 任务索引里的一条(`tasks.idx` 的元素, 也是 UI state 里的一条)。
///
/// 只带渲染任务列表所需的字段; `job_ref` / `staged_path` / `attempts` /
/// `retry_round` / `out_name` 等**不落索引** —— 它们只在推进那一条时才需要,
/// 从 `task.<id>` 读完整 [`Task`]。这是「与队列长度无关的峰值内存」的关键。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskIndexEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub status: String,
    /// 0.3.14: 入队去重所需的最小字段(不再逐条读完整记录)。
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub song_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub singers: String,
    #[serde(default)]
    pub quality: String,
    /// 失败/阻塞原因, 截断到 [`IDX_ERROR_LIMIT`] 字节。
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub updated_ms: u64,
}

impl TaskIndexEntry {
    /// 从完整任务投影出索引条目(`error` 按字节截断到 [`IDX_ERROR_LIMIT`]。
    pub fn of(task: &Task) -> TaskIndexEntry {
        TaskIndexEntry {
            id: task.id.clone(),
            source: task.source.clone(),
            song_id: task.song_id.clone(),
            status: task.status.clone(),
            name: task.name.clone(),
            singers: task.singers.clone(),
            quality: task.quality.clone(),
            error: util::trunc_to(task.error.as_bytes(), IDX_ERROR_LIMIT),
            updated_ms: task.updated_ms,
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

/// 读取旧版单键队列(KV `tasks`); 值非法时返回 `Err`(调用方决定是否继续, 避免静默丢队列)。
///
/// 只在 [`ensure_migrated`] 里用。
pub fn load_legacy_result() -> Result<Vec<Task>, String> {
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

/// 读一条任务的完整记录(KV `task.<id>`); 不存在返回 `None`。
pub fn load_task(task_id: &str) -> Option<Task> {
    store::get_json::<Task>(&task_key(task_id))
}

/// 写一条任务的完整记录(KV `task.<id>`)。
pub fn save_task(ids: &mut PutIds, task: &Task) -> Result<(), String> {
    store::put_json(ids, &task_key(&task.id), task).map_err(|err| err.to_string())
}

/// 删一条任务的完整记录(KV `task.<id>`)。
pub fn delete_task(ids: &mut PutIds, task_id: &str) -> Result<(), String> {
    store::delete(ids, &task_key(task_id)).map_err(|err| err.to_string())
}

/// 读任务索引(KV `tasks.idx`)。键不存在 → 空索引。
pub fn load_index() -> Vec<TaskIndexEntry> {
    store::get_json::<Vec<TaskIndexEntry>>(TASKS_IDX_KEY).unwrap_or_default()
}

/// 写任务索引(KV `tasks.idx`)。
pub fn save_index(ids: &mut PutIds, index: &[TaskIndexEntry]) -> Result<(), String> {
    store::put_json(ids, TASKS_IDX_KEY, &index).map_err(|err| err.to_string())
}

/// 索引按 `updated_ms` 倒序(同值按 id 倒序, 保证顺序稳定)。
///
/// 就地排序, **不截断**: pump 写回前调用, 保证索引始终是有序的。
pub fn sort_index(index: &mut [TaskIndexEntry]) {
    index.sort_by(|left, right| {
        right.updated_ms.cmp(&left.updated_ms).then_with(|| right.id.cmp(&left.id))
    });
}

/// 从旧单键 `tasks` 迁移到分片键; 返回迁移条数(已是分片形态则 0)。
///
/// - 旧键不存在/为空 → 0, 无副作用;
/// - 旧键解析失败 → `Err`, **不动任何键**(宁可停住也不静默丢队列);
/// - 成功 → 写 `task.<id>` 全部 + 建 `tasks.idx`, 最后删旧键。
///
/// 顺序重要: 先把分片全部写好, 再删旧键。删失败只会导致下次 pump 再迁移一次
/// (幂等: 写同一份数据, 结果相同), 反过来先删后写则可能整队丢失。
pub fn ensure_migrated(ids: &mut PutIds) -> Result<usize, String> {
    let (raw, ok) = store::get(TASKS_KEY);
    if !ok || raw.is_empty() {
        return Ok(0);
    }
    let tasks = {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Document {
            List(Vec<Task>),
            Wrapped { tasks: Vec<Task> },
        }
        match serde_json::from_slice::<Document>(&raw) {
            Ok(Document::List(tasks)) | Ok(Document::Wrapped { tasks }) => tasks,
            Err(err) => return Err(format!("任务队列解析失败: {err}")),
        }
    };
    let count = tasks.len();
    let mut index: Vec<TaskIndexEntry> = Vec::with_capacity(count);
    for task in &tasks {
        save_task(ids, task)?;
        index.push(TaskIndexEntry::of(task));
    }
    sort_index(&mut index);
    save_index(ids, &index)?;
    store::delete(ids, TASKS_KEY).map_err(|err| err.to_string())?;
    Ok(count)
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
///
/// `existing` 是**已占用的 id 集合**(分片后就是索引里全部 id, 不需要完整记录)。
pub fn allocate_id<I: AsRef<str>>(existing: &[I], seed: &str) -> String {
    for attempt in 0..64u32 {
        let probe = if attempt == 0 { seed.to_string() } else { format!("{seed}#{attempt}") };
        let id = short_id(&probe);
        if !existing.iter().any(|taken| taken.as_ref() == id) {
            return id;
        }
    }
    // 极端碰撞(几乎不可能): 用时间再加一层扰动。
    short_id(&format!("{seed}#{}", clock::now_unix_nanos()))
}

// ─────────────────────────── 入队 / 重试 / 清理 ───────────────────────────

/// 入队(去重: 同 `source+song_id+quality` 的 queued/downloading/copying 任务直接复用)。
///
/// # 0.3.14: 去重走索引, 存储调用数与队列长度无关
///
/// 索引条目自带 `source`/`song_id`/`quality`(见 [`TaskIndexEntry`]), 因此去重只需
/// **读一次 `tasks.idx`** 在内存里筛 `queued`/`downloading`/`copying` 的条目, **不再逐条
/// 读 `task.<id>`**。常规路径的 storage 调用固定为:
/// 迁移快查 1 次(GET `tasks`) + 读索引 1 次(GET `tasks.idx`) + 写分片 1 次(PUT)
/// + 写索引 1 次(PUT); 命中复用时不写, 只多读命中那**一条**完整记录返回给调用方。
/// 因此批量入队(如 `playlist-queue-all`)的总读次数与**已排队条数无关**,
/// 只随**本次处理的歌曲数**线性增长。对比 0.3.12 的 O(在途 + 排队) 次读。
///
/// # 一次性自愈(老索引)
///
/// 0.3.14 之前写下的索引条目没有 `source`(迁移产物与旧版都会如此)。若发现**进行中**的
/// 条目缺 `source`, 只读**缺字段的那些** `task.<id>` 补齐索引并写回一次(`healed`); 之后
/// 该索引不再缺字段, 自愈不会再次发生。缺 `source` 的终态条目不会被读(去重不关心它们),
/// 会保持缺字段直到被清理 —— 这是有意的: 自愈只服务去重, 代价只在首次。
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
    ensure_migrated(ids)?;

    // ① 读一次索引(唯一的一次数组读)。
    let index = load_index();

    // ② 0.3.14: 直接用索引去重(索引带 source/song_id/quality), 不再逐条读完整记录 ——
    //    批量入队从 O(队列) 次读降为常数次。老索引条目缺 source 时自愈一次:
    //    只读缺字段的那些记录, 顺手把索引条目补齐。
    let mut index = index;
    let mut healed = false;
    let mut stale_ids: Vec<String> = Vec::new();
    for entry in index.iter_mut() {
        if entry.source.is_empty()
            && matches!(entry.status.as_str(), STATUS_QUEUED | STATUS_DOWNLOADING | STATUS_COPYING)
        {
            stale_ids.push(entry.id.clone());
        }
    }
    for entry_id in &stale_ids {
        if let Some(task) = load_task(entry_id) {
            for entry in index.iter_mut() {
                if entry.id == *entry_id {
                    entry.source = task.source.clone();
                    entry.song_id = task.song_id.clone();
                    // 分片里确实有 source 才算补齐(否则写回也不会改变索引,
                    // 无谓地反复触发自愈写)。
                    if !task.source.is_empty() {
                        healed = true;
                    }
                }
            }
        }
    }
    if healed {
        sort_index(&mut index);
        save_index(ids, &index)?;
    }
    if let Some(hit) = index.iter().find(|entry| {
        matches!(entry.status.as_str(), STATUS_QUEUED | STATUS_DOWNLOADING | STATUS_COPYING)
            && entry.source == request.source
            && entry.song_id == request.song_id
            && entry.quality == request.quality
    }) {
        let task_id = hit.id.clone();
        let Some(task) = load_task(&task_id) else {
            return Err(format!("去重命中但分片缺失: {task_id}"));
        };
        return Ok(EnqueueOutcome { task, deduped: true });
    }

    // ③ 新建: id 必须避开**全队列**已有的 id(不只是进行中的), 暂存文件名靠它唯一。
    //    索引里就有全队列的 id 集合, 因此不需要再读完整记录。
    let millis = now_ms();
    let seed = format!("{}|{}|{}|{}", request.source, request.song_id, request.quality, millis);
    let taken: Vec<&str> = index.iter().map(|entry| entry.id.as_str()).collect();
    let id = allocate_id(&taken, &seed);
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
    save_task(ids, &task)?;
    index.push(TaskIndexEntry::of(&task));
    sort_index(&mut index);
    save_index(ids, &index)?;
    Ok(EnqueueOutcome { task, deduped: false })
}

/// 把一条任务重置为排队态(重试的公共逻辑)。
///
/// `attempts` 归零, 让重试拥有完整的 [`MAX_ATTEMPTS`] 次机会; `retry_round` 自增,
/// 使不同轮次的失败通知幂等键互不相同(见 [`crate::download::notify_failure`])。
/// 返回是否真的重置了(非失败态 → `false`, 调用方给"无需重试"的回应)。
fn requeue(task: &mut Task) -> bool {
    if task.status != STATUS_FAILED {
        return false;
    }
    task.status = STATUS_QUEUED.to_string();
    task.attempts = 0;
    task.retry_round = task.retry_round.saturating_add(1);
    task.error.clear();
    task.job_ref.clear();
    task.updated_ms = now_ms();
    true
}

/// 就地把 `task` 的最新状态写回 `task.<id>` 与 `tasks.idx`。
///
/// pump 与 retry 共用: 索引里对应 id 的条目**就地替换**(保持它在索引里的位置),
/// 找不到才追加(随后整体排序)。
pub fn persist_task(ids: &mut PutIds, task: &Task) -> Result<(), String> {
    save_task(ids, task)?;
    let entry = TaskIndexEntry::of(task);
    let mut index = load_index();
    match index.iter_mut().find(|slot| slot.id == task.id) {
        Some(slot) => *slot = entry,
        None => {
            index.push(entry);
            sort_index(&mut index);
        }
    }
    save_index(ids, &index)
}

/// 失败任务重新排队(Telegram `retry:<id>` 与 action `task-retry` 共用)。
///
/// 只读 `task.<id>` 一条完整记录(分片后不再整队加载)。
pub fn retry(ids: &mut PutIds, task_id: &str) -> Result<Value, String> {
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return Err("缺少任务 id".to_string());
    }
    ensure_migrated(ids)?;
    let Some(mut task) = load_task(task_id) else {
        return Err(format!("任务不存在: {task_id}"));
    };
    if !requeue(&mut task) {
        return Ok(json!({
            "task_id": task_id,
            "status": task.status,
            "message": "任务不在失败态, 无需重试",
        }));
    }
    let status = task.status.clone();
    persist_task(ids, &task)?;
    Ok(json!({"task_id": task_id, "status": status, "message": "已重新排队"}))
}

/// 清掉已终态(done/failed)的任务, 返回清理条数。
///
/// 遍历**索引**(一个键)决定删谁, 再逐条删 `task.<id>`, 最后重建索引。
/// 单条删除失败只记账不中断: 该条目**保留在索引里**(下次 clear 再试), 不会被
/// 同轮成功删除的其它条目连带从索引里抹掉 —— 否则分片 `task.<id>` 会变成
/// **永久孤儿**(pump 从不按前缀扫描 `task.*`, 没有别处会回收它)。
pub fn clear_finished(ids: &mut PutIds) -> Result<usize, String> {
    ensure_migrated(ids)?;
    let index = load_index();
    let before = index.len();
    let mut kept: Vec<TaskIndexEntry> = Vec::with_capacity(before);
    let mut removed = 0usize;
    let mut errors: Vec<String> = Vec::new();
    for entry in index {
        if matches!(entry.status.as_str(), STATUS_DONE | STATUS_FAILED) {
            if let Err(err) = delete_task(ids, &entry.id) {
                errors.push(format!("{}: {err}", entry.id));
                // 删除失败: 条目仍留在索引里, 与残留的分片保持一致(下轮可重试)。
                kept.push(entry);
            } else {
                removed += 1;
            }
        } else {
            kept.push(entry);
        }
    }
    if removed > 0 {
        save_index(ids, &kept)?;
    }
    if !errors.is_empty() {
        return Err(format!("清理失败 {} 条: {}", errors.len(), errors.join("; ")));
    }
    Ok(removed)
}

// ─────────────────────────── 展示 / 回调 / pump ───────────────────────────

/// `state` 响应里的任务列表: 索引按 `updated_ms` 倒序, 最近 [`STATE_TASKS_LIMIT`] 条。
///
/// **只读 `tasks.idx` 一个键** —— 这是 0.3.12 分片的直接收益: state 的峰值内存
/// 只与索引大小(<= 200 条紧凑条目)有关, 与队列里有多少完整记录无关。
///
/// 字段是索引的全集(`id`/`status`/`name`/`singers`/`quality`/`error`/`updated_ms`),
/// 前端只读这七个, 协议形状与旧的完整 `Task` 视图**兼容**(旧视图多出来的字段
/// 前端没有引用)。
pub fn state_view() -> Vec<Value> {
    let mut index = load_index();
    sort_index(&mut index);
    index.truncate(STATE_TASKS_LIMIT);
    index.into_iter().map(|entry| serde_json::to_value(entry).unwrap_or(Value::Null)).collect()
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
    ensure_migrated(ids)?;
    let Some(mut task) = load_task(task_id) else {
        // 任务被清理或不是本实例的任务: 静默确认, 避免宿主无限重投。
        return Ok(json!({"handled": true, "answer": "任务不存在或已被清理", "alert": false}));
    };
    if !requeue(&mut task) {
        return Ok(json!({
            "handled": true,
            "answer": format!("任务状态为 {}, 无需重试", task.status),
            "alert": false,
        }));
    }
    let name = task.display_name();
    persist_task(ids, &task)?;
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
        /// 让假宿主对指定 storage 键的 DELETE 返回 500(测删除失败时的索引一致性)。
        static FAIL_DELETE_KEY: RefCell<Option<String>> = RefCell::new(None);
        /// 0.3.14 审计: 假宿主收到的每一次 storage GET 的键。用例自行清空后
        /// 跑一段操作, 用来断言"去重读次数与队列长度无关"。
        static STORAGE_GETS: RefCell<Vec<String>> = RefCell::new(Vec::new());
    }

    /// 清空 GET 计数(审计用例在摆好初始队列后、断言前调用)。
    fn reset_get_count() {
        STORAGE_GETS.with(|gets| gets.borrow_mut().clear());
    }

    /// 自上次 [`reset_get_count`] 以来假宿主收到的 storage GET 次数。
    fn get_count() -> usize {
        STORAGE_GETS.with(|gets| gets.borrow().len())
    }

    /// 装一个只处理 `/api/plugin-runtime/storage/:key` 的宿主替身。
    fn install_fake_kv_host() {
        FAKE_KV.with(|kv| kv.borrow_mut().clear());
        FAIL_DELETE_KEY.with(|f| *f.borrow_mut() = None);
        STORAGE_GETS.with(|gets| gets.borrow_mut().clear());
        crate::host::testhost::install(Box::new(|request: &HostCallRequest| {
            let key = request
                .path
                .strip_prefix("/api/plugin-runtime/storage/")
                .unwrap_or("")
                .to_string();
            match request.method.as_str() {
                "GET" => {
                    STORAGE_GETS.with(|gets| gets.borrow_mut().push(key.clone()));
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
                "DELETE" => {
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
                    // 指定键的 DELETE 强制失败(测删除失败时的索引/分片一致性)。
                    let fail = FAIL_DELETE_KEY.with(|f| f.borrow().clone());
                    if fail.as_deref() == Some(key.as_str()) {
                        return Ok(HostCallResponse {
                            status: 500,
                            body_base64: base64::engine::general_purpose::STANDARD_NO_PAD
                                .encode(br#"{"error":"storage DELETE HTTP 500"}"#),
                            ..HostCallResponse::default()
                        });
                    }
                    let existed = FAKE_KV.with(|kv| kv.borrow_mut().remove(&key).is_some());
                    // 键不存在 → 404(store::delete 视作成功, 删幂等)。
                    Ok(HostCallResponse {
                        status: if existed { 200 } else { 404 },
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
        let taken = vec![short_id("seed"), short_id("seed#1")];
        let id = allocate_id(&taken, "seed");
        assert!(id.len() <= MAX_TASK_ID_LEN, "id 超长: {id}");
        assert!(id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'z').contains(&byte)));
        assert_ne!(id, taken[0], "必须绕开已有 id");
        assert_ne!(id, taken[1], "必须绕开已有 id");
        assert!(format!("retry:{id}").len() <= 32, "callback_data 限 32 字节");
    }

    /// 把一条任务写成分片形态(完整记录 + 索引), 供测试直接摆布状态。
    ///
    /// 走 [`persist_task`]: 同 id 的索引条目**就地替换**, 不会在索引里留下重复项。
    fn put_sharded(ids: &mut PutIds, task: &Task) {
        persist_task(ids, task).unwrap();
    }

    /// 分片键名必须满足宿主的 storage 键正则(否则 PUT/DELETE 一律 400)。
    ///
    /// 这条用例是 `TASK_KEY_PREFIX` 用 `.` 而非 `:` 的原因: 宿主键正则
    /// `^[A-Za-z0-9](?:[A-Za-z0-9]|[._-](?=[A-Za-z0-9]))*$` 不含 `:`。
    #[test]
    fn storage_keys_satisfy_host_pattern() {
        assert!(key_is_host_safe(TASKS_IDX_KEY), "索引键非法: {TASKS_IDX_KEY}");
        assert!(key_is_host_safe(TASKS_KEY), "旧键非法: {TASKS_KEY}");
        // 短 id 是 base36 字母数字, 拼出来的分片键必然合法。
        for id in [short_id("a"), "0".to_string(), "zzzzzzzz".into(), "a1b2c3d4".into()] {
            let key = task_key(&id);
            assert!(key_is_host_safe(&key), "分片键非法: {key}");
        }
        // 边界: 首字符非字母数字、分隔符结尾、分隔符后非字母数字、含 `:` —— 都要被拒。
        for bad in ["", ".task", "-x", "tasks.", "tasks..a", "tasks:a", "a b", "a/b"] {
            assert!(!key_is_host_safe(bad), "本该非法的键被判合法: {bad:?}");
        }
        assert!(!key_is_host_safe(&"a".repeat(161)), "超 160 字符必须拒绝");
        assert!(key_is_host_safe(&"a".repeat(160)), "160 字符应当合法");
    }

    /// 0.3.12 迁移: 旧单键 `tasks` → `task.<id>` 全量 + `tasks.idx` + 删旧键。
    ///
    /// 覆盖需求里的"FakeHost 里塞旧格式"场景: 直接往旧键写旧版数组(0.3.11 形态)。
    #[test]
    fn migration_splits_legacy_tasks_key_into_shards() {
        install_fake_kv_host();
        let mut ids = PutIds::new();
        let legacy = vec![
            Task {
                id: "aaa111".to_string(),
                source: "netease".to_string(),
                song_id: "1".to_string(),
                name: "歌一".to_string(),
                singers: "甲".to_string(),
                quality: "jymaster".to_string(),
                status: STATUS_QUEUED.to_string(),
                job_ref: "job-a".to_string(),
                staged_path: "/staging/aaa111.part".to_string(),
                attempts: 2,
                retry_round: 1,
                out_name: "甲 - 歌一.flac".to_string(),
                created_ms: 100,
                updated_ms: 500,
                ..Task::default()
            },
            Task {
                id: "bbb222".to_string(),
                source: "qq".to_string(),
                song_id: "2".to_string(),
                name: "歌二".to_string(),
                singers: "乙".to_string(),
                quality: "flac".to_string(),
                status: STATUS_DONE.to_string(),
                created_ms: 200,
                updated_ms: 900,
                ..Task::default()
            },
        ];
        // 旧格式: 顶层数组。
        store::put(&mut ids, TASKS_KEY, &serde_json::to_vec(&legacy).unwrap()).unwrap();

        let moved = ensure_migrated(&mut ids).unwrap();
        assert_eq!(moved, 2);

        // 旧键已删。
        let (raw, ok) = store::get(TASKS_KEY);
        assert!(!ok || raw.is_empty(), "旧键必须在迁移后删除");

        // 每条完整记录都在分片键上, 且字段完整(job_ref/attempts/retry_round 不丢)。
        let first = load_task("aaa111").expect("分片键缺失");
        assert_eq!(first.job_ref, "job-a");
        assert_eq!(first.staged_path, "/staging/aaa111.part");
        assert_eq!(first.attempts, 2);
        assert_eq!(first.retry_round, 1);
        assert_eq!(first.out_name, "甲 - 歌一.flac");
        assert_eq!(first.status, STATUS_QUEUED);
        assert_eq!(load_task("bbb222").unwrap().status, STATUS_DONE);

        // 索引两条齐全, 按 updated_ms 倒序(bbb222 的 900 更新)。
        let index = load_index();
        assert_eq!(index.len(), 2);
        assert_eq!(index[0].id, "bbb222");
        assert_eq!(index[1].id, "aaa111");
        assert_eq!(index[1].quality, "jymaster");
        assert_eq!(index[1].singers, "甲");

        // 幂等: 再迁移一次是零成本空操作(旧键已删)。
        assert_eq!(ensure_migrated(&mut ids).unwrap(), 0);
        assert_eq!(load_index().len(), 2);
    }

    /// 迁移兼容旧版 `{"tasks":[...]}` 包装形态, 并在解析失败时**保留**旧键。
    #[test]
    fn migration_handles_wrapped_document_and_keeps_bad_value() {
        install_fake_kv_host();
        let mut ids = PutIds::new();
        let wrapped = json!({"tasks": [{
            "id": "ccc333", "status": STATUS_FAILED, "name": "歌三", "error": "boom", "updated_ms": 42
        }]});
        store::put(&mut ids, TASKS_KEY, &serde_json::to_vec(&wrapped).unwrap()).unwrap();
        assert_eq!(ensure_migrated(&mut ids).unwrap(), 1);
        assert_eq!(load_index()[0].id, "ccc333");
        assert_eq!(load_index()[0].error, "boom");

        // 非法值: 报错且**不删**旧键(宁可停住也不静默丢队列)。
        store::put(&mut ids, TASKS_KEY, b"not json").unwrap();
        assert!(ensure_migrated(&mut ids).is_err());
        let (raw, ok) = store::get(TASKS_KEY);
        assert!(ok && !raw.is_empty(), "解析失败必须保留旧键");
    }

    /// 索引的 `error` 字段按 [`IDX_ERROR_LIMIT`] 截断(否则索引会被长响应体撑大)。
    #[test]
    fn index_entry_truncates_error_to_120_bytes() {
        let long = "错".repeat(200); // 600 字节
        let task = Task { id: "x".into(), error: long, ..Task::default() };
        let entry = TaskIndexEntry::of(&task);
        assert!(
            entry.error.len() <= IDX_ERROR_LIMIT,
            "error 未截断: {} 字节",
            entry.error.len()
        );
        assert_eq!(entry.error.chars().count(), IDX_ERROR_LIMIT / 3);
        // 短错误原样保留。
        let short = Task { id: "x".into(), error: "boom".into(), ..Task::default() };
        assert_eq!(TaskIndexEntry::of(&short).error, "boom");
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
        let mut task = load_task(&first.task.id).unwrap();
        task.status = STATUS_FAILED.to_string();
        put_sharded(&mut ids, &task);
        let third = enqueue(&mut ids, &request("netease", "123", "lossless")).unwrap();
        assert!(!third.deduped);
        assert_ne!(third.task.id, first.task.id);
        assert_eq!(load_index().len(), 2, "索引两条");
        assert!(load_task(&third.task.id).is_some(), "新任务也要有完整记录");
    }

    /// 0.3.14 存储调用审计: 一次"新歌入队"的 storage **GET 次数不随已排队条数增长**。
    ///
    /// 旧实现(0.3.12)对索引里全部进行中条目逐条读 `task.<id>` 做精确匹配, GET 次数
    /// 随待下载队列线性增长; 索引带上 `source`/`song_id` 后, 常规路径固定为
    /// 「迁移快查 1 次 + 读索引 1 次」两次 GET。这里用 5 条 vs 30 条排队做对照。
    #[test]
    fn enqueue_get_count_is_constant_in_queue_length() {
        fn measure_new_enqueue_gets(queued: usize) -> usize {
            install_fake_kv_host();
            let mut ids = PutIds::new();
            for index in 0..queued {
                // 每首不同的 song_id, 保证都是"新建"(索引条目都带 source)。
                enqueue(&mut ids, &request("netease", &format!("old-{index}"), "lossless")).unwrap();
            }
            assert_eq!(load_index().len(), queued);
            reset_get_count();
            let outcome = enqueue(&mut ids, &request("netease", "brand-new", "lossless")).unwrap();
            assert!(!outcome.deduped);
            get_count()
        }

        let short = measure_new_enqueue_gets(5);
        let long = measure_new_enqueue_gets(30);
        assert_eq!(
            short, long,
            "入队 GET 次数随队列长度变化: 5 条={short}, 30 条={long}"
        );
        // 常规新歌入队的 GET 组成(与队列长度无关): 迁移快查 `tasks` 1 + 读索引 `tasks.idx` 1
        // + 两次 PUT 各一次 ETag 预读(store::put 先读后写)2 = 4。关键不是这个常数本身,
        // 而是它不随已排队条数增长。
        assert_eq!(short, 4, "常规新歌入队 GET 次数 = 4(tasks + tasks.idx + 两次 PUT 预读)");
    }

    /// 审计续: **去重命中**的 GET 次数同样与队列长度无关(这正是 0.3.12 里 O(队列) 的路径)。
    ///
    /// 命中一首都只读一次索引 + 命中那一条完整记录; 无论目标排在第 5 还是第 30 位,
    /// 都不再像旧实现那样把前面所有进行中条目逐条读出来。
    #[test]
    fn enqueue_dedup_hit_get_count_is_constant_in_queue_length() {
        fn measure_dedup_gets(queued: usize, target: &str) -> usize {
            install_fake_kv_host();
            let mut ids = PutIds::new();
            for index in 0..queued {
                enqueue(&mut ids, &request("netease", &format!("s{index}"), "lossless")).unwrap();
            }
            reset_get_count();
            let outcome = enqueue(&mut ids, &request("netease", target, "lossless")).unwrap();
            assert!(outcome.deduped, "目标 {target} 应命中");
            get_count()
        }
        let short = measure_dedup_gets(5, "s0");
        let long = measure_dedup_gets(30, "s0");
        assert_eq!(short, long, "去重命中 GET 次数随队列长度变化: 5 条={short}, 30 条={long}");
        // 迁移快查 + 读索引 + 读命中那一条完整记录。
        assert_eq!(short, 3, "去重命中 GET 次数 = 3(tasks + tasks.idx + task.<id>)");
    }

    /// 0.3.14 自愈: 老索引条目缺 `source`/`song_id` 时, 首次入队读缺字段的分片补齐索引;
    /// 之后索引不再缺字段, 自愈**不会**再次发生(第二次入队的 GET 回到常规路径)。
    #[test]
    fn enqueue_heals_stale_index_once_then_dedupes() {
        install_fake_kv_host();
        let mut ids = PutIds::new();
        // 分片里有完整信息, 但索引条目是"老形态": 缺 source/song_id。
        let task = Task {
            id: "old1".to_string(),
            source: "netease".to_string(),
            song_id: "77".to_string(),
            quality: "lossless".to_string(),
            status: STATUS_QUEUED.to_string(),
            updated_ms: 1,
            ..Task::default()
        };
        save_task(&mut ids, &task).unwrap();
        save_index(
            &mut ids,
            &[TaskIndexEntry {
                id: "old1".to_string(),
                status: STATUS_QUEUED.to_string(),
                quality: "lossless".to_string(),
                updated_ms: 1,
                ..TaskIndexEntry::default()
            }],
        )
        .unwrap();

        reset_get_count();
        let first = enqueue(&mut ids, &request("netease", "77", "lossless")).unwrap();
        assert!(first.deduped, "补齐 source 后必须命中同 source+song_id+quality");
        assert_eq!(first.task.id, "old1");
        let healed_gets = get_count();
        // 迁移快查 + 读索引 + 读缺字段那一条分片(自愈) + 自愈写回索引的 ETag 预读
        // + 命中后再读该分片返回调用方 = 5。
        assert_eq!(healed_gets, 5, "首次自愈的读次数应为 5: {healed_gets}");

        // 索引条目已补齐(自愈写回)。
        let entry = load_index().into_iter().find(|e| e.id == "old1").unwrap();
        assert_eq!(entry.source, "netease");
        assert_eq!(entry.song_id, "77");

        // 第二次: 索引不再缺字段, 回到"迁移快查 + 读索引 + 读命中那一条"常规路径,
        // 少掉自愈那次多读与写回 —— 自愈只发生一次。
        reset_get_count();
        let second = enqueue(&mut ids, &request("netease", "77", "lossless")).unwrap();
        assert!(second.deduped);
        assert_eq!(second.task.id, "old1");
        assert_eq!(get_count(), 3, "第二次不该再读缺字段分片: {}", get_count());
        assert!(
            healed_gets > get_count(),
            "自愈必须是一次性开销: 首次 {healed_gets} > 常规 {}",
            get_count()
        );
    }

    /// 分片下 retry: 只读 `task.<id>` 一条, 重置后索引同步回排队态。
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

        let mut task = load_task(&id).unwrap();
        task.status = STATUS_FAILED.to_string();
        task.attempts = MAX_ATTEMPTS;
        task.error = "boom".to_string();
        put_sharded(&mut ids, &task);

        let value = retry(&mut ids, &id).unwrap();
        assert_eq!(value["message"], "已重新排队");
        let requeued = load_task(&id).unwrap();
        assert_eq!(requeued.status, STATUS_QUEUED);
        assert_eq!(requeued.attempts, 0);
        assert_eq!(requeued.error, "");
        // 索引也回到排队态(UI 不再显示 failed)。
        let entry = load_index().into_iter().find(|e| e.id == id).unwrap();
        assert_eq!(entry.status, STATUS_QUEUED);
        assert_eq!(entry.error, "");
        assert!(retry(&mut ids, "nope").is_err());
    }

    /// 分片下 task-clear: 遍历索引删完结任务的 `task.<id>`, 在途任务保留。
    #[test]
    fn clear_finished_removes_shards_and_rebuilds_index() {
        install_fake_kv_host();
        let mut ids = PutIds::new();
        let done = Task { id: "d1".into(), status: STATUS_DONE.into(), updated_ms: 1, ..Task::default() };
        let failed = Task { id: "f1".into(), status: STATUS_FAILED.into(), updated_ms: 2, ..Task::default() };
        let live = Task { id: "l1".into(), status: STATUS_DOWNLOADING.into(), job_ref: "job-1".into(), updated_ms: 3, ..Task::default() };
        for task in [&done, &failed, &live] {
            put_sharded(&mut ids, task);
        }

        let removed = clear_finished(&mut ids).unwrap();
        assert_eq!(removed, 2);
        assert!(load_task("d1").is_none(), "完结任务的分片键必须删掉");
        assert!(load_task("f1").is_none(), "完结任务的分片键必须删掉");
        let survivor = load_task("l1").expect("在途任务必须保留");
        assert_eq!(survivor.job_ref, "job-1", "完整字段不受影响");
        let index = load_index();
        assert_eq!(index.len(), 1);
        assert_eq!(index[0].id, "l1");

        // 再清一次: 幂等, 0 条。
        assert_eq!(clear_finished(&mut ids).unwrap(), 0);
        assert_eq!(load_index().len(), 1);
    }

    /// 删除失败的分片条目必须**留在索引里**: 否则同轮有别的条目删除成功时会
    /// `save_index`, 把这条终态任务从索引抹掉, 而它的 `task.<id>` 还在 ——
    /// 成为永久孤儿(pump 不扫描 `task.*`, 没有别处回收)。
    #[test]
    fn clear_finished_keeps_entry_when_shard_delete_fails() {
        install_fake_kv_host();
        let mut ids = PutIds::new();
        let done = Task { id: "d1".into(), status: STATUS_DONE.into(), updated_ms: 1, ..Task::default() };
        let done2 = Task { id: "d2".into(), status: STATUS_DONE.into(), updated_ms: 2, ..Task::default() };
        for task in [&done, &done2] {
            put_sharded(&mut ids, task);
        }

        // d1 的 DELETE 会失败, d2 正常删除。
        FAIL_DELETE_KEY.with(|f| *f.borrow_mut() = Some("task.d1".to_string()));
        let err = clear_finished(&mut ids).unwrap_err();
        assert!(err.contains("d1"), "错误应记账 d1: {err}");

        // d1: 分片仍在 → 索引条目必须也在(不能成孤儿)。
        assert!(load_task("d1").is_some(), "删除失败的分片本来就在");
        let index = load_index();
        assert!(
            index.iter().any(|e| e.id == "d1"),
            "删除失败的条目不能被索引丢掉: {index:?}"
        );
        // d2: 分片与索引都清掉(同轮成功删除的仍生效)。
        assert!(load_task("d2").is_none(), "d2 分片应被删");
        assert!(!index.iter().any(|e| e.id == "d2"), "d2 索引条目应被删");
        FAIL_DELETE_KEY.with(|f| *f.borrow_mut() = None);
    }

    #[test]
    fn telegram_callback_requeues_failed_task() {
        install_fake_kv_host();
        let mut ids = PutIds::new();
        let outcome = enqueue(&mut ids, &request("netease", "9", "jymaster")).unwrap();
        let id = outcome.task.id.clone();
        let mut task = load_task(&id).unwrap();
        task.status = STATUS_FAILED.to_string();
        task.attempts = MAX_ATTEMPTS;
        put_sharded(&mut ids, &task);

        // §12 的宿主投递形状。
        let payload = json!({
            "callback": {"data": format!("retry:{id}")},
            "message": {"message_id": 123, "chat_id": 456, "chat_type": "private", "user_id": 789, "date": 1759000000}
        });
        let value = on_telegram_callback(&mut ids, &payload).unwrap();
        assert_eq!(value["handled"], true);
        assert_eq!(value["alert"], false);
        assert_eq!(value["task_id"], id);
        let requeued = load_task(&id).unwrap();
        assert_eq!(requeued.status, STATUS_QUEUED);
        assert_eq!(requeued.attempts, 0);

        // 成功态任务不再重试。
        let mut task = load_task(&id).unwrap();
        task.status = STATUS_DONE.to_string();
        put_sharded(&mut ids, &task);
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

    /// state 只从 `tasks.idx` 组装(不再读 `task.<id>`), 且最近 [`STATE_TASKS_LIMIT`] 条。
    #[test]
    fn state_view_is_newest_first_and_capped() {
        install_fake_kv_host();
        let mut ids = PutIds::new();
        let entries: Vec<TaskIndexEntry> = (0..STATE_TASKS_LIMIT + 1)
            .map(|index| TaskIndexEntry {
                id: short_id(&format!("t{index}")),
                status: STATUS_QUEUED.to_string(),
                updated_ms: index as u64,
                ..TaskIndexEntry::default()
            })
            .collect();
        save_index(&mut ids, &entries).unwrap();
        let view = state_view();
        assert_eq!(view.len(), STATE_TASKS_LIMIT, "state 截最近 {} 条", STATE_TASKS_LIMIT);
        assert_eq!(view[0]["updated_ms"], STATE_TASKS_LIMIT as u64);
        // 索引本身不被 state_view 改写(只截副本)。
        assert_eq!(load_index().len(), STATE_TASKS_LIMIT + 1);
        // 协议形状: 前端读的七个字段都在。
        for key in ["id", "status", "name", "singers", "quality", "error", "updated_ms"] {
            assert!(view[0].get(key).is_some(), "state 条目缺字段: {key}");
        }
    }

    #[test]
    fn failed_document_surfaces_error() {
        install_fake_kv_host();
        let mut ids = PutIds::new();
        // 直接塞一个非法值。
        store::put(&mut ids, TASKS_KEY, b"not json").unwrap();
        assert!(load_legacy_result().is_err());
        // 索引读不出 → 空索引(供 state 展示), 不 panic。
        store::put(&mut ids, TASKS_IDX_KEY, b"not json").unwrap();
        assert!(load_index().is_empty());
    }
}
