//! 追剧日历(`/api/subscribe/air-calendar`)的解析。
//!
//! 该端点与 `emby/episodes` 一样**没有参数声明也没有响应 schema**
//! (openapi-v1.yaml:4749-4770, 响应只有 `GenericHostObject`), 所以:
//!
//! - 根可以是数组, 也可以是对象; 对象里依次找 `data` → `items`/`calendar`/`days`/`shows`/`episodes`,
//!   `data` 再下探一层;
//! - **两种分组形态都要能收**: 扁平的 `items:[{date,...}]` 与按天分组的
//!   `days:[{date,items:[...]}]`;
//! - 日期一律按前 10 字符归一成 `YYYY-MM-DD`(`2026-10-01T12:00:00Z` → `2026-10-01`);
//!   解析不出日期的条目**丢弃而不报错**;
//! - 结构整体认不出来(找不到候选容器) ⇒ `Err`, 由 runtime 记 debug 并降级
//!   (日历只影响界面与日报段①, 对齐照常, 目标上限退回 TMDB 的 season 集数)。

use std::collections::BTreeMap;

use serde_json::Value;

use crate::clock;
use crate::host;
use crate::model::{CalendarDay, CalendarItem};
use crate::raw::{self, ParseFailure};

/// 日历端点路径。
pub const PATH: &str = "/api/subscribe/air-calendar";

/// 根对象下探的容器候选。
const ROOT_KEYS: &[&str] = &["data", "items", "calendar", "days", "shows", "episodes"];
/// 分组形态里"这一天的条目"候选键。
const GROUP_KEYS: &[&str] = &["items", "episodes", "shows", "list", "calendar"];
/// 日期字段候选。
const DATE_KEYS: &[&str] = &["air_date", "airDate", "date", "first_air_date", "premiere_date"];
/// 剧集 id 候选。
const TMDB_KEYS: &[&str] = &["tmdb_id", "tmdbId", "id"];
/// 季号候选。
const SEASON_KEYS: &[&str] = &["season", "season_number"];
/// 集号候选。
const EPISODE_KEYS: &[&str] = &["episode", "episode_number", "index_number"];
/// 标题候选。
const TITLE_KEYS: &[&str] = &["title", "name", "series_name"];
/// 时间候选。
const TIME_KEYS: &[&str] = &["air_time", "airtime", "airTime", "time"];
/// 解析期保留的最大天数(状态文档只留 8 天, 这里给窗口筛选留余量)。
const PARSE_DAYS_MAX: usize = 64;

/// 解析结果。
#[derive(Debug, Clone, Default)]
pub struct AirCalendar {
    /// 按日期升序的日历(未做窗口裁剪)。
    pub days: Vec<CalendarDay>,
    /// 命中的形状指纹。
    pub shape: String,
    /// 收到的原始条目数(丢弃前的计数, 供诊断)。
    pub items_seen: usize,
}

impl AirCalendar {
    /// 截取 `[from, from+days]` 的窗口(状态文档最多留 8 天)。
    ///
    /// `from` 是本地日期 `YYYY-MM-DD`; 非法日期或窗口为空都返回空表(界面显示空态)。
    pub fn window(&self, from: &str, days: i64) -> Vec<CalendarDay> {
        let Some(start) = clock::parse_date_days(from) else { return Vec::new() };
        let end = start + days.max(0);
        self.days
            .iter()
            .filter(|day| {
                clock::parse_date_days(&day.date)
                    .map(|value| value >= start && value <= end)
                    .unwrap_or(false)
            })
            .take(crate::model::CALENDAR_DAYS_MAX)
            .cloned()
            .collect()
    }

    /// 某一天的全部条目(日报段①用)。
    pub fn items_on(&self, date: &str) -> Vec<CalendarItem> {
        self.days
            .iter()
            .find(|day| day.date == date)
            .map(|day| day.items.clone())
            .unwrap_or_default()
    }

    pub fn is_empty(&self) -> bool {
        self.days.iter().all(|day| day.items.is_empty())
    }
}

/// 拉取并解析追剧日历。
pub fn fetch() -> Result<AirCalendar, ParseFailure> {
    let response = host::get(PATH)
        .map_err(|err| ParseFailure::transport(format!("追剧日历请求失败: {err}")))?;
    if response.status >= 400 {
        return Err(ParseFailure::http(
            response.status,
            response.raw.clone(),
            format!("追剧日历 HTTP {}", response.status),
        ));
    }
    parse(&response.raw)
        .map_err(|message| ParseFailure::http(response.status, response.raw.clone(), message))
}

/// 解析追剧日历。
pub fn parse(raw: &[u8]) -> Result<AirCalendar, String> {
    let value = raw::decode_json(raw)?;
    let (elements, container_name) = locate_root(&value)
        .ok_or_else(|| "日历结构未识别: 未命中容器字段候选".to_string())?;

    let mut grouped: BTreeMap<String, Vec<CalendarItem>> = BTreeMap::new();
    let mut items_seen = 0usize;
    let mut flat_date_key = String::new();
    let mut grouped_form = false;

    for element in elements {
        let Some(obj) = element.as_object() else {
            // 裸数组里夹标量/字符串的噪声形态真实见过: 解析不了, 但算"收到过"。
            items_seen += 1;
            continue;
        };
        let date_text = raw::first_string(obj, DATE_KEYS);
        let date = date_text.clone().and_then(|text| clock::normalize_date(&text));
        // 分组形态: 这一天自带 date + 一个条目数组
        if let Some(inner) = raw::first_of(obj, GROUP_KEYS).and_then(Value::as_array) {
            grouped_form = true;
            let Some(date) = date else {
                // 整组因日期不可用被丢弃, 但条目本身仍算"收到过"(诊断口径: 丢弃前计数)。
                items_seen += inner.len();
                continue;
            };
            let bucket = grouped.entry(date).or_default();
            for entry in inner {
                items_seen += 1;
                if let Some(item) = parse_item(entry) {
                    bucket.push(item);
                }
            }
            continue;
        }
        // 扁平形态: 每条自带日期
        items_seen += 1;
        if flat_date_key.is_empty() {
            if let Some(key) = DATE_KEYS.iter().find(|key| obj.contains_key(**key)) {
                flat_date_key = (*key).to_string();
            }
        }
        let Some(date) = date else { continue };
        if let Some(item) = parse_item(element) {
            grouped.entry(date).or_default().push(item);
        }
    }

    let mut days: Vec<CalendarDay> = grouped
        .into_iter()
        .map(|(date, mut items)| {
            items.sort_by(|left, right| {
                (left.season, left.episode, left.time.clone())
                    .cmp(&(right.season, right.episode, right.time.clone()))
            });
            items.truncate(crate::model::CALENDAR_ITEMS_MAX);
            CalendarDay { date, items }
        })
        .collect();
    if days.len() > PARSE_DAYS_MAX {
        days.truncate(PARSE_DAYS_MAX);
    }

    let shape = format!(
        "root={container_name};grouped={};date={}",
        if grouped_form { "yes" } else { "no" },
        if flat_date_key.is_empty() { "n/a" } else { &flat_date_key }
    );
    Ok(AirCalendar { days, shape, items_seen })
}

/// 定位根容器: 返回 (元素数组, 命中的键名)。
fn locate_root(value: &Value) -> Option<(&Vec<Value>, String)> {
    match value {
        Value::Array(items) => Some((items, "array".to_string())),
        Value::Object(map) => {
            for key in ROOT_KEYS {
                let Some(candidate) = map.get(*key) else { continue };
                if let Value::Array(items) = candidate {
                    return Some((items, (*key).to_string()));
                }
                if *key == "data" {
                    if let Some(inner) = candidate.as_object() {
                        for deep in ROOT_KEYS {
                            if deep == &"data" {
                                continue;
                            }
                            if let Some(Value::Array(items)) = inner.get(*deep) {
                                return Some((items, format!("data.{deep}")));
                            }
                        }
                    }
                }
            }
            None
        }
        _ => None,
    }
}

/// 单条 → 日历条目; 完全没有可用信息(无 id/集号/标题)时丢弃。
fn parse_item(element: &Value) -> Option<CalendarItem> {
    let obj = element.as_object()?;
    let tmdb_id = raw::first_i64(obj, TMDB_KEYS).unwrap_or(0);
    let season = raw::first_i64(obj, SEASON_KEYS).unwrap_or(0);
    let episode = raw::first_i64(obj, EPISODE_KEYS).unwrap_or(0);
    let title = raw::first_string(obj, TITLE_KEYS).unwrap_or_default();
    if tmdb_id == 0 && episode == 0 && title.is_empty() {
        return None;
    }
    let time = raw::first_string(obj, TIME_KEYS)
        .map(|text| raw::truncate_bytes(text.trim(), 40).to_string())
        .unwrap_or_default();
    Some(CalendarItem {
        tmdb_id,
        season: season.max(0),
        episode: episode.max(0),
        title: raw::truncate_bytes(&title, 160).to_string(),
        time,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::FakeHost;

    /// 扁平形态(强类型假设: `items:[{air_date,...}]`)。
    fn flat_fixture() -> Vec<u8> {
        r#"{
          "items": [
            {"tmdb_id": 1396, "season": 5, "episode": 1, "title": "绝命毒师",
             "air_date": "2026-10-01T12:00:00Z", "air_time": "12:00"},
            {"tmdb_id": 1396, "season": 5, "episode": 2, "title": "绝命毒师",
             "date": "2026-10-02", "time": "12:00"}
          ]
        }"#.as_bytes()
        .to_vec()
    }

    /// 按天分组形态。
    fn grouped_fixture() -> Vec<u8> {
        r#"{
          "data": {
            "days": [
              {"date": "2026-10-01", "items": [
                 {"tmdbId": "1399", "season_number": 1, "episode_number": 3, "name": "权力的游戏"}
              ]},
              {"air_date": "2026-10-02", "episodes": [
                 {"id": 1399, "season": 1, "episode": 4, "series_name": "权力的游戏"}
              ]}
            ]
          }
        }"#.as_bytes()
        .to_vec()
    }

    /// 裸数组 + 斜杠日期 + 无日期的噪声条目。
    fn bare_fixture() -> Vec<u8> {
        r#"[
          {"tmdb_id": 42, "season": 2, "episode": 9, "title": "某剧", "air_date": "2026/10/03"},
          {"tmdb_id": 43, "season": 1, "episode": 1, "title": "没有日期"},
          "not an object"
        ]"#.as_bytes()
        .to_vec()
    }

    #[test]
    fn parses_flat_grouped_and_bare_shapes() {
        let flat = parse(&flat_fixture()).unwrap();
        assert_eq!(flat.days.len(), 2);
        assert_eq!(flat.days[0].date, "2026-10-01");
        assert_eq!(flat.days[0].items[0].episode, 1);
        assert_eq!(flat.days[0].items[0].time, "12:00");
        assert_eq!(flat.shape, "root=items;grouped=no;date=air_date");

        let grouped = parse(&grouped_fixture()).unwrap();
        assert_eq!(grouped.days.len(), 2);
        assert_eq!(grouped.days[0].items[0].tmdb_id, 1399);
        assert_eq!(grouped.days[1].date, "2026-10-02");
        assert!(grouped.shape.starts_with("root=data.days;grouped=yes;"));

        let bare = parse(&bare_fixture()).unwrap();
        assert_eq!(bare.days.len(), 1, "无日期的条目被丢弃");
        assert_eq!(bare.days[0].date, "2026-10-03");
        assert_eq!(bare.items_seen, 3);
        assert_eq!(bare.shape, "root=array;grouped=no;date=air_date");
    }

    #[test]
    fn unparsable_calendars_are_reported() {
        assert!(parse(b"<html>").is_err());
        assert!(parse(br#"{"nope":1}"#).is_err());
        assert!(parse(b"").is_err());
        // 空数组是合法的空日历
        let empty = parse(b"[]").unwrap();
        assert!(empty.is_empty());
    }

    #[test]
    fn window_filters_by_local_date_and_caps_days() {
        let mut days = Vec::new();
        for offset in 0..12 {
            let date = clock::date_plus_days("2026-10-01", offset).unwrap();
            days.push(CalendarDay {
                date,
                items: vec![CalendarItem { episode: offset, ..Default::default() }],
            });
        }
        let calendar = AirCalendar { days, shape: String::new(), items_seen: 12 };
        let window = calendar.window("2026-10-01", 7);
        assert_eq!(window.len(), 8, "含今日共 8 天");
        assert_eq!(window[0].date, "2026-10-01");
        assert_eq!(window[7].date, "2026-10-08");

        // 过去的日子被排除; 非法日期 → 空
        assert_eq!(calendar.window("2026-10-05", 2).len(), 3);
        assert!(calendar.window("oops", 7).is_empty());

        // 日报只看当天
        assert_eq!(calendar.items_on("2026-10-02").len(), 1);
        assert!(calendar.items_on("2027-01-01").is_empty());
    }

    #[test]
    fn items_are_bounded_and_sorted() {
        let mut items = Vec::new();
        for episode in (1..=30).rev() {
            items.push(serde_json::json!({
                "tmdb_id": 1, "season": 1, "episode": episode, "title": "x", "date": "2026-10-01"
            }));
        }
        let raw = serde_json::to_vec(&serde_json::json!({"items": items})).unwrap();
        let calendar = parse(&raw).unwrap();
        assert_eq!(calendar.days[0].items.len(), crate::model::CALENDAR_ITEMS_MAX);
        assert_eq!(calendar.days[0].items[0].episode, 1, "按集号升序");
    }

    #[test]
    fn fetch_reports_http_failures_with_raw() {
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 503, b"nope");
        let guard = fake.install();
        let failure = fetch().unwrap_err();
        assert_eq!(failure.http_status, 503);
        assert_eq!(failure.sample(), "nope");
        drop(guard);

        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 200, &flat_fixture());
        let guard = fake.install();
        assert_eq!(fetch().unwrap().days.len(), 2);
        drop(guard);
    }

    // ── 补: 嵌套容器 / 日期归一 / 窗口边界 ──

    #[test]
    fn parses_nested_data_items_and_normalizes_dates() {
        let raw = r#"{"data":{"items":[
            {"tmdb_id":7,"season":1,"episode":2,"title":"某剧","date":"2026-10-03T21:30:00+08:00"},
            {"tmdb_id":7,"season":1,"episode":3,"title":"某剧","date":"2026/10/04"},
            {"tmdb_id":7,"season":1,"episode":4,"title":"没有日期"}]}}"#
            .as_bytes();
        let calendar = parse(raw).unwrap();
        assert_eq!(calendar.days.len(), 2);
        assert_eq!(calendar.days[0].date, "2026-10-03");
        assert_eq!(calendar.days[1].date, "2026-10-04");
        assert_eq!(calendar.items_seen, 3, "丢弃前计数");
        assert_eq!(calendar.shape, "root=data.items;grouped=no;date=date");
    }

    #[test]
    fn grouped_day_without_a_usable_date_is_dropped_but_counted() {
        let raw = br#"{"days":[
            {"date":"oops","items":[{"tmdb_id":1,"episode":1,"title":"x"}]},
            {"date":"2026-10-05","items":[{"tmdb_id":1,"episode":2,"title":"y"}]}]}"#;
        let calendar = parse(raw).unwrap();
        assert_eq!(calendar.days.len(), 1);
        assert_eq!(calendar.days[0].date, "2026-10-05");
        assert_eq!(calendar.items_seen, 2, "被丢弃的条目也要计入收到数");
        assert!(calendar.shape.starts_with("root=days;grouped=yes;"));
    }

    #[test]
    fn window_handles_zero_and_negative_spans() {
        let mut days = Vec::new();
        for offset in 0..4 {
            days.push(CalendarDay {
                date: clock::date_plus_days("2026-10-01", offset).unwrap(),
                items: Vec::new(),
            });
        }
        let calendar = AirCalendar { days, shape: String::new(), items_seen: 0 };
        assert_eq!(calendar.window("2026-10-01", 0).len(), 1, "0 天窗口只留今天");
        assert_eq!(calendar.window("2026-10-01", -3).len(), 1, "负数按 0 天处理");
        assert_eq!(calendar.window("2026-10-02", 7).len(), 3);
        assert!(calendar.window("oops", 7).is_empty());
    }

    #[test]
    fn empty_calendar_is_reported_as_empty_not_as_an_error() {
        let calendar = parse(b"[]").unwrap();
        assert!(calendar.is_empty());
        assert!(calendar.items_on("2026-10-01").is_empty());
        assert_eq!(calendar.window("2026-10-01", 7).len(), 0);
        // 只有空 items 的分组也不算"有内容"
        let blank = parse(br#"{"days":[{"date":"2026-10-01","items":[]}]}"#).unwrap();
        assert!(blank.is_empty());
        assert_eq!(blank.days.len(), 1);
    }
}
