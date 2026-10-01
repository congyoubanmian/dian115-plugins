//! 防御式 JSON 解析层: 信封解包 + 多候选字段名 + 类型宽松 + 脱敏。
//!
//! 追剧管家的三个外部结构里, 只有部分有强类型 schema:
//!
//! | 端点 | 契约 | 本模块的角色 |
//! |------|------|--------------|
//! | `GET /api/subscribe/pool/intents` | `PoolIntentListResult`(强类型) | 直读, 但字段缺失/类型不符时不 panic、不填默认值 |
//! | `GET /api/plugin-host/emby/episodes` | `GenericHostObject`(参数与字段全未知) | 多候选字段名 + 宽松取数 |
//! | `GET /api/subscribe/air-calendar` | `GenericHostObject`(同上) | 同上 |
//!
//! 三条纪律(贯穿所有解析函数):
//!
//! 1. **绝不默认零值继续**: 解析不出来就返回 `Err`, 调用方跳过该条并在 `state.debug`
//!    留下 ≤2048 字节原文片段。把"没解析出来"当成 0 会让对齐器凭噪声发 PATCH。
//! 2. **类型宽松**: 数字可以来自 JSON number, 也可以是纯数字字符串(宿主不同版本
//!    在 `map[string]any` 与结构体之间的差异)。
//! 3. **脱敏**: 写进状态文档前递归丢弃键名匹配凭据模式的子字段
//!    ([`is_forbidden_key`]), 保证 `state` 里永远不出现凭据键。

use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

/// 字段类型与宿主结构体不一致(Go 里 `json.Unmarshal` 会返回 error)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TypeMismatch;

/// Go 的 `json.RawMessage` 字段: 缺失 / null / 有值(三态必须区分)。
///
/// 三态在分发层有语义: 缺失 → `-32602`, `null` → 空结构体不报错, 有值 → 正常解。
#[derive(Debug, Clone, Copy)]
pub enum RawPayload<'a> {
    Missing,
    Null,
    Value(&'a Value),
}

impl<'a> RawPayload<'a> {
    /// 把 payload 当宿主结构体解:
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

/// 宿主结构体的 `string` 字段: 缺失/null → ""; 字符串 → 原值; 其他类型 → 报错。
pub fn string_field(obj: Option<&Map<String, Value>>, key: &str) -> Result<String, TypeMismatch> {
    match obj.and_then(|m| m.get(key)) {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(s)) => Ok(s.clone()),
        Some(_) => Err(TypeMismatch),
    }
}

/// 宿主结构体的 `bool` 字段: 缺失/null → false; 布尔 → 原值; 其他类型 → 报错。
pub fn bool_field(obj: Option<&Map<String, Value>>, key: &str) -> Result<bool, TypeMismatch> {
    match obj.and_then(|m| m.get(key)) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(TypeMismatch),
    }
}

/// serde 的 `Option` 会把 `null` 也解成 `None`, 但 `json.RawMessage` 区分
/// "字段缺失"与 `null`: 分发层的 `recv=` 回显与 `envelope` 三态都依赖这个区别。
fn keep_null<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Some(Value::deserialize(deserializer)?))
}

/// 宿主发来的 JSON-RPC 消息。只关心分发要用的字段, 其余忽略。
#[derive(Debug, Deserialize)]
pub struct RpcMessage {
    #[serde(default)]
    pub method: Option<String>,
    /// 缺失 → `None`; 显式 `null` → `Some(Value::Null)`; 有值 → `Some(值)`。
    #[serde(default, deserialize_with = "keep_null")]
    pub params: Option<Value>,
}

impl RpcMessage {
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

/// `runtime.invoke` 的参数(Go `wasm.go:20` `invokeParams`)。
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

    /// `background` 必须解析并对类型较真(它决定后台预算与前台预算)。
    pub fn background(&self) -> bool {
        self.background
    }
}

// ─────────────────────── 类型宽松的取数 ───────────────────────

/// 宽松取非负整数: JSON number(整数或整数值浮点)或纯数字字符串。
///
/// 负数一律不认(`None`): 下游的集数/季号/编号语义上都非负, 认下负数会把
/// "结构不认识"伪装成合法数据。
pub fn loose_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Number(number) => {
            if let Some(v) = number.as_u64() {
                return Some(v);
            }
            let f = number.as_f64()?;
            if f.is_finite() && f >= 0.0 && f.fract() == 0.0 && f <= u64::MAX as f64 {
                return Some(f as u64);
            }
            None
        }
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            trimmed.parse::<u64>().ok()
        }
        Value::Bool(b) => Some(u64::from(*b)),
        _ => None,
    }
}

/// 宽松取整数(允许负号, 用于 `emby_proxy_id` 这类可能为 -1 的配置)。
pub fn loose_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => {
            if let Some(v) = number.as_i64() {
                return Some(v);
            }
            let f = number.as_f64()?;
            if f.is_finite() && f.fract() == 0.0 && f >= i64::MIN as f64 && f <= i64::MAX as f64 {
                return Some(f as i64);
            }
            None
        }
        Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    }
}

/// 宽松取字符串: 字符串原样; 数字/布尔转成文本; null/对象/数组不认。
pub fn loose_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// 对象里第一个命中的候选键(按给定的优先级顺序)。
pub fn first_of<'a>(obj: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    for key in keys {
        if let Some(value) = obj.get(*key) {
            if !value.is_null() {
                return Some(value);
            }
        }
    }
    None
}

/// 对象里第一个能宽松解成 u64 的候选键。
pub fn first_u64(obj: &Map<String, Value>, keys: &[&str]) -> Option<u64> {
    first_of(obj, keys).and_then(loose_u64)
}

/// 对象里第一个能宽松解成 i64 的候选键。
pub fn first_i64(obj: &Map<String, Value>, keys: &[&str]) -> Option<i64> {
    first_of(obj, keys).and_then(loose_i64)
}

/// 对象里第一个能宽松解成字符串的候选键。
pub fn first_string(obj: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    first_of(obj, keys).and_then(loose_string)
}

/// 对象里第一个候选键为 `true` 的布尔(`is_default` 这类标记)。
pub fn first_bool(obj: &Map<String, Value>, keys: &[&str]) -> bool {
    keys.iter().any(|key| matches!(obj.get(*key), Some(Value::Bool(true))))
}

/// 下探一层: 若 `value` 是对象, 取第一个命中的候选键。
pub fn descend<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    value.as_object().and_then(|obj| first_of(obj, keys))
}

/// 取数组: `value` 本身是数组, 或对象里第一个命中的候选键是数组。
pub fn array_at<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Vec<Value>> {
    if let Value::Array(items) = value {
        return Some(items);
    }
    descend(value, keys).and_then(Value::as_array)
}

/// 一次外部结构解析失败的完整现场: HTTP 状态 + 原始响应 + 可读原因。
///
/// 这是"解析失败 ⇒ 该条零写入 + `state.debug` 留 ≤2048 字节原文"这条不变量的载体:
/// 失败现场一路带着原始字节走到 runtime, 由 runtime 决定脱敏截断后写进哪个快照。
#[derive(Debug, Clone, Default)]
pub struct ParseFailure {
    pub http_status: i32,
    pub raw: Vec<u8>,
    pub message: String,
    /// 这次失败一共花了几次 host.call(一次探测可能试过多个参数组合)。
    ///
    /// 调用方靠它把"实际发出的 host.call 数"记进预算 — 预算必须按真实调用数收敛,
    /// 而不是按"探测了几个条目"收敛。
    pub attempts: u8,
}

impl ParseFailure {
    /// 非 HTTP 失败(如 host.call 报错): 没有状态码也没有原文。
    pub fn transport(message: impl Into<String>) -> Self {
        ParseFailure {
            http_status: 0,
            raw: Vec::new(),
            message: message.into(),
            attempts: 1,
        }
    }

    /// HTTP 失败: 状态码 + 原文都留档。
    pub fn http(status: i32, raw: Vec<u8>, message: impl Into<String>) -> Self {
        ParseFailure {
            http_status: status,
            raw,
            message: message.into(),
            attempts: 1,
        }
    }

    /// 记下这次失败实际用掉的 host.call 次数。
    pub fn with_attempts(mut self, attempts: u8) -> Self {
        self.attempts = attempts;
        self
    }

    /// 诊断快照里的状态词: `http_error`(请求本身没成/非 200)或 `unparsed`(结构认不出)。
    ///
    /// 只有这两个取值 —— 与设计规格给 `debug.emby_episodes.status` 的枚举
    /// (`ok|unparsed|http_error`)严格一致; 传输层失败(状态码 0)也归入 `http_error`,
    /// 更细的原因在 `last_errors[].message` 里。
    pub fn kind(&self) -> &'static str {
        if self.http_status == 0 || self.http_status >= 400 {
            "http_error"
        } else {
            "unparsed"
        }
    }

    /// ≤2048 字节的脱敏样本。
    pub fn sample(&self) -> String {
        sample_text(&self.raw, crate::model::SAMPLE_MAX)
    }
}

impl std::fmt::Display for ParseFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// 解出宿主响应 JSON(非法 JSON → `Err(detail)`, 不 panic)。
pub fn decode_json(raw: &[u8]) -> Result<Value, String> {
    if raw.is_empty() {
        return Err("空响应体".to_string());
    }
    serde_json::from_slice(raw).map_err(|err| format!("JSON 解析失败: {err}"))
}

// ─────────────────────── 截断与脱敏 ───────────────────────

/// 按 UTF-8 边界截断到 `max` 字节(不 panic, 不产生半个字符)。
pub fn truncate_bytes(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut cut = max;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    &text[..cut]
}

/// 键名是否命中凭据模式(大小写不敏感, 子串匹配)。
///
/// 子串而非全匹配: 宿主可能返回 `api_key_configured` / `X-Api-Key` / `authorization_header`
/// 这类派生键名。宁可多删几个诊断字段, 也不能让凭据键落进状态文档。
pub fn is_forbidden_key(key: &str) -> bool {
    let lowered = key.to_ascii_lowercase();
    const PATTERNS: [&str; 8] = [
        "cookie",
        "token",
        "secret",
        "password",
        "authorization",
        "api_key",
        "api-key",
        "apikey",
    ];
    PATTERNS.iter().any(|pattern| lowered.contains(pattern))
}

/// 递归丢弃键名命中凭据模式的子字段(数组逐元素处理)。
pub fn sanitize(value: &mut Value) {
    match value {
        Value::Object(map) => {
            let forbidden: Vec<String> = map
                .keys()
                .filter(|key| is_forbidden_key(key))
                .cloned()
                .collect();
            for key in forbidden {
                map.remove(&key);
            }
            for child in map.values_mut() {
                sanitize(child);
            }
        }
        Value::Array(items) => {
            for item in items.iter_mut() {
                sanitize(item);
            }
        }
        _ => {}
    }
}

/// 把原始响应做成 ≤`max` 字节的诊断样本(先脱敏, 再按 UTF-8 边界截断)。
///
/// 能解成 JSON 就递归丢弃凭据键后重新序列化; 解不开(HTML 错误页/空体)就按原文
/// 按字节截断 —— 此时它是"一整块文本", 不含任何键名结构。
pub fn sample_text(raw: &[u8], max: usize) -> String {
    match decode_json(raw) {
        Ok(mut value) => {
            sanitize(&mut value);
            let text = serde_json::to_string(&value).unwrap_or_default();
            truncate_bytes(&text, max).to_string()
        }
        Err(_) => truncate_bytes(&String::from_utf8_lossy(raw), max).to_string(),
    }
}

/// 文档级兜底: 递归检查是否还有凭据键(写入前的最后一道闸门, 供断言与自证)。
pub fn contains_forbidden_key(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if is_forbidden_key(key) {
                    return Some(key.clone());
                }
                if let Some(found) = contains_forbidden_key(child) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(contains_forbidden_key),
        _ => None,
    }
}

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

        assert!(params(json!({"envelope": {"op": "job"}})).unwrap().payload.is_missing());
        assert!(matches!(
            params(json!({"envelope": {"op": "job", "payload": null}})).unwrap().payload,
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
        assert_eq!(first_string(obj, &["skip", "season"]), Some("3".to_string()));
    }

    #[test]
    fn array_at_accepts_bare_array_and_named_container() {
        let bare = json!([1, 2]);
        assert_eq!(array_at(&bare, &["items"]).map(Vec::len), Some(2));

        let wrapped = json!({"items": [1, 2, 3]});
        assert_eq!(array_at(&wrapped, &["items", "data"]).map(Vec::len), Some(3));

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
        let long = format!(r#"{{"items":[{}],"note":"{}"}}"#, "1,".repeat(2000), "剧".repeat(500));
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
        assert_eq!(contains_forbidden_key(&value).as_deref(), Some("oauth_token"));
        assert_eq!(contains_forbidden_key(&json!({"a": [1, 2, {"k": true}]})), None);
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
