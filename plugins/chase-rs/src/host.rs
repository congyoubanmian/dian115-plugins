//! `host.call` 一次性往返(对照 Go `wasm.go:31` `wasmHostCall`)。
//!
//! 协议: 请求 `{"method":"host.call","params":{method,path,headers,body_base64}}`,
//! 响应 `{"result":{status,headers,body_base64}}` 或 `{"error":{code,message}}`。
//! 传输: `host_call(ptr,len)` 返回响应长度, `host_read(buf,n)` 把响应拷进 guest 缓冲。
//!
//! 从 douban-rs 的 `host.rs` 原样移植(与业务无关), 未做删减: 存储层与后续业务动作
//! 都只经这一个出口发起宿主调用。

use std::collections::BTreeMap;

use base64::Engine as _;
use serde::{Deserialize, Deserializer, Serialize};

/// 响应长度上限, 与 Go `wasm.go:41` 的 `n > (8<<20)` 一致。
pub const MAX_HOST_RESPONSE: u32 = 8 << 20;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "dian115")]
extern "C" {
    fn host_call(ptr: u32, len: u32) -> u32;
    fn host_read(ptr: u32, len: u32) -> u32;
}

/// 保活: wasm-ld 会丢掉没有任何引用的导入, 而 dian115:wasm@1 要求模块声明这两个导入。
#[cfg(target_arch = "wasm32")]
#[used]
static HOST_CALL_IMPORT: unsafe extern "C" fn(u32, u32) -> u32 = host_call;
#[cfg(target_arch = "wasm32")]
#[used]
static HOST_READ_IMPORT: unsafe extern "C" fn(u32, u32) -> u32 = host_read;

/// 非 wasm32 的占位实现(对应 Go 的 `abi_stub.go`, 本机 `cargo test` 用, 恒失败)。
#[cfg(not(target_arch = "wasm32"))]
#[allow(clippy::missing_safety_doc)]
pub unsafe fn host_call(_ptr: u32, _len: u32) -> u32 {
    0
}

#[cfg(not(target_arch = "wasm32"))]
#[allow(clippy::missing_safety_doc)]
pub unsafe fn host_read(_ptr: u32, _len: u32) -> u32 {
    0
}

// 本机测试观察窗口: 统计**本线程**实际发起了多少次 host.call。
//
// 用途是守住"runtime.initialize 期间禁止 host.call"这条宿主限制 —— 一旦有人把
// host 调用挪进初始化路径, 测试立刻失败。计数是线程本地的: `cargo test` 并行跑用例,
// 存储层用例会大量发起 host.call, 全进程共享的计数器会让"计数不变"这条断言随机失败。
#[cfg(not(target_arch = "wasm32"))]
thread_local! {
    static OBSERVED_HOST_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// 本线程已发起的 host.call 次数(wasm32 上恒为 0: 那个目标下没有测试在跑)。
pub fn observed_calls() -> usize {
    #[cfg(not(target_arch = "wasm32"))]
    {
        OBSERVED_HOST_CALLS.with(std::cell::Cell::get)
    }
    #[cfg(target_arch = "wasm32")]
    {
        0
    }
}

/// 计数器读写的串行闸门(需要"读计数 + 断言"原子性的用例用)。
#[cfg(test)]
pub(crate) static HOST_COUNTER_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// host.call 请求 (Go `main.go:62` `hostCallRequest`)。
///
/// 字段顺序与 Go 结构体一致, 空字段按 Go 的 `omitempty` 省掉 ——
/// 宿主侧的幂等指纹依赖请求体的稳定形态。
#[derive(Debug, Clone, Default, Serialize)]
pub struct HostCallRequest {
    pub method: String,
    pub path: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub body_base64: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub credential_ref: String,
}

impl HostCallRequest {
    pub fn new(method: impl Into<String>, path: impl Into<String>) -> Self {
        HostCallRequest { method: method.into(), path: path.into(), ..Default::default() }
    }

    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.insert(name.into(), value.into());
        self
    }

    pub fn with_body_base64(mut self, body: impl Into<String>) -> Self {
        self.body_base64 = body.into();
        self
    }
}

/// host.call 响应 (Go `main.go:70` `hostCallResponse`)。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostCallResponse {
    #[serde(default, deserialize_with = "null_to_default")]
    pub status: i32,
    /// Go 的 `map[string][]string`: 头部名大小写不敏感由调用方处理, nil 与 null 都当空表。
    #[serde(default, deserialize_with = "null_to_default")]
    pub headers: BTreeMap<String, Vec<String>>,
    #[serde(default, deserialize_with = "null_to_default")]
    pub body_base64: String,
}

/// `null` 等价于零值: Go 的 `map`/`string`/`int` 字段遇到 `"headers":null` 不报错。
fn null_to_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// 宿主 RPC 层错误 (Go `wasm.go:51` 的内联结构)。
#[derive(Debug, Clone, Deserialize)]
pub struct HostRpcError {
    #[serde(default, deserialize_with = "null_to_default")]
    pub code: i32,
    #[serde(default, deserialize_with = "null_to_default")]
    pub message: String,
}

/// host.call 失败的错误信息(与 Go 的 `fmt.Errorf` 文案一致)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostError(pub String);

impl HostError {
    pub fn new(message: impl Into<String>) -> Self {
        HostError(message.into())
    }

    pub fn message(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for HostError {}

/// host.call 响应信封 (Go `wasm.go:49` 的内联结构)。
#[derive(Debug, Deserialize)]
pub struct HostEnvelope {
    #[serde(default)]
    pub result: Option<HostCallResponse>,
    #[serde(default)]
    pub error: Option<HostRpcError>,
}

/// 解析宿主返回的信封(等价于 Go `wasm.go:56` 起的解析与错误分支)。
pub fn parse_host_envelope(body: &[u8]) -> Result<HostCallResponse, HostError> {
    let envelope: HostEnvelope = serde_json::from_slice(body)
        .map_err(|e| HostError::new(format!("host 响应解析失败: {e}")))?;
    match envelope.error {
        Some(err) => Err(HostError::new(format!("host RPC {}: {}", err.code, err.message))),
        // 与 Go 一致: 既无 result 也无 error 时返回零值响应(调用方看 status)
        None => Ok(envelope.result.unwrap_or_default()),
    }
}

/// 本机(`cargo test`)用的 host.call 替身。
///
/// wasm32 上这段代码不存在(沙箱只提供真实宿主)。native 构建里它让测试走**真实**的
/// [`call`] 路径 —— 请求信封编码、长度校验、响应解析全部照旧 —— 只把跨进程往返换成
/// 同线程闭包。
#[cfg(not(target_arch = "wasm32"))]
#[allow(dead_code)]
pub(crate) mod testhost {
    use super::{HostCallRequest, HostCallResponse, HostError};
    use std::cell::RefCell;

    type Handler = Box<dyn FnMut(&HostCallRequest) -> Result<HostCallResponse, HostError>>;

    thread_local! {
        static HANDLER: RefCell<Option<Handler>> = const { RefCell::new(None) };
    }

    pub(crate) fn install(handler: Handler) {
        HANDLER.with(|slot| *slot.borrow_mut() = Some(handler));
    }

    pub(crate) fn clear() {
        HANDLER.with(|slot| *slot.borrow_mut() = None);
    }

    /// 本线程装了替身就交给它, 否则返回 `None`(走真实导入, 本机是 abi_stub 的失败实现)。
    pub(crate) fn dispatch(request: &HostCallRequest) -> Option<Result<HostCallResponse, HostError>> {
        HANDLER.with(|slot| slot.borrow_mut().as_mut().map(|handler| handler(request)))
    }
}

/// 把请求体编码成 `body_base64`(Go `base64.RawStdEncoding`)。
///
/// 宿主文档: "body, unpadded base64 in responses"; 请求侧同样用不补 padding 的形态。
pub fn encode_body_base64(body: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD_NO_PAD.encode(body)
}

/// 出站信封 (Go `wasm.go:33` `json.Marshal(map[string]any{"method": ..., "params": request})`)。
///
/// 用结构体而不是 `json!`/`Value` 组装: serde_json 的 Value 对象是 BTreeMap(键按字典序),
/// 而 Go 的 encoding/json 是按**结构体字段序**输出 `params` 的 —— 只有结构体才能逐字节
/// 对齐 Go 的请求体(宿主对 host.call 的幂等指纹依赖请求体的稳定形态)。
#[derive(Debug, Serialize)]
pub struct HostCallEnvelope<'a> {
    pub method: &'a str,
    pub params: &'a HostCallRequest,
}

/// 把一次 host.call 编码成出站 JSON 字节(与 Go 的 `json.Marshal` 同序同形)。
pub fn encode_request(request: &HostCallRequest) -> Result<Vec<u8>, HostError> {
    let envelope = HostCallEnvelope { method: "host.call", params: request };
    serde_json::to_vec(&envelope).map_err(|e| HostError::new(format!("host.call 请求编码失败: {e}")))
}

/// 发起一次 host.call。
pub fn call(request: &HostCallRequest) -> Result<HostCallResponse, HostError> {
    #[cfg(not(target_arch = "wasm32"))]
    OBSERVED_HOST_CALLS.with(|count| count.set(count.get() + 1));

    #[cfg(not(target_arch = "wasm32"))]
    {
        if let Some(outcome) = testhost::dispatch(request) {
            return outcome;
        }
    }

    let payload = encode_request(request)?;

    // 请求缓冲放堆上(不用 arena): 它必须活到 host_read 完成之后。
    let n = unsafe { host_call(payload.as_ptr() as u32, payload.len() as u32) };
    if n == 0 || n > MAX_HOST_RESPONSE {
        return Err(HostError::new(format!("host_call 返回长度 {n}")));
    }

    let mut buf = vec![0u8; n as usize];
    let got = unsafe { host_read(buf.as_mut_ptr() as u32, n) };
    if got == 0 {
        return Err(HostError::new("host_read 返回 0"));
    }
    if got > n {
        return Err(HostError::new(format!("host_read 返回长度 {got} 超过缓冲 {n}")));
    }
    parse_host_envelope(&buf[..got as usize])
}

// ─────────────────── 追剧管家新增: 业务 HTTP 便捷层 ───────────────────
//
// douban-rs 的 host.rs 只有 `call` + 信封解析; 业务模块(订阅池/Emby/日历/通知)要的是
// "发一个请求, 拿 HTTP 状态 + 解码后的 body"。这层只做三件事, 不改动上面的任何语义:
// ① 组装 `HostCallRequest`; ② 走同一个 [`call`](因此本机测试里同样落到 `testhost` 替身上);
// ③ 解 `body_base64`(先 RawStd 再 Std, 与存储层 `decode_body` 同一套顺序)。

/// 一次业务 host.call 的结果: HTTP 状态 + 已解码的 body。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: i32,
    pub raw: Vec<u8>,
}

impl HttpResponse {
    /// 文本形态(诊断/错误信息用; 非 UTF-8 按 lossy 处理, 不 panic)。
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.raw).into_owned()
    }

    /// 前 200 字节的摘要(错误信息里回显用, 避免把整段 body 灌进日志)。
    pub fn excerpt(&self) -> String {
        let cut = self.raw.len().min(200);
        String::from_utf8_lossy(&self.raw[..cut]).into_owned()
    }
}

/// 解出响应 body(与存储层同一顺序: 先不补 padding 的 RawStd, 再补 padding 的 Std)。
pub fn decode_response_body(response: &HostCallResponse) -> Result<Vec<u8>, HostError> {
    if response.body_base64.is_empty() {
        return Ok(Vec::new());
    }
    if let Ok(bytes) = base64::engine::general_purpose::STANDARD_NO_PAD.decode(&response.body_base64)
    {
        return Ok(bytes);
    }
    base64::engine::general_purpose::STANDARD
        .decode(&response.body_base64)
        .map_err(|_| HostError::new("host 响应 body_base64 解码失败"))
}

/// 发起一次不带请求体的业务 host.call。
pub fn get(path: &str) -> Result<HttpResponse, HostError> {
    send("GET", path, None, &[("accept", "application/json")])
}

/// 发起一次业务 host.call。
///
/// `headers` 里已含 `content-type` 时以调用方为准; 有 body 时自动补
/// `content-type: application/json` 并做 RawStd base64 编码。
pub fn send(
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    headers: &[(&str, &str)],
) -> Result<HttpResponse, HostError> {
    let mut request = HostCallRequest::new(method, path);
    for (name, value) in headers {
        request = request.with_header(*name, *value);
    }
    if let Some(body) = body {
        if !request.headers.contains_key("content-type") {
            request = request.with_header("content-type", "application/json");
        }
        request = request.with_body_base64(encode_body_base64(body));
    }
    let response = call(&request)?;
    let raw = decode_response_body(&response)?;
    Ok(HttpResponse { status: response.status, raw })
}

/// 发起一次业务 host.call(GET), 解析成 JSON; HTTP >= 400 或非法 JSON 都是 Err。
pub fn get_json(path: &str) -> Result<(i32, serde_json::Value), HostError> {
    let response = get(path)?;
    if response.status >= 400 {
        return Err(HostError::new(format!(
            "HTTP {}: {}",
            response.status,
            response.excerpt()
        )));
    }
    let value = serde_json::from_slice(&response.raw)
        .map_err(|err| HostError::new(format!("响应不是合法 JSON: {err}")))?;
    Ok((response.status, value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_envelope_matches_go_shape() {
        let req = HostCallRequest::new("GET", "/api/plugin-runtime/storage/state")
            .with_header("accept", "application/json");
        let text = String::from_utf8(encode_request(&req).unwrap()).unwrap();
        assert_eq!(
            text,
            r#"{"method":"host.call","params":{"method":"GET","path":"/api/plugin-runtime/storage/state","headers":{"accept":"application/json"}}}"#
        );

        // 空 headers/body/credential 必须省略(Go 的 omitempty)
        let bare = String::from_utf8(encode_request(&HostCallRequest::new("PUT", "/x")).unwrap())
            .unwrap();
        assert_eq!(bare, r#"{"method":"host.call","params":{"method":"PUT","path":"/x"}}"#);
    }

    #[test]
    fn native_stub_fails_like_go_abi_stub() {
        let _guard = HOST_COUNTER_LOCK.lock().unwrap();
        let before = observed_calls();
        let err = call(&HostCallRequest::new("GET", "/api/plugin-runtime/storage/state")).unwrap_err();
        assert_eq!(err.to_string(), "host_call 返回长度 0");
        assert_eq!(observed_calls(), before + 1, "调用计数用于守住 initialize 不碰 host");
    }

    #[test]
    fn response_envelope_accepts_go_nulls() {
        let body = br#"{"result":{"status":404,"headers":null,"body_base64":""}}"#;
        let resp = parse_host_envelope(body).unwrap();
        assert_eq!(resp.status, 404);
        assert!(resp.headers.is_empty());
        assert_eq!(resp.body_base64, "");

        // 既无 result 也无 error → 零值(Go 的行为)
        let resp = parse_host_envelope(br#"{}"#).unwrap();
        assert_eq!(resp, HostCallResponse::default());
    }

    #[test]
    fn response_envelope_reports_host_rpc_error() {
        let body = br#"{"error":{"code":-32601,"message":"method not found"}}"#;
        let err = parse_host_envelope(body).unwrap_err();
        assert_eq!(err.to_string(), "host RPC -32601: method not found");
    }

    #[test]
    fn response_envelope_parse_failure_is_reported() {
        let err = parse_host_envelope(b"<html>502</html>").unwrap_err();
        assert!(err.to_string().starts_with("host 响应解析失败: "), "实际: {err}");
    }

    /// 请求体 base64 必须是不补 padding 的形态(宿主文档 + Go `RawStdEncoding`)。
    #[test]
    fn body_base64_is_raw_std() {
        assert_eq!(encode_body_base64(br#"{"tmdb_id":1}"#), "eyJ0bWRiX2lkIjoxfQ");
        assert!(!encode_body_base64(&[0xff, 0xff, 0xff]).contains('='), "RawStd 不带 padding");
        assert_eq!(encode_body_base64(b""), "");
    }

    #[test]
    fn business_send_sets_content_type_and_decodes_body() {
        let fake = crate::testkit::FakeHost::new();
        fake.json("/api/subscribe/pool/intents", 200, br#"{"code":"ok","data":[]}"#);
        let _guard = fake.install();
        let response = get("/api/subscribe/pool/intents").unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.raw, br#"{"code":"ok","data":[]}"#);
        assert_eq!(response.text(), r#"{"code":"ok","data":[]}"#);

        // 有 body 时自动补 content-type, 并做 RawStd 编码
        let body = br#"{"total_episodes":12}"#;
        send("PATCH", "/api/subscribe/pool/intents/1/episodes", Some(body), &[]).unwrap();
        let requests = fake.requests();
        let patch = &requests[1];
        assert_eq!(patch.method, "PATCH");
        assert_eq!(
            patch.headers.get("content-type").map(String::as_str),
            Some("application/json")
        );
        assert_eq!(
            crate::host::decode_response_body(&HostCallResponse {
                status: 200,
                headers: Default::default(),
                body_base64: patch.body_base64.clone(),
            })
            .unwrap(),
            body.to_vec()
        );
    }

    #[test]
    fn business_get_json_reports_http_and_parse_errors() {
        let fake = crate::testkit::FakeHost::new();
        fake.json("/api/x", 500, b"boom");
        let _guard = fake.install();
        let err = get_json("/api/x").unwrap_err();
        assert!(err.to_string().starts_with("HTTP 500: boom"), "{err}");
        fake.json("/api/y", 200, b"<html>");
        assert!(get_json("/api/y").unwrap_err().to_string().contains("不是合法 JSON"));
    }
}

