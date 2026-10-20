//! 薄封装: 通用存储层在 `common::store`, 这里只绑定本插件的幂等键前缀。
//!
//! 幂等键前缀有宿主语义(已部署实例的键空间), 不能统一: `chase-put`。
//! `PutIds` 用 marker + 类型别名, 所有 `PutIds::new()` 调用点(含 const static)保持原样。

pub use common::store::*;

/// 本插件的幂等键前缀 marker。
pub struct ChasePrefix;

impl IdPrefix for ChasePrefix {
    const PREFIX: &'static str = "chase-put";
}

/// 绑定前缀后的幂等键序列。
pub type PutIds = common::store::PutIds<ChasePrefix>;

#[cfg(test)]
use crate::clock;
#[cfg(test)]
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
#[cfg(test)]
use base64::Engine as _;
#[cfg(test)]
use common::host::{HostCallRequest, HostCallResponse, HostError};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::testhost;
    use std::cell::RefCell;
    use std::collections::BTreeMap;
    use std::rc::Rc;

    fn response(status: i32, etag: Option<&str>, body: &[u8]) -> HostCallResponse {
        let mut headers: BTreeMap<String, Vec<String>> = BTreeMap::new();
        if let Some(etag) = etag {
            headers.insert("ETag".to_string(), vec![etag.to_string()]);
        }
        HostCallResponse {
            status,
            headers,
            body_base64: STANDARD_NO_PAD.encode(body),
        }
    }

    /// 最小内存 KV 宿主: GET/PUT + `pkv_N` 乐观锁 + 宿主信封, 够覆盖存储层契约。
    #[derive(Default)]
    struct FakeHost {
        value: Option<Vec<u8>>,
        revision: u64,
        /// 一次性并发写入: 下一次 PUT 强制 412 并把 ETag 推新。
        concurrent_write: bool,
        puts: Vec<(String, String)>,
    }

    impl FakeHost {
        fn handle(&mut self, request: &HostCallRequest) -> Result<HostCallResponse, HostError> {
            match request.method.as_str() {
                "GET" => match &self.value {
                    Some(value) => Ok(response(
                        200,
                        Some(&format!("\"pkv_{}\"", self.revision)),
                        &envelope(value, self.revision),
                    )),
                    None => Ok(HostCallResponse {
                        status: 404,
                        ..Default::default()
                    }),
                },
                "PUT" => {
                    let if_match = request.headers.get("if-match").cloned().unwrap_or_default();
                    let idem = request
                        .headers
                        .get("idempotency-key")
                        .cloned()
                        .unwrap_or_default();
                    self.puts.push((if_match.clone(), idem));
                    if self.concurrent_write {
                        self.concurrent_write = false;
                        self.revision += 1;
                        return Ok(HostCallResponse {
                            status: 412,
                            ..Default::default()
                        });
                    }
                    if self.value.is_some() && if_match != format!("\"pkv_{}\"", self.revision) {
                        return Ok(HostCallResponse {
                            status: 412,
                            ..Default::default()
                        });
                    }
                    let body = STANDARD_NO_PAD
                        .decode(&request.body_base64)
                        .unwrap_or_default();
                    // 宿主只接受 {"value": ...}: 剥掉这层壳再存。
                    let inner = body
                        .strip_prefix(br#"{"value":"#)
                        .and_then(|rest| rest.strip_suffix(b"}"))
                        .unwrap_or(&body)
                        .to_vec();
                    self.value = Some(inner);
                    self.revision += 1;
                    Ok(response(
                        200,
                        Some(&format!("\"pkv_{}\"", self.revision)),
                        b"",
                    ))
                }
                other => Err(HostError::new(format!("意外的方法 {other}"))),
            }
        }
    }

    /// 宿主信封: `{"data":{"key":..,"value":<值>,"revision":"pkv_N"},"meta":{..}}`。
    fn envelope(value: &[u8], revision: u64) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(br#"{"data":{"key":"state","value":"#);
        body.extend_from_slice(value);
        body.extend_from_slice(
            format!(
                r#","revision":"pkv_{revision}","updated_at":"2026-10-01T00:00:00Z"}},"meta":{{"plugin_id":"chase.rs","installation_id":1}}}}"#
            )
            .as_bytes(),
        );
        body
    }

    fn install(fake: &Rc<RefCell<FakeHost>>) {
        let handle = Rc::clone(fake);
        testhost::install(Box::new(move |request| handle.borrow_mut().handle(request)));
    }

    #[test]
    fn decode_body_accepts_raw_and_std_padding() {
        for body in [
            b"".to_vec(),
            b"x".to_vec(),
            br#"{"settings":{"lists":{}}}"#.to_vec(),
            vec![0u8, 1, 2, 250, 251, 252, 253, 254, 255],
        ] {
            for padded in [false, true] {
                let encoded = if padded {
                    STANDARD.encode(&body)
                } else {
                    STANDARD_NO_PAD.encode(&body)
                };
                let resp = HostCallResponse {
                    status: 200,
                    headers: Default::default(),
                    body_base64: encoded,
                };
                assert_eq!(decode_body(&resp).unwrap(), body, "padded={padded}");
            }
        }
        let empty = HostCallResponse::default();
        assert_eq!(decode_body(&empty).unwrap(), Vec::<u8>::new());

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
            "value": {"revision":7,"last_align_at":"2026-10-01T00:00:00Z"},
            "revision": "pkv_248",
            "updated_at": "2026-10-01T00:00:00Z"
          },
          "meta": {"plugin_id": "chase.rs", "installation_id": 1}
        }"#;
        assert_eq!(
            String::from_utf8(unwrap_value(envelope.as_bytes())).unwrap(),
            r#"{"revision":7,"last_align_at":"2026-10-01T00:00:00Z"}"#
        );

        let legacy = r#"{"value":{"a":1}}"#;
        assert_eq!(
            String::from_utf8(unwrap_value(legacy.as_bytes())).unwrap(),
            r#"{"a":1}"#
        );

        let bare = r#"{"revision":1}"#;
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
        // 顶层不是对象 → 原样
        assert_eq!(unwrap_value(b"[1,2]"), b"[1,2]");
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
    fn read_unwraps_envelope_and_keeps_etag() {
        let fake = Rc::new(RefCell::new(FakeHost::default()));
        fake.borrow_mut().value = Some(br#"{"revision":1}"#.to_vec());
        fake.borrow_mut().revision = 1;
        install(&fake);

        let read = super::read(STATE_KEY);
        testhost::clear();
        assert!(read.ok);
        assert_eq!(read.etag, "\"pkv_1\"");
        assert_eq!(read.value, br#"{"revision":1}"#);
    }

    #[test]
    fn read_reports_missing_key_and_host_failure() {
        // 404 → ok=false, 值/etag 都是空
        let fake = Rc::new(RefCell::new(FakeHost::default()));
        install(&fake);
        let missing = super::read(STATE_KEY);
        testhost::clear();
        assert!(!missing.ok);
        assert_eq!(missing.value, Vec::<u8>::new());
        assert_eq!(missing.etag, "");

        // 没有替身(本机 abi_stub) → ok=false, status=0
        assert!(!super::read(STATE_KEY).ok);
        assert_eq!(super::status(STATE_KEY), 0);
    }

    #[test]
    fn put_body_is_value_wrapped() {
        assert_eq!(put_body(br#"{"a":1}"#), br#"{"value":{"a":1}}"#);
        assert_eq!(put_body(b""), Vec::<u8>::new());
    }

    #[test]
    fn put_writes_with_etag_lock_and_unique_idempotency_keys() {
        let fake = Rc::new(RefCell::new(FakeHost::default()));
        install(&fake);
        let mut ids = PutIds::new();

        // 键不存在: 先 GET(404) → 不带 If-Match 的 PUT
        put(&mut ids, STATE_KEY, br#"{"revision":1}"#).unwrap();
        assert_eq!(
            fake.borrow().value.as_deref(),
            Some(&br#"{"revision":1}"#[..])
        );
        assert_eq!(fake.borrow().puts.len(), 1);
        assert_eq!(fake.borrow().puts[0].0, "", "新建键不带 If-Match");

        // 键已存在: 必须带刚读回来的 ETag, 且幂等键每次唯一
        put(&mut ids, STATE_KEY, br#"{"revision":2}"#).unwrap();
        let puts = fake.borrow().puts.clone();
        assert_eq!(puts.len(), 2);
        assert_eq!(
            puts[1].0, "\"pkv_1\"",
            "第二次 PUT 必须带上一次写入后的 ETag"
        );
        assert_ne!(puts[0].1, puts[1].1, "幂等键每次写入必须唯一");
        assert!(puts[0].1.starts_with("chase-put-state-"), "{}", puts[0].1);
        assert!(puts[0].1.len() >= 16 && puts[0].1.bytes().all(|b| b.is_ascii_graphic()));
        assert_eq!(
            fake.borrow().value.as_deref(),
            Some(&br#"{"revision":2}"#[..])
        );
        testhost::clear();
    }

    #[test]
    fn put_retries_once_on_412_with_fresh_etag() {
        let fake = Rc::new(RefCell::new(FakeHost::default()));
        fake.borrow_mut().value = Some(br#"{"revision":1}"#.to_vec());
        fake.borrow_mut().revision = 1;
        // 模拟并发写入: 第一次 PUT 时键已被别的 worker 改过 → 412 + ETag 变新
        fake.borrow_mut().concurrent_write = true;
        install(&fake);

        let mut ids = PutIds::new();
        put(&mut ids, STATE_KEY, br#"{"revision":2}"#).unwrap();

        let puts = fake.borrow().puts.clone();
        assert_eq!(puts.len(), 2, "412 后必须重试一次, 实际 {}", puts.len());
        assert_eq!(puts[0].0, "\"pkv_1\"", "第一次 PUT 带旧 ETag: {puts:?}");
        assert_eq!(
            puts[1].0, "\"pkv_2\"",
            "重试必须用重读后的新 ETag: {puts:?}"
        );
        assert_eq!(
            puts[0].1, puts[1].1,
            "412 重试属于同一次业务写入, 必须复用原幂等键"
        );
        assert_eq!(
            fake.borrow().value.as_deref(),
            Some(&br#"{"revision":2}"#[..])
        );
        testhost::clear();
    }

    #[test]
    fn load_state_with_retry_three_states() {
        // ① 有值 → loaded, 不睡
        let fake = Rc::new(RefCell::new(FakeHost::default()));
        fake.borrow_mut().value = Some(br#"{"revision":3}"#.to_vec());
        fake.borrow_mut().revision = 3;
        install(&fake);
        let _ = clock::testhooks::take_sleeps();
        let (raw, result) = load_state_with_retry();
        assert_eq!(result, LoadResult::Loaded);
        assert_eq!(raw.as_deref(), Some(&br#"{"revision":3}"#[..]));
        assert!(clock::testhooks::take_sleeps().is_empty(), "成功路径不该睡");
        testhost::clear();

        // ② 两次 404 → fresh, 中间只睡 300ms
        let fake = Rc::new(RefCell::new(FakeHost::default()));
        install(&fake);
        let _ = clock::testhooks::take_sleeps();
        let (raw, result) = load_state_with_retry();
        assert_eq!(result, LoadResult::Fresh);
        assert!(raw.is_none());
        assert_eq!(
            clock::testhooks::take_sleeps(),
            vec![300],
            "404 需间隔 300ms 两次确认"
        );
        testhost::clear();

        // ③ 宿主持续不可读 → unavailable, 3 次尝试各睡 200ms
        let _ = clock::testhooks::take_sleeps();
        let (raw, result) = load_state_with_retry();
        assert_eq!(result, LoadResult::Unavailable);
        assert!(raw.is_none());
        assert_eq!(clock::testhooks::take_sleeps(), vec![200, 200, 200]);
    }
}
