//! Go `encoding/json` 结构体解码语义的对齐层。
//!
//! Go 用结构体收 JSON: 字段缺失或为 `null` → 零值; 类型不符 → 返回 error。
//! 协议层必须逐条对齐, 否则会出现"该报错的静默放过"或"该放过的报错"。
//! (对照 `main.go:1469` handle / `main.go:1498` invoke / `wasm.go:74` wasmDispatch)

use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

/// 字段类型与 Go 结构体不一致(Go 里 `json.Unmarshal` 会返回 error)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TypeMismatch;

/// 对应 Go 的 `json.RawMessage` 字段: 缺失 / null / 有值。
///
/// 三态必须区分: Go 里 `json.Unmarshal(nil, &v)` 一定失败, 而 `"null"` 会解成零值不报错。
/// `job` 的两种提示语("任务参数无效" / "未声明的任务")正靠这个区分。
#[derive(Debug, Clone, Copy)]
pub enum RawPayload<'a> {
    Missing,
    Null,
    Value(&'a Value),
}

impl<'a> RawPayload<'a> {
    /// 把 payload 当 Go 结构体解:
    /// - 缺失 → Err(`json.Unmarshal(nil, ...)` 必失败)
    /// - null → Ok(None)(Go 解成零值结构体, 不报错)
    /// - 对象 → Ok(Some(map))
    /// - 其他类型(数组/字符串/数字/布尔) → Err
    pub fn as_object(self) -> Result<Option<&'a Map<String, Value>>, TypeMismatch> {
        match self {
            RawPayload::Missing => Err(TypeMismatch),
            RawPayload::Null => Ok(None),
            RawPayload::Value(Value::Object(map)) => Ok(Some(map)),
            RawPayload::Value(_) => Err(TypeMismatch),
        }
    }

    /// payload 是否缺失(与显式 `null` 区分)。
    pub fn is_missing(self) -> bool {
        matches!(self, RawPayload::Missing)
    }
}

/// Go 结构体的 `string` 字段: 缺失/null → ""; 字符串 → 原值; 其他类型 → 报错。
pub fn string_field(obj: Option<&Map<String, Value>>, key: &str) -> Result<String, TypeMismatch> {
    match obj.and_then(|m| m.get(key)) {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(s)) => Ok(s.clone()),
        Some(_) => Err(TypeMismatch),
    }
}

/// Go 结构体的 `bool` 字段: 缺失/null → false; 布尔 → 原值; 其他类型 → 报错。
pub fn bool_field(obj: Option<&Map<String, Value>>, key: &str) -> Result<bool, TypeMismatch> {
    match obj.and_then(|m| m.get(key)) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(TypeMismatch),
    }
}

/// serde 的 `Option` 会把 `null` 也解成 `None`, 但 Go 的 `json.RawMessage` 区分
/// "字段缺失"(nil)与 "null"(原文 4 字节): `recv=` 回显与 `envelope` 三态都依赖这个区别。
/// 这里让 null 落成 `Some(Value::Null)`, 配合 `#[serde(default)]` 才凑齐三态。
fn keep_null<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Some(Value::deserialize(deserializer)?))
}

/// 宿主发来的 JSON-RPC 消息。只关心分发要用的字段, 其余忽略(与 Go 一致)。
#[derive(Debug, Deserialize)]
pub struct RpcMessage {
    #[serde(default)]
    pub method: Option<String>,
    /// 缺失 → `None`; 显式 `null` → `Some(Value::Null)`; 有值 → `Some(值)`。
    /// (Go 里 `json.Unmarshal(nil, ...)` 必失败, 而 `"null"` 解成零值不报错。)
    #[serde(default, deserialize_with = "keep_null")]
    pub params: Option<Value>,
}

impl RpcMessage {
    /// 等价于 Go `wasm.go:85` 的 `json.Unmarshal(req, &msg) != nil || msg.Method == ""`:
    /// 非 JSON、非对象、method 缺失/null/类型不符、method 为空串 → Err。
    pub fn parse(request: &[u8]) -> Result<Self, TypeMismatch> {
        let msg: RpcMessage = serde_json::from_slice(request).map_err(|_| TypeMismatch)?;
        if msg.method().is_empty() {
            return Err(TypeMismatch);
        }
        Ok(msg)
    }

    pub fn method(&self) -> &str {
        self.method.as_deref().unwrap_or("")
    }
}

/// `runtime.invoke` 的参数 (Go `wasm.go:20` `invokeParams`)。
#[derive(Debug)]
pub struct InvokeParams<'a> {
    pub op: String,
    pub invocation_id: String,
    pub payload: RawPayload<'a>,
    pub background: bool,
}

impl<'a> InvokeParams<'a> {
    /// 等价于 Go `wasm.go:97`:
    /// `json.Unmarshal(msg.Params, &input) != nil || input.Envelope.Op == ""`。
    pub fn parse(params: &'a Value) -> Result<Self, TypeMismatch> {
        let map = match params {
            Value::Object(m) => m,
            // null 或非对象: Go 解成零值结构体后 Op 为空, 调用方按 -32602 处理
            _ => return Err(TypeMismatch),
        };
        let (op, invocation_id, payload) = match map.get("envelope") {
            None | Some(Value::Null) => (String::new(), String::new(), RawPayload::Missing),
            Some(Value::Object(env)) => (
                string_field(Some(env), "op")?,
                string_field(Some(env), "invocation_id")?,
                match env.get("payload") {
                    None => RawPayload::Missing,
                    Some(Value::Null) => RawPayload::Null,
                    Some(value) => RawPayload::Value(value),
                },
            ),
            // envelope 类型不符(字符串/数组/数字) → Go 的解包会报错
            Some(_) => return Err(TypeMismatch),
        };
        Ok(InvokeParams {
            op,
            invocation_id,
            payload,
            background: bool_field(Some(map), "background")?,
        })
    }

    /// `background` 本阶段不参与决策(Go 只在 runtime 内部读它), 但必须解析并对类型较真。
    pub fn background(&self) -> bool {
        self.background
    }
}

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
        assert!(RpcMessage::parse(br#"{"jsonrpc":"2.0","id":1,"method":"runtime.invoke"}"#).is_ok());
    }

    #[test]
    fn rpc_message_distinguishes_missing_and_null_params() {
        let msg = RpcMessage::parse(br#"{"method":"runtime.invoke"}"#).unwrap();
        assert!(msg.params.is_none(), "缺失必须是 None");
        let msg = RpcMessage::parse(br#"{"method":"runtime.invoke","params":null}"#).unwrap();
        assert_eq!(msg.params, Some(Value::Null), "null 必须保留(None 与 null 文案不同)");
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
        assert_eq!(bool_field(Some(map), "nope").unwrap(), false);
        assert_eq!(string_field(None, "any").unwrap(), "", "payload 为 null 时字段都是零值");

        let nulls = json!({"s": null, "b": null});
        let map = nulls.as_object().unwrap();
        assert_eq!(string_field(Some(map), "s").unwrap(), "");
        assert_eq!(bool_field(Some(map), "b").unwrap(), false);

        let wrong = json!({"s": 1, "b": "no"});
        let map = wrong.as_object().unwrap();
        assert!(string_field(Some(map), "s").is_err(), "Go 类型不符会报错");
        assert!(bool_field(Some(map), "b").is_err());
    }
}
