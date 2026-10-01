//! JSON-RPC 分发(`initialize` / `state` / `action` / `job` / `shutdown`)。
//!
//! 对照 Go 插件运行时的 `wasm.go:74` `wasmDispatch`(也在
//! `plugins/music-dl/runtime/wasm.go:72` 与官方示例 `example/runtime/main.go:150`),
//! 按 dian115 Host 的真实线协议实现:
//!
//! ```json
//! 宿主 → {"method":"runtime.invoke","params":{"envelope":{"op":"state","invocation_id":"inv_1","payload":{}},"background":false}}
//! 插件 → {"result": ...} | {"error":{"code":N,"message":"..."}} | {"stopping":true}
//! ```
//!
//! - `runtime.initialize` → `{"result":{"ready":true,"protocol":"dian115:wasm@1"}}`,
//!   **期间不得发起 host.call**(宿主禁止重入, 因此这里连 `ensure_loaded` 都不调);
//! - `shutdown` → 顶层 `{"stopping":true}`(不包 `result`);
//! - 业务失败是**正常 result**(如 `{"status":"failed",...}`), 只有 payload 本身非法才
//!   走 `-32602`, 未知 op `-32601`, 编码兜底 `-32603`。
//!
//! 语义对齐层(结构体字段的 Go 三态语义)在 [`crate::raw`]; 业务判定/落地在
//! [`crate::runtime`]。

use serde::Serialize;
use serde_json::Value;

use crate::raw::InvokeParams;
use crate::runtime::Runtime;

/// 宿主 ABI 协议标识(`wasm.go:91` 硬编码)。
pub const PROTOCOL: &str = crate::PROTOCOL;

/// 未知 op(`wasm.go:114`)。
pub const CODE_METHOD_NOT_FOUND: i32 = -32601;
/// 业务错误码(`wasm.go:117`)。
pub const CODE_INVALID_PARAMS: i32 = -32602;
/// panic / 编码兜底(`wasm.go:77`)。
pub const CODE_INTERNAL: i32 = -32603;

/// 编码失败时的兜底响应(Go `wasm.go:128` `mustJSON`)。
const ENCODE_FAILED: &[u8] = br#"{"error":{"code":-32603,"message":"encode failed"}}"#;

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

/// initialize 的结果体。字段顺序固定 ready 在前(与宿主文档给的形状一致)。
#[derive(Serialize)]
struct InitializeResult<'a> {
    ready: bool,
    protocol: &'a str,
}

#[derive(Serialize)]
struct InitializeResponse<'a> {
    result: InitializeResult<'a>,
}

/// 序列化失败(正常不可能)时回退到固定错误响应。
fn encode_or_fallback<T: Serialize>(value: &T) -> Vec<u8> {
    serde_json::to_vec(value).unwrap_or_else(|_| ENCODE_FAILED.to_vec())
}

/// 组装 `{"error":{"code":...,"message":...}}`。
pub fn rpc_error(code: i32, message: impl Into<String>) -> Vec<u8> {
    encode_or_fallback(&ErrorResponse {
        error: ErrorBody { code, message: message.into() },
    })
}

/// 组装 `{"result": ...}`。
pub fn result_ok(value: Value) -> Vec<u8> {
    encode_or_fallback(&ResultResponse { result: value })
}

/// 组装 `{"stopping":true}`(顶层字段不是 result)。
pub fn stopping() -> Vec<u8> {
    encode_or_fallback(&StoppingResponse { stopping: true })
}

/// 组装 initialize 握手响应 —— 期间**不允许**任何 host.call(宿主限制)。
///
/// 走结构体而不是 `json!`/`to_value`: 后者底层是 BTreeMap, 会把键按字典序重排。
pub fn initialize_result() -> Vec<u8> {
    encode_or_fallback(&InitializeResponse {
        result: InitializeResult { ready: true, protocol: PROTOCOL },
    })
}

/// 错误信息里的原文回显按 200 字节截断(Go `wasm.go:244` 的 `trunc`)。
fn trunc(bytes: &[u8]) -> String {
    const LIMIT: usize = 200;
    let n = bytes.len().min(LIMIT);
    String::from_utf8_lossy(&bytes[..n]).into_owned()
}

/// 与 Go `wasm.go:98` 的 `"invalid params: method=" + method + " recv=" + trunc(params)` 一致。
fn invalid_params_message(method: &str, echoed: &[u8]) -> String {
    format!("invalid params: method={method} recv={}", trunc(echoed))
}

/// 分发入口。
///
/// `request` 是宿主写在 arena 里的原始请求字节; 返回值是响应 JSON 字节,
/// 由 [`crate::abi`] 写回 arena 并换算成 `(地址<<32 | 长度)`。
pub fn dispatch(runtime: &mut Runtime, request: &[u8]) -> Vec<u8> {
    // ① 外层消息: 非 JSON / 非对象 / method 缺失或为空 → -32602 "invalid invoke: recv=<前200字节>"
    let message: Value = match serde_json::from_slice(request) {
        Ok(value) => value,
        Err(_) => {
            return rpc_error(
                CODE_INVALID_PARAMS,
                format!("invalid invoke: recv={}", trunc(request)),
            )
        }
    };
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    if method.is_empty() {
        return rpc_error(CODE_INVALID_PARAMS, format!("invalid invoke: recv={}", trunc(request)));
    }

    // ② 初始化握手: 直接返回 ready, 期间禁止 host.call 重入。
    //    Go 这里完全不看 params(不校验 protocol), 保持一致。
    if method == "runtime.initialize" {
        return initialize_result();
    }

    // ②b 首次业务调用才加载宿主存储(Go `wasm.go:95` 的 `ensureGuest()`)。
    runtime.ensure_loaded();

    // ③ 业务参数: 缺失 → 空 recv; 解析失败或 op 为空 → -32602
    let params = match message.get("params") {
        Some(params) => params,
        None => return rpc_error(CODE_INVALID_PARAMS, invalid_params_message(method, b"")),
    };
    let input = match InvokeParams::parse(params) {
        Ok(input) => input,
        Err(_) => {
            let echoed = value_text(params);
            return rpc_error(CODE_INVALID_PARAMS, invalid_params_message(method, &echoed));
        }
    };
    let _background = input.background();
    if input.op.is_empty() {
        let echoed = value_text(params);
        return rpc_error(CODE_INVALID_PARAMS, invalid_params_message(method, &echoed));
    }

    // ④ op 分发。对应 Go `wasm.go:102` 的 switch。
    let outcome = match input.op.as_str() {
        "state" => runtime.state(input.payload),
        "action" => runtime.action(&input.invocation_id, input.payload),
        "job" => runtime.job(&input.invocation_id, input.payload),
        // Go 在分发层直接返回 {"stopping":true}, 不进 runtime(因此也不落盘)
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

/// JSON 值的紧凑文本(错误信息里回显参数用)。
fn value_text(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::FakeHost;
    use serde_json::json;

    fn body(value: &Value) -> String {
        String::from_utf8_lossy(&serde_json::to_vec(value).unwrap()).into_owned()
    }

    fn invoke(runtime: &mut Runtime, op: &str, payload: Value) -> Value {
        let request = body(&json!({
            "method": "runtime.invoke",
            "params": {"envelope": {"op": op, "invocation_id": "inv_1", "payload": payload}}
        }));
        let response = dispatch(runtime, request.as_bytes());
        serde_json::from_slice(&response).unwrap()
    }

    #[test]
    fn initialize_never_touches_the_host() {
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, b"{}");
        let guard = fake.install();
        let mut runtime = Runtime::new();
        let before = crate::host::observed_calls();
        let response = dispatch(&mut runtime, br#"{"method":"runtime.initialize"}"#);
        assert_eq!(
            String::from_utf8(response).unwrap(),
            r#"{"result":{"ready":true,"protocol":"dian115:wasm@1"}}"#
        );
        assert_eq!(crate::host::observed_calls(), before, "握手期间禁止 host.call");
        assert!(fake.requests().is_empty());
        drop(guard);
    }

    #[test]
    fn initialize_ignores_params_like_go() {
        let mut runtime = Runtime::new();
        let response = dispatch(
            &mut runtime,
            br#"{"method":"runtime.initialize","params":{"protocol":"nope"}}"#,
        );
        assert!(String::from_utf8(response).unwrap().contains("dian115:wasm@1"));
    }

    #[test]
    fn malformed_requests_are_invalid_params() {
        let fake = FakeHost::new();
        let guard = fake.install();
        let mut runtime = Runtime::new();
        for request in [
            b"not json".as_slice(),
            br#"{"method":""}"#,
            br#"{}"#,
            br#"{"method":7}"#,
            br#"{"method":"runtime.invoke"}"#,
            br#"{"method":"runtime.invoke","params":null}"#,
            br#"{"method":"runtime.invoke","params":{"envelope":"x"}}"#,
            br#"{"method":"runtime.invoke","params":{"envelope":{"op":""}}}"#,
        ] {
            let response: Value = serde_json::from_slice(&dispatch(&mut runtime, request)).unwrap();
            assert_eq!(response["error"]["code"], CODE_INVALID_PARAMS, "{request:?}");
            assert!(
                response["error"]["message"]
                    .as_str()
                    .unwrap_or_default()
                    .starts_with("invalid"),
                "{response}"
            );
        }
        drop(guard);
    }

    #[test]
    fn error_echo_is_truncated_to_200_bytes() {
        let mut runtime = Runtime::new();
        let long = vec![b'x'; 500];
        let mut request = b"{\"method\":".to_vec();
        request.extend_from_slice(&long);
        let response: Value = serde_json::from_slice(&dispatch(&mut runtime, &request)).unwrap();
        let message = response["error"]["message"].as_str().unwrap_or_default();
        assert_eq!(message.len(), "invalid invoke: recv=".len() + 200);
    }

    #[test]
    fn unknown_op_is_method_not_found() {
        let fake = FakeHost::new();
        let guard = fake.install();
        let mut runtime = Runtime::new();
        let response = invoke(&mut runtime, "teleport", json!({}));
        assert_eq!(response["error"]["code"], CODE_METHOD_NOT_FOUND);
        assert!(response["error"]["message"].as_str().unwrap().contains("teleport"));
        drop(guard);
    }

    #[test]
    fn shutdown_returns_stopping_without_touching_storage() {
        let fake = FakeHost::new();
        let guard = fake.install();
        let mut runtime = Runtime::new();
        let response = dispatch(
            &mut runtime,
            br#"{"method":"runtime.invoke","params":{"envelope":{"op":"shutdown"}}}"#,
        );
        assert_eq!(String::from_utf8(response).unwrap(), r#"{"stopping":true}"#);
        assert!(fake.puts().is_empty(), "shutdown 不落盘");
        drop(guard);
    }

    #[test]
    fn opaque_payloads_map_to_invalid_params() {
        let fake = FakeHost::new();
        let guard = fake.install();
        let mut runtime = Runtime::new();
        // payload 不是对象 → runtime 的 payload 解析失败 → -32602
        let response = invoke(&mut runtime, "state", json!("nope"));
        assert_eq!(response["error"]["code"], CODE_INVALID_PARAMS);
        // action 缺 id 也一样
        let response = invoke(&mut runtime, "action", json!({"input": {}}));
        assert_eq!(response["error"]["code"], CODE_INVALID_PARAMS);
        // job 相反: 参数无效是正常结果(Go 的"任务参数无效")
        let response = invoke(&mut runtime, "job", json!("nope"));
        assert_eq!(response["result"]["status"], "skipped");
        drop(guard);
    }

    #[test]
    fn null_payload_is_tolerated_where_go_tolerates_it() {
        let fake = FakeHost::new();
        let guard = fake.install();
        let mut runtime = Runtime::new();
        // payload: null → Go 解成零值结构体; state 的零值 view 合法 → 正常 result
        let request = br#"{"method":"runtime.invoke","params":{"envelope":{"op":"state","payload":null}}}"#;
        let response: Value = serde_json::from_slice(&dispatch(&mut runtime, request)).unwrap();
        assert!(response["result"]["state"].is_object(), "{response}");
        drop(guard);
    }

    #[test]
    fn responses_are_compact_and_stable() {
        let fake = FakeHost::new();
        let guard = fake.install();
        assert_eq!(result_ok(json!(1)), br#"{"result":1}"#.to_vec());
        assert_eq!(
            rpc_error(CODE_INTERNAL, "x"),
            br#"{"error":{"code":-32603,"message":"x"}}"#.to_vec()
        );
        assert_eq!(stopping(), br#"{"stopping":true}"#.to_vec());
        drop(guard);
    }
}
