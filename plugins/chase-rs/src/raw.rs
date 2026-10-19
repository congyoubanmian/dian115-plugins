//! 薄封装: 生产代码在 `common::raw`, 本模块只做 re-export。
//!
//! 插件级测试保留在这里(依赖插件的 testkit / 前缀断言 / 业务语义)。

pub use common::raw::*;

#[cfg(test)]
use serde_json::Value;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn params(value: Value) -> Result<InvokeParams<'static>, TypeMismatch> {
        let leaked: &'static Value = Box::leak(Box::new(value));
        InvokeParams::parse(leaked)
    }

    #[test]
    fn rpc_message_requires_non_empty_method() {
        assert!(RpcMessage::parse(br#"{"method":"runtime.initialize"}"#).is_ok());
        assert!(RpcMessage::parse(br#"{}"#).is_err());
        assert!(RpcMessage::parse(br#"{"method":null}"#).is_err());
        assert!(RpcMessage::parse(br#"{"method":""}"#).is_err());
        assert!(RpcMessage::parse(br#"{"method":7}"#).is_err());
        assert!(RpcMessage::parse(br#"not json"#).is_err());
        assert!(RpcMessage::parse(br#"[1,2]"#).is_err());
        assert!(RpcMessage::parse(br#"null"#).is_err());
    }

    #[test]
    fn rpc_message_distinguishes_missing_and_null_params() {
        let msg = RpcMessage::parse(br#"{"method":"runtime.invoke"}"#).unwrap();
        assert!(msg.params.is_none(), "缺失必须是 None");
        let msg = RpcMessage::parse(br#"{"method":"runtime.invoke","params":null}"#).unwrap();
        assert_eq!(msg.params, Some(Value::Null), "null 必须保留");
    }

    #[test]
    fn invoke_params_reads_envelope_and_tristate_payload() {
        let p = params(json!({
            "envelope": {"op": "state", "invocation_id": "inv_1", "payload": {"view": "main"}},
            "background": true
        }))
        .unwrap();
        assert_eq!(p.op, "state");
        assert_eq!(p.invocation_id, "inv_1");
        assert!(p.background());
        assert!(matches!(p.payload, RawPayload::Value(_)));

        assert!(params(json!({"envelope": {"op": "job"}}))
            .unwrap()
            .payload
            .is_missing());
        assert!(matches!(
            params(json!({"envelope": {"op": "job", "payload": null}}))
                .unwrap()
                .payload,
            RawPayload::Null
        ));
    }

    #[test]
    fn invoke_params_rejects_wrong_types_like_go() {
        assert!(params(json!(null)).is_err());
        assert!(params(json!([1])).is_err());
        assert!(params(json!({"envelope": "x"})).is_err());
        assert!(params(json!({"envelope": {"op": 1}})).is_err());
        assert!(params(json!({"envelope": {"op": "state", "invocation_id": 2}})).is_err());
        assert!(params(json!({"envelope": {"op": "state"}, "background": "true"})).is_err());
    }

    #[test]
    fn loose_numbers_accept_numbers_and_numeric_strings() {
        assert_eq!(loose_u64(&json!(12)), Some(12));
        assert_eq!(loose_u64(&json!("12")), Some(12));
        assert_eq!(loose_u64(&json!(" 12 ")), Some(12));
        assert_eq!(loose_u64(&json!(12.0)), Some(12));
        assert_eq!(loose_u64(&json!(-3)), None, "非负数语义: 负数不认");
        assert_eq!(loose_u64(&json!("-3")), None);
        assert_eq!(loose_u64(&json!("abc")), None);
        assert_eq!(loose_u64(&json!(12.5)), None);
        assert_eq!(loose_u64(&json!(null)), None);
        assert_eq!(loose_u64(&json!({})), None);

        assert_eq!(loose_i64(&json!(-1)), Some(-1));
        assert_eq!(loose_i64(&json!("-1")), Some(-1));
        assert_eq!(loose_i64(&json!(true)), None, "布尔不当数字");
    }

    #[test]
    fn loose_string_accepts_scalars_only() {
        assert_eq!(loose_string(&json!("x")), Some("x".to_string()));
        assert_eq!(loose_string(&json!(7)), Some("7".to_string()));
        assert_eq!(loose_string(&json!(true)), Some("true".to_string()));
        assert_eq!(loose_string(&json!(null)), None);
        assert_eq!(loose_string(&json!([1])), None);
    }

    #[test]
    fn candidate_lookup_prefers_first_present_key() {
        let value = json!({"season_number": 2, "season": "3", "skip": null});
        let obj = value.as_object().unwrap();
        assert_eq!(first_u64(obj, &["season", "season_number"]), Some(3));
        assert_eq!(first_u64(obj, &["season_number", "season"]), Some(2));
        assert_eq!(first_u64(obj, &["missing"]), None);
        // null 不当作命中, 继续看下一个候选
        assert_eq!(
            first_string(obj, &["skip", "season"]),
            Some("3".to_string())
        );
    }

    #[test]
    fn array_at_accepts_bare_array_and_named_container() {
        let bare = json!([1, 2]);
        assert_eq!(array_at(&bare, &["items"]).map(Vec::len), Some(2));

        let wrapped = json!({"items": [1, 2, 3]});
        assert_eq!(
            array_at(&wrapped, &["items", "data"]).map(Vec::len),
            Some(3)
        );

        let none = json!({"other": 1});
        assert!(array_at(&none, &["items"]).is_none());
        assert!(array_at(&json!("x"), &["items"]).is_none());
    }

    #[test]
    fn truncate_respects_utf8_boundaries() {
        assert_eq!(truncate_bytes("abc", 10), "abc");
        assert_eq!(truncate_bytes("abc", 2), "ab");
        // "剧" 占 3 字节: 上限 4 时只能回退到边界 3
        let text = "追剧管家";
        let cut = truncate_bytes(text, 4);
        assert_eq!(cut, "追");
        assert!(cut.len() <= 4);
    }

    #[test]
    fn forbidden_keys_cover_host_derived_names() {
        for key in [
            "cookie",
            "Cookie",
            "X-Token",
            "my_secret",
            "password",
            "Authorization",
            "api_key",
            "API-KEY",
            "apikey",
            "api_key_configured",
        ] {
            assert!(is_forbidden_key(key), "{key} 必须判为凭据键");
        }
        for key in ["key_ready", "key", "monkey", "episodes", "sample", "shape"] {
            assert!(!is_forbidden_key(key), "{key} 不该被判为凭据键");
        }
    }

    #[test]
    fn sanitize_drops_credential_fields_recursively() {
        let mut value = json!({
            "id": 1,
            "api_key_configured": true,
            "nested": {"authorization": "Bearer x", "keep": 2},
            "items": [{"token": "t", "name": "n"}]
        });
        sanitize(&mut value);
        assert_eq!(value["id"], 1);
        assert!(value.get("api_key_configured").is_none());
        assert!(value["nested"].get("authorization").is_none());
        assert_eq!(value["nested"]["keep"], 2);
        assert!(value["items"][0].get("token").is_none());
        assert_eq!(value["items"][0]["name"], "n");
        assert_eq!(contains_forbidden_key(&value), None);
    }

    #[test]
    fn sample_text_is_sanitized_and_bounded() {
        let raw = br#"{"api_key":"abc","missing":[3,4],"note":"hello"}"#;
        let sample = sample_text(raw, 2048);
        assert!(!sample.contains("api_key"), "{sample}");
        assert!(sample.contains("missing"));

        // 非 JSON: 按字节截断, 不 panic
        let html = vec![b'x'; 5000];
        assert_eq!(sample_text(&html, 2048).len(), 2048);
        // 多字节边界: 截断不产生半个字符
        let long = format!("{{\"title\":\"{}\"}}", "剧".repeat(2000));
        let sample = sample_text(long.as_bytes(), 2048);
        assert!(sample.len() <= 2048);
        assert!(std::str::from_utf8(sample.as_bytes()).is_ok());
    }

    // ── 补: 2KB 上限 / 脱敏递归 / 截断边界 ──

    #[test]
    fn sample_text_bounds_large_payloads_and_keeps_utf8() {
        // 远大于 2KB 的 JSON: 截断后 ≤2048 且仍是合法 UTF-8(可能残缺 —— 它只是诊断文本)
        let long = format!(
            r#"{{"items":[{}],"note":"{}"}}"#,
            "1,".repeat(2000),
            "剧".repeat(500)
        );
        assert!(long.len() > 4096);
        let sample = sample_text(long.as_bytes(), 2048);
        assert!(sample.len() <= 2048, "实际 {} 字节", sample.len());
        assert!(std::str::from_utf8(sample.as_bytes()).is_ok());
        // 空输入不 panic
        assert_eq!(sample_text(b"", 2048), "");
        // 极限: 上限 0 返回空串
        assert_eq!(sample_text(br#"{"a":1}"#, 0), "");
    }

    #[test]
    fn contains_forbidden_key_walks_arrays_and_nested_objects() {
        let value = json!({"a": [{"b": {"oauth_token": "x"}}], "ok": 1});
        assert_eq!(
            contains_forbidden_key(&value).as_deref(),
            Some("oauth_token")
        );
        assert_eq!(
            contains_forbidden_key(&json!({"a": [1, 2, {"k": true}]})),
            None
        );
        assert_eq!(contains_forbidden_key(&json!([])), None);
        assert_eq!(contains_forbidden_key(&json!("plain")), None);
    }

    #[test]
    fn truncate_bytes_handles_exact_and_zero_limits() {
        assert_eq!(truncate_bytes("", 0), "");
        assert_eq!(truncate_bytes("剧", 0), "");
        assert_eq!(truncate_bytes("剧", 1), "", "1 字节放不下一个 3 字节字符");
        assert_eq!(truncate_bytes("剧", 2), "");
        assert_eq!(truncate_bytes("剧", 3), "剧");
        assert_eq!(truncate_bytes("剧", 4), "剧");
        assert_eq!(truncate_bytes("追剧", 4), "追");
    }
}
