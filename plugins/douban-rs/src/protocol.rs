//! JSON-RPC 分发(对照 Go `wasm.go:74` `wasmDispatch` + `main.go:1469` handle / `main.go:1498` invoke)。
//!
//! 宿主发来的完整消息:
//! ```json
//! {"method":"runtime.invoke","params":{"envelope":{"op":"state","invocation_id":"inv_1","payload":{}},"background":false}}
//! ```
//! 响应形状(与 Go 逐字节一致):
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

/// 对应 Go `wasm.go:114` 的 `-32601`(未知 op)。
pub const CODE_METHOD_NOT_FOUND: i32 = -32601;
/// 对应 Go 的业务错误码 `-32602`。
pub const CODE_INVALID_PARAMS: i32 = -32602;
/// 对应 Go `wasm.go:77` panic 兜底的 `-32603`。
pub const CODE_INTERNAL: i32 = -32603;

/// 宿主 ABI 协议标识(`wasm.go:91` 硬编码)。
pub const PROTOCOL: &str = "dian115:wasm@1";

/// 业务错误: Go 里 invoke/handle 返回的 error 一律映射成 `-32602`(见 `wasm.go:117`)。
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

/// initialize 的结果体。字段顺序固定为 ready 在前 —— 与 ask/PoC 给出的字面形状一致
/// (Go 用 map 序列化会按字典序输出 protocol 在前, 内容等价, 宿主按 JSON 解析)。
#[derive(Serialize)]
struct InitializeResult<'a> {
    ready: bool,
    protocol: &'a str,
}

#[derive(Serialize)]
struct InitializeResponse<'a> {
    result: InitializeResult<'a>,
}

/// 组装 `{"error":{"code":...,"message":...}}`(Go `wasm.go:122` `rpcErr`)。
pub fn rpc_error(code: i32, message: impl Into<String>) -> Vec<u8> {
    util::encode_or_fallback(&ErrorResponse {
        error: ErrorBody { code, message: message.into() },
    })
}

/// 组装 `{"result": ...}`。
pub fn result_ok(value: Value) -> Vec<u8> {
    util::encode_or_fallback(&ResultResponse { result: value })
}

/// 组装 `{"stopping":true}`(Go `wasm.go:112`, 顶层字段不是 result)。
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

/// panic 兜底(Go `wasm.go:75` 的 `recover` → `-32603 PANIC: ...`)。
///
/// `panic = "abort"`(wasm release)下无法捕获, 只能由宿主看到 trap;
/// 本机 `cargo test`(unwind)下与 Go 行为一致 —— 见差异清单。
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
    //    Go 这里完全不看 params(不校验 protocol), 保持一致。
    if method == "runtime.initialize" {
        return initialize_result();
    }

    // ②b 首次业务调用才加载宿主存储(Go `wasm.go:95` 的 `ensureGuest()`)。
    //     位置与 Go 一致: initialize 之后、解析业务参数之前 —— 参数非法时 runtime
    //     也已经建好, 但握手期间绝不碰 host.call。
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

    // ④ op 分发。对应 Go `wasm.go:102` 的 switch。
    let outcome = match input.op.as_str() {
        "state" => runtime.state(input.payload),
        "action" => runtime.action(&input.invocation_id, input.payload),
        "job" => runtime.job(&input.invocation_id, input.payload),
        "event" => runtime.event(input.payload),
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

/// 与 Go `wasm.go:98` 的 `"invalid params: method=" + method + " recv=" + trunc(params)` 一致。
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

    /// 合法 invoke: state / action / job / event / shutdown 五个 op 的响应形状。
    ///
    /// 这里刻意用**未声明的** action/job id: 已声明的那些(`refresh`/`subscribe`/
    /// `refresh-charts`/`wish-sync` 等)已接线到骨架模块, 并行阶段那几个函数体是
    /// `todo!()`, 一调用就 panic —— 它们的落地行为由各自模块的测试覆盖。
    #[test]
    fn valid_invocations_return_result() {
        let state = dispatch_json(
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"state","invocation_id":"inv_1","payload":{}},"background":false}}"#,
        );
        assert_eq!(state["result"]["state_version"], "state-v0");
        assert_eq!(state["result"]["etag"], "\"state-v0\"");
        assert!(state["result"]["state"].is_object());

        let action = dispatch_json(
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"action","invocation_id":"inv_2","payload":{"id":"teleport","input":{}}}}}"#,
        );
        assert_eq!(
            action,
            json!({"result": {"status": "failed", "code": "unknown_action", "message": "未知动作"}})
        );

        let job = dispatch_json(
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"job","invocation_id":"inv_3","payload":{"id":"no-such-job"}}}}"#,
        );
        assert_eq!(job, json!({"result": {"status": "skipped", "message": "未声明的任务"}}));

        let event = dispatch_json(
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"event","payload":{"topic":"cron.tick","data":{}}}}}"#,
        );
        assert_eq!(event, json!({"result": {"accepted": true}}));

        // shutdown: 顶层 stopping, 不包 result
        let shutdown = dispatch_json(
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"shutdown","invocation_id":"inv_4"}}}"#,
        );
        assert_eq!(shutdown, json!({"stopping": true}));
        assert!(shutdown.get("result").is_none());
    }

    /// 接线自检: 已接线的动作在到达骨架函数之前的分支必须能跑通(不会掉进
    /// `unknown_action`)。这些前置分支都写在 `runtime.rs` 的接线层里, 与骨架函数体无关。
    #[test]
    fn wired_actions_reach_their_preconditions() {
        // subscribe / subscribe-now 的 douban_ref 前置校验(runtime.rs 接线层)
        for op_action in ["subscribe", "subscribe-now"] {
            let request = format!(
                r#"{{"method":"runtime.invoke","params":{{"envelope":{{"op":"action","payload":{{"id":"{op_action}","input":{{}}}}}}}}}}"#
            );
            let out = dispatch_json(&request);
            assert_eq!(
                out["result"],
                json!({"status": "failed", "message": "缺少 douban_ref"}),
                "action={op_action}"
            );
            // 类型不符的 douban_ref 在 Go 里同样断言失败 → 空串
            let request = format!(
                r#"{{"method":"runtime.invoke","params":{{"envelope":{{"op":"action","payload":{{"id":"{op_action}","input":{{"douban_ref":7}}}}}}}}}}"#
            );
            let out = dispatch_json(&request);
            assert_eq!(out["result"], json!({"status": "failed", "message": "缺少 douban_ref"}));
        }
    }

    /// Go `wasm.go:97` 只校验 op 非空, invocation_id 不校验(与 main.go 的 handle 不同)。
    /// payload 必须给: Go `stateResult` 对 nil payload 的 `json.Unmarshal` 会失败
    /// → `invalid state payload`(宿主真实消息总是带 payload)。
    #[test]
    fn invocation_id_is_not_required_in_wasm_path() {
        let out = dispatch_json(
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"state","payload":{}}}}"#,
        );
        assert!(out["result"].is_object());
    }

    /// state payload 的 if_none_match 命中 → 304 形态。
    #[test]
    fn state_not_modified() {
        let out = dispatch_json(
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"state","payload":{"view":"main","if_none_match":"\"state-v0\""}}}}"#,
        );
        assert_eq!(out, json!({"result": {"etag": "\"state-v0\"", "not_modified": true}}));
    }

    #[test]
    fn unknown_op_is_method_not_found() {
        let out = dispatch_json(
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"teleport","invocation_id":"inv_1"}}}"#,
        );
        assert_eq!(out, json!({"error": {"code": -32601, "message": "unsupported op: teleport"}}));
    }

    /// 非法消息: 逐条对齐 Go 的分支与文案。
    #[test]
    fn invalid_messages_use_invalid_params() {
        let cases: [(&str, &str); 9] = [
            // 非 JSON / 空请求
            ("", "invalid invoke: recv="),
            ("not json", "invalid invoke: recv=not json"),
            ("[1,2]", "invalid invoke: recv=[1,2]"),
            ("null", "invalid invoke: recv=null"),
            ("{}", "invalid invoke: recv={}"),
            (r#"{"method":null}"#, "invalid invoke: recv={\"method\":null}"),
            (r#"{"method":7}"#, "invalid invoke: recv={\"method\":7}"),
            (r#"{"method":""}"#, "invalid invoke: recv={\"method\":\"\"}"),
            (
                r#"{"method":"runtime.invoke"}"#,
                "invalid params: method=runtime.invoke recv=",
            ),
        ];
        for (request, want) in cases {
            let out = dispatch_json(request);
            assert_eq!(out["error"]["code"], -32602, "请求: {request}");
            assert_eq!(out["error"]["message"], want, "请求: {request}");
        }
    }

    /// params 存在但解不出 op(缺失/null/非对象/envelope 类型不符) → -32602 且回显 params。
    #[test]
    fn invalid_params_are_echoed() {
        let cases: [(&str, &str); 6] = [
            (
                r#"{"method":"runtime.invoke","params":null}"#,
                "invalid params: method=runtime.invoke recv=null",
            ),
            (
                r#"{"method":"runtime.invoke","params":[1]}"#,
                "invalid params: method=runtime.invoke recv=[1]",
            ),
            (
                r#"{"method":"runtime.invoke","params":{"background":false}}"#,
                r#"invalid params: method=runtime.invoke recv={"background":false}"#,
            ),
            (
                r#"{"method":"runtime.invoke","params":{"envelope":null}}"#,
                r#"invalid params: method=runtime.invoke recv={"envelope":null}"#,
            ),
            (
                r#"{"method":"runtime.invoke","params":{"envelope":{"invocation_id":"x"}}}"#,
                r#"invalid params: method=runtime.invoke recv={"envelope":{"invocation_id":"x"}}"#,
            ),
            (
                r#"{"method":"runtime.invoke","params":{"envelope":"x"}}"#,
                r#"invalid params: method=runtime.invoke recv={"envelope":"x"}"#,
            ),
        ];
        for (request, want) in cases {
            let out = dispatch_json(request);
            assert_eq!(out["error"]["code"], -32602, "请求: {request}");
            assert_eq!(out["error"]["message"], want, "请求: {request}");
        }
    }

    /// 非 runtime.* 的 method 也走同一条 invoke 路径(Go wasm.go 只有 initialize 特殊)。
    #[test]
    fn unknown_method_follows_invoke_path() {
        let out = dispatch_json(
            r#"{"method":"runtime.shutdown","params":{"envelope":{"op":"state","payload":{}}}}"#,
        );
        assert!(out["result"].is_object(), "method 只影响 initialize 分支");

        let out = dispatch_json(r#"{"method":"runtime.gc"}"#);
        assert_eq!(out["error"]["code"], -32602);
        assert_eq!(out["error"]["message"], "invalid params: method=runtime.gc recv=");
    }

    /// 业务错误一律 -32602, 文案来自 runtime。
    #[test]
    fn business_errors_are_invalid_params() {
        let cases: [(&str, &str); 4] = [
            (
                r#"{"method":"runtime.invoke","params":{"envelope":{"op":"state","payload":"x"}}}"#,
                "invalid state payload",
            ),
            (
                r#"{"method":"runtime.invoke","params":{"envelope":{"op":"action","payload":{}}}}"#,
                "invalid action payload",
            ),
            (
                r#"{"method":"runtime.invoke","params":{"envelope":{"op":"event","payload":{}}}}"#,
                "invalid event payload",
            ),
            (
                r#"{"method":"runtime.invoke","params":{"envelope":{"op":"event"}}}"#,
                "invalid event payload",
            ),
        ];
        for (request, want) in cases {
            let out = dispatch_json(request);
            assert_eq!(out["error"]["code"], -32602, "请求: {request}");
            assert_eq!(out["error"]["message"], want, "请求: {request}");
        }
    }

    /// 错误信息里的原文回显按 200 字节截断(Go `trunc`)。
    #[test]
    fn error_echo_is_truncated_at_200_bytes() {
        let mut request = String::from("{\"method\":\"");
        request.push_str(&"x".repeat(400));
        let out = dispatch_json(&request);
        let message = out["error"]["message"].as_str().unwrap();
        assert_eq!(message.len(), "invalid invoke: recv=".len() + 200);
        assert!(message.starts_with("invalid invoke: recv={\"method\":\""));
        assert!(message.ends_with('x'));
    }

    /// 任何输入都不许 panic(Go 用 recover 兜底, 我们用类型化解析)。
    #[test]
    fn dispatch_never_panics_on_garbage() {
        let cases: [&[u8]; 12] = [
            b"",
            b"\x00\xff\xe4\xbd",
            b"{}",
            b"[]",
            b"\"x\"",
            b"123",
            b"null",
            b"{\"method\":\"runtime.invoke\",\"params\":null}",
            b"{\"method\":\"runtime.invoke\",\"params\":{\"envelope\":{\"op\":null}}}",
            b"{\"method\":\"runtime.invoke\",\"params\":{\"envelope\":{\"op\":\"state\",\"payload\":{}},\"background\":1}}",
            b"{\"method\":\"runtime.initialize\",\"params\":[1,2,3]}",
            b"{\"method\":\"runtime.invoke\",\"params\":{\"envelope\":{\"op\":\"job\",\"payload\":[[[[[[]]]]]]}}}",
        ];
        for request in cases {
            let mut runtime = Runtime::new();
            let raw = dispatch(&mut runtime, request);
            let parsed: Result<Value, _> = from_slice(&raw);
            assert!(parsed.is_ok(), "输入 {request:?} 的响应不是 JSON: {:?}", String::from_utf8_lossy(&raw));
        }
    }

    /// background 只解析不影响本阶段行为, 但类型不符必须报错(与 Go 一致)。
    #[test]
    fn background_is_validated_not_used() {
        let ok = dispatch_json(
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"state","payload":{}},"background":true}}"#,
        );
        assert!(ok["result"].is_object());

        let bad = dispatch_json(
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"state"},"background":"true"}}"#,
        );
        assert_eq!(bad["error"]["code"], -32602);
        assert_eq!(
            bad["error"]["message"],
            r#"invalid params: method=runtime.invoke recv={"background":"true","envelope":{"op":"state"}}"#
        );
    }

    /// 响应信封形状: 成功必须只有 result, 失败必须只有 error。
    #[test]
    fn response_envelopes_are_exclusive() {
        let ok = dispatch_json(
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"state","payload":{}}}}"#,
        );
        assert!(ok.get("result").is_some() && ok.get("error").is_none());

        let err = dispatch_json(r#"{"method":"runtime.invoke","params":{"envelope":{"op":"nope"}}}"#);
        assert!(err.get("result").is_none() && err.get("error").is_some());
        assert_eq!(err["error"].as_object().unwrap().len(), 2, "error 只含 code/message");

        let stopping = dispatch_json(r#"{"method":"runtime.invoke","params":{"envelope":{"op":"shutdown"}}}"#);
        assert_eq!(stopping.as_object().unwrap().len(), 1);
    }

    /// 逐字节形状检查: 顶层字段名与顺序与 Go 的 map 序列化一致(map 键按字典序)。
    #[test]
    fn error_and_result_bytes_match_go_layout() {
        let mut runtime = Runtime::new();
        let raw = dispatch(&mut runtime, br#"{"method":"runtime.invoke","params":{"envelope":{"op":"nope"}}}"#);
        assert_eq!(
            raw,
            br#"{"error":{"code":-32601,"message":"unsupported op: nope"}}"#.to_vec()
        );
        let raw = dispatch(&mut runtime, br#"{"method":"runtime.invoke","params":{"envelope":{"op":"event","payload":{"topic":"t"}}}}"#);
        assert_eq!(raw, br#"{"result":{"accepted":true}}"#.to_vec());
    }

    /// 夹具自检: 脱敏后的 state 文档必须是合法 JSON 且不含任何凭据。
    #[test]
    fn fixtures_are_sanitized() {
        let state: Value = from_slice(crate::fixtures::STATE).expect("state_val.json 必须是合法 JSON");
        let movie: Value = from_slice(crate::fixtures::WISH_MOVIE).expect("wish_movie.json 必须是合法 JSON");
        let tv: Value = from_slice(crate::fixtures::WISH_TV).expect("wish_tv.json 必须是合法 JSON");

        assert_eq!(state["wish_info"]["uid"], "123456789", "uid 必须替换为 123456789");
        // 只嗅探"cookie 名/字段名"这类非机密标记; 绝不把真实凭据本身写进仓库。
        for (name, doc) in [("state_val", &state), ("wish_movie", &movie), ("wish_tv", &tv)] {
            for needle in ["dbcl2", "frodotk", "HMACCOUNT", "_pk_ref"] {
                assert!(
                    !serde_json::to_string(doc).unwrap().contains(needle),
                    "{name} 里残留了敏感片段 {needle}"
                );
            }
        }
        assert_eq!(movie["interests"].as_array().unwrap().len(), 3);
        assert_eq!(tv["interests"].as_array().unwrap().len(), 4);
        assert_eq!(state["cookie"], json!({}), "登录 cookie 必须整段丢弃");
        assert_eq!(state["settings"]["cookiecloud_key"], "key-test");
        assert_eq!(state["settings"]["cookiecloud_uuid"], "uuid-test");
    }
}
