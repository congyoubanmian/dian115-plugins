//! 薄封装: 通用存储层在 `common::store`, 这里只绑定本插件的幂等键前缀。
//!
//! 幂等键前缀有宿主语义(已部署实例的键空间), 不能统一: `dc-put`。
//! `PutIds` 用 marker + 类型别名, 所有 `PutIds::new()` 调用点(含 const static)保持原样。

pub use common::store::*;

/// 本插件的幂等键前缀 marker。
pub struct DoubanPrefix;

impl IdPrefix for DoubanPrefix {
    const PREFIX: &'static str = "dc-put";
}

/// 绑定前缀后的幂等键序列。
pub type PutIds = common::store::PutIds<DoubanPrefix>;

/// 旧版分键持久化的键名(Go `pathToKey`: `.data/history.json` → `history`)。
pub fn legacy_keys() -> [&'static str; 7] {
    [
        "settings",
        "snapshot",
        "queue",
        "history",
        "logs",
        "stats",
        "blackstate",
    ]
}

/// `.data/<name>.json` → 存储键(Go `pathToKey` 的移植, 供迁移与测试对照)。
pub fn path_to_key(path: &str) -> String {
    let path = path.strip_prefix('/').unwrap_or(path);
    let path = path.strip_prefix(".data/").unwrap_or(path);
    path.strip_suffix(".json").unwrap_or(path).to_string()
}

#[cfg(test)]
use crate::clock;
#[cfg(test)]
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
#[cfg(test)]
use base64::Engine as _;
#[cfg(test)]
use common::host::HostCallResponse;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{EnvelopeStyle, FakeHost};

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
        // Go 的 decodeBody: 先 RawStdEncoding(不带 padding), 失败再 StdEncoding(带 padding)
        for body in [
            b"".to_vec(),
            b"x".to_vec(),
            b"{\"settings\":{\"lists\":{\"hot\":{\"source\":\"subjects_json\"}}}}".to_vec(),
            vec![0u8, 1, 2, 250, 251, 252, 253, 254, 255],
        ] {
            for padded in [false, true] {
                let decoded = decode_body(&response(&body, padded)).unwrap();
                assert_eq!(decoded, body, "padded={padded}");
            }
        }
        // 空 body_base64 → 空值, 不报错(Go 里 decodeBody 返回 nil, nil)
        let empty = HostCallResponse {
            status: 200,
            headers: Default::default(),
            body_base64: String::new(),
        };
        assert_eq!(decode_body(&empty).unwrap(), Vec::<u8>::new());

        // 坏 base64 → 报错(Go 的 CorruptInputError 分支)
        let bad = HostCallResponse {
            status: 200,
            headers: Default::default(),
            body_base64: "!!!not base64!!!".to_string(),
        };
        assert!(decode_body(&bad).is_err());
    }

    /// Go `storage_test.go` `TestUnwrapStorageValue` 的逐条对照 + `null` 边界。
    #[test]
    fn unwrap_value_matches_go_cases() {
        let envelope = r#"{
          "data": {
            "key": "state",
            "value": {"settings":{"lists":{"hot":{"source":"subjects_json","enabled":true}}},"queue":{"items":[]}},
            "revision": "pkv_248",
            "updated_at": "2026-09-28T12:00:20Z"
          },
          "meta": {"plugin_id": "douban.center", "installation_id": 30}
        }"#;
        assert_eq!(
            String::from_utf8(unwrap_value(envelope.as_bytes())).unwrap(),
            r#"{"settings":{"lists":{"hot":{"source":"subjects_json","enabled":true}}},"queue":{"items":[]}}"#
        );

        let legacy = r#"{"value":{"a":1}}"#;
        assert_eq!(
            String::from_utf8(unwrap_value(legacy.as_bytes())).unwrap(),
            r#"{"a":1}"#
        );

        let bare = r#"{"settings":{"lists":{"hot":{}}}}"#;
        assert_eq!(
            String::from_utf8(unwrap_value(bare.as_bytes())).unwrap(),
            bare
        );

        assert_eq!(unwrap_value(b""), Vec::<u8>::new());

        // `null` 也是"有值": Go 的 json.RawMessage 会收到这 4 个字节
        assert_eq!(
            String::from_utf8(unwrap_value(br#"{"value":null}"#)).unwrap(),
            "null"
        );
        assert_eq!(
            String::from_utf8(unwrap_value(br#"{"data":{"value":null}}"#)).unwrap(),
            "null"
        );
        // data 优先于 value
        assert_eq!(
            String::from_utf8(unwrap_value(br#"{"data":{"value":1},"value":2}"#)).unwrap(),
            "1"
        );
        // 没有 value 字段 → 原样
        assert_eq!(
            String::from_utf8(unwrap_value(br#"{"data":{"key":"state"}}"#)).unwrap(),
            r#"{"data":{"key":"state"}}"#
        );
        // data 类型不符 → Go 的 Unmarshal 失败 → 原样
        assert_eq!(
            String::from_utf8(unwrap_value(br#"{"data":5,"value":2}"#)).unwrap(),
            r#"{"data":5,"value":2}"#
        );
        // data 为 null → Go 里是零值结构体(不报错) → 回退到顶层 value
        assert_eq!(
            String::from_utf8(unwrap_value(br#"{"data":null,"value":2}"#)).unwrap(),
            "2"
        );
        assert_eq!(
            String::from_utf8(unwrap_value(br#"{"data":null,"value":{"a":1}}"#)).unwrap(),
            r#"{"a":1}"#
        );
        // 顶层不是对象 → 原样
        assert_eq!(unwrap_value(b"[1,2]"), b"[1,2]");
        assert_eq!(unwrap_value(b"\"x\""), b"\"x\"");
        assert_eq!(unwrap_value(b"null"), b"null");
        assert_eq!(unwrap_value(b"not json"), b"not json");
        // 值本身是字符串时返回带引号的原始 JSON(与 Go 的 RawMessage 一致)
        assert_eq!(unwrap_value(br#"{"value":"x"}"#), b"\"x\"");
    }

    #[test]
    fn etag_header_lookup_is_case_insensitive() {
        let mut headers = std::collections::BTreeMap::new();
        headers.insert("ETag".to_string(), vec!["\"pkv_7\"".to_string()]);
        assert_eq!(header_first(&headers, "etag"), Some("\"pkv_7\""));
        assert_eq!(header_first(&headers, "ETAG"), Some("\"pkv_7\""));

        // 空值列表要跳过, 继续找同名条目(Go 的 len(values) > 0 判定)
        let mut headers = std::collections::BTreeMap::new();
        headers.insert("Etag".to_string(), Vec::<String>::new());
        headers.insert("etag".to_string(), vec!["\"pkv_9\"".to_string()]);
        assert_eq!(header_first(&headers, "etag"), Some("\"pkv_9\""));

        let empty: std::collections::BTreeMap<String, Vec<String>> = Default::default();
        assert_eq!(header_first(&empty, "etag"), None);
    }

    #[test]
    fn read_extracts_etag_and_unwraps_envelope() {
        let host = FakeHost::new();
        host.set("state", br#"{"settings":{"lists":{}}}"#);
        let _guard = host.install();
        let read = super::read("state");
        assert!(read.ok);
        assert_eq!(read.etag, "\"pkv_1\"");
        assert_eq!(read.value, br#"{"settings":{"lists":{}}}"#);
    }

    /// ETag 头的大小写不敏感(Go `strings.EqualFold`)。
    #[test]
    fn read_etag_is_case_insensitive() {
        for header in ["ETag", "etag", "eTaG"] {
            let host = FakeHost::new();
            host.etag_header_name(header);
            host.set("state", br#"{"settings":{"lists":{}}}"#);
            let _guard = host.install();
            let read = super::read("state");
            assert_eq!(read.etag, "\"pkv_1\"", "header={header}");
        }
    }

    #[test]
    fn read_reports_missing_key_and_host_failure() {
        let host = FakeHost::new();
        let _guard = host.install();
        let read = super::read("state");
        assert!(!read.ok, "404 必须 ok=false");
        assert_eq!(read.value, Vec::<u8>::new());
        assert_eq!(read.etag, "");

        let host = FakeHost::new();
        host.fail_all(true);
        let _guard = host.install();
        let read = super::read("state");
        assert!(!read.ok, "host.call 失败必须 ok=false");
        assert_eq!(super::status("state"), 0, "Go storageStatus 失败返回 0");
    }

    #[test]
    fn put_body_is_value_wrapped() {
        assert_eq!(put_body(br#"{"a":1}"#), br#"{"value":{"a":1}}"#);
        assert_eq!(put_body(b""), Vec::<u8>::new());
    }

    #[test]
    fn put_sends_go_shaped_request() {
        let host = FakeHost::new();
        let _guard = host.install();
        let mut ids = PutIds::new();
        put(&mut ids, "state", br#"{"a":1}"#).unwrap();

        let requests = host.requests();
        assert_eq!(requests[0].method, "GET", "先读 ETag");
        assert_eq!(requests[0].path, "/api/plugin-runtime/storage/state");
        assert_eq!(requests[1].method, "PUT");
        let put_request = &requests[1];
        assert_eq!(put_request.path, "/api/plugin-runtime/storage/state");
        assert_eq!(
            put_request.headers.get("content-type").map(String::as_str),
            Some("application/json")
        );
        assert_eq!(
            put_request.headers.get("accept").map(String::as_str),
            Some("application/json")
        );
        // 键不存在 → 不带 If-Match
        assert!(
            !put_request.headers.contains_key("if-match"),
            "新建键不该带 If-Match"
        );
        // body_base64 必须是 RawStd(不补 padding)
        assert_eq!(put_request.body_base64, "eyJ2YWx1ZSI6eyJhIjoxfX0");
        assert!(
            !put_request.body_base64.contains('='),
            "RawStd 不带 padding"
        );
        // 宿主约束: 幂等键 16~128 个可打印 ASCII
        let idem = put_request
            .headers
            .get("idempotency-key")
            .expect("幂等键必填");
        assert!(
            (16..=128).contains(&idem.len()),
            "幂等键长度 {} 越界: {idem}",
            idem.len()
        );
        assert!(
            idem.bytes().all(|b| b.is_ascii_graphic()),
            "必须全是可打印 ASCII: {idem}"
        );
        assert!(idem.starts_with("dc-put-state-"), "{idem}");

        // 第二次写入必须换一个幂等键(宿主保留 24h 幂等记录)
        put(&mut ids, "state", br#"{"a":2}"#).unwrap();
        let requests = host.requests();
        let first = &requests[1].headers["idempotency-key"];
        let second = &requests[3].headers["idempotency-key"];
        assert_ne!(first, second, "每次写入必须唯一");
        // 键已存在 → 必须带 If-Match, 且是本次 PUT 前刚读回来的 ETag。
        // 首次插入把 revision 推到 1(ETag "pkv_1"), 第二次 PUT 前读到的就是它;
        // 这次 PUT 成功后 revision 才变成 2。
        assert_eq!(
            requests[3].headers.get("if-match").map(String::as_str),
            Some("\"pkv_1\"")
        );
        // 值确实写进去了
        assert_eq!(host.value_of("state").unwrap(), br#"{"a":2}"#);

        // 请求信封形状(与 host.rs 的既有约定一致; 用同一个信封结构体, 保字段顺序)
        let wire =
            String::from_utf8(crate::host::encode_request(&requests[1]).expect("请求必须能编码"))
                .unwrap();
        assert_eq!(
            wire,
            r#"{"method":"host.call","params":{"method":"PUT","path":"/api/plugin-runtime/storage/state","headers":{"accept":"application/json","content-type":"application/json","idempotency-key":""#.to_string()
                + &requests[1].headers["idempotency-key"]
                + r#""},"body_base64":"eyJ2YWx1ZSI6eyJhIjoxfX0"}}"#
        );
    }

    #[test]
    fn put_retries_once_on_412_with_fresh_etag() {
        let host = FakeHost::new();
        host.set("state", br#"{"v":1}"#);
        // 模拟并发写入: 第一次 PUT 时键已被别的 worker 改过 → 412 + ETag 变新
        host.concurrent_write_on_put();
        let _guard = host.install();

        let mut ids = PutIds::new();
        put(&mut ids, "state", br#"{"v":2}"#).unwrap();

        let puts = host.puts();
        assert_eq!(puts.len(), 2, "412 后必须重试一次, 实际 {}", puts.len());
        assert_ne!(
            puts[0].if_match, puts[1].if_match,
            "重试必须用重读后的新 ETag: {:?}",
            puts
        );
        assert_eq!(puts[1].if_match.as_deref(), Some("\"pkv_2\""));
        assert_ne!(
            puts[0].idempotency_key, puts[1].idempotency_key,
            "重试也要换幂等键"
        );
        assert_eq!(host.value_of("state").unwrap(), br#"{"v":2}"#);

        // 412 但重读回来 ok=false(键被删了) → 不再重试, 直接报错
        let host = FakeHost::new();
        host.set("state", br#"{"v":1}"#);
        host.concurrent_delete_on_put();
        let _guard = host.install();
        let mut ids = PutIds::new();
        let err = put(&mut ids, "state", br#"{"v":2}"#).unwrap_err();
        assert!(err.0.starts_with("storage PUT HTTP 412"), "{err}");
        assert_eq!(host.puts().len(), 1, "重读失败就不再重试");
    }

    #[test]
    fn put_reports_http_errors_with_truncated_body() {
        let host = FakeHost::new();
        host.push_put_status(500);
        host.put_error_body(&vec![b'e'; 400]);
        let _guard = host.install();
        let mut ids = PutIds::new();
        let err = put(&mut ids, "state", br#"{"v":1}"#).unwrap_err();
        let text = err.0.clone();
        assert!(text.starts_with("storage PUT HTTP 500: "), "{text}");
        assert_eq!(
            text.len(),
            "storage PUT HTTP 500: ".len() + 200,
            "错误细节按 200 字节截断"
        );
    }

    #[test]
    fn load_state_with_retry_three_states() {
        // ① 有值 → loaded
        let host = FakeHost::new();
        host.set("state", br#"{"settings":{"lists":{}}}"#);
        let _guard = host.install();
        let _ = clock::testhooks::take_sleeps();
        let (raw, result) = load_state_with_retry();
        assert_eq!(result, LoadResult::Loaded);
        assert_eq!(raw.as_deref(), Some(&br#"{"settings":{"lists":{}}}"#[..]));
        assert!(clock::testhooks::take_sleeps().is_empty(), "成功路径不该睡");

        // ② 两次 404 → fresh, 中间只睡 300ms
        let host = FakeHost::new();
        host.get_status(404);
        let _guard = host.install();
        let _ = clock::testhooks::take_sleeps();
        let (raw, result) = load_state_with_retry();
        assert_eq!(result, LoadResult::Fresh);
        assert!(raw.is_none());
        assert_eq!(
            clock::testhooks::take_sleeps(),
            vec![300],
            "404 需间隔 300ms 两次确认"
        );

        // ③ 宿主持续不可读 → unavailable, 3 次尝试各睡 200ms
        let host = FakeHost::new();
        host.fail_all(true);
        let _guard = host.install();
        let _ = clock::testhooks::take_sleeps();
        let (raw, result) = load_state_with_retry();
        assert_eq!(result, LoadResult::Unavailable);
        assert!(raw.is_none());
        assert_eq!(clock::testhooks::take_sleeps(), vec![200, 200, 200]);

        // ④ 404 但第二次确认时已经恢复(瞬时 404) → 不判 fresh, 重试到 loaded
        let host = FakeHost::new();
        host.set("state", br#"{"settings":{"lists":{}}}"#);
        host.push_get_status(404);
        host.push_get_status(404);
        let _guard = host.install();
        let _ = clock::testhooks::take_sleeps();
        let (raw, result) = load_state_with_retry();
        assert_eq!(result, LoadResult::Loaded, "瞬时 404 不能被当成全新安装");
        assert_eq!(raw.as_deref(), Some(&br#"{"settings":{"lists":{}}}"#[..]));
        assert_eq!(clock::testhooks::take_sleeps(), vec![300, 200]);
    }

    #[test]
    fn legacy_keys_and_path_mapping() {
        assert_eq!(path_to_key("/.data/settings.json"), "settings");
        assert_eq!(path_to_key(".data/history.json"), "history");
        assert_eq!(path_to_key(".data/blackstate.json"), "blackstate");
        assert_eq!(legacy_keys().len(), 7);
    }

    #[test]
    fn put_ids_are_unique_and_prefixed() {
        let mut ids = PutIds::new();
        let a = ids.next_key("state");
        let b = ids.next_key("state");
        let c = ids.next_key("account");
        assert_ne!(a, b);
        assert_ne!(b, c);
        assert!(a.starts_with("dc-put-state-"));
        assert!(c.starts_with("dc-put-account-"));
        assert_eq!(ids.seq(), 3);
    }

    /// 信封风格三态都要能一路读到值(真实宿主 / 0.3.6 的扁平信封 / 裸文档)。
    #[test]
    fn read_supports_all_envelope_styles() {
        for style in [
            EnvelopeStyle::Host,
            EnvelopeStyle::LegacyFlat,
            EnvelopeStyle::Bare,
        ] {
            let host = FakeHost::new();
            host.envelope_style(style);
            host.set("state", br#"{"settings":{"lists":{"hot":{}}}}"#);
            let _guard = host.install();
            let read = super::read("state");
            assert!(read.ok, "{style:?} 必须能读到");
            assert_eq!(
                read.value, br#"{"settings":{"lists":{"hot":{}}}}"#,
                "{style:?}"
            );
        }
    }
}
