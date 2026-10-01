//! 宿主存储 KV 适配层(从 douban-rs 的 `store.rs` 裁剪: 只留 `state` 单键读写)。
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
//! # 信封解包
//!
//! 宿主把值包在 `data.value` 里, 早期宿主版本只给顶层 `value`, 还有裸值形态。
//! [`unwrap_value`] 按"先 `data.value`, 再顶层 `value`, 都不是就当裸值"三级回退处理。
//!
//! # 本轮范围
//!
//! 只有 `state` 一个键(追剧对齐的整份状态文档)。douban-rs 里的 `account`/`diag` 分键、
//! 旧版 `.data/*.json` 迁移与 `path_to_key` 都随业务一起删掉了。

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::value::RawValue;

use crate::clock;
use crate::host::{self, HostCallRequest, HostCallResponse, HostError};

/// 状态文档键(插件持久化的单键)。
pub const STATE_KEY: &str = "state";

/// 宿主存储键的路径前缀(`GET`/`PUT` 共用)。
const STORAGE_PATH_PREFIX: &str = "/api/plugin-runtime/storage/";

/// 存储键的 URL 路径。
pub fn storage_path(key: &str) -> String {
    format!("{STORAGE_PATH_PREFIX}{key}")
}

/// 存储层错误(文案形如 `storage PUT HTTP 500: ...`)。
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

/// 状态加载的三态(Go `main.go:255` 的 iota 常量)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadResult {
    /// 成功读到状态文档。
    Loaded,
    /// 两次 404 确认的全新安装。
    Fresh,
    /// 不确定(宿主不可读): 禁止落盘, 避免默认值覆盖用户配置。
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

/// 幂等键序列(Go `wasm.go:18` 的 `sessionNonce` + 计数器)。
///
/// 每次写入取号 —— 保证"同一会话内每次写入拿到的键不同"。跨会话靠
/// [`clock::session_nonce`] 拉开(宿主保留 24h 幂等记录, 新 worker 从 0 开始计数会撞上
/// 旧会话, 同一个 key + 不同指纹 → 412 `idempotency_conflict`)。
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

    /// 生成本次写入的幂等键: `chase-put-<key>-<nonce>-<seq>`。
    pub fn next_key(&mut self, key: &str) -> String {
        self.seq += 1;
        format!("chase-put-{key}-{}-{}", clock::session_nonce(), self.seq)
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
    // 第一个非空值列表, 结果稳定。
    matched.sort_by_key(|values| values.is_empty());
    matched.first().and_then(|values| values.first()).map(String::as_str)
}

/// 解出 `body_base64`。
///
/// 顺序与 Go 一致: 先按 **RawStd**(不补 padding)解, 失败再按 **Std**(补 padding)解。
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

/// 错误细节按 200 字节截断(对应 Go `wasm.go:244` 的 `trunc`)。
fn trunc(bytes: &[u8]) -> String {
    const LIMIT: usize = 200;
    let n = bytes.len().min(LIMIT);
    String::from_utf8_lossy(&bytes[..n]).into_owned()
}

/// 信封里的一个字段: **键出现就算"有值"**, `null` 也落成 `RawValue::NULL`。
///
/// Go 的 `json.RawMessage` 会原样收下 `null` 这 4 个字节(解出来非空 → 直接返回
/// `null` 文本); 而 serde 对 `Option<&RawValue>` 会把 `null` 提前吃成 `None`, 分不清
/// "字段缺失"与"值为 null"。`deserialize_with` 绕开 Option 的 null 短路,
/// `default` 负责"字段缺失 → None", 两种形态都可区分。
fn raw_field<'de, D>(deserializer: D) -> Result<Option<Box<RawValue>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(Box::<RawValue>::deserialize(deserializer)?))
}

/// 信封里的 `data` 对象(只认 `value`)。
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

/// 剥掉宿主存储响应的信封(Go `wasm.go:171` `unwrapStorageValue`)。
///
/// 三级回退: `data.value` → 顶层 `value` → 原样返回。
/// `null` 也是"有值"; 非法 JSON 或顶层不是对象时原样返回。
///
/// 字段视图用 `RawValue`(Go `json.RawMessage` 的等价物): 只收这一小段原文,
/// **不为整篇状态文档建树** —— `put()` 每次写入前都要先 `read()` 拿 ETag, 在
/// wasm 解释器 + manifest `memory_mb` 的预算下, 省掉这棵树是落盘路径上最直接的
/// 内存/CPU 收益。
pub fn unwrap_value(raw: &[u8]) -> Vec<u8> {
    if raw.is_empty() {
        return Vec::new();
    }
    let envelope: StorageEnvelope = match serde_json::from_slice(raw) {
        Ok(envelope) => envelope,
        // 不是合法 JSON / 顶层不是对象: Go 的 Unmarshal 失败分支 → 原样返回
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

/// 读取键值并返回宿主给出的 ETag。
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

/// 只要值, 不关心 ETag。
pub fn get(key: &str) -> (Vec<u8>, bool) {
    let read = read(key);
    (read.value, read.ok)
}

/// 直接探测存储键的 HTTP 状态: 区分 404 与瞬态错误。
pub fn status(key: &str) -> i32 {
    match host_call(&get_request(key)) {
        Ok(response) => response.status,
        Err(_) => 0,
    }
}

/// 组装 PUT 请求体 `{"value": <原始 JSON 字节>}`。
///
/// 值为空时返回空 body —— Go 在 `json.RawMessage("")` 上 Marshal 会报错, 出错后
/// `body` 是 nil, 最终发出一个没有 body 的 PUT; 这里保持同样的可观察行为。
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
        // Go `wasm.go:210`: base64.RawStdEncoding(不带 padding)
        request = request.with_body_base64(STANDARD_NO_PAD.encode(body));
    }
    host_call(&request).map_err(StoreError::from)
}

/// 写入键值(Go `wasm.go:198` `wasmStoragePut`)。
///
/// 流程: 先读一次拿 ETag(键存在时不带 `If-Match` 会被宿主按乐观锁拒绝),
/// 带 `If-Match` + 全新幂等键 PUT; 若返回 412(ETag 过期/并发写入)则重读 ETag
/// **重试一次**; 仍 >= 400 就报错。
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
            Ok(raw) if !raw.is_empty() => format!(": {}", trunc(&raw)),
            _ => String::new(),
        };
        return Err(StoreError(format!("storage PUT HTTP {}{}", response.status, detail)));
    }
    Ok(())
}

/// 读取状态并做 3 次重试(Go `main.go:264` `loadStateWithRetry`)。
///
/// - 读到非空值 → [`LoadResult::Loaded`];
/// - 404 需间隔 300ms **两次确认**(宿主重启风暴里存储会瞬时 404, 单次就当全新安装
///   会让默认值合法覆盖用户配置) → [`LoadResult::Fresh`];
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
    use crate::host::testhost;
    use std::cell::RefCell;
    use std::collections::BTreeMap;
    use std::rc::Rc;

    fn response(status: i32, etag: Option<&str>, body: &[u8]) -> HostCallResponse {
        let mut headers: BTreeMap<String, Vec<String>> = BTreeMap::new();
        if let Some(etag) = etag {
            headers.insert("ETag".to_string(), vec![etag.to_string()]);
        }
        HostCallResponse { status, headers, body_base64: STANDARD_NO_PAD.encode(body) }
    }

    /// 最小内存 KV 宿主: GET/PUT + `pkv_N` 乐观锁 + 宿主信封, 够覆盖存储层契约。
    #[derive(Default)]
    struct FakeHost {
        value: Option<Vec<u8>>,
        revision: u64,
        /// 一次性并发写入: 下一次 PUT 强制 412 并把 ETag 推新。
        concurrent_write: bool,
        puts: Vec<(String, String)>,
    }

    impl FakeHost {
        fn handle(&mut self, request: &HostCallRequest) -> Result<HostCallResponse, HostError> {
            match request.method.as_str() {
                "GET" => match &self.value {
                    Some(value) => Ok(response(
                        200,
                        Some(&format!("\"pkv_{}\"", self.revision)),
                        &envelope(value, self.revision),
                    )),
                    None => Ok(HostCallResponse { status: 404, ..Default::default() }),
                },
                "PUT" => {
                    let if_match = request.headers.get("if-match").cloned().unwrap_or_default();
                    let idem = request.headers.get("idempotency-key").cloned().unwrap_or_default();
                    self.puts.push((if_match.clone(), idem));
                    if self.concurrent_write {
                        self.concurrent_write = false;
                        self.revision += 1;
                        return Ok(HostCallResponse { status: 412, ..Default::default() });
                    }
                    if self.value.is_some() && if_match != format!("\"pkv_{}\"", self.revision) {
                        return Ok(HostCallResponse { status: 412, ..Default::default() });
                    }
                    let body = STANDARD_NO_PAD.decode(&request.body_base64).unwrap_or_default();
                    // 宿主只接受 {"value": ...}: 剥掉这层壳再存。
                    let inner = body
                        .strip_prefix(br#"{"value":"#)
                        .and_then(|rest| rest.strip_suffix(b"}"))
                        .unwrap_or(&body)
                        .to_vec();
                    self.value = Some(inner);
                    self.revision += 1;
                    Ok(response(200, Some(&format!("\"pkv_{}\"", self.revision)), b""))
                }
                other => Err(HostError::new(format!("意外的方法 {other}"))),
            }
        }
    }

    /// 宿主信封: `{"data":{"key":..,"value":<值>,"revision":"pkv_N"},"meta":{..}}`。
    fn envelope(value: &[u8], revision: u64) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(br#"{"data":{"key":"state","value":"#);
        body.extend_from_slice(value);
        body.extend_from_slice(
            format!(
                r#","revision":"pkv_{revision}","updated_at":"2026-10-01T00:00:00Z"}},"meta":{{"plugin_id":"chase.rs","installation_id":1}}}}"#
            )
            .as_bytes(),
        );
        body
    }

    fn install(fake: &Rc<RefCell<FakeHost>>) {
        let handle = Rc::clone(fake);
        testhost::install(Box::new(move |request| handle.borrow_mut().handle(request)));
    }

    #[test]
    fn decode_body_accepts_raw_and_std_padding() {
        for body in [
            b"".to_vec(),
            b"x".to_vec(),
            br#"{"settings":{"lists":{}}}"#.to_vec(),
            vec![0u8, 1, 2, 250, 251, 252, 253, 254, 255],
        ] {
            for padded in [false, true] {
                let encoded = if padded { STANDARD.encode(&body) } else { STANDARD_NO_PAD.encode(&body) };
                let resp = HostCallResponse {
                    status: 200,
                    headers: Default::default(),
                    body_base64: encoded,
                };
                assert_eq!(decode_body(&resp).unwrap(), body, "padded={padded}");
            }
        }
        let empty = HostCallResponse::default();
        assert_eq!(decode_body(&empty).unwrap(), Vec::<u8>::new());

        let bad = HostCallResponse {
            status: 200,
            headers: Default::default(),
            body_base64: "!!!not base64!!!".to_string(),
        };
        assert!(decode_body(&bad).is_err());
    }

    /// Go `storage_test.go` `TestUnwrapStorageValue` 的逐条对照 + `null` 边界。
    #[test]
    fn unwrap_value_matches_go_cases() {
        let envelope = r#"{
          "data": {
            "key": "state",
            "value": {"revision":7,"last_align_at":"2026-10-01T00:00:00Z"},
            "revision": "pkv_248",
            "updated_at": "2026-10-01T00:00:00Z"
          },
          "meta": {"plugin_id": "chase.rs", "installation_id": 1}
        }"#;
        assert_eq!(
            String::from_utf8(unwrap_value(envelope.as_bytes())).unwrap(),
            r#"{"revision":7,"last_align_at":"2026-10-01T00:00:00Z"}"#
        );

        let legacy = r#"{"value":{"a":1}}"#;
        assert_eq!(String::from_utf8(unwrap_value(legacy.as_bytes())).unwrap(), r#"{"a":1}"#);

        let bare = r#"{"revision":1}"#;
        assert_eq!(String::from_utf8(unwrap_value(bare.as_bytes())).unwrap(), bare);

        assert_eq!(unwrap_value(b""), Vec::<u8>::new());

        // `null` 也是"有值": Go 的 json.RawMessage 会收到这 4 个字节
        assert_eq!(String::from_utf8(unwrap_value(br#"{"value":null}"#)).unwrap(), "null");
        assert_eq!(String::from_utf8(unwrap_value(br#"{"data":{"value":null}}"#)).unwrap(), "null");
        // data 优先于 value
        assert_eq!(String::from_utf8(unwrap_value(br#"{"data":{"value":1},"value":2}"#)).unwrap(), "1");
        // 没有 value 字段 → 原样
        assert_eq!(
            String::from_utf8(unwrap_value(br#"{"data":{"key":"state"}}"#)).unwrap(),
            r#"{"data":{"key":"state"}}"#
        );
        // data 类型不符 → Go 的 Unmarshal 失败 → 原样
        assert_eq!(
            String::from_utf8(unwrap_value(br#"{"data":5,"value":2}"#)).unwrap(),
            r#"{"data":5,"value":2}"#
        );
        // data 为 null → Go 里是零值结构体(不报错) → 回退到顶层 value
        assert_eq!(String::from_utf8(unwrap_value(br#"{"data":null,"value":2}"#)).unwrap(), "2");
        // 顶层不是对象 → 原样
        assert_eq!(unwrap_value(b"[1,2]"), b"[1,2]");
        assert_eq!(unwrap_value(b"null"), b"null");
        assert_eq!(unwrap_value(b"not json"), b"not json");
        // 值本身是字符串时返回带引号的原始 JSON(与 Go 的 RawMessage 一致)
        assert_eq!(unwrap_value(br#"{"value":"x"}"#), b"\"x\"");
    }

    #[test]
    fn etag_header_lookup_is_case_insensitive() {
        let mut headers = std::collections::BTreeMap::new();
        headers.insert("ETag".to_string(), vec!["\"pkv_7\"".to_string()]);
        assert_eq!(header_first(&headers, "etag"), Some("\"pkv_7\""));
        assert_eq!(header_first(&headers, "ETAG"), Some("\"pkv_7\""));

        // 空值列表要跳过, 继续找同名条目(Go 的 len(values) > 0 判定)
        let mut headers = std::collections::BTreeMap::new();
        headers.insert("Etag".to_string(), Vec::<String>::new());
        headers.insert("etag".to_string(), vec!["\"pkv_9\"".to_string()]);
        assert_eq!(header_first(&headers, "etag"), Some("\"pkv_9\""));

        let empty: std::collections::BTreeMap<String, Vec<String>> = Default::default();
        assert_eq!(header_first(&empty, "etag"), None);
    }

    #[test]
    fn read_unwraps_envelope_and_keeps_etag() {
        let fake = Rc::new(RefCell::new(FakeHost::default()));
        fake.borrow_mut().value = Some(br#"{"revision":1}"#.to_vec());
        fake.borrow_mut().revision = 1;
        install(&fake);

        let read = super::read(STATE_KEY);
        testhost::clear();
        assert!(read.ok);
        assert_eq!(read.etag, "\"pkv_1\"");
        assert_eq!(read.value, br#"{"revision":1}"#);
    }

    #[test]
    fn read_reports_missing_key_and_host_failure() {
        // 404 → ok=false, 值/etag 都是空
        let fake = Rc::new(RefCell::new(FakeHost::default()));
        install(&fake);
        let missing = super::read(STATE_KEY);
        testhost::clear();
        assert!(!missing.ok);
        assert_eq!(missing.value, Vec::<u8>::new());
        assert_eq!(missing.etag, "");

        // 没有替身(本机 abi_stub) → ok=false, status=0
        assert!(!super::read(STATE_KEY).ok);
        assert_eq!(super::status(STATE_KEY), 0);
    }

    #[test]
    fn put_body_is_value_wrapped() {
        assert_eq!(put_body(br#"{"a":1}"#), br#"{"value":{"a":1}}"#);
        assert_eq!(put_body(b""), Vec::<u8>::new());
    }

    #[test]
    fn put_writes_with_etag_lock_and_unique_idempotency_keys() {
        let fake = Rc::new(RefCell::new(FakeHost::default()));
        install(&fake);
        let mut ids = PutIds::new();

        // 键不存在: 先 GET(404) → 不带 If-Match 的 PUT
        put(&mut ids, STATE_KEY, br#"{"revision":1}"#).unwrap();
        assert_eq!(fake.borrow().value.as_deref(), Some(&br#"{"revision":1}"#[..]));
        assert_eq!(fake.borrow().puts.len(), 1);
        assert_eq!(fake.borrow().puts[0].0, "", "新建键不带 If-Match");

        // 键已存在: 必须带刚读回来的 ETag, 且幂等键每次唯一
        put(&mut ids, STATE_KEY, br#"{"revision":2}"#).unwrap();
        let puts = fake.borrow().puts.clone();
        assert_eq!(puts.len(), 2);
        assert_eq!(puts[1].0, "\"pkv_1\"", "第二次 PUT 必须带上一次写入后的 ETag");
        assert_ne!(puts[0].1, puts[1].1, "幂等键每次写入必须唯一");
        assert!(puts[0].1.starts_with("chase-put-state-"), "{}", puts[0].1);
        assert!(puts[0].1.len() >= 16 && puts[0].1.bytes().all(|b| b.is_ascii_graphic()));
        assert_eq!(fake.borrow().value.as_deref(), Some(&br#"{"revision":2}"#[..]));
        testhost::clear();
    }

    #[test]
    fn put_retries_once_on_412_with_fresh_etag() {
        let fake = Rc::new(RefCell::new(FakeHost::default()));
        fake.borrow_mut().value = Some(br#"{"revision":1}"#.to_vec());
        fake.borrow_mut().revision = 1;
        // 模拟并发写入: 第一次 PUT 时键已被别的 worker 改过 → 412 + ETag 变新
        fake.borrow_mut().concurrent_write = true;
        install(&fake);

        let mut ids = PutIds::new();
        put(&mut ids, STATE_KEY, br#"{"revision":2}"#).unwrap();

        let puts = fake.borrow().puts.clone();
        assert_eq!(puts.len(), 2, "412 后必须重试一次, 实际 {}", puts.len());
        assert_ne!(puts[0].0, puts[1].0, "重试必须用重读后的新 ETag: {puts:?}");
        assert_eq!(puts[1].0, "\"pkv_2\"");
        assert_ne!(puts[0].1, puts[1].1, "重试也要换幂等键");
        assert_eq!(fake.borrow().value.as_deref(), Some(&br#"{"revision":2}"#[..]));
        testhost::clear();
    }

    #[test]
    fn load_state_with_retry_three_states() {
        // ① 有值 → loaded, 不睡
        let fake = Rc::new(RefCell::new(FakeHost::default()));
        fake.borrow_mut().value = Some(br#"{"revision":3}"#.to_vec());
        fake.borrow_mut().revision = 3;
        install(&fake);
        let _ = clock::testhooks::take_sleeps();
        let (raw, result) = load_state_with_retry();
        assert_eq!(result, LoadResult::Loaded);
        assert_eq!(raw.as_deref(), Some(&br#"{"revision":3}"#[..]));
        assert!(clock::testhooks::take_sleeps().is_empty(), "成功路径不该睡");
        testhost::clear();

        // ② 两次 404 → fresh, 中间只睡 300ms
        let fake = Rc::new(RefCell::new(FakeHost::default()));
        install(&fake);
        let _ = clock::testhooks::take_sleeps();
        let (raw, result) = load_state_with_retry();
        assert_eq!(result, LoadResult::Fresh);
        assert!(raw.is_none());
        assert_eq!(clock::testhooks::take_sleeps(), vec![300], "404 需间隔 300ms 两次确认");
        testhost::clear();

        // ③ 宿主持续不可读 → unavailable, 3 次尝试各睡 200ms
        let _ = clock::testhooks::take_sleeps();
        let (raw, result) = load_state_with_retry();
        assert_eq!(result, LoadResult::Unavailable);
        assert!(raw.is_none());
        assert_eq!(clock::testhooks::take_sleeps(), vec![200, 200, 200]);
    }
}
