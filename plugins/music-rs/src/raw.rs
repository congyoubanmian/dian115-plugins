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
        // 用 Box::leak 把测试用的 params 变成长生命周期, 便于断言借用关系
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
        // 未知字段忽略(与 Go 一致)
        assert!(
            RpcMessage::parse(br#"{"jsonrpc":"2.0","id":1,"method":"runtime.invoke"}"#).is_ok()
        );
    }

    #[test]
    fn rpc_message_distinguishes_missing_and_null_params() {
        let msg = RpcMessage::parse(br#"{"method":"runtime.invoke"}"#).unwrap();
        assert!(msg.params.is_none(), "缺失必须是 None");
        let msg = RpcMessage::parse(br#"{"method":"runtime.invoke","params":null}"#).unwrap();
        assert_eq!(
            msg.params,
            Some(Value::Null),
            "null 必须保留(None 与 null 文案不同)"
        );
    }

    #[test]
    fn invoke_params_reads_envelope() {
        let p = params(json!({
            "envelope": {"op": "state", "invocation_id": "inv_1", "payload": {"view": "main"}},
            "background": true
        }))
        .unwrap();
        assert_eq!(p.op, "state");
        assert_eq!(p.invocation_id, "inv_1");
        assert!(p.background());
        match p.payload {
            RawPayload::Value(v) => assert_eq!(v["view"], "main"),
            other => panic!("payload 应为有值: {other:?}"),
        }
    }

    #[test]
    fn invoke_params_payload_tristate() {
        let missing = params(json!({"envelope": {"op": "job"}})).unwrap();
        assert!(missing.payload.is_missing());
        let null = params(json!({"envelope": {"op": "job", "payload": null}})).unwrap();
        assert!(matches!(null.payload, RawPayload::Null));
        let value = params(json!({"envelope": {"op": "job", "payload": {"id": "x"}}})).unwrap();
        assert!(matches!(value.payload, RawPayload::Value(_)));
    }

    #[test]
    fn invoke_params_rejects_wrong_types_like_go() {
        // params 本身不是对象
        assert!(params(json!(null)).is_err());
        assert!(params(json!([1])).is_err());
        assert!(params(json!("x")).is_err());
        // envelope 不是对象
        assert!(params(json!({"envelope": "x"})).is_err());
        assert!(params(json!({"envelope": [1]})).is_err());
        // op / invocation_id 类型不符
        assert!(params(json!({"envelope": {"op": 1}})).is_err());
        assert!(params(json!({"envelope": {"op": "state", "invocation_id": 2}})).is_err());
        // background 类型不符
        assert!(params(json!({"envelope": {"op": "state"}, "background": "true"})).is_err());
    }

    #[test]
    fn invoke_params_treats_null_envelope_as_empty_op() {
        let p = params(json!({"envelope": null})).unwrap();
        assert_eq!(p.op, "", "Go 里 null 解成零值结构体 → Op 为空");
        let p = params(json!({"background": false})).unwrap();
        assert_eq!(p.op, "", "envelope 缺失同样是空 op");
    }

    #[test]
    fn raw_payload_object_semantics() {
        let value = json!({"a": 1});
        match RawPayload::Value(&value).as_object() {
            Ok(Some(map)) => assert_eq!(map.get("a"), Some(&json!(1))),
            other => panic!("应为对象: {other:?}"),
        }
        assert!(RawPayload::Missing.as_object().is_err());
        assert!(matches!(RawPayload::Null.as_object(), Ok(None)));
        let not_object = json!("x");
        assert!(RawPayload::Value(&not_object).as_object().is_err());
        let array = json!([1]);
        assert!(RawPayload::Value(&array).as_object().is_err());
    }

    #[test]
    fn struct_fields_go_semantics() {
        let empty = json!({});
        let map = empty.as_object().unwrap();
        assert_eq!(string_field(Some(map), "nope").unwrap(), "");
        assert!(!bool_field(Some(map), "nope").unwrap());
        assert_eq!(
            string_field(None, "any").unwrap(),
            "",
            "payload 为 null 时字段都是零值"
        );

        let nulls = json!({"s": null, "b": null});
        let map = nulls.as_object().unwrap();
        assert_eq!(string_field(Some(map), "s").unwrap(), "");
        assert!(!bool_field(Some(map), "b").unwrap());

        let wrong = json!({"s": 1, "b": "no"});
        let map = wrong.as_object().unwrap();
        assert!(string_field(Some(map), "s").is_err(), "Go 类型不符会报错");
        assert!(bool_field(Some(map), "b").is_err());
    }
}
