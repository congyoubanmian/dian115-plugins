//! `host.call` 一次性往返(对照 Go `wasm.go:31` `wasmHostCall`)。
//!
//! 协议: 请求 `{"method":"host.call","params":{method,path,headers,body_base64}}`,
//! 响应 `{"result":{status,headers,body_base64}}` 或 `{"error":{code,message}}`。
//! 传输: `host_call(ptr,len)` 返回响应长度, `host_read(buf,n)` 把响应拷进 guest 缓冲。
//!
//! 本阶段(协议层)不发起任何 host 调用; 这里先把通道和错误语义对齐, 供存储层直接使用。

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
/// 协议层的调用点(LTO 可能判定不可达)之外再挂一个显式引用, 保证导入段里始终有它们。
#[cfg(target_arch = "wasm32")]
#[used]
static HOST_CALL_IMPORT: unsafe extern "C" fn(u32, u32) -> u32 = host_call;
#[cfg(target_arch = "wasm32")]
#[used]
static HOST_READ_IMPORT: unsafe extern "C" fn(u32, u32) -> u32 = host_read;

/// 非 wasm32 的占位实现: 对应 Go 的 `abi_stub.go`(本机 `cargo test` 用, 恒失败)。
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

/// 本机测试观察窗口: 统计**本线程**实际发起了多少次 host.call。
///
/// 用途是守住"runtime.initialize 期间禁止 host.call"这条宿主限制 ——
/// 一旦有人把 host 调用挪进初始化路径, 测试立刻失败。
///
/// 计数是线程本地的: `cargo test` 并行跑用例, 存储层的用例会大量发起 host.call
/// (走到 [`testhost`] 的替身上), 全进程共享的计数器会让"计数不变"这条断言随机失败。
/// 用例自己创建 runtime 并在同一线程内断言, 线程本地计数刚好表达这层语义。
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

/// 计数器读写的串行闸门(历史遗留: 计数改成线程本地后不再必需, 但保留给需要
/// 串行化"读计数 + 断言"序列的用例)。
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
        HostCallRequest {
            method: method.into(),
            path: path.into(),
            ..Default::default()
        }
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
/// wasm32 上这段代码不存在(sandbox 只提供真实宿主)。native 构建里它让测试走**真实**
/// 的 [`call`] 路径 —— 请求信封编码、长度校验、响应解析全部照旧 —— 只把跨进程往返
/// 换成同线程闭包(见 [`crate::testkit::FakeHost`])。
#[cfg(not(target_arch = "wasm32"))]
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

/// 把请求体编码成 `body_base64`(Go `base64.RawStdEncoding`, 见 `main.go:1008`/`wasm.go:210`)。
///
/// 宿主文档: "body, unpadded base64 in responses"; 请求侧同样用不补 padding 的形态。
/// 需要直接发 POST 的调用方(如 `subscribe::create_subscription`)用它, 不要手写 padding。
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
}
