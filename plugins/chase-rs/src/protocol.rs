//! 薄封装: JSON-RPC 分发骨架在 `common::protocol`。
//!
//! 这里只为本插件的 `Runtime` 实现 `ProtocolRuntime`; 插件级测试保留在本文件。

pub use common::protocol::*;

use crate::raw::RawPayload;
use crate::runtime::Runtime;
use serde_json::Value;

impl ProtocolRuntime for Runtime {
    const SUPPORTS_EVENT: bool = false;

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
        assert_eq!(
            crate::host::observed_calls(),
            before,
            "握手期间禁止 host.call"
        );
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
        assert!(String::from_utf8(response)
            .unwrap()
            .contains("dian115:wasm@1"));
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
            assert_eq!(
                response["error"]["code"], CODE_INVALID_PARAMS,
                "{request:?}"
            );
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
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("teleport"));
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
        let request =
            br#"{"method":"runtime.invoke","params":{"envelope":{"op":"state","payload":null}}}"#;
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
