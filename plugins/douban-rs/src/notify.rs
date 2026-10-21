//! 订阅通知: `POST /api/notifications/plugin`(host-call-v2.md §2.4)。
//!
//! 宿主会把通知投递到所有已配置通道; 响应里的 `channels` 只描述各通道保留了
//! 什么, 不代表已送达。这里只做最小实现: level/title/body + dedupe_key,
//! 不发按钮(当前 OpenAPI 的 buttons 仍只允许 `{text,url}`, callback_data 不可用)。

use serde::Serialize;
use serde_json::Value;

use crate::host::{self, HostCallRequest};
use crate::store;
use crate::util;

/// 通知端点。
pub const PATH: &str = "/api/notifications/plugin";
/// 标题字符上限(openapi `maxLength: 160`)。
pub const TITLE_MAX: usize = 160;
/// 正文字符上限(openapi `maxLength: 2000`)。
pub const BODY_MAX: usize = 2000;

/// 宿主通知响应里的业务结论。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NotifyOutcome {
    pub accepted: bool,
    pub deduplicated: bool,
    pub channels: Vec<String>,
}

impl NotifyOutcome {
    pub fn recorded(&self) -> bool {
        self.accepted || self.deduplicated
    }
}

#[derive(Debug, Serialize)]
struct NotifyBody<'a> {
    level: &'a str,
    title: &'a str,
    body: &'a str,
    dedupe_key: &'a str,
}

/// JSON Schema 的 `maxLength` 按 Unicode 字符计数, 不能按 UTF-8 字节截断。
fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        value.to_string()
    } else {
        value.chars().take(max).collect()
    }
}

/// 组装请求体(测试与发送共用)。
pub fn request_body(level: &str, title: &str, body: &str, dedupe_key: &str) -> Vec<u8> {
    let title = truncate_chars(title, TITLE_MAX);
    let body = truncate_chars(body, BODY_MAX);
    serde_json::to_vec(&NotifyBody {
        level,
        title: title.as_str(),
        body: body.as_str(),
        dedupe_key,
    })
    .unwrap_or_default()
}

/// 解析宿主响应。
pub fn parse_outcome(raw_body: &[u8]) -> Result<NotifyOutcome, String> {
    let value: Value =
        serde_json::from_slice(raw_body).map_err(|err| format!("通知响应解析失败: {err}"))?;
    let data = value.get("data").unwrap_or(&value);
    let channels = data
        .get("channels")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("channel").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Ok(NotifyOutcome {
        accepted: data
            .get("accepted")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        deduplicated: data
            .get("deduplicated")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        channels,
    })
}

/// 发送一条通知。失败返回可读错误, 由调用方决定是否只记日志。
pub fn send(
    level: &str,
    title: &str,
    body: &str,
    dedupe_key: &str,
    idempotency_key: &str,
) -> Result<NotifyOutcome, String> {
    let payload = request_body(level, title, body, dedupe_key);
    let request = HostCallRequest::new("POST", PATH)
        .with_header("content-type", "application/json")
        .with_header("accept", "application/json")
        .with_header("idempotency-key", idempotency_key)
        .with_body_base64(host::encode_body_base64(&payload));
    let response = host::call(&request).map_err(|err| err.to_string())?;
    let raw_body = store::decode_body(&response).map_err(|err| err.0)?;
    if response.status >= 400 {
        return Err(format!(
            "通知 HTTP {}: {}",
            response.status,
            util::trunc(&raw_body)
        ));
    }
    parse_outcome(&raw_body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cookiecloud::test_support::{Route, TestHost};

    #[test]
    fn request_body_truncates_by_chars_and_keeps_dedupe_key() {
        let payload = request_body(
            "success",
            &"标".repeat(500),
            &"文".repeat(5000),
            "douban-sub-41",
        );
        let value: Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(value["title"].as_str().unwrap().chars().count(), TITLE_MAX);
        assert_eq!(value["body"].as_str().unwrap().chars().count(), BODY_MAX);
        assert_eq!(value["dedupe_key"], "douban-sub-41");
        assert!(value.get("buttons").is_none());
    }

    #[test]
    fn send_sets_idempotency_and_parses_channels() {
        let host = TestHost::install(vec![Route::json(
            "POST",
            PATH,
            r#"{"data":{"accepted":true,"channels":[{"channel":"telegram","preserved":["images"]},{"channel":"wecom","dropped":["callback_buttons"]}]}}"#,
        )]);
        let outcome = send(
            "success",
            "订阅成功",
            "已创建订阅 #41",
            "douban-sub-41",
            "dc-notify-inv_1-41",
        )
        .unwrap();
        assert!(outcome.accepted);
        assert_eq!(outcome.channels, vec!["telegram", "wecom"]);
        let request = host
            .requests()
            .into_iter()
            .find(|r| r.method == "POST")
            .unwrap();
        assert_eq!(request.path, PATH);
        assert_eq!(
            request.headers.get("idempotency-key").map(String::as_str),
            Some("dc-notify-inv_1-41")
        );
        let body = store::decode_body(&host::HostCallResponse {
            status: 200,
            headers: Default::default(),
            body_base64: request.body_base64,
        })
        .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["dedupe_key"], "douban-sub-41");
    }

    #[test]
    fn send_reports_http_error_status() {
        let _host = TestHost::install(vec![Route::new(
            "POST",
            PATH,
            400,
            br#"{"error":"bad payload"}"#,
        )]);
        let err = send("success", "t", "b", "douban-sub-1", "dc-notify-inv_1-1").unwrap_err();
        assert!(err.contains("HTTP 400"), "{err}");
    }
}
