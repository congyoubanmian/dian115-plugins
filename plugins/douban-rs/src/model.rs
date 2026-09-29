//! 宿主存储里的状态文档(对照 Go `main.go:231` `persistedState` 及其全部嵌套结构)。
//!
//! # 语义对齐
//!
//! 字段名/顺序/`omitempty` 与 Go 的 json tag **逐一一致** —— 这份文档既会被写回宿主的
//! `state` 键, 也会被 UI 读取, 改一个字段名就等于改协议。
//!
//! Go 的零值语义(本模块用类型表达):
//!
//! | Go | JSON | Rust |
//! |----|------|------|
//! | `nil` map / `nil` slice | `null` | `None` |
//! | 空 map / 空 slice | `{}` / `[]` | `Some(空)` |
//! | 带 `omitempty` 的零值 | 省略该键 | `skip_serializing_if` |
//! | 结构体字段(即使"空") | 总是出现 | 总是序列化 |
//!
//! 解码方向同样对齐: 字段缺失或为 `null` → 零值; 类型不符 → 报错(Go 的
//! `json.Unmarshal` 也是这个行为, 而不是静默忽略)。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Go `map[K]V` 字段: `None` = nil → `null`。
pub type GoMap<K, V> = Option<BTreeMap<K, V>>;
/// Go `[]T` 字段: `None` = nil → `null`。
pub type GoSlice<T> = Option<Vec<T>>;

/// Go `omitempty` 对 slice: nil 或空都省略。
pub fn skip_empty_seq<T>(value: &GoSlice<T>) -> bool {
    value.as_ref().map_or(true, |items| items.is_empty())
}

/// Go `omitempty` 对 map: nil 或空都省略。
pub fn skip_empty_map<K: Ord, V>(value: &GoMap<K, V>) -> bool {
    value.as_ref().map_or(true, |map| map.is_empty())
}

/// Go `omitempty` 对 int: 0 省略。
pub fn is_zero_i64(value: &i64) -> bool {
    *value == 0
}

/// Go `json.Unmarshal` 到结构体的语义: 字段缺失或为 `null` → 零值; 类型不符 → 报错。
///
/// serde 的默认行为对 `null` 严格(集合/标量都报错), 与 Go 不同; 因此这里先用
/// [`strip_nulls`] 递归删掉对象里的 `null` 成员, 让 `#[serde(default)]` 接手。
/// 快路径: 绝大多数文档(本插件自己写出来的)没有 `null` 标量, 直接 `from_slice` 解码,
/// 省掉一整棵 `Value` 树 —— 状态文档最大 4MiB, 内存预算要留给宿主限额。
pub fn decode<T: serde::de::DeserializeOwned>(raw: &[u8]) -> Option<T> {
    if let Ok(value) = serde_json::from_slice::<T>(raw) {
        return Some(value);
    }
    let value: serde_json::Value = serde_json::from_slice(raw).ok()?;
    serde_json::from_value(strip_nulls(value)).ok()
}

/// 递归删除对象里的 `null` 成员(等价于 Go 解码时把 `null` 当零值)。
///
/// 细微差异(见阶段差异清单): Go 对 map 值上的 `null` 会保留"键存在 + 零值"
/// (`{"hot":null}` → hot 是零值配置), 这里会让键消失; 对数组里的 `null` 元素则
/// 原样保留(Go 解成零值元素、serde 对非 Option 元素报错 —— 这种文档会被判成
/// "无法识别"从而拒绝落盘, 属于安全的失败方向)。
pub fn strip_nulls(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.into_iter()
                .filter(|(_, value)| !value.is_null())
                .map(|(key, value)| (key, strip_nulls(value)))
                .collect(),
        ),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(strip_nulls).collect())
        }
        other => other,
    }
}

/// 榜单来源配置 (Go `main.go:88` `ListConfig`)。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ListConfig {
    /// coming_html | subjects_json | chart_html
    pub source: String,
    /// movie | tv
    #[serde(rename = "type")]
    pub kind: String,
    pub tag: String,
    pub sort: String,
    pub limit: i64,
    pub enabled: bool,
}

/// 插件设置 (Go `main.go:97` `Settings`)。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub lists: GoMap<String, ListConfig>,
    pub blacklist: GoSlice<String>,
    pub observe_period_hours: i64,
    pub auto_subscribe: bool,
    pub notify_on_subscribe: bool,
    pub subscribe_source_filter: GoSlice<String>,
    pub max_history: i64,
    pub max_logs: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub cookiecloud_url: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub cookiecloud_uuid: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub cookiecloud_key: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub manual_cookie: String,
    pub wish_sync_enabled: bool,
}

impl Settings {
    /// 全零设置(`Default::default()` 的 const 版本, 供 `Runtime::new` 这类 const 上下文用)。
    pub const EMPTY: Settings = Settings {
        lists: None,
        blacklist: None,
        observe_period_hours: 0,
        auto_subscribe: false,
        notify_on_subscribe: false,
        subscribe_source_filter: None,
        max_history: 0,
        max_logs: 0,
        cookiecloud_url: String::new(),
        cookiecloud_uuid: String::new(),
        cookiecloud_key: String::new(),
        manual_cookie: String::new(),
        wish_sync_enabled: false,
    };

    /// 账号字段是否非空 —— `loadAccountOverlay` 的 `applied` 判定。
    pub fn has_account_fields(&self) -> bool {
        !self.cookiecloud_url.is_empty()
            || !self.cookiecloud_uuid.is_empty()
            || !self.cookiecloud_key.is_empty()
            || !self.manual_cookie.is_empty()
            || self.wish_sync_enabled
    }
}

/// 榜单条目 (Go `main.go:114` `ChartItem`)。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ChartItem {
    pub douban_ref: String,
    pub title: String,
    pub rate: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub rank: String,
    pub hotness: i64,
    pub poster_url: String,
    pub url: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub year: String,
}

/// 最近一次榜单抓取结果 (Go `main.go:125` `Snapshot`)。
///
/// `lists` 的值在 Go 里是 `[]ChartItem`: 可能是 nil(`null`)也可能是空数组(`[]`),
/// 与 `cloneSnapshot` 只补外层 map 的事实一致, 所以内层也用 [`GoSlice`]。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Snapshot {
    pub fetched_at: String,
    pub lists: GoMap<String, GoSlice<ChartItem>>,
}

impl Snapshot {
    pub const EMPTY: Snapshot = Snapshot { fetched_at: String::new(), lists: None };
}

/// 观察队列条目 (Go `main.go:130` `QueueItem`)。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct QueueItem {
    pub douban_ref: String,
    pub title: String,
    pub list: String,
    pub poster_url: String,
    pub url: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub tmdb_ref: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub media_type: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub year: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub poster_path: String,
    pub entered_at: String,
    pub due_at: String,
    /// observing | needs_review | subscribed
    pub state: String,
    pub attempt: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub last_error: String,
}

/// 观察队列 (Go `main.go:147` `Queue`)。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Queue {
    pub items: GoSlice<QueueItem>,
}

impl Queue {
    pub const EMPTY: Queue = Queue { items: None };
}

/// 订阅历史 (Go `main.go:151` `HistoryEntry`)。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct HistoryEntry {
    pub douban_ref: String,
    pub tmdb_ref: String,
    pub title: String,
    pub list: String,
    /// subscribe | skip
    pub action: String,
    /// succeeded | failed
    pub result: String,
    pub message: String,
    #[serde(skip_serializing_if = "is_zero_i64")]
    pub intent_id: i64,
    pub created_at: String,
}

/// 运行日志 (Go `main.go:163` `LogEntry`)。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct LogEntry {
    pub at: String,
    pub level: String,
    pub message: String,
}

/// 订阅统计 (Go `main.go:169` `Stats`)。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Stats {
    pub total: i64,
    pub month_new: i64,
    pub month: String,
    pub by_list: GoMap<String, i64>,
    pub last_archive_at: String,
}

impl Stats {
    pub const EMPTY: Stats = Stats {
        total: 0,
        month_new: 0,
        month: String::new(),
        by_list: None,
        last_archive_at: String::new(),
    };
}

/// 黑名单命中记录 (Go `main.go:177` `BlackHit`)。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BlackHit {
    pub title: String,
    pub keyword: String,
    pub at: String,
}

/// 黑名单状态 (Go `main.go:183` `BlackState`)。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BlackState {
    pub keywords: GoSlice<String>,
    pub hits: i64,
    pub recent: GoSlice<BlackHit>,
}

impl BlackState {
    pub const EMPTY: BlackState = BlackState { keywords: None, hits: 0, recent: None };
}

/// 想看条目 (Go `wish.go:15` `WishItem`)。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct WishItem {
    pub douban_ref: String,
    pub title: String,
    pub year: String,
    /// movie | tv
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub poster_url: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub added_at: String,
}

/// 想看同步状态摘要 (Go `wish.go:24` `WishInfo`)。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct WishInfo {
    pub enabled: bool,
    pub last_sync: String,
    pub last_count: i64,
    pub last_new: i64,
    pub last_status: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub last_error: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub uid: String,
    /// cookiecloud | manual
    #[serde(skip_serializing_if = "String::is_empty")]
    pub source: String,
}

impl WishInfo {
    pub const EMPTY: WishInfo = WishInfo {
        enabled: false,
        last_sync: String::new(),
        last_count: 0,
        last_new: 0,
        last_status: String::new(),
        last_error: String::new(),
        uid: String::new(),
        source: String::new(),
    };
}

/// CookieCloud 解密缓存 (Go `wish.go:38` `CookieCache`)。
///
/// 全字段 `omitempty` → 空缓存序列化成 `{}`(Go 里结构体字段不会因 omitempty 消失)。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct CookieCache {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub header: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub uid: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub source: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub fetched_at: String,
}

impl CookieCache {
    pub const EMPTY: CookieCache = CookieCache {
        header: String::new(),
        uid: String::new(),
        source: String::new(),
        fetched_at: String::new(),
    };
}

/// 宿主存储里的单一状态文档 (Go `main.go:231` `persistedState`)。
///
/// `wish`/`wish_seen` 带 `omitempty`(nil 或空都省略);
/// `wish_info`/`cookie` 虽是 `omitempty` 但结构体永远序列化(Go 的 omitempty 对
/// 结构体不生效), 因此这里也不做跳过。
///
/// `history`/`logs` 没有 `omitempty` → nil 时写出 `null`, 空切片则是 `[]` —— 两者在
/// 读取时必须区分, 用 [`GoSlice`] 表达。落盘路径上 `history` 归档后是 nil(→ `null`),
/// 而 `logs` 永远是数组(`persistAll` 用 `make([]LogEntry, 0, persistLogLimit)` 起步,
/// 见 runtime.rs 的 [`crate::runtime::Runtime::persist_all`])。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PersistedState {
    pub settings: Settings,
    pub snapshot: Snapshot,
    pub queue: Queue,
    pub history: GoSlice<HistoryEntry>,
    pub logs: GoSlice<LogEntry>,
    pub stats: Stats,
    pub blackstate: BlackState,
    #[serde(skip_serializing_if = "skip_empty_seq")]
    pub wish: GoSlice<WishItem>,
    #[serde(skip_serializing_if = "skip_empty_map")]
    pub wish_seen: GoMap<String, bool>,
    pub wish_info: WishInfo,
    pub cookie: CookieCache,
}

impl PersistedState {
    /// Go `safeUnmarshal` 到 `persistedState` 的等价物: 不合法就返回 `None`(调用方保持原值)。
    pub fn parse(raw: &[u8]) -> Option<PersistedState> {
        decode(raw)
    }

    /// 这份文档算不算"能识别的本插件状态" —— Go 用 `doc.Settings.Lists != nil` 判定。
    pub fn is_recognizable(&self) -> bool {
        self.settings.lists.is_some()
    }
}

/// 默认设置 (Go `main.go:2095` `defaultSettings`)。
pub fn default_settings() -> Settings {
    let mut lists = BTreeMap::new();
    lists.insert(
        "upcoming".to_string(),
        ListConfig { source: "coming_html".into(), kind: "movie".into(), limit: 20, enabled: true, ..ListConfig::default() },
    );
    lists.insert(
        "hot".to_string(),
        ListConfig {
            source: "subjects_json".into(),
            kind: "movie".into(),
            tag: "热门".into(),
            sort: "recommend".into(),
            limit: 30,
            enabled: true,
        },
    );
    lists.insert(
        "cn_wom".to_string(),
        ListConfig {
            source: "subjects_json".into(),
            kind: "tv".into(),
            tag: "国产剧".into(),
            sort: "recommend".into(),
            limit: 30,
            enabled: true,
        },
    );
    lists.insert(
        "global_wom".to_string(),
        ListConfig {
            source: "subjects_json".into(),
            kind: "movie".into(),
            tag: "欧美".into(),
            sort: "recommend".into(),
            limit: 30,
            enabled: true,
        },
    );
    lists.insert(
        "movie_wom".to_string(),
        ListConfig { source: "chart_html".into(), kind: "movie".into(), limit: 20, enabled: true, ..ListConfig::default() },
    );
    Settings {
        lists: Some(lists),
        observe_period_hours: 24,
        auto_subscribe: true,
        notify_on_subscribe: true,
        max_history: 200,
        max_logs: 200,
        ..Settings::EMPTY
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// 脱敏后的真实状态文档(宿主 `state` 键原文)必须能 **逐字节** 原样往返:
    /// 字段名、顺序、omitempty、null/[]/{} 的取舍全部对齐 Go 的 json tag。
    #[test]
    fn fixture_round_trips_byte_exact() {
        let raw = crate::fixtures::STATE;
        let doc = PersistedState::parse(raw).expect("夹具必须能解出 persistedState");
        let encoded = serde_json::to_string(&doc).expect("必须能再序列化");
        assert_eq!(
            encoded,
            std::str::from_utf8(raw).unwrap(),
            "状态文档往返后必须逐字节一致(实现在字段名/顺序/omitempty 上有偏差)"
        );
    }

    #[test]
    fn fixture_restores_every_section() {
        let doc = PersistedState::parse(crate::fixtures::STATE).unwrap();
        assert!(doc.is_recognizable(), "lists 必须非 nil —— 否则 Go 版会把状态当成空");
        assert_eq!(doc.settings.lists.as_ref().unwrap().len(), 5);
        assert_eq!(doc.queue.items.as_ref().unwrap().len(), 109);
        assert_eq!(doc.snapshot.lists.as_ref().unwrap().len(), 5);
        assert_eq!(doc.history.as_ref().unwrap().len(), 3);
        assert_eq!(doc.logs.as_ref().unwrap().len(), 40);
        assert_eq!(doc.stats.total, 3);
        assert_eq!(doc.stats.by_list.as_ref().unwrap().get("wish"), Some(&3));
        assert_eq!(doc.wish.as_ref().unwrap().len(), 3);
        assert_eq!(doc.wish_seen.as_ref().unwrap().len(), 3);
        assert_eq!(doc.wish_info.uid, "123456789");
        assert_eq!(doc.cookie, CookieCache::EMPTY, "脱敏夹具里登录 cookie 必须为空");
        assert_eq!(doc.blackstate.keywords, None, "Go nil slice → null");
        // 榜单条目字段全:
        let lists = doc.snapshot.lists.as_ref().unwrap();
        let hot = lists.get("hot").and_then(|items| items.as_ref()).unwrap();
        assert_eq!(hot[0].douban_ref, "db:subj:36850814");
        assert!(hot[0].poster_url.starts_with("https://img"));
        let movie_wom = lists.get("movie_wom").and_then(|items| items.as_ref()).unwrap();
        assert!(movie_wom.iter().any(|item| item.rank == "1"), "rank 字段必须解出来");
    }

    /// 与夹具等价但用构造值检查 null / [] / {} 三态(Go 的 nil 与空是两回事)。
    #[test]
    fn nil_and_empty_are_distinct() {
        let doc: PersistedState = serde_json::from_str(
            r#"{"settings":{"lists":{},"blacklist":[],"subscribe_source_filter":[]}}"#,
        )
        .unwrap();
        assert!(doc.is_recognizable(), "空对象 lists 在 Go 里是非 nil map → 算已加载");
        assert_eq!(doc.settings.lists, Some(BTreeMap::new()));
        assert_eq!(doc.settings.blacklist, Some(Vec::new()));
        let encoded = serde_json::to_string(&doc).unwrap();
        assert!(encoded.contains(r#""lists":{}"#), "空 map 必须是 {{}} 而不是 null: {encoded}");
        assert!(encoded.contains(r#""blacklist":[]"#), "空 slice 必须是 [] 而不是 null: {encoded}");

        let null_doc: PersistedState = serde_json::from_str(r#"{"settings":{"lists":null}}"#).unwrap();
        assert!(!null_doc.is_recognizable(), "null lists 在 Go 里是 nil → 不能算已加载");
        assert_eq!(null_doc.settings.lists, None);
    }

    #[test]
    fn missing_fields_become_zero_values() {
        let doc: PersistedState = serde_json::from_str("{}").unwrap();
        assert_eq!(doc, PersistedState::default());
        assert_eq!(doc.cookie, CookieCache::EMPTY);
        // Go 里 wish_info/cookie 是结构体字段(omitempty 无效), 永远出现
        let encoded = serde_json::to_string(&doc).unwrap();
        assert!(encoded.contains(r#""cookie":{}"#), "{encoded}");
        assert!(
            encoded.contains(r#""wish_info":{"enabled":false,"last_sync":"","last_count":0,"last_new":0,"last_status":""}"#),
            "{encoded}"
        );
        // 带 omitempty 的空 wish / wish_seen 必须消失
        assert!(!encoded.contains(r#""wish""#), "{encoded}");
        assert!(!encoded.contains(r#""wish_seen""#), "{encoded}");
        // 账号字段(omitempty)全部缺席
        assert!(!encoded.contains("manual_cookie"), "{encoded}");
        assert!(!encoded.contains("cookiecloud_key"), "{encoded}");
        // 无 omitempty 的字段必须出现, 且 nil → null
        assert!(encoded.contains(r#""lists":null"#), "{encoded}");
        assert!(encoded.contains(r#""subscribe_source_filter":null"#), "{encoded}");
        assert!(encoded.contains(r#""by_list":null"#), "{encoded}");
        // 全新安装第一次落盘就是这个形态: history/logs/queue.items 是 null(不是 [])
        assert!(encoded.contains(r#""history":null"#), "{encoded}");
        assert!(encoded.contains(r#""logs":null"#), "{encoded}");
        assert!(encoded.contains(r#""queue":{"items":null}"#), "{encoded}");
        assert!(encoded.contains(r#""snapshot":{"fetched_at":"","lists":null}"#), "{encoded}");
    }

    /// Go 的结构体解码对 `null` 宽容: 字段是 null → 零值(nil / 0 / ""), 不报错。
    /// 这是宿主里真实存在的形态(Go 版自己写出的全新安装文档就是 null 满天飞),
    /// 解不出来会让插件把用户状态判成"无法识别"而永久拒绝落盘。
    #[test]
    fn null_fields_decode_as_zero_values_like_go() {
        let doc = PersistedState::parse(
            br#"{"settings":{"lists":{},"blacklist":null,"subscribe_source_filter":null,"max_logs":null},
                 "snapshot":{"fetched_at":null,"lists":{"hot":null}},
                 "queue":{"items":null},
                 "history":null,"logs":null,
                 "stats":{"total":null,"by_list":null},
                 "blackstate":{"keywords":null,"hits":null,"recent":null},
                 "wish":null,"wish_seen":null,
                 "wish_info":{"last_error":null},"cookie":{"header":null}}"#,
        )
        .expect("null 字段必须按零值解出");
        assert!(doc.is_recognizable(), "null 不影响 lists 判定");
        assert_eq!(doc.settings.blacklist, None);
        assert_eq!(doc.settings.max_logs, 0);
        assert_eq!(doc.queue.items, None);
        assert_eq!(doc.history, None);
        assert_eq!(doc.logs, None);
        assert_eq!(doc.stats.total, 0);
        assert_eq!(doc.stats.by_list, None);
        // null 的榜单键在 Go 里是"键存在 + 零值"; 这里按"键缺失"处理(见 strip_nulls 注释)
        assert_eq!(doc.snapshot.lists.as_ref().unwrap().get("hot"), None);
        assert_eq!(doc.wish, None);
        assert_eq!(doc.cookie, CookieCache::EMPTY);

        // 类型不符仍然必须报错(与 Go 一致), 不能因为宽容 null 就把错误吞掉
        assert!(PersistedState::parse(br#"{"stats":{"total":"3"}}"#).is_none());
        assert!(PersistedState::parse(br#"{"history":[{"intent_id":"x"}]}"#).is_none());
    }

    #[test]
    fn unknown_fields_are_ignored_and_type_mismatch_errors_like_go() {
        let doc = PersistedState::parse(
            br#"{"settings":{"lists":{"hot":{"source":"x"}},"mystery":1},"unknown_top":true}"#,
        )
        .unwrap();
        assert_eq!(doc.settings.lists.as_ref().unwrap()["hot"].source, "x");

        // Go 的 json.Unmarshal 对类型不符会报错(而不是静默取零值)
        assert!(PersistedState::parse(br#"{"settings":{"lists":{"hot":{"limit":"30"}}}}"#).is_none());
        assert!(PersistedState::parse(br#"{"settings":{"lists":{"hot":{"limit":30.5}}}}"#).is_none());
        assert!(PersistedState::parse(br#"{"queue":{"items":[{"attempt":true}]}}"#).is_none());
        assert!(PersistedState::parse(br#"{"stats":{"total":"3"}}"#).is_none());
        // 整体不是对象(数组/字符串/数字/裸 null) → 解不出来
        assert!(PersistedState::parse(b"[1,2]").is_none());
        assert!(PersistedState::parse(b"null").is_none());
        assert!(PersistedState::parse(b"not json").is_none());
    }

    #[test]
    fn omitempty_fields_round_trip_as_go() {
        let doc: PersistedState = serde_json::from_str(
            r#"{"queue":{"items":[{"douban_ref":"a","attempt":0,"tmdb_ref":"","last_error":""}]},
                "history":[{"douban_ref":"b","intent_id":0}],
                "snapshot":{"lists":{"hot":[{"douban_ref":"c","rank":"","year":""}]}},
                "wish":[{"douban_ref":"d","poster_url":"","added_at":""}]}"#,
        )
        .unwrap();
        let value: Value = serde_json::to_value(&doc).unwrap();
        let item = &value["queue"]["items"][0];
        assert!(item.get("tmdb_ref").is_none() && item.get("last_error").is_none(), "{item}");
        assert_eq!(item["attempt"], json!(0), "attempt 无 omitempty → 0 必须出现");
        assert!(value["history"][0].get("intent_id").is_none(), "intent_id 带 omitempty → 0 省略");
        assert!(value["snapshot"]["lists"]["hot"][0].get("rank").is_none());
        assert!(value["wish"][0].get("poster_url").is_none());
    }

    #[test]
    fn default_settings_match_go() {
        let settings = default_settings();
        let lists = settings.lists.as_ref().unwrap();
        assert_eq!(lists.len(), 5);
        assert_eq!(lists["upcoming"].source, "coming_html");
        assert_eq!(lists["upcoming"].limit, 20);
        assert_eq!(lists["hot"].tag, "热门");
        assert_eq!(lists["hot"].sort, "recommend");
        assert_eq!(lists["cn_wom"].kind, "tv");
        assert_eq!(lists["global_wom"].tag, "欧美");
        assert_eq!(lists["movie_wom"].source, "chart_html");
        assert_eq!(settings.observe_period_hours, 24);
        assert!(settings.auto_subscribe && settings.notify_on_subscribe);
        assert_eq!(settings.max_history, 200);
        assert_eq!(settings.max_logs, 200);
        assert_eq!(settings.blacklist, None, "Go defaultSettings 的 nil slice → null");
        assert!(!settings.has_account_fields());
    }

    #[test]
    fn account_fields_detection() {
        let mut settings = Settings::EMPTY;
        assert!(!settings.has_account_fields());
        settings.cookiecloud_url = "http://127.0.0.1:8088".into();
        assert!(settings.has_account_fields());
        let mut settings = Settings::EMPTY;
        settings.wish_sync_enabled = true;
        assert!(settings.has_account_fields());
        let mut settings = Settings::EMPTY;
        settings.manual_cookie = "dbcl2=1:2".into();
        assert!(settings.has_account_fields());
    }
}
