//! 聚合订阅意图池(`/api/subscribe/pool/intents`)的拉取与解析。
//!
//! # 契约
//!
//! `GET /api/subscribe/pool/intents?media_type=tv&limit=500&offset=N` 返回
//! `PoolIntentListResult{code, data:[PoolIntent], counts}`(openapi-v1.yaml:2489-2523,
//! schema 6620-6634)。`PoolIntent` 是强类型 schema(6548-6582), 但宿主版本差异与
//! 中间层曾出现过 `data` 不是数组的形态, 所以解析仍按防御式来:
//!
//! - 根可以是数组(裸列表)或对象; 对象里 `data` 优先, 再退 `items`/`records`/`list`;
//! - 每条的 `id` / `tmdb_id` / `total_episodes_known` 三个字段缺一不可(缺了就跳过该条,
//!   **不填 0 继续** —— 0 集订阅会让对齐器算出一个假的缺口);
//! - 数组非空但**一条都解不出来** ⇒ 判为形状不匹配(整轮跳过), 而不是"本轮没有订阅"。
//!
//! # 写方向
//!
//! 唯一的业务写是 [`patch_path`] 上的 PATCH, body 由 [`patch_body`] 生成:
//! 默认只写 `total_episodes`, `needed_episodes` / `covered_episodes` 只有
//! [`strict_roundtrip`] 逐字节往返一致时才可能被带上(PoolIntentEpisodesRequest
//! 三字段全可选且 `minProperties: 1`, 见 openapi-v1.yaml:6604-6611)。

use serde::Serialize;

use crate::host;
use crate::raw::{self, ParseFailure};

/// 单页最大条数(schema 上限)。
pub const LIMIT_MAX: u32 = 500;
/// 一轮最多读几页(2000 条)。
pub const PAGES_MAX: u32 = 4;
/// 只有 `media_type=tv` 参与对齐。
pub const MEDIA_TYPE: &str = "tv";

/// 订阅池里的一条 tv 订阅(只保留对齐用得到的字段)。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Intent {
    pub id: i64,
    pub tmdb_id: i64,
    pub season: i64,
    pub title: String,
    pub total_known: i64,
    pub state: String,
    pub media_type: String,
    /// 原始 JSON 数组字符串(默认不写回)。
    pub needed_episodes: Option<String>,
    pub covered_episodes: Option<String>,
}

impl Intent {
    /// 该条是否可参与增方向对齐(`expired` / `failed` 只计数, 不写)。
    pub fn actionable(&self) -> bool {
        !matches!(self.state.as_str(), "expired" | "failed")
    }

    /// 减方向建议只在"已追平/已落地"的状态上给。
    pub fn trim_candidate(&self) -> bool {
        matches!(self.state.as_str(), "caught_up" | "landed")
    }
}

/// 一页的解析结果。
#[derive(Debug, Clone, Default)]
pub struct IntentPage {
    pub items: Vec<Intent>,
    /// 数组里被跳过的畸形条目数(结构在, 但关键字段缺失/类型不符)。
    pub skipped: usize,
}

/// 一次成功读取: 解析结果 + HTTP 状态(留档用)。
#[derive(Debug, Clone)]
pub struct FetchedPage {
    pub page: IntentPage,
    pub http_status: i32,
}

/// 列表请求路径。
pub fn list_path(limit: u32, offset: u32) -> String {
    format!(
        "/api/subscribe/pool/intents?media_type={MEDIA_TYPE}&limit={}&offset={}",
        limit.min(LIMIT_MAX),
        offset
    )
}

/// 拉一页订阅池。
pub fn fetch_page(limit: u32, offset: u32) -> Result<FetchedPage, ParseFailure> {
    let response = host::get(&list_path(limit, offset))
        .map_err(|err| ParseFailure::transport(format!("订阅池请求失败: {err}")))?;
    if response.status >= 400 {
        return Err(ParseFailure::http(
            response.status,
            response.raw.clone(),
            format!("订阅池 HTTP {}", response.status),
        ));
    }
    match parse_list(&response.raw) {
        Ok(page) => Ok(FetchedPage { page, http_status: response.status }),
        Err(message) => Err(ParseFailure::http(response.status, response.raw.clone(), message)),
    }
}

/// 解析一页订阅池(信封 + 逐条)。
pub fn parse_list(raw: &[u8]) -> Result<IntentPage, String> {
    let value = raw::decode_json(raw)?;
    let array = match &value {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(map) => {
            // `code` 存在时必须是 ok: 宿主用非 ok 表示业务失败, 不能当成空列表
            if let Some(code) = map.get("code").and_then(|code| code.as_str()) {
                if code != "ok" {
                    return Err(format!("宿主返回 code={code}"));
                }
            }
            match raw::first_of(map, &["data", "items", "records", "list"]) {
                Some(serde_json::Value::Array(items)) => items,
                Some(serde_json::Value::Object(inner)) => {
                    match raw::first_of(inner, &["items", "records", "list"]) {
                        Some(serde_json::Value::Array(items)) => items,
                        _ => return Err("订阅池列表结构未识别: data 不是数组".to_string()),
                    }
                }
                _ => return Err("订阅池列表结构未识别: 缺少 data 数组".to_string()),
            }
        }
        _ => return Err("订阅池响应不是对象或数组".to_string()),
    };

    let mut page = IntentPage::default();
    for element in array {
        match parse_intent(element) {
            Some(intent) => page.items.push(intent),
            None => page.skipped += 1,
        }
    }
    // 非空数组却一条都解不出来 ⇒ 形状不匹配(而不是"本轮没有订阅")
    if page.items.is_empty() && page.skipped > 0 {
        return Err(format!("订阅池 {} 条条目全部缺少关键字段", page.skipped));
    }
    Ok(page)
}

/// 解析单条; 关键字段(id / tmdb_id / total_episodes_known)缺失即 `None`。
pub fn parse_intent(element: &serde_json::Value) -> Option<Intent> {
    let obj = element.as_object()?;
    let id = raw::first_i64(obj, &["id", "intent_id"])?;
    let tmdb_id = raw::first_i64(obj, &["tmdb_id", "tmdbId"])?;
    let total_known = raw::first_i64(obj, &["total_episodes_known", "total_episodes"])?;
    let media_type = raw::first_string(obj, &["media_type"]).unwrap_or_else(|| MEDIA_TYPE.to_string());
    let season = raw::first_i64(obj, &["season"]).unwrap_or(0);
    let title = raw::first_string(obj, &["title", "name"]).unwrap_or_default();
    let state = raw::first_string(obj, &["state"]).unwrap_or_default();
    let needed = raw::first_string(obj, &["needed_episodes"]).filter(|text| !text.is_empty());
    let covered = raw::first_string(obj, &["covered_episodes"]).filter(|text| !text.is_empty());
    Some(Intent {
        id,
        tmdb_id,
        season: season.max(0),
        title: raw::truncate_bytes(&title, 160).to_string(),
        total_known: total_known.max(0),
        state,
        media_type,
        needed_episodes: needed,
        covered_episodes: covered,
    })
}

// ─────────────────────────── 写方向 ───────────────────────────

/// PATCH 的路径。
pub fn patch_path(id: i64) -> String {
    format!("/api/subscribe/pool/intents/{id}/episodes")
}

/// 幂等键: `chase-patch-<intent_id>-<from>-<to>-<run_seq>`(同一业务重试复用同值)。
///
/// 键里带 from→to: 即使跨 worker 会话撞上 24 小时内的旧记录, 也是同一条业务写
/// (宿主按幂等键返回上次结果), 不会把两次不同的抬升混在一起。
pub fn patch_idempotency_key(intent_id: i64, from_total: i64, to_total: i64, run_seq: u64) -> String {
    format!("chase-patch-{intent_id}-{from_total}-{to_total}-{run_seq}")
}

/// PATCH 请求体。
#[derive(Debug, Serialize)]
struct PatchBody<'a> {
    total_episodes: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    needed_episodes: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    covered_episodes: Option<&'a str>,
}

/// 组装 PATCH body: 只写 `total_episodes`; 两个集数字符串仅在
/// [`strict_roundtrip`] 通过且调用方显式开启时才带上。
pub fn patch_body(new_total: i64, needed: Option<&str>, covered: Option<&str>) -> Vec<u8> {
    // 先绑成局部变量: `and_then` 产出的 `Option<String>` 是临时值, 直接
    // 接 `.as_deref()` 会借到已析构的临时量(E0716)。
    let needed = needed.and_then(strict_roundtrip);
    let covered = covered.and_then(strict_roundtrip);
    let body = PatchBody {
        total_episodes: new_total,
        needed_episodes: needed.as_deref(),
        covered_episodes: covered.as_deref(),
    };
    serde_json::to_vec(&body).unwrap_or_else(|_| format!(r#"{{"total_episodes":{new_total}}}"#).into_bytes())
}

/// 原串能否被严格解析并**逐字节往返一致**(否则绝不写回, 免得把用户的集数表达式改坏)。
pub fn strict_roundtrip(text: &str) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let encoded = serde_json::to_string(&value).ok()?;
    if encoded == text {
        Some(text.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::FakeHost;
    use serde_json::json;

    /// 强类型 schema 形态(`PoolIntentListResult`)。
    fn strong_fixture() -> Vec<u8> {
        r#"{
          "code": "ok",
          "data": [
            {
              "id": 41, "tmdb_id": 1396, "season": 5, "media_type": "tv",
              "title": "绝命毒师", "total_episodes_known": 13, "state": "partial",
              "needed_episodes": "[11,12,13]", "covered_episodes": "[1,2,3]"
            },
            {
              "id": 42, "tmdb_id": 1399, "season": 1, "media_type": "tv",
              "title": "权力的游戏", "total_episodes_known": 10, "state": "landed",
              "needed_episodes": "", "covered_episodes": ""
            }
          ],
          "counts": {"partial": 1, "landed": 1}
        }"#.as_bytes()
        .to_vec()
    }

    /// 宽松形态: 数字是字符串、键名换了候选、外层多包了一层。
    fn loose_fixture() -> Vec<u8> {
        r#"{
          "data": {"items": [
            {"intent_id": "7", "tmdbId": "1396", "season": "5", "name": "绝命毒师",
             "total_episodes": "13", "state": "caught_up"}
          ]}
        }"#.as_bytes()
        .to_vec()
    }

    /// 裸数组形态(没有信封)。
    fn bare_fixture() -> Vec<u8> {
        br#"[{"id": 9, "tmdb_id": 99, "season": 1, "total_episodes_known": 8, "state": "pending"}]"#
            .to_vec()
    }

    #[test]
    fn parses_strong_typed_payload() {
        let page = parse_list(&strong_fixture()).unwrap();
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.skipped, 0);
        let first = &page.items[0];
        assert_eq!(first.id, 41);
        assert_eq!(first.tmdb_id, 1396);
        assert_eq!(first.season, 5);
        assert_eq!(first.title, "绝命毒师");
        assert_eq!(first.total_known, 13);
        assert_eq!(first.state, "partial");
        assert!(first.actionable());
        assert!(first.needed_episodes.is_some());
        assert!(page.items[1].trim_candidate());
    }

    #[test]
    fn parses_loose_and_bare_envelopes() {
        let loose = parse_list(&loose_fixture()).unwrap();
        assert_eq!(loose.items.len(), 1);
        assert_eq!(loose.items[0].id, 7);
        assert_eq!(loose.items[0].tmdb_id, 1396);
        assert_eq!(loose.items[0].total_known, 13);
        assert_eq!(loose.items[0].media_type, "tv", "缺 media_type 按 tv 处理(请求已按 tv 过滤)");

        let bare = parse_list(&bare_fixture()).unwrap();
        assert_eq!(bare.items.len(), 1);
        assert_eq!(bare.items[0].id, 9);
    }

    #[test]
    fn unparsable_shapes_are_reported_not_defaulted() {
        // data 不是数组
        assert!(parse_list(br#"{"code":"ok","data":{"nope":1}}"#).is_err());
        // 完全没有列表
        assert!(parse_list(br#"{"code":"ok"}"#).is_err());
        // 非 JSON / 标量
        assert!(parse_list(b"<html>502</html>").is_err());
        assert!(parse_list(b"null").is_err());
        assert!(parse_list(b"").is_err());
        // 业务失败码
        let err = parse_list(br#"{"code":"error","data":[]}"#).unwrap_err();
        assert!(err.contains("code=error"), "{err}");
        // 非空数组但一条都解不出来 → 形状不匹配
        let err = parse_list(br#"[{"foo":1},{"bar":2}]"#).unwrap_err();
        assert!(err.contains("全部缺少关键字段"), "{err}");
    }

    #[test]
    fn malformed_items_are_skipped_without_faking_zeros() {
        let raw = br#"{
          "code": "ok",
          "data": [
            {"id": 1, "tmdb_id": 2, "total_episodes_known": 3},
            {"id": 4, "tmdb_id": 5},
            {"tmdb_id": 6, "total_episodes_known": 7},
            "not an object"
          ]
        }"#;
        let page = parse_list(raw).unwrap();
        assert_eq!(page.items.len(), 1, "只有完整的一条能被收下");
        assert_eq!(page.skipped, 3);
    }

    #[test]
    fn empty_list_is_a_valid_empty_page() {
        let page = parse_list(br#"{"code":"ok","data":[],"counts":{}}"#).unwrap();
        assert!(page.items.is_empty());
        assert_eq!(page.skipped, 0);
        // data.items[] 也认
        let page = parse_list(br#"{"code":"ok","data":{"items":[]}}"#).unwrap();
        assert!(page.items.is_empty());
    }

    #[test]
    fn list_path_is_bounded_and_filters_tv() {
        assert_eq!(
            list_path(500, 1000),
            "/api/subscribe/pool/intents?media_type=tv&limit=500&offset=1000"
        );
        assert!(list_path(9999, 0).contains("limit=500"), "limit 夹取到 schema 上限");
    }

    #[test]
    fn fetch_page_reads_http_and_reports_failures_with_raw() {
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, &strong_fixture());
        let guard = fake.install();
        let fetched = fetch_page(500, 0).unwrap();
        assert_eq!(fetched.http_status, 200);
        assert_eq!(fetched.page.items.len(), 2);
        assert!(fake.business_paths()[0].contains("media_type=tv"));
        drop(guard);

        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 500, b"boom");
        let guard = fake.install();
        let failure = fetch_page(500, 0).unwrap_err();
        assert_eq!(failure.http_status, 500);
        assert_eq!(failure.raw, b"boom");
        assert!(failure.sample().contains("boom"));
        drop(guard);

        // 传输层失败(宿主不可用)也必须带可读原因, 不是空 panic
        let fake = FakeHost::new();
        fake.fail_all(true);
        let guard = fake.install();
        let failure = fetch_page(500, 0).unwrap_err();
        assert_eq!(failure.http_status, 0);
        assert!(failure.message.contains("订阅池请求失败"), "{}", failure.message);
        drop(guard);
    }

    #[test]
    fn patch_body_only_writes_total_by_default() {
        // 调用方默认不传两个字符串(runtime 只在 settings 显式开启时才传)
        assert_eq!(patch_body(13, None, None), br#"{"total_episodes":13}"#.to_vec());
    }

    #[test]
    fn patch_body_appends_strings_only_when_roundtrip_is_exact() {
        // 逐字节往返一致 → 允许追加
        assert_eq!(strict_roundtrip("[11,12,13]").as_deref(), Some("[11,12,13]"));
        assert_eq!(
            patch_body(13, Some("[11,12,13]"), Some("[1,2,3]")),
            br#"{"total_episodes":13,"needed_episodes":"[11,12,13]","covered_episodes":"[1,2,3]"}"#
                .to_vec()
        );

        // 非 JSON / 规范化后不一致 → 一律不写(整条 JSON 解析失败也不 panic)
        assert_eq!(strict_roundtrip("11,12,13"), None);
        assert_eq!(strict_roundtrip("[11, 12]"), None, "空格不一致就不写");
        assert_eq!(strict_roundtrip(""), None);
        assert_eq!(strict_roundtrip("[1.50]"), None, "浮点规范化后不一致");
        assert_eq!(patch_body(13, Some("11,12,13"), None), br#"{"total_episodes":13}"#.to_vec());
    }

    #[test]
    fn idempotency_key_shape_is_printable_and_long_enough() {
        let key = patch_idempotency_key(41, 10, 13, 7);
        assert_eq!(key, "chase-patch-41-10-13-7");
        assert!((16..=128).contains(&key.len()), "长度 {}: {key}", key.len());
        assert!(key.bytes().all(|b| b.is_ascii_graphic()));
        assert_eq!(
            key,
            patch_idempotency_key(41, 10, 13, 7),
            "同业务重试必须复用同值"
        );
        assert_ne!(key, patch_idempotency_key(41, 10, 12, 7));
    }

    #[test]
    fn patch_path_targets_the_documented_route() {
        assert_eq!(patch_path(41), "/api/subscribe/pool/intents/41/episodes");
        assert_eq!(parse_intent(&json!({"id": -1, "tmdb_id": 2, "total_episodes_known": 0})).unwrap().id, -1);
    }

    // ── 三路径之二/之三: 失败分类 + 逐字段边界 ──

    #[test]
    fn fetch_page_classifies_http_and_shape_failures_with_raw_sample() {
        // 200 但不是 JSON → unparsed, 原文随 ParseFailure 带走
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, b"<html>maintenance</html>");
        let guard = fake.install();
        let failure = fetch_page(50, 0).unwrap_err();
        assert_eq!(failure.http_status, 200);
        assert_eq!(failure.kind(), "unparsed");
        assert!(failure.sample().contains("maintenance"), "{}", failure.sample());
        drop(guard);

        // 404 → http_error(与"结构认不出"区分开, 排障时走不同分支)
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 404, b"");
        let guard = fake.install();
        let failure = fetch_page(50, 0).unwrap_err();
        assert_eq!(failure.kind(), "http_error");
        assert_eq!(failure.http_status, 404);
        drop(guard);
    }

    #[test]
    fn parse_intent_rejects_incomplete_entries_and_clamps_ranges() {
        // 三个关键字段缺一不可: 缺了就跳过, 绝不填 0 继续(0 集订阅会算出假缺口)
        assert!(parse_intent(&json!({"tmdb_id": 1, "total_episodes_known": 2})).is_none());
        assert!(parse_intent(&json!({"id": 1, "total_episodes_known": 2})).is_none());
        assert!(parse_intent(&json!({"id": 1, "tmdb_id": 2})).is_none());
        assert!(parse_intent(&json!({"id": "x", "tmdb_id": 2, "total_episodes_known": 2})).is_none());
        assert!(parse_intent(&json!("not an object")).is_none());
        assert!(parse_intent(&json!(null)).is_none());

        // 负集数/负季号夹到 0, 超长标题按 UTF-8 边界截断
        let intent = parse_intent(&json!({
            "id": 3, "tmdb_id": 4, "season": -2, "total_episodes_known": -9,
            "title": "剧".repeat(200)
        }))
        .unwrap();
        assert_eq!(intent.total_known, 0);
        assert_eq!(intent.season, 0);
        assert!(intent.title.len() <= 160);
        assert!(std::str::from_utf8(intent.title.as_bytes()).is_ok());
    }

    #[test]
    fn intent_helpers_split_actionable_and_trim_candidates() {
        let with_state = |state: &str| Intent { state: state.to_string(), ..Default::default() };
        assert!(with_state("partial").actionable());
        assert!(with_state("").actionable(), "缺 state 的条目仍参与补订");
        assert!(!with_state("expired").actionable(), "到期只计数, 不写");
        assert!(!with_state("failed").actionable());
        assert!(with_state("caught_up").trim_candidate());
        assert!(with_state("landed").trim_candidate());
        assert!(!with_state("partial").trim_candidate());
        assert!(!with_state("").trim_candidate());
    }

    #[test]
    fn patch_body_writes_each_optional_independently() {
        assert_eq!(
            patch_body(5, Some("[4,5]"), None),
            br#"{"total_episodes":5,"needed_episodes":"[4,5]"}"#.to_vec()
        );
        assert_eq!(
            patch_body(5, None, Some("[1]")),
            br#"{"total_episodes":5,"covered_episodes":"[1]"}"#.to_vec()
        );
        // 两个字符串都过不了严格往返 → 退化成只写 total_episodes
        assert_eq!(
            patch_body(5, Some("[4, 5]"), Some("1,2")),
            br#"{"total_episodes":5}"#.to_vec()
        );
    }

    #[test]
    fn strict_roundtrip_keeps_exact_text_only() {
        assert_eq!(strict_roundtrip("{\"a\":1}").as_deref(), Some("{\"a\":1}"));
        assert_eq!(strict_roundtrip("[1,2]").as_deref(), Some("[1,2]"));
        assert_eq!(strict_roundtrip("[1, 2]"), None, "空格不同就不写回");
        assert_eq!(strict_roundtrip("1,2"), None, "不是合法 JSON 就不写回");
        assert_eq!(strict_roundtrip(" "), None);
        assert_eq!(strict_roundtrip("[]").as_deref(), Some("[]"));
    }

    #[test]
    fn list_path_never_exceeds_the_schema_limit() {
        assert_eq!(
            list_path(0, 0),
            "/api/subscribe/pool/intents?media_type=tv&limit=0&offset=0"
        );
        assert!(list_path(50, 50).contains("limit=50"));
        assert!(list_path(u32::MAX, 0).contains("limit=500"), "limit 夹到 schema 上限");
        assert!(list_path(18, 500).contains("offset=500"));
    }
}
