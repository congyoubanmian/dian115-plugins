//! 榜单解析的**集成测试**(只走 crate 的公开 API)。
//!
//! 需要宿主替身的用例(抓取整页、get-poster、预算行为)在 `src/charts.rs` / `src/poster.rs`
//! 的 `mod tests` 里(那里才能装 `host::testhost` 替身); 这里覆盖纯函数与夹具本身。
//!
//! 夹具来源与脱敏见 `tests/fixtures/README.md`。三个 HTML/JSON 夹具都是 2026-09-29
//! 从豆瓣公开页面实抓的片段, 页面本身不含任何 uid/凭据。

use plugin::charts::{parse_want, section_after, source_cost};

/// 口碑榜页面摘录(`https://movie.douban.com/chart`)。
const CHART_HTML: &[u8] = include_bytes!("fixtures/chart_listcont2.html");
/// 即将上映页面摘录(`https://movie.douban.com/cinema/later/`)。
const COMING_HTML: &[u8] = include_bytes!("fixtures/coming_showing_soon.html");
/// `j/search_subjects` 的响应摘录(6 条)。
const SUBJECTS_JSON: &[u8] = include_bytes!("fixtures/search_subjects.json");
/// 宿主 state 文档原文。
const STATE_JSON: &[u8] = include_bytes!("fixtures/state_val.json");

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Go `main.go:692` `sectionAfter` 在真实页面上的行为: 从锚点截到 `</ul>`。
#[test]
fn section_after_cuts_real_chart_page() {
    let html = text(CHART_HTML);
    let segment = section_after(&html, "id=\"listCont2\"", "", "</ul>");
    assert!(segment.starts_with("id=\"listCont2\">"));
    assert!(!segment.contains("</ul>"), "截取段必须止于 </ul> 之前");
    assert_eq!(segment.matches("<li class=\"clearfix\">").count(), 10);
    // 真实页面的首行: 排名 1 的《罗斯》(subject/35322132)
    assert!(segment.contains("<div class=\"no\">1</div>"));
    assert!(segment.contains("href=\"https://movie.douban.com/subject/35322132/\""));
    assert!(segment.contains("罗斯"));

    // 锚点不存在时 Go 原样返回整份文档
    assert_eq!(section_after(&html, "id=\"nope\"", "", "</ul>"), html.as_str());
    // 即将上映页在 Go 里的调用形式: open/close 都为空 → 从锚点到结尾
    let coming = text(COMING_HTML);
    let tail = section_after(&coming, "id=\"showing-soon\"", "", "");
    assert!(tail.starts_with("id=\"showing-soon\""));
    assert_eq!(tail.matches("<div class=\"item mod").count(), 6);
}

/// Go `main.go:530` `parseWant`(`([\d,]+)\s*人?\s*想看` + `Atoi`)。
#[test]
fn parse_want_reads_real_page_numbers() {
    let coming = text(COMING_HTML);
    // 真实页面里的原文: <span class="">15177人想看</span>
    let needle = "<span class=\"\">15177人想看</span>";
    let at = coming.find(needle).expect("夹具里必须有这条");
    assert_eq!(parse_want(&coming[at..at + needle.len()]), 15177);
    // 同页其他条目
    assert_eq!(parse_want("6352人想看"), 6352);
    assert_eq!(parse_want("520人想看"), 520);

    // 口碑榜段里没有"想看"字样 → 0(Go 里这些条目的 Hotness 就是 0)
    let chart = text(CHART_HTML);
    let segment = section_after(&chart, "id=\"listCont2\"", "", "</ul>");
    assert!(!segment.contains("想看"));
    assert_eq!(parse_want(segment), 0);

    // 千分位与空白
    assert_eq!(parse_want("1,234 人想看"), 1234);
    assert_eq!(parse_want("没有数字"), 0);
}

/// Go `main.go:540` `sourceCost` 的成本序(排序时便宜的 JSON 榜单先抓)。
#[test]
fn source_cost_orders_json_before_html() {
    assert!(source_cost("subjects_json") < source_cost("chart_html"));
    assert!(source_cost("chart_html") < source_cost("coming_html"));
    assert!(source_cost("coming_html") < source_cost("anything_else"));
}

/// `ChartItem` 的 JSON 字段名必须与 Go(`main.go:114`)逐字一致 —— 这份结构既进
/// `state` 响应也给 UI 读, 改一个字段名就等于改协议。
#[test]
fn chart_item_serializes_with_go_field_names() {
    let document: serde_json::Value = serde_json::from_slice(STATE_JSON).expect("夹具是合法 JSON");
    let lists = document["snapshot"]["lists"].as_object().expect("有榜单快照");

    // 口碑榜条目带 rank(Go 的 `rank,omitempty`), hotness 是 0 → 不省略
    let movie_wom = lists["movie_wom"].as_array().expect("movie_wom 是数组");
    let mut keys: Vec<&str> = movie_wom[0].as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec!["douban_ref", "hotness", "poster_url", "rank", "rate", "title", "url"],
        "空 year 被 omitempty 省掉, rank 非空要出现"
    );

    // hot 榜单条目没有 rank(空串被省略)
    let hot = lists["hot"].as_array().expect("hot 是数组");
    let mut keys: Vec<&str> = hot[0].as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec!["douban_ref", "hotness", "poster_url", "rate", "title", "url"]
    );

    // 值本身: 真实抓取结果(douban_ref 前缀 / 链接形态)
    assert_eq!(hot[0]["douban_ref"], "db:subj:36850814");
    assert_eq!(hot[0]["url"], "https://movie.douban.com/subject/36850814/");
    assert_eq!(movie_wom[0]["rank"], "1");
    assert_eq!(movie_wom[0]["url"], "https://movie.douban.com/subject/35322132/");

    // 反序列化回 model::ChartItem(公开 API)后字段一一对上
    let item: plugin::model::ChartItem =
        serde_json::from_value(movie_wom[0].clone()).expect("能解回 ChartItem");
    assert_eq!(item.douban_ref, "db:subj:35322132");
    assert_eq!(item.title, "罗斯");
    assert_eq!(item.rank, "1");
    assert_eq!(item.rate, "");
    assert_eq!(item.hotness, 0);
    assert_eq!(item.year, "");
}

/// `j/search_subjects` 的响应摘录能喂给 `charts::SubjectsJson`(公开结构)且字段对上。
#[test]
fn subjects_json_fixture_decodes() {
    let parsed: plugin::charts::SubjectsJson =
        serde_json::from_slice(SUBJECTS_JSON).expect("夹具能解");
    assert_eq!(parsed.subjects.len(), 6);
    assert_eq!(parsed.subjects[0].id, "36850814");
    assert_eq!(parsed.subjects[0].title, "年会不能停！2");
    assert_eq!(parsed.subjects[0].rate, "6.6");
    assert_eq!(parsed.subjects[0].url, "https://movie.douban.com/subject/36850814/");
    assert!(parsed.subjects[0].cover.starts_with("https://img"));
}
