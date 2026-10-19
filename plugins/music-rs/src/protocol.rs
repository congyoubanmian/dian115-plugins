//! 薄封装: JSON-RPC 分发骨架在 `common::protocol`。
//!
//! 这里只为本插件的 `Runtime` 实现 `ProtocolRuntime`; 插件级测试保留在本文件。

pub use common::protocol::*;

use crate::raw::RawPayload;
use crate::runtime::Runtime;
use serde_json::Value;

impl ProtocolRuntime for Runtime {
    const SUPPORTS_EVENT: bool = true;

    fn ensure_loaded(&mut self) {
        Runtime::ensure_loaded(self);
    }

    fn state(&mut self, payload: RawPayload<'_>) -> Result<Value, OpError> {
        Runtime::state(self, payload)
    }

    fn action(&mut self, invocation_id: &str, payload: RawPayload<'_>) -> Result<Value, OpError> {
        Runtime::action(self, invocation_id, payload)
    }

    fn job(&mut self, invocation_id: &str, payload: RawPayload<'_>) -> Result<Value, OpError> {
        Runtime::job(self, invocation_id, payload)
    }

    fn event(&mut self, payload: RawPayload<'_>) -> Result<Value, OpError> {
        Runtime::event(self, payload)
    }
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
            panic!(
                "响应必须是合法 JSON: {e}; 实际 {:?}",
                String::from_utf8_lossy(&raw)
            )
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
        assert_eq!(
            observed_host_calls(),
            before,
            "initialize 期间发生了 host.call"
        );
    }

    /// 未声明的 op → -32601; shutdown 顶层 stopping。
    #[test]
    fn unknown_op_and_shutdown() {
        let out = dispatch_json(
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"teleport","invocation_id":"inv_1"}}}"#,
        );
        assert_eq!(
            out,
            json!({"error": {"code": -32601, "message": "unsupported op: teleport"}})
        );

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
            (
                r#"{"method":null}"#,
                "invalid invoke: recv={\"method\":null}",
            ),
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
            assert!(
                parsed.is_ok(),
                "输入 {request:?} 的响应不是 JSON: {:?}",
                String::from_utf8_lossy(&raw)
            );
        }
    }

    /// 响应信封形状: 成功必须只有 result, 失败必须只有 error。
    #[test]
    fn response_envelopes_are_exclusive() {
        let err =
            dispatch_json(r#"{"method":"runtime.invoke","params":{"envelope":{"op":"nope"}}}"#);
        assert!(err.get("result").is_none() && err.get("error").is_some());
        assert_eq!(
            err["error"].as_object().unwrap().len(),
            2,
            "error 只含 code/message"
        );
    }

    /// 逐字节形状检查: 错误响应与顶层字段名。
    #[test]
    fn error_bytes_match_layout() {
        let mut runtime = Runtime::new();
        let raw = dispatch(
            &mut runtime,
            br#"{"method":"runtime.invoke","params":{"envelope":{"op":"nope"}}}"#,
        );
        assert_eq!(
            raw,
            br#"{"error":{"code":-32601,"message":"unsupported op: nope"}}"#.to_vec()
        );
    }
}
