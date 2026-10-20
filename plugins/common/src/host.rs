//! `host.call` 一次性往返(对照 Go `wasm.go:31` `wasmHostCall`)。
//!
//! 协议: 请求 `{"method":"host.call","params":{method,path,headers,body_base64}}`,
//! 响应 `{"result":{status,headers,body_base64}}` 或 `{"error":{code,message}}`。
//! 传输: `host_call(ptr,len)` 返回响应长度, `host_read(buf,n)` 把响应拷进 guest 缓冲。
//!
//! `ext` feature 下额外提供 chase-rs 的业务 HTTP 便捷层([`HttpResponse`] / [`get`] /
//! [`send`] / [`get_json`]); 它只组装请求、复用同一个 [`call`], 不改动上面的语义。

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

// 本机测试观察窗口: 统计**本线程**实际发起了多少次 host.call。
//
// 用途是守住"runtime.initialize 期间禁止 host.call"这条宿主限制 ——
// 一旦有人把 host 调用挪进初始化路径, 测试立刻失败。
//
// 计数是线程本地的: `cargo test` 并行跑用例, 存储层的用例会大量发起 host.call
// (走到 [`testhost`] 的替身上), 全进程共享的计数器会让"计数不变"这条断言随机失败。
// 用例自己创建 runtime 并在同一线程内断言, 线程本地计数刚好表达这层语义。
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

/// 记一次实际经 `host_call` 发出的调用(native 测试观察窗口; wasm32 编译为空函数)。
fn record_observed_call() {
    #[cfg(not(target_arch = "wasm32"))]
    OBSERVED_HOST_CALLS.with(|count| count.set(count.get() + 1));
}

/// 计数器读写的串行闸门(历史遗留: 计数改成线程本地后不再必需, 但保留给需要
/// 串行化"读计数 + 断言"序列的用例)。
///
/// 按 `cfg(not(target_arch = "wasm32"))` 编译并 `pub`: common 作为依赖被插件测试
/// 链接时 `cfg(test)` 为 false, 用 `cfg(test)` 会让插件的 `HOST_COUNTER_LOCK`
/// 引用链接不到。
#[cfg(not(target_arch = "wasm32"))]
pub static HOST_COUNTER_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
        Some(err) => Err(HostError::new(format!(
            "host RPC {}: {}",
            err.code, err.message
        ))),
        // 与 Go 一致: 既无 result 也无 error 时返回零值响应(调用方看 status)
        None => Ok(envelope.result.unwrap_or_default()),
    }
}

/// 本机(`cargo test`)用的 host.call 替身。
///
/// wasm32 上这段代码不存在(沙箱只提供真实宿主)。native 构建里它让测试走**真实**
/// 的 [`call`] 路径 —— 请求信封编码、长度校验、响应解析全部照旧 —— 只把跨进程往返
/// 换成同线程闭包(见各插件的 `testkit` / `FakeHost`)。
///
/// 按 `cfg(not(target_arch = "wasm32"))` 编译(不是 `cfg(test)`)且全部 `pub`:
/// chase-rs 的 `testkit` 在 native 非测试构建也会编译, 插件测试也需要从
/// `crate::host::testhost` 直接安装替身。
#[cfg(not(target_arch = "wasm32"))]
pub mod testhost {
    use super::{HostCallRequest, HostCallResponse, HostError};
    use std::cell::RefCell;

    pub type Handler = Box<dyn FnMut(&HostCallRequest) -> Result<HostCallResponse, HostError>>;

    thread_local! {
        static HANDLER: RefCell<Option<Handler>> = const { RefCell::new(None) };
    }

    pub fn install(handler: Handler) {
        HANDLER.with(|slot| *slot.borrow_mut() = Some(handler));
    }

    pub fn clear() {
        HANDLER.with(|slot| *slot.borrow_mut() = None);
    }

    /// 本线程装了替身就交给它, 否则返回 `None`(走真实导入, 本机是 abi_stub 的失败实现)。
    pub fn dispatch(request: &HostCallRequest) -> Option<Result<HostCallResponse, HostError>> {
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
    let envelope = HostCallEnvelope {
        method: "host.call",
        params: request,
    };
    serde_json::to_vec(&envelope)
        .map_err(|e| HostError::new(format!("host.call 请求编码失败: {e}")))
}

/// 发起一次 host.call。
pub fn call(request: &HostCallRequest) -> Result<HostCallResponse, HostError> {
    record_observed_call();

    #[cfg(not(target_arch = "wasm32"))]
    {
        if let Some(outcome) = testhost::dispatch(request) {
            return outcome;
        }
    }

    let payload = encode_request(request)?;
    let body = roundtrip(&payload)?;
    parse_host_envelope(&body)
}

/// 把一段已编码的 `host.*` 帧交给宿主, 返回原始响应字节。
///
/// 与 [`call`] 走完全相同的传输和长度校验; 抽出来是为了让 `host.capabilities`
/// 复用同一条通道, 而不经过 host.call 的 `params` 信封。
fn roundtrip(payload: &[u8]) -> Result<Vec<u8>, HostError> {
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
        return Err(HostError::new(format!(
            "host_read 返回长度 {got} 超过缓冲 {n}"
        )));
    }
    buf.truncate(got as usize);
    Ok(buf)
}

// ─────────────────── host.capabilities(host-call-v2.md §10) ───────────────────
//
// §10 只给出两种明确形状:
//   请求 `{"method":"host.capabilities"}`(host.* 运行时方法, 没有 params);
//   返回 `host_version` / `plugin_api` / `host_access` / `apis` /
//   `granted_apis` / `unavailable_apis`。§10 的示例是裸结果对象, §1 又定义了
//   JSON-RPC `result`/`error` 封套; 两种都接受。这里不臆造 `category` 之外的
//   字段, 也不按版本号推断能力。

/// `host.capabilities` 的出站请求体。
///
/// 文档 §10 明确给出 `{"method":"host.capabilities"}`, 不带 `params`, 因此不能复用
/// [`HostCallEnvelope`] 的 host.call 信封。serde 按字段序输出, 与文档逐字节一致。
#[derive(Debug, Serialize)]
struct HostCapabilitiesRequest<'a> {
    method: &'a str,
}

/// 编码 `host.capabilities` 请求。
pub fn encode_capabilities_request() -> Result<Vec<u8>, HostError> {
    serde_json::to_vec(&HostCapabilitiesRequest {
        method: "host.capabilities",
    })
    .map_err(|e| HostError::new(format!("host.capabilities 请求编码失败: {e}")))
}

/// Host API 目录中的一条接口。
///
/// §10 的 `apis` 条目带 `category`; 同一节的 `granted_apis` / `unavailable_apis`
/// 条目示例只有 `method`/`path`。用同一个结构承载, 缺少 `category` 时为空串。
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct HostApiEntry {
    pub method: String,
    pub path: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub category: String,
}

/// `host.capabilities` 返回的运行时自省结果(host-call-v2.md §10)。
///
/// 六个字段都是文档承诺的返回内容, 因此全部必填: 缺字段时宁可报错, 也不能用
/// serde 默认值伪造一份“宿主没有任何能力”的成功结果。
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct HostCapabilities {
    pub host_version: String,
    pub plugin_api: String,
    pub host_access: String,
    /// 宿主当前提供的完整 Host API 目录。
    pub apis: Vec<HostApiEntry>,
    /// 本安装实例已批准的接口。
    pub granted_apis: Vec<HostApiEntry>,
    /// Manifest 中声明为 optional、但当前宿主不提供的接口。
    pub unavailable_apis: Vec<HostApiEntry>,
}

/// 解析 `host.capabilities` 响应。
///
/// §10 的示例是裸结果对象; §1 又定义了 JSON-RPC `result`/`error` 封套。两种形状
/// 都接受, 但 `result` 内的字段必须齐全: capabilities 的字段全是自省数据, 缺失时
/// 返回空目录等于谎报“宿主没有任何能力”。任何失败都是可恢复的 `Err`, 由调用方
/// 决定回退策略。
pub fn parse_capabilities(body: &[u8]) -> Result<HostCapabilities, HostError> {
    let value: serde_json::Value = serde_json::from_slice(body)
        .map_err(|e| HostError::new(format!("host.capabilities 响应解析失败: {e}")))?;

    if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
        let error: HostRpcError = serde_json::from_value(error.clone())
            .map_err(|e| HostError::new(format!("host.capabilities 错误响应解析失败: {e}")))?;
        return Err(HostError::new(format!(
            "host RPC {}: {}",
            error.code, error.message
        )));
    }

    let result = match value.get("result") {
        Some(result) if !result.is_null() => result.clone(),
        Some(_) => return Err(HostError::new("host.capabilities 响应缺少 result")),
        // §10 的裸结果对象没有 result 外壳; 只把带 capabilities 字段的对象当作裸结果,
        // 这样 `{}` 或无关 JSON 仍会得到明确的“缺少 result”。
        None if CAPABILITIES_FIELDS
            .iter()
            .any(|field| value.get(field).is_some()) =>
        {
            value
        }
        None => return Err(HostError::new("host.capabilities 响应缺少 result")),
    };

    serde_json::from_value(result)
        .map_err(|e| HostError::new(format!("host.capabilities 响应解析失败: {e}")))
}

/// `HostCapabilities` 的字段名, 用于识别 §10 的裸结果对象。
const CAPABILITIES_FIELDS: [&str; 6] = [
    "host_version",
    "plugin_api",
    "host_access",
    "apis",
    "granted_apis",
    "unavailable_apis",
];

/// 发起一次 `host.capabilities` 自省调用。
///
/// 旧宿主不认识该方法时返回 JSON-RPC error, 这里统一转成 [`HostError`]; 不会
/// panic, 也不改变 [`call`] 的请求编码、响应解析或错误文案。
///
/// 和所有 host 调用一样, **不能**在 `runtime.initialize` 握手期间调用(宿主禁止
/// 那时的 host.call 重入); 本模块也不会把它接进初始化路径。
pub fn capabilities() -> Result<HostCapabilities, HostError> {
    record_observed_call();
    let payload = encode_capabilities_request()?;
    let body = roundtrip(&payload)?;
    parse_capabilities(&body)
}

// ─────────────────── 业务 HTTP 便捷层(chase-rs, ext) ───────────────────

/// 一次业务 host.call 的结果: HTTP 状态 + 已解码的 body。
#[cfg(feature = "ext")]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: i32,
    pub raw: Vec<u8>,
}

#[cfg(feature = "ext")]
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
#[cfg(feature = "ext")]
pub fn decode_response_body(response: &HostCallResponse) -> Result<Vec<u8>, HostError> {
    if response.body_base64.is_empty() {
        return Ok(Vec::new());
    }
    if let Ok(bytes) =
        base64::engine::general_purpose::STANDARD_NO_PAD.decode(&response.body_base64)
    {
        return Ok(bytes);
    }
    base64::engine::general_purpose::STANDARD
        .decode(&response.body_base64)
        .map_err(|_| HostError::new("host 响应 body_base64 解码失败"))
}

/// 发起一次不带请求体的业务 host.call。
#[cfg(feature = "ext")]
pub fn get(path: &str) -> Result<HttpResponse, HostError> {
    send("GET", path, None, &[("accept", "application/json")])
}

/// 发起一次业务 host.call。
///
/// `headers` 里已含 `content-type` 时以调用方为准; 有 body 时自动补
/// `content-type: application/json` 并做 RawStd base64 编码。
#[cfg(feature = "ext")]
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
    Ok(HttpResponse {
        status: response.status,
        raw,
    })
}

/// 发起一次业务 host.call(GET), 解析成 JSON; HTTP >= 400 或非法 JSON 都是 Err。
#[cfg(feature = "ext")]
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
    fn capabilities_request_matches_documented_shape() {
        let text = String::from_utf8(encode_capabilities_request().unwrap()).unwrap();
        // host-call-v2.md §10 原样给出, 没有 params / jsonrpc / id。
        assert_eq!(text, r#"{"method":"host.capabilities"}"#);
    }

    #[test]
    fn capabilities_parse_documented_example() {
        // §10 的字段, 套进 §1 描述的 JSON-RPC result 封套。
        let body = br#"{"jsonrpc":"2.0","id":"p:call:1","result":{
            "host_version":"3.9.0",
            "plugin_api":"2.0.0",
            "host_access":"standard",
            "apis":[{"method":"GET","path":"/api/tmdb/search","category":"tmdb"}],
            "granted_apis":[{"method":"GET","path":"/api/tmdb/search"}],
            "unavailable_apis":[]
        }}"#;
        let caps = parse_capabilities(body).unwrap();
        assert_eq!(caps.host_version, "3.9.0");
        assert_eq!(caps.plugin_api, "2.0.0");
        assert_eq!(caps.host_access, "standard");
        assert_eq!(
            caps.apis,
            vec![HostApiEntry {
                method: "GET".into(),
                path: "/api/tmdb/search".into(),
                category: "tmdb".into(),
            }]
        );
        // granted/unavailable 的条目在示例里省略 category。
        assert_eq!(
            caps.granted_apis,
            vec![HostApiEntry {
                method: "GET".into(),
                path: "/api/tmdb/search".into(),
                category: String::new(),
            }]
        );
        assert!(caps.unavailable_apis.is_empty());
    }

    #[test]
    fn capabilities_parse_unavailable_entries() {
        let body = br#"{"result":{
            "host_version":"3.8.0","plugin_api":"2.0.0","host_access":"extended",
            "apis":[],
            "granted_apis":[],
            "unavailable_apis":[{"method":"GET","path":"/api/plugin-host/emby/episodes"}]
        }}"#;
        let caps = parse_capabilities(body).unwrap();
        assert_eq!(caps.host_access, "extended");
        assert_eq!(
            caps.unavailable_apis,
            vec![HostApiEntry {
                method: "GET".into(),
                path: "/api/plugin-host/emby/episodes".into(),
                category: String::new(),
            }]
        );
    }

    #[test]
    fn capabilities_parse_bare_result_object() {
        // §10 的返回块本身没有 result 外壳。
        let body = br#"{
            "host_version":"3.9.0","plugin_api":"2.0.0","host_access":"standard",
            "apis":[],"granted_apis":[],"unavailable_apis":[]
        }"#;
        let caps = parse_capabilities(body).unwrap();
        assert_eq!(caps.host_version, "3.9.0");
        assert!(caps.apis.is_empty());
    }

    #[test]
    fn capabilities_missing_required_fields_fail_closed() {
        let full = serde_json::json!({
            "host_version":"3.9.0",
            "plugin_api":"2.0.0",
            "host_access":"standard",
            "apis":[],
            "granted_apis":[],
            "unavailable_apis":[]
        });
        for field in CAPABILITIES_FIELDS {
            let mut value = full.clone();
            value.as_object_mut().unwrap().remove(field);
            let body = serde_json::to_vec(&value).unwrap();
            let err = parse_capabilities(&body).unwrap_err();
            assert!(
                err.to_string()
                    .contains(&format!("missing field `{field}`")),
                "缺 {field} 时应 fail closed, 实际: {err}"
            );
        }
    }

    #[test]
    fn capabilities_result_missing_fields_fail_closed() {
        // 复核 probe 的两种输入: result 为空 / 只有版本字段。不能返回 Ok 空目录。
        let err = parse_capabilities(br#"{"result":{}}"#).unwrap_err();
        assert!(
            err.to_string().contains("missing field `host_version`"),
            "实际: {err}"
        );
        let err = parse_capabilities(
            br#"{"result":{"host_version":"3.9.0","plugin_api":"2.0.0","host_access":"standard"}}"#,
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("missing field `apis`"),
            "实际: {err}"
        );
    }

    #[test]
    fn capabilities_null_required_fields_fail_closed() {
        let full = serde_json::json!({
            "host_version":"3.9.0",
            "plugin_api":"2.0.0",
            "host_access":"standard",
            "apis":[],
            "granted_apis":[],
            "unavailable_apis":[]
        });
        for field in CAPABILITIES_FIELDS {
            let mut value = full.clone();
            value[field] = serde_json::Value::Null;
            let body = serde_json::to_vec(&value).unwrap();
            assert!(
                parse_capabilities(&body).is_err(),
                "字段 {field} 为 null 时应 fail closed"
            );
        }
    }

    #[test]
    fn capabilities_incomplete_api_entry_fails_closed() {
        let body = br#"{"result":{
            "host_version":"3.9.0","plugin_api":"2.0.0","host_access":"standard",
            "apis":[],
            "granted_apis":[{"path":"/api/tmdb/search"}],
            "unavailable_apis":[]
        }}"#;
        let err = parse_capabilities(body).unwrap_err();
        assert!(
            err.to_string().contains("missing field `method`"),
            "实际: {err}"
        );
    }

    #[test]
    fn capabilities_error_envelope_is_reported() {
        let err = parse_capabilities(br#"{"error":{"code":-32601,"message":"method not found"}}"#)
            .unwrap_err();
        assert_eq!(err.to_string(), "host RPC -32601: method not found");
    }

    #[test]
    fn capabilities_missing_result_is_an_error() {
        // 不能把“没有 result”伪装成一份空能力目录。
        let err = parse_capabilities(br#"{"jsonrpc":"2.0","id":"p:call:1"}"#).unwrap_err();
        assert_eq!(err.to_string(), "host.capabilities 响应缺少 result");
    }

    #[test]
    fn capabilities_parse_failure_is_reported() {
        let err = parse_capabilities(b"<html>502</html>").unwrap_err();
        assert!(
            err.to_string()
                .starts_with("host.capabilities 响应解析失败: "),
            "实际: {err}"
        );
    }

    /// 本机(无宿主)调用必须返回可恢复的 Err, 与 host.call 的 abi_stub 行为一致。
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn capabilities_native_stub_is_recoverable() {
        let _guard = HOST_COUNTER_LOCK.lock().unwrap();
        let before = observed_calls();
        let err = capabilities().unwrap_err();
        assert_eq!(err.to_string(), "host_call 返回长度 0");
        assert_eq!(observed_calls(), before + 1);
    }

    /// 现有 host.call 编码/解析不受 capabilities 影响。
    #[test]
    fn host_call_request_shape_is_unchanged() {
        let req = HostCallRequest::new("GET", "/api/tmdb/search")
            .with_header("accept", "application/json");
        let text = String::from_utf8(encode_request(&req).unwrap()).unwrap();
        assert_eq!(
            text,
            r#"{"method":"host.call","params":{"method":"GET","path":"/api/tmdb/search","headers":{"accept":"application/json"}}}"#
        );
        let resp =
            parse_host_envelope(br#"{"result":{"status":200,"headers":null,"body_base64":""}}"#)
                .unwrap();
        assert_eq!(resp.status, 200);
    }
}
