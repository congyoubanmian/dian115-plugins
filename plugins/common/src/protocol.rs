//! JSON-RPC 分发骨架(协议层在三个插件间完全同形)。
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
//!
//! 业务实现由插件的 `Runtime` 通过 [`ProtocolRuntime`] 提供; `event` op 由
//! `SUPPORTS_EVENT` 控制 —— chase-rs 设为 `false`, 于是 `event` 继续落入
//! `unsupported op: event`(`-32601`), 与原实现一致。

use serde::Serialize;
use serde_json::Value;

use crate::host;
use crate::raw::{InvokeParams, RawPayload, RpcMessage};
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

/// 插件 `Runtime` 需要提供给分发层的操作。
///
/// `event` 有默认实现(`Err`): 没有 event 业务的插件可以不实现它, 并把
/// `SUPPORTS_EVENT` 设为 `false`, 让分发层直接返回 `-32601 unsupported op: event`。
pub trait ProtocolRuntime {
    fn ensure_loaded(&mut self);
    fn state(&mut self, payload: RawPayload<'_>) -> Result<Value, OpError>;
    fn action(&mut self, invocation_id: &str, payload: RawPayload<'_>) -> Result<Value, OpError>;
    fn job(&mut self, invocation_id: &str, payload: RawPayload<'_>) -> Result<Value, OpError>;

    /// 默认: 不支持的 event op(仅当 `SUPPORTS_EVENT = false` 时不会被调用)。
    fn event(&mut self, _payload: RawPayload<'_>) -> Result<Value, OpError> {
        Err(OpError::new("unsupported op: event"))
    }

    /// 为 `false` 时, 分发层把 `event` 当作未知 op 处理(`-32601`)。
    const SUPPORTS_EVENT: bool = true;
}

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
        error: ErrorBody {
            code,
            message: message.into(),
        },
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
        result: InitializeResult {
            ready: true,
            protocol: PROTOCOL,
        },
    })
}

/// 分发入口。
///
/// `request` 是宿主写在 arena 里的原始请求字节; 返回值是响应 JSON 字节,
/// 由 `abi` 层写回 arena 并换算成 `(地址<<32 | 长度)`。
pub fn dispatch<R: ProtocolRuntime>(runtime: &mut R, request: &[u8]) -> Vec<u8> {
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

fn dispatch_inner<R: ProtocolRuntime>(runtime: &mut R, request: &[u8]) -> Vec<u8> {
    // ① 外层消息: 非 JSON / 无 method → -32602 "invalid invoke: recv=<前200字节>"
    let message = match RpcMessage::parse(request) {
        Ok(message) => message,
        Err(_) => {
            return rpc_error(
                CODE_INVALID_PARAMS,
                format!("invalid invoke: recv={}", util::trunc(request)),
            )
        }
    };
    let method = message.method();

    // ② 初始化握手: 直接返回 ready, 期间禁止 host.call 重入。
    if method == "runtime.initialize" {
        return initialize_result();
    }

    // ②a 宿主卸载模块前会调用顶层 `runtime.shutdown`(wasm-runtime-v1.md §配额和生命周期)。
    //     它和 initialize 一样不能先加载存储, 否则关停阶段会多出 host.call。
    if method == "runtime.shutdown" {
        return stopping();
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
    // 官方示例要求 op 与 invocation_id 都非空; action/job 直接决定幂等与宿主
    // 投递账本, 缺失时无法安全重放, 必须拒绝。state/event 保持历史宽容度。
    let needs_invocation_id = matches!(input.op.as_str(), "action" | "job");
    if input.op.is_empty() || (needs_invocation_id && input.invocation_id.is_empty()) {
        let echoed = util::value_text(params);
        return rpc_error(CODE_INVALID_PARAMS, invalid_params_message(method, &echoed));
    }

    // ④ op 分发。
    let outcome = match input.op.as_str() {
        "state" => runtime.state(input.payload),
        "action" => runtime.action(&input.invocation_id, input.payload),
        "job" => runtime.job(&input.invocation_id, input.payload),
        "event" if R::SUPPORTS_EVENT => runtime.event(input.payload),
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
    format!(
        "invalid params: method={method} recv={}",
        util::trunc(echoed)
    )
}

/// 供测试与后续阶段检查"本进程有没有发生过 host.call"。
pub fn observed_host_calls() -> usize {
    host::observed_calls()
}
