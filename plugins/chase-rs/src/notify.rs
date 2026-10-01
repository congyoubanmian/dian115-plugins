//! TG 日报: 文案组装 + 当日去重 + 宿主响应解析。
//!
//! # 契约
//!
//! `POST /api/notifications/plugin`(openapi-v1.yaml:2624-2659), body 是
//! `PluginNotificationRequest{level,title,body,image_url?,buttons?,job_ref?,dedupe_key?}`
//! (schema 6927-6966)。三条硬约束:
//!
//! 1. `title` ≤160 字符、`body` ≤2000 字符(都按 UTF-8 边界截断);
//! 2. **不带 buttons** —— `buttons[].url` 必填且 `^https://`, 带按钮只会在宿主那里 400;
//! 3. 带 `dedupe_key = "chase-daily-<d>"`, 同一自然日只成功记一次账
//!    (`daily.last_sent_date`)。
//!
//! 响应侧 `NotificationEnvelope.data` 是
//! `{event, accepted, deduplicated, suppressed, suppression_reason}`(6641-6659):
//! - `accepted` / `deduplicated` ⇒ 记日期(宿主已有当日记录);
//! - `suppressed` ⇒ **不**记日期, 下一小时重试并记 `suppression_reason`;
//! - HTTP ≥400 或解析失败 ⇒ 不记日期 + `last_error`。

use serde::Serialize;

use crate::host;
use crate::model::{AlignItem, CalendarItem, DailyState, ReportSettings};
use crate::raw;

/// 通知端点路径。
pub const PATH: &str = "/api/notifications/plugin";
/// 标题字节上限(宿主 schema `maxLength: 160`)。
pub const TITLE_MAX: usize = 160;
/// 正文字节上限(宿主 schema `maxLength: 2000`)。
pub const BODY_MAX: usize = 2000;
/// 日报去重键前缀。
pub const DEDUPE_PREFIX: &str = "chase-daily-";
/// 正文里"今日播出"最多几条。
pub const TODAY_MAX: usize = 15;
/// 正文里"本次补订"最多几条。
pub const PATCHED_MAX: usize = 15;

/// 宿主通知响应里的业务结论。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NotifyOutcome {
    pub accepted: bool,
    pub deduplicated: bool,
    pub suppressed: bool,
    pub suppression_reason: String,
}

impl NotifyOutcome {
    /// 这次发送是否应该记进 `daily.last_sent_date`。
    pub fn records_date(&self) -> bool {
        self.accepted || self.deduplicated
    }
}

/// 日报请求体(`PluginNotificationRequest` 的子集; 刻意不带 buttons)。
#[derive(Debug, Serialize)]
struct NotifyBody<'a> {
    level: &'a str,
    title: &'a str,
    body: &'a str,
    dedupe_key: &'a str,
}

/// 组装请求体。
pub fn request_body(level: &str, title: &str, body: &str, dedupe_key: &str) -> Vec<u8> {
    let title = raw::truncate_bytes(title, TITLE_MAX);
    let body = raw::truncate_bytes(body, BODY_MAX);
    serde_json::to_vec(&NotifyBody { level, title, body, dedupe_key }).unwrap_or_default()
}

/// 去重键。
pub fn dedupe_key(date: &str) -> String {
    format!("{DEDUPE_PREFIX}{date}")
}

/// 是否到了该发日报的时刻。
///
/// 三个条件缺一不可: 开关打开、本地日期与上次成功日不同、本地小时 >= 配置小时。
pub fn should_send(report: &ReportSettings, last_sent_date: &str, today: &str, hour: u8) -> bool {
    report.enabled && !today.is_empty() && last_sent_date != today && hour >= report.hour
}

/// 组装日报(标题 + 正文)。
///
/// 段①今日播出、段②本次补订、段③跳过/失败计数与首个原因。
pub fn compose(
    today: &str,
    today_items: &[CalendarItem],
    patched: &[AlignItem],
    skipped: u32,
    failed: u32,
    first_reason: &str,
) -> (String, String) {
    let title = format!(
        "追剧管家 {today}: 补订 {} 条",
        patched.iter().filter(|item| item.action == crate::align::ACTION_PATCHED).count()
    );

    let mut body = String::new();
    body.push_str(&format!("① 今日播出({})\n", today_items.len()));
    if today_items.is_empty() {
        body.push_str("  今日没有订阅剧集更新\n");
    }
    for item in today_items.iter().take(TODAY_MAX) {
        let title = if item.title.is_empty() { "未命名" } else { item.title.as_str() };
        let clock = if item.time.is_empty() { "--:--" } else { item.time.as_str() };
        body.push_str(&format!(
            "  {clock} {title} S{}E{}\n",
            item.season, item.episode
        ));
    }
    if today_items.len() > TODAY_MAX {
        body.push_str(&format!("  …另有 {} 条\n", today_items.len() - TODAY_MAX));
    }

    let patched_items: Vec<&AlignItem> = patched
        .iter()
        .filter(|item| {
            item.action == crate::align::ACTION_PATCHED || item.action == crate::align::ACTION_DRY_RUN
        })
        .collect();
    let dry_run = patched_items.iter().any(|item| item.action == crate::align::ACTION_DRY_RUN);
    body.push_str(&format!(
        "② 本次补订({}){}\n",
        patched_items.len(),
        if dry_run { " [dry-run 未写入]" } else { "" }
    ));
    if patched_items.is_empty() {
        body.push_str("  本轮没有需要补订的条目\n");
    }
    for item in patched_items.iter().take(PATCHED_MAX) {
        let title = if item.title.is_empty() { "未命名" } else { item.title.as_str() };
        body.push_str(&format!(
            "  {title} S{}: {} → {}\n",
            item.season, item.from_total, item.to_total
        ));
    }
    if patched_items.len() > PATCHED_MAX {
        body.push_str(&format!("  …另有 {} 条\n", patched_items.len() - PATCHED_MAX));
    }

    body.push_str(&format!("③ 跳过 {skipped} 条, 失败 {failed} 条\n"));
    if !first_reason.is_empty() {
        body.push_str(&format!("  首个原因: {first_reason}\n"));
    }

    (raw::truncate_bytes(&title, TITLE_MAX).to_string(), raw::truncate_bytes(&body, BODY_MAX).to_string())
}

/// 解析宿主通知响应。
pub fn parse_result(status: i32, raw_bytes: &[u8]) -> Result<NotifyOutcome, String> {
    if status >= 400 {
        let excerpt = raw::truncate_bytes(&String::from_utf8_lossy(raw_bytes), 200).to_string();
        return Err(format!("通知 HTTP {status}: {excerpt}"));
    }
    let value = raw::decode_json(raw_bytes)?;
    let obj = value
        .as_object()
        .ok_or_else(|| "通知响应不是对象".to_string())?;
    let data = raw::descend(&value, &["data"]).and_then(|inner| inner.as_object()).unwrap_or(obj);
    Ok(NotifyOutcome {
        accepted: raw::first_bool(data, &["accepted"]),
        deduplicated: raw::first_bool(data, &["deduplicated"]),
        suppressed: raw::first_bool(data, &["suppressed"]),
        suppression_reason: raw::first_string(data, &["suppression_reason"]).unwrap_or_default(),
    })
}

/// 发送一次日报。
///
/// 幂等键 = `chase-notify-<date>-<run_seq>`(同一次发送重试复用同值)。
pub fn send(
    level: &str,
    title: &str,
    body: &str,
    date: &str,
    run_seq: u64,
) -> Result<(NotifyOutcome, i32), String> {
    let key = format!("chase-notify-{date}-{run_seq}");
    let payload = request_body(level, title, body, &dedupe_key(date));
    let response = host::send(
        "POST",
        PATH,
        Some(&payload),
        &[("accept", "application/json"), ("idempotency-key", &key)],
    )
    .map_err(|err| format!("通知请求失败: {err}"))?;
    let outcome = parse_result(response.status, &response.raw)?;
    Ok((outcome, response.status))
}

/// 按宿主结论更新 `daily` 账本。
///
/// 只有 accepted / deduplicated 才记 `last_sent_date`; suppressed 留到下一小时重试。
pub fn apply_outcome(daily: &mut DailyState, date: &str, outcome: &NotifyOutcome, at: &str) {
    daily.last_at = at.to_string();
    if outcome.accepted || outcome.deduplicated {
        daily.last_sent_date = date.to_string();
        daily.sent_total = daily.sent_total.saturating_add(1);
        daily.last_result =
            if outcome.accepted { "accepted" } else { "deduplicated" }.to_string();
        daily.last_error.clear();
        return;
    }
    if outcome.suppressed {
        daily.last_result = "suppressed".to_string();
        daily.last_error = raw::truncate_bytes(&outcome.suppression_reason, 200).to_string();
        return;
    }
    daily.last_result = "failed".to_string();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::FakeHost;

    fn item(season: i64, episode: i64, title: &str, time: &str) -> CalendarItem {
        CalendarItem {
            tmdb_id: 1,
            season,
            episode,
            title: title.to_string(),
            time: time.to_string(),
        }
    }

    fn align_item(id: i64, title: &str, from: i64, to: i64, action: &str) -> AlignItem {
        AlignItem {
            intent_id: id,
            tmdb_id: 1,
            season: 1,
            title: title.to_string(),
            total_known: from,
            emby_have_max: to,
            emby_have_count: to,
            gap_max: to,
            from_total: from,
            to_total: to,
            action: action.to_string(),
            reason: String::new(),
            at: String::new(),
        }
    }

    #[test]
    fn compose_contains_all_three_sections() {
        let today = vec![item(1, 3, "权力的游戏", "20:00")];
        let patched = vec![
            align_item(7, "绝命毒师", 10, 13, crate::align::ACTION_PATCHED),
            align_item(8, "某剧", 5, 5, crate::align::ACTION_SKIPPED),
        ];
        let (title, body) = compose("2026-10-01", &today, &patched, 4, 1, "Emby 覆盖解析失败");

        assert!(title.starts_with("追剧管家 2026-10-01"), "{title}");
        assert!(title.len() <= TITLE_MAX);
        assert!(body.contains("① 今日播出(1)"), "{body}");
        assert!(body.contains("20:00 权力的游戏 S1E3"), "{body}");
        assert!(body.contains("② 本次补订(1)"), "{body}");
        assert!(body.contains("绝命毒师 S1: 10 → 13"), "{body}");
        assert!(body.contains("③ 跳过 4 条, 失败 1 条"), "{body}");
        assert!(body.contains("Emby 覆盖解析失败"), "{body}");
        assert!(!body.contains("某剧"), "skipped 不该出现在补订段");
        assert!(body.len() <= BODY_MAX);
    }

    #[test]
    fn compose_handles_empty_rounds_and_dry_run() {
        let (title, body) = compose("2026-10-01", &[], &[], 0, 0, "");
        assert_eq!(title, "追剧管家 2026-10-01: 补订 0 条");
        assert!(body.contains("今日没有订阅剧集更新"), "{body}");
        assert!(body.contains("本轮没有需要补订的条目"), "{body}");
        assert!(!body.contains("首个原因"), "{body}");

        let dry = vec![align_item(1, "某剧", 1, 2, crate::align::ACTION_DRY_RUN)];
        let (_, body) = compose("2026-10-01", &[], &dry, 0, 0, "");
        assert!(body.contains("dry-run"), "{body}");
    }

    #[test]
    fn compose_truncates_at_utf8_boundaries() {
        let today: Vec<CalendarItem> =
            (1..=20).map(|index| item(1, index, "很长的剧名在此重复", "08:00")).collect();
        let patched: Vec<AlignItem> = (1..=20)
            .map(|index| align_item(index, "另一部非常长的剧名", 1, 2, crate::align::ACTION_PATCHED))
            .collect();
        let (title, body) = compose("2026-10-01", &today, &patched, 99, 88, &"原因".repeat(200));
        assert!(title.len() <= TITLE_MAX);
        assert!(body.len() <= BODY_MAX, "实际 {} 字节", body.len());
        assert!(std::str::from_utf8(body.as_bytes()).is_ok());
        assert!(body.contains("…另有"), "超出上限要有省略提示");
    }

    #[test]
    fn request_body_has_no_buttons_and_carries_dedupe_key() {
        let payload = request_body("info", "标题", "正文", "chase-daily-2026-10-01");
        let text = String::from_utf8(payload).unwrap();
        assert!(!text.contains("buttons"), "{text}");
        assert!(!text.contains("image_url"), "{text}");
        assert!(text.contains(r#""dedupe_key":"chase-daily-2026-10-01""#), "{text}");
        assert!(text.contains(r#""level":"info""#), "{text}");
    }

    #[test]
    fn send_posts_with_idempotency_key_and_parses_outcome() {
        let fake = FakeHost::new();
        fake.route(
            "POST",
            PATH,
            200,
            br#"{"data":{"event":"plugin_notification","accepted":true},"meta":{}}"#,
        );
        let guard = fake.install();
        let (outcome, status) = send("info", "标题", "正文", "2026-10-01", 3).unwrap();
        assert_eq!(status, 200);
        assert!(outcome.accepted);
        assert!(outcome.records_date());

        let requests = fake.requests();
        let post = &requests[0];
        assert_eq!(post.method, "POST");
        let key = post.headers.get("idempotency-key").cloned().unwrap_or_default();
        assert_eq!(key, "chase-notify-2026-10-01-3");
        assert!((16..=128).contains(&key.len()));
        assert!(key.bytes().all(|b| b.is_ascii_graphic()));
        // body 里必须带 dedupe_key(宿主按它做当日去重)
        let body = crate::host::decode_response_body(&crate::host::HostCallResponse {
            status: 200,
            headers: Default::default(),
            body_base64: post.body_base64.clone(),
        })
        .unwrap();
        assert!(String::from_utf8_lossy(&body).contains("chase-daily-2026-10-01"));
        drop(guard);
    }

    #[test]
    fn parse_result_covers_host_verdicts() {
        let accepted = parse_result(
            200,
            br#"{"data":{"event":"plugin_notification","accepted":true,"deduplicated":false}}"#,
        )
        .unwrap();
        assert!(accepted.accepted && !accepted.suppressed);

        let deduplicated = parse_result(
            202,
            br#"{"data":{"event":"plugin_notification","accepted":false,"deduplicated":true}}"#,
        )
        .unwrap();
        assert!(deduplicated.records_date(), "宿主已有当日记录 → 同样记日期");

        let suppressed = parse_result(
            200,
            br#"{"data":{"event":"plugin_notification","accepted":false,"suppressed":true,"suppression_reason":"quiet_hours"}}"#,
        )
        .unwrap();
        assert!(suppressed.suppressed);
        assert!(!suppressed.records_date(), "suppressed 必须留给下一小时重试");
        assert_eq!(suppressed.suppression_reason, "quiet_hours");

        // 扁平形态(没有 data 信封)也认
        let flat = parse_result(200, br#"{"accepted":true}"#).unwrap();
        assert!(flat.accepted);

        // HTTP 失败 / 非法 JSON
        assert!(parse_result(500, b"boom").unwrap_err().contains("HTTP 500"));
        assert!(parse_result(200, b"<html>").is_err());
    }

    #[test]
    fn apply_outcome_records_only_success_days() {
        let mut daily = DailyState::default();
        apply_outcome(
            &mut daily,
            "2026-10-01",
            &NotifyOutcome { accepted: true, ..Default::default() },
            "2026-10-01T09:00:00Z",
        );
        assert_eq!(daily.last_sent_date, "2026-10-01");
        assert_eq!(daily.last_result, "accepted");
        assert_eq!(daily.sent_total, 1);

        // suppressed: 不记日期, 记原因
        let mut daily = DailyState::default();
        apply_outcome(
            &mut daily,
            "2026-10-02",
            &NotifyOutcome {
                suppressed: true,
                suppression_reason: "quiet_hours".to_string(),
                ..Default::default()
            },
            "2026-10-02T09:00:00Z",
        );
        assert_eq!(daily.last_sent_date, "", "suppressed 不记日期");
        assert_eq!(daily.last_result, "suppressed");
        assert_eq!(daily.last_error, "quiet_hours");

        // 全 false(既没接受也没抑制)算失败
        let mut daily = DailyState::default();
        apply_outcome(&mut daily, "2026-10-03", &NotifyOutcome::default(), "at");
        assert_eq!(daily.last_result, "failed");
        assert_eq!(daily.last_sent_date, "");
    }

    #[test]
    fn should_send_respects_switch_date_and_hour() {
        let mut report = ReportSettings::default();
        report.enabled = true;
        report.hour = 9;
        assert!(should_send(&report, "", "2026-10-01", 9));
        assert!(should_send(&report, "", "2026-10-01", 23));
        assert!(!should_send(&report, "", "2026-10-01", 8), "没到点");
        assert!(!should_send(&report, "2026-10-01", "2026-10-01", 9), "当天已发过");
        assert!(should_send(&report, "2026-09-30", "2026-10-01", 9), "新的一天可以再发");
        report.enabled = false;
        assert!(!should_send(&report, "", "2026-10-01", 12));
        assert!(!should_send(&report, "", "", 12), "日期为空(时钟异常)不发");
    }

    #[test]
    fn dedupe_key_is_stable_per_day() {
        assert_eq!(dedupe_key("2026-10-01"), "chase-daily-2026-10-01");
        assert_ne!(dedupe_key("2026-10-01"), dedupe_key("2026-10-02"));
    }

    // ── 补: 文案边界 / 宿主结论分类 / 发送键 ──

    #[test]
    fn compose_title_counts_real_patches_only() {
        let dry = vec![align_item(1, "某剧", 1, 2, crate::align::ACTION_DRY_RUN)];
        let (title, body) = compose("2026-10-01", &[], &dry, 0, 0, "");
        assert_eq!(title, "追剧管家 2026-10-01: 补订 0 条", "dry-run 不算真补订");
        assert!(body.contains("② 本次补订(1) [dry-run 未写入]"), "{body}");
        assert!(!body.contains("① 今日播出(1)"), "{body}");
    }

    #[test]
    fn request_body_stays_under_host_limits_for_huge_cjk_text() {
        let payload = request_body("info", &"追".repeat(500), &"剧".repeat(5000), "chase-daily-2026-10-01");
        let parsed: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        let title = parsed["title"].as_str().unwrap();
        let body = parsed["body"].as_str().unwrap();
        assert!(title.len() <= TITLE_MAX, "标题 {} 字节", title.len());
        assert!(body.len() <= BODY_MAX, "正文 {} 字节", body.len());
        // 截断必须落在 UTF-8 边界: 再解析一次仍然成功, 且没有替换字符
        assert!(!title.contains('\u{FFFD}') && !body.contains('\u{FFFD}'));
        assert!(parsed.get("buttons").is_none(), "宿主 schema 要求 buttons[].url, 一律不带");
        assert!(parsed.get("image_url").is_none());
    }

    #[test]
    fn parse_result_reports_http_errors_with_excerpt() {
        let err = parse_result(400, br#"{"error":"buttons[].url is required"}"#).unwrap_err();
        assert!(err.contains("400"), "{err}");
        assert!(err.contains("buttons"), "{err}");
        assert!(parse_result(500, b"").is_err(), "空 body 的 500 也不能 panic");
        assert!(parse_result(200, b"[1,2]").is_err(), "非对象响应判为解析失败");
        assert!(parse_result(200, b"").is_err());
    }

    #[test]
    fn apply_outcome_records_deduplicated_as_a_sent_day() {
        let mut daily = DailyState { last_error: "上一轮的旧错误".into(), ..Default::default() };
        apply_outcome(
            &mut daily,
            "2026-10-01",
            &NotifyOutcome { deduplicated: true, ..Default::default() },
            "2026-10-01T09:00:00Z",
        );
        assert_eq!(daily.last_sent_date, "2026-10-01", "宿主已有当日记录 → 同样记日期");
        assert_eq!(daily.last_result, "deduplicated");
        assert_eq!(daily.sent_total, 1);
        assert_eq!(daily.last_error, "", "这一轮成功了, 旧错误要清掉");
        assert_eq!(daily.last_at, "2026-10-01T09:00:00Z");
    }

    #[test]
    fn send_uses_one_idempotency_key_per_attempt_and_one_dedupe_key_per_day() {
        let fake = FakeHost::new();
        fake.route("POST", PATH, 200, br#"{"data":{"accepted":true}}"#);
        let guard = fake.install();
        let _ = send("info", "t", "b", "2026-10-01", 1).unwrap();
        let _ = send("info", "t", "b", "2026-10-01", 2).unwrap();
        let keys: Vec<String> = fake
            .requests()
            .iter()
            .map(|request| request.headers.get("idempotency-key").cloned().unwrap_or_default())
            .collect();
        assert_eq!(keys, vec!["chase-notify-2026-10-01-1", "chase-notify-2026-10-01-2"]);
        let bodies: Vec<String> = fake
            .requests()
            .iter()
            .map(|request| {
                String::from_utf8_lossy(
                    &crate::host::decode_response_body(&crate::host::HostCallResponse {
                        status: 200,
                        headers: Default::default(),
                        body_base64: request.body_base64.clone(),
                    })
                    .unwrap(),
                )
                .into_owned()
            })
            .collect();
        assert!(bodies.iter().all(|body| body.contains(r#""dedupe_key":"chase-daily-2026-10-01""#)));
        drop(guard);
    }

    #[test]
    fn should_send_is_false_without_a_configured_hour_or_date() {
        let mut report = ReportSettings::default();
        assert!(!report.enabled);
        assert_eq!(report.hour, 9);
        assert_eq!(report.tz_offset_minutes, 480);
        report.enabled = true;
        assert!(!should_send(&report, "", "", 23), "本地日期为空(时钟异常)不发");
        report.hour = 0;
        assert!(should_send(&report, "", "2026-10-01", 0));
    }
}
