//! 宿主存储 KV 适配层(对照 Go `wasm.go:134` 的存储段 + `loadStateWithRetry`/
//! `storageStatus`/`decodeBody`)。
//!
//! # 宿主契约
//!
//! - `GET  /api/plugin-runtime/storage/:key` → 200 + 响应头 `ETag: "pkv_N"`,
//!   body 是 `StorageValueEnvelope`: `{"data":{"key":..,"value":<值>,"revision":"pkv_N",..},"meta":..}`;
//!   键不存在 → 404。
//! - `PUT` 同路径, body 必须是 `{"value": <值>}`; 已存在的键要带 `If-Match: <ETag>`
//!   (乐观锁, 对不上 → 412); `Idempotency-Key` 必填且每次写入唯一(16~128 个可打印 ASCII)。
//! - `body_base64` 是不补 padding 的 base64, 但解码要同时兼容补 padding 的形态。
//!
//! 信封解包保留三级回退(`data.value` → 顶层 `value` → 裸值, 见 [`unwrap_value`])。
//!
//! # 幂等键前缀
//!
//! 幂等键 `"<PREFIX>-<key>-<nonce>-<seq>"` 的前缀有宿主语义(同时出现在已部署实例的
//! 幂等键空间里), 因此由各插件通过 [`IdPrefix`] marker 提供:
//! `mr-put`(music) / `chase-put`(chase) / `dc-put`(douban)。
//! 插件 wrapper 里 `pub type PutIds = common::store::PutIds<Marker>;` 保持所有
//! `PutIds::new()` 调用点(含 const static)零改动。

use std::marker::PhantomData;

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::value::RawValue;

use crate::clock;
use crate::host::{self, HostCallRequest, HostCallResponse, HostError};
use crate::util;

/// 状态文档键。
pub const STATE_KEY: &str = "state";
/// 账号配置键: 只有 settings-update 写它, 大状态被竞态冲掉也带不走账号配置。
pub const ACCOUNT_KEY: &str = "account";
/// 诊断面包屑键。
pub const DIAG_KEY: &str = "diag";

/// 宿主存储键的路径前缀(`GET`/`PUT` 共用)。
const STORAGE_PATH_PREFIX: &str = "/api/plugin-runtime/storage/";

/// 存储键的 URL 路径。
pub fn storage_path(key: &str) -> String {
    format!("{STORAGE_PATH_PREFIX}{key}")
}

/// 存储层错误(Go 的 `error`, 文案逐字对齐: `storage PUT HTTP 500: ...`)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreError(pub String);

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for StoreError {}

impl From<HostError> for StoreError {
    fn from(err: HostError) -> Self {
        StoreError(err.0)
    }
}

/// `GET` 的结果(Go `wasmStorageRead` 的三返回值 `([]byte, etag string, ok bool)`)。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StorageRead {
    /// 剥掉信封后的值; 读取失败时为空。
    pub value: Vec<u8>,
    /// 响应头里的 ETag(大小写不敏感); 没有就是空串。
    pub etag: String,
    /// HTTP 200 且 body 解出来 —— Go 里 `ok` 只看这两点(空值也算成功)。
    pub ok: bool,
}

/// 状态文档的加载三态(对照 Go `main.go` 的 iota 常量)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadResult {
    /// 成功读到状态文档。
    Loaded,
    /// 两次 404 确认的全新安装。
    Fresh,
    /// 不确定(宿主不可读): 禁止落盘, 避免默认值覆盖用户数据。
    Unavailable,
}

impl LoadResult {
    /// 写进诊断面包屑的字符串。
    pub fn name(self) -> &'static str {
        match self {
            LoadResult::Loaded => "loaded",
            LoadResult::Fresh => "fresh",
            LoadResult::Unavailable => "unavailable",
        }
    }
}

/// 幂等键前缀的插件 marker: `const PREFIX` 必须与已部署实例的键空间一致。
pub trait IdPrefix {
    /// 例如 `"mr-put"` / `"chase-put"` / `"dc-put"`。
    const PREFIX: &'static str;
}

/// 幂等键序列(Go 版 `wasm.go` 的 `sessionNonce` + `idCounter`)。
///
/// 每次写入取号, 保证"同一会话内每次写入拿到的键不同"。跨会话靠
/// [`clock::session_nonce`] 拉开(宿主保留 24h 幂等记录, 新 worker 从 0 开始计数
/// 会撞上旧会话)。
///
/// `PhantomData<fn() -> P>` 不把 `P` 的自动 trait 带到 `PutIds` 上(尤其 `Send`),
/// 因此 const `static Mutex<PutIds>` 的既有写法保持不变。
pub struct PutIds<P: IdPrefix> {
    seq: u64,
    _marker: PhantomData<fn() -> P>,
}

impl<P: IdPrefix> PutIds<P> {
    pub const fn new() -> Self {
        PutIds {
            seq: 0,
            _marker: PhantomData,
        }
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// 生成本次写入的幂等键: `<PREFIX>-<key>-<nonce>-<seq>`
    /// (长度与字符集满足宿主 16~128 可打印 ASCII 的约束)。
    pub fn next_key(&mut self, key: &str) -> String {
        self.seq += 1;
        format!(
            "{}-{key}-{}-{}",
            P::PREFIX,
            clock::session_nonce(),
            self.seq
        )
    }
}

impl<P: IdPrefix> std::fmt::Debug for PutIds<P> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PutIds").field("seq", &self.seq).finish()
    }
}

impl<P: IdPrefix> Clone for PutIds<P> {
    fn clone(&self) -> Self {
        PutIds {
            seq: self.seq,
            _marker: PhantomData,
        }
    }
}

impl<P: IdPrefix> Default for PutIds<P> {
    fn default() -> Self {
        PutIds::new()
    }
}

fn get_request(key: &str) -> HostCallRequest {
    HostCallRequest::new("GET", storage_path(key)).with_header("accept", "application/json")
}

/// 发起一次 host.call(存储层唯一的出口, 测试里被 `host` 的替身接管)。
fn host_call(request: &HostCallRequest) -> Result<HostCallResponse, HostError> {
    host::call(request)
}

/// 响应头里按名字取第一个值(大小写不敏感, 值列表为空则继续找同名的其他条目)。
pub fn header_first<'a>(
    headers: &'a std::collections::BTreeMap<String, Vec<String>>,
    name: &str,
) -> Option<&'a str> {
    let mut matched: Vec<&Vec<String>> = headers
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, values)| values)
        .collect();
    // BTreeMap 的键序是确定的(大写在前); Go 遍历 map 的顺序随机, 这里取确定顺序里
    // 第一个非空值列表, 结果稳定且与 Go 的常见情形一致。
    matched.sort_by_key(|values| values.is_empty());
    matched
        .first()
        .and_then(|values| values.first())
        .map(String::as_str)
}

/// 解出 `body_base64`(Go `decodeBody`)。
///
/// 顺序与 Go 一致: 先按 **RawStd**(不补 padding)解, 失败再按 **Std**(补 padding)解。
/// 宿主文档说响应是"unpadded base64", 但补了 padding 的也必须能读。
pub fn decode_body(response: &HostCallResponse) -> Result<Vec<u8>, StoreError> {
    if response.body_base64.is_empty() {
        return Ok(Vec::new());
    }
    if let Ok(bytes) = STANDARD_NO_PAD.decode(&response.body_base64) {
        return Ok(bytes);
    }
    if let Ok(bytes) = STANDARD.decode(&response.body_base64) {
        return Ok(bytes);
    }
    Err(StoreError("base64 解码失败".to_string()))
}

/// 信封里的一个字段: **键出现就算"有值"**, `null` 也落成 `RawValue::NULL`。
///
/// Go 的 `json.RawMessage` 会原样收下 `null` 这 4 个字节; 而 serde 对
/// `Option<&RawValue>` 会把 `null` 提前吃成 `None`, 分不清"字段缺失"与"值为 null"。
/// `deserialize_with` 绕开 Option 的 null 短路, `default` 负责"字段缺失 → None"。
fn raw_field<'de, D>(deserializer: D) -> Result<Option<Box<RawValue>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(Box::<RawValue>::deserialize(deserializer)?))
}

/// 信封里的 `data` 对象(Go 内层匿名结构体: 只认 `value`)。
#[derive(Deserialize)]
struct StorageEnvelopeData {
    #[serde(default, deserialize_with = "raw_field")]
    value: Option<Box<RawValue>>,
}

#[derive(Deserialize)]
struct StorageEnvelope {
    #[serde(default, deserialize_with = "raw_field")]
    value: Option<Box<RawValue>>,
    // `data` 只有两态有意义: 缺失/null 都是零值结构体(回退顶层 value),
    // 非对象则 Go 的解包失败(→ 原样返回), 交给 serde 的类型检查即可。
    #[serde(default)]
    data: Option<StorageEnvelopeData>,
}

/// 剥掉宿主存储响应的信封(Go `unwrapStorageValue`)。
///
/// 三级回退: `data.value` → 顶层 `value` → 原样返回。
/// `null` 也是"有值"(Go 的 `json.RawMessage` 会记下 `null` 这 4 个字节), 这里同样
/// 返回 `null` 文本, 让上层按普通 JSON 处理。
///
/// 顶层必须是对象才可能是信封: Go 的 `json.Unmarshal` 把数组解进结构体会直接报错
/// (→ 原样返回); serde 的派生实现却会按"序列 → 结构体"把 `[a]` 解成 `value=a` ——
/// 任务队列这种顶层数组会被静默截成第一个元素, 因此这里显式挡掉非对象输入。
///
/// 字段视图用 `RawValue`(Go `json.RawMessage` 的等价物): 只收这一小段原文,
/// **不为整篇文档建树** —— 状态文档越大, 省掉这棵树的内存收益越明显。
pub fn unwrap_value(raw: &[u8]) -> Vec<u8> {
    if raw.is_empty() {
        return Vec::new();
    }
    let first = raw.iter().find(|byte| !byte.is_ascii_whitespace());
    if !matches!(first, Some(b'{')) {
        return raw.to_vec();
    }
    let envelope: StorageEnvelope = match serde_json::from_slice(raw) {
        Ok(envelope) => envelope,
        // 不是合法 JSON: Go 的 Unmarshal 失败分支 → 原样返回
        Err(_) => return raw.to_vec(),
    };
    if let Some(value) = envelope
        .data
        .as_ref()
        .and_then(|data| data.value.as_deref())
    {
        if !value.get().is_empty() {
            return value.get().as_bytes().to_vec();
        }
    }
    if let Some(value) = envelope.value.as_deref() {
        if !value.get().is_empty() {
            return value.get().as_bytes().to_vec();
        }
    }
    raw.to_vec()
}

/// 读取键值并返回宿主给出的 ETag(Go `wasmStorageRead`)。
pub fn read(key: &str) -> StorageRead {
    let response = match host_call(&get_request(key)) {
        Ok(response) => response,
        Err(_) => return StorageRead::default(),
    };
    if response.status != 200 {
        return StorageRead::default();
    }
    let etag = header_first(&response.headers, "etag")
        .unwrap_or_default()
        .to_string();
    let raw = match decode_body(&response) {
        Ok(raw) => raw,
        Err(_) => {
            return StorageRead {
                value: Vec::new(),
                etag,
                ok: false,
            }
        }
    };
    let value = unwrap_value(&raw);
    if !value.is_empty() {
        return StorageRead {
            value,
            etag,
            ok: true,
        };
    }
    StorageRead {
        value: raw,
        etag,
        ok: true,
    }
}

/// Go `wasmStorageGet`: 只要值, 不关心 ETag。
pub fn get(key: &str) -> (Vec<u8>, bool) {
    let read = read(key);
    (read.value, read.ok)
}

/// 读取并解析一个 JSON 值(键不存在 / 解析失败 → `None`)。
///
/// 供自管键(`settings` / `tasks`)使用: 这些键的值由本插件写入, 形状固定;
/// 读不到或解不出时调用方按默认值处理(而不是 panic)。
pub fn get_json<T: serde::de::DeserializeOwned>(key: &str) -> Option<T> {
    let (raw, ok) = get(key);
    if !ok || raw.is_empty() {
        return None;
    }
    serde_json::from_slice(&raw).ok()
}

/// 序列化并写入一个 JSON 值(经 ETag 乐观锁 + 幂等键, 见 [`put`])。
pub fn put_json<P: IdPrefix, T: serde::Serialize>(
    ids: &mut PutIds<P>,
    key: &str,
    value: &T,
) -> Result<(), StoreError> {
    let body =
        serde_json::to_vec(value).map_err(|err| StoreError(format!("JSON 序列化失败: {err}")))?;
    put(ids, key, &body)
}

/// 直接探测存储键的 HTTP 状态(Go `storageStatus`): 区分 404 与瞬态错误。
pub fn status(key: &str) -> i32 {
    match host_call(&get_request(key)) {
        Ok(response) => response.status,
        Err(_) => 0,
    }
}

/// 组装 PUT 请求体 `{"value": <原始 JSON 字节>}`(Go 用 `map[string]json.RawMessage`
/// 得到同样形状)。值为空时返回空 body(Go 在 `json.RawMessage("")` 上 Marshal 会报错,
/// 出错后 body 是 nil, 最终发出一个没有 body 的 PUT; 这里保持同样的可观察行为)。
pub fn put_body(value: &[u8]) -> Vec<u8> {
    if value.is_empty() {
        return Vec::new();
    }
    let mut body = Vec::with_capacity(value.len() + 12);
    body.extend_from_slice(br#"{"value":"#);
    body.extend_from_slice(value);
    body.push(b'}');
    body
}

fn send_put<P: IdPrefix>(
    ids: &mut PutIds<P>,
    key: &str,
    body: &[u8],
    if_match: &str,
) -> Result<HostCallResponse, StoreError> {
    let mut request = HostCallRequest::new("PUT", storage_path(key))
        .with_header("content-type", "application/json")
        .with_header("accept", "application/json")
        .with_header("idempotency-key", ids.next_key(key));
    if !if_match.is_empty() {
        request
            .headers
            .insert("if-match".to_string(), if_match.to_string());
    }
    if !body.is_empty() {
        // Go: base64.RawStdEncoding(不带 padding)
        request = request.with_body_base64(STANDARD_NO_PAD.encode(body));
    }
    host_call(&request).map_err(StoreError::from)
}

/// 写入键值(Go `wasmStoragePut`)。
///
/// 流程与 Go 一致: 先读一次拿 ETag(键存在时不带 `If-Match` 会被宿主按
/// 乐观锁拒绝), 带 `If-Match` + 全新幂等键 PUT; 若返回 412(ETag 过期/并发写入)
/// 则重读 ETag **重试一次**; 仍 >= 400 就报错。
pub fn put<P: IdPrefix>(ids: &mut PutIds<P>, key: &str, value: &[u8]) -> Result<(), StoreError> {
    let body = put_body(value);
    let current = read(key);
    let mut response = send_put(ids, key, &body, &current.etag)?;
    if response.status == 412 && current.ok {
        let fresh = read(key);
        if fresh.ok {
            response = send_put(ids, key, &body, &fresh.etag)?;
        }
    }
    if response.status >= 400 {
        let detail = match decode_body(&response) {
            Ok(raw) if !raw.is_empty() => format!(": {}", util::trunc(&raw)),
            _ => String::new(),
        };
        return Err(StoreError(format!(
            "storage PUT HTTP {}{}",
            response.status, detail
        )));
    }
    Ok(())
}

/// 删除一个键(KV `DELETE /api/plugin-runtime/storage/:key`)。
///
/// 分片队列清完结任务时逐条删 `task.<id>`; 迁移成功时删旧键 `tasks`。
/// 键不存在按成功处理(404 = 已经不在了), 与 Go 侧删除幂等的预期一致。
pub fn delete<P: IdPrefix>(ids: &mut PutIds<P>, key: &str) -> Result<(), StoreError> {
    let request = HostCallRequest::new("DELETE", storage_path(key))
        .with_header("accept", "application/json")
        .with_header("idempotency-key", ids.next_key(key));
    let response = host_call(&request)?;
    if response.status == 404 || response.status < 400 {
        return Ok(());
    }
    let detail = match decode_body(&response) {
        Ok(raw) if !raw.is_empty() => format!(": {}", util::trunc(&raw)),
        _ => String::new(),
    };
    Err(StoreError(format!(
        "storage DELETE HTTP {}{}",
        response.status, detail
    )))
}

/// 读取状态并做 3 次重试(Go `loadStateWithRetry`)。
///
/// - 读到非空值 → [`LoadResult::Loaded`];
/// - 404 需间隔 300ms **两次确认**(宿主重启风暴里存储会瞬时 404, 单次就当全新安装
///   会让默认值合法覆盖用户数据) → [`LoadResult::Fresh`];
/// - 其余失败一律 200ms 后重试, 3 次都不行 → [`LoadResult::Unavailable`]。
pub fn load_state_with_retry() -> (Option<Vec<u8>>, LoadResult) {
    for _ in 0..3 {
        let (raw, ok) = get(STATE_KEY);
        if ok && !raw.is_empty() {
            return (Some(raw), LoadResult::Loaded);
        }
        if status(STATE_KEY) == 404 {
            clock::sleep_ms(300);
            if status(STATE_KEY) == 404 {
                return (None, LoadResult::Fresh);
            }
        }
        clock::sleep_ms(200);
    }
    (None, LoadResult::Unavailable)
}

/// 旧版分键持久化的键名(Go `pathToKey`: `.data/history.json` → `history`)。
pub fn legacy_keys() -> [&'static str; 7] {
    [
        "settings",
        "snapshot",
        "queue",
        "history",
        "logs",
        "stats",
        "blackstate",
    ]
}

/// `.data/<name>.json` → 存储键(Go `pathToKey` 的移植, 供迁移与测试对照)。
pub fn path_to_key(path: &str) -> String {
    let path = path.strip_prefix('/').unwrap_or(path);
    let path = path.strip_prefix(".data/").unwrap_or(path);
    path.strip_suffix(".json").unwrap_or(path).to_string()
}
