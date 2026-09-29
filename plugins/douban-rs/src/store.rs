//! 宿主存储 KV 适配层(对照 Go `wasm.go:134` 的存储段 + `main.go` 的 `loadStateWithRetry`/
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
//! # 0.3.7 的信封 bug
//!
//! 早期实现只认顶层 `value`, 于是把整个信封当成了值 → 状态文档解成空结构, 每次
//! 启动都当作没有历史状态, 账号配置也读不到。现在按"先 `data.value`, 再顶层
//! `value`, 都不是就当裸值"三级回退([`unwrap_value`])处理, 逐条对齐 Go 的
//! `unwrapStorageValue`。

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::value::RawValue;

use crate::clock;
use crate::host::{self, HostCallRequest, HostCallResponse, HostError};
use crate::util;

/// 状态文档键(Go `main.go:247` `stateStorageKey`)。
pub const STATE_KEY: &str = "state";
/// 账号配置键(Go `main.go:252` `accountStorageKey`): 只有 settings-update 写它,
/// 榜单刷新的 `persistAll` 永远不碰 —— 大状态被竞态冲掉也带不走账号配置。
pub const ACCOUNT_KEY: &str = "account";
/// 诊断面包屑键(Go `main.go:1112` 里的字面量 `"diag"`)。
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

/// `loadAll` 的加载三态(Go `main.go:255` 的 iota 常量)。
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
    /// Go `loadResultName`(写进诊断面包屑的字符串)。
    pub fn name(self) -> &'static str {
        match self {
            LoadResult::Loaded => "loaded",
            LoadResult::Fresh => "fresh",
            LoadResult::Unavailable => "unavailable",
        }
    }
}

/// 幂等键序列(Go `wasm.go:18` 的 `sessionNonce` + `wasm.go:29` 的 `idCounter`)。
///
/// Go 的计数器在每次 `wasmHostCall` 自增, 这里只在每次写入取号 —— 两者都保证
/// "同一会话内每次写入拿到的键不同"。跨会话靠 [`clock::session_nonce`] 拉开
/// (宿主保留 24h 幂等记录, 新 worker 从 0 开始计数会撞上旧会话)。
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

    /// 生成本次写入的幂等键: `dc-put-<key>-<nonce>-<seq>`(Go `wasm.go:203` 同格式)。
    pub fn next_key(&mut self, key: &str) -> String {
        self.seq += 1;
        format!("dc-put-{key}-{}-{}", clock::session_nonce(), self.seq)
    }
}

fn get_request(key: &str) -> HostCallRequest {
    HostCallRequest::new("GET", storage_path(key)).with_header("accept", "application/json")
}

/// 发起一次 host.call(存储层唯一的出口, 测试里被 [`crate::host`] 的替身接管)。
fn host_call(request: &HostCallRequest) -> Result<HostCallResponse, HostError> {
    host::call(request)
}

/// 响应头里按名字取第一个值(Go `wasm.go:147` 的 `strings.EqualFold` 遍历: 大小写不敏感,
/// 值列表为空则继续找同名的其他条目)。
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

/// 解出 `body_base64`(Go `main.go:2112` `decodeBody`)。
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

/// 剥掉宿主存储响应的信封(Go `wasm.go:171` `unwrapStorageValue`)。
///
/// 三级回退: `data.value` → 顶层 `value` → 原样返回。
/// `null` 也是"有值"(Go 的 `json.RawMessage` 会记下 `null` 这 4 个字节), 这里同样
/// 返回 `null` 文本, 让上层按普通 JSON 处理 —— 状态文档解出空结构后
/// `Lists == nil`, 与 Go 的 `restored == false` 一致。
///
/// 字段视图用 `RawValue`(Go `json.RawMessage` 的等价物): 只收这一小段原文,
/// **不为整篇文档建树**。`put()` 每次写入前都要先 `read()` 拿 ETag, 而状态文档
/// 最大 4MiB —— 在 wazero 解释器 + manifest `memory_mb` 的预算下, 省掉这棵树是
/// 落盘路径上最直接的内存/CPU 收益(Go 的匿名结构体正是为此只放两个 RawMessage)。
/// 病态输入(同名字段重复/字段类型不符)按 Go 的 Unmarshal 失败分支处理: 原样返回。
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

/// 读取键值并返回宿主给出的 ETag(Go `wasm.go:138` `wasmStorageRead`)。
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

/// 直接探测存储键的 HTTP 状态(Go `main.go:281` `storageStatus`): 区分 404 与瞬态错误。
pub fn status(key: &str) -> i32 {
    match host_call(&get_request(key)) {
        Ok(response) => response.status,
        Err(_) => 0,
    }
}

/// 组装 PUT 请求体 `{"value": <原始 JSON 字节>}`(Go `wasm.go:199` 用
/// `map[string]json.RawMessage` 得到同样形状)。
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

fn send_put(ids: &mut PutIds, key: &str, body: &[u8], if_match: &str) -> Result<HostCallResponse, StoreError> {
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
/// 流程与 Go 一致: 先读一次拿 ETag(键存在时不带 `If-Match` 会被宿主按乐观锁拒绝),
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
            Ok(raw) if !raw.is_empty() => format!(": {}", util::trunc(&raw)),
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

/// 旧版分键持久化的键名(Go `main.go:1067` `pathToKey`: `.data/history.json` → `history`)。
pub fn legacy_keys() -> [&'static str; 7] {
    ["settings", "snapshot", "queue", "history", "logs", "stats", "blackstate"]
}

/// `.data/<name>.json` → 存储键(Go `pathToKey` 的移植, 供迁移与测试对照)。
pub fn path_to_key(path: &str) -> String {
    let path = path.strip_prefix('/').unwrap_or(path);
    let path = path.strip_prefix(".data/").unwrap_or(path);
    path.strip_suffix(".json").unwrap_or(path).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{EnvelopeStyle, FakeHost};

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
        // Go 的 decodeBody: 先 RawStdEncoding(不带 padding), 失败再 StdEncoding(带 padding)
        for body in [
            b"".to_vec(),
            b"x".to_vec(),
            b"{\"settings\":{\"lists\":{\"hot\":{\"source\":\"subjects_json\"}}}}".to_vec(),
            vec![0u8, 1, 2, 250, 251, 252, 253, 254, 255],
        ] {
            for padded in [false, true] {
                let decoded = decode_body(&response(&body, padded)).unwrap();
                assert_eq!(decoded, body, "padded={padded}");
            }
        }
        // 空 body_base64 → 空值, 不报错(Go 里 decodeBody 返回 nil, nil)
        let empty = HostCallResponse { status: 200, headers: Default::default(), body_base64: String::new() };
        assert_eq!(decode_body(&empty).unwrap(), Vec::<u8>::new());

        // 坏 base64 → 报错(Go 的 CorruptInputError 分支)
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
            "value": {"settings":{"lists":{"hot":{"source":"subjects_json","enabled":true}}},"queue":{"items":[]}},
            "revision": "pkv_248",
            "updated_at": "2026-09-28T12:00:20Z"
          },
          "meta": {"plugin_id": "douban.center", "installation_id": 30}
        }"#;
        assert_eq!(
            String::from_utf8(unwrap_value(envelope.as_bytes())).unwrap(),
            r#"{"settings":{"lists":{"hot":{"source":"subjects_json","enabled":true}}},"queue":{"items":[]}}"#
        );

        let legacy = r#"{"value":{"a":1}}"#;
        assert_eq!(String::from_utf8(unwrap_value(legacy.as_bytes())).unwrap(), r#"{"a":1}"#);

        let bare = r#"{"settings":{"lists":{"hot":{}}}}"#;
        assert_eq!(String::from_utf8(unwrap_value(bare.as_bytes())).unwrap(), bare);

        assert_eq!(unwrap_value(b""), Vec::<u8>::new());

        // `null` 也是"有值": Go 的 json.RawMessage 会收到这 4 个字节
        assert_eq!(String::from_utf8(unwrap_value(br#"{"value":null}"#)).unwrap(), "null");
        assert_eq!(String::from_utf8(unwrap_value(br#"{"data":{"value":null}}"#)).unwrap(), "null");
        // data 优先于 value
        assert_eq!(
            String::from_utf8(unwrap_value(br#"{"data":{"value":1},"value":2}"#)).unwrap(),
            "1"
        );
        // 没有 value 字段 → 原样
        assert_eq!(String::from_utf8(unwrap_value(br#"{"data":{"key":"state"}}"#)).unwrap(), r#"{"data":{"key":"state"}}"#);
        // data 类型不符 → Go 的 Unmarshal 失败 → 原样
        assert_eq!(String::from_utf8(unwrap_value(br#"{"data":5,"value":2}"#)).unwrap(), r#"{"data":5,"value":2}"#);
        // data 为 null → Go 里是零值结构体(不报错) → 回退到顶层 value
        assert_eq!(String::from_utf8(unwrap_value(br#"{"data":null,"value":2}"#)).unwrap(), "2");
        assert_eq!(
            String::from_utf8(unwrap_value(br#"{"data":null,"value":{"a":1}}"#)).unwrap(),
            r#"{"a":1}"#
        );
        // 顶层不是对象 → 原样
        assert_eq!(unwrap_value(b"[1,2]"), b"[1,2]");
        assert_eq!(unwrap_value(b"\"x\""), b"\"x\"");
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
    fn read_extracts_etag_and_unwraps_envelope() {
        let host = FakeHost::new();
        host.set("state", br#"{"settings":{"lists":{}}}"#);
        let _guard = host.install();
        let read = super::read("state");
        assert!(read.ok);
        assert_eq!(read.etag, "\"pkv_1\"");
        assert_eq!(read.value, br#"{"settings":{"lists":{}}}"#);
    }

    /// ETag 头的大小写不敏感(Go `strings.EqualFold`)。
    #[test]
    fn read_etag_is_case_insensitive() {
        for header in ["ETag", "etag", "eTaG"] {
            let host = FakeHost::new();
            host.etag_header_name(header);
            host.set("state", br#"{"settings":{"lists":{}}}"#);
            let _guard = host.install();
            let read = super::read("state");
            assert_eq!(read.etag, "\"pkv_1\"", "header={header}");
        }
    }

    #[test]
    fn read_reports_missing_key_and_host_failure() {
        let host = FakeHost::new();
        let _guard = host.install();
        let read = super::read("state");
        assert!(!read.ok, "404 必须 ok=false");
        assert_eq!(read.value, Vec::<u8>::new());
        assert_eq!(read.etag, "");

        let host = FakeHost::new();
        host.fail_all(true);
        let _guard = host.install();
        let read = super::read("state");
        assert!(!read.ok, "host.call 失败必须 ok=false");
        assert_eq!(super::status("state"), 0, "Go storageStatus 失败返回 0");
    }

    #[test]
    fn put_body_is_value_wrapped() {
        assert_eq!(put_body(br#"{"a":1}"#), br#"{"value":{"a":1}}"#);
        assert_eq!(put_body(b""), Vec::<u8>::new());
    }

    #[test]
    fn put_sends_go_shaped_request() {
        let host = FakeHost::new();
        let _guard = host.install();
        let mut ids = PutIds::new();
        put(&mut ids, "state", br#"{"a":1}"#).unwrap();

        let requests = host.requests();
        assert_eq!(requests[0].method, "GET", "先读 ETag");
        assert_eq!(requests[0].path, "/api/plugin-runtime/storage/state");
        assert_eq!(requests[1].method, "PUT");
        let put_request = &requests[1];
        assert_eq!(put_request.path, "/api/plugin-runtime/storage/state");
        assert_eq!(put_request.headers.get("content-type").map(String::as_str), Some("application/json"));
        assert_eq!(put_request.headers.get("accept").map(String::as_str), Some("application/json"));
        // 键不存在 → 不带 If-Match
        assert!(!put_request.headers.contains_key("if-match"), "新建键不该带 If-Match");
        // body_base64 必须是 RawStd(不补 padding)
        assert_eq!(put_request.body_base64, "eyJ2YWx1ZSI6eyJhIjoxfX0");
        assert!(!put_request.body_base64.contains('='), "RawStd 不带 padding");
        // 宿主约束: 幂等键 16~128 个可打印 ASCII
        let idem = put_request.headers.get("idempotency-key").expect("幂等键必填");
        assert!((16..=128).contains(&idem.len()), "幂等键长度 {} 越界: {idem}", idem.len());
        assert!(idem.bytes().all(|b| b.is_ascii_graphic()), "必须全是可打印 ASCII: {idem}");
        assert!(idem.starts_with("dc-put-state-"), "{idem}");

        // 第二次写入必须换一个幂等键(宿主保留 24h 幂等记录)
        put(&mut ids, "state", br#"{"a":2}"#).unwrap();
        let requests = host.requests();
        let first = &requests[1].headers["idempotency-key"];
        let second = &requests[3].headers["idempotency-key"];
        assert_ne!(first, second, "每次写入必须唯一");
        // 键已存在 → 必须带 If-Match, 且是本次 PUT 前刚读回来的 ETag。
        // 首次插入把 revision 推到 1(ETag "pkv_1"), 第二次 PUT 前读到的就是它;
        // 这次 PUT 成功后 revision 才变成 2。
        assert_eq!(requests[3].headers.get("if-match").map(String::as_str), Some("\"pkv_1\""));
        // 值确实写进去了
        assert_eq!(host.value_of("state").unwrap(), br#"{"a":2}"#);

        // 请求信封形状(与 host.rs 的既有约定一致; 用同一个信封结构体, 保字段顺序)
        let wire = String::from_utf8(
            crate::host::encode_request(&requests[1]).expect("请求必须能编码"),
        )
        .unwrap();
        assert_eq!(
            wire,
            r#"{"method":"host.call","params":{"method":"PUT","path":"/api/plugin-runtime/storage/state","headers":{"accept":"application/json","content-type":"application/json","idempotency-key":""#.to_string()
                + &requests[1].headers["idempotency-key"]
                + r#""},"body_base64":"eyJ2YWx1ZSI6eyJhIjoxfX0"}}"#
        );
    }

    #[test]
    fn put_retries_once_on_412_with_fresh_etag() {
        let host = FakeHost::new();
        host.set("state", br#"{"v":1}"#);
        // 模拟并发写入: 第一次 PUT 时键已被别的 worker 改过 → 412 + ETag 变新
        host.concurrent_write_on_put();
        let _guard = host.install();

        let mut ids = PutIds::new();
        put(&mut ids, "state", br#"{"v":2}"#).unwrap();

        let puts = host.puts();
        assert_eq!(puts.len(), 2, "412 后必须重试一次, 实际 {}", puts.len());
        assert_ne!(
            puts[0].if_match, puts[1].if_match,
            "重试必须用重读后的新 ETag: {:?}", puts
        );
        assert_eq!(puts[1].if_match.as_deref(), Some("\"pkv_2\""));
        assert_ne!(puts[0].idempotency_key, puts[1].idempotency_key, "重试也要换幂等键");
        assert_eq!(host.value_of("state").unwrap(), br#"{"v":2}"#);

        // 412 但重读回来 ok=false(键被删了) → 不再重试, 直接报错
        let host = FakeHost::new();
        host.set("state", br#"{"v":1}"#);
        host.concurrent_delete_on_put();
        let _guard = host.install();
        let mut ids = PutIds::new();
        let err = put(&mut ids, "state", br#"{"v":2}"#).unwrap_err();
        assert!(err.0.starts_with("storage PUT HTTP 412"), "{err}");
        assert_eq!(host.puts().len(), 1, "重读失败就不再重试");
    }

    #[test]
    fn put_reports_http_errors_with_truncated_body() {
        let host = FakeHost::new();
        host.push_put_status(500);
        host.put_error_body(&vec![b'e'; 400]);
        let _guard = host.install();
        let mut ids = PutIds::new();
        let err = put(&mut ids, "state", br#"{"v":1}"#).unwrap_err();
        let text = err.0.clone();
        assert!(text.starts_with("storage PUT HTTP 500: "), "{text}");
        assert_eq!(text.len(), "storage PUT HTTP 500: ".len() + 200, "错误细节按 200 字节截断");
    }

    #[test]
    fn load_state_with_retry_three_states() {
        // ① 有值 → loaded
        let host = FakeHost::new();
        host.set("state", br#"{"settings":{"lists":{}}}"#);
        let _guard = host.install();
        let _ = clock::testhooks::take_sleeps();
        let (raw, result) = load_state_with_retry();
        assert_eq!(result, LoadResult::Loaded);
        assert_eq!(raw.as_deref(), Some(&br#"{"settings":{"lists":{}}}"#[..]));
        assert!(clock::testhooks::take_sleeps().is_empty(), "成功路径不该睡");

        // ② 两次 404 → fresh, 中间只睡 300ms
        let host = FakeHost::new();
        host.get_status(404);
        let _guard = host.install();
        let _ = clock::testhooks::take_sleeps();
        let (raw, result) = load_state_with_retry();
        assert_eq!(result, LoadResult::Fresh);
        assert!(raw.is_none());
        assert_eq!(clock::testhooks::take_sleeps(), vec![300], "404 需间隔 300ms 两次确认");

        // ③ 宿主持续不可读 → unavailable, 3 次尝试各睡 200ms
        let host = FakeHost::new();
        host.fail_all(true);
        let _guard = host.install();
        let _ = clock::testhooks::take_sleeps();
        let (raw, result) = load_state_with_retry();
        assert_eq!(result, LoadResult::Unavailable);
        assert!(raw.is_none());
        assert_eq!(clock::testhooks::take_sleeps(), vec![200, 200, 200]);

        // ④ 404 但第二次确认时已经恢复(瞬时 404) → 不判 fresh, 重试到 loaded
        let host = FakeHost::new();
        host.set("state", br#"{"settings":{"lists":{}}}"#);
        host.push_get_status(404);
        host.push_get_status(404);
        let _guard = host.install();
        let _ = clock::testhooks::take_sleeps();
        let (raw, result) = load_state_with_retry();
        assert_eq!(result, LoadResult::Loaded, "瞬时 404 不能被当成全新安装");
        assert_eq!(raw.as_deref(), Some(&br#"{"settings":{"lists":{}}}"#[..]));
        assert_eq!(clock::testhooks::take_sleeps(), vec![300, 200]);
    }

    #[test]
    fn legacy_keys_and_path_mapping() {
        assert_eq!(path_to_key("/.data/settings.json"), "settings");
        assert_eq!(path_to_key(".data/history.json"), "history");
        assert_eq!(path_to_key(".data/blackstate.json"), "blackstate");
        assert_eq!(legacy_keys().len(), 7);
    }

    #[test]
    fn put_ids_are_unique_and_prefixed() {
        let mut ids = PutIds::new();
        let a = ids.next_key("state");
        let b = ids.next_key("state");
        let c = ids.next_key("account");
        assert_ne!(a, b);
        assert_ne!(b, c);
        assert!(a.starts_with("dc-put-state-"));
        assert!(c.starts_with("dc-put-account-"));
        assert_eq!(ids.seq(), 3);
    }

    /// 信封风格三态都要能一路读到值(真实宿主 / 0.3.6 的扁平信封 / 裸文档)。
    #[test]
    fn read_supports_all_envelope_styles() {
        for style in [EnvelopeStyle::Host, EnvelopeStyle::LegacyFlat, EnvelopeStyle::Bare] {
            let host = FakeHost::new();
            host.envelope_style(style);
            host.set("state", br#"{"settings":{"lists":{"hot":{}}}}"#);
            let _guard = host.install();
            let read = super::read("state");
            assert!(read.ok, "{style:?} 必须能读到");
            assert_eq!(read.value, br#"{"settings":{"lists":{"hot":{}}}}"#, "{style:?}");
        }
    }
}
