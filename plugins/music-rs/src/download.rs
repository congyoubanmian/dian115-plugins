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

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

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

const FILES_ROOTS: &str = "/api/plugin-host/files/roots";
const FILES_ENTRIES: &str = "/api/plugin-host/files/entries";
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
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            staging_dir: DEFAULT_MUSIC_DIR.to_string(),
            target_dir: DEFAULT_MUSIC_DIR.to_string(),
            quality: DEFAULT_QUALITY.to_string(),
            max_active: DEFAULT_MAX_ACTIVE,
            notify_on_fail: true,
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

/// 设置的可展示形态(state 响应 / settings-update 返回)。
pub fn settings_view(settings: &Settings) -> Value {
    json!({
        "staging_dir": settings.staging_dir,
        "target_dir": settings.target_dir,
        "quality": settings.quality,
        "max_active": settings.max_active,
        "notify_on_fail": settings.notify_on_fail,
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
                *target = text.to_string();
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
            return RootsProbe { ok: false, error: err, roots: Vec::new() };
        }
    };
    if !(200..300).contains(&status) {
        return RootsProbe {
            ok: false,
            error: http_error("GET", FILES_ROOTS, status, &body),
            roots: Vec::new(),
        };
    }
    let value: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(err) => {
            return RootsProbe {
                ok: false,
                error: format!("GET {FILES_ROOTS} 响应不是 JSON: {err}"),
                roots: Vec::new(),
            };
        }
    };
    let roots = extract_array(&value).iter().filter_map(parse_root).collect();
    RootsProbe { ok: true, error: String::new(), roots }
}

/// 依据探测结果决定本次 pump 实际使用的暂存目录。
///
/// - 配置的 `staging_dir` 落在某个**本地可写根**下(排除 CD2/AURA) → 原样使用;
/// - 否则回退到第一个本地可写根下的 `音乐下载/`, 并把回退原因放进 warnings;
/// - 没有任何本地可写根 → `None`(队列保持排队, 由 state 里的 warnings 提示)。
pub fn effective_staging(settings: &Settings, probe: &RootsProbe) -> (Option<String>, Vec<String>) {
    let mut warnings = Vec::new();
    let configured = normalize_dir(&settings.staging_dir);
    if !configured.is_empty() && best_root(probe, &configured).is_some() {
        return (Some(configured), warnings);
    }
    if let Some(root) = probe.roots.iter().find(|root| root.local && root.writable) {
        let fallback = join_dir(&root.path, "音乐下载");
        warnings.push(format!(
            "staging_dir {} 不在本地可写根内(排除 CD2 后), 本次回退到 {}",
            settings.staging_dir, fallback
        ));
        return (Some(fallback), warnings);
    }
    warnings.push(format!(
        "staging_dir {} 不在本地可写根内, 且宿主未返回任何本地可写根",
        settings.staging_dir
    ));
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
                "path": root.path,
                "name": root.name,
                "local": root.local,
                "writable": root.writable,
            })
        })
        .collect();
    json!({
        "ok": probe.ok,
        "error": probe.error,
        "staging_dir": settings.staging_dir,
        "staging_dir_effective": effective,
        "target_dir": settings.target_dir,
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

/// 列暂存目录并取 parent_ref; 404 → `Missing`。
fn entries_parent_ref(staging: &str) -> Result<ParentRef, String> {
    let path = format!("{FILES_ENTRIES}?path={}", netease::query_escape(staging));
    let (status, body) = host_roundtrip("GET", &path, None, None)?;
    if status == 404 {
        return Ok(ParentRef::Missing);
    }
    if !(200..300).contains(&status) {
        return Err(http_error("GET", &path, status, &body));
    }
    let value: Value = serde_json::from_slice(&body)
        .map_err(|err| format!("GET {FILES_ENTRIES} 响应不是 JSON: {err}"))?;
    Ok(match find_ref(&value, 0) {
        Some(reference) if !reference.is_empty() => ParentRef::Found(reference),
        _ => ParentRef::Missing,
    })
}

/// 建目录(`POST /api/plugin-host/files/directories {path}`); 已存在视为成功。
fn create_directory(dir: &str) -> Result<(), String> {
    let body = serde_json::to_vec(&json!({"path": dir})).unwrap_or_default();
    let key = format!("mr-dl-mkdir-{:016x}", fnv_hash(dir.as_bytes()));
    let (status, body) = host_roundtrip("POST", FILES_DIRECTORIES, Some(&body), Some(&key))?;
    if (200..300).contains(&status) || status == 409 {
        return Ok(());
    }
    let text = util::trunc(&body).to_ascii_lowercase();
    if text.contains("exist") || text.contains("已存在") {
        return Ok(());
    }
    Err(http_error("POST", FILES_DIRECTORIES, status, &body))
}

fn fnv_hash(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 确保暂存目录存在并返回其 parent_ref(首次 pump 自动建目录)。
fn ensure_staging(staging: &str) -> Result<String, String> {
    match entries_parent_ref(staging)? {
        ParentRef::Found(reference) => return Ok(reference),
        ParentRef::Missing => {}
    }
    create_directory(staging)?;
    match entries_parent_ref(staging)? {
        ParentRef::Found(reference) => Ok(reference),
        ParentRef::Missing => Err(format!(
            "GET {FILES_ENTRIES} 未返回 parent_ref(path={staging}), 无法提交宿主下载"
        )),
    }
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
        "{} - {}\n来源: {} / 音质: {}\n{}",
        task.singers, task.name, task.source, task.quality, error
    );
    let body = serde_json::to_vec(&json!({
        "level": "error",
        "title": title,
        "body": truncate_chars(&body_text, 1800),
        "buttons": [[{
            "text": "重试",
            "callback_data": format!("{}{}", tasks::RETRY_PREFIX, task.id),
        }]],
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
pub fn request_download(ids: &mut PutIds, request: &DownloadRequest) -> Result<Value, String> {
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
    }))
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
            let staged = match job_result_path(&value) {
                Some(path) => path,
                None if !staging.is_empty() => {
                    join_dir(staging, &format!("{}.part", task.id))
                }
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
    if staging.is_empty() || task.out_name.is_empty() {
        fail_task(
            settings,
            task,
            "缺少暂存目录或目标文件名, 无法复制".to_string(),
            report,
        );
        return;
    }
    let staged = join_dir(staging, &task.out_name);
    match copy_to_cd2(&task.id, &staged, &settings.target_dir, task.attempts) {
        Ok(_) => {
            task.status = tasks::STATUS_DONE.to_string();
            task.job_ref.clear();
            task.error.clear();
            task.updated_ms = tasks::now_ms();
            report.completed.push(task.id.clone());
            report
                .messages
                .push(format!("任务 {} 完成: {}", task.id, task.out_name));
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

/// 推进 KV 任务队列(状态机本体)。
///
/// 顺序对齐 sidecar 的 `pumpQueue`:
/// 1. 先推进在途任务(下载轮询 / 复制重试);
/// 2. 再按 `created_ms` 升序启动排队任务, 直到 `max_active` 个槽位占满;
/// 3. 队列按 `tasks` 键整体落盘(ETag 乐观锁 + 幂等键)。
///
/// 返回摘要 `{staging_dir, staging_error, started, completed, failed, active, messages}`。
pub fn pump(ids: &mut PutIds) -> Result<Value, String> {
    let settings = load_settings();
    let mut queue = tasks::load_result()?;
    queue.sort_by(|left, right| {
        left.created_ms
            .cmp(&right.created_ms)
            .then_with(|| left.id.cmp(&right.id))
    });

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
    let staging_dir = staging.clone().unwrap_or_default();

    // ① 在途任务。
    for task in queue.iter_mut() {
        match task.status.as_str() {
            tasks::STATUS_DOWNLOADING => {
                advance_downloading(&settings, &staging_dir, task, &mut report)
            }
            tasks::STATUS_COPYING => {
                advance_copying(&settings, &staging_dir, task, &mut report)
            }
            _ => {}
        }
    }

    // ② 排队任务(每轮每个任务最多启动一次)。
    let queued_ids: Vec<String> = queue
        .iter()
        .filter(|task| task.status == tasks::STATUS_QUEUED)
        .map(|task| task.id.clone())
        .collect();
    if !queued_ids.is_empty() {
        match staging.as_deref() {
            None => {
                let reason = if staging_error.is_empty() {
                    "暂存目录不可用".to_string()
                } else {
                    staging_error.clone()
                };
                report
                    .messages
                    .push(format!("{} 个排队任务无法启动: {reason}", queued_ids.len()));
            }
            Some(dir) => match ensure_staging(dir) {
                Ok(parent_ref) => {
                    let cap = settings.max_active.max(1) as usize;
                    for id in queued_ids {
                        // 槽位数每轮实时统计: 本轮完成的(下载快)立即释放槽位。
                        let active = queue.iter().filter(|task| task.is_slot()).count();
                        if active >= cap {
                            break;
                        }
                        let index = match queue.iter().position(|task| task.id == id) {
                            Some(index) => index,
                            None => continue,
                        };
                        if queue[index].status != tasks::STATUS_QUEUED {
                            continue;
                        }
                        let task = &mut queue[index];
                        start_task(&settings, &parent_ref, task, &mut report);
                        if task.status == tasks::STATUS_DOWNLOADING {
                            // 取链后立即发起, 发起后立即轮询一次: 宿主任务可能本轮就完成,
                            // 能在一轮里做完的尽量做完(下一次 cron 是 5 分钟后)。
                            advance_downloading(&settings, &staging_dir, task, &mut report);
                        }
                    }
                }
                Err(err) => report
                    .messages
                    .push(format!("暂存目录 {dir} 不可用: {err}")),
            },
        }
    }

    tasks::save(ids, &queue)?;

    Ok(json!({
        "staging_dir": staging,
        "staging_error": staging_error,
        "queued": queue.iter().filter(|task| task.status == tasks::STATUS_QUEUED).count(),
        "active": queue.iter().filter(|task| task.is_slot()).count(),
        "started": report.started,
        "completed": report.completed,
        "failed": report.failed,
        "messages": report.messages,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::{HostCallRequest, HostCallResponse, HostError};
    use base64::Engine as _;
    use std::cell::RefCell;
    use std::collections::{BTreeMap, HashMap};
    use std::rc::Rc;

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
    }

    fn json_response(status: i32, body: &[u8]) -> Result<HostCallResponse, HostError> {
        Ok(HostCallResponse {
            status,
            headers: BTreeMap::new(),
            body_base64: base64::engine::general_purpose::STANDARD_NO_PAD.encode(body),
        })
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
                return kv_response(&mut state, request, key);
            }
            // 网易 eapi 取链: 只解响应, 不校验加密请求。
            if path.starts_with("https://interface3.music.163.com/") {
                return json_response(
                    200,
                    br#"{"data":[{"url":"https://cdn.example.com/song.flac","type":"flac","level":"lossless","size":1024}]}"#,
                );
            }
            if path == FILES_ROOTS {
                return json_response(
                    200,
                    r#"{"roots":[
                        {"path":"/CloudNAS/115open/音乐","name":"音乐","backend":"local","writable":true},
                        {"path":"/mnt/cd2","name":"CD2","backend":"cd2","writable":true}
                    ]}"#
                    .as_bytes(),
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
        assert!(state.created_dir, "首次 pump 必须自动建暂存目录");
        assert_eq!(state.entries_calls, 2, "第一次 entries 404 后建目录再查一次");
        assert_eq!(state.downloads.len(), 1);
        assert_eq!(state.downloads[0]["name"], format!("{task_id}.part"));
        assert_eq!(state.downloads[0]["parent_ref"], "dir-ref-7");
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

        let tasks = tasks::load();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].status, tasks::STATUS_DONE);
        assert_eq!(tasks[0].out_name, "周杰伦 - 晴天.flac");
        assert_eq!(tasks[0].attempts, 1);
        assert!(tasks[0].error.is_empty());
    }

    #[test]
    fn pump_retries_three_times_then_notifies_with_retry_button() {
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

        let tasks = tasks::load();
        assert_eq!(tasks[0].status, tasks::STATUS_FAILED);
        assert_eq!(tasks[0].attempts, MAX_ATTEMPTS);
        assert_eq!(tasks[0].error, "CDN 403");

        let state = fake.borrow();
        assert_eq!(state.notifications.len(), 1, "只通知一次");
        let notice = &state.notifications[0];
        assert_eq!(notice["level"], "error");
        assert!(notice["title"].as_str().unwrap().contains("晴天"));
        assert!(notice["body"].as_str().unwrap().contains("CDN 403"));
        assert_eq!(notice["buttons"][0][0]["text"], "重试");
        assert_eq!(notice["buttons"][0][0]["callback_data"], format!("retry:{task_id}"));
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
        let retried = tasks::load();
        assert_eq!(retried[0].attempts, 0);
        assert_eq!(retried[0].retry_round, 1);
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
        // callback_data 仍指向同一个任务, 便于重试按钮路由。
        assert_eq!(second["buttons"][0][0]["callback_data"], format!("retry:{task_id}"));
    }

    #[test]
    fn effective_staging_requires_local_writable_root() {
        let settings = Settings::default();
        // 默认路径在 CD2 根下 → 回退到第一个本地根。
        let probe = RootsProbe {
            ok: true,
            error: String::new(),
            roots: vec![
                Root { path: "/CloudNAS/115open/音乐".into(), name: "音乐".into(), local: false, writable: true },
                Root { path: "/volume1/music".into(), name: "本地".into(), local: true, writable: true },
            ],
        };
        let (dir, warnings) = effective_staging(&settings, &probe);
        assert_eq!(dir.as_deref(), Some("/volume1/music/音乐下载"));
        assert_eq!(warnings.len(), 1, "{warnings:?}");

        // 默认路径在本地根下 → 原样使用。
        let probe = RootsProbe {
            ok: true,
            error: String::new(),
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

        // 只有 CD2 根 → 无可用暂存目录。
        let probe = RootsProbe {
            ok: true,
            error: String::new(),
            roots: vec![Root { path: "/mnt/cd2".into(), name: "CD2".into(), local: false, writable: true }],
        };
        let (dir, warnings) = effective_staging(&settings, &probe);
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
        assert_eq!(view["staging_dir"], "/data/dl");
        assert_eq!(view["target_dir"], "/mnt/target");
        assert_eq!(view["quality"], "lossless");
        assert_eq!(view["max_active"], DEFAULT_MAX_ACTIVE, "0 视为非法, 回默认");
        assert_eq!(view["notify_on_fail"], false);
        assert!(view.get("unknown").is_none());

        // 落 KV 后重新读出。
        let reloaded = load_settings();
        assert_eq!(reloaded.staging_dir, "/data/dl");
        assert_eq!(reloaded.quality, "lossless");
        assert!(!reloaded.notify_on_fail);
        drop(fake);
    }
}
