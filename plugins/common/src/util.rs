//! 与 Go 文本语义对齐的小工具(错误信息截断、非法 UTF-8 替换、编码兜底)。

use serde::Serialize;

/// Go `wasm.go:244` 的 `trunc`: 超过 200 字节按字节截断
/// (可能切断 UTF-8, 之后按 Go `encoding/json` 的替换策略还原成合法字符串)。
pub const TRUNC_LIMIT: usize = 200;

/// 编码失败时的兜底响应, 与 Go `wasm.go:128` `mustJSON` 的 fallback 逐字节一致。
pub const ENCODE_FAILED: &[u8] = br#"{"error":{"code":-32603,"message":"encode failed"}}"#;

/// 对应 Go `trunc([]byte) string`。
pub fn trunc(bytes: &[u8]) -> String {
    let n = bytes.len().min(TRUNC_LIMIT);
    go_lossy(&bytes[..n])
}

/// 复刻 Go `encoding/json` 对非法 UTF-8 的替换方式: 每个无法解码的字节各产出一个 U+FFFD。
///
/// Rust 的 `String::from_utf8_lossy` 会把"被截断的多字节序列"合成一个 U+FFFD,
/// 而 Go 是逐字节替换, 错误信息文本会不一样, 因此这里手写一遍。
pub fn go_lossy(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    let mut rest = bytes;
    loop {
        match std::str::from_utf8(rest) {
            Ok(valid) => {
                out.push_str(valid);
                return out;
            }
            Err(err) => {
                let good = err.valid_up_to();
                // valid_up_to() 之前的片段一定是合法 UTF-8
                out.push_str(std::str::from_utf8(&rest[..good]).unwrap_or(""));
                let bad = err.error_len().unwrap_or(rest.len() - good);
                for _ in 0..bad {
                    out.push('\u{FFFD}');
                }
                let next = good.saturating_add(bad).min(rest.len());
                if next <= good {
                    // 防御: 不前进就直接退出, 绝不死循环
                    return out;
                }
                rest = &rest[next..];
            }
        }
    }
}

/// 按字节上限截断(与 [`trunc`] 同一套 Go `encoding/json` 逐字节 U+FFFD 替换),
/// 只是上限可传。`tasks` 索引的 `error` 字段用它把错误压到 120B。
pub fn trunc_to(bytes: &[u8], limit: usize) -> String {
    go_lossy(&bytes[..bytes.len().min(limit)])
}

/// 对应 Go `mustJSON`: 序列化失败(正常不可能)时回退到固定错误响应。
pub fn encode_or_fallback<T: Serialize>(value: &T) -> Vec<u8> {
    match serde_json::to_vec(value) {
        Ok(bytes) => bytes,
        Err(_) => ENCODE_FAILED.to_vec(),
    }
}

/// JSON 值的紧凑文本: 错误信息里回显参数用。
///
/// Go 回显的是 `json.RawMessage` 的**原始字节**(含空白), 这里回显的是重新紧凑序列化的
/// 结果 —— 只有诊断文本的空白差异, 语义相同。
pub fn value_text(value: &serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap_or_default()
}

/// 对应 Go `main.go:2085` `stringVal`: `nil` → `""`, 字符串原样, 其余走 `fmt.Sprint`。
///
/// 用在 `action` 的 `input` 取值上: Go 那边 `input["x"]` 是 `any`,
/// 类型断言失败就当空串(非严格取值, 与 [`crate::raw::string_field`] 的"类型不符报错"不同)。
///
/// 已知差异(仅诊断路径, 不影响是否取到值): 对象/数组在 Go 里会得到 `map[a:1]` /
/// `[1 2]` 这种 `%v` 记法, 这里给紧凑 JSON; 浮点 `3.0` 在 Go 里是 `3`, 这里是 `3.0`。
pub fn string_val(value: Option<&serde_json::Value>) -> String {
    match value {
        None | Some(serde_json::Value::Null) => String::new(),
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Bool(flag)) => flag.to_string(),
        Some(serde_json::Value::Number(number)) => number.to_string(),
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
    }
}
