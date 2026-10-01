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
//! | `debug` | 三个探测端点的快照 + 尝试 + 错误(原文 ≤2048 字节) |
//! | `stats` | 界面概览计数 |
//! | `logs` | 自持日志(≤50 条, 消息 ≤400 字节) |
//! | `emby_instances` | 最近一次成功解析的 Emby 实例列表(界面设置抽屉的下拉数据源) |
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
/// 单个季的目标集数兜底(取不到 TMDB 时的保守上限)。
pub const TARGET_FALLBACK_LIMIT: i64 = 2000;

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
    /// 单轮 Emby 探测次数上限。
    pub emby_probe_budget: u16,
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
            dry_run: false,
            write_episode_strings: false,
            report: ReportSettings::default(),
            probe: ProbeSettings::default(),
        }
    }
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

/// 一条错误记录。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DebugError {
    pub step: String,
    pub message: String,
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
    pub air_calendar: ProbeSnapshot,
    /// 订阅池列表的失败现场(解析失败时的 ≤2048 字节原文)。
    pub pool_intents: ProbeSnapshot,
    pub attempts: Vec<DebugAttempt>,
    pub last_errors: Vec<DebugError>,
}

impl DebugState {
    pub fn new() -> Self {
        DebugState {
            updated_at: String::new(),
            emby_episodes: ProbeSnapshot::never(),
            air_calendar: ProbeSnapshot::never(),
            pool_intents: ProbeSnapshot::never(),
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
        }
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
        self.debug.emby_episodes.sample =
            raw::truncate_bytes(&self.debug.emby_episodes.sample, SAMPLE_MAX).to_string();
        self.debug.air_calendar.sample =
            raw::truncate_bytes(&self.debug.air_calendar.sample, SAMPLE_MAX).to_string();
        self.debug.pool_intents.sample =
            raw::truncate_bytes(&self.debug.pool_intents.sample, SAMPLE_MAX).to_string();
        trim_tail(&mut self.debug.emby_episodes.params_tried, 8);
        trim_tail(&mut self.debug.air_calendar.params_tried, 8);
        trim_tail(&mut self.debug.pool_intents.params_tried, 8);
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
    /// 释放三个探测样本占用的空间(仍超限时的降级手段)。
    pub fn sample_free(&mut self) {
        self.emby_episodes.sample.clear();
        self.air_calendar.sample.clear();
        self.pool_intents.sample.clear();
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
        assert!(!settings.dry_run);
        assert_eq!(settings.report.hour, 9);
        assert_eq!(settings.report.tz_offset_minutes, 480);
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
