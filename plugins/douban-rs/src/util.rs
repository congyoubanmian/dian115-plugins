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
/// 用在 `action` 的 `input` 取值上(`blacklist-add` 的 keyword、`get-poster` 的 poster_url):
/// Go 那边 `input["x"]` 是 `any`, 类型断言失败就当空串。
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trunc_caps_at_200_bytes() {
        let short = b"abc";
        assert_eq!(trunc(short), "abc");
        let long = vec![b'x'; 400];
        assert_eq!(trunc(&long).len(), TRUNC_LIMIT);
        assert_eq!(trunc(&long), "x".repeat(TRUNC_LIMIT));
        assert_eq!(trunc(b""), "");
    }

    #[test]
    fn trunc_keeps_utf8_when_ascii() {
        let s = "汉字".repeat(10); // 60 字节, 不触发截断
        assert_eq!(trunc(s.as_bytes()), s);
    }

    /// Go 逐字节替换 U+FFFD: 被截断的多字节序列会产生多个替换字符。
    #[test]
    fn go_lossy_replaces_each_bad_byte() {
        assert_eq!(go_lossy("你好".as_bytes()), "你好");
        assert_eq!(go_lossy(b"a\xffb"), "a\u{FFFD}b");
        // "你" = E4 BD A0, 砍掉最后一字节 → Go 输出两个 U+FFFD
        assert_eq!(go_lossy(&[0xE4, 0xBD]), "\u{FFFD}\u{FFFD}");
        // 完整三轮 UTF-8 里的非法序列
        assert_eq!(go_lossy(&[0xE4, 0xBD, 0xA0, 0x41]), "你A");
        assert_eq!(go_lossy(b""), "");
    }

    #[test]
    fn trunc_truncated_utf8_does_not_panic() {
        let mut raw = vec![b'x'; 198];
        raw.extend_from_slice(&[0xE4, 0xBD]); // 半个汉字, 正好卡在 200 字节窗口末尾
        let mut long = raw.clone();
        long.extend_from_slice(&vec![b'y'; 500]);
        let out = trunc(&long);
        assert_eq!(out.matches('\u{FFFD}').count(), 2);
        assert_eq!(out.chars().count(), TRUNC_LIMIT);
    }

    #[test]
    fn encode_or_fallback_matches_go() {
        let ok = encode_or_fallback(&serde_json::json!({"a": 1}));
        assert_eq!(ok, br#"{"a":1}"#.to_vec());

        struct Failing;
        impl Serialize for Failing {
            fn serialize<S: serde::Serializer>(&self, _s: S) -> Result<S::Ok, S::Error> {
                Err(<S::Error as serde::ser::Error>::custom("boom"))
            }
        }
        assert_eq!(encode_or_fallback(&Failing), ENCODE_FAILED.to_vec());
    }

    #[test]
    fn value_text_is_compact() {
        let v: serde_json::Value = serde_json::from_str("{ \"a\" : [1, 2] }").unwrap();
        assert_eq!(value_text(&v), br#"{"a":[1,2]}"#.to_vec());
    }

    /// Go `stringVal`(`main.go:2085`): nil → "", 字符串原样, 标量按字面。
    #[test]
    fn string_val_matches_go_for_scalars() {
        assert_eq!(string_val(None), "");
        assert_eq!(string_val(Some(&serde_json::Value::Null)), "");
        assert_eq!(string_val(Some(&serde_json::json!("海报"))), "海报");
        assert_eq!(string_val(Some(&serde_json::json!(true))), "true");
        assert_eq!(string_val(Some(&serde_json::json!(false))), "false");
        assert_eq!(string_val(Some(&serde_json::json!(3))), "3");
        assert_eq!(string_val(Some(&serde_json::json!(""))), "");
        // 非字符串在原子里是"取不到" —— `action` 里它就是空关键词
        assert_eq!(string_val(Some(&serde_json::json!({"a": 1}))), r#"{"a":1}"#);
    }
}
