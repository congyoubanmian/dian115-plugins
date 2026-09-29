//! 本机测试用的假宿主(只在 `cargo test` 下编译)。
//!
//! 语义尽量贴近宿主 OpenAPI 文档:
//!
//! - `GET  /api/plugin-runtime/storage/:key` → 200 + `ETag: "pkv_N"` + `StorageValueEnvelope`
//!   (`{"data":{"key":..,"value":<值>,"revision":"pkv_N","updated_at":..},"meta":..}`); 键不存在 → 404。
//! - `PUT`: body 必须是 `{"value": <值>}`; `Idempotency-Key` 必填且 16~128 个可打印 ASCII;
//!   已存在的键必须带**匹配当前 ETag** 的 `If-Match`, 否则 412(乐观锁)。
//!   revision 是**每个键各自**的(夹具里 state=pkv_248 而 account=pkv_2)。
//! - `body_base64` 默认**不补 padding**(宿主文档: "body, unpadded base64 in responses"),
//!   可切成补 padding 以覆盖 Raw/Std 两种解码路径。
//!
//! 额外能力(用于复现竞态与故障): 粘性/脚本化状态码、并发写入/删除注入、整体不可读。

use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::rc::Rc;

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine as _;
use serde_json::Value;

use crate::host::{testhost, HostCallRequest, HostCallResponse, HostError};

/// 宿主响应的信封形态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EnvelopeStyle {
    /// 现行宿主: `{"data":{"value":..},"meta":..}`。
    Host,
    /// 0.3.6 及以前的扁平信封: `{"value": ..}`。
    LegacyFlat,
    /// 裸文档(既没有 data 也没有 value)。
    Bare,
}

#[derive(Debug, Clone)]
struct Entry {
    value: Vec<u8>,
    revision: u64,
}

impl Entry {
    fn etag(&self) -> String {
        format!("\"pkv_{}\"", self.revision)
    }
}

/// 一次 PUT 的记录(供用例断言请求形态与重试行为)。
#[derive(Debug, Clone)]
pub(crate) struct PutRecord {
    pub key: String,
    pub idempotency_key: String,
    pub if_match: Option<String>,
    /// 解码后的请求体(`{"value": ...}` 原文)。
    pub body: Vec<u8>,
    /// 从请求体里解出的 value 字节。
    pub value: Vec<u8>,
}

#[derive(Default)]
struct Inner {
    kv: BTreeMap<String, Entry>,
    etag_header: String,
    envelope: Option<EnvelopeStyle>,
    base64_padded: bool,
    fail_all: bool,
    /// 粘性 GET 状态(404 确认窗口)。
    get_status: Option<i32>,
    /// 脚本化 GET 状态(逐次弹出, 用于"瞬时 404 又恢复")。
    get_statuses: VecDeque<i32>,
    put_statuses: VecDeque<i32>,
    put_error_body: Vec<u8>,
    concurrent_write_on_put: bool,
    concurrent_delete_on_put: bool,
    requests: Vec<HostCallRequest>,
    puts: Vec<PutRecord>,
}

impl Inner {
    fn style(&self) -> EnvelopeStyle {
        self.envelope.unwrap_or(EnvelopeStyle::Host)
    }

    fn etag_header_name(&self) -> &str {
        if self.etag_header.is_empty() {
            "ETag"
        } else {
            &self.etag_header
        }
    }
}

/// 假宿主句柄(内部共享状态, `install()` 之后仍可从用例侧读取记录)。
pub(crate) struct FakeHost {
    inner: Rc<RefCell<Inner>>,
}

/// `install()` 的清理守卫: 离开作用域时摘掉本线程的 host.call 替身。
pub(crate) struct FakeHostGuard;

impl Drop for FakeHostGuard {
    fn drop(&mut self) {
        testhost::clear();
    }
}

impl FakeHost {
    pub(crate) fn new() -> Self {
        FakeHost { inner: Rc::new(RefCell::new(Inner::default())) }
    }

    /// 装上本线程的 host.call 替身。
    pub(crate) fn install(&self) -> FakeHostGuard {
        let inner = Rc::clone(&self.inner);
        testhost::install(Box::new(move |request: &HostCallRequest| handle(&inner, request)));
        FakeHostGuard
    }

    /// 写入一个键(新键的 revision 从 1 开始 → ETag `"pkv_1"`)。
    pub(crate) fn set(&self, key: &str, value: &[u8]) {
        let mut state = self.inner.borrow_mut();
        let revision = state.kv.get(key).map(|entry| entry.revision).unwrap_or(0) + 1;
        state.kv.insert(key.to_string(), Entry { value: value.to_vec(), revision });
    }

    pub(crate) fn remove(&self, key: &str) {
        self.inner.borrow_mut().kv.remove(key);
    }

    pub(crate) fn value_of(&self, key: &str) -> Option<Vec<u8>> {
        self.inner.borrow().kv.get(key).map(|entry| entry.value.clone())
    }

    /// ETag 响应头的名字(默认 `ETag`; 改成别的拼写用于大小写不敏感断言)。
    pub(crate) fn etag_header_name(&self, name: &str) {
        self.inner.borrow_mut().etag_header = name.to_string();
    }

    pub(crate) fn envelope_style(&self, style: EnvelopeStyle) {
        self.inner.borrow_mut().envelope = Some(style);
    }

    /// 响应体是否补 padding(默认 false = 宿主现行行为)。
    pub(crate) fn base64_padded(&self, padded: bool) {
        self.inner.borrow_mut().base64_padded = padded;
    }

    /// 所有 host.call 直接失败(模拟宿主不可用)。
    pub(crate) fn fail_all(&self, fail: bool) {
        self.inner.borrow_mut().fail_all = fail;
    }

    /// 所有 GET 一律返回这个状态(404 两次确认场景)。
    pub(crate) fn get_status(&self, status: i32) {
        self.inner.borrow_mut().get_status = Some(status);
    }

    /// 按顺序返回若干次 GET 状态, 之后恢复正常查表(瞬时 404 场景)。
    pub(crate) fn push_get_status(&self, status: i32) {
        self.inner.borrow_mut().get_statuses.push_back(status);
    }

    /// 下一次(及后续排队的)PUT 直接返回这个状态, 不落盘。
    pub(crate) fn push_put_status(&self, status: i32) {
        self.inner.borrow_mut().put_statuses.push_back(status);
    }

    /// 与 [`Self::push_put_status`] 搭配的错误响应体。
    pub(crate) fn put_error_body(&self, body: &[u8]) {
        self.inner.borrow_mut().put_error_body = body.to_vec();
    }

    /// 注入"另一个 worker 抢先写入": 第一次 PUT 时把该键 revision 推进, 并回 412。
    pub(crate) fn concurrent_write_on_put(&self) {
        self.inner.borrow_mut().concurrent_write_on_put = true;
    }

    /// 注入"另一个 worker 抢先删除": 第一次 PUT 时删掉该键, 并回 412。
    pub(crate) fn concurrent_delete_on_put(&self) {
        self.inner.borrow_mut().concurrent_delete_on_put = true;
    }

    pub(crate) fn requests(&self) -> Vec<HostCallRequest> {
        self.inner.borrow().requests.clone()
    }

    pub(crate) fn puts(&self) -> Vec<PutRecord> {
        self.inner.borrow().puts.clone()
    }

    /// 最近一次写入某个键的原始 body 文本。
    pub(crate) fn last_put_body(&self, key: &str) -> Option<Vec<u8>> {
        self.inner
            .borrow()
            .puts
            .iter()
            .rev()
            .find(|record| record.key == key)
            .map(|record| record.body.clone())
    }
}

fn handle(inner: &Rc<RefCell<Inner>>, request: &HostCallRequest) -> Result<HostCallResponse, HostError> {
    let mut state = inner.borrow_mut();
    state.requests.push(request.clone());
    if state.fail_all {
        return Err(HostError::new("host_call 返回长度 0"));
    }
    let key = request
        .path
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string();
    match request.method.as_str() {
        "GET" => Ok(get_response(&mut state, &key)),
        "PUT" => Ok(put_response(&mut state, &key, request)),
        _ => Ok(status_response(405, b"method not allowed", state.base64_padded)),
    }
}

fn get_response(state: &mut Inner, key: &str) -> HostCallResponse {
    if let Some(status) = state.get_statuses.pop_front() {
        return status_response(status, b"", state.base64_padded);
    }
    if let Some(status) = state.get_status {
        return status_response(status, b"", state.base64_padded);
    }
    match state.kv.get(key).cloned() {
        Some(entry) => {
            let body = envelope_body(state.style(), key, &entry.value, entry.revision);
            let mut headers = BTreeMap::new();
            headers.insert(state.etag_header_name().to_string(), vec![entry.etag()]);
            headers.insert("content-type".to_string(), vec!["application/json".to_string()]);
            HostCallResponse {
                status: 200,
                headers,
                body_base64: encode(&body, state.base64_padded),
            }
        }
        None => status_response(404, b"", state.base64_padded),
    }
}

fn put_response(state: &mut Inner, key: &str, request: &HostCallRequest) -> HostCallResponse {
    // ① 宿主文档约束: Idempotency-Key 16~128 个可打印 ASCII
    let idem = request.headers.get("idempotency-key").cloned().unwrap_or_default();
    if !(16..=128).contains(&idem.len()) || !idem.bytes().all(|b| b.is_ascii_graphic()) {
        return status_response(400, format!("bad idempotency-key: {idem:?}").as_bytes(), state.base64_padded);
    }
    // ② body 必须是 {"value": ...}
    let raw_body = match decode_any(&request.body_base64) {
        Some(bytes) => bytes,
        None => return status_response(400, b"bad base64 body", state.base64_padded),
    };
    let parsed: Value = match serde_json::from_slice(&raw_body) {
        Ok(value) => value,
        Err(_) => return status_response(400, b"bad json body", state.base64_padded),
    };
    let value = match parsed.get("value") {
        Some(value) => serde_json::to_vec(value).unwrap_or_default(),
        None => return status_response(400, b"missing value", state.base64_padded),
    };
    let if_match = request.headers.get("if-match").cloned();
    state.puts.push(PutRecord {
        key: key.to_string(),
        idempotency_key: idem,
        if_match: if_match.clone(),
        body: raw_body,
        value,
    });

    // ③ 竞态注入
    if state.concurrent_write_on_put {
        state.concurrent_write_on_put = false;
        if let Some(entry) = state.kv.get_mut(key) {
            entry.revision += 1;
        }
        return status_response(412, b"", state.base64_padded);
    }
    if state.concurrent_delete_on_put {
        state.concurrent_delete_on_put = false;
        state.kv.remove(key);
        return status_response(412, b"", state.base64_padded);
    }
    // ④ 脚本化状态
    if let Some(status) = state.put_statuses.pop_front() {
        let body = state.put_error_body.clone();
        return status_response(status, &body, state.base64_padded);
    }
    // ⑤ 乐观锁: 已存在的键必须带匹配的 If-Match
    if let Some(entry) = state.kv.get(key) {
        if if_match.as_deref() != Some(entry.etag().as_str()) {
            return status_response(412, b"", state.base64_padded);
        }
    }
    let new_value = match state.puts.last() {
        Some(record) => record.value.clone(),
        None => Vec::new(),
    };
    let (revision, stored) = {
        let entry = state
            .kv
            .entry(key.to_string())
            .or_insert(Entry { value: Vec::new(), revision: 0 });
        entry.value = new_value;
        entry.revision += 1;
        (entry.revision, entry.value.clone())
    };
    let body = envelope_body(state.style(), key, &stored, revision);
    let mut headers = BTreeMap::new();
    headers.insert(state.etag_header_name().to_string(), vec![format!("\"pkv_{revision}\"")]);
    headers.insert("content-type".to_string(), vec!["application/json".to_string()]);
    HostCallResponse { status: 200, headers, body_base64: encode(&body, state.base64_padded) }
}

fn status_response(status: i32, body: &[u8], padded: bool) -> HostCallResponse {
    HostCallResponse { status, headers: BTreeMap::new(), body_base64: encode(body, padded) }
}

fn encode(body: &[u8], padded: bool) -> String {
    if body.is_empty() {
        return String::new();
    }
    if padded {
        STANDARD.encode(body)
    } else {
        STANDARD_NO_PAD.encode(body)
    }
}

fn decode_any(encoded: &str) -> Option<Vec<u8>> {
    if encoded.is_empty() {
        return Some(Vec::new());
    }
    STANDARD_NO_PAD
        .decode(encoded)
        .or_else(|_| STANDARD.decode(encoded))
        .ok()
}

/// 把存储值包成宿主的响应体。
fn envelope_body(style: EnvelopeStyle, key: &str, value: &[u8], revision: u64) -> Vec<u8> {
    match style {
        EnvelopeStyle::Host => {
            let mut body = format!(r#"{{"data":{{"key":"{key}","value":"#).into_bytes();
            body.extend_from_slice(value);
            body.extend_from_slice(
                format!(
                    r#","revision":"pkv_{revision}","updated_at":"2026-09-29T10:00:09Z"}},"meta":{{"plugin_id":"douban.center","installation_id":30}}}}"#
                )
                .as_bytes(),
            );
            body
        }
        EnvelopeStyle::LegacyFlat => {
            let mut body = br#"{"value":"#.to_vec();
            body.extend_from_slice(value);
            body.push(b'}');
            body
        }
        EnvelopeStyle::Bare => value.to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_host_round_trip_and_optimistic_lock() {
        let host = FakeHost::new();
        let _guard = host.install();

        // 缺失 → 404
        assert_eq!(crate::store::status("state"), 404);

        // 首次写入不带 If-Match
        host.set("state", br#"{"v":1}"#);
        let (value, ok) = crate::store::get("state");
        assert!(ok);
        assert_eq!(value, br#"{"v":1}"#);

        let mut ids = crate::store::PutIds::new();
        crate::store::put(&mut ids, "state", br#"{"v":2}"#).unwrap();
        assert_eq!(host.value_of("state").unwrap(), br#"{"v":2}"#);
        // 带错 If-Match → 412
        let stale = crate::host::HostCallRequest::new("PUT", "/api/plugin-runtime/storage/state")
            .with_header("idempotency-key", "x".repeat(20))
            .with_header("if-match", "\"pkv_0\"")
            .with_body_base64(STANDARD_NO_PAD.encode(br#"{"value":3}"#));
        let response = crate::host::call(&stale).unwrap();
        assert_eq!(response.status, 412);
    }

    #[test]
    fn fake_host_enforces_idempotency_key_shape() {
        let host = FakeHost::new();
        let _guard = host.install();
        let short = crate::host::HostCallRequest::new("PUT", "/api/plugin-runtime/storage/state")
            .with_header("idempotency-key", "short")
            .with_body_base64(STANDARD_NO_PAD.encode(br#"{"value":1}"#));
        assert_eq!(crate::host::call(&short).unwrap().status, 400);
    }
}
