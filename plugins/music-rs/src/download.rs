//! 宿主代下载管线 —— 取链 → 暂存 → 轮询 → 定名 → 复制 → 通知。
//!
//! 与 Go 版 music-dl(`music-agent` sidecar 本地下载)的关键差异: 字节搬运全部交给
//! 宿主 broker, 插件只编排状态机。对照 `sidecars/music-agent/app/server.mjs`:
//!
//! 1. **取链接**: [`crate::netease::song_url`] / [`crate::qq::song_url`] 拿到 CDN 直链;
//! 2. **暂存**: `POST /api/plugin-host/files/downloads {url, parent_ref, name:"<短id>.part"}`
//!    让宿主把直链下载到**本地**暂存目录(排除 CD2/AURA, 见 `new-hostcall.md` §11),
//!    返回 `job_ref`; 轮询 `GET /api/plugin-host/jobs/:job_ref` 直到终态;
//! 3. **定名**: 暂存完成后 `POST /api/local-files/rename` 把 `<短id>.part` 改成
//!    `"{singers} - {name}.{ext}"`(sidecar 是 `fs.renameSync(tmp, out_path)`);
//! 4. **入库**: `POST /api/local-files/copy` 把定名后的文件复制进 `target_dir`,
//!    由 CD2 负责刮削/入库;
//! 5. **通知**: 尝试次数用尽后 `POST /api/notifications/plugin`(level=error,
//!    标题含歌名, `buttons` 带 `{text:"重试", callback_data:"retry:<短id>"}`);
//!    `dedupe_key` 与幂等键都带 `retry_round`, 用户重试后再次失败仍会发出新通知。
//!
//! 队列语义(并发 `max_active`、按 `created_ms` 升序、失败消息文案)全部在 [`pump`]
//! 里实现; 队列本体在 [`crate::tasks`]。写操作(目录/下载/改名/复制/通知)都带
//! `Idempotency-Key`(16~128 可打印 ASCII), KV 走 ETag 乐观锁, 时间走 [`crate::clock`]。
//!
//! # 单次 pump 的内存上界(0.3.12 审计)
//!
//! wasm 线性内存**不归还 OS**: 堆的高水位由历史峰值决定, 且 static/OnceLock 的
//! 内容只增不减。因此"一次调用用了多少"必须按**最坏情况**算, 而不是按平均值。
//!
//! 一次 [`pump`] 常驻的只有三项, 逐项都有字节级上界(数字来自
//! `audit_measured_index_and_record_sizes`, 真机形态实测):
//!
//! | 项 | 上界 | 依据 |
//! |----|------|------|
//! | **idx 索引** `tasks.idx` | **条目 289 B × 条数**; 队列 200 条 = **56.4 KB** | 一条只带 `id`/`status`/`source`/`song_id`(0.3.14 入队去重需要)/`name`/`singers`/`quality`/`error`(截 120 B)/`updated_ms`; 由 [`crate::tasks::TaskIndexEntry`] 定义 |
//! | **在途完整记录** `task.<id>` | **951 B × 在途条数**; 稳态在途 `<= max_active`(封顶 16 条 = **14.9 KB**), 但轮询阶段**不按 `max_active` 截断**, 真实上界是索引里 `downloading`/`copying` 的条目数 | 完整 [`crate::tasks::Task`]](含 `job_ref`/`staged_path`/`out_name`/`album`/未截断的 `error`) |
//! | **单曲取链工作集** | **一首**, 不是一阶梯 | [`netease::song_url`] 的 8 档阶梯逐档释放: 每档的 `payload`/`params`/`form`/`response`/`body` 都在该次迭代结束即 drop, 跨档只留 200 B 的 `last_tail`(错误文案尾巴) |
//!
//! 合计**约 72 KB**(200 条队列 + 在途打满 + 一首取链), 加上宿主响应体的瞬时副本
//! (`host.call` 上限 [`crate::host::MAX_HOST_RESPONSE`] 8 MB, 但实际响应是 KB 级
//! 的 job/entries 列表)与 [`crate::arena`] 的 32 MB 帧上限(= 宿主帧上限, 不是本模块的用量)。
//!
//! ## 为什么与队列长度无关
//!
//! 队列里 40 条**已完结**任务的完整记录, 一次 pump **一条都不读** —— pump 只按
//! `tasks.idx` 里的 `status` 挑出 `downloading`/`copying`/第一条 `queued` 的 id,
//! 再按 id 去读那几条 `task.<id>`。完结记录只在 `task-clear`/`archive` 里逐条删,
//! 那是有界的显式操作, 不在 pump 的路径上。回归测试
//! `pump_reads_no_full_records_for_finished_queue`(40 条终态 → `task.<id>` 读取为 0)
//! 与 `pump_reads_only_the_one_task_it_advances`(38 终态 + 1 排队 → 只读那一条)
//! 守住这条性质。
//!
//! 换句话说: **峰值 = f(在途条数, 单曲工作集), 而不是 f(队列总长)**; 队列变长
//! 只会让 `tasks.idx` 这一个键变长(条目恒 289 B), 而不会把 N 份完整记录同时拉进内存。
//!
//! 另有三处"每轮固定"的瞬时开销: `probe_roots` 的响应 + `resolve_staged`/
//! `cleanup_staged` 的 `/api/local-files` `Value` 树(工作区目录大小, 与队列无关)、
//! 以及 `pumpdiag` 落盘用的 `json!` —— 三者都在各自函数作用域内 drop, 无逃逸
//! (不进返回值/闭包/static)。诊断 static 自身的上界见 [`DIAG_RAW_MAX_B64`]。

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::clock;
use crate::host::{self, HostCallRequest};
use crate::netease::{self, SongUrl};
use crate::qq;
use crate::store::{self, PutIds};
use crate::tasks::{self, Task, MAX_ATTEMPTS};
use crate::util;

/// 设置键(KV)。`staging_dir` / `target_dir` / `quality` / `max_active` / `notify_on_fail`。
pub const SETTINGS_KEY: &str = "settings";

/// 暂存目录与目标目录的默认值(与 sidecar `MUSIC_MOUNT` + `DL_SUBDIR` 一致)。
pub const DEFAULT_MUSIC_DIR: &str = "/CloudNAS/115open/音乐/音乐下载";
/// 默认音质(网易档位; QQ 用 `master`/`flac`/`320`/`128` 裁剪取链阶梯)。
pub const DEFAULT_QUALITY: &str = "jymaster";
/// 默认并发(与 sidecar `MAX_CONCURRENT_DOWNLOADS` 默认一致)。
pub const DEFAULT_MAX_ACTIVE: u32 = 2;
/// `max_active` 的接受上限(防止一次 pump 起过多宿主调用)。
pub const MAX_ACTIVE_CAP: u32 = 16;
/// CookieCloud 服务默认地址(本机官方默认端口, 见 `cookiecloud.rs`)。
pub const DEFAULT_COOKIECLOUD_URL: &str = "http://127.0.0.1:8088";

const FILES_ROOTS: &str = "/api/plugin-host/files/roots";

/// 0.3.10: 宿主文件管理器里插件工作区(ai_workspace)对应的容器路径。
/// 下载 job 的响应是无字段契约的 GenericHostObject, 真实落盘文件名还可能带
/// 宿主去重后缀("id (1).part"), 所以用文件列表按任务前缀定位, 不猜 job 字段。
const WORKSPACE_DIR: &str = "/dian115AI";
const FILES_ENTRIES: &str = "/api/plugin-host/files/entries";

// ── 诊断留档(0.3.7): files/roots 与 files/entries 都是官方无字段契约的
// GenericHostObject, 出入只能靠原始响应排查。pump 每轮把两处原始 HTTP 响应
// (base64, 规避宿主对响应内容的过滤)写入 KV `pumpdiag`, 供真机诊断读取。
//
// **上界(0.3.12 内存审计)**: 这两个 static 在 wasm 里**永不释放** —— 线性内存不归还
// OS, 堆高水位由历史峰值决定。因此它们的内容只增不减就是泄漏: 一次异常大的
// `files/roots` 响应(宿主是 GenericHostObject, 条目数不由本插件决定)会把 base64
// 后的**整份响应**钉在 static 里, 直到 worker 结束。两者都按
// [`DIAG_RAW_MAX_B64`] 截断, 使常驻量与响应大小、也与历史峰值无关。
//
// - [`DIAG_ROOTS_RAW`]: `files/roots` 响应, 上限 [`DIAG_RAW_MAX_B64`] 字节;
// - [`DIAG_ENTRIES`]: 0.3.8 起不再走 `files/entries` 引用链(改用工作区
//   `root_entry_ref`), 全仓无写入点, 恒为 `(0, "")` —— 保留字段只为 `pumpdiag`
//   的键形状稳定, 仍然是 0 字节。
static DIAG_ROOTS_RAW: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// 0.3.15: WASM 线性内存实时字节数(64KB 页 × 页数); 非 wasm 目标(测试)恒 0。
///
/// wasm 线性内存**不归还 OS**, 所以"这次操作到底涨了多少"只能靠内存指针读数
/// 前后对比: 真机上 `memory_size` 是权威值, manifest 的 `memory_mb` 只是上限。
pub fn wasm_memory_bytes() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        // Rust 1.98 起 `memory_size` 已是安全函数(再包 unsafe 会触发 unused_unsafe);
        // `allow(unused_unsafe)` 让这段在仍要求 unsafe 的旧工具链上也能编译
        // (CI 用滚动的 rust:1-slim 镜像)。
        #[allow(unused_unsafe)]
        unsafe {
            (core::arch::wasm32::memory_size(0) as u64) * 65_536
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}

/// [`wasm_memory_bytes`] 的 KB 形态(诊断字段一律 KB; 非 wasm 恒 0)。
pub fn wasm_memory_kb() -> u64 {
    wasm_memory_bytes() / 1024
}

// ── 队列操作互斥(0.3.15) ────────────────────────────────────────────────
//
// pump(定时 job `queuePump` 与手动 action `pump`/`queue-pump`)、单曲入队
// (action `download` → [`tasks::enqueue`])与整单入队(action `playlist-queue-all`)
// 读改写的都是同一批 KV 键(`tasks.idx` 与 `task.<id>`), 因此共用**同一面**旗标:
//
// - **为什么需要**: manifest `max_concurrency = 2`, cron 的 `queuePump` 可能撞上
//   用户手动点击。两个队列操作并发时, 各自在内存里持有一份索引/在途记录 ——
//   双份内存, 正是 0.3.12 起在 128MB 上限下要避免的; 而且 ETag 乐观锁只保证
//   单个键的写入不损坏, 不保证后写者不会覆盖前者的状态转移(读-改-写丢更新)。
// - **语义: 尝试进入, 失败即跳过, 绝不排队等待**。后来者立刻拿到 `skipped`
//   (提示"稍后再试"), 而不是阻塞/自旋 —— wasm 里没有可让步的线程原语, 阻塞只会
//   把请求堆在宿主侧; 被跳过的又都是幂等操作(推进/入队), 稍后再点或等下一轮
//   cron 都没有副作用。
// - **作用域**: 同一 wasm 实例内的重入/并发(第二个调用看得到第一个的旗标)。
//   宿主若把并发派发到不同实例, 那份隔离由宿主调度决定, 不在本旗标范围内。
//
// 生产是进程级原子; `cfg(test)` 用线程局部 —— 测试是多线程并行跑的, 共享旗标会
// 让互斥用例把其它并行用例挡成 skipped(假失败), 线程局部与 wasm 的单实例串行
// 语义一致(与 `clock::testhooks` 同一处理)。
#[cfg(not(test))]
static QUEUE_OP_RUNNING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(test)]
std::thread_local! {
    static QUEUE_OP_RUNNING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// 读改写队列旗标, 返回**改前**的值(`true` = 已有队列操作在跑)。
fn queue_op_flag_swap(running: bool) -> bool {
    #[cfg(not(test))]
    {
        QUEUE_OP_RUNNING.swap(running, std::sync::atomic::Ordering::SeqCst)
    }
    #[cfg(test)]
    {
        QUEUE_OP_RUNNING.with(|flag| flag.replace(running))
    }
}

/// 队列操作作用域守卫: 任何路径退出(含 `?` 提前返回)都复位旗标。
struct QueueOpGuard;

impl Drop for QueueOpGuard {
    fn drop(&mut self) {
        queue_op_flag_swap(false);
    }
}

/// 尝试独占一次队列操作。`None` = 已有队列操作在跑, 调用方必须**立即**返回
/// [`queue_busy_value`], 不得排队、不得重试(语义见上方互斥注释)。
fn try_begin_queue_op() -> Option<QueueOpGuard> {
    if queue_op_flag_swap(true) {
        None
    } else {
        Some(QueueOpGuard)
    }
}

/// 队列忙时的统一回答(不是失败: 什么都没做, 稍后再试即可)。
/// `skipped` 让 action 层([`crate::runtime`])把状态栏标成"已跳过"而不是"成功"。
fn queue_busy_value(message: &str) -> Value {
    json!({"skipped": "queue_busy", "message": message})
}

static DIAG_ENTRIES: std::sync::Mutex<(u16, String)> = std::sync::Mutex::new((0, String::new()));

/// 诊断留档单个字段的 base64 字节上限。
///
/// 取 8 KiB: 足够看清 `files/roots` 的字段形状(诊断只需要开头一段), 又让两个
/// static 的常驻量恒为 <= 16 KiB —— 不再由"历史最大响应"决定。base64 不可从中间
/// 解码, 因此按**字节**对齐到 4 的倍数再截, 保证截断后的文本仍是合法 base64。
pub const DIAG_RAW_MAX_B64: usize = 8 * 1024;

/// 把响应体编码成 base64 供诊断留档, 截断到 [`DIAG_RAW_MAX_B64`] 字节。
///
/// 截断标记放在**解码后**的字节里(而不是拼在 base64 文本末尾): 读档的人
/// `base64 -d` 之后能直接看到 `...<truncated>`, 不会把标记当响应内容。
fn diag_b64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    const MARKER: &[u8] = b"\n<truncated>";
    let engine = base64::engine::general_purpose::STANDARD;
    let marker_b64 = engine.encode(MARKER);
    // 上界是**编码后**的字符数(base64 把 3 字节变 4 字符, 膨胀 4/3), 所以先在
    // 字符域里给标记留位, 再把有效载荷对齐到 4 字符(= 3 字节), 最后换算回字节。
    let payload_chars = (DIAG_RAW_MAX_B64.saturating_sub(marker_b64.len()) / 4) * 4;
    let payload_bytes = payload_chars / 4 * 3;
    if bytes.len() <= payload_bytes {
        return engine.encode(bytes);
    }
    let mut out = engine.encode(&bytes[..payload_bytes]);
    out.push_str(&marker_b64);
    debug_assert!(out.len() <= DIAG_RAW_MAX_B64);
    out
}
const FILES_DIRECTORIES: &str = "/api/plugin-host/files/directories";
const FILES_DOWNLOADS: &str = "/api/plugin-host/files/downloads";
const JOBS_PREFIX: &str = "/api/plugin-host/jobs/";
const LOCAL_COPY: &str = "/api/local-files/copy";
const LOCAL_RENAME: &str = "/api/local-files/rename";
const NOTIFY_PLUGIN: &str = "/api/notifications/plugin";

/// CD2/AURA/云端后端的识别标记(root 的 backend/kind 字段里出现即排除)。
const CLOUD_MARKERS: [&str; 12] = [
    "cd2", "aura", "115", "cloud", "remote", "alist", "webdav", "smb", "nfs", "ftp", "s3",
    "oss",
];

// ─────────────────────────── 设置 ───────────────────────────

fn default_max_active() -> u32 {
    DEFAULT_MAX_ACTIVE
}

fn default_true() -> bool {
    true
}

fn default_cookiecloud_url() -> String {
    DEFAULT_COOKIECLOUD_URL.to_string()
}

/// 下载管线设置(KV `settings`)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    /// 本地暂存目录(必须在 `files/roots` 的本地可写根下)。
    #[serde(default)]
    pub staging_dir: String,
    /// 最终落点(通常指向 CD2 挂载的音乐目录)。
    #[serde(default)]
    pub target_dir: String,
    /// 默认音质(网易档位名)。
    #[serde(default)]
    pub quality: String,
    /// 并发下载数。
    #[serde(default = "default_max_active")]
    pub max_active: u32,
    /// 失败时是否发 Telegram 通知。
    #[serde(default = "default_true")]
    pub notify_on_fail: bool,
    /// CookieCloud 服务地址(默认本机 8088; 字段名保留原名落 KV —— 宿主的
    /// "cookie" 键名校验只针对 state/action 响应, 持久化存储不受限, 见
    /// `cookiecloud.rs` 模块头)。
    #[serde(default = "default_cookiecloud_url")]
    pub cookiecloud_url: String,
    /// CookieCloud 的 UUID(浏览器扩展同步端点 `/get/{uuid}`)。
    #[serde(default)]
    pub cookiecloud_uuid: String,
    /// CookieCloud 的同步口令。**绝不回显**(state/settings 视图只给 `cc_key_ready` 布尔)。
    #[serde(default)]
    pub cookiecloud_key: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            staging_dir: DEFAULT_MUSIC_DIR.to_string(),
            target_dir: DEFAULT_MUSIC_DIR.to_string(),
            quality: DEFAULT_QUALITY.to_string(),
            max_active: DEFAULT_MAX_ACTIVE,
            notify_on_fail: true,
            cookiecloud_url: DEFAULT_COOKIECLOUD_URL.to_string(),
            cookiecloud_uuid: String::new(),
            cookiecloud_key: String::new(),
        }
    }
}

impl Settings {
    /// 补齐空值(存储里缺字段/空串时回默认)。
    pub fn normalized(mut self) -> Settings {
        if self.staging_dir.trim().is_empty() {
            self.staging_dir = DEFAULT_MUSIC_DIR.to_string();
        }
        if self.target_dir.trim().is_empty() {
            self.target_dir = DEFAULT_MUSIC_DIR.to_string();
        }
        if self.quality.trim().is_empty() {
            self.quality = DEFAULT_QUALITY.to_string();
        }
        if self.max_active == 0 || self.max_active > MAX_ACTIVE_CAP {
            self.max_active = DEFAULT_MAX_ACTIVE;
        }
        if self.cookiecloud_url.trim().is_empty() {
            self.cookiecloud_url = DEFAULT_COOKIECLOUD_URL.to_string();
        }
        self.cookiecloud_uuid = self.cookiecloud_uuid.trim().to_string();
        self.cookiecloud_key = self.cookiecloud_key.trim().to_string();
        self
    }
}

/// 读取设置(KV `settings`; 缺失/损坏回默认)。
pub fn load_settings() -> Settings {
    store::get_json::<Settings>(SETTINGS_KEY).map(Settings::normalized).unwrap_or_default()
}

/// 写入设置。
pub fn save_settings(ids: &mut PutIds, settings: &Settings) -> Result<(), String> {
    store::put_json(ids, SETTINGS_KEY, settings).map_err(|err| err.to_string())
}

/// state 视图里的路径展示形态: 宿主安全过滤会拒绝包含"绝对路径"字符串的整个 state 响应
/// (以 "/" 开头即触发, douban-rs sanitize_state 的同一宿主行为), 所以对用户可见的
/// 路径一律去掉开头的 "/", 保存时再用 [`normalize_path`] 补回。
pub fn display_path(path: &str) -> String {
    path.trim_start_matches('/').to_string()
}

/// settings-update 输入归一化: 允许用户存不带开头 "/" 的路径, 内部一律还原成绝对路径。
pub fn normalize_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

/// 设置的可展示形态(state 响应 / settings-update 返回)。
///
/// CookieCloud 字段(0.3.4): 宿主(2026-09-30)递归拒绝 state/action 响应里键名含
/// "cookie" 子串的整个响应(douban-rs `sanitize_settings_view` 的同一宿主规则),
/// 所以输出键改名 `cc_url`/`cc_uuid`; 密钥绝不回显, 只给 `cc_key_ready` 布尔
/// (同步口令非空)。持久化 KV 里的字段原名不变。
pub fn settings_view(settings: &Settings) -> Value {
    json!({
        "staging_dir": display_path(&settings.staging_dir),
        "target_dir": display_path(&settings.target_dir),
        "quality": settings.quality,
        "max_active": settings.max_active,
        "notify_on_fail": settings.notify_on_fail,
        "cc_url": settings.cookiecloud_url,
        "cc_uuid": settings.cookiecloud_uuid,
        "cc_key_ready": !settings.cookiecloud_key.is_empty(),
    })
}

/// 当前设置视图。
pub fn settings_doc() -> Value {
    settings_view(&load_settings())
}

/// 合并设置补丁(action `settings-update`): 只接受类型正确的已知键, 非法值忽略。
pub fn settings_update(ids: &mut PutIds, patch: &Map<String, Value>) -> Result<Value, String> {
    let mut settings = load_settings();
    for (key, target) in [
        ("staging_dir", &mut settings.staging_dir),
        ("target_dir", &mut settings.target_dir),
        ("quality", &mut settings.quality),
    ] {
        if let Some(Value::String(text)) = patch.get(key) {
            let text = text.trim();
            if !text.is_empty() {
                let value = if key == "quality" {
                    text.to_string()
                } else {
                    normalize_path(text)
                };
                *target = value;
            }
        }
    }
    if let Some(value) = patch.get("max_active").and_then(Value::as_u64) {
        if value >= 1 && value <= u64::from(MAX_ACTIVE_CAP) {
            settings.max_active = value as u32;
        }
    }
    if let Some(flag) = patch.get("notify_on_fail").and_then(Value::as_bool) {
        settings.notify_on_fail = flag;
    }
    // CookieCloud 三项(0.3.4): 纯字符串, trim 后原样写入 —— **不走路径归一化**
    // ("http://…" 不以 "/" 开头, 会被 normalize_path 加上 "/" 前缀破坏);
    // 空串原样写入(显式清空 UUID/口令), URL 清空后由 normalized() 回默认本机地址。
    for (key, target) in [
        ("cookiecloud_url", &mut settings.cookiecloud_url),
        ("cookiecloud_uuid", &mut settings.cookiecloud_uuid),
        ("cookiecloud_key", &mut settings.cookiecloud_key),
    ] {
        if let Some(Value::String(text)) = patch.get(key) {
            *target = text.trim().to_string();
        }
    }
    let settings = settings.normalized();
    save_settings(ids, &settings)?;
    Ok(settings_view(&settings))
}

// ─────────────────────────── host.call 小工具 ───────────────────────────

/// 一次 host.call: 编码请求、解码响应体。传输层失败 → `Err`。
fn host_roundtrip(
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    idempotency_key: Option<&str>,
) -> Result<(i32, Vec<u8>), String> {
    let mut request = HostCallRequest::new(method, path).with_header("accept", "application/json");
    if let Some(key) = idempotency_key {
        request = request.with_header("idempotency-key", key);
    }
    if let Some(body) = body {
        request = request
            .with_header("content-type", "application/json")
            .with_body_base64(host::encode_body_base64(body));
    }
    let response = host::call(&request).map_err(|err| format!("host.call {method} {path}: {err}"))?;
    let bytes = store::decode_body(&response)
        .map_err(|err| format!("host.call {method} {path} 响应解码失败: {err}"))?;
    Ok((response.status, bytes))
}

/// 非 2xx 的错误文本(带响应体截断, 对齐仓库里 `util::trunc` 的 200 字节约定)。
fn http_error(method: &str, path: &str, status: i32, body: &[u8]) -> String {
    let detail = util::trunc(body);
    if detail.is_empty() {
        format!("host.call {method} {path} HTTP {status}")
    } else {
        format!("host.call {method} {path} HTTP {status}: {detail}")
    }
}

/// broker 写操作的幂等键: 同一任务同一尝试重试时保持不变(宿主据此去重),
/// 新尝试用新键。长度 16~128、全可打印 ASCII。
fn idem_key(kind: &str, task_id: &str, attempt: u32) -> String {
    format!("mr-dl-{kind}-{task_id}-attempt{attempt}")
}

/// URL 路径段编码(不引入依赖; 保留 RFC3986 unreserved 与 `:`)。
fn path_segment(raw: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b':') {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    out
}

/// 目录拼接(去掉尾部 `/`, 空目录退化为 `/{name}` 由调用方兜底)。
fn join_dir(dir: &str, name: &str) -> String {
    format!("{}/{}", dir.trim_end_matches('/'), name)
}

/// 取路径最后一段(文件名)。
/// 取父目录(不含末尾 '/'; 无 '/' 时返回空串)。锚定 job 上报的绝对路径用。
fn parent_dir(path: &str) -> String {
    match path.rfind('/') {
        Some(index) if index > 0 => path[..index].to_string(),
        Some(_) => String::new(),
        None => String::new(),
    }
}

fn file_name_of(path: &str) -> String {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string()
}

/// 目录规范化: trim + 去尾部 `/`(保留根 `/` 的原义交给前缀匹配)。
fn normalize_dir(dir: &str) -> String {
    dir.trim().trim_end_matches('/').to_string()
}

// ─────────────────────────── 文件根探测 ───────────────────────────

/// `files/roots` 里的一个根。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Root {
    pub path: String,
    pub name: String,
    /// 后端不是 CD2/AURA/云端(按 backend/kind 字段里的标记判断)。
    pub local: bool,
    pub writable: bool,
}

/// `files/roots` 的探测结果。
#[derive(Debug, Clone, Default)]
pub struct RootsProbe {
    pub ok: bool,
    pub error: String,
    pub roots: Vec<Root>,
    /// roots 原始条目(0.3.8): 宿主真实形状是 data.items[] 里带 root_id/root_entry_ref/
    /// alias/backend/capabilities, 引用链(parent_ref)只能从这里取。
    pub items: Vec<Value>,
}

/// 在对象(或 `data`/`result` 里的一层嵌套对象)中取第一个非空字符串字段。
fn first_str(map: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(Value::String(text)) = map.get(*key) {
            if !text.trim().is_empty() {
                return Some(text.trim().to_string());
            }
        }
    }
    None
}

/// 在对象(或一层嵌套对象)中取第一个布尔字段。
fn first_bool(map: &Map<String, Value>, keys: &[&str]) -> Option<bool> {
    for key in keys {
        if let Some(Value::Bool(flag)) = map.get(*key) {
            return Some(*flag);
        }
    }
    for container in ["data", "root", "entry"] {
        if let Some(Value::Object(inner)) = map.get(container) {
            for key in keys {
                if let Some(Value::Bool(flag)) = inner.get(*key) {
                    return Some(*flag);
                }
            }
        }
    }
    None
}

/// 从 `files/roots` 响应里找根列表(兼容数组直给 / `roots`/`entries`/`items`/`data` 包装)。
fn extract_array(value: &Value) -> Vec<Value> {
    if let Value::Array(items) = value {
        return items.clone();
    }
    if let Value::Object(map) = value {
        for key in ["roots", "entries", "items", "list", "data"] {
            if let Some(Value::Array(items)) = map.get(key) {
                return items.clone();
            }
            if let Some(Value::Object(inner)) = map.get(key) {
                for inner_key in ["roots", "entries", "items", "list"] {
                    if let Some(Value::Array(items)) = inner.get(inner_key) {
                        return items.clone();
                    }
                }
            }
        }
    }
    Vec::new()
}

fn parse_root(item: &Value) -> Option<Root> {
    let (path, map) = match item {
        Value::String(text) => {
            let path = normalize_dir(text);
            if path.is_empty() {
                return None;
            }
            return Some(Root { path, name: String::new(), local: true, writable: true });
        }
        Value::Object(map) => (
            first_str(
                map,
                &[
                    "path", "full_path", "local_path", "dir_path", "mount_path", "root_path",
                    "root", "dir", "real_path",
                ],
            )?,
            map,
        ),
        _ => return None,
    };
    let path = normalize_dir(&path);
    if path.is_empty() {
        return None;
    }
    let name = first_str(map, &["name", "label", "title"]).unwrap_or_default();
    let backend = first_str(
        map,
        &["backend", "kind", "type", "source", "provider", "protocol", "storage", "fs_type"],
    )
    .unwrap_or_default()
    .to_ascii_lowercase();
    let local = !CLOUD_MARKERS.iter().any(|marker| backend.contains(marker));
    let writable = first_bool(map, &["writable", "is_writable", "writeable", "can_write"])
        .or_else(|| first_bool(map, &["read_only", "readonly"]).map(|read_only| !read_only))
        .unwrap_or(true);
    Some(Root { path, name, local, writable })
}

/// 探测宿主向插件开放的本地/云端根(`GET /api/plugin-host/files/roots`)。
pub fn probe_roots() -> RootsProbe {
    let (status, body) = match host_roundtrip("GET", FILES_ROOTS, None, None) {
        Ok(out) => out,
        Err(err) => {
            return RootsProbe { ok: false, error: err, roots: Vec::new(), items: Vec::new() };
        }
    };
    if !(200..300).contains(&status) {
        return RootsProbe {
            ok: false,
            error: http_error("GET", FILES_ROOTS, status, &body),
            roots: Vec::new(),
            items: Vec::new(),
        };
    }
    *DIAG_ROOTS_RAW.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = diag_b64(&body);
    let value: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(err) => {
            return RootsProbe {
                ok: false,
                error: format!("GET {FILES_ROOTS} 响应不是 JSON: {err}"),
                roots: Vec::new(),
                items: Vec::new(),
            };
        }
    };
    let roots = extract_array(&value).iter().filter_map(parse_root).collect();
    let items = extract_array(&value);
    RootsProbe { ok: true, error: String::new(), roots, items }
}

/// 依据探测结果决定本次 pump 实际使用的暂存目录。
///
/// - 配置的 `staging_dir` 落在某个**本地可写根**下(排除 CD2/AURA) → 原样使用;
/// - 否则回退到第一个本地可写根下的 `音乐下载/`, 并把回退原因放进 warnings;
/// - 没有任何本地可写根 → `None`(队列保持排队, 由 state 里的 warnings 提示)。
pub fn effective_staging(settings: &Settings, probe: &RootsProbe) -> (Option<String>, Vec<String>) {
    let mut warnings = Vec::new();
    let configured = normalize_dir(&settings.staging_dir);
    if !configured.is_empty() {
        // 0.3.5: 直接信任已配置的暂存目录。宿主的 downloads broker 才是最终裁判
        // (目标非法会在任务 error 里给出明确原因), 不再因 files/roots 视图
        // (官方无字段契约的 GenericHostObject) 对不上而无限期搁置整个队列。
        if best_root(probe, &configured).is_none() {
            warnings.push(format!(
                "staging_dir {configured} 未命中宿主文件根视图, 按配置直试(以 downloads broker 校验为准)"
            ));
        }
        return (Some(configured), warnings);
    }
    if let Some(root) = probe.roots.iter().find(|root| root.local && root.writable) {
        let fallback = join_dir(&root.path, "音乐下载");
        warnings.push(format!("staging_dir 未配置, 回退到本地可写根下 {fallback}"));
        return (Some(fallback), warnings);
    }
    warnings.push("staging_dir 未配置且宿主未返回可识别的本地可写根".to_string());
    (None, warnings)
}

/// 最长前缀命中的本地可写根。
fn best_root<'a>(probe: &'a RootsProbe, dir: &str) -> Option<&'a Root> {
    probe
        .roots
        .iter()
        .filter(|root| root.local && root.writable)
        .filter(|root| dir == root.path || dir.starts_with(&format!("{}/", root.path)))
        .max_by_key(|root| root.path.len())
}

/// state 响应里的"本地根探测"摘要。
pub fn state_probe() -> Value {
    let settings = load_settings();
    let probe = probe_roots();
    let (effective, warnings) = if probe.ok {
        effective_staging(&settings, &probe)
    } else {
        (None, Vec::new())
    };
    let roots: Vec<Value> = probe
        .roots
        .iter()
        .take(50)
        .map(|root| {
            json!({
                "path": display_path(&root.path),
                "name": root.name,
                "local": root.local,
                "writable": root.writable,
            })
        })
        .collect();
    json!({
        "ok": probe.ok,
        "error": probe.error,
        "staging_dir": display_path(&settings.staging_dir),
        "staging_dir_effective": effective.as_deref().map(display_path),
        "target_dir": display_path(&settings.target_dir),
        "warnings": warnings,
        "roots": roots,
    })
}

// ─────────────────────────── 暂存目录与 parent_ref ───────────────────────────

/// `files/entries` 的 parent_ref 结果。
enum ParentRef {
    Found(String),
    Missing,
}

/// 从 entries 响应里取目录引用: `parent_ref`, 兼容 `self_ref`/`entry_ref`/`ref` 等写法。
fn find_ref(value: &Value, depth: u8) -> Option<String> {
    if depth > 3 {
        return None;
    }
    if let Value::Object(map) = value {
        if let Some(found) = first_str(
            map,
            &["parent_ref", "self_ref", "entry_ref", "current_ref", "dir_ref", "ref"],
        ) {
            return Some(found);
        }
        for container in ["data", "entry", "current", "result"] {
            if let Some(inner) = map.get(container) {
                if let Some(found) = find_ref(inner, depth + 1) {
                    return Some(found);
                }
            }
        }
    }
    None
}

/// 0.3.8: 宿主向插件开放的文件根是"工作区"模型(roots 返回 data.items[], 每项含
/// root_id / root_entry_ref / alias / backend / capabilities), entries/directories
/// 都要求 root_id 语义(官方无字段契约)。因此暂存直接放**本地可写工作区根**下,
/// parent_ref 取 root_entry_ref, 免去 entries/directories 的引用链; 暂存文件的
/// 真实路径以 downloads job 的上报为准(见 Task::staged_path), 后续 rename/copy
/// 全部锚定该路径。
fn workspace_parent_ref(probe: &RootsProbe) -> Result<String, String> {
    let empty = serde_json::Map::new();
    for item in &probe.items {
        let map = item.as_object().unwrap_or(&empty);
        let backend = first_str(map, &["backend", "kind", "type"])
            .unwrap_or_default()
            .to_ascii_lowercase();
        if CLOUD_MARKERS.iter().any(|marker| backend.contains(marker)) {
            continue;
        }
        let caps = item
            .get("capabilities")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<String>>()
            })
            .unwrap_or_default();
        let writable = caps.iter().any(|cap| cap.contains("write"));
        if !backend.is_empty() && !writable {
            continue;
        }
        let reference =
            first_str(map, &["root_entry_ref", "entry_ref", "ref", "root_ref"]).unwrap_or_default();
        if !reference.is_empty() {
            return Ok(reference);
        }
    }
    let seen: Vec<String> = probe
        .items
        .iter()
        .map(|item| {
            let map = item.as_object().unwrap_or(&empty);
            format!(
                "{}({})",
                first_str(map, &["alias", "name"]).unwrap_or_default(),
                first_str(map, &["backend"]).unwrap_or_default()
            )
        })
        .collect();
    Err(format!(
        "宿主未向插件开放本地可写工作区根(roots: [{}]); 请在宿主侧为插件开放本地文件根",
        seen.join(", ")
    ))
}

// ─────────────────────────── 两段式操作 ───────────────────────────

/// 在对象(及 `data`/`result`/`job`/`task` 嵌套对象)里取第一个非空字符串字段。
fn find_string(value: &Value, keys: &[&str], depth: u8) -> Option<String> {
    if depth > 3 {
        return None;
    }
    let map = match value.as_object() {
        Some(map) => map,
        None => return None,
    };
    if let Some(found) = first_str(map, keys) {
        return Some(found);
    }
    for container in ["data", "result", "job", "task"] {
        if let Some(inner) = map.get(container) {
            if let Some(found) = find_string(inner, keys, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

/// 第一段: `POST /api/plugin-host/files/downloads`, 返回 `{job_ref}`。
pub fn stage_download(
    task_id: &str,
    parent_ref: &str,
    url: &str,
    file_name: &str,
    attempt: u32,
) -> Result<Value, String> {
    let body = serde_json::to_vec(&json!({
        "url": url,
        "parent_ref": parent_ref,
        "name": file_name,
    }))
    .unwrap_or_default();
    let key = idem_key("stage", task_id, attempt);
    let (status, response) = host_roundtrip("POST", FILES_DOWNLOADS, Some(&body), Some(&key))?;
    if !(200..300).contains(&status) {
        return Err(http_error("POST", FILES_DOWNLOADS, status, &response));
    }
    let value: Value = serde_json::from_slice(&response)
        .map_err(|err| format!("POST {FILES_DOWNLOADS} 响应不是 JSON: {err}"))?;
    let job_ref = find_string(&value, &["job_ref", "task_ref", "ref", "id"], 0).unwrap_or_default();
    if job_ref.is_empty() {
        return Err(format!(
            "POST {FILES_DOWNLOADS} 响应缺少 job_ref: {}",
            util::trunc(&response)
        ));
    }
    Ok(json!({"job_ref": job_ref}))
}

/// 暂存文件定名: `POST /api/local-files/rename {old_path, new_name}`。
pub fn rename_staged(
    task_id: &str,
    old_path: &str,
    new_name: &str,
    attempt: u32,
) -> Result<Value, String> {
    let body = serde_json::to_vec(&json!({"old_path": old_path, "new_name": new_name}))
        .unwrap_or_default();
    let key = idem_key("rename", task_id, attempt);
    let (status, response) = host_roundtrip("POST", LOCAL_RENAME, Some(&body), Some(&key))?;
    if !(200..300).contains(&status) {
        return Err(http_error("POST", LOCAL_RENAME, status, &response));
    }
    let dir = old_path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    Ok(json!({"path": join_dir(dir, new_name)}))
}

/// 第二段: `POST /api/local-files/copy {src_paths, dest_dir}` 复制进目标目录。
pub fn copy_to_cd2(
    task_id: &str,
    staged_path: &str,
    target_dir: &str,
    attempt: u32,
) -> Result<Value, String> {
    let body = serde_json::to_vec(&json!({
        "src_paths": [staged_path],
        "dest_dir": target_dir,
    }))
    .unwrap_or_default();
    let key = idem_key("copy", task_id, attempt);
    let (status, response) = host_roundtrip("POST", LOCAL_COPY, Some(&body), Some(&key))?;
    if !(200..300).contains(&status) {
        return Err(http_error("POST", LOCAL_COPY, status, &response));
    }
    // SuccessResult {success:true}; 宽松处理: 2xx 且没有显式 success:false 即成功。
    if let Ok(value) = serde_json::from_slice::<Value>(&response) {
        if value.get("success").and_then(Value::as_bool) == Some(false) {
            return Err(format!("POST {LOCAL_COPY} 未成功: {}", util::trunc(&response)));
        }
    }
    Ok(json!({"path": join_dir(target_dir, &file_name_of(staged_path))}))
}

/// 失败通知: `POST /api/notifications/plugin`(§12 回调按钮见 `new-hostcall.md`)。
///
/// `dedupe_key` / `Idempotency-Key` 都带上 `retry_round`: `attempts` 在用户重试时
/// 会被归零, 只用 `attempts` 会让"重试后再次用尽"的第二次通知与上一轮逐字节相同,
/// 被宿主按幂等/去重吞掉(见 `docs-ref/new-hostcall.md:97-103` 与
/// `docs-ref/openapi64.yaml:2653` 的 200「通知已去重或明确抑制」)。
pub fn notify_failure(task: &Task, error: &str) -> Result<(), String> {
    let title = format!("下载失败: {}", truncate_chars(&task.name, 100));
    let body_text = format!(
        "{} - {}\n来源: {} / 音质: {}\n{}\n(在插件「下载任务」里可一键重试)",
        task.singers, task.name, task.source, task.quality, error
    );
    let body = serde_json::to_vec(&json!({
        "level": "error",
        "title": title,
        "body": truncate_chars(&body_text, 1800),
        // 0.3.11: 通知 schema(openapi PluginNotificationRequest)只认 {text,url} 按钮,
        // callback_data 会被 400 拒(真机证实); 重试入口并在正文里, 操作走插件页。
        "dedupe_key": format!(
            "dl-fail-{}-r{}-a{}",
            task.id, task.retry_round, task.attempts
        ),
    }))
    .unwrap_or_default();
    let key = notify_idem_key(task);
    let (status, response) = host_roundtrip("POST", NOTIFY_PLUGIN, Some(&body), Some(&key))?;
    if status == 200 || status == 202 {
        Ok(())
    } else {
        Err(http_error("POST", NOTIFY_PLUGIN, status, &response))
    }
}

/// 失败通知的幂等键: 含 `retry_round`, 使不同重试轮次的失败通知互不冲突。
fn notify_idem_key(task: &Task) -> String {
    format!(
        "mr-dl-notify-{}-round{}-attempt{}",
        task.id, task.retry_round, task.attempts
    )
}

/// 按字符数截断(通知标题/正文有长度上限)。
fn truncate_chars(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    text.chars().take(limit).collect()
}

// ─────────────────────────── 宿主任务状态 ───────────────────────────

/// 宿主 job 的三态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobState {
    Pending,
    Succeeded,
    Failed(String),
}

/// 映射宿主 job 状态(字段名/取值都按容错处理: 未知状态一律视为进行中)。
pub fn job_state(value: &Value) -> JobState {
    let status = find_string(value, &["status", "state", "phase"], 0)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        status.as_str(),
        "succeeded" | "success" | "done" | "completed" | "complete" | "finished" | "ok"
    ) {
        return JobState::Succeeded;
    }
    if matches!(
        status.as_str(),
        "failed" | "failure" | "error" | "canceled" | "cancelled" | "aborted" | "timeout"
            | "timed_out"
    ) {
        let detail = find_string(
            value,
            &["error", "message", "detail", "reason", "error_message"],
            0,
        )
        .unwrap_or_default();
        // sidecar 失败文案: `r.error || '失败'`。
        return JobState::Failed(if detail.is_empty() { "失败".to_string() } else { detail });
    }
    JobState::Pending
}

/// 从 job 响应里取暂存文件路径(取不到时调用方按 `<staging>/<短id>.part` 兜底)。
/// 列工作区目录, 返回以 `prefix` 开头的最新暂存文件真实路径(含宿主去重后缀)。
fn resolve_staged(prefix: &str) -> Option<String> {
    let query = format!("/api/local-files?path={}", netease::query_escape(WORKSPACE_DIR));
    let (status, body) = host_roundtrip("GET", &query, None, None).ok()?;
    if !(200..300).contains(&status) {
        return None;
    }
    let value: Value = serde_json::from_slice(&body).ok()?;
    let mut best: Option<(String, String)> = None;
    for entry in value.get("entries").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        if entry.get("is_dir").and_then(Value::as_bool).unwrap_or(true) {
            continue;
        }
        let name = entry.get("name").and_then(Value::as_str).unwrap_or("");
        let path = entry.get("path").and_then(Value::as_str).unwrap_or("");
        if path.is_empty() || !name.starts_with(prefix) {
            continue;
        }
        let mod_time = entry.get("mod_time").and_then(Value::as_str).unwrap_or("");
        if best.as_ref().map_or(true, |(_, best_time): &(String, String)| mod_time > best_time.as_str()) {
            best = Some((path.to_string(), mod_time.to_string()));
        }
    }
    best.map(|(path, _)| path)
}

/// 删除工作区里以 `prefix` 开头的全部暂存文件(入库成功后的清理, 尽力而为)。
fn cleanup_staged(prefix: &str) -> Result<usize, String> {
    let query = format!("/api/local-files?path={}", netease::query_escape(WORKSPACE_DIR));
    let (status, body) = host_roundtrip("GET", &query, None, None)?;
    if !(200..300).contains(&status) {
        return Err(http_error("GET", "/api/local-files", status, &body));
    }
    let value: Value = serde_json::from_slice(&body).map_err(|err| format!("列表解析失败: {err}"))?;
    let paths: Vec<String> = value
        .get("entries")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|entry| {
            !entry.get("is_dir").and_then(Value::as_bool).unwrap_or(true)
                && entry
                    .get("name")
                    .and_then(Value::as_str)
                    .map_or(false, |name| name.starts_with(prefix))
        })
        .filter_map(|entry| entry.get("path").and_then(Value::as_str).map(str::to_string))
        .collect();
    if paths.is_empty() {
        return Ok(0);
    }
    let count = paths.len();
    let body = serde_json::to_vec(&json!({"paths": paths})).unwrap_or_default();
    let key = idem_key("clean", prefix, 1);
    let (status, response) = host_roundtrip("DELETE", "/api/local-files", Some(&body), Some(&key))?;
    if !(200..300).contains(&status) {
        return Err(http_error("DELETE", "/api/local-files", status, &response));
    }
    Ok(count)
}

pub fn job_result_path(value: &Value) -> Option<String> {
    let mut containers = vec![value.clone()];
    for key in ["result", "data"] {
        if let Some(inner) = value.get(key) {
            if inner.is_object() {
                containers.push(inner.clone());
            }
        }
    }
    for container in containers {
        if let Some(path) = find_string(
            &container,
            &["path", "file_path", "dest_path", "output_path", "target_path", "dest", "output"],
            0,
        ) {
            return Some(path);
        }
        if let Some(Value::Array(entries)) = container.get("entries") {
            if let Some(Value::String(path)) = entries.first().and_then(|entry| entry.get("path")) {
                if !path.is_empty() {
                    return Some(path.clone());
                }
            }
        }
    }
    None
}

// ─────────────────────────── 入队 ───────────────────────────

/// action `download` 的入参。
#[derive(Debug, Clone, Default)]
pub struct DownloadRequest {
    pub source: String,
    pub song_id: String,
    pub name: String,
    pub singers: String,
    pub album: String,
    /// 请求音质(空 → 用设置的 `quality`)。
    pub level: String,
}

/// 建一条下载任务并写入 KV 队列(真正的下载在 [`pump`] 里推进)。
///
/// 0.3.15: 与 [`pump`]/[`playlist_queue_all`] 共用"队列操作"互斥 —— 撞车时**直接
/// 跳过**(返回 `skipped=queue_busy`, 不排队等待, 语义见 `QUEUE_OP_RUNNING` 注释),
/// 此时不产生任何 KV 写入。响应带 `mem_kb{start,end}` 内存探针(真机诊断用)。
pub fn request_download(ids: &mut PutIds, request: &DownloadRequest) -> Result<Value, String> {
    let Some(_guard) = try_begin_queue_op() else {
        let mem = wasm_memory_kb();
        return Ok(json!({
            "skipped": "queue_busy",
            "message": "队列正在推进或入队, 本次未入队, 请稍后再试",
            "mem_kb": {"start": mem, "end": mem},
        }));
    };
    let mem_start = wasm_memory_kb();
    let settings = load_settings();
    let level = request.level.trim();
    let quality = if level.is_empty() { settings.quality.clone() } else { level.to_string() };
    let outcome = tasks::enqueue(
        ids,
        &tasks::NewTask {
            source: request.source.trim().to_string(),
            song_id: request.song_id.trim().to_string(),
            name: request.name.clone(),
            singers: request.singers.clone(),
            album: request.album.clone(),
            quality,
        },
    )?;
    Ok(json!({
        "task_id": outcome.task.id,
        "status": outcome.task.status,
        "deduped": outcome.deduped,
        "out_name": outcome.task.out_name,
        "quality": outcome.task.quality,
        "mem_kb": {"start": mem_start, "end": wasm_memory_kb()},
    }))
}

// ─────────────────────── 歌单整单入队 (0.3.14) ───────────────────────

/// action `playlist-queue-all` 每批最多翻的页数上限。
/// 前台 action 超时 60s: 整批只 1 次 v6 detail(GET) 拿全量索引, 之后每页 1 次
/// v3 detail(POST, ~200ms), 10 页(1000 首)也只有约 11 次网络往返, 预算充足。
pub const PLAYLIST_QUEUE_MAX_PAGES: u32 = 10;

/// action `playlist-queue-all` 的 `batch_pages` 缺省值(5 页 = 500 首)。
pub const PLAYLIST_QUEUE_DEFAULT_PAGES: u32 = 5;

/// 歌单每页取歌数(与 [`netease::playlist_songs`] 一页 100 首一致)。
pub const PLAYLIST_PAGE_SIZE: u32 = 100;

/// action `playlist-queue-all` 的入参。
#[derive(Debug, Clone, Default)]
pub struct PlaylistQueueRequest {
    pub source: String,
    /// 歌单 id。
    pub playlist_id: String,
    /// 统一音质(空 → KV 设置里的默认音质)。
    pub quality: String,
    /// 本批最多翻页数(缺省 [`PLAYLIST_QUEUE_DEFAULT_PAGES`], 上限 [`PLAYLIST_QUEUE_MAX_PAGES`])。
    pub batch_pages: u32,
    /// 本批从第几页开始(缺省 1)。用于消费上一次返回的 `next_page` 续跑大歌单,
    /// 否则每批都会从头重复入队前几页。
    pub next_page: u32,
}

/// 整单入队的计数(响应的 `data` 字段来源)。
#[derive(Debug, Default, Clone, Copy)]
struct QueueCounts {
    queued: u64,
    deduped: u64,
    total_seen: u64,
    skipped: u64,
}

/// action result 的 `data` 主体(`status`/`message` 由调用方决定)。
///
/// 0.3.15 起 `data` 里恒带内存探针:
/// - `mem_kb{start,end}`: 本次 action 起止时的 wasm 线性内存(KB, 真机诊断);
/// - `pages_mem_kb`: 每处理完一页记一条 `{page,start,end}` —— 大歌单入队时
///   一眼能看出是哪一页把内存从多少 KB 推到了多少 KB。
///
/// 字段名与值都走宿主安全规则: 键名不含 "cookie" 子串、值不是以 "/" 开头的字符串
/// (见 `settings_view` 注释里的宿主过滤), 探针全是数字/数组, 不会被过滤。
fn queue_all_data(
    counts: QueueCounts,
    next_page: u32,
    has_more: bool,
    mem_start: u64,
    pages_mem_kb: &[Value],
) -> Value {
    json!({
        "queued": counts.queued,
        "deduped": counts.deduped,
        "total_seen": counts.total_seen,
        "skipped": counts.skipped,
        "next_page": next_page,
        "has_more": has_more,
        "mem_kb": {"start": mem_start, "end": wasm_memory_kb()},
        "pages_mem_kb": pages_mem_kb,
    })
}

/// 组装 action result(`status` 在顶层, 计数与探针在 `data` 下)。
fn queue_all_result(
    counts: QueueCounts,
    next_page: u32,
    has_more: bool,
    error: Option<String>,
    mem_start: u64,
    pages_mem_kb: &[Value],
) -> Value {
    let data = queue_all_data(counts, next_page, has_more, mem_start, pages_mem_kb);
    match error {
        Some(message) => json!({"status": "failed", "message": message, "data": data}),
        None => json!({"status": "succeeded", "data": data}),
    }
}

/// 队列操作互斥把本批整单入队挡下时的回答: `status=skipped`(不是 failed),
/// 计数全 0、`pages_mem_kb` 为空, 续批游标停在**请求的起始页**(什么都没做,
/// 下次从同一页继续, 不丢也不重)。
fn queue_all_skipped(mem_start: u64, start_page: u32) -> Value {
    json!({
        "status": "skipped",
        "skipped": "queue_busy",
        "message": "队列正在推进或入队, 本批未入队, 请稍后再试",
        "data": queue_all_data(
            QueueCounts::default(),
            start_page,
            true,
            mem_start,
            &[],
        ),
    })
}

/// 歌单整单入队核心(可注入取页器, 便于测试)。
///
/// 从 `start_page` 起逐页调用 `fetch(page, page_size)`; 对每首歌走 [`tasks::enqueue`](与
/// `download` 同一条入队路径, 索引去重, 统一 `quality`)。处理满 `batch_pages` 页, 或翻到
/// 页接口 `total`(整单曲目数)所指的末尾(`page * page_size >= total`)即停;
/// 仅在 `total` 缺失时退回"当页不满 [`PLAYLIST_PAGE_SIZE`]"的保守判定。
/// **页面级失败是业务失败**: 返回已完成的 `next_page`
/// 与错误文案, 已入队的不回滚。`next_page` 是"下次该取的页号"(错误时即失败那一页,
/// 全部满页时是 `start_page + batch_pages`)。
///
/// 0.3.15: 每页结束时记一条内存探针(`pages_mem_kb`, 成功页与失败页都记)。
/// 采样点在**页面作用域之后**, 页响应体已经释放 —— 量的是这页留在内存里的部分
/// (新入队条目推高的索引/分片工作集), 而不是当页响应体的瞬时副本。
/// 取页器(`fetch`)自 0.3.15 起在整单入队里是"一次性索引 + 本地切片": 全量
/// `trackIds` 只在第一页拉取时解析一次并被闭包持有到本批结束, 所以第一页之后
/// 各页的采样增量只包含当页 v3 详情与队列写入, 不再有整棵 trackIds 的解析分配。
fn queue_playlist_pages<F>(
    ids: &mut PutIds,
    source: &str,
    quality: &str,
    start_page: u32,
    batch_pages: u32,
    mut fetch: F,
) -> Value
where
    F: FnMut(u32, u32) -> Result<Value, String>,
{
    let start_page = start_page.max(1);
    let mem_start = wasm_memory_kb();
    let counts = &mut QueueCounts::default();
    let mut pages_mem_kb: Vec<Value> = Vec::new();
    // 本批处理 [start_page, start_page + batch_pages) 这些页。
    let end_page = start_page.saturating_add(batch_pages);
    let mut page = start_page;
    while page < end_page {
        let page_mem_start = wasm_memory_kb();
        // 一页的结局: 取尽 / 继续 / 取页失败。在页面作用域里算出, 作用域外再
        // 采样与返回 —— 这样页响应与逐首 `NewTask` 都已经释放。
        let mut exhausted = false;
        let mut page_error: Option<String> = None;
        {
            match fetch(page, PLAYLIST_PAGE_SIZE) {
                Ok(page_value) => {
                    let songs = page_value
                        .get("songs")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    counts.total_seen += songs.len() as u64;
                    for song in &songs {
                        let song_id =
                            song.get("id").and_then(Value::as_str).unwrap_or("").trim().to_string();
                        if song_id.is_empty() {
                            counts.skipped += 1;
                            continue;
                        }
                        let new_task = tasks::NewTask {
                            source: source.to_string(),
                            song_id,
                            name: song.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                            singers: song
                                .get("singers")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            album: song.get("album").and_then(Value::as_str).unwrap_or("").to_string(),
                            quality: quality.to_string(),
                        };
                        // 单首入队失败(如单条分片写入失败)不拖垮整批: 记账跳过, 继续后面的歌。
                        match tasks::enqueue(ids, &new_task) {
                            Ok(outcome) if outcome.deduped => counts.deduped += 1,
                            Ok(_) => counts.queued += 1,
                            Err(_) => counts.skipped += 1,
                        }
                    }
                    // 取尽判定以页接口恒带的 `total`(整单曲目数)为准, 而非当页条数:
                    // `song/detail` 会因下架/无版权/无效 id 少返曲目, 满页也可能不足 100 首,
                    // 只看 `songs.len()` 会把这样的页误判成最后一页, 后续页静默丢失。
                    // 本页覆盖到的曲目序号上界是 `page * PLAYLIST_PAGE_SIZE`, 一旦 >= total
                    // 就已翻到整单末尾(与前端 `plSongs.length < plTotal` 的权威判定一致)。
                    let total = page_value.get("total").and_then(Value::as_i64).unwrap_or(0);
                    let page_end = u64::from(page) * u64::from(PLAYLIST_PAGE_SIZE);
                    exhausted = if total > 0 {
                        page_end >= total as u64
                    } else {
                        // 没有 total(异常/旧接口)才退回当页条数判定, 保持有界。
                        songs.len() < PLAYLIST_PAGE_SIZE as usize
                    };
                }
                Err(err) => {
                    page_error = Some(format!("第 {page} 页取歌失败: {err}"));
                }
            }
        }
        // 本页结束(成功或失败)各记一次。
        pages_mem_kb.push(json!({
            "page": page,
            "start": page_mem_start,
            "end": wasm_memory_kb(),
        }));
        if let Some(message) = page_error {
            return queue_all_result(*counts, page, true, Some(message), mem_start, &pages_mem_kb);
        }
        if exhausted {
            // 取尽: 已覆盖整单全部曲目, 歌单到底了。
            return queue_all_result(*counts, page + 1, false, None, mem_start, &pages_mem_kb);
        }
        page += 1;
    }
    // 处理满 batch_pages 页且末页仍是满页: 后面可能还有, 让调用方从 end_page 续跑。
    queue_all_result(*counts, end_page, true, None, mem_start, &pages_mem_kb)
}

/// action `playlist-queue-all`: 把网易云歌单从 `next_page` 起的 `batch_pages` 页整单入队。
///
/// 入参校验失败或页面取歌失败都是**业务 failed**(不是协议 error, 宿主不该重投):
/// - 非网易云来源 → `该来源暂不支持歌单`;
/// - 缺歌单 id → `缺少歌单 id`; 音质与设置都空 → `缺少音质`;
/// - 某页接口失败 → 返回"第 N 页取歌失败"与**已入队计数 + 失败页号**, 不回滚已入队的。
///
/// `batch_pages` 会夹到 `[1, PLAYLIST_QUEUE_MAX_PAGES]`; `next_page` 缺省/0 视为从第 1 页
/// 开始。大歌单(> `batch_pages` 页)靠返回的 `next_page` 续跑, 不会重复处理已经入队的页。
///
/// 0.3.15: 本批只拉一次 [`netease::PlaylistIndex`](v6 `playlist/detail?n=0` 全量
/// `trackIds` + `total`), 之后各页纯本地切片、每页只 POST 一次 v3 `song/detail`。
/// 索引拉取失败与页面取歌失败同语义(业务 failed, 回传起始页与已入队计数)。
///
/// 0.3.15: 与 [`pump`]/[`request_download`] 共用"队列操作"互斥 —— 撞车时整批直接
/// `status=skipped`(不排队等待, 也不产生任何 KV 写入), 续批游标停在请求的起始页。
/// 响应带内存探针 `mem_kb{start,end}` 与逐页的 `pages_mem_kb`。
pub fn playlist_queue_all(ids: &mut PutIds, request: &PlaylistQueueRequest) -> Value {
    let mem_start = wasm_memory_kb();
    let start_page = request.next_page.max(1);
    let Some(_guard) = try_begin_queue_op() else {
        return queue_all_skipped(mem_start, start_page);
    };
    let source = request.source.trim();
    if source != "netease" {
        return queue_all_result(
            QueueCounts::default(),
            1,
            false,
            Some("该来源暂不支持歌单，先支持网易云".to_string()),
            mem_start,
            &[],
        );
    }
    let playlist_id = request.playlist_id.trim().to_string();
    if playlist_id.is_empty() {
        return queue_all_result(
            QueueCounts::default(),
            1,
            false,
            Some("缺少歌单 id".to_string()),
            mem_start,
            &[],
        );
    }
    let level = request.quality.trim();
    let quality = if level.is_empty() { load_settings().quality } else { level.to_string() };
    if quality.trim().is_empty() {
        return queue_all_result(
            QueueCounts::default(),
            1,
            false,
            Some("缺少音质".to_string()),
            mem_start,
            &[],
        );
    }
    let batch_pages = request.batch_pages.clamp(1, PLAYLIST_QUEUE_MAX_PAGES);
    // 0.3.15: 整批只 GET 一次 v6 detail 拿全量 trackIds + total, 之后各页纯本地切片
    // (`page*100..page*100+100`), 每片只 POST 一次 v3 detail 换详情 —— 网络从
    // N×(v6 全量 + v3) 降为 1×v6 + N×v3, 全量解析分配从 N 次降为 1 次。
    // 索引在**第一次取页时**才拉(惰性): 失败照样归到"第 N 页取歌失败"(N = 请求的起始页),
    // 续批游标不会因一次索引失败而跳页。跨批(next_page 续跑)是新的调用路径, 各自
    // 重取一次索引 —— 每批仍是 1×v6 + N×v3, 不是每页 v6。
    let mut index: Option<netease::PlaylistIndex> = None;
    queue_playlist_pages(ids, source, quality.trim(), start_page, batch_pages, |page, size| {
        if index.is_none() {
            index = Some(netease::PlaylistIndex::fetch(&playlist_id)?);
        }
        index.as_ref().expect("上面刚填入").songs(page, size)
    })
}

// ─────────────────────────── pump ───────────────────────────

/// 一次 pump 的摘要(报告给 job/action 调用方)。
#[derive(Debug, Default)]
struct PumpReport {
    messages: Vec<String>,
    started: Vec<String>,
    completed: Vec<String>,
    failed: Vec<String>,
}

/// 按来源取直链(QQ 用 `level` 裁剪取链阶梯, 见 `qq::quality_ladder`)。
fn resolve_song_url(source: &str, song_id: &str, level: &str) -> Result<SongUrl, String> {
    match source {
        "netease" => netease::song_url(song_id, level),
        "qq" => qq::song_url(song_id, level),
        other => Err(format!("未知音乐源: {other}")),
    }
}

/// 扩展名兜底(取链没给 type 时按 flac, 与 sidecar 默认一致)。
fn normalize_ext(ext: &str) -> String {
    let ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if ext.is_empty() {
        "flac".to_string()
    } else {
        ext
    }
}

/// 失败处理: 尝试次数用尽 → 置 failed 并发通知; 否则回 queued 等下轮重试。
fn fail_task(settings: &Settings, task: &mut Task, error: String, report: &mut PumpReport) {
    task.error = error.clone();
    task.updated_ms = tasks::now_ms();
    task.job_ref.clear();
    if task.attempts >= MAX_ATTEMPTS {
        task.status = tasks::STATUS_FAILED.to_string();
        report.failed.push(task.id.clone());
        if settings.notify_on_fail {
            if let Err(err) = notify_failure(task, &error) {
                report.messages.push(format!("任务 {} 失败通知发送失败: {err}", task.id));
            }
        }
    } else {
        task.status = tasks::STATUS_QUEUED.to_string();
        report
            .messages
            .push(format!("任务 {} 第 {} 次尝试失败, 将重试: {error}", task.id, task.attempts));
    }
}

/// 启动一个排队任务: 取链接 → 立即提交宿主下载(sidecar 的 `startDownload`)。
fn start_task(
    settings: &Settings,
    parent_ref: &str,
    task: &mut Task,
    report: &mut PumpReport,
) {
    task.attempts = task.attempts.saturating_add(1);
    task.updated_ms = tasks::now_ms();
    let song = match resolve_song_url(&task.source, &task.song_id, &task.quality) {
        Ok(song) => song,
        Err(err) => {
            fail_task(settings, task, err, report);
            return;
        }
    };
    if song.url.is_empty() {
        fail_task(settings, task, "取链结果缺少直链".to_string(), report);
        return;
    }
    // 真实扩展名到手后再定名(入队时按 flac 兜底)。
    task.out_name = tasks::out_name(&task.singers, &task.name, &normalize_ext(&song.ext));
    let file_name = format!("{}.part", task.id);
    match stage_download(&task.id, parent_ref, &song.url, &file_name, task.attempts) {
        Ok(value) => {
            task.job_ref = value["job_ref"].as_str().unwrap_or("").to_string();
            task.status = tasks::STATUS_DOWNLOADING.to_string();
            task.error.clear();
            report.started.push(task.id.clone());
            report.messages.push(format!(
                "任务 {} 已提交宿主下载({} {})",
                task.id, task.source, song.level
            ));
        }
        Err(err) => fail_task(settings, task, err, report),
    }
}

/// 推进下载中的任务: 轮询 job, 成功后定名并立即尝试复制。
fn advance_downloading(
    settings: &Settings,
    staging: &str,
    task: &mut Task,
    report: &mut PumpReport,
) {
    if task.job_ref.is_empty() {
        fail_task(settings, task, "缺少 job_ref".to_string(), report);
        return;
    }
    let path = format!("{JOBS_PREFIX}{}", path_segment(&task.job_ref));
    let (status, body) = match host_roundtrip("GET", &path, None, None) {
        Ok(out) => out,
        Err(err) => {
            fail_task(settings, task, err, report);
            return;
        }
    };
    if !(200..300).contains(&status) {
        fail_task(settings, task, http_error("GET", &path, status, &body), report);
        return;
    }
    let value: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(err) => {
            fail_task(
                settings,
                task,
                format!("GET {JOBS_PREFIX}{} 响应不是 JSON: {err}", task.job_ref),
                report,
            );
            return;
        }
    };
    match job_state(&value) {
        JobState::Pending => {}
        JobState::Failed(error) => fail_task(settings, task, error, report),
        JobState::Succeeded => {
            let _ = staging;
            let staged = match job_result_path(&value).or_else(|| resolve_staged(&task.id)) {
                Some(path) => path,
                None => {
                    fail_task(
                        settings,
                        task,
                        "下载任务已完成但响应里没有文件路径".to_string(),
                        report,
                    );
                    return;
                }
            };
            task.staged_path = staged.clone();
            let target_name = task.out_name.clone();
            if file_name_of(&staged) != target_name {
                if let Err(err) =
                    rename_staged(&task.id, &staged, &target_name, task.attempts)
                {
                    fail_task(settings, task, err, report);
                    return;
                }
            }
            task.status = tasks::STATUS_COPYING.to_string();
            task.updated_ms = tasks::now_ms();
            task.error.clear();
            // 复制是同步调用, 当轮就把能做完的做完。
            advance_copying(settings, staging, task, report);
        }
    }
}

/// 推进待复制的任务: 把暂存文件复制进目标目录。
fn advance_copying(
    settings: &Settings,
    staging: &str,
    task: &mut Task,
    report: &mut PumpReport,
) {
    let _ = staging;
    if task.staged_path.is_empty() || task.out_name.is_empty() {
        fail_task(
            settings,
            task,
            "缺少暂存文件路径或目标文件名, 无法复制".to_string(),
            report,
        );
        return;
    }
    let staged = join_dir(&parent_dir(&task.staged_path), &task.out_name);
    match copy_to_cd2(&task.id, &staged, &settings.target_dir, task.attempts) {
        Ok(_) => {
            task.status = tasks::STATUS_DONE.to_string();
            task.job_ref.clear();
            task.error.clear();
            task.updated_ms = tasks::now_ms();
            report.completed.push(task.id.clone());
            // 0.3.10: 入库成功后清理工作区里该任务的全部暂存副本(含 (N) 去重残留)。
            let staged_note = task.staged_path.clone();
            match cleanup_staged(&task.id) {
                Ok(count) if count > 0 => report
                    .messages
                    .push(format!("任务 {} 完成: {}; 清理暂存 {count} 个", task.id, task.out_name)),
                _ => report
                    .messages
                    .push(format!("任务 {} 完成: {}", task.id, task.out_name)),
            }
            let _ = staged_note;
        }
        Err(err) => {
            // 复制失败只重试复制(暂存文件已定名), 不重新下载; 次数计入总尝试。
            task.attempts = task.attempts.saturating_add(1);
            task.error = err.clone();
            task.updated_ms = tasks::now_ms();
            task.job_ref.clear();
            if task.attempts >= MAX_ATTEMPTS {
                task.status = tasks::STATUS_FAILED.to_string();
                report.failed.push(task.id.clone());
                if settings.notify_on_fail {
                    if let Err(notify_err) = notify_failure(task, &err) {
                        report
                            .messages
                            .push(format!("任务 {} 失败通知发送失败: {notify_err}", task.id));
                    }
                }
            } else {
                task.status = tasks::STATUS_COPYING.to_string();
                report
                    .messages
                    .push(format!("任务 {} 复制失败, 将重试: {err}", task.id));
            }
        }
    }
}

/// 推进 KV 任务队列(状态机本体, 分片版)。
///
/// # 峰值内存(0.3.12 的全部意义)
///
/// 一次调用的常驻结构只有:
/// - `tasks.idx` 索引(<= 200 条紧凑条目, 且**不截断**存储的那份也可能更长);
/// - 在途任务(`downloading`/`copying`, 稳态 `<= settings.max_active`, 但轮询阶段
///   按索引条目逐条处理、**不按 `max_active` 截断**);
/// - **一首**歌的取链工作集(取链阶梯跑完立刻 drop)。
///
/// 与总队列长度**无关** —— 队列里 40 条已完结任务不会在一次 pump 里被读进内存。
///
/// # 顺序
/// 0. [`tasks::ensure_migrated`]: 旧键 `tasks` 还在就先拆成 `task.<id>` + `tasks.idx`;
/// 1. 轮询 `downloading` 的 job(便宜, 逐条处理; 条目数由索引决定, 不按 `max_active`
///    截断, 一旦某条收尾本轮即停);
/// 2. 收尾(定名/复制/清理)**最多 1 个任务**(done/failed): ①② 合计不产生第二个终态;
/// 3. 新开下载**最多 1 首**: 取链阶梯(eapi 最多 8 个请求)完整跑完、中间结构立刻
///    drop 之后才考虑下一首 —— 这是 OOM 的主因(旧实现一轮里能同时持有多首的
///    eapi 响应体)。
///
/// 每一类工作都在**独立作用域**里处理单条任务, 处理完 `Task`/`Value`/`Vec` 立即释放。
///
/// 返回摘要 `{staging_dir, staging_error, queued, active, started, completed, failed, messages}`。
///
/// 0.3.15: 与 [`request_download`]/[`playlist_queue_all`] 共用"队列操作"互斥
/// (见 `QUEUE_OP_RUNNING` 注释) —— 已有队列操作在跑时本次**直接跳过**, 不排队等待。
/// 每轮把各阶段的内存采样写进 `pumpdiag.mem_kb`(start/after_index/after_poll/
/// after_start/after_finish/end), 真机上"哪个阶段把内存推到多少"有据可查。
pub fn pump(ids: &mut PutIds) -> Result<Value, String> {
    let Some(_guard) = try_begin_queue_op() else {
        return Ok(queue_busy_value("上一轮队列推进仍在进行, 本次跳过, 请稍后再试"));
    };
    // 阶段探针(0.3.15): 每个大步骤后采样一次线性内存(KB)。非 wasm(测试)目标恒 0;
    // 值全部送进末尾的 `pumpdiag.mem_kb`。各变量都在对应阶段无条件赋值。
    let mem_start = wasm_memory_kb();
    let mem_after_index: u64;
    let mem_after_poll: u64;
    let mem_after_finish: u64;
    let mem_after_start: u64;
    // 首读索引时的排队条数(诊断用; 索引此时尚未被本轮改动)。
    let queue_len_at_start: usize;
    // ① 迁移(幂等: 已分片则零成本返回 0)。
    tasks::ensure_migrated(ids)?;

    let settings = load_settings();
    let probe = probe_roots();
    let mut report = PumpReport::default();
    let mut staging_error = String::new();
    let staging: Option<String> = if probe.ok {
        let (effective, warnings) = effective_staging(&settings, &probe);
        report.messages.extend(warnings);
        effective
    } else {
        staging_error = format!("本地根探测失败: {}", probe.error);
        None
    };

    // ② 轮询在途下载: 逐条处理, **不按 max_active 截断**(条目数由索引里的
    //    `downloading` 条目决定; `max_active` 只用于第 ④ 步"是否新开一首")。
    // ③ 收尾最多 1 个任务(done/failed); ②③ 合计不超过 1 个终态。
    //    ②③ 共用**一次**索引读: 这里的 id 列表 = 索引里在途 + 待收尾的条目,
    //    与队列总长无关。
    {
        let index = tasks::load_index();
        queue_len_at_start =
            index.iter().filter(|entry| entry.status == tasks::STATUS_QUEUED).count();
        let downloading: Vec<String> = index
            .iter()
            .filter(|entry| entry.status == tasks::STATUS_DOWNLOADING)
            .map(|entry| entry.id.clone())
            .collect();
        let copying: Vec<String> = index
            .iter()
            .filter(|entry| entry.status == tasks::STATUS_COPYING)
            .map(|entry| entry.id.clone())
            .collect();
        // 「读索引后」: 索引 + 两个 id 列表都在内存里时的读数。
        mem_after_index = wasm_memory_kb();
        // 门禁「一次 pump 最多收尾 1 个」: 逐条轮询, 一旦本轮已有任务进入终态
        // (done/failed)就停手, 其余在途条目下一轮再轮。否则多个在途 job 同轮
        // 成功会在这一轮里收尾多个。
        for task_id in &downloading {
            step_one_downloading(ids, &settings, task_id, &mut report);
            if finalized_count(&report) > 0 {
                break;
            }
        }
        // 「在途轮询后」: 轮询(可能已有一条任务推进到 copying/done/failed)之后的读数。
        mem_after_poll = wasm_memory_kb();
        // 同上: ② 已经收尾过一个, 就不再收尾 copying; 只有 ② 颗粒无收时才动手。
        if finalized_count(&report) == 0 {
            if let Some(task_id) = copying.first() {
                step_one_copying(ids, &settings, task_id, &mut report);
            }
        }
        // 「收尾一个后」: 收尾阶段(本轮最多 1 个任务, 可能一个都没有)结束时的读数。
        mem_after_finish = wasm_memory_kb();
    }

    // ④ 新开下载最多 1 首。
    //    索引在这里**重新读一次**: ②③ 已经落盘了状态变化, 槽位判断必须用最新值。
    //    一次读同时算出排队数/在途数/下一个候选(省 2 次 GET)。
    {
        let index = tasks::load_index();
        let queued_count = index.iter().filter(|e| e.status == tasks::STATUS_QUEUED).count();
        let active = index
            .iter()
            .filter(|e| matches!(e.status.as_str(), tasks::STATUS_DOWNLOADING | tasks::STATUS_COPYING))
            .count();
        let next_queued = index
            .iter()
            .find(|e| e.status == tasks::STATUS_QUEUED)
            .map(|e| e.id.clone());
        if queued_count > 0 {
            match staging.as_deref() {
                None => {
                    let reason = if staging_error.is_empty() {
                        "暂存目录不可用".to_string()
                    } else {
                        staging_error.clone()
                    };
                    report.messages.push(format!("{queued_count} 个排队任务无法启动: {reason}"));
                }
                Some(_) => match workspace_parent_ref(&probe) {
                    Ok(parent_ref) => {
                        let cap = settings.max_active.max(1) as usize;
                        if active < cap {
                            if let Some(task_id) = next_queued {
                                // 本轮已收尾过就别再新开 ---- 新开的下载若宿主 job
                                // 当轮完成, step_one_start 的即时轮询会把它也收尾,
                                // 一轮就变成 2 个终态。
                                let already_finalized = finalized_count(&report) > 0;
                                step_one_start(
                                    ids,
                                    &settings,
                                    &parent_ref,
                                    &task_id,
                                    &mut report,
                                    already_finalized,
                                );
                            }
                        } else {
                            report
                                .messages
                                .push(format!("{queued_count} 个排队任务等待槽位({active}/{cap})"));
                        }
                    }
                    Err(err) => {
                        let reason = format!("宿主工作区根不可用: {err}");
                        // 阻塞原因只落到**索引**里排队任务的那一条 error(不整队加载)。
                        mark_queued_error(ids, &reason, &mut report);
                    }
                },
            }
        }
        // 「新开一首后」: ④ 阶段(本轮可能没有新开)结束时的读数。
        mem_after_start = wasm_memory_kb();
    }

    let diag = json!({
        "at": clock::now_rfc3339(),
        // 阶段内存探针(0.3.15, 单位 KB): 见 pump 开头各赋值处的采样点注释。
        // `manifest_cap_kb` 是 manifest `memory_mb`(=128MB)换算的上限, 只读展示。
        "mem_kb": {
            "start": mem_start,
            "after_index": mem_after_index,
            "after_poll": mem_after_poll,
            "after_start": mem_after_start,
            "after_finish": mem_after_finish,
            "end": wasm_memory_kb(),
            "manifest_cap_kb": 128 * 1024,
        },
        "queue": {
            "idx": queue_len_at_start,
        },
        "staging_dir": staging,
        "roots_raw_b64": DIAG_ROOTS_RAW.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone(),
        "entries_status": DIAG_ENTRIES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).0,
        "entries_body_b64": DIAG_ENTRIES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).1.clone(),
        "messages": report.messages,
    });
    if let Err(err) = store::put_json(ids, "pumpdiag", &diag) {
        report.messages.push(format!("pumpdiag 写入失败: {err}"));
    }

    // 摘要里的排队/在途计数从索引重算(索引已经是最新状态)。
    let index = tasks::load_index();
    let queued = index.iter().filter(|e| e.status == tasks::STATUS_QUEUED).count();
    let active = index
        .iter()
        .filter(|e| matches!(e.status.as_str(), tasks::STATUS_DOWNLOADING | tasks::STATUS_COPYING))
        .count();

    Ok(json!({
        "staging_dir": staging,
        "staging_error": staging_error,
        "queued": queued,
        "active": active,
        "started": report.started,
        "completed": report.completed,
        "failed": report.failed,
        "messages": report.messages,
    }))
}

/// 把"暂存/工作区根不可用"写进**排队任务**的索引条目, 让 UI 不再只看到干等的 queued。
///
/// **上界(0.3.12 内存审计)**: `reason` 来自 [`workspace_parent_ref`], 内含宿主
/// 返回的**全部** roots 摘要(逐条 `alias(backend)`, 见该函数的 `seen`), 长度由宿主
/// 决定而与队列长度无关。这里若原样写进**每一条**排队条目, 索引体积会变成
/// `排队条数 × reason 长度` —— 正是分片要消灭的那种"随队列膨胀"的驻留。
/// 因此按 [`tasks::IDX_ERROR_LIMIT`] 截断, 与 [`tasks::TaskIndexEntry::of`]
/// 投影完整记录时用的同一个上限, 索引条目大小重新变成常数。
fn mark_queued_error(ids: &mut PutIds, reason: &str, report: &mut PumpReport) {
    let mut index = tasks::load_index();
    let short = util::trunc_to(reason.as_bytes(), tasks::IDX_ERROR_LIMIT);
    let mut touched = 0usize;
    for entry in index.iter_mut() {
        if entry.status == tasks::STATUS_QUEUED && entry.error != short {
            entry.error = short.clone();
            entry.updated_ms = tasks::now_ms();
            touched += 1;
        }
    }
    if touched > 0 {
        if let Err(err) = tasks::save_index(ids, &index) {
            report.messages.push(format!("阻塞原因写回失败: {err}"));
        }
    }
    report.messages.push(reason.to_string());
}

/// 单任务作用域: 轮询一条 `downloading`。读 → 推进 → 落盘 → 释放。
fn step_one_downloading(ids: &mut PutIds, settings: &Settings, task_id: &str, report: &mut PumpReport) {
    let Some(mut task) = tasks::load_task(task_id) else { return };
    if task.status != tasks::STATUS_DOWNLOADING {
        return; // 上一轮已把它推进到别的状态
    }
    {
        let mut local = PumpReport::default();
        advance_downloading(settings, "", &mut task, &mut local);
        merge(report, local);
    }
    if let Err(err) = tasks::persist_task(ids, &task) {
        report.messages.push(format!("任务 {task_id} 落盘失败: {err}"));
    }
    // `task` 在函数返回时释放, 不进任何长生命周期容器。
}

/// 单任务作用域: 收尾一条 `copying`(定名后复制入库 + 清理暂存)。
fn step_one_copying(ids: &mut PutIds, settings: &Settings, task_id: &str, report: &mut PumpReport) {
    let Some(mut task) = tasks::load_task(task_id) else { return };
    if task.status != tasks::STATUS_COPYING {
        return;
    }
    {
        let mut local = PumpReport::default();
        advance_copying(settings, "", &mut task, &mut local);
        merge(report, local);
    }
    if let Err(err) = tasks::persist_task(ids, &task) {
        report.messages.push(format!("任务 {task_id} 落盘失败: {err}"));
    }
}

/// 单任务作用域: 新开**一首**下载。取链阶梯完整跑完、中间结构立即释放。
///
/// `already_finalized` 为真表示本轮已有任务收尾(done/failed) —— 此时只提交下载,
/// **不做**即时轮询, 保证「一次 pump 最多收尾 1 个」(门禁 3)。即时轮询只在
/// 本轮尚无收尾时进行, 让常见的"宿主 job 当轮即成功"仍能一轮走完。
fn step_one_start(
    ids: &mut PutIds,
    settings: &Settings,
    parent_ref: &str,
    task_id: &str,
    report: &mut PumpReport,
    already_finalized: bool,
) {
    let Some(mut task) = tasks::load_task(task_id) else { return };
    if task.status != tasks::STATUS_QUEUED {
        return;
    }
    {
        let mut local = PumpReport::default();
        start_task(settings, parent_ref, &mut task, &mut local);
        merge(report, local);
        if task.status == tasks::STATUS_DOWNLOADING && !already_finalized {
            // 取链后立即轮询一次: 宿主任务可能本轮就完成(这是"单曲"范围内的工作集)。
            let mut local2 = PumpReport::default();
            advance_downloading(settings, "", &mut task, &mut local2);
            merge(report, local2);
        }
    }
    if let Err(err) = tasks::persist_task(ids, &task) {
        report.messages.push(format!("任务 {task_id} 落盘失败: {err}"));
    }
}

/// 本轮进入终态(done/failed)的任务数。
///
/// `completed`/`failed` 只在任务**真正收尾**时被 push(复制重试、排队失败都不算),
/// 因此这是门禁「一次 pump 最多收尾 1 个」的直接度量。
fn finalized_count(report: &PumpReport) -> usize {
    report.completed.len() + report.failed.len()
}

/// 把单任务作用域里产生的摘要并进本轮摘要。
fn merge(into: &mut PumpReport, from: PumpReport) {
    into.messages.extend(from.messages);
    into.started.extend(from.started);
    into.completed.extend(from.completed);
    into.failed.extend(from.failed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::{HostCallRequest, HostCallResponse, HostError};
    use base64::Engine as _;
    use std::cell::RefCell;
    use std::collections::{BTreeMap, BTreeSet, HashMap};
    use std::rc::Rc;

    /// 整单入队测试的整单曲目数: 1000 首 = 10 页(每页 100)。
    const PLAYLIST_TEST_TRACKS: usize = 1000;

    /// 宿主会拒绝包含绝对路径字符串的整个 state 响应: settings 视图必须无开头 "/",
    /// 且 settings-update 能把无斜杠输入还原回绝对路径(往返一致)。
    #[test]
    fn settings_path_view_has_no_leading_slash_and_roundtrips() {
        let mut settings = Settings::default();
        settings.staging_dir = "/media/music-dl-staging".to_string();
        settings.target_dir = "/CloudNAS/115open/音乐/音乐下载".to_string();
        let view = settings_view(&settings);
        assert_eq!(view["staging_dir"], "media/music-dl-staging");
        assert_eq!(view["target_dir"], "CloudNAS/115open/音乐/音乐下载");
        assert_eq!(normalize_path("CloudNAS/115open/音乐/音乐下载"), settings.target_dir);
        assert_eq!(normalize_path("/CloudNAS/115open/音乐/音乐下载"), settings.target_dir);
        assert_eq!(normalize_path("  "), "");
        // 兜底清洗: 任何以 "/" 开头的字符串(如任务 error/日志里整串就是路径)必须被清空;
        // "//" 开头与路径只出现在中间的不受影响(与 douban-rs 同一宿主规则)。
        let dirty = serde_json::json!({"error": "/media/a.part", "keep": "//scheme", "msg": "copy /media/a.part 失败", "n": 1});
        let clean = crate::runtime::sanitize_state(dirty);
        assert_eq!(clean["error"], "");
        assert_eq!(clean["keep"], "//scheme");
        assert_eq!(clean["msg"], "copy /media/a.part 失败");
        assert_eq!(clean["n"], 1);
    }

    /// 假宿主的 job 结局。
    #[derive(Debug, Clone)]
    enum JobOutcome {
        Succeeded,
        Failed(String),
    }

    /// 假宿主记录下来的请求/状态。
    #[derive(Debug, Default)]
    struct FakeHost {
        kv: HashMap<String, (Vec<u8>, u64)>,
        entries_calls: usize,
        created_dir: bool,
        staged_name: String,
        job_status: String,
        job_error: String,
        downloads: Vec<Value>,
        renames: Vec<Value>,
        copies: Vec<Value>,
        notifications: Vec<Value>,
        write_keys: Vec<(String, String)>,
        /// 读过的**单条完整任务记录**(`task.<id>`)的键与字节数 —— 用来直接量
        /// 「一次 pump 把多少完整记录搬进了内存」(0.3.12 的核心指标)。
        task_reads: Vec<(String, usize)>,
        /// 整单入队链路的网易请求计数: v6 全量索引 与 v3 当页详情。
        /// 0.3.15 起 1000 首整批应为 1 次 v6 + 每页 1 次 v3。
        playlist_v6_calls: usize,
        playlist_v3_ids: Vec<Vec<i64>>,
    }

    fn json_response(status: i32, body: &[u8]) -> Result<HostCallResponse, HostError> {
        Ok(HostCallResponse {
            status,
            headers: BTreeMap::new(),
            body_base64: base64::engine::general_purpose::STANDARD_NO_PAD.encode(body),
        })
    }

    /// 请求体的原始字节(生产 POST 用带 padding 的 StdEncoding, 两种都容错解码;
    /// `request_body` 只适合 JSON 体, 表单体要走这里)。
    fn request_bytes(request: &HostCallRequest) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(&request.body_base64)
            .or_else(|_| {
                base64::engine::general_purpose::STANDARD_NO_PAD.decode(&request.body_base64)
            })
            .unwrap_or_default()
    }

    /// 从 v3 请求表单 `c=..&ids=[1,2,..]` 里取出当页 id 列表。
    fn form_ids(form: &str) -> Vec<i64> {
        form.split("&ids=[")
            .nth(1)
            .unwrap_or("")
            .split(']')
            .next()
            .unwrap_or("")
            .split(',')
            .filter_map(|text| text.trim().parse::<i64>().ok())
            .collect()
    }

    /// v6 `playlist/detail` 的固定索引: `0..track_count-1` 的全量 trackIds。
    fn playlist_index_body(track_count: usize) -> Vec<u8> {
        let ids: Vec<Value> = (0..track_count).map(|id| json!({ "id": id })).collect();
        serde_json::to_vec(&json!({
            "playlist": {"name": "大歌单", "trackCount": track_count, "trackIds": ids},
        }))
        .unwrap()
    }

    fn request_body(request: &HostCallRequest) -> Value {
        if request.body_base64.is_empty() {
            return Value::Null;
        }
        let raw = base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(&request.body_base64)
            .unwrap_or_default();
        serde_json::from_slice(&raw).unwrap_or(Value::Null)
    }

    fn kv_response(state: &mut FakeHost, request: &HostCallRequest, key: &str) -> Result<HostCallResponse, HostError> {
        match request.method.as_str() {
            "GET" => match state.kv.get(key).cloned() {
                Some((value, revision)) => Ok(HostCallResponse {
                    status: 200,
                    headers: etag_headers(revision),
                    body_base64: base64::engine::general_purpose::STANDARD_NO_PAD.encode(&value),
                }),
                None => Ok(HostCallResponse { status: 404, ..HostCallResponse::default() }),
            },
            "PUT" => {
                let idem = request.headers.get("idempotency-key").cloned().unwrap_or_default();
                if !(16..=128).contains(&idem.len())
                    || !idem.bytes().all(|byte| byte.is_ascii_graphic())
                {
                    return json_response(400, br#"{"error":"bad idempotency key"}"#);
                }
                let parsed = request_body(request);
                let value = serde_json::to_vec(&parsed["value"]).unwrap_or_default();
                let current = state.kv.get(key).cloned();
                if let Some(if_match) = request.headers.get("if-match") {
                    let matches = match &current {
                        Some((_, revision)) => if_match == &format!("\"pkv_{revision}\""),
                        None => false,
                    };
                    if !matches {
                        return Ok(HostCallResponse { status: 412, ..HostCallResponse::default() });
                    }
                }
                let revision = current.map(|(_, revision)| revision).unwrap_or(0) + 1;
                state.kv.insert(key.to_string(), (value, revision));
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
                    return json_response(400, br#"{"error":"bad idempotency key"}"#);
                }
                let existed = state.kv.remove(key).is_some();
                Ok(HostCallResponse { status: if existed { 200 } else { 404 }, ..HostCallResponse::default() })
            }
            other => Err(HostError::new(format!("unexpected KV method: {other}"))),
        }
    }

    fn etag_headers(revision: u64) -> BTreeMap<String, Vec<String>> {
        let mut headers = BTreeMap::new();
        headers.insert("ETag".to_string(), vec![format!("\"pkv_{revision}\"")]);
        headers
    }

    /// 装一个假宿主: 本地根 + 暂存目录初次 404 + 网易取链 + job 结局可配置。
    fn install_pipeline_host(outcome: JobOutcome) -> Rc<RefCell<FakeHost>> {
        let state = Rc::new(RefCell::new(FakeHost {
            job_status: match &outcome {
                JobOutcome::Succeeded => "succeeded".to_string(),
                JobOutcome::Failed(_) => "failed".to_string(),
            },
            job_error: match &outcome {
                JobOutcome::Failed(message) => message.clone(),
                JobOutcome::Succeeded => String::new(),
            },
            ..FakeHost::default()
        }));
        let shared = state.clone();
        crate::host::testhost::install(Box::new(move |request: &HostCallRequest| {
            let method = request.method.clone();
            let path = request.path.clone();
            let body = request_body(request);
            let mut state = shared.borrow_mut();
            if method != "GET" {
                if let Some(key) = request.headers.get("idempotency-key") {
                    state.write_keys.push((format!("{method} {path}"), key.clone()));
                }
            }
            if let Some(key) = path.strip_prefix("/api/plugin-runtime/storage/") {
                // 量"搬进内存的完整任务记录"总量: 只统计 `task.<id>` 的读取。
                if method == "GET" && key.starts_with(tasks::TASK_KEY_PREFIX) {
                    let size = state.kv.get(key).map(|(bytes, _)| bytes.len()).unwrap_or(0);
                    state.task_reads.push((key.to_string(), size));
                }
                return kv_response(&mut state, request, key);
            }
            // 网易 eapi 取链: 只解响应, 不校验加密请求。
            if path.starts_with("https://interface3.music.163.com/") {
                return json_response(
                    200,
                    br#"{"data":[{"url":"https://cdn.example.com/song.flac","type":"flac","level":"lossless","size":1024}]}"#,
                );
            }
            // 网易歌单链路(整单入队): v6 detail 回全量索引, v3 song/detail 按当页 ids 回详情。
            if method == "GET" && path.starts_with(netease::PLAYLIST_DETAIL_URL) {
                state.playlist_v6_calls += 1;
                return json_response(200, &playlist_index_body(PLAYLIST_TEST_TRACKS));
            }
            if method == "POST" && path == netease::SONG_DETAIL_URL {
                let ids = form_ids(&String::from_utf8_lossy(&request_bytes(request)));
                state.playlist_v3_ids.push(ids.clone());
                let songs: Vec<Value> = ids
                    .iter()
                    .map(|id| {
                        json!({"id": id, "name": format!("歌{id}"), "singers": "歌手", "album": "专辑"})
                    })
                    .collect();
                return json_response(200, &serde_json::to_vec(&json!({ "songs": songs })).unwrap());
            }
            if path == FILES_ROOTS {
                // 0.3.8: 换成宿主真实形状(data.items[] + root_id/root_entry_ref/capabilities)。
                return json_response(
                    200,
                    br#"{"data":{"items":[
                        {"root_id":"root_test_ws","alias":"ai_workspace","root_entry_ref":"fe_test_ws_root","name":"AI workspace","backend":"local","capabilities":["files.local.read","files.local.write"]},
                        {"root_id":"root_test_cd2","alias":"cloud","root_entry_ref":"fe_test_cd2","name":"CD2","backend":"cd2","capabilities":["files.cloud.read"]}
                    ]}}"#,
                );
            }
            if path.starts_with(FILES_ENTRIES) {
                state.entries_calls += 1;
                if !state.created_dir {
                    return Ok(HostCallResponse { status: 404, ..HostCallResponse::default() });
                }
                return json_response(200, br#"{"parent_ref":"dir-ref-7","entries":[]}"#);
            }
            if path == FILES_DIRECTORIES {
                state.created_dir = true;
                return json_response(200, br#"{"success":true}"#);
            }
            if path == FILES_DOWNLOADS {
                state.staged_name = body["name"].as_str().unwrap_or("").to_string();
                state.downloads.push(body);
                return json_response(200, br#"{"job_ref":"job-1"}"#);
            }
            if path.starts_with(JOBS_PREFIX) {
                if state.job_status == "succeeded" {
                    let staged = format!(
                        "/CloudNAS/115open/音乐/音乐下载/{}",
                        state.staged_name
                    );
                    let payload = json!({"status": "succeeded", "result": {"path": staged}});
                    return json_response(200, &serde_json::to_vec(&payload).unwrap());
                }
                let payload = json!({"status": "failed", "error": state.job_error});
                return json_response(200, &serde_json::to_vec(&payload).unwrap());
            }
            if path == LOCAL_RENAME {
                state.renames.push(body);
                return json_response(200, br#"{"success":true}"#);
            }
            if path == LOCAL_COPY {
                state.copies.push(body);
                return json_response(200, br#"{"success":true}"#);
            }
            if path == NOTIFY_PLUGIN {
                state.notifications.push(body);
                return json_response(202, br#"{"data":{},"meta":{}}"#);
            }
            Err(HostError::new(format!("unexpected host call: {method} {path}")))
        }));
        state
    }

    fn download_request() -> DownloadRequest {
        DownloadRequest {
            source: "netease".to_string(),
            song_id: "123".to_string(),
            name: "晴天".to_string(),
            singers: "周杰伦".to_string(),
            album: "叶惠美".to_string(),
            level: String::new(),
        }
    }

    // ─────────────── playlist-queue-all (0.3.14) ───────────────

    /// 造一页 `playlist_songs` 形状的返回: `ids` 每首一个歌曲对象。
    /// `total` 是**整个歌单**的曲目数(页接口每页恒带, 是取尽判定的权威字段),
    /// 不是当页条数——当页可以因 `song/detail` 少返而不足 `ids` 应给出的数量。
    fn songs_page(total: usize, ids: &[String]) -> Value {
        let songs: Vec<Value> = ids
            .iter()
            .map(|id| {
                json!({
                    "id": id,
                    "name": format!("歌{id}"),
                    "singers": "歌手",
                    "album": "专辑",
                    "source": "netease",
                })
            })
            .collect();
        json!({"name": "歌单", "total": total, "page": 1, "page_size": 100, "songs": songs})
    }

    /// 顺序 id 列表(`prefix` + 序号), 用来凑满页(100 首触发继续翻页)。
    fn ids_range(prefix: &str, count: usize) -> Vec<String> {
        (0..count).map(|index| format!("{prefix}{index}")).collect()
    }

    /// 整批入队走到"取尽"(末页不满 100 首): 计数正确、`has_more=false`。
    #[test]
    fn playlist_queue_all_pages_until_exhausted() {
        let _fake = install_pipeline_host(JobOutcome::Succeeded);
        let mut ids = PutIds::new();
        let pages = vec![
            songs_page(230, &ids_range("a", 100)),
            songs_page(230, &ids_range("b", 100)),
            songs_page(230, &ids_range("c", 30)),
        ];
        let result = queue_playlist_pages(&mut ids, "netease", "lossless", 1, 5, |page, _size| {
            Ok(pages[(page - 1) as usize].clone())
        });
        assert_eq!(result["status"], "succeeded");
        assert_eq!(result["data"]["queued"], 230);
        assert_eq!(result["data"]["deduped"], 0);
        assert_eq!(result["data"]["total_seen"], 230);
        assert_eq!(result["data"]["skipped"], 0);
        assert_eq!(result["data"]["next_page"], 4);
        assert_eq!(result["data"]["has_more"], false);
        // 每首都落了分片(不回滚/不丢)。
        assert_eq!(tasks::load_index().len(), 230);
    }

    /// 去重沿用索引路径: 跨页重复的歌算 `deduped`, 不重复建任务。
    #[test]
    fn playlist_queue_all_dedupes_repeat_across_pages() {
        let _fake = install_pipeline_host(JobOutcome::Succeeded);
        let mut ids = PutIds::new();
        let first = ids_range("a", 100);
        // 第二页只有 1 首, 且与第一页第 0 首重复; 不满 100 → 取尽。
        let pages = vec![songs_page(101, &first), songs_page(101, &[first[0].clone()])];
        let result = queue_playlist_pages(&mut ids, "netease", "lossless", 1, 5, |page, _size| {
            Ok(pages[(page - 1) as usize].clone())
        });
        assert_eq!(result["status"], "succeeded");
        assert_eq!(result["data"]["queued"], 100, "跨页重复不该新建: {result}");
        assert_eq!(result["data"]["deduped"], 1);
        assert_eq!(result["data"]["total_seen"], 101);
        assert_eq!(result["data"]["has_more"], false);
        assert_eq!(tasks::load_index().len(), 100);
    }

    /// 满 `batch_pages` 页且末页仍是满页: `has_more=true`, `next_page` 指向下一批起点。
    #[test]
    fn playlist_queue_all_stops_at_batch_pages() {
        let _fake = install_pipeline_host(JobOutcome::Succeeded);
        let mut ids = PutIds::new();
        let pages = vec![
            songs_page(300, &ids_range("a", 100)),
            songs_page(300, &ids_range("b", 100)),
            songs_page(300, &ids_range("c", 100)),
        ];
        let result = queue_playlist_pages(&mut ids, "netease", "lossless", 1, 2, |page, _size| {
            Ok(pages[(page - 1) as usize].clone())
        });
        assert_eq!(result["status"], "succeeded");
        assert_eq!(result["data"]["queued"], 200, "只处理参数给定的 2 页");
        assert_eq!(result["data"]["next_page"], 3);
        assert_eq!(result["data"]["has_more"], true);
        assert_eq!(tasks::load_index().len(), 200);
    }

    /// 续批游标: 7 页歌单 + `batch_pages=5`, 第一批返回 `next_page=6/has_more=true`;
    /// 带 `next_page=6` 续跑能取到尾页(7), 且**不会重复入队**前 5 页。
    #[test]
    fn playlist_queue_all_resumes_from_next_page_without_duplicates() {
        let _fake = install_pipeline_host(JobOutcome::Succeeded);
        let mut ids = PutIds::new();
        // 7 页: 前 6 页满 100, 尾页 30(<100 → 取尽)。
        let pages: Vec<Value> = (1..=6)
            .map(|page| songs_page(630, &ids_range(&format!("p{page}-"), 100)))
            .chain(std::iter::once(songs_page(630, &ids_range("p7-", 30))))
            .collect();
        let fetch = |page: u32, _size: u32| Ok(pages[(page - 1) as usize].clone());

        // 第一批: 从第 1 页起处理 5 页, 末页仍是满页 → 交还续批游标 6。
        let first = queue_playlist_pages(&mut ids, "netease", "lossless", 1, 5, fetch);
        assert_eq!(first["status"], "succeeded");
        assert_eq!(first["data"]["queued"], 500, "只处理第 1~5 页: {first}");
        assert_eq!(first["data"]["next_page"], 6);
        assert_eq!(first["data"]["has_more"], true);
        assert_eq!(tasks::load_index().len(), 500);

        // 第二批: 从返回的 next_page=6 续跑, 取到第 6 页(满)、第 7 页(30, 取尽)。
        let second = queue_playlist_pages(&mut ids, "netease", "lossless", 6, 5, fetch);
        assert_eq!(second["status"], "succeeded");
        assert_eq!(second["data"]["queued"], 130, "第 6~7 页: {second}");
        assert_eq!(second["data"]["total_seen"], 130);
        assert_eq!(second["data"]["deduped"], 0, "续跑不碰已入队的前 5 页");
        assert_eq!(second["data"]["next_page"], 8);
        assert_eq!(second["data"]["has_more"], false);

        // 全量 630 首, 且第一页那首只出现一次(续跑没有重复入队)。
        let index = tasks::load_index();
        assert_eq!(index.len(), 630);
        assert_eq!(index.iter().filter(|entry| entry.song_id == "p1-0").count(), 1);
        assert_eq!(index.iter().filter(|entry| entry.song_id == "p7-29").count(), 1);
    }

    /// 回归(满页少返, 下架/无版权/无效 id): 当页因 `song/detail` 少返只剩 97 首, 但
    /// `total`(整单 300 首)表明后面还有页 —— 不能把 97 < 100 误判成取尽, 必须继续翻到第 3 页。
    #[test]
    fn playlist_queue_all_full_page_with_short_songs_keeps_paging() {
        let _fake = install_pipeline_host(JobOutcome::Succeeded);
        let mut ids = PutIds::new();
        // 整单 300 首: 第 1、2 页本该各 100, 第 2 页因无效 id 只回 97; 第 3 页是尾页 100。
        let pages = vec![
            songs_page(300, &ids_range("a", 100)),
            songs_page(300, &ids_range("b", 97)),
            songs_page(300, &ids_range("c", 100)),
        ];
        let result = queue_playlist_pages(&mut ids, "netease", "lossless", 1, 5, |page, _size| {
            Ok(pages[(page - 1) as usize].clone())
        });
        assert_eq!(result["status"], "succeeded");
        assert_eq!(result["data"]["total_seen"], 297, "第 2 页少返的 3 首不该截断后续页: {result}");
        assert_eq!(result["data"]["queued"], 297);
        assert_eq!(result["data"]["next_page"], 4);
        assert_eq!(result["data"]["has_more"], false, "page 3 覆盖 300 首即整单末尾");
        // 第 3 页确实入了队(97 < 100 未被误判为取尽)。
        let index = tasks::load_index();
        assert_eq!(index.len(), 297);
        assert_eq!(index.iter().filter(|entry| entry.song_id == "c99").count(), 1);
    }

    /// `total` 缺失(旧接口/异常返回)才退回当页条数判定: 不满 100 首即视为取尽。
    #[test]
    fn playlist_queue_all_without_total_falls_back_to_page_size() {
        let _fake = install_pipeline_host(JobOutcome::Succeeded);
        let mut ids = PutIds::new();
        // 无 `total` 字段, 每页 100 首: 翻满 batch_pages 后交还续批游标。
        let result = queue_playlist_pages(&mut ids, "netease", "lossless", 1, 2, |page, _size| {
            let songs: Vec<Value> = ids_range(&format!("p{page}-"), 100)
                .iter()
                .map(|id| json!({"id": id, "name": "歌", "singers": "s", "album": "al"}))
                .collect();
            Ok(json!({"name": "歌单", "page": page, "page_size": 100, "songs": songs}))
        });
        assert_eq!(result["data"]["queued"], 200);
        assert_eq!(result["data"]["next_page"], 3);
        assert_eq!(result["data"]["has_more"], true, "无 total: 满页应继续翻: {result}");
    }

    /// 页面接口失败: **业务 failed**(不是协议错误), 回传已入队计数与失败页号, 不回滚。
    #[test]
    fn playlist_queue_all_page_error_returns_partial() {
        let _fake = install_pipeline_host(JobOutcome::Succeeded);
        let mut ids = PutIds::new();
        let result = queue_playlist_pages(&mut ids, "netease", "lossless", 1, 5, |page, _size| {
            if page == 2 {
                return Err("network boom".to_string());
            }
            Ok(songs_page(200, &ids_range("a", 100)))
        });
        assert_eq!(result["status"], "failed", "页面失败是业务 failed: {result}");
        assert!(result["message"].as_str().unwrap().contains("第 2 页"), "{result}");
        assert_eq!(result["data"]["queued"], 100);
        assert_eq!(result["data"]["total_seen"], 100);
        assert_eq!(result["data"]["next_page"], 2, "失败页号即下次续跑起点");
        assert_eq!(result["data"]["has_more"], true);
        // 已入队的 100 首不因后面的失败回滚。
        assert_eq!(tasks::load_index().len(), 100);
    }

    /// 入参校验: 非网易云来源 / 缺歌单 id 都是业务 failed, 且不发任何网络请求
    /// (wrapper 在调 `netease::playlist_songs` 前就返回)。
    #[test]
    fn playlist_queue_all_validates_input() {
        let _fake = install_pipeline_host(JobOutcome::Succeeded);
        let mut ids = PutIds::new();
        let qq = playlist_queue_all(
            &mut ids,
            &PlaylistQueueRequest {
                source: "qq".to_string(),
                playlist_id: "42".to_string(),
                quality: "lossless".to_string(),
                batch_pages: 5,
                next_page: 1,
            },
        );
        assert_eq!(qq["status"], "failed");
        assert!(qq["message"].as_str().unwrap().contains("暂不支持歌单"), "{qq}");

        let missing = playlist_queue_all(
            &mut ids,
            &PlaylistQueueRequest {
                source: "netease".to_string(),
                playlist_id: "  ".to_string(),
                quality: "lossless".to_string(),
                batch_pages: 5,
                next_page: 1,
            },
        );
        assert_eq!(missing["status"], "failed");
        assert!(missing["message"].as_str().unwrap().contains("缺少歌单 id"), "{missing}");
        assert_eq!(tasks::load_index().len(), 0);
    }

    /// 0.3.15: 1000 首整单(10 页)只 GET 一次 v6 全量索引, 之后各页纯本地切片;
    /// 第 10 页取 900..999, v3 详情每页一次; 内存探针仍逐页记录。
    #[test]
    fn playlist_queue_all_fetches_v6_index_once_for_all_pages() {
        let fake = install_pipeline_host(JobOutcome::Succeeded);
        let mut ids = PutIds::new();
        let result = playlist_queue_all(
            &mut ids,
            &PlaylistQueueRequest {
                source: "netease".to_string(),
                playlist_id: "42".to_string(),
                quality: "lossless".to_string(),
                batch_pages: 10,
                next_page: 1,
            },
        );
        assert_eq!(result["status"], "succeeded", "{result}");
        assert_eq!(result["data"]["queued"], 1000);
        assert_eq!(result["data"]["total_seen"], 1000);
        assert_eq!(result["data"]["deduped"], 0);
        assert_eq!(result["data"]["next_page"], 11);
        assert_eq!(result["data"]["has_more"], false);

        {
            let state = fake.borrow();
            assert_eq!(state.playlist_v6_calls, 1, "v6 全量索引整批只请求一次: {result}");
            assert_eq!(state.playlist_v3_ids.len(), 10, "v3 详情每页一次");
            assert_eq!(state.playlist_v3_ids[0], (0..100).collect::<Vec<i64>>());
            assert_eq!(
                state.playlist_v3_ids[9],
                (900..1000).collect::<Vec<i64>>(),
                "第 10 页本地切片取 900..999"
            );
        }

        // 1000 首全部入队(含第 10 页的 900..999), 不重不漏。
        let index = tasks::load_index();
        assert_eq!(index.len(), 1000);
        let song_ids: BTreeSet<String> = index.iter().map(|entry| entry.song_id.clone()).collect();
        assert!(song_ids.contains("900") && song_ids.contains("999"));

        // 逐页内存探针: 10 页各一条、页号连续。v6 全量索引只在第一页解析一次,
        // 之后各页的采样增量只含当页 v3 详情与队列写入(真机内存数值由 wasm 侧给)。
        let pages = result["data"]["pages_mem_kb"].as_array().unwrap();
        assert_eq!(pages.len(), 10);
        for (offset, page) in pages.iter().enumerate() {
            assert_eq!(page["page"], offset as u64 + 1);
            assert!(page["start"].is_u64() && page["end"].is_u64(), "{page}");
        }
    }

    /// 续批(`${next_page}` 续跑)是新的调用路径: 每批各自取一次索引, 仍是
    /// "每批 1×v6 + N×v3"(不是每页 v6), 且续批不重复入队。
    #[test]
    fn playlist_queue_all_continuation_fetches_index_per_batch() {
        let fake = install_pipeline_host(JobOutcome::Succeeded);
        let mut ids = PutIds::new();
        let request = |next_page: u32| PlaylistQueueRequest {
            source: "netease".to_string(),
            playlist_id: "42".to_string(),
            quality: "lossless".to_string(),
            batch_pages: 5,
            next_page,
        };

        let first = playlist_queue_all(&mut ids, &request(1));
        assert_eq!(first["status"], "succeeded", "{first}");
        assert_eq!(first["data"]["queued"], 500);
        assert_eq!(first["data"]["next_page"], 6);
        assert_eq!(first["data"]["has_more"], true);
        assert_eq!(fake.borrow().playlist_v6_calls, 1, "第一批 5 页只 1 次 v6");
        assert_eq!(fake.borrow().playlist_v3_ids.len(), 5);

        let second = playlist_queue_all(&mut ids, &request(6));
        assert_eq!(second["status"], "succeeded", "{second}");
        assert_eq!(second["data"]["queued"], 500);
        assert_eq!(second["data"]["deduped"], 0, "续批不碰已入队的前 5 页");
        assert_eq!(second["data"]["next_page"], 11);
        assert_eq!(second["data"]["has_more"], false);
        {
            let state = fake.borrow();
            assert_eq!(state.playlist_v6_calls, 2, "续批各自 1 次索引, 不是每页");
            assert_eq!(state.playlist_v3_ids.len(), 10);
            assert_eq!(state.playlist_v3_ids[5], (500..600).collect::<Vec<i64>>());
        }
        assert_eq!(tasks::load_index().len(), 1000);
    }

    #[test]
    fn pump_runs_full_pipeline_and_names_output() {
        let fake = install_pipeline_host(JobOutcome::Succeeded);
        crate::clock::testhooks::set_now(Some(1_790_676_009_000_000_000));
        let mut ids = PutIds::new();

        let queued = request_download(&mut ids, &download_request()).unwrap();
        assert_eq!(queued["deduped"], false);
        assert_eq!(queued["quality"], DEFAULT_QUALITY, "空 level 用设置默认音质");
        let task_id = queued["task_id"].as_str().unwrap().to_string();

        let summary = pump(&mut ids).unwrap();
        assert_eq!(summary["completed"].as_array().unwrap().len(), 1, "{summary}");
        assert_eq!(summary["active"], 0);
        assert_eq!(summary["failed"].as_array().unwrap().len(), 0);

        let state = fake.borrow();
        // 0.3.8: 不再走 entries/directories 引用链, 暂存直接放工作区根。
        assert!(!state.created_dir, "0.3.8 起不再自动建暂存子目录");
        assert_eq!(state.downloads.len(), 1);
        assert_eq!(state.downloads[0]["name"], format!("{task_id}.part"));
        assert_eq!(state.downloads[0]["parent_ref"], "fe_test_ws_root");
        assert_eq!(state.downloads[0]["url"], "https://cdn.example.com/song.flac");
        assert_eq!(state.renames.len(), 1);
        assert_eq!(
            state.renames[0]["old_path"],
            format!("/CloudNAS/115open/音乐/音乐下载/{task_id}.part")
        );
        assert_eq!(state.renames[0]["new_name"], "周杰伦 - 晴天.flac");
        assert_eq!(state.copies.len(), 1);
        assert_eq!(
            state.copies[0]["src_paths"][0],
            "/CloudNAS/115open/音乐/音乐下载/周杰伦 - 晴天.flac"
        );
        assert_eq!(state.copies[0]["dest_dir"], DEFAULT_MUSIC_DIR);

        // 写操作必须带 16~128 个可打印 ASCII 的幂等键。
        assert!(!state.write_keys.is_empty());
        for (what, key) in &state.write_keys {
            assert!((16..=128).contains(&key.len()), "{what} 幂等键长度越界: {key}");
            assert!(key.bytes().all(|byte| byte.is_ascii_graphic()), "{what} 幂等键非法: {key}");
        }
        // 借出中的替身状态不能跨 host.call: 先归还再读 KV。
        drop(state);

        let tasks = tasks::load_index();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].status, tasks::STATUS_DONE);
        assert_eq!(tasks[0].id, task_id);
        // 完整记录(定名/尝试次数)在分片键上, 不在索引里。
        let full = tasks::load_task(&task_id).unwrap();
        assert_eq!(full.out_name, "周杰伦 - 晴天.flac");
        assert_eq!(full.attempts, 1);
        assert!(full.error.is_empty());
    }

    #[test]
    fn pump_retries_three_times_then_notifies() {
        let fake = install_pipeline_host(JobOutcome::Failed("CDN 403".to_string()));
        crate::clock::testhooks::set_now(Some(1_790_676_009_000_000_000));
        let mut ids = PutIds::new();
        let task_id = request_download(&mut ids, &download_request()).unwrap()["task_id"]
            .as_str()
            .unwrap()
            .to_string();

        // 第 1 轮提交, 第 2/3 轮各重试一次, 第 4 轮用尽 3 次尝试 → failed + 通知。
        for _ in 0..4 {
            pump(&mut ids).unwrap();
        }

        let full = tasks::load_task(&task_id).unwrap();
        assert_eq!(full.status, tasks::STATUS_FAILED);
        assert_eq!(full.attempts, MAX_ATTEMPTS);
        assert_eq!(full.error, "CDN 403");

        let state = fake.borrow();
        assert_eq!(state.notifications.len(), 1, "只通知一次");
        let notice = &state.notifications[0];
        assert_eq!(notice["level"], "error");
        assert!(notice["title"].as_str().unwrap().contains("晴天"));
        assert!(notice["body"].as_str().unwrap().contains("CDN 403"));
        // 0.3.11 起通知不再带 callback_data 按钮(宿主 schema 会 400), 重试入口在正文里。
        assert!(notice.get("buttons").is_none(), "0.3.11 起不发 callback_data 按钮");
        assert!(notice["body"].as_str().unwrap().contains("可一键重试"));
    }

    /// 0.3.12 核心保证: **一次 pump 最多新开 1 首**下载。
    ///
    /// 旧实现一轮里把 `max_active` 个槽位全填满, 每首都要跑完 eapi 取链阶梯
    /// (网易最多 8 个请求), 于是同时持有多首歌的中间结构 —— 这就是真机 128MB
    /// 内存限下被 SIGKILL 的直接原因。这里入队 5 首, 一次 pump 只应提交 1 个
    /// 宿主下载任务。
    #[test]
    fn single_pump_starts_at_most_one_new_download() {
        let fake = install_pipeline_host(JobOutcome::Succeeded);
        crate::clock::testhooks::set_now(Some(1_790_676_009_000_000_000));
        let mut ids = PutIds::new();

        // 5 首不同的歌(不同 song_id → 不去重)。
        for index in 0..5 {
            let mut request = download_request();
            request.song_id = format!("song-{index}");
            request.name = format!("歌{index}");
            request_download(&mut ids, &request).unwrap();
        }
        assert_eq!(tasks::load_index().len(), 5);

        let summary = pump(&mut ids).unwrap();
        assert_eq!(summary["started"].as_array().unwrap().len(), 1, "一次 pump 只新开 1 首: {summary}");
        assert_eq!(fake.borrow().downloads.len(), 1, "只提交 1 个宿主下载 job");
        assert_eq!(fake.borrow().copies.len(), 1, "假宿主 job 本轮就成功, 顺带收尾 1 条");

        // 其余 4 首仍是排队态, 没有被"顺手"开掉。
        let index = tasks::load_index();
        let queued = index.iter().filter(|e| e.status == tasks::STATUS_QUEUED).count();
        assert_eq!(queued, 4, "剩下 4 首必须还排队: {index:?}");

        // 再 pump 4 次: 每次正好推进一首, 5 轮全部走完。
        for _ in 0..4 {
            pump(&mut ids).unwrap();
        }
        let index = tasks::load_index();
        assert_eq!(index.iter().filter(|e| e.status == tasks::STATUS_DONE).count(), 5);
        assert_eq!(fake.borrow().downloads.len(), 5, "总共 5 个下载 job");
    }

    /// 门禁 3 的回归: 队列里已有 1 条 `copying` + 1 条 `queued`(max_active=2)时,
    /// 一次 pump **只能收尾 1 个**。旧实现在 ③ 收尾旧 copying 之后, ④ 新开的那首
    /// 会被 `step_one_start` 的即时轮询同步收尾(宿主 job 当轮成功), 一轮出现 2 个终态。
    #[test]
    fn single_pump_finalizes_at_most_one_task_with_copying_and_queued() {
        let fake = install_pipeline_host(JobOutcome::Succeeded);
        crate::clock::testhooks::set_now(Some(1_790_676_009_000_000_000));
        let mut ids = PutIds::new();

        // 一条已在 copying 的旧任务(暂存已定名, 只差复制入库)。
        let copying = Task {
            id: "cp00001".to_string(),
            source: "netease".to_string(),
            song_id: "old".to_string(),
            name: "旧歌".to_string(),
            singers: "旧歌手".to_string(),
            quality: DEFAULT_QUALITY.to_string(),
            out_name: "旧歌手 - 旧歌.flac".to_string(),
            staged_path: format!("{DEFAULT_MUSIC_DIR}/cp00001.part"),
            status: tasks::STATUS_COPYING.to_string(),
            updated_ms: 1,
            ..Task::default()
        };
        tasks::persist_task(&mut ids, &copying).unwrap();

        // 一条排队的新歌(与旧任务不同 source/song_id, 不去重)。
        let queued = request_download(&mut ids, &download_request()).unwrap();
        let queued_id = queued["task_id"].as_str().unwrap().to_string();
        assert_eq!(tasks::load_index().len(), 2);

        let summary = pump(&mut ids).unwrap();
        let completed = summary["completed"].as_array().unwrap().len();
        let failed = summary["failed"].as_array().unwrap().len();
        assert!(completed + failed <= 1, "一次 pump 最多收尾 1 个: {summary}");
        assert_eq!(fake.borrow().copies.len(), 1, "同一轮最多 1 次复制: {summary}");

        // 旧 copying 被收尾; 新开的那首只是提交(仍是 downloading), 留到下轮收尾。
        assert_eq!(tasks::load_task("cp00001").unwrap().status, tasks::STATUS_DONE);
        let new_entry = tasks::load_index()
            .into_iter()
            .find(|e| e.id == queued_id)
            .expect("新任务在索引里");
        assert_eq!(
            new_entry.status,
            tasks::STATUS_DOWNLOADING,
            "新开的那首不该在同一轮被顺手收尾: {summary}"
        );
        drop(fake);
    }

    /// 0.3.12 内存审计: 把模块头注释里引用的**实测字节数**钉成断言。
    ///
    /// 索引条目与完整记录的单条体积决定了"单次 pump 内存上界"里 idx 与在途两项的
    /// 系数。这里按真机形态构造(长 error 撑满 `IDX_ERROR_LIMIT`、绝对暂存路径、
    /// `job_ref`), 断言:
    /// - 索引条目 < 完整记录的一半(分片的收益前提);
    /// - 索引条目有**字节级上界**(不随 error 文本长度线性膨胀);
    /// - 200 条索引(state 展示上限)仍远小于宿主帧上限。
    ///
    /// 顺带把 `report` 打印出来, 便于对照模块头的数字。
    #[test]
    fn audit_measured_index_and_record_sizes() {
        // 索引条目: `error` 撑满 IDX_ERROR_LIMIT(这是它唯一可能变大的字段)。
        let idx = tasks::TaskIndexEntry {
            id: "a1b2c3d4".to_string(),
            source: "netease".to_string(),
            song_id: "12345".to_string(),
            status: tasks::STATUS_QUEUED.to_string(),
            name: "晴天".to_string(),
            singers: "周杰伦".to_string(),
            quality: "jymaster".to_string(),
            error: "x".repeat(tasks::IDX_ERROR_LIMIT),
            updated_ms: 1_790_676_009_000,
        };
        // 完整记录: 多带 job_ref / staged_path / out_name / album, error 撑到 600B。
        let full = Task {
            id: "a1b2c3d4".to_string(),
            source: "netease".to_string(),
            song_id: "12345".to_string(),
            name: "晴天".to_string(),
            singers: "周杰伦".to_string(),
            album: "叶惠美".to_string(),
            quality: "jymaster".to_string(),
            out_name: "周杰伦 - 晴天.flac".to_string(),
            staged_path: "/dian115AI/a1b2c3d4.part".to_string(),
            status: tasks::STATUS_DOWNLOADING.to_string(),
            job_ref: "job-8f2c1a".to_string(),
            attempts: 1,
            error: "x".repeat(600),
            created_ms: 1_790_676_009_000,
            updated_ms: 1_790_676_009_000,
            ..Task::default()
        };
        let idx_bytes = serde_json::to_vec(&idx).unwrap().len();
        let full_bytes = serde_json::to_vec(&full).unwrap().len();

        // 索引条目必须明显小于完整记录(分片的收益前提)。
        assert!(
            idx_bytes * 2 < full_bytes,
            "索引条目({idx_bytes}B)相对完整记录({full_bytes}B)没有小到一半以下"
        );
        // 字节级上界: error 撑满时也只有这个量级, 不再随文本长度线性增长。
        // 0.3.14 索引新增 `source`/`song_id` 两个短字段(入队去重需要), 上界从
        // 256B 抬到 320B; 实测约 289B(error 撑满 IDX_ERROR_LIMIT 时)。
        assert!(
            idx_bytes <= 320,
            "索引条目 {idx_bytes}B 超过 320B 上界, 模块头的 KB 估算需要更新"
        );
        // 200 条(state 展示上限)仍只有几十 KB。
        let idx_200 = 200 * idx_bytes;
        assert!(
            idx_200 < 64 * 1024,
            "200 条索引 {idx_200}B 超过 64KiB, 超出模块头声称的量级"
        );
        println!(
            "[audit] idx_entry={idx_bytes}B full_record={full_bytes}B ratio={:.1} \
             idx@200={:.1}KB in_flight@max_active_cap={:.1}KB",
            full_bytes as f64 / idx_bytes as f64,
            idx_200 as f64 / 1024.0,
            (crate::download::MAX_ACTIVE_CAP as usize * full_bytes) as f64 / 1024.0,
        );
    }

    /// 0.3.12 内存审计: `DIAG_ROOTS_RAW` 是**永不释放**的 static(线性内存不归还
    /// OS), 因此必须与"历史最大响应"解耦。
    ///
    /// 断言 [`diag_b64`] 把超长响应截到 [`DIAG_RAW_MAX_B64`], 且截断后仍是合法
    /// base64(否则诊断读档时 `base64 -d` 会直接失败)。
    #[test]
    fn diag_static_is_bounded_and_stays_valid_base64() {
        use base64::Engine as _;
        let engine = base64::engine::general_purpose::STANDARD;

        // 短响应: 原样编码, 不加截断标记。
        let small = diag_b64(b"{\"data\":{\"items\":[]}}");
        assert_eq!(small, engine.encode(b"{\"data\":{\"items\":[]}}"));

        // 远超上限的响应: 截断。
        let huge = vec![b'x'; DIAG_RAW_MAX_B64 * 4];
        let capped = diag_b64(&huge);
        assert!(
            capped.len() <= DIAG_RAW_MAX_B64,
            "诊断留档 {}B 超过上限 {DIAG_RAW_MAX_B64}B",
            capped.len()
        );
        // 必须是合法 base64(否则读档的人没法解码)。
        let decoded = engine
            .decode(&capped)
            .unwrap_or_else(|err| panic!("截断后不是合法 base64: {err}"));
        assert!(
            decoded.len() <= DIAG_RAW_MAX_B64,
            "解码后 {}B 超过上限",
            decoded.len()
        );
        // 标记在解码之后可见, 且落在 4 字节对齐的有效载荷之后。
        let text = String::from_utf8_lossy(&decoded);
        assert!(text.contains("<truncated>"), "截断标记必须可见: {text:?}");
        let marker_len = "\n<truncated>".len();
        let payload_bytes = decoded.len() - marker_len;
        assert_eq!(payload_bytes % 3, 0, "有效载荷必须 3 字节对齐(base64 的最小编码单位)");

        // 关键性质: 响应再大, static 的字节数也不变(与历史峰值无关)。
        for scale in [1usize, 8, 64] {
            let body = vec![b'y'; DIAG_RAW_MAX_B64 * scale];
            assert_eq!(
                diag_b64(&body).len(),
                capped.len(),
                "响应放大 {scale} 倍后诊断留档长度变了 → static 上界与响应大小相关"
            );
        }
    }

    /// 0.3.12 内存审计: [`mark_queued_error`] 把阻塞原因写进**每一条**排队条目,
    /// 若不截断, 索引体积会变成 `排队条数 × reason 长度`(reason 内含宿主返回的
    /// 全部 roots 摘要)。断言它与完整记录投影走同一个 `IDX_ERROR_LIMIT`。
    #[test]
    fn queued_block_reason_is_truncated_in_index() {
        let fake = install_pipeline_host(JobOutcome::Succeeded);
        crate::clock::testhooks::set_now(Some(1_790_676_009_000_000_000));
        let mut ids = PutIds::new();

        // 3 条排队任务(全终态队列不需要完整记录, 便于只观察索引)。
        for index in 0..3u64 {
            let task = Task {
                id: format!("q{index:03}"),
                status: tasks::STATUS_QUEUED.to_string(),
                name: format!("歌{index}"),
                updated_ms: index + 1,
                ..Task::default()
            };
            tasks::persist_task(&mut ids, &task).unwrap();
        }

        // 一个远超 IDX_ERROR_LIMIT 的阻塞原因(模拟宿主返回几十个 roots 的形态)。
        let long_reason = format!("宿主未向插件开放本地可写工作区根(roots: [{}])", "别名(后端), ".repeat(200));
        assert!(long_reason.len() > tasks::IDX_ERROR_LIMIT * 5);
        let mut report = PumpReport::default();
        mark_queued_error(&mut ids, &long_reason, &mut report);

        let index = tasks::load_index();
        assert_eq!(index.len(), 3);
        for entry in &index {
            assert!(
                entry.error.len() <= tasks::IDX_ERROR_LIMIT,
                "排队条目的 error 未截断: {}B",
                entry.error.len()
            );
        }
        // 整份索引仍是常数级: 3 条 × 上界, 不随 reason 长度膨胀。
        let idx_bytes = serde_json::to_vec(&index).unwrap().len();
        assert!(
            idx_bytes <= 3 * 512,
            "3 条索引就占了 {idx_bytes}B, 阻塞原因仍在按 reason 长度膨胀"
        );
        drop(fake);
    }

    /// 峰值内存与队列长度**无关**的直接度量: 一次 pump 只把"在途 + 本轮要动的那几条"
    /// 完整记录读进内存, 队列里其余几十条**一次都不读**。
    ///
    /// 摆 40 条任务(模拟真机队列规模), 全部推到 `done`(终态, 无需推进), 槽位全空;
    /// 一次 pump 应当只读索引与设置, `task.<id>` 的读取**为 0**。
    /// 对照旧实现: 整队 `Vec<Task>` 被 load 进来, 40 条全量进内存。
    #[test]
    fn pump_reads_no_full_records_for_finished_queue() {
        let fake = install_pipeline_host(JobOutcome::Succeeded);
        crate::clock::testhooks::set_now(Some(1_790_676_009_000_000_000));
        let mut ids = PutIds::new();

        // 40 条已完成的完整记录(故意带长 error/长路径, 让单条足够"重")。
        for index in 0..40u64 {
            let task = Task {
                id: format!("fin{index:03}"),
                source: "netease".to_string(),
                song_id: index.to_string(),
                name: format!("歌{index}"),
                singers: "歌手".to_string(),
                quality: "jymaster".to_string(),
                status: tasks::STATUS_DONE.to_string(),
                out_name: format!("歌手 - 歌{index}.flac"),
                staged_path: format!("/dian115AI/fin{index:03}.part"),
                job_ref: format!("job-{index}"),
                attempts: 3,
                error: "x".repeat(600),
                created_ms: index + 1,
                updated_ms: index + 1,
                ..Task::default()
            };
            tasks::persist_task(&mut ids, &task).unwrap();
        }
        let index = tasks::load_index();
        assert_eq!(index.len(), 40);
        // 索引条目必须明显小于完整记录(这是分片的收益前提)。实测: 索引里 `error`
        // 被截到 120B, 完整记录还带 job_ref/staged_path/out_name/album 等。
        let idx_bytes = serde_json::to_vec(&index).unwrap().len() / index.len();
        let full_bytes = serde_json::to_vec(&tasks::load_task("fin000").unwrap()).unwrap().len();
        assert!(
            full_bytes >= idx_bytes * 2,
            "索引条目({idx_bytes}B)相对完整记录({full_bytes}B)没有明显变小"
        );

        fake.borrow_mut().task_reads.clear();
        let summary = pump(&mut ids).unwrap();
        let reads = fake.borrow().task_reads.clone();
        assert!(
            reads.is_empty(),
            "全终态队列的一次 pump 不该读任何完整记录, 实际读了: {:?}",
            reads.iter().map(|(k, _)| k).collect::<Vec<_>>()
        );
        assert_eq!(summary["active"], 0);
        assert_eq!(summary["queued"], 0);
        assert_eq!(summary["completed"].as_array().unwrap().len(), 0);
        // 40 条记录都还在(没有被这次 pump 顺手清掉)。
        assert_eq!(tasks::load_index().len(), 40);
    }

    /// 队列里只剩 1 首排队 + 38 条已完成时, 一次 pump 只读**那一条**的完整记录。
    #[test]
    fn pump_reads_only_the_one_task_it_advances() {
        let fake = install_pipeline_host(JobOutcome::Succeeded);
        crate::clock::testhooks::set_now(Some(1_790_676_009_000_000_000));
        let mut ids = PutIds::new();

        // 38 条已完成。
        for index in 0..38 {
            let task = Task {
                id: format!("fin{index:03}"),
                status: tasks::STATUS_DONE.to_string(),
                updated_ms: index as u64 + 1,
                ..Task::default()
            };
            tasks::persist_task(&mut ids, &task).unwrap();
        }
        // 1 首排队。
        let queued = request_download(&mut ids, &download_request()).unwrap();
        let queued_id = queued["task_id"].as_str().unwrap().to_string();
        assert_eq!(tasks::load_index().len(), 39);

        fake.borrow_mut().task_reads.clear();
        let summary = pump(&mut ids).unwrap();
        assert_eq!(summary["started"].as_array().unwrap().len(), 1);

        let reads = fake.borrow().task_reads.clone();
        assert!(!reads.is_empty(), "推进那条必须读它的完整记录");
        // 读到的键只有被推进的那一条。
        let distinct: std::collections::BTreeSet<&String> = reads.iter().map(|(k, _)| k).collect();
        assert_eq!(distinct.len(), 1, "只应读被推进的那一条, 实际读了: {distinct:?}");
        assert!(
            distinct.iter().all(|k| k.ends_with(&queued_id)),
            "读到的是别的任务: {distinct:?}"
        );
    }

    /// pump 开头做旧键迁移: 旧单键 `tasks` 的任务会被拆成分片并被推进。
    #[test]
    fn pump_migrates_legacy_queue_first() {
        let fake = install_pipeline_host(JobOutcome::Succeeded);
        crate::clock::testhooks::set_now(Some(1_790_676_009_000_000_000));
        let mut ids = PutIds::new();

        // 直接塞旧版单键队列(0.3.11 形态, 顶层数组)。
        let legacy = vec![Task {
            id: "leg001".to_string(),
            source: "netease".to_string(),
            song_id: "77".to_string(),
            name: "旧歌".to_string(),
            singers: "旧歌手".to_string(),
            quality: "jymaster".to_string(),
            out_name: "旧歌手 - 旧歌.flac".to_string(),
            status: tasks::STATUS_QUEUED.to_string(),
            created_ms: 1_000,
            updated_ms: 1_000,
            ..Task::default()
        }];
        store::put(&mut ids, tasks::TASKS_KEY, &serde_json::to_vec(&legacy).unwrap()).unwrap();

        // 第一次 pump: 迁移 + 推进这一条(一次只新开 1 首)。
        let summary = pump(&mut ids).unwrap();
        assert_eq!(summary["started"].as_array().unwrap().len(), 1, "{summary}");

        let (raw, ok) = store::get(tasks::TASKS_KEY);
        assert!(!ok || raw.is_empty(), "pump 之后旧键必须被删");
        let full = tasks::load_task("leg001").expect("分片键");
        assert_eq!(full.status, tasks::STATUS_DONE);
        assert_eq!(full.out_name, "旧歌手 - 旧歌.flac");
        let index = tasks::load_index();
        assert_eq!(index.len(), 1);
        assert_eq!(index[0].id, "leg001");
        assert_eq!(fake.borrow().downloads.len(), 1);
    }

    /// 重试后再用尽: 第二次失败通知的 `dedupe_key` 与幂等键必须与第一轮不同,
    /// 否则会被宿主按幂等/去重吞掉(attempts 归零导致键逐字节相同)。
    #[test]
    fn second_failure_notification_keys_differ_after_retry() {
        let fake = install_pipeline_host(JobOutcome::Failed("CDN 403".to_string()));
        crate::clock::testhooks::set_now(Some(1_790_676_009_000_000_000));
        let mut ids = PutIds::new();
        let task_id = request_download(&mut ids, &download_request()).unwrap()["task_id"]
            .as_str()
            .unwrap()
            .to_string();

        // 第一轮: 3 次尝试用尽 → failed + 通知。
        for _ in 0..4 {
            pump(&mut ids).unwrap();
        }
        assert_eq!(fake.borrow().notifications.len(), 1);

        // 用户点「重试」: attempts 归零、retry_round 自增, 再跑一轮仍失败。
        tasks::retry(&mut ids, &task_id).unwrap();
        let retried = tasks::load_task(&task_id).unwrap();
        assert_eq!(retried.attempts, 0);
        assert_eq!(retried.retry_round, 1);
        for _ in 0..4 {
            pump(&mut ids).unwrap();
        }

        let state = fake.borrow();
        assert_eq!(state.notifications.len(), 2, "第二轮失败必须再发一次通知");
        let first = &state.notifications[0];
        let second = &state.notifications[1];
        assert_ne!(first["dedupe_key"], second["dedupe_key"]);
        assert!(second["dedupe_key"].as_str().unwrap().contains("-r1-"));

        let notify_keys: Vec<&String> = state
            .write_keys
            .iter()
            .filter(|(what, _)| what == "POST /api/notifications/plugin")
            .map(|(_, key)| key)
            .collect();
        assert_eq!(notify_keys.len(), 2);
        assert_ne!(notify_keys[0], notify_keys[1]);
        // 两轮通知都指向同一个任务(正文里的重试入口经插件页路由到 task-retry)。
        assert!(second["body"].as_str().unwrap().contains("可一键重试"));
        assert_eq!(second["body"].as_str().unwrap(), first["body"].as_str().unwrap());
    }

    #[test]
    fn effective_staging_requires_local_writable_root() {
        let settings = Settings::default();
        // 默认路径在 CD2 根下 → 回退到第一个本地根。
        let probe = RootsProbe {
            ok: true,
            error: String::new(),
            items: Vec::new(),
            roots: vec![
                Root { path: "/CloudNAS/115open/音乐".into(), name: "音乐".into(), local: false, writable: true },
                Root { path: "/volume1/music".into(), name: "本地".into(), local: true, writable: true },
            ],
        };
        let (dir, warnings) = effective_staging(&settings, &probe);
        // 0.3.5: 已配置(CD2 默认值)就按配置直试, roots 不匹配只警告不拦截。
        assert_eq!(dir.as_deref(), Some(DEFAULT_MUSIC_DIR));
        assert_eq!(warnings.len(), 1, "{warnings:?}");

        // 默认路径在本地根下 → 原样使用。
        let probe = RootsProbe {
            ok: true,
            error: String::new(),
            items: Vec::new(),
            roots: vec![Root {
                path: "/CloudNAS/115open/音乐".into(),
                name: "音乐".into(),
                local: true,
                writable: true,
            }],
        };
        let (dir, warnings) = effective_staging(&settings, &probe);
        assert_eq!(dir.as_deref(), Some(DEFAULT_MUSIC_DIR));
        assert!(warnings.is_empty());

        // 只有 CD2 根但已配置 → 仍按配置直试(downloads broker 会给出最终裁决)。
        let probe = RootsProbe {
            ok: true,
            error: String::new(),
            items: Vec::new(),
            roots: vec![Root { path: "/mnt/cd2".into(), name: "CD2".into(), local: false, writable: true }],
        };
        let (dir, warnings) = effective_staging(&settings, &probe);
        assert_eq!(dir.as_deref(), Some(DEFAULT_MUSIC_DIR));
        assert_eq!(warnings.len(), 1);

        // 未配置 + 只有 CD2 根 → None。
        let mut empty = settings.clone();
        empty.staging_dir = String::new();
        let (dir, warnings) = effective_staging(&empty, &probe);
        assert_eq!(dir, None);
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn roots_parsing_flags_cd2_and_writability() {
        let local = parse_root(&json!({"path": "/data/", "name": "本地", "kind": "local", "writable": true})).unwrap();
        assert_eq!(local.path, "/data");
        assert!(local.local && local.writable);
        let cd2 = parse_root(&json!({"path": "/mnt/cd2", "backend": "cd2", "writable": true})).unwrap();
        assert!(!cd2.local, "CD2 必须被排除");
        let read_only = parse_root(&json!({"path": "/ro", "backend": "local", "read_only": true})).unwrap();
        assert!(!read_only.writable);
        let bare = parse_root(&json!("/plain/path")).unwrap();
        assert_eq!(bare.path, "/plain/path");
    }

    #[test]
    fn job_state_and_result_path_are_tolerant() {
        assert_eq!(job_state(&json!({"status": "succeeded"})), JobState::Succeeded);
        assert_eq!(job_state(&json!({"data": {"state": "running"}})), JobState::Pending);
        assert_eq!(job_state(&json!({"status": "not-a-state"})), JobState::Pending);
        assert_eq!(
            job_state(&json!({"status": "failed", "error": "boom"})),
            JobState::Failed("boom".to_string())
        );
        assert_eq!(job_state(&json!({"status": "failed"})), JobState::Failed("失败".to_string()));
        assert_eq!(
            job_result_path(&json!({"result": {"path": "/x/y.flac"}})),
            Some("/x/y.flac".to_string())
        );
        assert_eq!(job_result_path(&json!({"status": "succeeded"})), None);
    }

    /// CookieCloud 设置(0.3.4): settings-update 接受三个键(字符串、不做路径归一化),
    /// settings_view 只输出改名后的 cc_url/cc_uuid + cc_key_ready 布尔, 且整棵视图
    /// 递归不含 "cookie" 键名、没有以 "/" 开头的字符串值(宿主 2026-09-30 两条校验)。
    #[test]
    fn cookiecloud_settings_update_and_sanitized_view() {
        let fake = install_pipeline_host(JobOutcome::Succeeded);
        let mut ids = PutIds::new();

        // ① 三个键都收; URL 不被 normalize_path 破坏(不以 "h" 开头判断: 显式给
        //    "http://…" 必须原样落 KV)。
        let patch = json!({
            "cookiecloud_url": "  http://127.0.0.1:8088/  ",
            "cookiecloud_uuid": " cc-uuid-1 ",
            "cookiecloud_key": " cc-key-1 ",
        });
        let view = settings_update(&mut ids, patch.as_object().unwrap()).unwrap();
        assert_eq!(view["cc_url"], "http://127.0.0.1:8088/", "URL 只 trim 空白, 尾斜杠由 pull 侧去除");
        assert_eq!(view["cc_uuid"], "cc-uuid-1");
        assert_eq!(view["cc_key_ready"], true, "密钥非空 → ready 布尔");
        assert!(view.get("cookiecloud_url").is_none(), "视图不得回显原字段名");
        assert!(view.get("cookiecloud_key").is_none(), "密钥绝不回显");

        let reloaded = load_settings();
        assert_eq!(reloaded.cookiecloud_url, "http://127.0.0.1:8088/");
        assert_eq!(reloaded.cookiecloud_uuid, "cc-uuid-1");
        assert_eq!(reloaded.cookiecloud_key, "cc-key-1");

        // ② 默认视图: URL 回默认本机地址, cc_key_ready=false。
        let view = settings_view(&Settings::default());
        assert_eq!(view["cc_url"], DEFAULT_COOKIECLOUD_URL);
        assert_eq!(view["cc_uuid"], "");
        assert_eq!(view["cc_key_ready"], false);

        // ③ 清空 URL → normalized 回默认; 空串显式写入 UUID/密钥(允许清除)。
        let patch = json!({"cookiecloud_url": "", "cookiecloud_uuid": " ", "cookiecloud_key": ""});
        let view = settings_update(&mut ids, patch.as_object().unwrap()).unwrap();
        assert_eq!(view["cc_url"], DEFAULT_COOKIECLOUD_URL);
        assert_eq!(view["cc_uuid"], "");
        assert_eq!(view["cc_key_ready"], false);

        // ④ 宿主两条校验: 视图键名递归无 "cookie" 子串; 无以 "/" 开头的字符串值
        //    (looks_like_abs_path 的判据, "//" 开头也不算但这里一并排除)。
        fn assert_view_sanitized(value: &Value, path: &str) {
            match value {
                Value::Object(map) => {
                    for (key, inner) in map {
                        assert!(
                            !key.to_lowercase().contains("cookie"),
                            "视图键名含 cookie 子串: {path}.{key}"
                        );
                        assert_view_sanitized(inner, &format!("{path}.{key}"));
                    }
                }
                Value::Array(items) => {
                    for (index, inner) in items.iter().enumerate() {
                        assert_view_sanitized(inner, &format!("{path}[{index}]"));
                    }
                }
                Value::String(text) => {
                    assert!(
                        !text.starts_with('/'),
                        "视图字符串值以 / 开头(宿主会整体拒绝): {path}={text}"
                    );
                }
                _ => {}
            }
        }
        let mut filled = Settings::default();
        filled.cookiecloud_uuid = "u-9".to_string();
        filled.cookiecloud_key = "k-9".to_string();
        for view in [view, settings_view(&filled)] {
            assert_view_sanitized(&view, "$");
        }
        drop(fake);
    }

    #[test]
    fn settings_update_validates_patch() {
        let fake = install_pipeline_host(JobOutcome::Succeeded);
        let mut ids = PutIds::new();
        let patch = json!({
            "staging_dir": "  /data/dl  ",
            "target_dir": "/mnt/target",
            "quality": "lossless",
            "max_active": 0,
            "notify_on_fail": false,
            "unknown": "ignored",
        });
        let view = settings_update(&mut ids, patch.as_object().unwrap()).unwrap();
        // 0.3.1 起 state 视图里的路径不再带开头 "/"(宿主安全过滤), 保存侧归一化回绝对路径。
        assert_eq!(view["staging_dir"], "data/dl");
        assert_eq!(view["target_dir"], "mnt/target");
        assert_eq!(view["quality"], "lossless");
        assert_eq!(view["max_active"], DEFAULT_MAX_ACTIVE, "0 视为非法, 回默认");
        assert_eq!(view["notify_on_fail"], false);
        assert!(view.get("unknown").is_none());

        // 落 KV 后重新读出(内部存储保持绝对路径)。
        let reloaded = load_settings();
        assert_eq!(reloaded.staging_dir, "/data/dl");
        assert_eq!(reloaded.target_dir, "/mnt/target");
        assert_eq!(reloaded.quality, "lossless");
        assert!(!reloaded.notify_on_fail);
        drop(fake);
    }

    // ─────────────── 0.3.15: 队列操作互斥 + 内存探针 ───────────────

    /// 队列操作互斥: pump / 单曲入队 / 整单入队共用一面旗标, 已有操作在跑时后来者
    /// **直接 skipped**(不排队等待、不触碰 KV/宿主), 守卫释放后同一入口立刻恢复。
    #[test]
    fn queue_op_mutex_skips_second_queue_op_while_busy() {
        let fake = install_pipeline_host(JobOutcome::Succeeded);
        crate::clock::testhooks::set_now(Some(1_790_676_009_000_000_000));
        let mut ids = PutIds::new();
        // 持有守卫 = 模拟"另一个 pump/入队正在跑"(cron 撞上手动点击的真实形态)。
        let held = try_begin_queue_op().expect("首个队列操作应拿到互斥");

        let skipped_pump = pump(&mut ids).unwrap();
        assert_eq!(skipped_pump["skipped"], "queue_busy", "{skipped_pump}");
        assert!(skipped_pump["message"].as_str().unwrap().contains("稍后再试"), "{skipped_pump}");

        let skipped_enqueue = request_download(&mut ids, &download_request()).unwrap();
        assert_eq!(skipped_enqueue["skipped"], "queue_busy", "{skipped_enqueue}");
        assert!(skipped_enqueue.get("task_id").is_none(), "跳过时不该建任务: {skipped_enqueue}");
        assert!(skipped_enqueue["mem_kb"]["start"].is_u64(), "{skipped_enqueue}");

        let skipped_all = playlist_queue_all(
            &mut ids,
            &PlaylistQueueRequest {
                source: "netease".to_string(),
                playlist_id: "42".to_string(),
                quality: "lossless".to_string(),
                batch_pages: 5,
                next_page: 3,
            },
        );
        assert_eq!(skipped_all["status"], "skipped", "{skipped_all}");
        assert_eq!(skipped_all["skipped"], "queue_busy", "{skipped_all}");
        // 什么都没做: 续批游标停在请求的起始页, 不丢也不重。
        assert_eq!(skipped_all["data"]["next_page"], 3, "{skipped_all}");
        assert_eq!(skipped_all["data"]["queued"], 0, "{skipped_all}");

        // 跳过路径不许碰存储/宿主。
        assert_eq!(tasks::load_index().len(), 0, "跳过路径不该产生任务");
        assert!(fake.borrow().downloads.is_empty(), "跳过路径不该提交宿主下载");
        assert!(fake.borrow().task_reads.is_empty(), "跳过路径不该读任务分片");

        // 释放后同一入口立刻恢复正常(守卫必须复位旗标)。
        drop(held);
        let queued = request_download(&mut ids, &download_request()).unwrap();
        assert_eq!(queued["deduped"], false, "{queued}");
        assert_eq!(tasks::load_index().len(), 1);
    }

    /// action 层形状: 忙时 `download` / `pump` / `playlist-queue-all` 三个 action
    /// 都返回 `status=skipped` + `skipped=queue_busy`(提示稍后再试), 而不是
    /// succeeded(误报已入队/已推进)或 failed(其实什么都没做)。
    #[test]
    fn runtime_actions_report_skipped_while_queue_busy() {
        let _fake = install_pipeline_host(JobOutcome::Succeeded);
        let held = try_begin_queue_op().expect("首个队列操作应拿到互斥");
        let mut runtime = crate::runtime::Runtime::new();

        let download_payload = json!({
            "id": "download",
            "input": {
                "source": "netease", "song_id": "1", "name": "晴天",
                "singers": "周杰伦", "album": "叶惠美", "level": "lossless"
            }
        });
        let result = runtime
            .action("inv-busy-1", crate::raw::RawPayload::Value(&download_payload))
            .unwrap();
        assert_eq!(result["status"], "skipped", "{result}");
        assert_eq!(result["skipped"], "queue_busy", "{result}");
        assert_eq!(result["data"]["skipped"], "queue_busy", "{result}");

        let pump_payload = json!({"id": "pump"});
        let result = runtime
            .action("inv-busy-2", crate::raw::RawPayload::Value(&pump_payload))
            .unwrap();
        assert_eq!(result["status"], "skipped", "{result}");
        assert_eq!(result["skipped"], "queue_busy", "{result}");

        let playlist_payload = json!({
            "id": "playlist-queue-all",
            "input": {"source": "netease", "id": "42", "quality": "lossless", "batch_pages": 5}
        });
        let result = runtime
            .action("inv-busy-3", crate::raw::RawPayload::Value(&playlist_payload))
            .unwrap();
        assert_eq!(result["status"], "skipped", "{result}");
        assert_eq!(result["skipped"], "queue_busy", "{result}");

        drop(held);
    }

    /// pumpdiag 携带六段阶段内存探针(键齐全、值为整数)与 `queue.idx`;
    /// 非 wasm(测试)目标探针恒 0 —— 真值是 wasm 下 `memory_size` 的读数。
    #[test]
    fn pumpdiag_carries_stage_memory_probes() {
        let _fake = install_pipeline_host(JobOutcome::Succeeded);
        crate::clock::testhooks::set_now(Some(1_790_676_009_000_000_000));
        let mut ids = PutIds::new();
        let _ = request_download(&mut ids, &download_request()).unwrap();
        let summary = pump(&mut ids).unwrap();
        assert!(summary.get("skipped").is_none(), "不忙时 pump 应正常推进: {summary}");

        let diag = store::get_json::<Value>("pumpdiag").expect("pumpdiag 必须落盘");
        let mem = &diag["mem_kb"];
        let keys = ["start", "after_index", "after_poll", "after_start", "after_finish", "end"];
        for key in keys {
            assert!(mem.get(key).and_then(Value::as_u64).is_some(), "mem_kb.{key} 缺失或非整数: {diag}");
        }
        // 首次读索引时的排队数: 1 条(刚入队; 本轮 ④ 才把它启动)。
        assert_eq!(diag["queue"]["idx"], 1, "{diag}");
        // 只读展示 manifest 上限(memory_mb=128 → 131072 KB), 恒 >= 当前读数。
        assert_eq!(mem["manifest_cap_kb"], 128 * 1024, "{diag}");
        assert!(mem["manifest_cap_kb"].as_u64().unwrap() >= mem["end"].as_u64().unwrap());
        #[cfg(not(target_arch = "wasm32"))]
        for key in keys {
            assert_eq!(mem[key], 0, "非 wasm(测试)目标探针恒 0: {diag}");
        }
    }

    /// action 响应探针: 单曲入队带 `mem_kb{start,end}`; 整单入队带整批 `mem_kb`
    /// 与每页一条的 `pages_mem_kb{page,start,end}`(失败页也记, 校验失败的空数组)。
    #[test]
    fn action_responses_carry_memory_probes() {
        let _fake = install_pipeline_host(JobOutcome::Succeeded);
        let mut ids = PutIds::new();

        // ① 单曲入队(action `download` 的落地函数)。
        let enqueue = request_download(&mut ids, &download_request()).unwrap();
        assert!(enqueue["mem_kb"]["start"].is_u64(), "{enqueue}");
        assert!(enqueue["mem_kb"]["end"].is_u64(), "{enqueue}");

        // ② 整单入队: 两页, 每页一条 pages_mem_kb, 页号连续。
        let pages = vec![
            songs_page(150, &ids_range("a", 100)),
            songs_page(150, &ids_range("b", 50)),
        ];
        let all = queue_playlist_pages(&mut ids, "netease", "lossless", 1, 5, |page, _size| {
            Ok(pages[(page - 1) as usize].clone())
        });
        assert_eq!(all["status"], "succeeded", "{all}");
        assert!(all["data"]["mem_kb"]["start"].is_u64(), "{all}");
        assert!(all["data"]["mem_kb"]["end"].is_u64(), "{all}");
        let per_page =
            all["data"]["pages_mem_kb"].as_array().expect("pages_mem_kb 必须是数组");
        assert_eq!(per_page.len(), 2, "每页结束记一条: {all}");
        for (index, item) in per_page.iter().enumerate() {
            assert_eq!(item["page"], (index + 1) as u64, "{all}");
            assert!(item["start"].is_u64() && item["end"].is_u64(), "{all}");
        }

        // ③ 入参校验失败的业务 failed 响应同样带探针数组(空)。
        let bad = playlist_queue_all(
            &mut ids,
            &PlaylistQueueRequest {
                source: "qq".to_string(),
                playlist_id: "42".to_string(),
                quality: "lossless".to_string(),
                batch_pages: 5,
                next_page: 1,
            },
        );
        assert_eq!(bad["status"], "failed", "{bad}");
        assert!(bad["data"]["pages_mem_kb"].as_array().unwrap().is_empty(), "{bad}");
        assert!(bad["data"]["mem_kb"]["start"].is_u64(), "{bad}");

        // ④ 页面失败也记一条: 失败页的内存尖峰同样要能看到。
        let mut ids2 = PutIds::new();
        let failed = queue_playlist_pages(&mut ids2, "netease", "lossless", 1, 5, |page, _size| {
            if page == 1 {
                return Err("network boom".to_string());
            }
            Ok(songs_page(0, &[]))
        });
        assert_eq!(failed["status"], "failed", "{failed}");
        assert_eq!(failed["data"]["pages_mem_kb"].as_array().unwrap().len(), 1, "{failed}");

        // 非 wasm(测试)目标: 所有探针恒 0(真值只在 wasm 下由 memory_size 给出)。
        #[cfg(not(target_arch = "wasm32"))]
        {
            for value in [&enqueue["mem_kb"], &all["data"]["mem_kb"]] {
                assert_eq!(value["start"], 0, "非 wasm 探针恒 0: {value}");
                assert_eq!(value["end"], 0, "非 wasm 探针恒 0: {value}");
            }
            for item in per_page {
                assert_eq!(item["start"], 0, "非 wasm 探针恒 0: {item}");
                assert_eq!(item["end"], 0, "非 wasm 探针恒 0: {item}");
            }
        }
    }
}
