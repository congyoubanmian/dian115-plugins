//! JSON-RPC 分发(从 douban-rs `src/protocol.rs` 移植, 协议层完全相同)。
//!
//! 宿主发来的完整消息:
//! ```json
//! {"method":"runtime.invoke","params":{"envelope":{"op":"state","invocation_id":"inv_1","payload":{}},"background":false}}
//! ```
//! 响应形状(与 Go 版逐字节一致):
//! - 成功: `{"result": ...}`
//! - 失败: `{"error":{"code":N,"message":"..."}}`
//! - `shutdown`: `{"stopping":true}`(**不包 result**)
//! - `runtime.initialize`: `{"result":{"ready":true,"protocol":"dian115:wasm@1"}}`

use serde::Serialize;
use serde_json::Value;

use crate::host;
use crate::raw::{InvokeParams, RpcMessage};
use crate::runtime::Runtime;
use crate::util;

/// 未知 op 的错误码(`-32601`)。
pub const CODE_METHOD_NOT_FOUND: i32 = -32601;
/// 业务错误码(`-32602`)。
pub const CODE_INVALID_PARAMS: i32 = -32602;
/// panic 兜底的错误码(`-32603`)。
pub const CODE_INTERNAL: i32 = -32603;

/// 宿主 ABI 协议标识。
pub const PROTOCOL: &str = "dian115:wasm@1";

/// 业务错误: invoke/handle 返回的 error 一律映射成 `-32602`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpError(pub String);

impl OpError {
    pub fn new(message: impl Into<String>) -> Self {
        OpError(message.into())
    }

    pub fn message(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for OpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for OpError {}

#[derive(Serialize)]
struct ErrorBody {
    code: i32,
    message: String,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: ErrorBody,
}

#[derive(Serialize)]
struct ResultResponse {
    result: Value,
}

#[derive(Serialize)]
struct StoppingResponse {
    stopping: bool,
}

/// initialize 的结果体。字段顺序固定为 ready 在前 —— 与宿主约定的字面形状一致。
#[derive(Serialize)]
struct InitializeResult<'a> {
    ready: bool,
    protocol: &'a str,
}

#[derive(Serialize)]
struct InitializeResponse<'a> {
    result: InitializeResult<'a>,
}

/// 组装 `{"error":{"code":...,"message":...}}`。
pub fn rpc_error(code: i32, message: impl Into<String>) -> Vec<u8> {
    util::encode_or_fallback(&ErrorResponse {
        error: ErrorBody { code, message: message.into() },
    })
}

/// 组装 `{"result": ...}`。
pub fn result_ok(value: Value) -> Vec<u8> {
    util::encode_or_fallback(&ResultResponse { result: value })
}

/// 组装 `{"stopping":true}`(顶层字段不是 result)。
pub fn stopping() -> Vec<u8> {
    util::encode_or_fallback(&StoppingResponse { stopping: true })
}

/// 组装 initialize 握手响应 —— 期间**不允许**任何 host.call(宿主限制)。
///
/// 走结构体而不是 `json!`/`to_value`: 后者底层是 BTreeMap, 会把键按字典序重排。
pub fn initialize_result() -> Vec<u8> {
    util::encode_or_fallback(&InitializeResponse {
        result: InitializeResult { ready: true, protocol: PROTOCOL },
    })
}

/// 分发入口。
///
/// `request` 是宿主写在 arena 里的原始请求字节; 返回值是响应 JSON 字节,
/// 由 `abi` 层写回 arena 并换算成 `(地址<<32 | 长度)`。
pub fn dispatch(runtime: &mut Runtime, request: &[u8]) -> Vec<u8> {
    guard(|| dispatch_inner(runtime, request))
}

/// panic 兜底(`recover` → `-32603 PANIC: ...`)。
///
/// `panic = "abort"`(wasm release)下无法捕获, 只能由宿主看到 trap;
/// 本机 `cargo test`(unwind)下与 Go 行为一致。
#[cfg(panic = "unwind")]
fn guard<F: FnOnce() -> Vec<u8>>(f: F) -> Vec<u8> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(response) => response,
        Err(payload) => rpc_error(CODE_INTERNAL, format!("PANIC: {}", panic_text(&payload))),
    }
}

#[cfg(not(panic = "unwind"))]
fn guard<F: FnOnce() -> Vec<u8>>(f: F) -> Vec<u8> {
    f()
}

#[cfg(panic = "unwind")]
fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        return (*s).to_string();
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    "unknown panic".to_string()
}

fn dispatch_inner(runtime: &mut Runtime, request: &[u8]) -> Vec<u8> {
    // ① 外层消息: 非 JSON / 无 method → -32602 "invalid invoke: recv=<前200字节>"
    let message = match RpcMessage::parse(request) {
        Ok(message) => message,
        Err(_) => return rpc_error(CODE_INVALID_PARAMS, format!("invalid invoke: recv={}", util::trunc(request))),
    };
    let method = message.method();

    // ② 初始化握手: 直接返回 ready, 期间禁止 host.call 重入。
    if method == "runtime.initialize" {
        return initialize_result();
    }

    // ②b 首次业务调用才加载宿主存储。位置与 Go 版一致: initialize 之后、
    //     解析业务参数之前 —— 参数非法时 runtime 也已经建好, 但握手期间绝不碰 host.call。
    runtime.ensure_loaded();

    // ③ 业务参数: 缺失 → 空 recv; 解析失败或 op 为空 → -32602
    let params = match message.params.as_ref() {
        Some(params) => params,
        None => return rpc_error(CODE_INVALID_PARAMS, invalid_params_message(method, b"")),
    };
    let input = match InvokeParams::parse(params) {
        Ok(input) => input,
        Err(_) => {
            let echoed = util::value_text(params);
            return rpc_error(CODE_INVALID_PARAMS, invalid_params_message(method, &echoed));
        }
    };
    if input.op.is_empty() {
        let echoed = util::value_text(params);
        return rpc_error(CODE_INVALID_PARAMS, invalid_params_message(method, &echoed));
    }

    // ④ op 分发。
    let outcome = match input.op.as_str() {
        "state" => runtime.state(input.payload),
        "action" => runtime.action(&input.invocation_id, input.payload),
        "job" => runtime.job(&input.invocation_id, input.payload),
        "event" => runtime.event(input.payload),
        // Go 版在分发层直接返回 {"stopping":true}, 不进 runtime(因此也不落盘)
        "shutdown" => return stopping(),
        other => {
            return rpc_error(CODE_METHOD_NOT_FOUND, format!("unsupported op: {other}"));
        }
    };

    match outcome {
        Ok(result) => result_ok(result),
        Err(err) => rpc_error(CODE_INVALID_PARAMS, err.message()),
    }
}

/// `"invalid params: method=" + method + " recv=" + trunc(params)`。
fn invalid_params_message(method: &str, echoed: &[u8]) -> String {
    format!("invalid params: method={method} recv={}", util::trunc(echoed))
}

/// 供测试与后续阶段检查"本进程有没有发生过 host.call"。
pub fn observed_host_calls() -> usize {
    host::observed_calls()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::HOST_COUNTER_LOCK;
    use serde_json::{from_slice, json};

    fn dispatch_json(request: &str) -> Value {
        let mut runtime = Runtime::new();
        let raw = dispatch(&mut runtime, request.as_bytes());
        from_slice(&raw).unwrap_or_else(|e| {
            panic!("响应必须是合法 JSON: {e}; 实际 {:?}", String::from_utf8_lossy(&raw))
        })
    }

    #[test]
    fn initialize_returns_ready_byte_exact() {
        // 覆盖三种宿主可能的握手写法: 不带 params / 带 protocol / params 为 null
        for request in [
            r#"{"method":"runtime.initialize"}"#,
            r#"{"method":"runtime.initialize","params":{"protocol":"dian115:wasm@1"}}"#,
            r#"{"method":"runtime.initialize","params":null}"#,
        ] {
            let mut runtime = Runtime::new();
            let raw = dispatch(&mut runtime, request.as_bytes());
            assert_eq!(
                raw,
                br#"{"result":{"ready":true,"protocol":"dian115:wasm@1"}}"#.to_vec(),
                "请求: {request}"
            );
        }
    }

    /// 宿主硬限制: 初始化握手期间不允许任何 host.call(否则宿主会拒绝重入)。
    #[test]
    fn initialize_never_calls_host() {
        let _guard = HOST_COUNTER_LOCK.lock().unwrap();
        let before = observed_host_calls();
        for request in [
            r#"{"method":"runtime.initialize"}"#,
            r#"{"method":"runtime.initialize","params":{"protocol":"dian115:wasm@1"}}"#,
            r#"{"method":"runtime.initialize","params":{"unexpected":true}}"#,
        ] {
            let mut runtime = Runtime::new();
            let _ = dispatch(&mut runtime, request.as_bytes());
        }
        assert_eq!(observed_host_calls(), before, "initialize 期间发生了 host.call");
    }

    /// 未声明的 op → -32601; shutdown 顶层 stopping。
    #[test]
    fn unknown_op_and_shutdown() {
        let out = dispatch_json(
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"teleport","invocation_id":"inv_1"}}}"#,
        );
        assert_eq!(out, json!({"error": {"code": -32601, "message": "unsupported op: teleport"}}));

        let shutdown = dispatch_json(
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"shutdown","invocation_id":"inv_2"}}}"#,
        );
        assert_eq!(shutdown, json!({"stopping": true}));
        assert!(shutdown.get("result").is_none());
    }

    /// 非法消息逐条对齐: 非 JSON / 空 / 无 params / op 为空 / 类型不符。
    #[test]
    fn invalid_messages_use_invalid_params() {
        let cases: [(&str, &str); 6] = [
            ("", "invalid invoke: recv="),
            ("not json", "invalid invoke: recv=not json"),
            ("[1,2]", "invalid invoke: recv=[1,2]"),
            (r#"{"method":null}"#, "invalid invoke: recv={\"method\":null}"),
            (
                r#"{"method":"runtime.invoke"}"#,
                "invalid params: method=runtime.invoke recv=",
            ),
            (
                r#"{"method":"runtime.invoke","params":{"envelope":{"op":""}}}"#,
                r#"invalid params: method=runtime.invoke recv={"envelope":{"op":""}}"#,
            ),
        ];
        for (request, want) in cases {
            let out = dispatch_json(request);
            assert_eq!(out["error"]["code"], -32602, "请求: {request}");
            assert_eq!(out["error"]["message"], want, "请求: {request}");
        }
    }

    /// 任何输入都不许 panic。
    #[test]
    fn dispatch_never_panics_on_garbage() {
        let cases: [&[u8]; 8] = [
            b"",
            b"\x00\xff\xe4\xbd",
            b"{}",
            b"[]",
            b"null",
            b"{\"method\":\"runtime.invoke\",\"params\":null}",
            b"{\"method\":\"runtime.invoke\",\"params\":{\"envelope\":{\"op\":null}}}",
            b"{\"method\":\"runtime.invoke\",\"params\":{\"envelope\":{\"op\":\"job\",\"payload\":[[[[[[]]]]]]}}}",
        ];
        for request in cases {
            let mut runtime = Runtime::new();
            let raw = dispatch(&mut runtime, request);
            let parsed: Result<Value, _> = from_slice(&raw);
            assert!(parsed.is_ok(), "输入 {request:?} 的响应不是 JSON: {:?}", String::from_utf8_lossy(&raw));
        }
    }

    /// 响应信封形状: 成功必须只有 result, 失败必须只有 error。
    #[test]
    fn response_envelopes_are_exclusive() {
        let err = dispatch_json(r#"{"method":"runtime.invoke","params":{"envelope":{"op":"nope"}}}"#);
        assert!(err.get("result").is_none() && err.get("error").is_some());
        assert_eq!(err["error"].as_object().unwrap().len(), 2, "error 只含 code/message");
    }

    /// 逐字节形状检查: 错误响应与顶层字段名。
    #[test]
    fn error_bytes_match_layout() {
        let mut runtime = Runtime::new();
        let raw = dispatch(&mut runtime, br#"{"method":"runtime.invoke","params":{"envelope":{"op":"nope"}}}"#);
        assert_eq!(
            raw,
            br#"{"error":{"code":-32601,"message":"unsupported op: nope"}}"#.to_vec()
        );
    }
}
