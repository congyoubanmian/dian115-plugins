//! 薄封装: 生产代码在 `common::util`, 本模块只做 re-export。
//!
//! 插件级测试保留在这里(依赖插件的 testkit / 前缀断言 / 业务语义)。

pub use common::util::*;

#[cfg(test)]
use serde::Serialize;

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
