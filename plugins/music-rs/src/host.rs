//! 薄封装: 生产代码在 `common::host`, 本模块只做 re-export。
//!
//! 插件级测试保留在这里(依赖插件的 testkit / 前缀断言 / 业务语义)。

pub use common::host::*;

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
        let bare =
            String::from_utf8(encode_request(&HostCallRequest::new("PUT", "/x")).unwrap()).unwrap();
        assert_eq!(
            bare,
            r#"{"method":"host.call","params":{"method":"PUT","path":"/x"}}"#
        );
    }

    #[test]
    fn native_stub_fails_like_go_abi_stub() {
        let _guard = HOST_COUNTER_LOCK.lock().unwrap();
        let before = observed_calls();
        let err = call(&HostCallRequest::new(
            "GET",
            "/api/plugin-runtime/storage/state",
        ))
        .unwrap_err();
        assert_eq!(err.to_string(), "host_call 返回长度 0");
        assert_eq!(
            observed_calls(),
            before + 1,
            "调用计数用于守住 initialize 不碰 host"
        );
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
        assert!(
            err.to_string().starts_with("host 响应解析失败: "),
            "实际: {err}"
        );
    }

    /// 请求体 base64 必须是不补 padding 的形态(宿主文档 + Go `RawStdEncoding`)。
    #[test]
    fn body_base64_is_raw_std() {
        assert_eq!(
            encode_body_base64(br#"{"tmdb_id":1}"#),
            "eyJ0bWRiX2lkIjoxfQ"
        );
        assert!(
            !encode_body_base64(&[0xff, 0xff, 0xff]).contains('='),
            "RawStd 不带 padding"
        );
        assert_eq!(encode_body_base64(b""), "");
    }
}
