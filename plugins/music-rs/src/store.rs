//! 薄封装: 通用存储层在 `common::store`, 这里只绑定本插件的幂等键前缀。
//!
//! 幂等键前缀有宿主语义(已部署实例的键空间), 不能统一: `mr-put`。
//! `PutIds` 用 marker + 类型别名, 所有 `PutIds::new()` 调用点(含 const static)保持原样。

pub use common::store::*;

/// 本插件的幂等键前缀 marker。
pub struct MusicPrefix;

impl IdPrefix for MusicPrefix {
    const PREFIX: &'static str = "mr-put";
}

/// 绑定前缀后的幂等键序列。
pub type PutIds = common::store::PutIds<MusicPrefix>;

#[cfg(test)]
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
#[cfg(test)]
use base64::Engine as _;
#[cfg(test)]
use common::host::HostCallResponse;

#[cfg(test)]
mod tests {
    use super::*;

    fn response(body: &[u8], padded: bool) -> HostCallResponse {
        let encoded = if padded {
            STANDARD.encode(body)
        } else {
            STANDARD_NO_PAD.encode(body)
        };
        HostCallResponse {
            status: 200,
            headers: Default::default(),
            body_base64: encoded,
        }
    }

    #[test]
    fn decode_body_accepts_raw_and_std_padding() {
        for body in [
            b"".to_vec(),
            b"x".to_vec(),
            b"{\"tasks\":[],\"settings\":{}}".to_vec(),
            vec![0u8, 1, 2, 250, 251, 252, 253, 254, 255],
        ] {
            for padded in [false, true] {
                let decoded = decode_body(&response(&body, padded)).unwrap();
                assert_eq!(decoded, body, "padded={padded}");
            }
        }
        let empty = HostCallResponse {
            status: 200,
            headers: Default::default(),
            body_base64: String::new(),
        };
        assert_eq!(decode_body(&empty).unwrap(), Vec::<u8>::new());

        let bad = HostCallResponse {
            status: 200,
            headers: Default::default(),
            body_base64: "!!!not base64!!!".to_string(),
        };
        assert!(decode_body(&bad).is_err());
    }

    /// 信封三态: `data.value` → 顶层 `value` → 裸值, 以及 `null` 边界。
    #[test]
    fn unwrap_value_tiers() {
        let envelope = r#"{
          "data": {
            "key": "state",
            "value": {"tasks":[{"id":"t1"}],"settings":{"level":"flac"}},
            "revision": "pkv_248"
          },
          "meta": {"plugin_id": "music.rs"}
        }"#;
        assert_eq!(
            String::from_utf8(unwrap_value(envelope.as_bytes())).unwrap(),
            r#"{"tasks":[{"id":"t1"}],"settings":{"level":"flac"}}"#
        );

        let legacy = r#"{"value":{"a":1}}"#;
        assert_eq!(
            String::from_utf8(unwrap_value(legacy.as_bytes())).unwrap(),
            r#"{"a":1}"#
        );

        let bare = r#"{"tasks":[]}"#;
        assert_eq!(
            String::from_utf8(unwrap_value(bare.as_bytes())).unwrap(),
            bare
        );

        assert_eq!(unwrap_value(b""), Vec::<u8>::new());
        assert_eq!(
            String::from_utf8(unwrap_value(br#"{"value":null}"#)).unwrap(),
            "null"
        );
        assert_eq!(
            String::from_utf8(unwrap_value(br#"{"data":{"value":1},"value":2}"#)).unwrap(),
            "1"
        );
        assert_eq!(unwrap_value(b"[1,2]"), b"[1,2]");
        // 回归: `[{"id":"t1"}]` 这类顶层数组, serde 的"序列 → 结构体"会把信封解成
        // `value = {"id":"t1"}`, 静默截掉数组外壳(任务队列就长这样)。
        let array = br#"[{"id":"t1","status":"queued"}]"#;
        assert_eq!(unwrap_value(array), array);
        assert_eq!(unwrap_value(b"  []"), b"  []");
        assert_eq!(unwrap_value(b"not json"), b"not json");
        assert_eq!(unwrap_value(br#"{"value":"x"}"#), b"\"x\"");
    }

    #[test]
    fn etag_header_lookup_is_case_insensitive() {
        let mut headers = std::collections::BTreeMap::new();
        headers.insert("ETag".to_string(), vec!["\"pkv_7\"".to_string()]);
        assert_eq!(header_first(&headers, "etag"), Some("\"pkv_7\""));
        assert_eq!(header_first(&headers, "ETAG"), Some("\"pkv_7\""));

        let mut headers = std::collections::BTreeMap::new();
        headers.insert("Etag".to_string(), Vec::<String>::new());
        headers.insert("etag".to_string(), vec!["\"pkv_9\"".to_string()]);
        assert_eq!(header_first(&headers, "etag"), Some("\"pkv_9\""));

        let empty: std::collections::BTreeMap<String, Vec<String>> = Default::default();
        assert_eq!(header_first(&empty, "etag"), None);
    }

    #[test]
    fn put_body_is_value_wrapped() {
        assert_eq!(put_body(br#"{"a":1}"#), br#"{"value":{"a":1}}"#);
        assert_eq!(put_body(b""), Vec::<u8>::new());
    }

    /// 幂等键必须唯一、带前缀, 且长度落在宿主允许的 16~128 个可打印 ASCII。
    #[test]
    fn put_ids_are_unique_and_host_safe() {
        let mut ids = PutIds::new();
        let a = ids.next_key("state");
        let b = ids.next_key("state");
        let c = ids.next_key("diag");
        assert_ne!(a, b);
        assert_ne!(b, c);
        assert!(a.starts_with("mr-put-state-"));
        assert!(c.starts_with("mr-put-diag-"));
        for id in [&a, &b, &c] {
            assert!((16..=128).contains(&id.len()), "幂等键长度越界: {id}");
            assert!(
                id.bytes().all(|byte| byte.is_ascii_graphic()),
                "必须全是可打印 ASCII: {id}"
            );
        }
        assert_eq!(ids.seq(), 3);
    }
}
