//! 「想看」链路的**集成测试**(只走 crate 的公开 API + 脱敏夹具)。
//!
//! 回归目标(对照 `runtime/wish.go`):
//! - `subject.id` 时而字符串(`"36808876"`)时而数字(`12345`)→ [`WishFlexString`] 两种都收,
//!   `null`/缺失 → 空串;
//! - 只收 `type` 是 `movie`/`tv` 的条目: 真实样本 `type=tv` 的响应里混着 movie 与 book,
//!   `year` 还可能是 `null`(所以解析真实响应要走 `model::decode` 的 "null → 零值" 语义);
//! - cookie 缓存 TTL 45 分钟; `dbcl2` → uid 取冒号前段。
//!
//! 夹具是 2026-09-29 从豆瓣 `kind=mark` 接口实抓的**公开响应**(见
//! `tests/fixtures/README.md`): 响应里没有 uid/登录态, 无需脱敏字段; movie 与 tv 两份
//! 有 3 条重叠 —— 去重逻辑由 `src/wish.rs` 的替身用例覆盖(集成测试装不了 host 替身)。
//!
//! 需要宿主替身的用例(分页抓取、CookieCloud 拉取、入队/订阅)在 `src/wish.rs` 的
//! `mod tests` 里。

use plugin::clock;
use plugin::model::CookieCache;
use plugin::wish::{
    cookie_cache_fresh, parse_manual_cookie, wish_items_from_interests, InterestsResponse,
    WishFlexString, COOKIE_CACHE_TTL_MS, WISH_PAGE_SIZE, WISH_USER_AGENT,
};

/// `kind=mark&type=movie` 的响应(3 条, 全是电影)。
const WISH_MOVIE: &[u8] = include_bytes!("fixtures/wish_movie.json");
/// `kind=mark&type=tv` 的响应(4 条: 混进 1 条 book, `year` 是 `null`)。
const WISH_TV: &[u8] = include_bytes!("fixtures/wish_tv.json");

#[test]
fn movie_fixture_maps_every_entry() {
    let parsed: InterestsResponse = plugin::model::decode(WISH_MOVIE).expect("movie 夹具必须能解");
    assert_eq!(parsed.total, 3);
    assert_eq!(parsed.interests.len(), 3);

    let items = wish_items_from_interests(&parsed.interests);
    assert_eq!(items.len(), 3, "movie 样本里没有非影视条目");
    // 顺序与响应一致
    let refs: Vec<&str> = items.iter().map(|item| item.douban_ref.as_str()).collect();
    assert_eq!(refs, vec!["36808876", "36809864", "35653205"]);
    assert_eq!(items[0].title, "奥德赛");
    assert_eq!(items[0].year, "2026");
    assert_eq!(items[0].kind, "movie");
    assert!(items[0].poster_url.starts_with("https://img"), "{}", items[0].poster_url);
    assert!(items[2].poster_url.starts_with("https://img"));
    // `added_at` 由调用方(runtime)补时间戳, 纯函数不填
    assert!(items.iter().all(|item| item.added_at.is_empty()));
}

#[test]
fn tv_fixture_filters_out_non_video_entries() {
    let parsed: InterestsResponse = plugin::model::decode(WISH_TV).expect("tv 夹具必须能解");
    assert_eq!(parsed.total, 4);
    assert_eq!(parsed.interests.len(), 4);

    let items = wish_items_from_interests(&parsed.interests);
    assert_eq!(items.len(), 3, "4 条里那条 book 必须被滤掉");
    assert!(
        !items.iter().any(|item| item.douban_ref == "26968034"),
        "书目不得进订阅列表(拿去 TMDB 匹配会订阅到同名电影)"
    );
    assert!(items.iter().all(|item| item.kind == "movie" || item.kind == "tv"));
    // `type=tv` 的响应里混着 movie: 既有的 kind 原样保留, 不按查询类型改写
    assert_eq!(items[0].kind, "movie");
}

/// 真实样本里 `year` 键**缺失**(那条 book), 未知字段的 `null`(rating/release_date)
/// 必须被忽略; 而落在**建模字段**上的显式 `null` 与 serde 的默认行为冲突 ——
/// 这正是 `model::decode`(Go 的 "null → 零值")存在的理由。
#[test]
fn missing_year_decodes_to_zero_and_null_needs_go_style_decode() {
    // 真实夹具: 缺失的 `year` 由 `#[serde(default)]` 兜底, 未知字段的 null 被忽略
    let parsed: InterestsResponse =
        serde_json::from_slice(WISH_TV).expect("缺失的 year + 未知字段的 null 都不该让解析失败");
    let book = parsed
        .interests
        .iter()
        .find(|interest| interest.subject.kind == "book")
        .expect("夹具里必须留着那条 book 用于回归");
    assert_eq!(book.subject.year, "", "缺失 → 零值");
    assert_eq!(book.subject.id.as_str(), "26968034");

    // 显式 null 落在建模字段上: 裸 serde_json 报错, Go 当零值 —— 用最小样本钉住差异
    let minimal = br#"{"interests":[{"subject":{"id":"1","title":"x","year":null,"type":"movie"}}],"total":1}"#;
    assert!(
        serde_json::from_slice::<InterestsResponse>(minimal).is_err(),
        "serde 对建模字段上的 null 是严格的(与 Go 不同)"
    );
    let parsed: InterestsResponse = plugin::model::decode(minimal).expect("model::decode 走 null → 零值");
    assert_eq!(parsed.interests[0].subject.year, "");
    assert_eq!(parsed.interests[0].subject.id.as_str(), "1");
}

/// `subject.id` 字符串/数字两种形态都收, `null`/缺失 → 空串。
#[test]
fn flex_string_accepts_both_id_shapes() {
    #[derive(serde::Deserialize)]
    struct Holder {
        id: WishFlexString,
    }

    let text: Holder = serde_json::from_str(r#"{"id":"36808876"}"#).unwrap();
    assert_eq!(text.id.as_str(), "36808876");

    let number: Holder = serde_json::from_str(r#"{"id":12345}"#).unwrap();
    assert_eq!(number.id.as_str(), "12345", "数字 id 收成不带引号的原文");

    let big: Holder = serde_json::from_str(r#"{"id":4935623109}"#).unwrap();
    assert_eq!(big.id.as_str(), "4935623109");

    let null: Holder = serde_json::from_str(r#"{"id":null}"#).unwrap();
    assert_eq!(null.id.as_str(), "", "null → 空串");

    // 数字 id 要能一路映射成 douban_ref(拼 URL 用)
    let interest = serde_json::from_str::<plugin::wish::WishInterest>(
        r#"{"subject":{"id":12345,"title":"某剧集","year":"2026","type":"tv","pic":{}}}"#,
    )
    .unwrap();
    let items = wish_items_from_interests(&[interest]);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].douban_ref, "12345");
    assert_eq!(items[0].kind, "tv");

    // id 为空白 → 跳过
    let blank = serde_json::from_str::<plugin::wish::WishInterest>(
        r#"{"subject":{"id":"  ","title":"x","type":"movie"}}"#,
    )
    .unwrap();
    assert!(wish_items_from_interests(&[blank]).is_empty());
}

/// 请求常量: 移动 UA + 分页大小(`httpGetWithCookie` 的 referer/headers 由替身用例断言)。
#[test]
fn request_constants_match_the_mobile_endpoint() {
    assert!(WISH_USER_AGENT.contains("iPhone"), "m 站接口要移动 UA");
    assert!(WISH_USER_AGENT.contains("Mobile/15E148"));
    assert_eq!(WISH_PAGE_SIZE, 50);
}

/// `parseManualCookie`: 整段 cookie 头透传, uid 取 `dbcl2` 冒号前段; 无效输入返回空。
#[test]
fn manual_cookie_parsing_cases() {
    let (header, uid) = parse_manual_cookie("  dbcl2=123456789:tok; ck=abc  ");
    assert_eq!(header, "dbcl2=123456789:tok; ck=abc", "header 是 trim 后的整段原文");
    assert_eq!(uid, "123456789");

    assert_eq!(parse_manual_cookie("dbcl2=999").1, "999", "没有冒号时 uid 就是整段");
    for invalid in ["", "no-equals", "ck=abc", "123456789:tok", "dbcl2=;ck=x"] {
        assert_eq!(parse_manual_cookie(invalid), (String::new(), String::new()), "{invalid:?}");
    }
}

/// cookie 缓存: 45 分钟 TTL, 缺字段或脏时间戳一律不新鲜。
#[test]
fn cookie_cache_ttl_is_45_minutes() {
    assert_eq!(COOKIE_CACHE_TTL_MS, 45 * 60 * 1_000);

    let now = clock::now_unix_nanos();
    let nanos = 1_000_000_000u64;
    let at = |minutes_ago: u64| CookieCache {
        header: "dbcl2=123456789:tok; ck=abc".to_string(),
        uid: "123456789".to_string(),
        source: "cookiecloud".to_string(),
        fetched_at: clock::rfc3339(now - minutes_ago * 60 * nanos),
    };

    assert!(cookie_cache_fresh(&at(0)), "刚取到的缓存必须新鲜");
    assert!(cookie_cache_fresh(&at(44)), "44 分钟内必须新鲜");
    assert!(!cookie_cache_fresh(&at(45)), "45 分钟整已过期(Go 是严格小于)");
    assert!(!cookie_cache_fresh(&at(60)));

    // 配置变更作废缓存的效果: 空缓存(全零字段)永远不新鲜
    assert!(!cookie_cache_fresh(&CookieCache::default()));
    let mut no_uid = at(1);
    no_uid.uid = String::new();
    assert!(!cookie_cache_fresh(&no_uid));
    let mut broken = at(1);
    broken.fetched_at = "garbage".to_string();
    assert!(!cookie_cache_fresh(&broken));
}
