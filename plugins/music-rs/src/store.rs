//! 宿主存储 KV 适配层(对照 douban-rs `src/store.rs` 的存储段, 已剥离豆瓣业务)。
//!
//! # 宿主契约(与 douban-rs 完全相同)
//!
//! - `GET  /api/plugin-runtime/storage/:key` → 200 + 响应头 `ETag: "pkv_N"`,
//!   body 是 `StorageValueEnvelope`: `{"data":{"key":..,"value":<值>,"revision":"pkv_N",..},"meta":..}`;
//!   键不存在 → 404。
//! - `PUT` 同路径, body 必须是 `{"value": <值>}`; 已存在的键要带 `If-Match: <ETag>`
//!   (乐观锁, 对不上 → 412); `Idempotency-Key` 必填且每次写入唯一(16~128 个可打印 ASCII)。
//! - `body_base64` 是不补 padding 的 base64, 但解码要同时兼容补 padding 的形态。
//!
//! 信封解包保留三级回退(`data.value` → 顶层 `value` → 裸值, 见 [`unwrap_value`]),
//! 对齐 douban-rs 里记录过的宿主信封差异。

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::value::RawValue;

use crate::clock;
use crate::host::{self, HostCallRequest, HostCallResponse, HostError};
use crate::util;

/// 状态文档键。音乐下载插件的任务队列、会话与设置全部落在这一个键上。
pub const STATE_KEY: &str = "state";
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

/// 幂等键序列(Go 版 `wasm.go` 的 `sessionNonce` + `idCounter`)。
///
/// 每次写入取号, 保证"同一会话内每次写入拿到的键不同"。跨会话靠
/// [`clock::session_nonce`] 拉开(宿主保留 24h 幂等记录, 新 worker 从 0 开始计数
/// 会撞上旧会话)。
#[derive(Debug, Clone, Default)]
pub struct PutIds {
    seq: u64,
}

impl PutIds {
    pub const fn new() -> Self {
        PutIds { seq: 0 }
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// 生成本次写入的幂等键: `mr-put-<key>-<nonce>-<seq>`
    /// (长度与字符集满足宿主 16~128 可打印 ASCII 的约束)。
    pub fn next_key(&mut self, key: &str) -> String {
        self.seq += 1;
        format!("mr-put-{key}-{}-{}", clock::session_nonce(), self.seq)
    }
}

fn get_request(key: &str) -> HostCallRequest {
    HostCallRequest::new("GET", storage_path(key)).with_header("accept", "application/json")
}

/// 发起一次 host.call(存储层唯一的出口, 测试里被 [`crate::host`] 的替身接管)。
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
    matched.first().and_then(|values| values.first()).map(String::as_str)
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
/// 字段视图用 `RawValue`(Go `json.RawMessage` 的等价物): 只收这一小段原文,
/// **不为整篇文档建树** —— 状态文档越大, 省掉这棵树的内存收益越明显
/// (manifest `runtime.memory_mb` 的预算直接受益)。
pub fn unwrap_value(raw: &[u8]) -> Vec<u8> {
    if raw.is_empty() {
        return Vec::new();
    }
    // 顶层必须是对象才可能是信封。Go 的 `json.Unmarshal` 把数组解进结构体会直接报错
    // (→ 原样返回); serde 的派生实现却会按"序列 → 结构体"把 `[a]` 解成 `value=a`——
    // 任务队列这种顶层数组会被静默截成第一个元素, 因此这里显式挡掉非对象输入。
    let first = raw.iter().find(|byte| !byte.is_ascii_whitespace());
    if !matches!(first, Some(b'{')) {
        return raw.to_vec();
    }
    let envelope: StorageEnvelope = match serde_json::from_slice(raw) {
        Ok(envelope) => envelope,
        // 不是合法 JSON: Go 的 Unmarshal 失败分支 → 原样返回
        Err(_) => return raw.to_vec(),
    };
    if let Some(value) = envelope.data.as_ref().and_then(|data| data.value.as_deref()) {
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
    let etag = header_first(&response.headers, "etag").unwrap_or_default().to_string();
    let raw = match decode_body(&response) {
        Ok(raw) => raw,
        Err(_) => return StorageRead { value: Vec::new(), etag, ok: false },
    };
    let value = unwrap_value(&raw);
    if !value.is_empty() {
        return StorageRead { value, etag, ok: true };
    }
    StorageRead { value: raw, etag, ok: true }
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
pub fn put_json<T: serde::Serialize>(ids: &mut PutIds, key: &str, value: &T) -> Result<(), StoreError> {
    let body = serde_json::to_vec(value)
        .map_err(|err| StoreError(format!("JSON 序列化失败: {err}")))?;
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

fn send_put(
    ids: &mut PutIds,
    key: &str,
    body: &[u8],
    if_match: &str,
) -> Result<HostCallResponse, StoreError> {
    let mut request = HostCallRequest::new("PUT", storage_path(key))
        .with_header("content-type", "application/json")
        .with_header("accept", "application/json")
        .with_header("idempotency-key", ids.next_key(key));
    if !if_match.is_empty() {
        request.headers.insert("if-match".to_string(), if_match.to_string());
    }
    if !body.is_empty() {
        // Go: base64.RawStdEncoding(不带 padding)
        request = request.with_body_base64(STANDARD_NO_PAD.encode(body));
    }
    host_call(&request).map_err(StoreError::from)
}

/// 写入键值(Go `wasmStoragePut`)。
///
/// 流程与 douban-rs 一致: 先读一次拿 ETag(键存在时不带 `If-Match` 会被宿主按
/// 乐观锁拒绝), 带 `If-Match` + 全新幂等键 PUT; 若返回 412(ETag 过期/并发写入)
/// 则重读 ETag **重试一次**; 仍 >= 400 就报错。
pub fn put(ids: &mut PutIds, key: &str, value: &[u8]) -> Result<(), StoreError> {
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
        return Err(StoreError(format!("storage PUT HTTP {}{}", response.status, detail)));
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn response(body: &[u8], padded: bool) -> HostCallResponse {
        let encoded = if padded {
            STANDARD.encode(body)
        } else {
            STANDARD_NO_PAD.encode(body)
        };
        HostCallResponse { status: 200, headers: Default::default(), body_base64: encoded }
    }

    #[test]
    fn decode_body_accepts_raw_and_std_padding() {
        for body in [
            b"".to_vec(),
            b"x".to_vec(),
            b"{\"tasks\":[],\"settings\":{}}".to_vec(),
            vec![0u8, 1, 2, 250, 251, 252, 253, 254, 255],
        ] {
            for padded in [false, true] {
                let decoded = decode_body(&response(&body, padded)).unwrap();
                assert_eq!(decoded, body, "padded={padded}");
            }
        }
        let empty = HostCallResponse { status: 200, headers: Default::default(), body_base64: String::new() };
        assert_eq!(decode_body(&empty).unwrap(), Vec::<u8>::new());

        let bad = HostCallResponse {
            status: 200,
            headers: Default::default(),
            body_base64: "!!!not base64!!!".to_string(),
        };
        assert!(decode_body(&bad).is_err());
    }

    /// 信封三态: `data.value` → 顶层 `value` → 裸值, 以及 `null` 边界。
    #[test]
    fn unwrap_value_tiers() {
        let envelope = r#"{
          "data": {
            "key": "state",
            "value": {"tasks":[{"id":"t1"}],"settings":{"level":"flac"}},
            "revision": "pkv_248"
          },
          "meta": {"plugin_id": "music.rs"}
        }"#;
        assert_eq!(
            String::from_utf8(unwrap_value(envelope.as_bytes())).unwrap(),
            r#"{"tasks":[{"id":"t1"}],"settings":{"level":"flac"}}"#
        );

        let legacy = r#"{"value":{"a":1}}"#;
        assert_eq!(String::from_utf8(unwrap_value(legacy.as_bytes())).unwrap(), r#"{"a":1}"#);

        let bare = r#"{"tasks":[]}"#;
        assert_eq!(String::from_utf8(unwrap_value(bare.as_bytes())).unwrap(), bare);

        assert_eq!(unwrap_value(b""), Vec::<u8>::new());
        assert_eq!(String::from_utf8(unwrap_value(br#"{"value":null}"#)).unwrap(), "null");
        assert_eq!(String::from_utf8(unwrap_value(br#"{"data":{"value":1},"value":2}"#)).unwrap(), "1");
        assert_eq!(unwrap_value(b"[1,2]"), b"[1,2]");
        // 回归: `[{"id":"t1"}]` 这类顶层数组, serde 的"序列 → 结构体"会把信封解成
        // `value = {"id":"t1"}`, 静默截掉数组外壳(任务队列就长这样)。
        let array = br#"[{"id":"t1","status":"queued"}]"#;
        assert_eq!(unwrap_value(array), array);
        assert_eq!(unwrap_value(b"  []"), b"  []");
        assert_eq!(unwrap_value(b"not json"), b"not json");
        assert_eq!(unwrap_value(br#"{"value":"x"}"#), b"\"x\"");
    }

    #[test]
    fn etag_header_lookup_is_case_insensitive() {
        let mut headers = std::collections::BTreeMap::new();
        headers.insert("ETag".to_string(), vec!["\"pkv_7\"".to_string()]);
        assert_eq!(header_first(&headers, "etag"), Some("\"pkv_7\""));
        assert_eq!(header_first(&headers, "ETAG"), Some("\"pkv_7\""));

        let mut headers = std::collections::BTreeMap::new();
        headers.insert("Etag".to_string(), Vec::<String>::new());
        headers.insert("etag".to_string(), vec!["\"pkv_9\"".to_string()]);
        assert_eq!(header_first(&headers, "etag"), Some("\"pkv_9\""));

        let empty: std::collections::BTreeMap<String, Vec<String>> = Default::default();
        assert_eq!(header_first(&empty, "etag"), None);
    }

    #[test]
    fn put_body_is_value_wrapped() {
        assert_eq!(put_body(br#"{"a":1}"#), br#"{"value":{"a":1}}"#);
        assert_eq!(put_body(b""), Vec::<u8>::new());
    }

    /// 幂等键必须唯一、带前缀, 且长度落在宿主允许的 16~128 个可打印 ASCII。
    #[test]
    fn put_ids_are_unique_and_host_safe() {
        let mut ids = PutIds::new();
        let a = ids.next_key("state");
        let b = ids.next_key("state");
        let c = ids.next_key("diag");
        assert_ne!(a, b);
        assert_ne!(b, c);
        assert!(a.starts_with("mr-put-state-"));
        assert!(c.starts_with("mr-put-diag-"));
        for id in [&a, &b, &c] {
            assert!((16..=128).contains(&id.len()), "幂等键长度越界: {id}");
            assert!(id.bytes().all(|byte| byte.is_ascii_graphic()), "必须全是可打印 ASCII: {id}");
        }
        assert_eq!(ids.seq(), 3);
    }
}
