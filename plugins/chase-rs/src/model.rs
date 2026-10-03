//! 状态文档模型(宿主存储 `state` 单键里的那一份 JSON)。
//!
//! # 形状
//!
//! 顶层键(与设计规格 `stateShape` 一致, 逐条对应):
//!
//! | 键 | 内容 |
//! |----|------|
//! | `schema_version` / `revision` | 文档版本 / 每次落盘 +1 |
//! | `status` / `last_message` / `last_run` | 最近一次动作或任务的结论 |
//! | `settings` | 用户配置(全部走白名单合并, 见 [`crate::runtime`]) |
//! | `align` | 最近一轮对齐的计数与逐条结果(≤50 条) |
//! | `trim_suggestions` | 减方向**只读**建议(≤50 条, 永不触发写) |
//! | `calendar` | 追剧日历(≤8 天, 每天 ≤20 条) |
//! | `daily` | 日报去重账(同一自然日只成功记一次) |
//! | `debug` | 四个探测端点(含 TMDB 目标)的快照 + 尝试 + 错误(原文 ≤2048 字节) |
//! | `stats` | 界面概览计数 |
//! | `logs` | 自持日志(≤50 条, 消息 ≤400 字节) |
//! | `emby_instances` | 最近一次成功解析的 Emby 实例列表(界面设置抽屉的下拉数据源) |
//! | `probe_book` | 跨轮的 (实例, 剧, 季) 探测记账: 公平排队 + 失败负缓存 |
//! | `tmdb_targets` | 最近成功取到的该季 TMDB 目标(前台 align-now 复用, 零新增 host.call) |
//!
//! 两处**对规格的显式扩展**(都是规格正文要求的界面/行为所必需, 见各自的注释):
//! `settings.dry_run`(规格 `uiSections` ⑥ 的 dry-run 开关)与
//! `settings.write_episode_strings`(规格 `jobFlow` ⑦ 的"仅当 settings 显式开启扩展"),
//! 以及 `emby_instances`(规格 `uiSections` ⑥"来自最近一次成功解析的实例列表")。
//! `debug.pool_intents` 同样是扩展: 规格的不变量要求**订阅池列表**解析失败也留
//! ≤2048 字节原文, 而 `stateShape` 只给了两个快照槽(见 [`DebugState`] 的说明)。
//! 其余键名与语义严格照规格。
//!
//! # 硬约束
//!
//! - 全文档递归不得出现键名命中凭据模式的字段 —— 见 [`raw::contains_forbidden_key`],
//!   写入前由 [`crate::runtime::Runtime::persist_state`] 断言并脱敏。
//! - 单文档 ≤256KB, 各列表有独立上限([`StateDoc::enforce_limits`] 在每次落盘前裁剪)。
//! - 所有字段都带 `#[serde(default)]`: 旧文档缺键能读, 新增键不会让老版本崩。

use serde::{Deserialize, Serialize};

use crate::raw;

/// 文档版本标记: 认不出这个数字的文档不当作本插件的状态。
pub const SCHEMA_VERSION: u64 = 1;

/// 单文档字节上限(写入前先裁剪)。
pub const MAX_STATE_BYTES: usize = 256 * 1024;
/// `align.items` 上限。
pub const ALIGN_ITEMS_MAX: usize = 50;
/// `trim_suggestions` 上限。
pub const TRIM_MAX: usize = 50;
/// `calendar.days` 上限。
pub const CALENDAR_DAYS_MAX: usize = 8;
/// 每天日历条目上限。
pub const CALENDAR_ITEMS_MAX: usize = 20;
/// `debug.attempts` 上限。
pub const DEBUG_ATTEMPTS_MAX: usize = 20;
/// `debug.last_errors` 上限。
pub const DEBUG_ERRORS_MAX: usize = 10;
/// `logs` 上限。
pub const LOGS_MAX: usize = 50;
/// 单条日志消息的字节上限。
pub const LOG_MESSAGE_MAX: usize = 400;
/// `debug` 里原始响应片段的字节上限。
pub const SAMPLE_MAX: usize = 2048;
/// `emby_instances` 上限。
pub const INSTANCES_MAX: usize = 20;
/// 单轮 PATCH 的**代码硬上限**(用户配置再大也不越过)。
pub const PATCH_HARD_LIMIT: u8 = 20;
/// `max_patch_per_run` 的默认值。
pub const PATCH_DEFAULT: u8 = 5;
/// `max_raise_per_run` 的默认值。
pub const RAISE_DEFAULT: u8 = 20;
/// `catch_up_days` 的默认值。
pub const CATCH_UP_DEFAULT: u16 = 7;
/// `emby_probe_budget` 的默认值。
pub const PROBE_BUDGET_DEFAULT: u16 = 120;
/// 目标集数的硬上限(元数据异常的保护阈值, 见规格 ⑥)。
pub const TARGET_UPPER_LIMIT: i64 = 2000;
/// `probe_book` 上限(每轮探测记账保留的 (实例, 剧, 季) 条数)。
pub const PROBE_BOOK_MAX: usize = 200;
/// `tmdb_targets` 上限(与 `align.items` 同量级: 一次 job 最多判定 50 条)。
pub const TMDB_TARGETS_MAX: usize = 50;

// ─────────────────────────── settings ───────────────────────────

/// 日报设置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ReportSettings {
    /// 是否发送日报(默认关: 用户没配时不该收到 TG 消息)。
    pub enabled: bool,
    /// 本地小时(0-23), 到点且当天没发过才发。
    pub hour: u8,
    /// 本地时区偏移(分钟), 例如 +08:00 = 480。
    pub tz_offset_minutes: i32,
}

impl Default for ReportSettings {
    fn default() -> Self {
        ReportSettings { enabled: false, hour: 9, tz_offset_minutes: 480 }
    }
}

/// 探测指纹缓存。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ProbeSettings {
    /// 命中的 `emby/episodes` 参数/字段指纹(空 = 还没探测成功过)。
    pub emby_episodes_shape: String,
    /// 命中的 `air-calendar` 字段指纹。
    pub air_calendar_shape: String,
}

/// 用户配置。
///
/// 所有上限字段都由 [`Settings::clamp`] 夹取 —— 前端可以送出越界值, 落盘前一定收敛。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// 插件总开关。
    pub enabled: bool,
    /// -1 = 跟随宿主默认实例; ≥1 = 指定实例 id; 0 = 旧版单实例(调用时省略 proxy_id)。
    pub emby_proxy_id: i64,
    /// 单轮最多补订多少条(≤ [`PATCH_HARD_LIMIT`])。
    pub max_patch_per_run: u8,
    /// 单条一次最多抬升多少集(超出视为元数据异常, 跳过并记 debug)。
    pub max_raise_per_run: u8,
    /// 追剧日历向前看多少天。
    pub catch_up_days: u16,
    /// 单轮 Emby 覆盖 + TMDB 目标探测的 host.call 总上限(两条取数共用一份预算,
    /// 见 `runtime::job_align` 的记账: 每条条目通常 Emby 1 次 + TMDB 1 次 = 2 次)。
    pub emby_probe_budget: u16,
    /// 小时 job 是否自动补订(默认开)。
    ///
    /// 关掉后 job 只判定不写 PATCH(界面里的 `align-now` 是手动动作, 不受此开关限制)。
    /// 缺键/null 都落回 `true`(旧状态文档没有这个键, 必须是向后兼容的 true)。
    #[serde(default = "default_true", deserialize_with = "deserialize_auto_bump")]
    pub auto_bump: bool,
    /// 只判定不发 PATCH(界面开关; 规格 `uiSections` ⑥)。
    pub dry_run: bool,
    /// 是否把 `needed_episodes` / `covered_episodes` 一起写回。
    ///
    /// 默认关: 只有显式开启、且原串能严格解析并逐字节往返一致时才追加(规格 `jobFlow` ⑦)。
    pub write_episode_strings: bool,
    pub report: ReportSettings,
    pub probe: ProbeSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            enabled: true,
            emby_proxy_id: -1,
            max_patch_per_run: PATCH_DEFAULT,
            max_raise_per_run: RAISE_DEFAULT,
            catch_up_days: CATCH_UP_DEFAULT,
            emby_probe_budget: PROBE_BUDGET_DEFAULT,
            auto_bump: true,
            dry_run: false,
            write_episode_strings: false,
            report: ReportSettings::default(),
            probe: ProbeSettings::default(),
        }
    }
}

/// `auto_bump` 的缺省值: 默认开(与 `enabled`/`dry_run` 一起构成"装好即自动补订")。
fn default_true() -> bool {
    true
}

/// `auto_bump` 的反序列化: 缺键走 `#[serde(default)]`(true), **显式 null 也落回 true**
/// (宿主/旧前端可能写 `null`; 不能因为 null 就把自动补订静默关掉), 布尔值原样。
fn deserialize_auto_bump<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<bool>::deserialize(deserializer)?.unwrap_or(true))
}

impl Settings {
    /// 把越界配置夹取回硬上限(前端与旧文档都可能给出离谱值)。
    pub fn clamp(&mut self) {
        self.max_patch_per_run = self.max_patch_per_run.min(PATCH_HARD_LIMIT).max(1);
        self.max_raise_per_run = self.max_raise_per_run.min(100).max(1);
        self.catch_up_days = self.catch_up_days.clamp(1, 30);
        self.emby_probe_budget = self.emby_probe_budget.clamp(1, 500);
        self.report.hour = self.report.hour.min(23);
        // ±14 小时是现实世界的极限, 再大一定是配置错误
        self.report.tz_offset_minutes = self.report.tz_offset_minutes.clamp(-840, 840);
        if self.emby_proxy_id < -1 {
            self.emby_proxy_id = -1;
        }
    }
}

// ─────────────────────────── align ───────────────────────────

/// 逐条对齐结果(界面核心表的一行)。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AlignItem {
    pub intent_id: i64,
    pub tmdb_id: i64,
    pub season: i64,
    pub title: String,
    pub total_known: i64,
    /// Emby 已有集的最大集号; -1 = 未知(解析失败/未探测)。
    pub emby_have_max: i64,
    /// Emby 已有集的条数; -1 = 未知。
    pub emby_have_count: i64,
    /// 缺口上沿 = max(0, emby_have_max - total_known)。
    pub gap_max: i64,
    /// 该季的 TMDB 目标集数(取不到 = 0, 但 [`AlignItem::target_known`] 为 false)。
    /// align-now 连同 Emby 覆盖一起复用这一行, 就不必为同一季再花一次 host.call,
    /// 也不会退化成"只按 Emby 缺口"判定。
    pub target_upper: i64,
    /// 目标是否真的取到了: TMDB 明确给出该季集数时为 true(明确 0 集也算)。
    /// `false` 表示"未知", 界面/文案必须显示未知而不是 0 —— 0 不得冒充
    /// `total_known`。旧文档缺这个键时按 `false` 读(配合 `target_upper > 0`
    /// 兜底, 见 runtime 的 `cached_coverage`)。
    pub target_known: bool,
    pub from_total: i64,
    pub to_total: i64,
    /// `patched` | `dry-run` | `skipped` | `failed`。
    pub action: String,
    pub reason: String,
    pub at: String,
}

/// 最近一轮对齐的汇总。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AlignState {
    pub last_run_at: String,
    /// 读了几页订阅池。
    pub pages: u16,
    /// 订阅池里见到的 tv 条目数。
    pub intents_seen: u16,
    /// 参与判定的条目数(有 Emby 覆盖的)。
    pub matched: u16,
    pub patched: u16,
    pub skipped: u16,
    pub failed: u16,
    /// Emby 侧明确"该季 0 集/未收录"的条目数(既不算失败也不算无缺口, 见 align.rs)。
    pub absent: u16,
    /// 本轮因探测预算/墙钟/负缓存没能探测、留到下一轮优先补探的条目数。
    pub pending_probe: u16,
    pub last_error: String,
    pub items: Vec<AlignItem>,
}

/// 减方向只读建议。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TrimSuggestion {
    pub intent_id: i64,
    pub tmdb_id: i64,
    pub season: i64,
    pub title: String,
    pub total_known: i64,
    pub emby_have_max: i64,
    /// 建议裁剪到的目标上限(该季 TMDB 集数)。
    pub target_upper: i64,
    pub reason: String,
    pub at: String,
}

// ─────────────────────────── calendar / daily ───────────────────────────

/// 追剧日历里的一条。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CalendarItem {
    pub tmdb_id: i64,
    pub season: i64,
    pub episode: i64,
    pub title: String,
    /// 播出时间文本(解析不出就是空串, 不猜)。
    pub time: String,
}

/// 追剧日历里的一天。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CalendarDay {
    /// `YYYY-MM-DD`。
    pub date: String,
    pub items: Vec<CalendarItem>,
}

/// 追剧日历快照。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CalendarState {
    pub fetched_at: String,
    pub days: Vec<CalendarDay>,
}

/// 日报去重账。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DailyState {
    /// 最近一次**成功**记下的本地日期(accepted / deduplicated)。
    pub last_sent_date: String,
    pub last_at: String,
    /// `accepted` | `deduplicated` | `suppressed` | `failed` | ""。
    pub last_result: String,
    pub last_error: String,
    pub sent_total: u32,
}

// ─────────────────────────── debug ───────────────────────────

/// 一次端点探测的快照(手写 `Default`: 缺键的槽位是 `never`, 不是空串)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ProbeSnapshot {
    /// `ok` | `unparsed` | `http_error` | `skipped` | `never`。
    pub status: String,
    /// 命中的形状指纹。
    pub shape: String,
    /// 尝试过的参数组合(按顺序)。
    pub params_tried: Vec<String>,
    pub http_status: i32,
    /// ≤2048 字节的脱敏原文片段。
    pub sample: String,
    pub at: String,
}

impl ProbeSnapshot {
    /// 全新的空快照(状态文档的初始值)。
    pub fn never() -> Self {
        ProbeSnapshot { status: "never".to_string(), ..Default::default() }
    }
}

impl Default for ProbeSnapshot {
    /// 与 [`ProbeSnapshot::never`] 一致: 缺键的槽位是"从没探过", 不是空串 ——
    /// 旧文档里 `"debug": {}` 这种形态也能得到可直接展示的状态词。
    fn default() -> Self {
        ProbeSnapshot {
            status: "never".to_string(),
            shape: String::new(),
            params_tried: Vec::new(),
            http_status: 0,
            sample: String::new(),
            at: String::new(),
        }
    }
}

/// 一次 host.call 的尝试记录。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DebugAttempt {
    pub endpoint: String,
    pub params: String,
    pub http_status: i32,
    pub shape: String,
    pub at: String,
}

/// 一条错误的记录。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DebugError {
    pub step: String,
    pub message: String,
    pub at: String,
}

/// 每个 (实例, 剧, 季) 上一次 Emby 覆盖探测的记账(跨轮, 用于公平性与负缓存)。
///
/// 一轮探测预算/墙钟用尽时, 被跳过的条目下轮必须先探(不能每轮都从池头开始);
/// 解析失败的条目在 [`PROBE_NEGATIVE_TTL`](crate::runtime::PROBE_NEGATIVE_TTL_SECS)
/// 内不再重复烧 host.call。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ProbeBookEntry {
    /// `"{proxy_id}:{tmdb_id}:{season}"`(与 runtime 的轮内缓存键同构)。
    pub key: String,
    /// 上一次记账时刻(RFC3339)。
    pub at: String,
    /// Emby 探测结果: `ok` | `failed` | `absent` | `budget` | `time` | `limit`。
    pub emby: String,
    /// TMDB 目标取数结果: `ok` | `cached` | `unknown`。
    pub target: String,
}

/// 一次成功取到的该季 TMDB 目标(前台 align-now 复用, 零新增 host.call)。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TmdbTarget {
    pub tmdb_id: i64,
    pub season: i64,
    /// TMDB 明确给出的该季集数(可为 0)。
    pub episode_count: i64,
    pub at: String,
}

/// 诊断区。
///
/// 三个快照槽: 规范枚举的两个未知端点(`emby_episodes` / `air_calendar`)之外,
/// [`pool_intents`](DebugState::pool_intents) 是**对规格的显式扩展** —— 规格的
/// 不变量写着「任一关键结构(**Emby 覆盖或订阅池列表**)解析失败 ⇒ 该条本轮零写入,
/// 且 state.debug 留下 ≤2048 字节截断原文」, 而订阅池列表没有自己的槽位, 原文就无处
/// 安放(塞进 `last_errors[].message` 只有 400 字节且语义是"原因"不是"原文")。
/// 因此这里给它一个与另外两个同形的槽位, 前端诊断面板同样展示。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DebugState {
    pub updated_at: String,
    pub emby_episodes: ProbeSnapshot,
    /// 实例列表的现场(含 ≤2048 字节原文)——真实宿主出现过「200 但解析为空」,
    /// 是字段没认出还是宿主没配实例, 只有原文能分辨。
    pub emby_instances: ProbeSnapshot,
    pub air_calendar: ProbeSnapshot,
    /// 订阅池列表的失败现场(解析失败时的 ≤2048 字节原文)。
    pub pool_intents: ProbeSnapshot,
    /// TMDB 目标(`GET /api/tmdb/tv/:id`)的现场: 参数/HTTP 状态/原文样本,
    /// 让"该季目标取不到"在诊断面板一键可见(而不是只看 last_errors 的 ≤10 条)。
    pub tmdb_target: ProbeSnapshot,
    pub attempts: Vec<DebugAttempt>,
    pub last_errors: Vec<DebugError>,
}

impl DebugState {
    pub fn new() -> Self {
        DebugState {
            updated_at: String::new(),
            emby_episodes: ProbeSnapshot::never(),
            emby_instances: ProbeSnapshot::never(),
            air_calendar: ProbeSnapshot::never(),
            pool_intents: ProbeSnapshot::never(),
            tmdb_target: ProbeSnapshot::never(),
            attempts: Vec::new(),
            last_errors: Vec::new(),
        }
    }
}

impl Default for DebugState {
    /// 与 [`DebugState::new`] 一致(serde 的容器级 `default` 也走这里):
    /// 旧文档缺键时拿到的是 `status = "never"` 而不是空串。
    fn default() -> Self {
        DebugState::new()
    }
}

// ─────────────────────────── stats / logs / instances ───────────────────────────

/// 界面概览计数。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct StatsState {
    /// 订阅池里的 tv 条目数。
    pub tv_intents: u32,
    /// 有 Emby 覆盖、参与判定的条目数。
    pub matched: u32,
    /// 本轮真正补订(或 dry-run 判定要补)的条目数。
    pub aligned: u32,
    /// 所有判定条目的缺口合计。
    pub gap_total: u32,
    /// 结构解析失败(形状未识别)的次数。
    pub unknown_shape: u32,
}

/// 自持日志的一条。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LogEntry {
    pub at: String,
    pub level: String,
    pub message: String,
}

/// 最近一次成功解析的 Emby 实例(界面下拉数据源)。
///
/// 键名 `key_ready` 而不是宿主原字段 `api_key_configured`: 后者的键名命中凭据模式
/// (`api_key`), 会违反"全文档不得出现凭据键名"的硬约束(见 [`raw::is_forbidden_key`])。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct EmbyInstanceView {
    pub id: i64,
    pub name: String,
    pub is_default: bool,
    /// 宿主 `api_key_configured` 的等价物(已改名以避开凭据键模式)。
    pub key_ready: bool,
    pub at: String,
}

// ─────────────────────────── 文档 ───────────────────────────

/// 整个状态文档。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct StateDoc {
    pub schema_version: u64,
    pub revision: u64,
    pub status: String,
    pub last_message: String,
    pub last_run: String,
    pub settings: Settings,
    pub align: AlignState,
    pub trim_suggestions: Vec<TrimSuggestion>,
    pub calendar: CalendarState,
    pub daily: DailyState,
    pub debug: DebugState,
    pub stats: StatsState,
    pub logs: Vec<LogEntry>,
    pub emby_instances: Vec<EmbyInstanceView>,
    /// 跨轮的探测记账(公平性 + 失败负缓存), 见 [`ProbeBookEntry`]。
    pub probe_book: Vec<ProbeBookEntry>,
    /// 最近一次成功取到的该季 TMDB 目标(align-now 复用, 零新增 host.call)。
    pub tmdb_targets: Vec<TmdbTarget>,
}

impl Default for StateDoc {
    fn default() -> Self {
        StateDoc::new()
    }
}

impl StateDoc {
    pub fn new() -> Self {
        StateDoc {
            schema_version: SCHEMA_VERSION,
            revision: 0,
            status: String::new(),
            last_message: String::new(),
            last_run: String::new(),
            settings: Settings::default(),
            align: AlignState::default(),
            trim_suggestions: Vec::new(),
            calendar: CalendarState::default(),
            daily: DailyState::default(),
            debug: DebugState::new(),
            stats: StatsState::default(),
            logs: Vec::new(),
            emby_instances: Vec::new(),
            probe_book: Vec::new(),
            tmdb_targets: Vec::new(),
        }
    }

    /// 记下/更新该季的 TMDB 目标(成功取数时调用; ≤ [`TMDB_TARGETS_MAX`] 条)。
    pub fn remember_tmdb_target(&mut self, tmdb_id: i64, season: i64, episode_count: i64, at: &str) {
        self.tmdb_targets
            .retain(|target| !(target.tmdb_id == tmdb_id && target.season == season));
        self.tmdb_targets.push(TmdbTarget {
            tmdb_id,
            season,
            episode_count: episode_count.max(0),
            at: at.to_string(),
        });
        let len = self.tmdb_targets.len();
        if len > TMDB_TARGETS_MAX {
            self.tmdb_targets.drain(..len - TMDB_TARGETS_MAX);
        }
    }

    /// 取该季最近一次成功记录的目标(不做新鲜度判断, 由调用方决定窗口)。
    pub fn tmdb_target_of(&self, tmdb_id: i64, season: i64) -> Option<&TmdbTarget> {
        self.tmdb_targets
            .iter()
            .rev()
            .find(|target| target.tmdb_id == tmdb_id && target.season == season)
    }

    /// 忘记该季的目标(本轮取数失败时调用: 不拿旧值冒充"取到了")。
    pub fn forget_tmdb_target(&mut self, tmdb_id: i64, season: i64) {
        self.tmdb_targets
            .retain(|target| !(target.tmdb_id == tmdb_id && target.season == season));
    }

    /// 认得出是本插件的状态文档吗(认不出就禁止落盘, 避免默认值覆盖用户数据)。
    pub fn is_recognizable(&self) -> bool {
        self.schema_version == SCHEMA_VERSION
    }

    /// 每次状态变化 +1(`state-v<N>` 与幂等键的轮次都靠它)。
    pub fn bump_revision(&mut self) {
        self.revision = self.revision.saturating_add(1);
    }

    /// 写一条自持日志(≤400 字节、≤50 条; 不走额外 RPC)。
    pub fn log(&mut self, level: &str, message: &str) {
        let message = raw::truncate_bytes(message, LOG_MESSAGE_MAX);
        self.logs.push(LogEntry {
            at: crate::clock::now_rfc3339(),
            level: level.to_string(),
            message: message.to_string(),
        });
        let len = self.logs.len();
        if len > LOGS_MAX {
            self.logs.drain(..len - LOGS_MAX);
        }
    }

    /// 记一条诊断错误(≤10 条, 最新的在最后)。
    pub fn record_error(&mut self, step: &str, message: &str) {
        let message = raw::truncate_bytes(message, LOG_MESSAGE_MAX).to_string();
        self.debug.last_errors.push(DebugError {
            step: step.to_string(),
            message,
            at: crate::clock::now_rfc3339(),
        });
        let len = self.debug.last_errors.len();
        if len > DEBUG_ERRORS_MAX {
            self.debug.last_errors.drain(..len - DEBUG_ERRORS_MAX);
        }
        self.debug.updated_at = crate::clock::now_rfc3339();
    }

    /// 记一次 host.call 尝试(≤20 条)。
    pub fn record_attempt(&mut self, endpoint: &str, params: &str, http_status: i32, shape: &str) {
        self.debug.attempts.push(DebugAttempt {
            endpoint: endpoint.to_string(),
            params: raw::truncate_bytes(params, 200).to_string(),
            http_status,
            shape: raw::truncate_bytes(shape, 200).to_string(),
            at: crate::clock::now_rfc3339(),
        });
        let len = self.debug.attempts.len();
        if len > DEBUG_ATTEMPTS_MAX {
            self.debug.attempts.drain(..len - DEBUG_ATTEMPTS_MAX);
        }
        self.debug.updated_at = crate::clock::now_rfc3339();
    }

    /// 按上限裁剪所有列表(落盘前调用)。
    pub fn enforce_limits(&mut self) {
        trim_tail(&mut self.align.items, ALIGN_ITEMS_MAX);
        trim_tail(&mut self.trim_suggestions, TRIM_MAX);
        trim_tail(&mut self.calendar.days, CALENDAR_DAYS_MAX);
        for day in &mut self.calendar.days {
            trim_tail(&mut day.items, CALENDAR_ITEMS_MAX);
        }
        trim_tail(&mut self.debug.attempts, DEBUG_ATTEMPTS_MAX);
        trim_tail(&mut self.debug.last_errors, DEBUG_ERRORS_MAX);
        trim_tail(&mut self.logs, LOGS_MAX);
        trim_tail(&mut self.emby_instances, INSTANCES_MAX);
        trim_tail(&mut self.probe_book, PROBE_BOOK_MAX);
        trim_tail(&mut self.tmdb_targets, TMDB_TARGETS_MAX);
        self.debug.emby_episodes.sample =
            raw::truncate_bytes(&self.debug.emby_episodes.sample, SAMPLE_MAX).to_string();
        self.debug.air_calendar.sample =
            raw::truncate_bytes(&self.debug.air_calendar.sample, SAMPLE_MAX).to_string();
        self.debug.pool_intents.sample =
            raw::truncate_bytes(&self.debug.pool_intents.sample, SAMPLE_MAX).to_string();
        self.debug.tmdb_target.sample =
            raw::truncate_bytes(&self.debug.tmdb_target.sample, SAMPLE_MAX).to_string();
        trim_tail(&mut self.debug.emby_episodes.params_tried, 8);
        trim_tail(&mut self.debug.air_calendar.params_tried, 8);
        trim_tail(&mut self.debug.pool_intents.params_tried, 8);
        trim_tail(&mut self.debug.tmdb_target.params_tried, 8);
        for item in &mut self.align.items {
            item.reason = raw::truncate_bytes(&item.reason, LOG_MESSAGE_MAX).to_string();
            item.title = raw::truncate_bytes(&item.title, 120).to_string();
        }
        for item in &mut self.trim_suggestions {
            item.reason = raw::truncate_bytes(&item.reason, LOG_MESSAGE_MAX).to_string();
            item.title = raw::truncate_bytes(&item.title, 120).to_string();
        }
        for item in &mut self.logs {
            item.message = raw::truncate_bytes(&item.message, LOG_MESSAGE_MAX).to_string();
        }
        for item in &mut self.debug.last_errors {
            item.message = raw::truncate_bytes(&item.message, LOG_MESSAGE_MAX).to_string();
        }
    }

    /// 序列化到 ≤[`MAX_STATE_BYTES`] 的字节(超限则继续裁掉最旧的诊断, 仍超限返回 Err)。
    pub fn to_bytes(&mut self) -> Result<Vec<u8>, String> {
        self.enforce_limits();
        let mut data = serde_json::to_vec(self).map_err(|err| format!("状态文档编码失败: {err}"))?;
        // 逐级降级: 先砍诊断, 再砍日志 —— 业务数据(settings/align/calendar)最后才动。
        for step in 0..6 {
            if data.len() <= MAX_STATE_BYTES {
                return Ok(data);
            }
            match step {
                0 => self.debug.attempts.clear(),
                1 => self.debug.sample_free(),
                2 => self.logs.clear(),
                3 => trim_tail(&mut self.align.items, ALIGN_ITEMS_MAX / 2),
                4 => trim_tail(&mut self.calendar.days, 4),
                _ => trim_tail(&mut self.trim_suggestions, TRIM_MAX / 2),
            }
            data = serde_json::to_vec(self).map_err(|err| format!("状态文档编码失败: {err}"))?;
        }
        if data.len() > MAX_STATE_BYTES {
            return Err(format!("状态文档超过 {} 字节", MAX_STATE_BYTES));
        }
        Ok(data)
    }
}

impl DebugState {
    /// 释放探测样本占用的空间(仍超限时的降级手段)。
    pub fn sample_free(&mut self) {
        self.emby_episodes.sample.clear();
        self.air_calendar.sample.clear();
        self.pool_intents.sample.clear();
        self.tmdb_target.sample.clear();
    }
}

/// 保留列表尾部 `max` 条(丢掉最旧的)。
fn trim_tail<T>(items: &mut Vec<T>, max: usize) {
    if items.len() > max {
        let cut = items.len() - max;
        items.drain(..cut);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_are_the_documented_numbers() {
        let settings = Settings::default();
        assert_eq!(settings.max_patch_per_run, 5);
        assert_eq!(settings.max_raise_per_run, 20);
        assert_eq!(settings.catch_up_days, 7);
        assert_eq!(settings.emby_probe_budget, 120);
        assert_eq!(settings.emby_proxy_id, -1);
        assert!(settings.enabled);
        assert!(settings.auto_bump, "自动补订默认开");
        assert!(!settings.dry_run);
        assert_eq!(settings.report.hour, 9);
        assert_eq!(settings.report.tz_offset_minutes, 480);
    }

    #[test]
    fn auto_bump_is_true_by_default_and_null_means_true() {
        // 缺键 → true(旧文档向后兼容)
        let legacy: Settings = serde_json::from_str(r#"{"enabled":false}"#).unwrap();
        assert!(legacy.auto_bump, "缺键必须落回 true");
        // 显式 null → true(不能因为 null 静默关掉自动补订)
        let nulled: Settings = serde_json::from_str(r#"{"auto_bump":null}"#).unwrap();
        assert!(nulled.auto_bump, "null 视为 true");
        // 明确布尔原样(可关)
        let off: Settings = serde_json::from_str(r#"{"auto_bump":false}"#).unwrap();
        assert!(!off.auto_bump);
        let on: Settings = serde_json::from_str(r#"{"auto_bump":true}"#).unwrap();
        assert!(on.auto_bump);
        // 序列化出来是明确布尔(不是 null)
        let text = serde_json::to_string(&Settings::default()).unwrap();
        assert!(text.contains(r#""auto_bump":true"#), "{text}");
    }

    #[test]
    fn tmdb_target_book_remembers_updates_and_forgets() {
        let mut doc = StateDoc::new();
        doc.remember_tmdb_target(1396, 5, 16, "2026-10-04T00:00:00Z");
        doc.remember_tmdb_target(1399, 1, 10, "2026-10-04T00:00:00Z");
        assert_eq!(doc.tmdb_target_of(1396, 5).unwrap().episode_count, 16);
        // 同一季再次成功 → 更新而不是重复
        doc.remember_tmdb_target(1396, 5, 17, "2026-10-04T01:00:00Z");
        assert_eq!(doc.tmdb_targets.len(), 2);
        assert_eq!(doc.tmdb_target_of(1396, 5).unwrap().episode_count, 17);
        // 取数失败 → 忘掉该季(不拿旧值冒充)
        doc.forget_tmdb_target(1396, 5);
        assert!(doc.tmdb_target_of(1396, 5).is_none());
        assert!(doc.tmdb_target_of(1399, 1).is_some());
        // 上限裁剪: 只留最新的 50 条
        for index in 0..80 {
            doc.remember_tmdb_target(index, 1, 12, "2026-10-04T02:00:00Z");
        }
        doc.enforce_limits();
        assert_eq!(doc.tmdb_targets.len(), TMDB_TARGETS_MAX);
        assert!(doc.tmdb_targets.iter().all(|target| target.tmdb_id != 1399), "最旧的被裁掉");
    }

    #[test]
    fn probe_book_is_bounded_on_persist() {
        let mut doc = StateDoc::new();
        for index in 0..(PROBE_BOOK_MAX + 20) {
            doc.probe_book.push(ProbeBookEntry {
                key: format!("3:{index}:1"),
                at: "2026-10-04T00:00:00Z".to_string(),
                emby: "ok".to_string(),
                target: "ok".to_string(),
            });
        }
        doc.enforce_limits();
        assert_eq!(doc.probe_book.len(), PROBE_BOOK_MAX);
    }

    #[test]
    fn clamp_pulls_out_of_range_values_back() {
        let mut settings = Settings::default();
        settings.max_patch_per_run = 200;
        settings.max_raise_per_run = 0;
        settings.catch_up_days = 900;
        settings.emby_probe_budget = 9_000;
        settings.emby_proxy_id = -77;
        settings.report.hour = 42;
        settings.report.tz_offset_minutes = 10_000;
        settings.clamp();
        assert_eq!(settings.max_patch_per_run, PATCH_HARD_LIMIT);
        assert_eq!(settings.max_raise_per_run, 1);
        assert_eq!(settings.catch_up_days, 30);
        assert_eq!(settings.emby_probe_budget, 500);
        assert_eq!(settings.emby_proxy_id, -1);
        assert_eq!(settings.report.hour, 23);
        assert_eq!(settings.report.tz_offset_minutes, 840);
    }

    #[test]
    fn document_round_trips_and_ignores_unknown_fields() {
        let mut doc = StateDoc::new();
        doc.bump_revision();
        doc.log("info", "hi");
        let bytes = doc.to_bytes().unwrap();
        let parsed: StateDoc = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed.revision, 1);
        assert_eq!(parsed.schema_version, SCHEMA_VERSION);
        assert!(parsed.is_recognizable());

        // 旧文档缺键能读; 未知键被忽略
        let legacy: StateDoc =
            serde_json::from_slice(br#"{"schema_version":1,"revision":3,"future_key":true}"#).unwrap();
        assert_eq!(legacy.revision, 3);
        assert_eq!(legacy.settings.max_patch_per_run, 5);

        // 版本标记不认识 → 禁止落盘
        let other: StateDoc = serde_json::from_slice(br#"{"schema_version":9}"#).unwrap();
        assert!(!other.is_recognizable());
    }

    #[test]
    fn logs_and_errors_are_bounded() {
        let mut doc = StateDoc::new();
        for index in 0..80 {
            doc.log("info", &format!("line-{index}"));
            doc.record_error("step", &format!("err-{index}"));
        }
        assert_eq!(doc.logs.len(), LOGS_MAX);
        assert_eq!(doc.logs[0].message, "line-30", "保留最新的");
        assert_eq!(doc.debug.last_errors.len(), DEBUG_ERRORS_MAX);

        doc.log("warning", &"剧".repeat(500));
        let last = doc.logs.last().unwrap();
        assert!(last.message.len() <= LOG_MESSAGE_MAX);
        assert!(std::str::from_utf8(last.message.as_bytes()).is_ok());
    }

    #[test]
    fn enforce_limits_caps_every_list() {
        let mut doc = StateDoc::new();
        for index in 0..80 {
            doc.align.items.push(AlignItem { intent_id: index, ..Default::default() });
            doc.trim_suggestions.push(TrimSuggestion { intent_id: index, ..Default::default() });
            doc.emby_instances.push(EmbyInstanceView { id: index, ..Default::default() });
        }
        doc.calendar.days.push(CalendarDay {
            date: "2026-10-01".into(),
            items: (0..30).map(|i| CalendarItem { episode: i, ..Default::default() }).collect(),
        });
        doc.enforce_limits();
        assert_eq!(doc.align.items.len(), ALIGN_ITEMS_MAX);
        assert_eq!(doc.align.items[0].intent_id, 30, "丢最旧的");
        assert_eq!(doc.trim_suggestions.len(), TRIM_MAX);
        assert_eq!(doc.emby_instances.len(), INSTANCES_MAX);
        assert_eq!(doc.calendar.days[0].items.len(), CALENDAR_ITEMS_MAX);
    }

    #[test]
    fn oversized_documents_are_shrunk_before_writing() {
        let mut doc = StateDoc::new();
        doc.debug.emby_episodes.sample = "x".repeat(MAX_STATE_BYTES);
        doc.debug.air_calendar.sample = "y".repeat(MAX_STATE_BYTES);
        for index in 0..50 {
            doc.align.items.push(AlignItem {
                intent_id: index,
                title: "剧".repeat(120),
                reason: "因为".repeat(120),
                ..Default::default()
            });
        }
        let bytes = doc.to_bytes().unwrap();
        assert!(bytes.len() <= MAX_STATE_BYTES, "实际 {} 字节", bytes.len());
        let parsed: StateDoc = serde_json::from_slice(&bytes).unwrap();
        assert!(parsed.is_recognizable());
    }

    #[test]
    fn document_never_contains_credential_key_names() {
        let mut doc = StateDoc::new();
        doc.emby_instances.push(EmbyInstanceView {
            id: 3,
            name: "客厅".into(),
            is_default: true,
            key_ready: true,
            at: "2026-10-01T00:00:00Z".into(),
        });
        doc.debug.emby_episodes.sample = raw::sample_text(
            br#"{"api_key":"leak","items":[{"index_number":1}]}"#,
            SAMPLE_MAX,
        );
        let bytes = doc.to_bytes().unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(raw::contains_forbidden_key(&value), None);
        assert!(!String::from_utf8_lossy(&bytes).contains("api_key"));
        assert_eq!(value["emby_instances"][0]["key_ready"], json!(true));
    }

    // ── 补: 诊断槽位 / 上限 / 裁剪顺序 ──

    #[test]
    fn debug_snapshots_default_to_never() {
        let fresh = DebugState::default();
        assert_eq!(fresh.emby_episodes.status, "never");
        assert_eq!(fresh.air_calendar.status, "never");
        assert_eq!(fresh.pool_intents.status, "never");
        assert_eq!(fresh.pool_intents.http_status, 0);

        // 旧文档缺 debug.* 键 → 槽位是 never(可直接展示的状态词)
        let missing: StateDoc = serde_json::from_slice(br#"{"schema_version":1,"revision":2}"#).unwrap();
        assert_eq!(missing.debug.pool_intents.status, "never");
        // 显式给了空 debug 对象也一样(容器级 default 走 DebugState::new)
        let blank: StateDoc =
            serde_json::from_slice(br#"{"schema_version":1,"debug":{}}"#).unwrap();
        assert_eq!(blank.debug.emby_episodes.status, "never");
        assert!(blank.debug.attempts.is_empty());
    }

    #[test]
    fn record_attempt_bounds_the_list_and_truncates_fields() {
        let mut doc = StateDoc::new();
        for index in 0..30 {
            doc.record_attempt(&format!("endpoint-{index}"), &"p".repeat(500), 200, &"s".repeat(500));
        }
        assert_eq!(doc.debug.attempts.len(), DEBUG_ATTEMPTS_MAX);
        assert_eq!(doc.debug.attempts[0].endpoint, "endpoint-10", "保留最新的");
        assert!(doc.debug.attempts[0].params.len() <= 200);
        assert!(doc.debug.attempts[0].shape.len() <= 200);
        assert!(!doc.debug.updated_at.is_empty());
    }

    #[test]
    fn enforce_limits_truncates_item_text() {
        let mut doc = StateDoc::new();
        doc.align.items.push(AlignItem {
            title: "剧".repeat(200),
            reason: "因".repeat(500),
            ..Default::default()
        });
        doc.trim_suggestions.push(TrimSuggestion {
            title: "剧".repeat(200),
            reason: "因".repeat(500),
            ..Default::default()
        });
        doc.enforce_limits();
        assert!(doc.align.items[0].title.len() <= 120);
        assert!(doc.align.items[0].reason.len() <= LOG_MESSAGE_MAX);
        assert!(doc.trim_suggestions[0].title.len() <= 120);
        assert!(doc.trim_suggestions[0].reason.len() <= LOG_MESSAGE_MAX);
        assert!(std::str::from_utf8(doc.align.items[0].reason.as_bytes()).is_ok());
    }

    #[test]
    fn oversized_samples_are_truncated_before_the_cap() {
        let mut doc = StateDoc::new();
        // 三个槽位各塞半兆: 落盘前必须被裁到 ≤2048 字节, 业务数据不许被动
        doc.debug.emby_episodes.sample = "x".repeat(MAX_STATE_BYTES / 2);
        doc.debug.air_calendar.sample = "x".repeat(MAX_STATE_BYTES / 2);
        doc.debug.pool_intents.sample = "x".repeat(MAX_STATE_BYTES / 2);
        doc.settings.max_raise_per_run = 33;
        doc.calendar.days.push(CalendarDay {
            date: "2026-10-01".into(),
            items: vec![CalendarItem { episode: 3, ..Default::default() }],
        });
        let bytes = doc.to_bytes().unwrap();
        assert!(bytes.len() <= MAX_STATE_BYTES, "实际 {} 字节", bytes.len());
        let parsed: StateDoc = serde_json::from_slice(&bytes).unwrap();
        assert!(parsed.debug.emby_episodes.sample.len() <= SAMPLE_MAX);
        assert!(parsed.debug.air_calendar.sample.len() <= SAMPLE_MAX);
        assert!(parsed.debug.pool_intents.sample.len() <= SAMPLE_MAX);
        assert_eq!(parsed.settings.max_raise_per_run, 33, "业务数据不许被诊断挤掉");
        assert_eq!(parsed.calendar.days.len(), 1);
        assert!(parsed.is_recognizable());
    }

    #[test]
    fn sample_free_clears_every_probe_slot() {
        let mut doc = StateDoc::new();
        doc.debug.emby_episodes.sample = "a".repeat(64);
        doc.debug.air_calendar.sample = "b".repeat(64);
        doc.debug.pool_intents.sample = "c".repeat(64);
        doc.debug.sample_free();
        assert!(doc.debug.emby_episodes.sample.is_empty());
        assert!(doc.debug.air_calendar.sample.is_empty());
        assert!(doc.debug.pool_intents.sample.is_empty());
        // 状态词与形状指纹保留(它们才是排障的索引)
        assert_eq!(doc.debug.emby_episodes.status, "never");
    }

    #[test]
    fn log_keeps_the_newest_and_records_error_steps() {
        let mut doc = StateDoc::new();
        doc.record_error("job.emby.episodes", "结构未识别");
        assert_eq!(doc.debug.last_errors.len(), 1);
        assert_eq!(doc.debug.last_errors[0].step, "job.emby.episodes");
        assert!(!doc.debug.last_errors[0].at.is_empty());
        assert!(!doc.debug.updated_at.is_empty());
        // 版本号只增不减
        doc.bump_revision();
        doc.bump_revision();
        assert_eq!(doc.revision, 2);
        assert_eq!(doc.schema_version, SCHEMA_VERSION);
    }
}
