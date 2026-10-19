//! Go `encoding/json` 结构体解码语义的对齐层, 以及 chase-rs 的防御式扩展。
//!
//! Go 用结构体收 JSON: 字段缺失或为 `null` → 零值; 类型不符 → 返回 error。
//! 协议层必须逐条对齐, 否则会出现"该报错的静默放过"或"该放过的报错"。
//!
//! `ext` feature 下追加 chase-rs 的宽松取数(数字/数字串都收)、候选字段名、
//! JSON 脱敏与 ≤2048 字节诊断样本。这些函数只在 chase-rs 的依赖图里编译。

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
        // serde 的 derive 允许结构体按字段声明顺序从数组反序列化, serde_json 的
        // `deserialize_struct` 也确实接受 `[`; 于是 ["runtime.initialize"] 会被
        // 静默解成 method = "runtime.initialize"。Go 的 json.Unmarshal 对数组帧
        // 直接报错, 这里先看首个非空白字节, 保持同样的拒绝行为。
        if !starts_with_object(request) {
            return Err(TypeMismatch);
        }
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

/// 首个非空白字节是 `{` 才可能是 RPC 对象帧(serde derive 本身也接受数组)。
fn starts_with_object(request: &[u8]) -> bool {
    request
        .iter()
        .find(|byte| !byte.is_ascii_whitespace())
        .is_some_and(|byte| *byte == b'{')
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

// ─────────────────────── 类型宽松的取数(chase-rs, ext) ───────────────────────

/// 诊断样本的字节上限(chase-rs 的 `state.debug.*.sample`)。
#[cfg(feature = "ext")]
pub const SAMPLE_MAX: usize = 2048;

/// 宽松取非负整数: JSON number(整数或整数值浮点)或纯数字字符串。
///
/// 负数一律不认(`None`): 下游的集数/季号/编号语义上都非负, 认下负数会把
/// "结构不认识"伪装成合法数据。
#[cfg(feature = "ext")]
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
#[cfg(feature = "ext")]
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
#[cfg(feature = "ext")]
pub fn loose_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// 对象里第一个命中的候选键(按给定的优先级顺序)。
#[cfg(feature = "ext")]
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
#[cfg(feature = "ext")]
pub fn first_u64(obj: &Map<String, Value>, keys: &[&str]) -> Option<u64> {
    first_of(obj, keys).and_then(loose_u64)
}

/// 对象里第一个能宽松解成 i64 的候选键。
#[cfg(feature = "ext")]
pub fn first_i64(obj: &Map<String, Value>, keys: &[&str]) -> Option<i64> {
    first_of(obj, keys).and_then(loose_i64)
}

/// 对象里第一个能宽松解成字符串的候选键。
#[cfg(feature = "ext")]
pub fn first_string(obj: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    first_of(obj, keys).and_then(loose_string)
}

/// 对象里第一个候选键为 `true` 的布尔(`is_default` 这类标记)。
#[cfg(feature = "ext")]
pub fn first_bool(obj: &Map<String, Value>, keys: &[&str]) -> bool {
    keys.iter()
        .any(|key| matches!(obj.get(*key), Some(Value::Bool(true))))
}

/// 下探一层: 若 `value` 是对象, 取第一个命中的候选键。
#[cfg(feature = "ext")]
pub fn descend<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    value.as_object().and_then(|obj| first_of(obj, keys))
}

/// 取数组: `value` 本身是数组, 或对象里第一个命中的候选键是数组。
#[cfg(feature = "ext")]
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
#[cfg(feature = "ext")]
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

#[cfg(feature = "ext")]
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
        sample_text(&self.raw, SAMPLE_MAX)
    }
}

#[cfg(feature = "ext")]
impl std::fmt::Display for ParseFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// 解出宿主响应 JSON(非法 JSON → `Err(detail)`, 不 panic)。
#[cfg(feature = "ext")]
pub fn decode_json(raw: &[u8]) -> Result<Value, String> {
    if raw.is_empty() {
        return Err("空响应体".to_string());
    }
    serde_json::from_slice(raw).map_err(|err| format!("JSON 解析失败: {err}"))
}

/// 按 UTF-8 边界截断到 `max` 字节(不 panic, 不产生半个字符)。
#[cfg(feature = "ext")]
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
#[cfg(feature = "ext")]
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
#[cfg(feature = "ext")]
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
#[cfg(feature = "ext")]
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
#[cfg(feature = "ext")]
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
