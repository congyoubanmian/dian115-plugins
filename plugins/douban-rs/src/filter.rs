//! 功能 2「订阅过滤器」+ 功能 3「已删除不重订」的名下文件 —— **本文件只属于功能 2/3 一路**。
//!
//! # 两路文件边界(冻结)
//!
//! | 路 | 名下文件(只在这里填函数体) | 在共享文件上的接口 |
//! |----|---------------------------|--------------------|
//! | 功能 1(TMDB 匹配增强) | `subject.rs` + `subscribe.rs` 的**匹配函数内部** | [`crate::subject::Runtime::rexxar_subject_detail`] |
//! | 功能 2/3(本文件) | **`filter.rs`(本文件)** + `wish.rs`(rating 补提取) + `AppPage.vue`(设置抽屉/想看区) | [`Runtime::can_subscribe`] / [`Runtime::no_resub_guard`] 等 |
//!
//! 共享文件 `subscribe.rs` 上只有两条互不重叠的线, 合并时不需要解冲突:
//! - **功能 1** 只改匹配函数的**函数体**(`subscribe_queue_item` 与 `subscribe_from_snapshot`
//!   里 `tmdb_search → match_tmdb → 阈值判定` 那几行), 不改签名、不加参数、不碰订阅入口;
//! - **功能 2/3** 只在**订阅入口**加守卫, 署名如下(实现阶段加, 本阶段不接线):
//!   - `process_due`: 每条到期条目在 `subscribe_queue_item(...)` **之前**先
//!     [`Runtime::no_resub_guard`] → 再 [`Runtime::can_subscribe`];
//!   - `sync_wish_list`(wish.rs, 功能 2/3 名下): 内联订阅前先 `no_resub_guard` + `can_subscribe`;
//!   - `subscribe_queue_now`(action `subscribe-now`): 先 `can_subscribe`; 墓碑**不拦**
//!     自动路径以外的手动入口, 改为在响应里带 [`NO_RESUB_CONFIRM_TEXT`]
//!     (见 [`Runtime::no_resub_confirmation`]);
//!   - `subscribe_from_snapshot`(action `subscribe`): 只加 [`Runtime::no_resub_confirmation`]
//!     提示, **不过滤**(契约给定的自动路径清单里没有它)。
//!
//! `subscribe.rs` 里两路各自的行都带 `// [功能1]` / `// [功能2/3]` 标记, 便于合并时核对。
//!
//! # 冻结的调用矩阵
//!
//! | 入口 | 触发方式 | [`Runtime::can_subscribe`] | [`Runtime::no_resub_guard`] | 墓碑确认文案 |
//! |------|----------|---------------------------|----------------------------|--------------|
//! | `process_due`(chart 到期 / wish 到期) | 自动 | 应用 | 应用(拦截) | — |
//! | `sync_wish_list` 内联订阅 | 自动 | 应用 | 应用(拦截) | — |
//! | `subscribe_queue_now`(`subscribe-now`) | 手动 | **应用** | 不拦 | 有 |
//! | `subscribe_from_snapshot`(`subscribe`) | 手动 | 不应用 | 不拦 | 有 |
//!
//! 被过滤的队列条目标 `state = `[`FILTERED_QUEUE_STATE`], 被墓碑拦下的标
//! `state = `[`NO_RESUB_QUEUE_STATE`], 两者都是**终态**: `process_due` 的保留循环要把它们
//! 和 `needs_review` 一样直接 `keep`(不再重试), 也**不再进 `needs_review`**。
//!
//! # 功能 2: 数据来源(全部来自真实响应, 不编造字段)
//!
//! | 字段 | chart 条目 | wish 条目 | rexxar 详情 |
//! |------|-----------|-----------|-------------|
//! | 评分 | `ChartItem::rate`(字符串 `"8.0"`, 口碑榜实测有空串) | `subject.rating.value` → [`crate::model::WishItem::rating`](模型已加字段, wish.rs 实现时补提取) | `rating.value` |
//! | 年份 | `ChartItem::year`(口碑榜实测为空串) | `subject.year`(实测 `"2026"`; 可能缺失/`null`) | `year` |
//! | 地区 | —— | —— | `countries`(string[]) |
//!
//! 地区只在 rexxar 详情里存在, 而详情只在**功能 1 的失配回退**时才取; 因此地区过滤
//! **只在详情已取到时生效**, 详情未取到时放行并记一条 warning 日志 —— 见下面 deviations 第 1 条。
//!
//! # deviations(与契约的偏离 / 降级, 实现阶段必须照此并在日志里体现)
//!
//! 1. **地区过滤只在详情已取到时生效**。`min_rating`/`min_year` 用列表自带的评分/年份
//!    (chart 的 `rate`/`year`、wish 的 `rating`/`year`), 但 `regions` 的唯一数据源是
//!    rexxar 条目详情(`countries`)。高置信直配的条目**不会**取详情, 于是无法判定地区 →
//!    [`Runtime::can_subscribe`] 放行(不拦), 并记一条 `warning` 日志
//!    `地区过滤降级: 详情未取到，跳过地区判定（<title>）`。
//!    (取证结论: rexxar 详情**确有一等公民的地区字段 `countries`**, 见 `subject.rs` 的字段表,
//!    所以"取到了就能判"; 降级只发生在"没取到"。)
//! 2. **无评分条目在 `min_rating > 0` 时按"低于阈值"处理**(契约明文要求), 文案见
//!    [`reason_rating`]; 设置抽屉的输入项必须带 [`UI_COPY_MIN_RATING`] 这句说明。
//! 3. **chart 口碑榜(`chart_html`)的 `rate`/`year` 实测常为空串**(`state_val.json` 的
//!    107 条快照里 37 条 `rate` 为空、`year` 全部缺失; `coming_html` 两者都空)。空串 =
//!    没有数据 → 与第 2 条同口径(有阈值就按"低于阈值"拦), 日志里要能看出是"缺数据"而不是
//!    "评分低"。**这是行为上的硬后果: 开了 `min_rating` 之后, 口碑榜与即将上映榜的条目
//!    在直配路径上会被大面积过滤**, 实现阶段要在日志与 UI 文案里都体现, 不要静默。
//! 4. **`min_year` 比较的是数值**, 不是字符串序(`"9" > "10"` 是字符串序的坑);
//!    年份解析不出数字时按第 2 条同口径处理。
//! 5. **功能 3 的"已完成"判定**: 宿主 `PoolIntent.state` 的取值域由宿主 OpenAPI 冻结为
//!    `pending | searching | transferring | partial | caught_up | landed | failed | expired`
//!    (`~/.cache/dian115-contract/openapi-v1.yaml:3108`)。"已完成"取
//!    [`COMPLETED_INTENT_STATES`] = `landed` + `caught_up`; `failed`/`expired` **不算**
//!    已完成(它们不代表用户没删, 而是订阅本身失败/过期)。
//!    宿主**没有**给出 `state` 的中文标签, "已完成 = landed/caught_up" 是按"追平/落地"语义
//!    推断的, 属于本契约的**外部假设**(与功能 1 的字段名不同, 这里无法用 curl 证实,
//!    宿主不在本机可测范围内 —— 见结果里的风险条目)。
//!
//! # 功能 3: 墓碑集(`no_resub`)的持久化形态
//!
//! 放在状态文档的**新字段** `no_resub`(键 = `douban_ref`, 与 [`crate::model::PersistedState`]
//! 的其它 `GoMap` 一样带 `omitempty` → 空 map 不落盘, 旧文档读进来自然为空):
//!
//! ```json
//! "no_resub": {
//!   "36808876": {"tmdb_ref":"tmdb:movie:1077295","intent_id":171,
//!                "at":"2026-09-30T10:00:09Z","reason":"宿主已无该 tmdb 订阅"}
//! }
//! ```
//!
//! **池消费式(重要)**: 守卫只看"墓碑键存在", **不读 value**(value 里的
//! `tmdb_ref`/`intent_id`/`at`/`reason` 只用于 UI 与排查), 也**不回查历史** ——
//! 历史里的合格记录在墓碑写入时已验证过, 守卫若再回查, `archive` 清空历史或
//! `max_history` 截断后守卫就失效, 自动路径会重订已删除条目。墓碑是"用户的删除
//! 决定", 不该跟着历史一起消失; `archive` 也**不清**墓碑(见 `runtime.rs::archive`
//! 的注释)。要恢复自动订阅只有两条路: action `no-resub-clear`(清空)或在宿主侧
//! 重新建订阅。
//!
//! # 判定流程(实现阶段照此写, 已冻结)
//!
//! 1. 候选历史 = `action == "subscribe" && result == "succeeded" && intent_id != 0`
//!    (`intent_id` 有记录), 且 `douban_ref`/`tmdb_ref` 非空、`tmdb_ref` 形如
//!    `tmdb:<media_type>:<id>` 且 `<id>` 能解析成 `i64`(用
//!    [`Runtime::host_pool_intents`] 的 `tmdb_id` 比较)。
//! 2. 宿主池里**存在**同 `(tmdb_id, media_type)` 的 intent → 没被删 → 不写墓碑。
//! 3. 宿主池里**不存在**该 `(tmdb_id, media_type)`, 但存在同 `tmdb_id` 且
//!    `state ∈ `[`COMPLETED_INTENT_STATES`] 的 intent → 视为"已完成/已落地" →
//!    不写墓碑(这正是契约里"且条目非已完成"的分支)。
//! 4. 其余情况(池为空 / 只剩该 `tmdb_id` 的**非完成**态意图消失) → 写墓碑。
//! 5. 宿主调用失败 / 解析失败 → **不写**(宁可漏判不可误判), 记 `warning` 日志;
//!    池查询返回条数达到 [`crate::subscribe::HOST_POOL_INTENTS_LIMIT`] 上限(可能被
//!    截断, "查不到"≠"已删除") → 同样**不写**, 记 `warning` 日志。
//! 6. 判定时机: `wish-sync` 后台任务 —— 挂载点是 `runtime.rs::job_dispatch` 的
//!    `wish-sync` 分支(`process_due` 之后调一次 [`Runtime::resolve_no_resub_from_history`]),
//!    并加"上次扫描时间"节流(建议 >= 6 小时, 用 `clock::now_unix_nanos` + `parse_rfc3339`,
//!    节流字段落在新状态键或 `no_resub` 值里, 实现阶段定)。
//!    **实现阶段已接线**(本功能名下): 节流字段落在**新状态键** `no_resub_scan_at`
//!    (RFC3339, omitempty; `PersistedState` + `Runtime` 各一份),
//!    到期判定见 [`Runtime::no_resub_scan_due`], 常量
//!    [`NO_RESUB_SCAN_MIN_INTERVAL_NANOS`]。

use serde_json::Value;

use crate::clock;
use crate::host::{self, HostCallRequest};
use crate::model::{ChartItem, GoMap, HistoryEntry, QueueItem, WishItem};
// `pub(crate)`: crate 内经由 `filter` 引用 `Runtime`(如 subscribe.rs 的
// `crate::filter::Runtime::queue_item_rating` 调用点)。
pub(crate) use crate::runtime::Runtime;
use crate::store;
use crate::subscribe::{PoolIntentEntry, PoolIntentListResult};

/// 队列条目被过滤器拦下后的终态(功能 2)。
pub const FILTERED_QUEUE_STATE: &str = "filtered";
/// 队列条目被墓碑拦下后的终态(功能 3)。
pub const NO_RESUB_QUEUE_STATE: &str = "no_resub";
/// 宿主 `PoolIntent.state` 里代表"已完成/已落地"的取值(功能 3, 见 deviations 第 5 条)。
pub const COMPLETED_INTENT_STATES: &[&str] = &["landed", "caught_up"];
/// 手动订阅按钮遇到墓碑时的确认文案(功能 3; 实现阶段把它放进 action 响应, UI 二次确认后放行)。
pub const NO_RESUB_CONFIRM_TEXT: &str =
    "该条目此前订阅过、现在已被你删除：自动订阅不会重订它，确认要手动订阅吗？";
/// 墓碑扫描的最小间隔(功能 3, 模块头"判定流程"第 6 条建议的 >= 6 小时)。
pub const NO_RESUB_SCAN_MIN_INTERVAL_NANOS: u64 = 6 * 3_600_000_000_000;
/// 墓碑值里的默认原因文案(功能 3)。
pub const NO_RESUB_REASON: &str = "宿主已无该 tmdb 订阅";
/// 被墓碑拦下时的日志/`last_error` 文案(功能 3, 自动路径)。
pub fn no_resub_guard_message(title: &str) -> String {
    format!("已删除不重订，跳过自动订阅：{title}")
}
/// 地区判定降级时的日志文案(功能 2, deviations 第 1 条)。
pub fn region_degraded_log(title: &str) -> String {
    format!("地区过滤降级: 详情未取到，跳过地区判定（{title}）")
}

// ── 设置抽屉的文案(功能 2 的 AppPage.vue 直接引用这些字面量, 便于前后端一致) ──

/// 设置抽屉: 最低评分输入项的说明文案(必须注明"无评分按低于阈值处理")。
pub const UI_COPY_MIN_RATING: &str = "最低评分（0 = 不限；无评分的条目按“低于阈值”处理，会被过滤）";
/// 设置抽屉: 最低年份输入项的说明文案。
pub const UI_COPY_MIN_YEAR: &str = "最低年份（0 = 不限；豆瓣口碑榜/即将上映榜多数条目没有年份）";
/// 设置抽屉: 地区输入项的说明文案(注明只在详情已取到时生效)。
pub const UI_COPY_REGIONS: &str = "地区（逗号分隔，留空 = 不限；只在已取到豆瓣条目详情时生效）";
/// 想看区的墓碑数与"清除重订限制"按钮文案。`{}` 处填条数。
pub fn ui_copy_no_resub_count(count: i64) -> String {
    format!("已删除不重订：{count} 条")
}
/// 想看区"清除重订限制"按钮文案(action `no-resub-clear`)。
pub const UI_COPY_NO_RESUB_CLEAR: &str = "清除重订限制";

/// 宿主 `PoolIntent.state` 是否属于"已完成/已落地"(功能 3; 纯函数, 已实现)。
pub fn intent_is_completed(state: &str) -> bool {
    COMPLETED_INTENT_STATES.contains(&state)
}

/// `tmdb:<media_type>:<id>` → `(media_type, tmdb_id)`(功能 3, 模块头"判定流程"第 1 条)。
///
/// 只认该形态: `<id>` 必须能解析成 `i64`,`media_type` 非空(空类型没法与宿主池比对,
/// 按"宁可漏判不可误判"不收)。
pub fn parse_tmdb_ref(tmdb_ref: &str) -> Option<(&str, i64)> {
    let rest = tmdb_ref.strip_prefix("tmdb:")?;
    let mut parts = rest.splitn(2, ':');
    let media_type = parts.next()?;
    let id_text = parts.next()?;
    if media_type.is_empty() {
        return None;
    }
    let id = id_text.parse::<i64>().ok()?;
    Some((media_type, id))
}

/// 历史条目是否是"订阅成功且有宿主 intent"的合格候选(功能 3, 模块头"判定流程"第 1 条):
/// `action == "subscribe" && result == "succeeded" && intent_id != 0`,且 `tmdb_ref`
/// 能按 [`parse_tmdb_ref`] 解析。
pub fn history_entry_qualifies(entry: &HistoryEntry) -> bool {
    entry.action == "subscribe"
        && entry.result == "succeeded"
        && entry.intent_id != 0
        && parse_tmdb_ref(&entry.tmdb_ref).is_some()
}

/// 地区白名单比对(功能 2; 纯函数, 已实现): 白名单里**任一项**与 `countries` 里**任一项**
/// 精确相等即命中; `countries` 为空表 = 详情取到了但没有地区数据 → 不命中;
/// `None` = 详情没取到 → **放行**(deviations 第 1 条的降级, 由 `can_subscribe` 处理)。
pub fn regions_match(countries: &[String], regions: &[String]) -> bool {
    countries
        .iter()
        .any(|country| regions.iter().any(|region| region == country))
}

/// 豆瓣评分字符串 → 数值(`ChartItem::rate`, 实测形态 `"8.0"` / `""` / `"暂无评分"`)。
///
/// 纯函数(已实现): 解析不出数字一律 `None`(→ 设置里 `min_rating > 0` 时按低于阈值处理)。
pub fn parse_rate(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

/// 豆瓣年份字符串 → 数值(实测形态 `"2026"` / `""` / 缺失)。
///
/// 纯函数(已实现): 只认开头的十进制数字(`"2026"`、`"2026-08-14"` 都 → 2026),
/// 解析不出 → `None`。**按数值比较**, 不做字符串序(见 deviations 第 4 条)。
pub fn parse_year(text: &str) -> Option<i32> {
    let trimmed = text.trim();
    let digits: String = trimmed
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<i32>().ok()
}

/// 过滤原因文案: 评分(含"无评分"降级口径)。**文案已冻结**, 测试按它断言。
pub fn reason_rating(rating: Option<f64>, min_rating: f64) -> String {
    match rating {
        Some(value) => format!("评分不足（{value:.1} < {min_rating:.1}）"),
        None => format!("无评分条目按低于阈值处理（疑似无数据, min_rating={min_rating:.1}）"),
    }
}

/// 过滤原因文案: 年份。
pub fn reason_year(year: Option<i32>, min_year: i32) -> String {
    match year {
        Some(value) => format!("年份不足（{value} < {min_year}）"),
        None => format!("无年份条目按低于阈值处理（min_year={min_year}）"),
    }
}

/// 过滤原因文案: 地区(`countries` 为 `None` 表示详情没取到 —— 那是降级放行, 不走这里)。
pub fn reason_region(countries: &[String], regions: &[String]) -> String {
    format!(
        "地区不符（{} ∉ {}）",
        if countries.is_empty() {
            "无地区数据".to_string()
        } else {
            countries.join("/")
        },
        regions.join("/")
    )
}

/// 过滤判定结果(功能 2)。`reason` 就是进日志/进 `last_error` 的文案。
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct FilterDecision {
    /// `true` = 放行。
    pub allowed: bool,
    /// 拦下时的原因文案; 放行时为 `None`。
    pub reason: Option<String>,
    /// `true` = 因为"详情没取到"而跳过了地区判定(只记日志, 不算拦下)。
    pub region_skipped: bool,
}

/// [`Runtime::can_subscribe`] 的入参(spread 视图, 不拷贝数据)。
///
/// 三个来源各有一个构造函数: chart 条目、wish 条目、队列条目(队列条目只有 `year`
/// 与最终 `rate` 是否落地的差别 —— 实现阶段在 `QueueItem` 里补 `rating` 时可改走第 3 个构造函数)。
#[derive(Debug, Clone, Copy)]
pub struct SubscriptionCandidate<'a> {
    pub douban_ref: &'a str,
    pub title: &'a str,
    /// `movie` | `tv`(空串 = 未知)。
    pub kind: &'a str,
    /// 年份原文(空串/`None` = 未知)。
    pub year: Option<&'a str>,
    /// 评分(`None` = 未知/无评分)。
    pub rating: Option<f64>,
    /// rexxar 详情的 `countries`; `None` = **详情未取到** → 地区过滤降级放行
    /// (deviations 第 1 条), 空切片 = 详情取到但没有地区数据。
    pub countries: Option<&'a [String]>,
}

impl<'a> SubscriptionCandidate<'a> {
    /// chart 榜单条目(`ChartItem::rate` 是字符串评分, `year` 可能是空串)。
    ///
    /// `ChartItem` **不带类型字段**(`movie`/`tv` 只在榜单配置 `ListConfig::kind` 上),
    /// 所以这里 `kind` 恒为空串; 需要类型时用 [`SubscriptionCandidate::with_kind`] 补。
    pub fn from_chart_item(item: &'a ChartItem) -> SubscriptionCandidate<'a> {
        SubscriptionCandidate {
            douban_ref: item.douban_ref.as_str(),
            title: item.title.as_str(),
            kind: "",
            year: Some(item.year.as_str()),
            rating: parse_rate(&item.rate),
            countries: None,
        }
    }

    /// wish 想看条目(评分取 `subject.rating.value`, 由 `wish.rs` 的映射补进来)。
    pub fn from_wish_item(item: &'a WishItem) -> SubscriptionCandidate<'a> {
        SubscriptionCandidate {
            douban_ref: item.douban_ref.as_str(),
            title: item.title.as_str(),
            kind: item.kind.as_str(),
            year: Some(item.year.as_str()),
            rating: if item.rating > 0.0 {
                Some(item.rating)
            } else {
                None
            },
            countries: None,
        }
    }

    /// 观察队列条目。`rating` 传 [`Runtime::queue_item_rating`] 的结果
    /// (`QueueItem::rating`, `0` = 未知 → `None`); 入队点见 `charts.rs` / `wish.rs`。
    pub fn from_queue_item(item: &'a QueueItem, rating: Option<f64>) -> SubscriptionCandidate<'a> {
        SubscriptionCandidate {
            douban_ref: item.douban_ref.as_str(),
            title: item.title.as_str(),
            kind: item.media_type.as_str(),
            year: Some(item.year.as_str()),
            rating,
            countries: None,
        }
    }

    /// 补上条目类型(`movie`/`tv`; chart 路的来源是榜单配置 `ListConfig::kind`)。
    pub fn with_kind(mut self, kind: &'a str) -> Self {
        self.kind = kind;
        self
    }

    /// 补上 rexxar 详情里的地区(功能 2 在详情已取到时调用)。
    pub fn with_countries(mut self, countries: Option<&'a [String]>) -> Self {
        self.countries = countries;
        self
    }
}

/// 墓碑集(功能 3): 键 = `douban_ref`, 值只用于展示与排查 —— 守卫不看值(池消费式)。
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct NoResubEntry {
    /// 当时命中的 TMDB 订阅引用(`tmdb:<media_type>:<id>`)。
    #[serde(skip_serializing_if = "String::is_empty")]
    pub tmdb_ref: String,
    /// 历史里记下的宿主 intent id。
    #[serde(skip_serializing_if = "crate::model::is_zero_i64")]
    pub intent_id: i64,
    /// 墓碑建立时间(RFC3339)。
    #[serde(skip_serializing_if = "String::is_empty")]
    pub at: String,
    /// 人类可读原因(进日志, 也给 UI 看)。
    #[serde(skip_serializing_if = "String::is_empty")]
    pub reason: String,
}

/// 墓碑集的类型别名(= 状态文档里 `no_resub` 字段的形态)。
pub type NoResubMap = GoMap<String, NoResubEntry>;

/// 在榜单快照里按 `douban_ref` 找标题(功能 2 的日志兜底, 纯函数)。
fn snapshot_title(snapshot: &crate::model::Snapshot, douban_ref: &str) -> Option<String> {
    let lists = snapshot.lists.as_ref()?;
    for items in lists.values() {
        for chart in items.iter().flatten() {
            if chart.douban_ref == douban_ref {
                return Some(chart.title.clone());
            }
        }
    }
    None
}

impl Runtime {
    /// **功能 2 的唯一过滤器入口**: `allowed = false` 时调用方写日志、标
    /// `state = `[`FILTERED_QUEUE_STATE`], **不走 `needs_review`**。
    ///
    /// 判定顺序(已冻结; 三项都满足才放行):
    /// 1. `min_rating > 0` 且 `rating` 为 `None` 或 `< min_rating` → 拦(原因见 [`reason_rating`]);
    /// 2. `min_year > 0` 且 `year` 解析不出或 `< min_year` → 拦(见 [`reason_year`]);
    /// 3. `regions` 非空: `countries == None` → **放行** + `region_skipped = true`
    ///    (deviations 第 1 条); `Some([])` → 拦(详情取到但没有地区数据);
    ///    `Some(list)` → 白名单与列表**任一精确相等**才放行。
    ///
    /// 纯判定: 不落盘、不写日志; `region_skipped` 的 warning 由**调用方**记
    /// ([`region_degraded_log`]), 保持本函数可在无宿主环境下单测。
    pub fn can_subscribe(&self, item: &SubscriptionCandidate<'_>) -> FilterDecision {
        let settings = &self.settings;
        // ① 评分: 0 = 不限; None(无评分/解析不出)按"低于阈值"处理(deviations 第 2 条)
        if settings.min_rating > 0.0 {
            let pass = matches!(item.rating, Some(value) if value >= settings.min_rating);
            if !pass {
                return FilterDecision {
                    allowed: false,
                    reason: Some(reason_rating(item.rating, settings.min_rating)),
                    region_skipped: false,
                };
            }
        }
        // ② 年份: 数值比较(不是字符串序), 解析不出按"低于阈值"(deviations 第 4 条)
        if settings.min_year > 0 {
            let year = item.year.and_then(parse_year);
            let pass = matches!(year, Some(value) if value >= settings.min_year);
            if !pass {
                return FilterDecision {
                    allowed: false,
                    reason: Some(reason_year(year, settings.min_year)),
                    region_skipped: false,
                };
            }
        }
        // ③ 地区: 空 = 不限; None(详情没取到)= 降级放行(deviations 第 1 条)
        let regions = settings.regions.as_deref().unwrap_or(&[]);
        if !regions.is_empty() {
            return match item.countries {
                None => FilterDecision {
                    allowed: true,
                    reason: None,
                    region_skipped: true,
                },
                Some(countries) => {
                    if regions_match(countries, regions) {
                        FilterDecision {
                            allowed: true,
                            reason: None,
                            region_skipped: false,
                        }
                    } else {
                        FilterDecision {
                            allowed: false,
                            reason: Some(reason_region(countries, regions)),
                            region_skipped: false,
                        }
                    }
                }
            };
        }
        FilterDecision {
            allowed: true,
            reason: None,
            region_skipped: false,
        }
    }

    /// 把队列里的条目记成"被过滤"(功能 2 的副作用): `state = `[`FILTERED_QUEUE_STATE`]
    /// + `last_error = reason` + 一条 `info` 日志 `已过滤自动订阅：<title>（<reason>）`。
    ///
    /// **只标队列里已有的条目**: 找不到就只写日志(候选可能来自 wish 内联订阅的局部条目;
    /// `process_due` 的调用点上队列已被 `take()` 走, 条目由调用方在自己手里的副本上标)。
    /// 日志标题依次取队列条目 → 榜单快照 → `douban_ref` 本身。
    pub fn mark_queue_item_filtered(&mut self, douban_ref: &str, reason: &str) {
        let mut title = String::new();
        if let Some(items) = self.queue.items.as_mut() {
            for entry in items.iter_mut() {
                if entry.douban_ref == douban_ref {
                    entry.state = FILTERED_QUEUE_STATE.to_string();
                    entry.last_error = reason.to_string();
                    if title.is_empty() {
                        title = entry.title.clone();
                    }
                }
            }
        }
        if title.is_empty() {
            // 队列已被 take() 的场景(process_due): 退回榜单快照找标题
            if let Some(snapshot_title) = snapshot_title(&self.snapshot, douban_ref) {
                title = snapshot_title;
            }
        }
        let subject = if title.is_empty() {
            douban_ref.to_string()
        } else {
            title
        };
        self.log("info", &format!("已过滤自动订阅：{subject}（{reason}）"));
    }

    /// [`QueueItem`] 上的评分视图: 入队时带上的 `rating`(`0` = 未知 → `None`)。
    ///
    /// chart 入队取 `ChartItem::rate` 的解析值、wish 入队取 `subject.rating.value`
    /// (见 `charts.rs` / `wish.rs` 的入队点), 到期判定直接用它, 不回查快照/想看列表。
    pub fn queue_item_rating(item: &QueueItem) -> Option<f64> {
        if item.rating > 0.0 {
            Some(item.rating)
        } else {
            None
        }
    }

    /// 读取墓碑集(功能 3)。
    pub fn no_resub(&self) -> NoResubMap {
        self.no_resub.clone()
    }

    /// 墓碑条数(功能 3, 给 UI 的"已删除不重订：N 条"用)。
    pub fn no_resub_count(&self) -> i64 {
        self.no_resub.as_ref().map_or(0, |map| map.len() as i64)
    }

    /// **自动路径的墓碑守卫**(功能 3): `Some(message)` = 已拦截, 调用方**不要**再订阅。
    ///
    /// **只看墓碑键**: 墓碑只在写入时验证过"历史里有该条目的合格订阅记录"
    /// ([`Runtime::resolve_no_resub_from_history`] 的第 1 条), 这个事实必须独立于历史
    /// 存续 —— 历史会被 `archive()` 整体清空([`crate::runtime::Runtime::archive`])、
    /// 也会被 [`crate::subscribe::Runtime::add_history`] 按 `max_history` 截断, 守卫若
    /// 回查历史, 归档/截断后墓碑就守不住 → 自动路径重订已删除条目。不读墓碑值。
    /// **自动路径永不重订**; 返回值就是调用方要记的那条日志。
    pub fn no_resub_guard(&self, item: &SubscriptionCandidate<'_>) -> Option<String> {
        let map = self.no_resub.as_ref()?;
        if map.contains_key(item.douban_ref) {
            Some(no_resub_guard_message(item.title))
        } else {
            None
        }
    }

    /// **手动入口的墓碑确认**(功能 3): `Some(text)` = 该条目在墓碑集里, **不拦**, 由调用方
    /// 把 [`NO_RESUB_CONFIRM_TEXT`] 放进 action 响应让 UI 二次确认。
    pub fn no_resub_confirmation(&self, douban_ref: &str) -> Option<String> {
        let map = self.no_resub.as_ref()?;
        if map.contains_key(douban_ref) {
            Some(NO_RESUB_CONFIRM_TEXT.to_string())
        } else {
            None
        }
    }

    /// 写一条墓碑(功能 3 的低层写入口, 供判定流程与 `no-resub-clear` 之后的手工补录用)。
    ///
    /// `entry.intent_id`/`tmdb_ref` 抄进墓碑值; `at` 取 `clock::now_rfc3339()`; 已存在同
    /// `douban_ref` 时不覆盖(返回 `false`), 并 `touch()` 让状态版本号 +1。
    /// 不主动落盘 —— 判定流程挂在 `wish-sync` job 上, 由它统一 `persist_all()`。
    pub fn record_no_resub(&mut self, entry: &HistoryEntry, reason: &str) -> bool {
        if entry.douban_ref.is_empty() {
            return false;
        }
        let inserted;
        {
            let map = self
                .no_resub
                .get_or_insert_with(std::collections::BTreeMap::new);
            if map.contains_key(&entry.douban_ref) {
                inserted = false;
            } else {
                map.insert(
                    entry.douban_ref.clone(),
                    NoResubEntry {
                        tmdb_ref: entry.tmdb_ref.clone(),
                        intent_id: entry.intent_id,
                        at: clock::now_rfc3339(),
                        reason: reason.to_string(),
                    },
                );
                inserted = true;
            }
        }
        self.touch();
        inserted
    }

    /// 扫描历史, 把"订阅成功过但宿主池已查不到"的条目写进墓碑集(功能 3 的判定流程本体)。
    ///
    /// 返回本次新增的墓碑条数; 宿主调用失败时返回 0 且不写(模块头"判定流程"第 5 条),
    /// 每条新墓碑记一条 `info` 日志。同一 `douban_ref` 只看**最新**一条合格历史。
    pub fn resolve_no_resub_from_history(&mut self) -> i64 {
        let intents = match self.host_pool_intents() {
            Some(intents) => intents,
            None => {
                self.log("warning", "宿主订阅池查询失败，跳过「已删除不重订」判定");
                return 0;
            }
        };
        // 池查询可能被 `HOST_POOL_INTENTS_LIMIT` 截断: 返回条数达到上限时, "查不到"
        // 不再等价于"已被删除"(第 201 条起的订阅根本不在返回里)。此时按第 5 条
        // "宁可漏判不可误判"跳过本轮 —— 否则仍存在的订阅会被误写成需要手动
        // `no-resub-clear` 才能解除的持久墓碑。
        if intents.len() >= crate::subscribe::HOST_POOL_INTENTS_LIMIT {
            self.log(
                "warning",
                &format!(
                    "宿主订阅池返回条数达查询上限（{} 条），可能被截断，跳过「已删除不重订」判定",
                    intents.len()
                ),
            );
            return 0;
        }
        // 候选: 历史是最新在前, 每个 `douban_ref` 只收**第一条合格**记录。
        // 先判合格、后去重: 不合格的记录(如最新一条是 failed)不占去重名额,
        // 否则同 ref 更早的成功记录会被吞掉 → 该 ref 永远写不进墓碑(漏判)。
        let mut candidates: Vec<HistoryEntry> = Vec::new();
        let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for entry in self.history.as_deref().unwrap_or(&[]) {
            if entry.douban_ref.is_empty() || !history_entry_qualifies(entry) {
                continue;
            }
            if !seen.insert(entry.douban_ref.clone()) {
                continue;
            }
            candidates.push(entry.clone());
        }
        let mut added: i64 = 0;
        for entry in &candidates {
            let Some((media_type, tmdb_id)) = parse_tmdb_ref(&entry.tmdb_ref) else {
                continue;
            };
            // 第 2 条: 池里还有同 (tmdb_id, media_type) 的订阅 → 没被删
            if intents
                .iter()
                .any(|intent| intent.tmdb_id == tmdb_id && intent.media_type == media_type)
            {
                continue;
            }
            // 第 3 条: 同 tmdb_id 换了形态但已完成/已落地 → 不算删
            if intents
                .iter()
                .any(|intent| intent.tmdb_id == tmdb_id && intent_is_completed(&intent.state))
            {
                continue;
            }
            if self.record_no_resub(entry, NO_RESUB_REASON) {
                added += 1;
                self.log(
                    "info",
                    &format!(
                        "墓碑记录：{}（{}）的宿主订阅已消失，此后不再自动重订",
                        entry.title, entry.douban_ref
                    ),
                );
            }
        }
        added
    }

    /// 清空墓碑集(功能 3): action `no-resub-clear` 的落地函数。返回清掉的条数。
    pub fn prune_no_resub(&mut self) -> i64 {
        let count = self.no_resub_count();
        self.no_resub = None;
        self.persist_all();
        count
    }

    /// action `no-resub-clear`: `{"status":"succeeded","message":"已清除重订限制（N 条）"}`。
    ///
    /// 空墓碑集时也返回 `succeeded`(幂等; 文案 `已清除重订限制（0 条）`)。
    pub fn action_no_resub_clear(&mut self) -> Value {
        let count = self.prune_no_resub();
        let message = format!("已清除重订限制（{count} 条）");
        self.bump("succeeded", &message);
        serde_json::json!({"status": "succeeded", "message": message})
    }

    /// 墓碑扫描是否到期(功能 3, 模块头"判定流程"第 6 条的节流):
    /// 距上次扫描不足 [`NO_RESUB_SCAN_MIN_INTERVAL_NANOS`] 就跳过; 从未扫过 → 到期。
    pub fn no_resub_scan_due(&self) -> bool {
        match clock::parse_rfc3339(&self.no_resub_scan_at) {
            Some(last) => {
                clock::now_unix_nanos().saturating_sub(last) >= NO_RESUB_SCAN_MIN_INTERVAL_NANOS
            }
            None => true,
        }
    }

    /// `GET /api/subscribe/pool/intents?limit=`[`crate::subscribe::HOST_POOL_INTENTS_LIMIT`]
    /// 的**条目列表**(功能 3 用得上 `state`;
    /// [`crate::subscribe::Runtime::host_intent_exists`] 只回 `(bool, id)`, 不够判定)。
    ///
    /// 失败语义与 `host_intent_exists` 一致 —— 任何失败(host 错误 / HTTP >= 400 /
    /// 解析失败)**返回 `None`**, 调用方按"没查到"降级但**不**写墓碑。
    ///
    /// 注意返回**可能被 limit 截断**: 墓碑判定
    /// ([`Runtime::resolve_no_resub_from_history`])在条数达到上限时视为池视图不完整,
    /// 跳过本轮判定 —— "池里查不到"只有在查询完整时才等价于"已被删除"。
    pub fn host_pool_intents(&self) -> Option<Vec<PoolIntentEntry>> {
        let request = HostCallRequest::new("GET", &crate::subscribe::pool_intents_path())
            .with_header("accept", "application/json");
        let response = host::call(&request).ok()?;
        if response.status >= 400 {
            return None;
        }
        let body = store::decode_body(&response).ok()?;
        crate::model::decode::<PoolIntentListResult>(&body).map(|out| out.data)
    }
}
// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cookiecloud::test_support::{Route, TestHost};
    use crate::model::{Settings, Snapshot};
    use crate::raw::RawPayload;
    use serde_json::json;
    use std::collections::BTreeMap;

    /// 夹具里的时间常量: `2026-09-29T10:00:09Z`。
    const FIXED_NOW: u64 = 1_790_676_009_000_000_000;

    fn fixed_clock() {
        clock::testhooks::set_now(Some(FIXED_NOW));
    }

    fn cand<'a>(
        year: Option<&'a str>,
        rating: Option<f64>,
        countries: Option<&'a [String]>,
    ) -> SubscriptionCandidate<'a> {
        SubscriptionCandidate {
            douban_ref: "36808876",
            title: "奥德赛",
            kind: "movie",
            year,
            rating,
            countries,
        }
    }

    fn owned_countries(list: &[&str]) -> Option<Vec<String>> {
        Some(list.iter().map(|s| s.to_string()).collect())
    }

    fn log_messages(runtime: &Runtime) -> Vec<String> {
        runtime
            .logs
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|entry| entry.message)
            .collect()
    }

    fn history_entry(douban_ref: &str, tmdb_ref: &str, intent_id: i64) -> HistoryEntry {
        HistoryEntry {
            douban_ref: douban_ref.to_string(),
            tmdb_ref: tmdb_ref.to_string(),
            title: "标题".to_string(),
            action: "subscribe".to_string(),
            result: "succeeded".to_string(),
            message: "订阅成功".to_string(),
            intent_id,
            ..HistoryEntry::default()
        }
    }

    /// 历史写好 + 墓碑就位的最小运行时(不做任何宿主调用)。
    fn runtime_with_tombstone(douban_ref: &str, tmdb_ref: &str, intent_id: i64) -> Runtime {
        let mut runtime = Runtime::new();
        runtime.history = Some(vec![history_entry(douban_ref, tmdb_ref, intent_id)]);
        runtime.no_resub = Some(BTreeMap::from([(
            douban_ref.to_string(),
            NoResubEntry::default(),
        )]));
        runtime
    }

    // ─────────────────── 纯函数 ───────────────────

    #[test]
    fn parse_rate_and_year_cover_real_shapes() {
        // rate: 实测形态 "8.0" / "" / 非数字
        assert_eq!(parse_rate("8.0"), Some(8.0));
        assert_eq!(parse_rate(" 7.5 "), Some(7.5));
        assert_eq!(parse_rate(""), None, "口碑榜实测大量空串");
        assert_eq!(parse_rate("暂无评分"), None);
        assert_eq!(parse_rate("inf"), None, "解析出的必须有限");
        // year: 只认开头的十进制数字, 按数值比较
        assert_eq!(parse_year("2026"), Some(2026));
        assert_eq!(parse_year("2026-08-14"), Some(2026));
        assert_eq!(parse_year(""), None);
        assert_eq!(parse_year("暂无"), None);
        // 字符串序的坑: "9" > "10" 是字符串序, 数值序必须反过来
        assert_eq!(parse_year("9"), Some(9));
        assert_eq!(parse_year("10"), Some(10));
    }

    #[test]
    fn parse_tmdb_ref_accepts_only_wellformed_refs() {
        assert_eq!(
            parse_tmdb_ref("tmdb:movie:1077295"),
            Some(("movie", 1_077_295))
        );
        assert_eq!(parse_tmdb_ref("tmdb:tv:12"), Some(("tv", 12)));
        assert_eq!(parse_tmdb_ref(""), None);
        assert_eq!(
            parse_tmdb_ref("tmdb::5"),
            None,
            "空 media_type 没法与池比对, 不收"
        );
        assert_eq!(parse_tmdb_ref("tmdb:movie:x"), None);
        assert_eq!(parse_tmdb_ref("tmdb:movie:"), None);
        assert_eq!(parse_tmdb_ref("db:subj:5"), None);
        assert_eq!(parse_tmdb_ref("tmdb:movie"), None);
    }

    #[test]
    fn history_entry_qualifies_needs_success_and_intent() {
        let good = history_entry("36808876", "tmdb:movie:1077295", 171);
        assert!(history_entry_qualifies(&good));
        let mut entry = good.clone();
        entry.result = "failed".to_string();
        assert!(!history_entry_qualifies(&entry));
        let mut entry = good.clone();
        entry.intent_id = 0;
        assert!(!history_entry_qualifies(&entry));
        let mut entry = good.clone();
        entry.tmdb_ref = "tmdb:movie:x".to_string();
        assert!(!history_entry_qualifies(&entry));
        let mut entry = good;
        entry.action = "skip".to_string();
        assert!(!history_entry_qualifies(&entry));
    }

    #[test]
    fn regions_match_and_intent_completed() {
        let countries = vec!["美国".to_string(), "加拿大".to_string()];
        assert!(regions_match(&countries, &["加拿大".to_string()]));
        assert!(regions_match(
            &countries,
            &["法国".to_string(), "美国".to_string()]
        ));
        assert!(!regions_match(&countries, &["法国".to_string()]));
        assert!(
            !regions_match(&[], &["美国".to_string()]),
            "详情取到但没有地区数据 → 不命中"
        );
        assert!(intent_is_completed("landed") && intent_is_completed("caught_up"));
        assert!(!intent_is_completed("failed") && !intent_is_completed("expired"));
        assert!(!intent_is_completed("active"));
    }

    // ─────────────────── can_subscribe: 三参数命中/放行/边界 ───────────────────

    #[test]
    fn rating_filter_boundaries() {
        let mut runtime = Runtime::new();
        // 0 = 不限: 无评分也放行
        runtime.settings.min_rating = 0.0;
        assert!(
            runtime
                .can_subscribe(&cand(Some("2026"), None, None))
                .allowed
        );
        // min_rating = 8: 边界(恰好相等)放行
        runtime.settings.min_rating = 8.0;
        assert!(
            runtime
                .can_subscribe(&cand(Some("2026"), Some(8.0), None))
                .allowed
        );
        // 低于阈值 → 拦, 原因文案冻结
        let low = runtime.can_subscribe(&cand(Some("2026"), Some(7.9), None));
        assert!(!low.allowed);
        assert_eq!(low.reason.as_deref(), Some("评分不足（7.9 < 8.0）"));
        // 无评分(min_rating > 0)按低于阈值处理(deviations 第 2 条)
        let none = runtime.can_subscribe(&cand(Some("2026"), None, None));
        assert!(!none.allowed);
        assert_eq!(
            none.reason.as_deref(),
            Some("无评分条目按低于阈值处理（疑似无数据, min_rating=8.0）")
        );
    }

    #[test]
    fn year_filter_boundaries() {
        let mut runtime = Runtime::new();
        // 0 = 不限: 解析不出的年份也放行
        runtime.settings.min_year = 0;
        assert!(
            runtime
                .can_subscribe(&cand(Some("garbage"), None, None))
                .allowed
        );
        assert!(runtime.can_subscribe(&cand(None, None, None)).allowed);
        runtime.settings.min_year = 2020;
        // 边界: 恰好相等放行
        assert!(
            runtime
                .can_subscribe(&cand(Some("2020"), None, None))
                .allowed
        );
        // 数值比较而不是字符串序: "9" < 2020, "2026" >= 2020
        assert!(!runtime.can_subscribe(&cand(Some("9"), None, None)).allowed);
        assert!(
            runtime
                .can_subscribe(&cand(Some("2026-08-14"), None, None))
                .allowed
        );
        // 拦 + 冻结文案
        let old = runtime.can_subscribe(&cand(Some("2019"), None, None));
        assert!(!old.allowed);
        assert_eq!(old.reason.as_deref(), Some("年份不足（2019 < 2020）"));
        let missing = runtime.can_subscribe(&cand(Some(""), None, None));
        assert!(!missing.allowed);
        assert_eq!(
            missing.reason.as_deref(),
            Some("无年份条目按低于阈值处理（min_year=2020）")
        );
    }

    #[test]
    fn regions_filter_matrix() {
        let mut runtime = Runtime::new();
        runtime.settings.regions = Some(vec!["美国".to_string()]);
        // 详情没取到 → 降级放行 + region_skipped(deviations 第 1 条)
        let skipped = runtime.can_subscribe(&cand(Some("2026"), None, None));
        assert!(skipped.allowed && skipped.region_skipped);
        // 详情取到但没有地区数据 → 拦
        let empty = runtime.can_subscribe(&cand(Some("2026"), None, Some(&[])));
        assert!(!empty.allowed);
        assert_eq!(
            empty.reason.as_deref(),
            Some("地区不符（无地区数据 ∉ 美国）")
        );
        // 任一精确相等 → 放行
        let hit = runtime.can_subscribe(&cand(
            Some("2026"),
            None,
            owned_countries(&["加拿大", "美国"]).as_deref(),
        ));
        assert!(hit.allowed && !hit.region_skipped);
        // 全不命中 → 拦
        let miss = runtime.can_subscribe(&cand(
            Some("2026"),
            None,
            owned_countries(&["意大利"]).as_deref(),
        ));
        assert!(!miss.allowed);
        assert_eq!(miss.reason.as_deref(), Some("地区不符（意大利 ∉ 美国）"));
        // 空白名单 = 不限: 详情没取到也不算降级
        runtime.settings.regions = Some(Vec::new());
        let unlimited = runtime.can_subscribe(&cand(Some("2026"), None, None));
        assert!(unlimited.allowed && !unlimited.region_skipped);
        runtime.settings.regions = None;
        let unlimited = runtime.can_subscribe(&cand(Some("2026"), None, None));
        assert!(unlimited.allowed && !unlimited.region_skipped);
    }

    #[test]
    fn rating_fails_before_region_short_circuit() {
        let mut runtime = Runtime::new();
        runtime.settings.min_rating = 8.0;
        runtime.settings.regions = Some(vec!["美国".to_string()]);
        // 评分先拦: region_skipped 不该被置位(地区判定根本没走到)
        let decision = runtime.can_subscribe(&cand(None, None, None));
        assert!(!decision.allowed && !decision.region_skipped);
        assert_eq!(
            decision.reason.as_deref(),
            Some("无评分条目按低于阈值处理（疑似无数据, min_rating=8.0）")
        );
    }

    // ─────────────────── mark_queue_item_filtered ───────────────────

    #[test]
    fn mark_queue_item_filtered_marks_and_logs() {
        let mut runtime = Runtime::new();
        runtime.queue.items = Some(vec![QueueItem {
            douban_ref: "36808876".to_string(),
            title: "奥德赛".to_string(),
            state: "observing".to_string(),
            ..QueueItem::default()
        }]);
        runtime.mark_queue_item_filtered("36808876", "评分不足（7.9 < 8.0）");
        let item = &runtime.queue.items.as_ref().unwrap()[0];
        assert_eq!(item.state, "filtered");
        assert_eq!(item.last_error, "评分不足（7.9 < 8.0）");
        assert_eq!(
            log_messages(&runtime),
            vec!["已过滤自动订阅：奥德赛（评分不足（7.9 < 8.0））".to_string()]
        );

        // 队列里没有的 ref: 只写日志(标识用 ref 本身)
        runtime.mark_queue_item_filtered("999", "评分不足（7.9 < 8.0）");
        assert_eq!(
            log_messages(&runtime)[1],
            "已过滤自动订阅：999（评分不足（7.9 < 8.0））"
        );
        assert_eq!(runtime.queue.items.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn queue_item_rating_zero_is_unknown() {
        let mut item = QueueItem::default();
        assert_eq!(Runtime::queue_item_rating(&item), None, "0 = 未知");
        item.rating = 8.6;
        assert_eq!(Runtime::queue_item_rating(&item), Some(8.6));
    }

    // ─────────────────── 墓碑集: 进入 ───────────────────

    #[test]
    fn record_no_resub_dedupes_and_copies_entry_values() {
        fixed_clock();
        let mut runtime = Runtime::new();
        let entry = history_entry("36808876", "tmdb:movie:1077295", 171);
        assert!(runtime.record_no_resub(&entry, NO_RESUB_REASON));
        let map = runtime.no_resub.clone().unwrap();
        let tomb = &map["36808876"];
        assert_eq!(tomb.tmdb_ref, "tmdb:movie:1077295");
        assert_eq!(tomb.intent_id, 171);
        assert_eq!(tomb.at, "2026-09-29T10:00:09Z", "at 取固定时钟");
        assert_eq!(tomb.reason, "宿主已无该 tmdb 订阅");
        // 已存在 → 不覆盖, 仍 touch
        let revision = runtime.revision();
        assert!(!runtime.record_no_resub(&entry, "另外的原因"));
        assert_eq!(runtime.no_resub_count(), 1);
        assert_eq!(
            runtime.no_resub.clone().unwrap()["36808876"].reason,
            NO_RESUB_REASON
        );
        assert!(runtime.revision() > revision, "重复写也要 bump 版本号");
        // 空 douban_ref 拒收
        assert!(!runtime.record_no_resub(&history_entry("", "tmdb:movie:1", 1), NO_RESUB_REASON));
    }

    #[test]
    fn host_pool_intents_parses_or_none() {
        let host = TestHost::install(vec![Route::json(
            "GET",
            "/api/subscribe/pool/intents",
            r#"{"code":"ok","data":[
                {"id":171,"tmdb_id":1077295,"media_type":"movie","title":"奥德赛","state":"active"},
                {"id":172,"tmdb_id":200,"media_type":"tv","title":"别的","state":"landed"}]}"#,
        )]);
        let runtime = Runtime::new();
        let intents = runtime.host_pool_intents().expect("正常响应必须解出");
        assert_eq!(intents.len(), 2);
        assert_eq!(intents[0].id, 171);
        assert_eq!(intents[0].tmdb_id, 1_077_295);
        assert_eq!(intents[0].media_type, "movie");
        assert_eq!(intents[0].state, "active");
        assert_eq!(
            host.last_path("GET", "/api/subscribe/pool/intents")
                .as_deref(),
            Some("/api/subscribe/pool/intents?limit=200")
        );
        drop(host);

        // 三种失败(host 错误 / HTTP >= 400 / 解析失败)都 → None
        for route in [
            Route::fail("GET", "/api/subscribe/pool/intents"),
            Route::new("GET", "/api/subscribe/pool/intents", 502, b""),
            Route::json("GET", "/api/subscribe/pool/intents", "not json"),
        ] {
            let _host = TestHost::install(vec![route]);
            let runtime = Runtime::new();
            assert!(runtime.host_pool_intents().is_none());
        }
    }

    #[test]
    fn resolve_writes_tombstones_only_for_vanished_subscriptions() {
        fixed_clock();
        // 池里: (1077295, movie) 还在; (200, tv) 换成了 movie 且已完成
        let host = TestHost::install(vec![Route::json(
            "GET",
            "/api/subscribe/pool/intents",
            r#"{"code":"ok","data":[
                {"id":1,"tmdb_id":1077295,"media_type":"movie","state":"active"},
                {"id":2,"tmdb_id":200,"media_type":"tv","state":"landed"}]}"#,
        )]);
        let mut runtime = Runtime::new();
        runtime.history = Some(vec![
            // A: 还在池里 → 不写
            history_entry("still_there", "tmdb:movie:1077295", 9),
            // C: (200, movie) 不在池里, 但同 tmdb_id 的 tv 已 landed → 非删除
            history_entry("completed_other_type", "tmdb:movie:200", 8),
            // D: 池里彻底没有 → 写墓碑
            history_entry("vanished", "tmdb:movie:300", 7),
            // E/F/G: 不合格候选(failed / 无 intent / 坏 ref)
            history_entry("failed_one", "tmdb:movie:400", 6),
            history_entry("no_intent", "tmdb:movie:500", 0),
            history_entry("bad_ref", "tmdb:movie:xxx", 5),
        ]);
        runtime.history.as_mut().unwrap()[3].result = "failed".to_string();

        let added = runtime.resolve_no_resub_from_history();
        assert_eq!(added, 1, "只有 vanished 该写");
        assert_eq!(runtime.no_resub_count(), 1);
        let map = runtime.no_resub.clone().unwrap();
        assert!(map.contains_key("vanished"));
        assert!(!map.contains_key("still_there"));
        assert!(!map.contains_key("completed_other_type"));
        let tomb = &map["vanished"];
        assert_eq!(tomb.intent_id, 7);
        assert_eq!(tomb.tmdb_ref, "tmdb:movie:300");
        assert_eq!(tomb.reason, NO_RESUB_REASON);
        let messages = log_messages(&runtime);
        assert!(
            messages
                .iter()
                .any(|m| m.contains("墓碑记录：标题（vanished）")),
            "{messages:?}"
        );
        drop(host);

        // 幂等: 同样的池数据再跑一遍不新增(已存在的墓碑不覆盖)
        let _host = TestHost::install(vec![Route::json(
            "GET",
            "/api/subscribe/pool/intents",
            r#"{"code":"ok","data":[
                {"id":1,"tmdb_id":1077295,"media_type":"movie","state":"active"},
                {"id":2,"tmdb_id":200,"media_type":"tv","state":"landed"}]}"#,
        )]);
        assert_eq!(runtime.resolve_no_resub_from_history(), 0);
        assert_eq!(runtime.no_resub_count(), 1);
    }

    #[test]
    fn resolve_swallows_host_failures_and_writes_nothing() {
        fixed_clock();
        for route in [
            Route::fail("GET", "/api/subscribe/pool/intents"),
            Route::new("GET", "/api/subscribe/pool/intents", 500, b""),
            Route::json("GET", "/api/subscribe/pool/intents", "not json"),
        ] {
            let _host = TestHost::install(vec![route]);
            let mut runtime = Runtime::new();
            runtime.history = Some(vec![history_entry("vanished", "tmdb:movie:300", 7)]);
            assert_eq!(runtime.resolve_no_resub_from_history(), 0, "失败一律不写");
            assert!(runtime.no_resub.is_none(), "宁可漏判不可误判");
            let messages = log_messages(&runtime);
            assert!(
                messages.iter().any(|m| m.contains("宿主订阅池查询失败")),
                "{messages:?}"
            );
        }
    }

    /// 去重发生在**合格判定之后**: 同一 ref 最新一条历史若是 failed, 更早的成功记录
    /// 仍要入选("只看最新一条**合格**记录"), 否则该 ref 永远写不进墓碑(漏判)。
    #[test]
    fn resolve_qualifies_before_dedup_uses_older_success() {
        fixed_clock();
        let _host = TestHost::install(vec![Route::json(
            "GET",
            "/api/subscribe/pool/intents",
            r#"{"code":"ok","data":[]}"#,
        )]);
        let mut runtime = Runtime::new();
        let mut newest = history_entry("dup_ref", "tmdb:movie:300", 0);
        newest.result = "failed".to_string();
        let older = history_entry("dup_ref", "tmdb:movie:300", 7);
        runtime.history = Some(vec![newest, older]);

        assert_eq!(
            runtime.resolve_no_resub_from_history(),
            1,
            "failed 的最新记录不占去重名额, 更早的成功记录仍入选"
        );
        let map = runtime.no_resub.clone().unwrap();
        assert_eq!(map["dup_ref"].intent_id, 7, "墓碑值取自合格(成功)记录");
    }

    /// 池查询返回条数达到 [`crate::subscribe::HOST_POOL_INTENTS_LIMIT`] 上限 → 视图
    /// 可能被截断("查不到"≠"已删除"), 本轮跳过判定, 不写任何墓碑。
    #[test]
    fn resolve_skips_scan_when_pool_hits_query_limit() {
        fixed_clock();
        let mut entries = String::new();
        for index in 0..crate::subscribe::HOST_POOL_INTENTS_LIMIT {
            if index > 0 {
                entries.push(',');
            }
            entries.push_str(&format!(
                r#"{{"id":{index},"tmdb_id":900000,"media_type":"movie","state":"active"}}"#
            ));
        }
        let _host = TestHost::install(vec![Route::json(
            "GET",
            "/api/subscribe/pool/intents",
            &format!(r#"{{"code":"ok","data":[{entries}]}}"#),
        )]);
        let mut runtime = Runtime::new();
        runtime.history = Some(vec![history_entry("vanished", "tmdb:movie:300", 7)]);

        assert_eq!(runtime.resolve_no_resub_from_history(), 0, "达上限一律不写");
        assert!(runtime.no_resub.is_none(), "宁可漏判不可误判");
        let messages = log_messages(&runtime);
        assert!(
            messages.iter().any(|m| m.contains("可能被截断")),
            "{messages:?}"
        );
    }

    // ─────────────────── 墓碑集: 跳过(守卫)与确认 ───────────────────

    #[test]
    fn no_resub_guard_blocks_on_tombstone_key_alone() {
        let candidate = cand(Some("2026"), None, None);
        // 墓碑 + 合格历史 → 拦, 文案带标题
        let runtime = runtime_with_tombstone("36808876", "tmdb:movie:1077295", 171);
        assert_eq!(
            runtime.no_resub_guard(&candidate).as_deref(),
            Some("已删除不重订，跳过自动订阅：奥德赛")
        );
        // 守卫不读墓碑值(池消费式): 空值也照样拦
        // (runtime_with_tombstone 塞的就是 NoResubEntry::default())

        // 只有墓碑, 历史为空(archive 后/被 max_history 截断)→ **照样拦**:
        // 墓碑写入时已验证过历史, 守卫回查历史的话归档/截断后自动路径会重订已删条目
        let mut runtime = Runtime::new();
        runtime.no_resub = Some(BTreeMap::from([(
            "36808876".to_string(),
            NoResubEntry::default(),
        )]));
        assert_eq!(
            runtime.no_resub_guard(&candidate).as_deref(),
            Some("已删除不重订，跳过自动订阅：奥德赛")
        );
        // 历史里只有**不合格**记录(intent_id = 0, 判定流程第 1 条不满足)也拦
        runtime.history = Some(vec![history_entry("36808876", "tmdb:movie:1077295", 0)]);
        assert!(runtime.no_resub_guard(&candidate).is_some());

        // 只有历史, 没有墓碑 → 不拦(池里还在的条目走不到墓碑)
        let mut runtime = Runtime::new();
        runtime.history = Some(vec![history_entry("36808876", "tmdb:movie:1077295", 171)]);
        assert!(runtime.no_resub_guard(&candidate).is_none());

        // 墓碑键对不上(别的条目) → 不拦
        let runtime = runtime_with_tombstone("999", "tmdb:movie:1", 1);
        assert!(runtime.no_resub_guard(&candidate).is_none());
    }

    #[test]
    fn no_resub_confirmation_hits_tombstone_only() {
        let runtime = runtime_with_tombstone("36808876", "tmdb:movie:1077295", 171);
        assert_eq!(
            runtime.no_resub_confirmation("36808876").as_deref(),
            Some(NO_RESUB_CONFIRM_TEXT)
        );
        assert_eq!(runtime.no_resub_confirmation("999"), None);
        assert_eq!(Runtime::new().no_resub_confirmation("36808876"), None);
    }

    // ─────────────────── 墓碑集: 清除 ───────────────────

    #[test]
    fn prune_clears_and_persists() {
        fixed_clock();
        let host = TestHost::install(vec![]);
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let entry = history_entry("36808876", "tmdb:movie:1077295", 171);
        let _ = runtime.record_no_resub(&entry, NO_RESUB_REASON);
        let _ = runtime.record_no_resub(&history_entry("other", "tmdb:tv:5", 6), NO_RESUB_REASON);
        assert_eq!(runtime.no_resub_count(), 2);

        assert_eq!(runtime.prune_no_resub(), 2);
        assert_eq!(runtime.no_resub_count(), 0);
        assert!(runtime.no_resub.is_none());
        // 落盘文档里 no_resub 已消失(omitempty: 空 → 键不出现)
        let request = host
            .requests()
            .into_iter()
            .rev()
            .find(|request| request.method == "PUT" && request.path.ends_with("/storage/state"))
            .expect("必须落盘");
        let raw = crate::store::decode_body(&crate::host::HostCallResponse {
            status: 200,
            headers: Default::default(),
            body_base64: request.body_base64,
        })
        .unwrap();
        let text = String::from_utf8(raw).unwrap();
        assert!(!text.contains("\"no_resub\""), "{text}");
        // 空墓碑再清一次 → 0(幂等)
        assert_eq!(runtime.prune_no_resub(), 0);
    }

    #[test]
    fn action_no_resub_clear_reports_count() {
        fixed_clock();
        let _host = TestHost::install(vec![]);
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let payload = json!({"id": "no-resub-clear"});
        let result = runtime
            .action("inv_1", RawPayload::Value(&payload))
            .expect("payload 合法");
        assert_eq!(
            result,
            json!({"status": "succeeded", "message": "已清除重订限制（0 条）"}),
            "空墓碑集也 succeeded(幂等)"
        );

        let entry = history_entry("36808876", "tmdb:movie:1077295", 171);
        let _ = runtime.record_no_resub(&entry, NO_RESUB_REASON);
        let result = runtime
            .action("inv_2", RawPayload::Value(&payload))
            .unwrap();
        assert_eq!(
            result,
            json!({"status": "succeeded", "message": "已清除重订限制（1 条）"})
        );
        assert_eq!(runtime.no_resub_count(), 0);
        // bump 过的 last_message 经 state_doc 暴露(字段本身是 runtime 模块私有)
        assert_eq!(
            runtime.state_doc()["last_message"],
            json!("已清除重订限制（1 条）")
        );
    }

    // ─────────────────── 接线: process_due(自动路径) ───────────────────

    fn queue_item(douban_ref: &str, title: &str, rating: f64, year: &str) -> QueueItem {
        QueueItem {
            douban_ref: douban_ref.to_string(),
            title: title.to_string(),
            list: "wish".to_string(),
            rating,
            year: year.to_string(),
            state: "observing".to_string(),
            due_at: "2026-09-29T09:00:00Z".to_string(),
            ..QueueItem::default()
        }
    }

    /// TMDB 直配成功 + 空池 + 创建成功的标准替身(与 subscribe.rs 的 subscribe_host 同款)。
    fn subscribe_host() -> TestHost {
        TestHost::install(vec![
            Route::json(
                "GET",
                "/api/tmdb/search",
                r#"{"results":[{"id":1077295,"title":"奥德赛","media_type":"movie","vote_average":7.4}]}"#,
            ),
            Route::json(
                "GET",
                "/api/subscribe/pool/intents",
                r#"{"code":"ok","data":[]}"#,
            ),
            Route::json(
                "POST",
                "/api/subscribe/pool/intents",
                r#"{"code":"ok","data":{"id":171}}"#,
            ),
        ])
    }

    #[test]
    fn process_due_marks_tombstoned_item_terminal() {
        fixed_clock();
        let host = subscribe_host();
        let mut runtime = runtime_with_tombstone("36808876", "tmdb:movie:1077295", 171);
        runtime.queue.items = Some(vec![queue_item("36808876", "奥德赛", 0.0, "2026")]);

        let (subscribed, needs_review, _) = runtime.process_due("inv", &Settings::EMPTY);
        assert_eq!((subscribed, needs_review), (0, 0));
        // 不发 TMDB/创建请求: 墓碑守卫在匹配之前
        assert_eq!(host.count("GET", "/api/tmdb/search"), 0);
        assert_eq!(host.count("POST", "/api/subscribe/pool/intents"), 0);
        let kept = &runtime.queue.items.as_ref().unwrap()[0];
        assert_eq!(kept.state, NO_RESUB_QUEUE_STATE);
        assert_eq!(kept.last_error, "已删除不重订，跳过自动订阅：奥德赛");
        assert_eq!(
            log_messages(&runtime),
            vec!["已删除不重订，跳过自动订阅：奥德赛".to_string()]
        );

        // 终态保留: 再来一轮不重判、不重记日志、不重订阅
        let logs_before = log_messages(&runtime).len();
        let (subscribed, needs_review, _) = runtime.process_due("inv", &Settings::EMPTY);
        assert_eq!((subscribed, needs_review), (0, 0));
        assert_eq!(log_messages(&runtime).len(), logs_before, "终态不再守卫");
        assert_eq!(
            runtime.queue.items.as_ref().unwrap()[0].state,
            NO_RESUB_QUEUE_STATE
        );
    }

    #[test]
    fn process_due_marks_filtered_item_terminal() {
        fixed_clock();
        let host = subscribe_host();
        let mut runtime = Runtime::new();
        runtime.settings.min_rating = 8.0;
        // 评分 7.9 → 评分不足; 评分缺失(0) → 无评分口径; 8.0 → 放行去订阅
        runtime.queue.items = Some(vec![
            queue_item("low", "低分片", 7.9, "2026"),
            queue_item("no-rating", "无评分片", 0.0, "2026"),
            queue_item("ok", "奥德赛", 8.0, "2026"),
        ]);
        let (subscribed, needs_review, _) = runtime.process_due("inv", &runtime.settings.clone());
        assert_eq!((subscribed, needs_review), (1, 0), "只有过线的那条被订阅");
        assert_eq!(host.count("POST", "/api/subscribe/pool/intents"), 1);
        let items = runtime.queue.items.as_ref().unwrap();
        let low = items.iter().find(|item| item.douban_ref == "low").unwrap();
        assert_eq!(low.state, FILTERED_QUEUE_STATE);
        assert_eq!(low.last_error, "评分不足（7.9 < 8.0）");
        let no_rating = items
            .iter()
            .find(|item| item.douban_ref == "no-rating")
            .unwrap();
        assert_eq!(no_rating.state, FILTERED_QUEUE_STATE);
        assert_eq!(
            no_rating.last_error,
            "无评分条目按低于阈值处理（疑似无数据, min_rating=8.0）"
        );
        let messages = log_messages(&runtime);
        // process_due 里队列已被 take()、快照为空 → 日志标题退回 douban_ref
        assert!(
            messages.contains(&"已过滤自动订阅：low（评分不足（7.9 < 8.0））".to_string()),
            "{messages:?}"
        );
        assert!(
            messages.contains(
                &"已过滤自动订阅：no-rating（无评分条目按低于阈值处理（疑似无数据, min_rating=8.0））"
                    .to_string()
            ),
            "{messages:?}"
        );

        // 终态保留: 再来一轮不再重判
        let logs_before = messages.len();
        let (subscribed, needs_review, _) = runtime.process_due("inv", &runtime.settings.clone());
        assert_eq!((subscribed, needs_review), (0, 0));
        assert_eq!(log_messages(&runtime).len(), logs_before);
    }

    #[test]
    fn process_due_degrades_region_and_logs_warning() {
        fixed_clock();
        let host = subscribe_host();
        let mut runtime = Runtime::new();
        runtime.settings.regions = Some(vec!["美国".to_string()]);
        runtime.queue.items = Some(vec![queue_item("36808876", "奥德赛", 8.0, "2026")]);
        let (subscribed, needs_review, _) = runtime.process_due("inv", &runtime.settings.clone());
        assert_eq!(
            (subscribed, needs_review),
            (1, 0),
            "详情未取到 → 放行(deviation 1)"
        );
        let messages = log_messages(&runtime);
        assert!(
            messages.contains(&"地区过滤降级: 详情未取到，跳过地区判定（奥德赛）".to_string()),
            "{messages:?}"
        );
    }

    // ─────────────────── 接线: 手动入口 ───────────────────

    #[test]
    fn subscribe_now_applies_filter_but_not_tombstone() {
        fixed_clock();
        // 过滤器拦手动订阅: failed + 原因, 队列标 filtered, 不写 needs_review 历史
        let _host = subscribe_host();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        runtime.settings.min_rating = 8.0;
        runtime.queue.items = Some(vec![queue_item("36808876", "奥德赛", 5.9, "2026")]);
        let result = runtime.subscribe_queue_now("inv", "36808876").unwrap();
        assert_eq!(
            result,
            json!({"status": "failed", "message": "评分不足（5.9 < 8.0）"})
        );
        let item = &runtime.queue.items.as_ref().unwrap()[0];
        assert_eq!(item.state, FILTERED_QUEUE_STATE);
        assert!(runtime.history.is_none(), "过滤不写历史");
        assert_eq!(
            log_messages(&runtime),
            vec!["已过滤自动订阅：奥德赛（评分不足（5.9 < 8.0））".to_string()]
        );
        drop(_host);

        // 墓碑不拦手动: 订阅照常成功, 响应里带确认文案
        let host = subscribe_host();
        let mut runtime = runtime_with_tombstone("36808876", "tmdb:movie:1077295", 171);
        runtime.ensure_loaded();
        runtime.queue.items = Some(vec![queue_item("36808876", "奥德赛", 8.0, "2026")]);
        let result = runtime.subscribe_queue_now("inv", "36808876").unwrap();
        assert_eq!(
            result,
            json!({
                "status": "succeeded",
                "message": "订阅成功",
                "intent_id": 171,
                "no_resub_confirm": NO_RESUB_CONFIRM_TEXT,
            })
        );
        assert_eq!(host.count("POST", "/api/subscribe/pool/intents"), 1);
        assert_eq!(runtime.queue.items.as_ref().unwrap()[0].state, "subscribed");
        drop(host);

        // 没有墓碑的条目: 响应不带确认键(与既有响应形态逐字段一致)
        let _host = subscribe_host();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        runtime.queue.items = Some(vec![queue_item("36808876", "奥德赛", 8.0, "2026")]);
        let result = runtime.subscribe_queue_now("inv", "36808876").unwrap();
        assert_eq!(
            result,
            json!({"status": "succeeded", "message": "订阅成功", "intent_id": 171})
        );
    }

    #[test]
    fn subscribe_from_snapshot_carries_tombstone_confirm() {
        fixed_clock();
        let host = subscribe_host();
        let mut runtime = runtime_with_tombstone("36808876", "tmdb:movie:1077295", 171);
        runtime.ensure_loaded();
        runtime.snapshot = Snapshot {
            fetched_at: String::new(),
            lists: Some(BTreeMap::from([(
                "hot".to_string(),
                Some(vec![ChartItem {
                    douban_ref: "36808876".to_string(),
                    title: "奥德赛".to_string(),
                    ..ChartItem::default()
                }]),
            )])),
        };
        let result = runtime.subscribe_from_snapshot("inv", "36808876").unwrap();
        assert_eq!(
            result,
            json!({
                "status": "succeeded",
                "message": "订阅成功",
                "intent_id": 171,
                "no_resub_confirm": NO_RESUB_CONFIRM_TEXT,
            }),
            "手动入口不拦墓碑, 只带确认文案"
        );
        drop(host);

        // 无墓碑 → 响应不带确认键
        let _host = subscribe_host();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        runtime.snapshot = Snapshot {
            fetched_at: String::new(),
            lists: Some(BTreeMap::from([(
                "hot".to_string(),
                Some(vec![ChartItem {
                    douban_ref: "36808876".to_string(),
                    title: "奥德赛".to_string(),
                    ..ChartItem::default()
                }]),
            )])),
        };
        let result = runtime.subscribe_from_snapshot("inv", "36808876").unwrap();
        assert_eq!(
            result,
            json!({"status": "succeeded", "message": "订阅成功", "intent_id": 171})
        );
    }

    // ─────────────────── job 挂载与节流 ───────────────────

    #[test]
    fn job_wish_sync_scans_history_and_throttles() {
        fixed_clock();
        let host = TestHost::install(vec![Route::json(
            "GET",
            "/api/subscribe/pool/intents",
            r#"{"code":"ok","data":[]}"#,
        )]);
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        runtime.history = Some(vec![history_entry("vanished", "tmdb:movie:300", 7)]);

        let payload = json!({"id": "wish-sync"});
        let result = runtime.job("inv", RawPayload::Value(&payload)).unwrap();
        assert_eq!(
            result,
            json!({"status": "accepted", "message": "想看与到期订阅已处理"})
        );
        assert_eq!(runtime.no_resub_count(), 1, "job 里完成一次墓碑判定");
        assert_eq!(runtime.no_resub_scan_at, "2026-09-29T10:00:09Z");
        assert_eq!(host.count("GET", "/api/subscribe/pool/intents"), 1);

        // 6 小时内再跑: 节流生效, 不再查池(用户就算重建了订阅也轮不到判定)
        runtime.no_resub = Some(BTreeMap::from([(
            "vanished".to_string(),
            NoResubEntry::default(),
        )]));
        let _ = runtime.job("inv", RawPayload::Value(&payload));
        assert_eq!(
            host.count("GET", "/api/subscribe/pool/intents"),
            1,
            "节流期内不再扫描"
        );

        // 超过 6 小时: 再扫描
        clock::testhooks::set_now(Some(
            FIXED_NOW + crate::filter::NO_RESUB_SCAN_MIN_INTERVAL_NANOS,
        ));
        let _ = runtime.job("inv", RawPayload::Value(&payload));
        assert_eq!(host.count("GET", "/api/subscribe/pool/intents"), 2);
        assert_eq!(runtime.no_resub_scan_at, "2026-09-29T16:00:09Z");
    }

    #[test]
    fn no_resub_scan_due_throttles_by_interval() {
        fixed_clock();
        let runtime = Runtime::new();
        assert!(runtime.no_resub_scan_due(), "从未扫过 → 到期");
        let mut runtime = runtime;
        runtime.no_resub_scan_at = "2026-09-29T10:00:09Z".to_string();
        assert!(!runtime.no_resub_scan_due(), "6 小时内 → 跳过");
        clock::testhooks::set_now(Some(FIXED_NOW + NO_RESUB_SCAN_MIN_INTERVAL_NANOS - 1));
        assert!(!runtime.no_resub_scan_due(), "差 1 纳秒满 6 小时也算跳过");
        clock::testhooks::set_now(Some(FIXED_NOW + NO_RESUB_SCAN_MIN_INTERVAL_NANOS));
        assert!(runtime.no_resub_scan_due());
        // 脏数据(解析不出)按"从未扫过"处理
        runtime.no_resub_scan_at = "garbage".to_string();
        assert!(runtime.no_resub_scan_due());
    }

    // ─────────────────── settings_update: 新字段合并语义 ───────────────────

    fn patch(value: &str) -> serde_json::Map<String, Value> {
        match serde_json::from_str::<Value>(value).expect("测试补丁必须是 JSON 对象") {
            Value::Object(map) => map,
            _ => panic!("测试补丁必须是 JSON 对象"),
        }
    }

    #[test]
    fn settings_update_accepts_filter_fields() {
        fixed_clock();
        let host = TestHost::install(vec![]);
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();

        let result = runtime.settings_update(&patch(
            r#"{"min_rating": 7.5, "min_year": 2000, "regions": ["中国 ", "美国", ""]}"#,
        ));
        assert_eq!(
            result,
            json!({"status": "succeeded", "message": "设置已保存"})
        );
        assert_eq!(runtime.settings.min_rating, 7.5);
        assert_eq!(runtime.settings.min_year, 2000);
        assert_eq!(
            runtime.settings.regions,
            Some(vec!["中国".to_string(), "美国".to_string()]),
            "逐项 trim 后丢弃空项"
        );
        // 其它设置不受影响(合并语义)
        assert_eq!(runtime.settings.observe_period_hours, 24);
        assert!(runtime.settings.auto_subscribe);

        // 落盘文档带上三个新键(存储层不受宿主脱敏限制, 键名原样)
        let request = last_state_put(&host).expect("必须落盘");
        let doc: Value = serde_json::from_slice(&request).unwrap();
        assert_eq!(doc["settings"]["min_rating"], json!(7.5));
        assert_eq!(doc["settings"]["min_year"], json!(2000));
        assert_eq!(doc["settings"]["regions"], json!(["中国", "美国"]));
    }

    #[test]
    fn settings_update_merges_without_touching_other_filter_fields() {
        fixed_clock();
        let _host = TestHost::install(vec![]);
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        runtime.settings.min_rating = 6.0;
        runtime.settings.regions = Some(vec!["日本".to_string()]);

        // 只带 min_year 的补丁: 其它两个过滤器字段原样保留
        runtime.settings_update(&patch(r#"{"min_year": 2001}"#));
        assert_eq!(runtime.settings.min_rating, 6.0);
        assert_eq!(runtime.settings.min_year, 2001);
        assert_eq!(runtime.settings.regions, Some(vec!["日本".to_string()]));
    }

    #[test]
    fn settings_update_ignores_invalid_filter_values() {
        fixed_clock();
        let _host = TestHost::install(vec![]);
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        runtime.settings.min_rating = 6.0;
        runtime.settings.min_year = 2000;
        runtime.settings.regions = Some(vec!["日本".to_string()]);

        // 数值非法(负数 / 类型不符)整项忽略; JSON 里写不出 NaN, 字符串数字也不收
        runtime.settings_update(&patch(r#"{"min_rating": -1.5}"#));
        runtime.settings_update(&patch(r#"{"min_rating": "7.5"}"#));
        runtime.settings_update(&patch(r#"{"min_year": -1}"#));
        runtime.settings_update(&patch(r#"{"min_year": "2020"}"#));
        assert_eq!(runtime.settings.min_rating, 6.0);
        assert_eq!(runtime.settings.min_year, 2000);

        // regions: 类型不符(字符串/数字/对象)整块忽略
        runtime.settings_update(&patch(r#"{"regions": "中国"}"#));
        runtime.settings_update(&patch(r#"{"regions": [1, 2]}"#));
        runtime.settings_update(&patch(r#"{"regions": {"a": 1}}"#));
        assert_eq!(runtime.settings.regions, Some(vec!["日本".to_string()]));

        // null 清空(与 blacklist 同款语义); 空数组 = 不限(合法值)
        runtime.settings_update(&patch(r#"{"regions": null}"#));
        assert_eq!(runtime.settings.regions, None);
        runtime.settings_update(&patch(r#"{"regions": []}"#));
        assert_eq!(runtime.settings.regions, Some(Vec::new()));

        // 0 = 不限, 是合法值(不是"非法被忽略")
        runtime.settings_update(&patch(r#"{"min_rating": 0, "min_year": 0}"#));
        assert_eq!(runtime.settings.min_rating, 0.0);
        assert_eq!(runtime.settings.min_year, 0);
    }

    /// TestHost 上的最近一次 `state` 落盘体(`{"value": ...}` 里的 value), 只在测试里用。
    fn last_state_put(host: &TestHost) -> Option<Vec<u8>> {
        let request =
            host.requests().into_iter().rev().find(|request| {
                request.method == "PUT" && request.path.ends_with("/storage/state")
            })?;
        let body = crate::store::decode_body(&crate::host::HostCallResponse {
            status: 200,
            headers: Default::default(),
            body_base64: request.body_base64,
        })
        .ok()?;
        // 宿主存储信封是 `{"key":…,"value":<文档>}`(同 runtime.rs 的 state_body), 取 value
        let parsed: Value = serde_json::from_slice(&body).ok()?;
        parsed
            .get("value")
            .map(|value| value.to_string().into_bytes())
    }

    // ─────────────────── chart 入队带上评分/年份 ───────────────────

    #[test]
    fn chart_enqueue_carries_rating_and_year() {
        fixed_clock();
        let mut runtime = Runtime::new();
        let snapshot = Snapshot {
            fetched_at: String::new(),
            lists: Some(BTreeMap::from([(
                "movie_wom".to_string(),
                Some(vec![
                    ChartItem {
                        douban_ref: "db:subj:1".to_string(),
                        title: "有评分".to_string(),
                        rate: "8.0".to_string(),
                        year: "2026".to_string(),
                        ..ChartItem::default()
                    },
                    ChartItem {
                        douban_ref: "db:subj:2".to_string(),
                        title: "无评分".to_string(),
                        rate: String::new(),
                        ..ChartItem::default()
                    },
                ]),
            )])),
        };
        runtime.filter_and_enqueue(&snapshot, &crate::model::default_settings());
        let items = runtime.queue.items.clone().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].rating, 8.0);
        assert_eq!(items[0].year, "2026");
        assert_eq!(items[1].rating, 0.0, "空 rate → 0 = 未知(omitempty 不落盘)");
        // 0 值序列化时省略(与旧文档字节兼容)
        let encoded = serde_json::to_string(&items[1]).unwrap();
        assert!(!encoded.contains("rating"), "{encoded}");
    }
}
