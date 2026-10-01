//! 运行时: 状态文档 + 4 个 action + 1 个 job 的分发与落地。
//!
//! # 分工
//!
//! | 入口 | 做什么 | 写不写 |
//! |------|--------|--------|
//! | `action refresh` | 重读 state(只读)+ 1 页 intents + 1 次日历 | 零业务写入, **不落盘** |
//! | `action align-now` | 限量对齐(≤1 页 intents, ≤5 次 PATCH, ≤3 次 Emby 探测) | 只 PATCH, **不落盘** |
//! | `action settings-update` | 白名单逐键合并 settings | 落盘(ETag 乐观锁) |
//! | `action probe-dump` | 两个未知端点的参数/字段矩阵 | 只写 `state.debug`, 落盘 |
//! | `job align` | 小时级全量对齐 + 追剧日历 + TG 日报 | PATCH + 落盘 |
//!
//! # 为什么 align-now 不落盘
//!
//! 设计规格给 align-now 的不变量是"PATCH ≤5 且 host.call 总数 ≤ 1 + max_patch_per_run + 3"。
//! 存储读写本身要花 2 次 host.call(GET 拿 ETag + PUT), 一旦落盘就必然越过这条预算, 所以
//! align-now 只改内存里的状态文档 —— 界面紧接着的 `state` op 就能看到结果, 由下一个整点
//! job 一并落盘。`refresh` 同理(规格要求"零写入")。两条路径都不会丢数据: 真正的业务写
//! (PATCH)已经发到宿主, 内存里的只是诊断记录。
//!
//! # 关键不变量
//!
//! - 单轮 PATCH ≤ `settings.max_patch_per_run` 且 ≤ [`crate::model::PATCH_HARD_LIMIT`];
//! - 单轮 Emby 探测 ≤ `settings.emby_probe_budget`(按实际 host.call 计数, 见
//!   [`crate::emby::fetch_coverage`] 的 `max_attempts`);
//! - 任何解析失败 ⇒ 该条零写入 + `state.debug` 留 ≤2048 字节原文;
//! - 减方向永不产生写请求(只进 `trim_suggestions`);
//! - `storage_ok == false`(宿主存储不可读)时**绝不落盘**, 免得默认值覆盖用户配置。

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Map, Value};

use crate::aircal;
use crate::align::{self, Decision, Evidence};
use crate::clock;
use crate::emby;
use crate::host;
use crate::intents::{self, Intent};
use crate::model::{
    self, AlignItem, CalendarItem, EmbyInstanceView, ProbeSnapshot, Settings, StateDoc,
    TrimSuggestion, ALIGN_ITEMS_MAX, SAMPLE_MAX,
};
use crate::notify;
use crate::raw::{self, ParseFailure, RawPayload};
use crate::store::{self, PutIds, StoreError};

/// 后台 job 的墙钟预算(manifest `background_timeout_ms = 240000`, 留 60s 余量)。
pub const RUN_BUDGET_SECS: i64 = 180;
/// align-now 的墙钟预算(规格: 硬预算 6s)。
pub const ALIGN_NOW_BUDGET_SECS: i64 = 6;
/// align-now 的 PATCH 硬上限(规格: ≤5)。
pub const ALIGN_NOW_PATCH_LIMIT: u8 = 5;
/// align-now 对未命中缓存的条目最多补发几次 Emby 探测(按 host.call 计数)。
pub const ALIGN_NOW_PROBE_LIMIT: u8 = 3;
/// align-now 复用的缓存新鲜度(6 小时)。
pub const CACHE_FRESH_SECS: i64 = 6 * 3600;
/// align-now 只读 1 页, 大小为 50(规格: `limit=50`)。
pub const ALIGN_NOW_PAGE_SIZE: u32 = 50;

/// `refresh` 的 action id。
pub const ACTION_REFRESH: &str = "refresh";
/// `align-now` 的 action id。
pub const ACTION_ALIGN_NOW: &str = "align-now";
/// `settings-update` 的 action id。
pub const ACTION_SETTINGS_UPDATE: &str = "settings-update";
/// `probe-dump` 的 action id。
pub const ACTION_PROBE_DUMP: &str = "probe-dump";
/// 4 个前台动作(不写进 manifest, 由本表分发; 未知 id 返回 `unknown_action`)。
pub const DECLARED_ACTIONS: &[&str] = &[
    ACTION_REFRESH,
    ACTION_ALIGN_NOW,
    ACTION_SETTINGS_UPDATE,
    ACTION_PROBE_DUMP,
];

/// `alignHourly` 的 job id(与 manifest 的 `jobs[0].handler` 对应)。
pub const JOB_ALIGN: &str = "align";

/// 解析失败要落进哪个 debug 快照槽。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailSlot {
    Emby,
    Calendar,
    /// 订阅池列表: 规格的不变量要求它解析失败时也留 ≤2048 字节原文(该条本轮零写入)。
    Intents,
    None,
}

/// 一轮对齐的计数(汇总进 `state.align` 与 `state.stats`)。
#[derive(Debug, Clone, Default)]
struct Counters {
    pages: u16,
    intents_seen: u16,
    matched: u16,
    patched: u16,
    skipped: u16,
    failed: u16,
    gap_total: u32,
    aligned: u32,
    unknown_shape: u32,
}

/// 插件运行时。
pub struct Runtime {
    state: StateDoc,
    /// 宿主存储是否已确认可用。
    storage_ok: bool,
    /// [`Runtime::ensure_loaded`] 闸门(整个 worker 会话只加载一次)。
    loaded: bool,
    put_ids: PutIds,
    /// 轮次序号(幂等键的最后一段)。
    run_seq: u64,
}

impl Runtime {
    /// 新建一个尚未加载的运行时。
    ///
    /// 刻意**不是** `const fn`: [`StateDoc::new`] 要走 `Default`(内含 `String`/`Vec`),
    /// 在 const 上下文里调不了。
    pub fn new() -> Self {
        Runtime {
            state: StateDoc::new(),
            storage_ok: false,
            loaded: false,
            put_ids: PutIds::new(),
            run_seq: 0,
        }
    }

    // ─────────────────────────── 加载 / 落盘 ───────────────────────────

    /// 首次业务调用时加载宿主存储(初始化握手期间**不能**走这里)。
    pub fn ensure_loaded(&mut self) {
        if self.loaded {
            return;
        }
        self.loaded = true;
        self.load_all();
    }

    /// 读取 `state` 单键。
    ///
    /// 三态: loaded(读到本文档)/ fresh(两次 404 确认的全新安装)/ unavailable(宿主不可读)。
    /// 只有前两种才允许落盘 —— unavailable 时保持 `storage_ok = false`。
    pub fn load_all(&mut self) {
        let (payload, result) = store::load_state_with_retry();
        match result {
            store::LoadResult::Fresh => self.storage_ok = true,
            store::LoadResult::Loaded => {
                if let Some(bytes) = payload.filter(|bytes| !bytes.is_empty()) {
                    self.apply_loaded(&bytes);
                }
            }
            store::LoadResult::Unavailable => {}
        }
    }

    /// 把读到的文档并进内存; **旧版本不覆盖新版本**(免得 refresh 把内存里更新的一轮结果冲掉)。
    fn apply_loaded(&mut self, bytes: &[u8]) -> bool {
        let Ok(document) = serde_json::from_slice::<StateDoc>(bytes) else { return false };
        if !document.is_recognizable() || document.revision < self.state.revision {
            return false;
        }
        self.state = document;
        self.state.settings.clamp();
        self.storage_ok = true;
        // 轮次序号跟着已落盘的版本走: worker 重启后新会话的幂等键不会与上一会话撞车
        // (同一条目的同一次补订在不同会话里必须是不同的 Idempotency-Key)。
        self.run_seq = self.run_seq.max(self.state.revision);
        true
    }

    /// 宿主存储是否已确认可用。
    pub fn storage_ok(&self) -> bool {
        self.storage_ok
    }

    /// 当前状态版本号。
    pub fn revision(&self) -> u64 {
        self.state.revision
    }

    /// 状态文档(响应与落盘共用)。
    pub fn state_doc(&self) -> &StateDoc {
        &self.state
    }

    /// 落盘: 版本 +1、裁剪、脱敏、带 ETag 乐观锁写回。
    ///
    /// 存储不可用时直接返回 `Ok(())`(本轮只读) —— 这是"默认值不得覆盖用户配置"的实现。
    pub fn persist_state(&mut self) -> Result<(), StoreError> {
        if !self.storage_ok {
            return Ok(());
        }
        self.state.settings.clamp();
        self.state.bump_revision();
        // 轮次序号只增不减地跟上版本(跨会话的幂等键唯一性, 见 `apply_loaded`)。
        self.run_seq = self.run_seq.max(self.state.revision);
        let mut bytes = match self.state.to_bytes() {
            Ok(bytes) => bytes,
            Err(message) => return Err(StoreError(message)),
        };
        // 最后一道闸门: 递归扫一遍凭据键名, 有就脱敏后重新序列化
        if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
            if raw::contains_forbidden_key(&value).is_some() {
                let mut value = value;
                raw::sanitize(&mut value);
                match serde_json::to_vec(&value) {
                    Ok(clean) => bytes = clean,
                    Err(err) => return Err(StoreError(format!("状态文档编码失败: {err}"))),
                }
            }
        }
        store::put(&mut self.put_ids, store::STATE_KEY, &bytes)
    }

    /// 落盘并吞掉错误(错误写进 `last_message` / 日志)。
    fn persist_quietly(&mut self) {
        if let Err(err) = self.persist_state() {
            let message = format!("状态落盘失败: {err}");
            self.state.last_message = message.clone();
            self.state.log("warning", &message);
        }
    }

    // ─────────────────────────── state op ───────────────────────────

    /// `state` op: 返回状态文档 + ETag, 支持 `if_none_match` 的 304 形态。
    pub fn state(&mut self, payload: RawPayload<'_>) -> Result<Value, OpError> {
        let obj = payload.as_object().map_err(|_| invalid_state())?;
        let _view = raw::string_field(obj, "view").map_err(|_| invalid_state())?;
        let if_none_match = raw::string_field(obj, "if_none_match").map_err(|_| invalid_state())?;

        let version = format!("state-v{}", self.state.revision);
        let etag = format!("\"{version}\"");
        if if_none_match == etag {
            return Ok(json!({"not_modified": true, "etag": etag}));
        }
        let document = self.state.clone();
        Ok(json!({"state_version": version, "etag": etag, "state": document}))
    }

    // ─────────────────────────── action op ───────────────────────────

    /// `action` op: 业务失败是**正常 result**, 只有 payload 本身非法才走 `-32602`。
    pub fn action(&mut self, invocation_id: &str, payload: RawPayload<'_>) -> Result<Value, OpError> {
        let obj = payload.as_object().map_err(|_| invalid_action())?;
        let id = raw::string_field(obj, "id").map_err(|_| invalid_action())?;
        if id.is_empty() {
            return Err(invalid_action());
        }
        let input: Map<String, Value> = match obj.and_then(|map| map.get("input")) {
            Some(Value::Object(input)) => input.clone(),
            _ => Map::new(),
        };
        match id.as_str() {
            ACTION_REFRESH => Ok(self.action_refresh()),
            ACTION_ALIGN_NOW => Ok(self.action_align_now(invocation_id)),
            ACTION_SETTINGS_UPDATE => Ok(self.action_settings_update(&input)),
            ACTION_PROBE_DUMP => Ok(self.action_probe_dump()),
            _ => Ok(json!({
                "status": "failed",
                "code": "unknown_action",
                "message": "未知动作"
            })),
        }
    }

    // ─────────────────────────── job op ───────────────────────────

    /// `job` op: 未声明的任务返回正常 result。
    pub fn job(&mut self, invocation_id: &str, payload: RawPayload<'_>) -> Result<Value, OpError> {
        let obj = match payload.as_object() {
            Ok(obj) => obj,
            Err(_) => return Ok(json!({"status": "skipped", "message": "任务参数无效"})),
        };
        let id = match raw::string_field(obj, "id") {
            Ok(id) => id,
            Err(_) => return Ok(json!({"status": "skipped", "message": "任务参数无效"})),
        };
        match id.as_str() {
            JOB_ALIGN => Ok(self.job_align(invocation_id)),
            _ => Ok(json!({"status": "skipped", "message": "未声明的任务"})),
        }
    }

    // ─────────────────────────── refresh ───────────────────────────

    /// 只读刷新: 重读 state + 1 页 intents + 1 次日历。零 PATCH, 不落盘。
    fn action_refresh(&mut self) -> Value {
        let started = clock::now_unix_secs();
        // 重读状态文档(只读; 只有更新的版本才会覆盖内存)
        if let store::StorageRead { value, ok: true, .. } = store::read(store::STATE_KEY) {
            self.apply_loaded(&value);
        }

        let mut message = String::new();
        let mut tv_intents = 0u32;
        match intents::fetch_page(ALIGN_NOW_PAGE_SIZE, 0) {
            Ok(fetched) => {
                // 只数 tv: 订阅池原则上已按 media_type=tv 过滤, 但真收到别的类型也
                // 不能把它算进"订阅剧集数"(界面是按这个数字展示的)。
                tv_intents = fetched
                    .page
                    .items
                    .iter()
                    .filter(|intent| intent.media_type == intents::MEDIA_TYPE)
                    .count() as u32;
                self.state.stats.tv_intents = tv_intents;
                self.state.record_attempt(
                    "pool.intents",
                    &format!("limit={ALIGN_NOW_PAGE_SIZE}&offset=0"),
                    fetched.http_status,
                    &format!("items={tv_intents}"),
                );
            }
            Err(failure) => {
                self.record_failure("refresh.intents", &failure, FailSlot::Intents);
                message = format!("订阅池读取失败: {}", failure.message);
            }
        }

        let mut calendar_days = 0usize;
        match aircal::fetch() {
            Ok(calendar) => {
                self.state.settings.probe.air_calendar_shape = calendar.shape.clone();
                self.state.debug.air_calendar = ProbeSnapshot {
                    status: "ok".to_string(),
                    shape: calendar.shape.clone(),
                    params_tried: vec!["(无参数)".to_string()],
                    http_status: 200,
                    sample: String::new(),
                    at: clock::now_rfc3339(),
                };
                let settings = self.state.settings.clone();
                let today = clock::local_date(settings.report.tz_offset_minutes);
                let window = calendar.window(&today, i64::from(settings.catch_up_days));
                calendar_days = window.len();
                self.state.calendar.days = window;
                self.state.calendar.fetched_at = clock::now_rfc3339();
                self.state.record_attempt(
                    "subscribe.air-calendar",
                    "(无参数)",
                    200,
                    &calendar.shape,
                );
            }
            Err(failure) => {
                self.record_failure("refresh.air-calendar", &failure, FailSlot::Calendar);
                if message.is_empty() {
                    message = format!("日历读取失败: {}", failure.message);
                }
            }
        }

        let matched = self.state.align.items.len() as u32;
        self.state.stats.matched = matched;
        // 只读动作**不动 revision**: 版本号代表"已落盘的内容", 内存里的诊断刷新不该
        // 让界面的 ETag 缓存失效(下一次真正落盘时版本自然会变)。
        let elapsed_ms = (clock::now_unix_secs() - started).max(0) * 1000;
        if message.is_empty() {
            message = format!("界面计数已刷新({elapsed_ms}ms)");
        }
        self.state.log("info", &message);
        json!({
            "status": "accepted",
            "message": message,
            "tv_intents": tv_intents,
            "matched": matched,
            "calendar_days": calendar_days,
            "checked_at": clock::now_rfc3339()
        })
    }

    // ─────────────────────────── align-now ───────────────────────────

    /// 限量对齐: 只用 1 页 intents + 缓存/最多 3 次 Emby 实测, PATCH ≤5。
    ///
    /// host.call 预算 = 1(intents) + PATCH 数 + 探测数 ≤ 1 + 5 + 3; 因此**不落盘**。
    fn action_align_now(&mut self, _invocation_id: &str) -> Value {
        self.run_seq += 1;
        let run_seq = self.run_seq;
        let started = clock::now_unix_secs();
        let deadline = started + ALIGN_NOW_BUDGET_SECS;
        let settings = self.state.settings.clone();
        if !settings.enabled {
            return json!({"status": "skipped", "message": "插件已停用"});
        }

        let now = clock::now_rfc3339();
        let mut counters = Counters::default();
        let mut budget_hit = false;

        // ① 只读 1 页
        let fetched = match intents::fetch_page(ALIGN_NOW_PAGE_SIZE, 0) {
            Ok(fetched) => fetched,
            Err(failure) => {
                self.record_failure("align-now.intents", &failure, FailSlot::Intents);
                return json!({
                    "status": "failed",
                    "message": format!("订阅池读取失败: {}", failure.message)
                });
            }
        };
        counters.pages = 1;

        let cache = self.cached_coverage();
        let patch_limit = settings.max_patch_per_run.min(ALIGN_NOW_PATCH_LIMIT);
        let mut probe_calls: u8 = 0;
        let mut patches: u8 = 0;
        let mut items: Vec<AlignItem> = Vec::new();
        let mut planned = 0usize;

        for intent in &fetched.page.items {
            if intent.media_type != intents::MEDIA_TYPE {
                continue;
            }
            counters.intents_seen = counters.intents_seen.saturating_add(1);
            if !intent.actionable() {
                counters.skipped = counters.skipped.saturating_add(1);
                continue;
            }
            if clock::now_unix_secs() > deadline {
                budget_hit = true;
                break;
            }

            // 优先用 6 小时内新鲜的缓存判定
            let cached = cache
                .get(&intent.id)
                .filter(|(at, _, _)| is_fresh(at, CACHE_FRESH_SECS))
                .cloned();
            let evidence = match cached {
                Some((_, have_max, have_count)) => {
                    Evidence::from_cache(intent.total_known, have_max, have_count)
                }
                None => {
                    let remaining = ALIGN_NOW_PROBE_LIMIT.saturating_sub(probe_calls);
                    let Some(selected) = self.selected_instance(&settings) else {
                        counters.skipped = counters.skipped.saturating_add(1);
                        continue;
                    };
                    if remaining == 0 {
                        counters.skipped = counters.skipped.saturating_add(1);
                        continue;
                    }
                    if clock::now_unix_secs() > deadline {
                        budget_hit = true;
                        break;
                    }
                    match emby::fetch_coverage(
                        intent.tmdb_id,
                        intent.season,
                        selected.proxy_id,
                        &self.state.settings.probe.emby_episodes_shape,
                        remaining.min(3),
                    ) {
                        Ok((coverage, query, calls)) => {
                            probe_calls = probe_calls.saturating_add(calls);
                            self.state.settings.probe.emby_episodes_shape = coverage.shape.clone();
                            self.state.record_attempt(
                                "emby.episodes",
                                &query.params_label(),
                                200,
                                &coverage.shape,
                            );
                            self.state.debug.emby_episodes = ProbeSnapshot {
                                status: "ok".to_string(),
                                shape: coverage.shape.clone(),
                                params_tried: vec![query.params_label()],
                                http_status: 200,
                                sample: String::new(),
                                at: now.clone(),
                            };
                            Evidence::from_coverage(intent.total_known, &coverage, 0)
                        }
                        Err(failure) => {
                            probe_calls = probe_calls.saturating_add(failure.attempts);
                            counters.failed = counters.failed.saturating_add(1);
                            counters.unknown_shape = counters.unknown_shape.saturating_add(1);
                            self.record_failure("align-now.emby.episodes", &failure, FailSlot::Emby);
                            items.push(item_of(
                                intent,
                                Decision {
                                    action: align::ACTION_FAILED,
                                    from_total: intent.total_known,
                                    to_total: intent.total_known,
                                    have_max: -1,
                                    have_count: -1,
                                    gap_max: 0,
                                    reason: failure.message.clone(),
                                },
                                &now,
                            ));
                            continue;
                        }
                    }
                }
            };

            let decision = align::decide(&evidence, &settings, settings.dry_run);
            counters.matched = counters.matched.saturating_add(1);
            counters.gap_total = counters.gap_total.saturating_add(decision.gap_max.max(0) as u32);
            match decision.action {
                align::ACTION_PATCHED => {
                    if patches >= patch_limit {
                        counters.skipped = counters.skipped.saturating_add(1);
                        items.push(item_of(
                            intent,
                            Decision {
                                action: align::ACTION_SKIPPED,
                                reason: format!("已达单轮补订上限 {patch_limit} 条"),
                                ..decision.clone()
                            },
                            &now,
                        ));
                        continue;
                    }
                    if clock::now_unix_secs() > deadline {
                        budget_hit = true;
                        break;
                    }
                    patches += 1;
                    planned += 1;
                    let outcome = self.send_patch(intent, &decision, &settings, run_seq);
                    if outcome.action == align::ACTION_PATCHED {
                        counters.patched = counters.patched.saturating_add(1);
                        counters.aligned = counters.aligned.saturating_add(1);
                    } else {
                        counters.failed = counters.failed.saturating_add(1);
                    }
                    items.push(item_of(intent, outcome, &now));
                }
                align::ACTION_DRY_RUN => {
                    planned += 1;
                    counters.aligned = counters.aligned.saturating_add(1);
                    items.push(item_of(intent, decision, &now));
                }
                _ => {
                    counters.skipped = counters.skipped.saturating_add(1);
                    items.push(item_of(intent, decision, &now));
                }
            }
        }

        // 只改内存(不落盘: host.call 预算见模块头)
        self.state.align.last_run_at = now.clone();
        self.state.align.pages = counters.pages;
        self.state.align.intents_seen = counters.intents_seen;
        self.state.align.matched = counters.matched;
        self.state.align.patched = counters.patched;
        self.state.align.skipped = counters.skipped;
        self.state.align.failed = counters.failed;
        self.state.align.items = items;
        self.state.stats.tv_intents = counters.intents_seen as u32;
        self.state.stats.matched = counters.matched as u32;
        self.state.stats.aligned = counters.aligned;
        self.state.stats.gap_total = counters.gap_total;
        self.state.stats.unknown_shape = counters.unknown_shape;
        self.state.status = "accepted".to_string();
        self.state.last_message =
            format!("立即对齐: 补订 {} 条, 跳过 {} 条", counters.patched, counters.skipped);
        self.state.last_run = clock::now_rfc3339();
        self.state.bump_revision();

        if budget_hit {
            // 超限的返回形状按规格固定
            return json!({
                "status": "accepted",
                "planned": planned,
                "patched": counters.patched,
                "skipped": counters.skipped,
                "budget_hit": true,
                "persisted": false,
                "message": format!("已达 {}s 预算, 本轮提前结束", ALIGN_NOW_BUDGET_SECS)
            });
        }
        let message = self.state.last_message.clone();
        json!({
            "status": "accepted",
            "planned": planned,
            "patched": counters.patched,
            "skipped": counters.skipped,
            "budget_hit": false,
            "persisted": false,
            "message": message
        })
    }

    /// 取当前应使用的 Emby 实例(不发起请求, 用内存里的实例列表)。
    ///
    /// 列表还是空的(全新安装、还没跑过 job / probe-dump)时, 用户**显式钉住**的实例 id
    /// 可以直接用 —— 这条路径不花 host.call, align-now 的 `1 + max_patch + 3` 预算不变,
    /// 也让"装好就点立即对齐"能真正干活。`-1`(跟随宿主默认)不猜: 默认实例只有
    /// instances 接口知道。
    fn selected_instance(&mut self, settings: &Settings) -> Option<emby::Selection> {
        let instances: Vec<emby::Instance> = self
            .state
            .emby_instances
            .iter()
            .map(|view| emby::Instance {
                id: view.id,
                name: view.name.clone(),
                is_default: view.is_default,
                key_ready: view.key_ready,
            })
            .collect();
        match emby::select(&instances, settings.emby_proxy_id) {
            Ok(selected) => Some(selected),
            Err(message) => {
                if instances.is_empty() {
                    if let Some(pinned) = emby::selection_from_settings(settings.emby_proxy_id) {
                        self.state.record_attempt(
                            "emby.instances",
                            "(无列表, 按配置直连)",
                            0,
                            &format!("id={}", pinned.id),
                        );
                        return Some(pinned);
                    }
                }
                self.state.record_error("emby.select", &message);
                None
            }
        }
    }

    // ─────────────────────────── settings-update ───────────────────────────

    /// 白名单逐键合并(绝不整块替换: 前端在 state 未加载时保存不能把配置清空)。
    fn action_settings_update(&mut self, input: &Map<String, Value>) -> Value {
        let mut changed: Vec<String> = Vec::new();
        {
            let settings = &mut self.state.settings;

            if let Some(value) = input.get("enabled").and_then(Value::as_bool) {
                settings.enabled = value;
                changed.push("enabled".to_string());
            }
            if let Some(value) = input.get("dry_run").and_then(Value::as_bool) {
                settings.dry_run = value;
                changed.push("dry_run".to_string());
            }
            if let Some(value) = input.get("write_episode_strings").and_then(Value::as_bool) {
                settings.write_episode_strings = value;
                changed.push("write_episode_strings".to_string());
            }
            if let Some(value) = input.get("emby_proxy_id").and_then(raw::loose_i64) {
                settings.emby_proxy_id = value;
                changed.push("emby_proxy_id".to_string());
            }
            if let Some(value) = input.get("max_patch_per_run").and_then(raw::loose_u64) {
                settings.max_patch_per_run =
                    value.min(u64::from(model::PATCH_HARD_LIMIT)) as u8;
                changed.push("max_patch_per_run".to_string());
            }
            if let Some(value) = input.get("max_raise_per_run").and_then(raw::loose_u64) {
                settings.max_raise_per_run = value.min(100) as u8;
                changed.push("max_raise_per_run".to_string());
            }
            if let Some(value) = input.get("catch_up_days").and_then(raw::loose_u64) {
                settings.catch_up_days = value.min(u64::from(u16::MAX)) as u16;
                changed.push("catch_up_days".to_string());
            }
            if let Some(value) = input.get("emby_probe_budget").and_then(raw::loose_u64) {
                settings.emby_probe_budget = value.min(u64::from(u16::MAX)) as u16;
                changed.push("emby_probe_budget".to_string());
            }
            // report.* 逐键合并
            if let Some(report) = input.get("report").and_then(Value::as_object) {
                if let Some(value) = report.get("enabled").and_then(Value::as_bool) {
                    settings.report.enabled = value;
                    changed.push("report.enabled".to_string());
                }
                if let Some(value) = report.get("hour").and_then(raw::loose_u64) {
                    settings.report.hour = value.min(23) as u8;
                    changed.push("report.hour".to_string());
                }
                if let Some(value) = report.get("tz_offset_minutes").and_then(raw::loose_i64) {
                    settings.report.tz_offset_minutes = value as i32;
                    changed.push("report.tz_offset_minutes".to_string());
                }
            }
            // probe.* 逐键合并(前端通常只读, 这里仍按白名单收)
            if let Some(probe) = input.get("probe").and_then(Value::as_object) {
                if let Some(value) = probe.get("emby_episodes_shape").and_then(Value::as_str) {
                    settings.probe.emby_episodes_shape =
                        raw::truncate_bytes(value, 200).to_string();
                    changed.push("probe.emby_episodes_shape".to_string());
                }
                if let Some(value) = probe.get("air_calendar_shape").and_then(Value::as_str) {
                    settings.probe.air_calendar_shape =
                        raw::truncate_bytes(value, 200).to_string();
                    changed.push("probe.air_calendar_shape".to_string());
                }
            }
            settings.clamp();
        }

        let message = if changed.is_empty() {
            "设置未变化".to_string()
        } else {
            format!("已更新设置: {}", changed.join(", "))
        };
        self.state.status = "succeeded".to_string();
        self.state.last_message = message.clone();
        self.state.last_run = clock::now_rfc3339();
        self.state.log("info", &message);
        self.persist_quietly();
        let settings = self.state.settings.clone();
        json!({
            "status": "succeeded",
            "message": message,
            "changed": changed,
            "settings": settings
        })
    }

    // ─────────────────────────── probe-dump ───────────────────────────

    /// 两个未知端点的参数/字段矩阵; 结果写 `state.debug`(唯一会写 debug 的前台动作)。
    fn action_probe_dump(&mut self) -> Value {
        self.run_seq += 1;
        let now = clock::now_rfc3339();

        // ① 实例列表(强类型, 顺便刷新界面下拉)
        match emby::fetch_instances() {
            Ok(instances) => {
                self.remember_instances(&instances);
                self.state.record_attempt("emby.instances", "(无参数)", 200, "ok");
            }
            Err(failure) => {
                self.record_failure("probe.emby.instances", &failure, FailSlot::None);
            }
        }
        let settings = self.state.settings.clone();
        let selected = self.selected_instance(&settings);

        // ② 探测样本: 优先用上一轮对齐的条目, 否则拉 1 页订阅池
        let sample = self
            .state
            .align
            .items
            .iter()
            .find(|item| item.tmdb_id > 0)
            .map(|item| (item.tmdb_id, item.season))
            .or_else(|| {
                intents::fetch_page(1, 0)
                    .ok()
                    .and_then(|fetched| fetched.page.items.into_iter().find(|item| item.tmdb_id > 0))
                    .map(|item| (item.tmdb_id, item.season))
            });

        let mut emby_shape = String::new();
        let mut emby_status = "skipped".to_string();
        let mut emby_http = 0i32;
        // 每个分支都会给这两个赋值, 所以不预置初值(预置了也只是死写)。
        let emby_sample: String;
        let params_tried: Vec<String>;

        match (selected, sample) {
            (Some(selected), Some((tmdb_id, season))) => {
                let mut tried = Vec::new();
                let mut last_failure: Option<ParseFailure> = None;
                let mut success: Option<(String, i32, String)> = None;
                for query in emby::candidates(tmdb_id, season, selected.proxy_id) {
                    tried.push(query.params_label());
                    match host::get(&query.path()) {
                        Ok(response) if response.status < 400 => {
                            match emby::parse_coverage(&response.raw) {
                                Ok(coverage) => {
                                    let shape =
                                        format!("{};{}", query.shape_prefix(), coverage.shape);
                                    self.state.record_attempt(
                                        "emby.episodes",
                                        &query.params_label(),
                                        response.status,
                                        &shape,
                                    );
                                    success = Some((
                                        shape,
                                        response.status,
                                        raw::sample_text(&response.raw, SAMPLE_MAX),
                                    ));
                                    break;
                                }
                                Err(message) => {
                                    self.state.record_attempt(
                                        "emby.episodes",
                                        &query.params_label(),
                                        response.status,
                                        "unparsed",
                                    );
                                    last_failure = Some(ParseFailure::http(
                                        response.status,
                                        response.raw.clone(),
                                        message,
                                    ));
                                }
                            }
                        }
                        Ok(response) => {
                            self.state.record_attempt(
                                "emby.episodes",
                                &query.params_label(),
                                response.status,
                                "http_error",
                            );
                            last_failure = Some(ParseFailure::http(
                                response.status,
                                response.raw.clone(),
                                format!("Emby 覆盖 HTTP {}", response.status),
                            ));
                        }
                        Err(err) => {
                            self.state.record_attempt(
                                "emby.episodes",
                                &query.params_label(),
                                0,
                                "transport_error",
                            );
                            last_failure = Some(ParseFailure::transport(format!(
                                "Emby 覆盖请求失败: {err}"
                            )));
                        }
                    }
                }
                match success {
                    Some((shape, status, sample)) => {
                        self.state.settings.probe.emby_episodes_shape = shape.clone();
                        emby_shape = shape;
                        emby_status = "ok".to_string();
                        emby_http = status;
                        emby_sample = sample;
                    }
                    None => {
                        let failure = last_failure
                            .unwrap_or_else(|| ParseFailure::transport("没有可用的 Emby 探测参数"));
                        emby_status = failure.kind().to_string();
                        emby_http = failure.http_status;
                        emby_sample = failure.sample();
                        self.record_failure("probe.emby.episodes", &failure, FailSlot::Emby);
                    }
                }
                params_tried = tried;
            }
            _ => {
                emby_sample = "没有可用的 TMDB 剧集样本或 Emby 实例; 先让订阅池里有 tv 条目".to_string();
                self.state.record_error("probe.emby.episodes", &emby_sample);
                params_tried = vec!["(无参数)".to_string()];
            }
        }
        self.state.debug.emby_episodes = ProbeSnapshot {
            status: emby_status.clone(),
            shape: emby_shape.clone(),
            params_tried: params_tried.clone(),
            http_status: emby_http,
            sample: emby_sample.clone(),
            at: now.clone(),
        };

        // ③ 追剧日历(无参数, 一次调用)
        let mut calendar_shape = String::new();
        // 两个分支都会赋值, 不预置初值。
        let calendar_status: String;
        let calendar_http: i32;
        let mut calendar_sample = String::new();
        match aircal::fetch() {
            Ok(calendar) => {
                calendar_shape = calendar.shape.clone();
                calendar_status = "ok".to_string();
                calendar_http = 200;
                self.state.record_attempt(
                    "subscribe.air-calendar",
                    "(无参数)",
                    200,
                    &calendar.shape,
                );
                self.state.settings.probe.air_calendar_shape = calendar.shape.clone();
                let today = clock::local_date(settings.report.tz_offset_minutes);
                let window = calendar.window(&today, i64::from(settings.catch_up_days));
                self.state.calendar.days = window;
                self.state.calendar.fetched_at = now.clone();
            }
            Err(failure) => {
                calendar_status = failure.kind().to_string();
                calendar_http = failure.http_status;
                calendar_sample = failure.sample();
                self.record_failure("probe.air-calendar", &failure, FailSlot::Calendar);
            }
        }
        self.state.debug.air_calendar = ProbeSnapshot {
            status: calendar_status.clone(),
            shape: calendar_shape.clone(),
            params_tried: vec!["(无参数)".to_string()],
            http_status: calendar_http,
            sample: calendar_sample.clone(),
            at: now.clone(),
        };
        self.state.debug.updated_at = now.clone();

        let message = format!("探测完成: emby={emby_status}, calendar={calendar_status}");
        self.state.status = "accepted".to_string();
        self.state.last_message = message.clone();
        self.state.last_run = now;
        self.state.log("info", &message);
        self.persist_quietly();

        json!({
            "status": "accepted",
            "message": message,
            "emby": {
                "shape": emby_shape,
                "http_status": emby_http,
                "sample_preview": raw::truncate_bytes(&emby_sample, 200).to_string(),
                "params_tried": params_tried
            },
            "calendar": {
                "shape": calendar_shape,
                "http_status": calendar_http,
                "sample_preview": raw::truncate_bytes(&calendar_sample, 200).to_string()
            },
            "state_version": format!("state-v{}", self.state.revision)
        })
    }

    // ─────────────────────────── 小时 job ───────────────────────────

    /// `alignHourly`: ① 加载 → ② 实例 → ③ 订阅池 → ④ 日历 → ⑤⑥⑦⑧ 逐条对齐 →
    /// ⑨⑩ 日报 → ⑪ 落盘。
    fn job_align(&mut self, _invocation_id: &str) -> Value {
        self.run_seq += 1;
        let run_seq = self.run_seq;
        let started = clock::now_unix_secs();
        let deadline = started + RUN_BUDGET_SECS;
        let mut settings = self.state.settings.clone();
        settings.clamp();
        let now = clock::now_rfc3339();
        self.state.last_run = now.clone();

        // ① 加载三态: unavailable 时本轮只读、绝不落盘
        if !self.storage_ok {
            let message = "宿主存储不可用: 本轮只读, 不落盘".to_string();
            self.state.log("warning", &message);
            self.state.last_message = message.clone();
            return json!({"status": "skipped", "message": message});
        }

        if !settings.enabled {
            self.state.status = "skipped".to_string();
            self.state.last_message = "插件已停用".to_string();
            self.state.log("info", "插件已停用, 跳过本轮对齐");
            self.persist_quietly();
            return json!({"status": "skipped", "message": "插件已停用"});
        }

        let mut counters = Counters::default();
        let mut items: Vec<AlignItem> = Vec::new();
        let mut trims: Vec<TrimSuggestion> = Vec::new();

        // ② 实例解析
        let mut selection: Option<emby::Selection> = None;
        // 规格 ⑤ 降级 4: 实例层不可用 ⇒ 整段 Emby 跳过, 且要在日报里报「本轮未对齐: <原因>」。
        let mut alignment_blocked: Option<String> = None;
        match emby::fetch_instances() {
            Ok(instances) => {
                self.remember_instances(&instances);
                self.state.record_attempt(
                    "emby.instances",
                    "(无参数)",
                    200,
                    &format!("items={}", instances.len()),
                );
                match emby::select(&instances, settings.emby_proxy_id) {
                    Ok(selected) => selection = Some(selected),
                    Err(message) => {
                        self.state.record_error("emby.select", &message);
                        self.state.log("warning", &format!("Emby 段跳过: {message}"));
                        alignment_blocked = Some(format!("本轮未对齐: {message}"));
                    }
                }
            }
            Err(failure) => {
                self.record_failure("emby.instances", &failure, FailSlot::None);
                self.state.log("warning", &format!("Emby 段跳过: {}", failure.message));
                alignment_blocked = Some(format!("本轮未对齐: {}", failure.message));
            }
        }
        if selection.is_none() {
            if alignment_blocked.is_none() {
                alignment_blocked = Some("本轮未对齐: 没有可用的 Emby 实例".to_string());
            }
            let status = self.state.debug.emby_episodes.status.clone();
            if status.is_empty() || status == "never" {
                self.state.debug.emby_episodes.status = "skipped".to_string();
            }
        }

        // ③ 订阅池(≤4 页 / 2000 条)
        let mut pool: Vec<Intent> = Vec::new();
        let mut list_failure: Option<ParseFailure> = None;
        for page in 0..intents::PAGES_MAX {
            let offset = page * intents::LIMIT_MAX;
            match intents::fetch_page(intents::LIMIT_MAX, offset) {
                Ok(fetched) => {
                    counters.pages = counters.pages.saturating_add(1);
                    let received = fetched.page.items.len();
                    pool.extend(fetched.page.items);
                    self.state.record_attempt(
                        "pool.intents",
                        &format!("limit={}&offset={offset}", intents::LIMIT_MAX),
                        fetched.http_status,
                        &format!("items={received}"),
                    );
                    if received < intents::LIMIT_MAX as usize {
                        break;
                    }
                }
                Err(failure) => {
                    list_failure = Some(failure);
                    break;
                }
            }
        }
        if let Some(failure) = list_failure {
            // 整轮跳过: 零业务写入, 只写 debug(含 ≤2048 字节原文, 见 FailSlot::Intents)
            self.record_failure("job.intents", &failure, FailSlot::Intents);
            self.state.align.last_error = failure.message.clone();
            self.state.stats.tv_intents = pool
                .iter()
                .filter(|intent| intent.media_type == intents::MEDIA_TYPE)
                .count() as u32;
            let message =
                format!("订阅池不可解析, 整轮跳过(零写入): {}", failure.message);
            self.state.status = "failed".to_string();
            self.state.last_message = message.clone();
            self.state.log("error", &message);
            self.persist_quietly();
            return json!({"status": "failed", "message": message});
        }
        counters.intents_seen = pool
            .iter()
            .filter(|intent| intent.media_type == intents::MEDIA_TYPE)
            .count() as u16;
        self.state.stats.tv_intents = counters.intents_seen as u32;

        // ④ 追剧日历(失败只影响界面与日报段①, 对齐照常)
        let mut calendar_today: Vec<CalendarItem> = Vec::new();
        match aircal::fetch() {
            Ok(calendar) => {
                let today = clock::local_date(settings.report.tz_offset_minutes);
                calendar_today = calendar.items_on(&today);
                let window = calendar.window(&today, i64::from(settings.catch_up_days));
                self.state.calendar.days = window;
                self.state.calendar.fetched_at = now.clone();
                self.state.settings.probe.air_calendar_shape = calendar.shape.clone();
                self.state.debug.air_calendar = ProbeSnapshot {
                    status: "ok".to_string(),
                    shape: calendar.shape.clone(),
                    params_tried: vec!["(无参数)".to_string()],
                    http_status: 200,
                    sample: String::new(),
                    at: now.clone(),
                };
                self.state.record_attempt(
                    "subscribe.air-calendar",
                    "(无参数)",
                    200,
                    &calendar.shape,
                );
            }
            Err(failure) => {
                self.record_failure("job.air-calendar", &failure, FailSlot::Calendar);
                self.state.log(
                    "warning",
                    &format!(
                        "追剧日历不可解析, 日报只发补订段: {}",
                        failure.message
                    ),
                );
            }
        }

        // ⑤⑥⑦⑧ 逐条对齐
        let patch_limit = settings.max_patch_per_run.min(model::PATCH_HARD_LIMIT);
        let mut coverage_cache: BTreeMap<String, emby::Coverage> = BTreeMap::new();
        // 同一个 (实例, 剧, 季) 本轮只探一次; 失败过的也一样 —— 否则一个结构认不出的
        // 端点会被每一条同剧条目各烧掉最多 3 次 host.call。
        let mut failed_keys: BTreeSet<String> = BTreeSet::new();
        let mut target_cache: BTreeMap<(i64, i64), i64> = BTreeMap::new();
        let mut probes: u16 = 0;
        // 与 `patch_limit`(u8)同型: 直接比大小, 不做隐式转换。
        let mut patches: u8 = 0;
        let mut budget_hit = false;

        if selection.is_some() {
            'align: for intent in &pool {
                if intent.media_type != intents::MEDIA_TYPE {
                    continue;
                }
                let Some(selected) = selection.as_ref() else { break };
                if !intent.actionable() {
                    counters.skipped = counters.skipped.saturating_add(1);
                    push_align_item(
                        &mut items,
                        item_of(
                            intent,
                            Decision {
                                action: align::ACTION_SKIPPED,
                                from_total: intent.total_known,
                                to_total: intent.total_known,
                                have_max: -1,
                                have_count: -1,
                                gap_max: 0,
                                reason: format!("状态 {} 不参与补订", display_state(&intent.state)),
                            },
                            &now,
                        ),
                    );
                    continue;
                }
                if patches >= patch_limit {
                    counters.skipped = counters.skipped.saturating_add(1);
                    push_align_item(
                        &mut items,
                        item_of(
                            intent,
                            Decision {
                                action: align::ACTION_SKIPPED,
                                from_total: intent.total_known,
                                to_total: intent.total_known,
                                have_max: -1,
                                have_count: -1,
                                gap_max: 0,
                                reason: format!("已达单轮补订上限 {patch_limit} 条"),
                            },
                            &now,
                        ),
                    );
                    continue;
                }
                if clock::now_unix_secs() > deadline {
                    budget_hit = true;
                    break 'align;
                }

                // ⑤ Emby 覆盖(同 (实例, 剧, 季) 只探一次)
                let key = format!(
                    "{}:{}:{}",
                    selected.proxy_id.unwrap_or(0),
                    intent.tmdb_id,
                    intent.season
                );
                let coverage = match coverage_cache.get(&key) {
                    Some(coverage) => coverage.clone(),
                    None => {
                        if failed_keys.contains(&key) {
                            counters.skipped = counters.skipped.saturating_add(1);
                            push_align_item(
                                &mut items,
                                item_of(
                                    intent,
                                    Decision {
                                        action: align::ACTION_SKIPPED,
                                        from_total: intent.total_known,
                                        to_total: intent.total_known,
                                        have_max: -1,
                                        have_count: -1,
                                        gap_max: 0,
                                        reason: "同一剧集本轮已探测失败, 不重复消耗预算".to_string(),
                                    },
                                    &now,
                                ),
                            );
                            continue;
                        }
                        let remaining = settings.emby_probe_budget.saturating_sub(probes);
                        if remaining == 0 {
                            counters.skipped = counters.skipped.saturating_add(1);
                            push_align_item(
                                &mut items,
                                item_of(
                                    intent,
                                    Decision {
                                        action: align::ACTION_SKIPPED,
                                        from_total: intent.total_known,
                                        to_total: intent.total_known,
                                        have_max: -1,
                                        have_count: -1,
                                        gap_max: 0,
                                        reason: format!(
                                            "Emby 探测预算用尽({})",
                                            settings.emby_probe_budget
                                        ),
                                    },
                                    &now,
                                ),
                            );
                            continue;
                        }
                        if clock::now_unix_secs() > deadline {
                            budget_hit = true;
                            break 'align;
                        }
                        match emby::fetch_coverage(
                            intent.tmdb_id,
                            intent.season,
                            selected.proxy_id,
                            &self.state.settings.probe.emby_episodes_shape,
                            remaining.min(3) as u8,
                        ) {
                            Ok((coverage, query, calls)) => {
                                probes = probes.saturating_add(u16::from(calls));
                                self.state.settings.probe.emby_episodes_shape =
                                    coverage.shape.clone();
                                self.state.record_attempt(
                                    "emby.episodes",
                                    &query.params_label(),
                                    200,
                                    &coverage.shape,
                                );
                                self.state.debug.emby_episodes = ProbeSnapshot {
                                    status: "ok".to_string(),
                                    shape: coverage.shape.clone(),
                                    params_tried: vec![query.params_label()],
                                    http_status: 200,
                                    sample: String::new(),
                                    at: now.clone(),
                                };
                                coverage_cache.insert(key.clone(), coverage.clone());
                                coverage
                            }
                            Err(failure) => {
                                // 该条零写入 + 原文留档, 继续下一条
                                probes = probes.saturating_add(u16::from(failure.attempts));
                                failed_keys.insert(key.clone());
                                counters.failed = counters.failed.saturating_add(1);
                                counters.unknown_shape = counters.unknown_shape.saturating_add(1);
                                self.record_failure("job.emby.episodes", &failure, FailSlot::Emby);
                                push_align_item(
                                    &mut items,
                                    item_of(
                                        intent,
                                        Decision {
                                            action: align::ACTION_FAILED,
                                            from_total: intent.total_known,
                                            to_total: intent.total_known,
                                            have_max: -1,
                                            have_count: -1,
                                            gap_max: 0,
                                            reason: failure.message.clone(),
                                        },
                                        &now,
                                    ),
                                );
                                continue;
                            }
                        }
                    }
                };
                counters.matched = counters.matched.saturating_add(1);

                // ⑥ 目标上限: 该季 TMDB 集数(取不到就 0, 只靠 Emby 缺口)
                let target_upper = match target_cache.get(&(intent.tmdb_id, intent.season)) {
                    Some(target) => *target,
                    None => {
                        if clock::now_unix_secs() > deadline {
                            budget_hit = true;
                            break 'align;
                        }
                        let target = self.fetch_target_upper(intent.tmdb_id, intent.season);
                        target_cache.insert((intent.tmdb_id, intent.season), target);
                        target
                    }
                };

                let evidence =
                    Evidence::from_coverage(intent.total_known, &coverage, target_upper);
                let decision = align::decide(&evidence, &settings, settings.dry_run);
                counters.gap_total =
                    counters.gap_total.saturating_add(decision.gap_max.max(0) as u32);

                match decision.action {
                    align::ACTION_PATCHED => {
                        if patches >= patch_limit {
                            counters.skipped = counters.skipped.saturating_add(1);
                            push_align_item(
                                &mut items,
                                item_of(
                                    intent,
                                    Decision {
                                        action: align::ACTION_SKIPPED,
                                        reason: format!("已达单轮补订上限 {patch_limit} 条"),
                                        ..decision.clone()
                                    },
                                    &now,
                                ),
                            );
                        } else {
                            patches += 1;
                            let outcome = self.send_patch(intent, &decision, &settings, run_seq);
                            if outcome.action == align::ACTION_PATCHED {
                                counters.patched = counters.patched.saturating_add(1);
                                counters.aligned = counters.aligned.saturating_add(1);
                            } else {
                                // 非 200 记 failed: 本轮不重试, 下一小时再来
                                counters.failed = counters.failed.saturating_add(1);
                            }
                            push_align_item(&mut items, item_of(intent, outcome, &now));
                        }
                    }
                    align::ACTION_DRY_RUN => {
                        counters.aligned = counters.aligned.saturating_add(1);
                        push_align_item(&mut items, item_of(intent, decision, &now));
                    }
                    _ => {
                        counters.skipped = counters.skipped.saturating_add(1);
                        push_align_item(&mut items, item_of(intent, decision, &now));
                    }
                }

                // ⑧ 减方向建议(只读; 永不写)
                if align::should_suggest_trim(
                    intent.total_known,
                    &coverage,
                    target_upper,
                    intent.trim_candidate(),
                ) {
                    trims.push(TrimSuggestion {
                        intent_id: intent.id,
                        tmdb_id: intent.tmdb_id,
                        season: intent.season,
                        title: intent.title.clone(),
                        total_known: intent.total_known,
                        emby_have_max: coverage.have_max().unwrap_or(-1),
                        target_upper,
                        reason: align::trim_reason(intent.total_known, target_upper),
                        at: now.clone(),
                    });
                }
            }
        }

        // 落账(计数 + 逐条结果)
        self.state.align.last_run_at = now.clone();
        self.state.align.pages = counters.pages;
        self.state.align.intents_seen = counters.intents_seen;
        self.state.align.matched = counters.matched;
        self.state.align.patched = counters.patched;
        self.state.align.skipped = counters.skipped;
        self.state.align.failed = counters.failed;
        // 有逐条失败就记第一条; 整段 Emby 跳过(没有逐条失败)时记「本轮未对齐: <原因>」,
        // 这条字符串会被日报段③当作"首个原因"回显(规格 ⑤ 降级 4)。
        self.state.align.last_error = items
            .iter()
            .find(|item| item.action == align::ACTION_FAILED)
            .map(|item| item.reason.clone())
            .or_else(|| alignment_blocked.clone())
            .unwrap_or_default();
        self.state.align.items = items;
        self.state.trim_suggestions = trims;
        self.state.stats.matched = counters.matched as u32;
        self.state.stats.aligned = counters.aligned;
        self.state.stats.gap_total = counters.gap_total;
        self.state.stats.unknown_shape = counters.unknown_shape;

        // ⑨⑩ 日报
        let report = self.maybe_send_daily(&settings, &calendar_today, &now, run_seq);

        // ⑪ 落盘
        let message = format!(
            "对齐完成: 订阅 {} 条, 判定 {} 条, 补订 {} 条, 跳过 {} 条, 失败 {} 条{}",
            counters.intents_seen,
            counters.matched,
            counters.patched,
            counters.skipped,
            counters.failed,
            if budget_hit { " (时间预算用尽)" } else { "" }
        );
        self.state.status = "accepted".to_string();
        self.state.last_message = message.clone();
        self.state.log("info", &message);
        self.persist_quietly();

        json!({
            "status": "accepted",
            "message": message,
            "pages": counters.pages,
            "intents_seen": counters.intents_seen,
            "matched": counters.matched,
            "patched": counters.patched,
            "skipped": counters.skipped,
            "failed": counters.failed,
            "budget_hit": budget_hit,
            "report": report
        })
    }

    /// ⑨⑩ 日报判定与落账; 返回给 job 响应的简述。
    fn maybe_send_daily(
        &mut self,
        settings: &Settings,
        calendar_today: &[CalendarItem],
        now: &str,
        run_seq: u64,
    ) -> Value {
        let today = clock::local_date(settings.report.tz_offset_minutes);
        let hour = clock::local_hour(settings.report.tz_offset_minutes);
        if !notify::should_send(&settings.report, &self.state.daily.last_sent_date, &today, hour) {
            return json!({"status": "idle", "date": today});
        }
        let patched: Vec<AlignItem> = self
            .state
            .align
            .items
            .iter()
            .filter(|item| {
                item.action == align::ACTION_PATCHED || item.action == align::ACTION_DRY_RUN
            })
            .cloned()
            .collect();
        let first_reason = self
            .state
            .align
            .items
            .iter()
            .find(|item| {
                item.action == align::ACTION_FAILED || item.action == align::ACTION_SKIPPED
            })
            .map(|item| item.reason.clone())
            .filter(|reason| !reason.is_empty())
            // 没有逐条原因(整段 Emby 跳过 / 订阅池为空)时回落到本轮的 last_error ——
            // 「本轮未对齐: <原因>」正是从这里进日报段③的。
            .unwrap_or_else(|| self.state.align.last_error.clone());
        let (title, body) = notify::compose(
            &today,
            calendar_today,
            &patched,
            u32::from(self.state.align.skipped),
            u32::from(self.state.align.failed),
            &first_reason,
        );
        match notify::send("info", &title, &body, &today, run_seq) {
            Ok((outcome, status)) => {
                notify::apply_outcome(&mut self.state.daily, &today, &outcome, now);
                self.state.record_attempt("notifications.plugin", "chase-daily", status, "sent");
                let result = self.state.daily.last_result.clone();
                json!({
                    "status": result,
                    "accepted": outcome.accepted,
                    "deduplicated": outcome.deduplicated,
                    "suppressed": outcome.suppressed
                })
            }
            Err(message) => {
                self.state.daily.last_at = now.to_string();
                self.state.daily.last_result = "failed".to_string();
                self.state.daily.last_error = raw::truncate_bytes(&message, 200).to_string();
                self.state.record_error("job.notify", &message);
                json!({"status": "failed", "message": message})
            }
        }
    }

    // ─────────────────────────── 内部工具 ───────────────────────────

    /// 解析失败: 记错误列表 + 日志 + 尝试记录; 需要时把 ≤2048 字节原文写进 debug 快照。
    fn record_failure(&mut self, step: &str, failure: &ParseFailure, slot: FailSlot) {
        let message = if failure.http_status > 0 {
            format!("{} (HTTP {})", failure.message, failure.http_status)
        } else {
            failure.message.clone()
        };
        self.state.record_error(step, &message);
        self.state.log("warning", &format!("{step}: {message}"));
        self.state.record_attempt(
            endpoint_of(step),
            "(见 last_errors)",
            failure.http_status,
            failure.kind(),
        );
        let sample = failure.sample();
        let snapshot = ProbeSnapshot {
            status: failure.kind().to_string(),
            shape: String::new(),
            params_tried: Vec::new(),
            http_status: failure.http_status,
            sample: String::new(),
            at: clock::now_rfc3339(),
        };
        match slot {
            FailSlot::Emby => {
                let mut snapshot = snapshot;
                snapshot.sample = sample;
                self.state.debug.emby_episodes = snapshot;
            }
            FailSlot::Calendar => {
                let mut snapshot = snapshot;
                snapshot.sample = sample;
                self.state.debug.air_calendar = snapshot;
            }
            FailSlot::Intents => {
                let mut snapshot = snapshot;
                snapshot.sample = sample;
                self.state.debug.pool_intents = snapshot;
            }
            FailSlot::None => {}
        }
    }

    /// 记下最近一次成功解析的实例列表(界面设置抽屉的数据源)。
    fn remember_instances(&mut self, instances: &[emby::Instance]) {
        let at = clock::now_rfc3339();
        self.state.emby_instances = instances
            .iter()
            .map(|instance| EmbyInstanceView {
                id: instance.id,
                name: raw::truncate_bytes(&instance.name, 160).to_string(),
                is_default: instance.is_default,
                key_ready: instance.key_ready,
                at: at.clone(),
            })
            .collect();
    }

    /// align-now 的缓存: intent_id → (探测时刻, have_max, have_count)。
    fn cached_coverage(&self) -> BTreeMap<i64, (String, i64, i64)> {
        self.state
            .align
            .items
            .iter()
            .map(|item| {
                (item.intent_id, (item.at.clone(), item.emby_have_max, item.emby_have_count))
            })
            .collect()
    }

    /// ⑥ 该季 TMDB 集数; 失败记 debug 并返回 0(只用 Emby 缺口判定)。
    fn fetch_target_upper(&mut self, tmdb_id: i64, season: i64) -> i64 {
        let path = format!("/api/tmdb/tv/{tmdb_id}");
        match host::get(&path) {
            Ok(response) if response.status < 400 => {
                match align::parse_target_upper(&response.raw, season) {
                    Ok(target) => {
                        self.state.record_attempt(
                            "tmdb.tv",
                            &format!("id={tmdb_id}&season={season}"),
                            response.status,
                            &format!("target={target}"),
                        );
                        target
                    }
                    Err(message) => {
                        self.state.record_attempt(
                            "tmdb.tv",
                            &format!("id={tmdb_id}&season={season}"),
                            response.status,
                            "unparsed",
                        );
                        self.state.record_error("job.tmdb", &message);
                        0
                    }
                }
            }
            Ok(response) => {
                let message = format!("TMDB HTTP {}", response.status);
                self.state.record_attempt(
                    "tmdb.tv",
                    &format!("id={tmdb_id}&season={season}"),
                    response.status,
                    "http_error",
                );
                self.state.record_error("job.tmdb", &message);
                0
            }
            Err(err) => {
                self.state.record_error("job.tmdb", &format!("TMDB 请求失败: {err}"));
                0
            }
        }
    }

    /// ⑦ 发一次 PATCH(非 200 记 failed, 本轮不重试)。
    fn send_patch(
        &mut self,
        intent: &Intent,
        decision: &Decision,
        settings: &Settings,
        run_seq: u64,
    ) -> Decision {
        // 双保险: 只增 + 幅度上限, 任何情况下都不发缩小或越界的请求
        if decision.to_total <= intent.total_known
            || decision.to_total - intent.total_known > i64::from(settings.max_raise_per_run)
        {
            return Decision {
                action: align::ACTION_SKIPPED,
                from_total: intent.total_known,
                to_total: intent.total_known,
                reason: "守卫拒绝: 目标集数不满足只增与幅度上限".to_string(),
                ..decision.clone()
            };
        }
        let (needed, covered) = if settings.write_episode_strings {
            (intent.needed_episodes.as_deref(), intent.covered_episodes.as_deref())
        } else {
            (None, None)
        };
        let body = intents::patch_body(decision.to_total, needed, covered);
        let key =
            intents::patch_idempotency_key(intent.id, decision.from_total, decision.to_total, run_seq);
        let path = intents::patch_path(intent.id);
        let response = host::send(
            "PATCH",
            &path,
            Some(&body),
            &[("accept", "application/json"), ("idempotency-key", &key)],
        );
        match response {
            Ok(response) if response.status == 200 => {
                self.state.record_attempt("pool.intents.patch", &key, 200, "patched");
                let log = format!(
                    "补订 intent={} {} S{}: {} → {}",
                    intent.id, intent.title, intent.season, decision.from_total, decision.to_total
                );
                self.state.log("info", &log);
                Decision { action: align::ACTION_PATCHED, ..decision.clone() }
            }
            Ok(response) => {
                let message = format!(
                    "PATCH HTTP {}: {}",
                    response.status,
                    raw::truncate_bytes(&response.text(), 160)
                );
                self.state.record_attempt("pool.intents.patch", &key, response.status, "failed");
                self.state.record_error("job.patch", &message);
                Decision {
                    action: align::ACTION_FAILED,
                    to_total: decision.from_total,
                    reason: message,
                    ..decision.clone()
                }
            }
            Err(err) => {
                let message = format!("PATCH 请求失败: {err}");
                self.state.record_error("job.patch", &message);
                Decision {
                    action: align::ACTION_FAILED,
                    to_total: decision.from_total,
                    reason: message,
                    ..decision.clone()
                }
            }
        }
    }
}

impl Default for Runtime {
    fn default() -> Self {
        Runtime::new()
    }
}

// ─────────────────────────── 自由函数 ───────────────────────────

/// `state` payload 非法。
fn invalid_state() -> OpError {
    OpError::new("invalid state payload")
}

/// `action` payload 非法。
fn invalid_action() -> OpError {
    OpError::new("invalid action payload")
}

/// 业务错误: 一律映射成 `-32602`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpError(pub String);

impl OpError {
    pub fn new(message: impl Into<String>) -> Self {
        OpError(message.into())
    }

    pub fn message(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for OpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for OpError {}

/// 判定结果 → 状态文档里的一行。
fn item_of(intent: &Intent, decision: Decision, at: &str) -> AlignItem {
    AlignItem {
        intent_id: intent.id,
        tmdb_id: intent.tmdb_id,
        season: intent.season,
        title: intent.title.clone(),
        total_known: intent.total_known,
        emby_have_max: decision.have_max,
        emby_have_count: decision.have_count,
        gap_max: decision.gap_max,
        from_total: decision.from_total,
        to_total: decision.to_total,
        action: decision.action.to_string(),
        reason: raw::truncate_bytes(&decision.reason, 400).to_string(),
        at: at.to_string(),
    }
}

/// 追加一行对齐结果; 满 [`ALIGN_ITEMS_MAX`] 时优先丢掉最旧的 `skipped`。
fn push_align_item(items: &mut Vec<AlignItem>, item: AlignItem) {
    if items.len() >= ALIGN_ITEMS_MAX {
        let position = items
            .iter()
            .position(|existing| existing.action == align::ACTION_SKIPPED)
            .unwrap_or(0);
        items.remove(position);
    }
    items.push(item);
}

/// 解析失败落在哪个端点上(debug.attempts[].endpoint)。
fn endpoint_of(step: &str) -> &str {
    if step.contains("emby") {
        "emby"
    } else if step.contains("calendar") {
        "subscribe.air-calendar"
    } else if step.contains("intents") || step.contains("patch") {
        "subscribe.pool.intents"
    } else if step.contains("notify") {
        "notifications.plugin"
    } else {
        step
    }
}

/// 状态值的中文占位(空状态在界面/日报里不能是空白)。
fn display_state(state: &str) -> &str {
    if state.is_empty() {
        "未知"
    } else {
        state
    }
}

/// RFC3339 时刻是否在 `secs` 秒以内(解析不出就当作不新鲜)。
fn is_fresh(at: &str, secs: i64) -> bool {
    match clock::parse_rfc3339_secs(at) {
        Some(then) => {
            let now = clock::now_unix_secs();
            now >= then && now - then <= secs
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::FakeHost;

    // ── 夹具 ──

    fn intents_body() -> Vec<u8> {
        // 注: 42 订阅 5 集而 Emby 夹具已有到第 12 集 → 两条 tv 都是"有缺口"条目。
        // 旧代码里 42 之所以在同轮被跳过, 是因为 TMDB 夹具只有第 5 季, 缺季回退到整剧
        // 62 集后被当成"抬升 57 集超过单条上限"的元数据异常; 那条回退已删除(整剧的
        // number_of_episodes 不是该季目标), 缺季按 target=0 走纯 Emby 缺口判定。
        r#"{
          "code": "ok",
          "data": [
            {"id": 41, "tmdb_id": 1396, "season": 5, "media_type": "tv",
             "title": "绝命毒师", "total_episodes_known": 10, "state": "partial"},
            {"id": 42, "tmdb_id": 1399, "season": 1, "media_type": "tv",
             "title": "权力的游戏", "total_episodes_known": 5, "state": "caught_up"},
            {"id": 43, "tmdb_id": 1, "season": 1, "media_type": "movie",
             "title": "电影", "total_episodes_known": 1, "state": "pending"}
          ],
          "counts": {}
        }"#.as_bytes()
        .to_vec()
    }

    fn instances_body() -> Vec<u8> {
        r#"{"items":[{"id":3,"name":"客厅","is_default":true,"api_key_configured":true}]}"#.as_bytes().to_vec()
    }

    fn episodes_body() -> Vec<u8> {
        br#"{"items":[{"index_number":1},{"index_number":2},{"index_number":12}],
             "missing":[11],"episode_count":3}"#
            .to_vec()
    }

    fn calendar_body() -> Vec<u8> {
        r#"{"items":[{"tmdb_id":1396,"season":5,"episode":1,"title":"绝命毒师",
                       "air_date":"2026-10-01","air_time":"12:00"}]}"#.as_bytes()
            .to_vec()
    }

    fn tmdb_body() -> Vec<u8> {
        r#"{"id":1396,"name":"绝命毒师","number_of_episodes":62,
             "seasons":[{"season_number":5,"episode_count":16}]}"#.as_bytes()
            .to_vec()
    }

    /// 装好一套可用的宿主(fake)与**尚未加载**的 runtime。
    ///
    /// 顺序很关键: 调用方要先 [`FakeHost::install`] 再 `runtime.ensure_loaded()` ——
    /// 本机没有宿主可连, 装替身之前加载只会拿到 `Unavailable`(那条路径另有专门用例覆盖)。
    fn harness() -> (FakeHost, Runtime) {
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, &intents_body());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, &instances_body());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/episodes?", 200, &episodes_body());
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 200, &calendar_body());
        fake.route_prefix("GET", "GET /api/tmdb/tv/", 200, &tmdb_body());
        // 订阅池的补订端点: 默认回 200(夹具里的"成功"路径)
        fake.route_prefix("PATCH", "PATCH /api/subscribe/pool/intents/", 200, b"{}");
        fake.route(
            "POST",
            "/api/notifications/plugin",
            200,
            br#"{"data":{"event":"plugin_notification","accepted":true},"meta":{}}"#,
        );
        (fake, Runtime::new())
    }

    fn call(runtime: &mut Runtime, request: &str) -> Value {
        let raw = crate::protocol::dispatch(runtime, request.as_bytes());
        serde_json::from_slice(&raw).unwrap_or_else(|err| {
            panic!("响应必须是合法 JSON: {err}; {:?}", String::from_utf8_lossy(&raw))
        })
    }

    fn action(runtime: &mut Runtime, id: &str, input: Value) -> Value {
        call(
            runtime,
            &format!(
                r#"{{"method":"runtime.invoke","params":{{"envelope":{{"op":"action","invocation_id":"inv","payload":{{"id":"{id}","input":{input}}}}}}}}}"#
            ),
        )["result"]
            .clone()
    }

    fn job(runtime: &mut Runtime, id: &str) -> Value {
        call(
            runtime,
            &format!(
                r#"{{"method":"runtime.invoke","params":{{"envelope":{{"op":"job","invocation_id":"inv","payload":{{"id":"{id}"}}}}}}}}"#
            ),
        )["result"]
            .clone()
    }

    fn stored(fake: &FakeHost) -> StateDoc {
        serde_json::from_slice(&fake.value_of("state").expect("必须落过盘")).unwrap()
    }

    // ── 加载 / 落盘 ──

    #[test]
    fn fresh_install_persists_and_unavailable_never_does() {
        // 存储 404 两次 → fresh → 允许落盘
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, &intents_body());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, &instances_body());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/episodes?", 200, &episodes_body());
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 200, &calendar_body());
        fake.route_prefix("GET", "GET /api/tmdb/tv/", 200, &tmdb_body());
        fake.route_prefix("PATCH", "PATCH /api/subscribe/pool/intents/", 200, b"{}");
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        assert!(runtime.storage_ok(), "两次 404 = 全新安装");
        let _ = job(&mut runtime, "align");
        assert!(fake.value_of("state").is_some(), "fresh 安装必须能落盘");
        drop(guard);

        // 宿主不可读 → unavailable → 绝不落盘
        let fake = FakeHost::new();
        fake.fail_all(true);
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        assert!(!runtime.storage_ok());
        let result = job(&mut runtime, "align");
        assert_eq!(result["status"], "skipped");
        assert!(fake.value_of("state").is_none(), "unavailable 时绝不许落盘");
        assert!(fake.puts().is_empty());
        drop(guard);
    }

    #[test]
    fn stale_documents_do_not_clobber_newer_memory_state() {
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, &intents_body());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, &instances_body());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/episodes?", 200, &episodes_body());
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 200, &calendar_body());
        fake.route_prefix("GET", "GET /api/tmdb/tv/", 200, &tmdb_body());
        fake.route_prefix("PATCH", "PATCH /api/subscribe/pool/intents/", 200, b"{}");
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();

        // 先跑一轮对齐(内存 revision 涨到 1, 已落盘)
        let _ = job(&mut runtime, "align");
        let persisted = stored(&fake);
        assert_eq!(persisted.revision, 1);

        // 旧的存储快照(revision 0)不能覆盖内存
        let stale = br#"{"schema_version":1,"revision":0,"status":"stale"}"#;
        fake.set("state", stale);
        let _ = action(&mut runtime, "refresh", json!({}));
        assert_ne!(runtime.state_doc().status, "stale");
        drop(guard);
    }

    // ── action 分发表 ──

    #[test]
    fn unknown_action_is_reported() {
        let (fake, mut runtime) = harness();
        let guard = fake.install();
        // 替身必须先装好, 运行时才读得到宿主存储(顺序反了会走到 Unavailable 分支)。
        runtime.ensure_loaded();
        let result = action(&mut runtime, "teleport", json!({}));
        assert_eq!(result["status"], "failed");
        assert_eq!(result["code"], "unknown_action");
        drop(guard);
    }

    #[test]
    fn declared_actions_are_exactly_the_four_from_the_spec() {
        assert_eq!(DECLARED_ACTIONS.len(), 4);
        for id in ["refresh", "align-now", "settings-update", "probe-dump"] {
            assert!(DECLARED_ACTIONS.contains(&id), "{id}");
        }
    }

    // ── refresh ──

    #[test]
    fn refresh_is_read_only_and_updates_counters() {
        let (fake, mut runtime) = harness();
        let guard = fake.install();
        // 替身必须先装好, 运行时才读得到宿主存储(顺序反了会走到 Unavailable 分支)。
        runtime.ensure_loaded();
        let before = crate::host::observed_calls();
        let result = action(&mut runtime, "refresh", json!({}));
        assert_eq!(result["status"], "accepted");
        assert_eq!(result["tv_intents"], 2, "夹具里的 movie 条目不计数");
        assert_eq!(result["calendar_days"], 1);
        assert!(fake.puts().is_empty(), "refresh 零写入");
        assert!(fake.patches().is_empty(), "refresh 零 PATCH");
        assert_eq!(runtime.state_doc().stats.tv_intents, 2);
        assert!(crate::host::observed_calls() - before <= 4, "刷新要快: 只该有 3~4 次调用");
        drop(guard);
    }

    // ── settings-update ──

    #[test]
    fn settings_update_merges_whitelist_and_clamps() {
        let (fake, mut runtime) = harness();
        let guard = fake.install();
        // 替身必须先装好, 运行时才读得到宿主存储(顺序反了会走到 Unavailable 分支)。
        runtime.ensure_loaded();
        let result = action(
            &mut runtime,
            "settings-update",
            json!({"max_patch_per_run": 99, "catch_up_days": 3, "report": {"enabled": true, "hour": 7},
                   "emby_proxy_id": 3, "unknown_key": 1, "blacklist": ["x"]}),
        );
        assert_eq!(result["status"], "succeeded");
        let settings = runtime.state_doc().settings.clone();
        assert_eq!(settings.max_patch_per_run, model::PATCH_HARD_LIMIT, "越界值夹到硬上限");
        assert_eq!(settings.catch_up_days, 3);
        assert!(settings.report.enabled);
        assert_eq!(settings.report.hour, 7);
        assert_eq!(settings.emby_proxy_id, 3);
        // 旧值不被清空: max_raise_per_run 没传, 保持默认
        assert_eq!(settings.max_raise_per_run, model::RAISE_DEFAULT);
        // 未白名单键被忽略
        assert!(!session_has_key(&result["settings"], "unknown_key"));

        // 落盘生效
        let persisted = stored(&fake);
        assert_eq!(persisted.settings.catch_up_days, 3);
        assert!(persisted.settings.report.enabled);
        drop(guard);
    }

    fn session_has_key(value: &Value, key: &str) -> bool {
        value.as_object().map(|map| map.contains_key(key)).unwrap_or(false)
    }

    // ── job: 全链路 ──

    #[test]
    fn hourly_job_patches_only_upward_and_records_items() {
        let (fake, mut runtime) = harness();
        let guard = fake.install();
        // 替身必须先装好, 运行时才读得到宿主存储(顺序反了会走到 Unavailable 分支)。
        runtime.ensure_loaded();
        let result = job(&mut runtime, "align");
        assert_eq!(result["status"], "accepted");
        assert_eq!(result["patched"], 2, "{result}");

        let patches = fake.patches();
        assert_eq!(patches.len(), 2);
        assert_eq!(patches[0].path, "/api/subscribe/pool/intents/41/episodes");
        let body = crate::host::decode_response_body(&crate::host::HostCallResponse {
            status: 200,
            headers: Default::default(),
            body_base64: patches[0].body_base64.clone(),
        })
        .unwrap();
        // Emby 已有 12 集, TMDB 16 集, 订阅 10 集 → 抬到 16
        assert_eq!(String::from_utf8_lossy(&body), r#"{"total_episodes":16}"#);
        let key = patches[0].headers.get("idempotency-key").cloned().unwrap_or_default();
        assert_eq!(key, "chase-patch-41-10-16-1");

        // 第二条 (tmdb 1399 第 1 季): TMDB 夹具只有第 5 季 → 该季目标取不到, target=0,
        // 只按 Emby 缺口判定: 已有到第 12 集, 订阅 5 集 → 抬到 12。
        // (旧的"缺季回退整剧 62 集"会把它误判成抬升 57 集的元数据异常, 连带压掉这条补订。)
        assert_eq!(patches[1].path, "/api/subscribe/pool/intents/42/episodes");
        let body = crate::host::decode_response_body(&crate::host::HostCallResponse {
            status: 200,
            headers: Default::default(),
            body_base64: patches[1].body_base64.clone(),
        })
        .unwrap();
        assert_eq!(String::from_utf8_lossy(&body), r#"{"total_episodes":12}"#);
        let key = patches[1].headers.get("idempotency-key").cloned().unwrap_or_default();
        assert_eq!(key, "chase-patch-42-5-12-1");

        let doc = stored(&fake);
        assert_eq!(doc.align.patched, 2);
        assert_eq!(doc.align.matched, 2);
        assert_eq!(doc.align.items.len(), 2);
        assert_eq!(doc.calendar.days.len(), 1);
        assert_eq!(doc.stats.tv_intents, 2, "movie 不参与");
        assert_eq!(doc.revision, 1);
        // 键名不得出现凭据模式
        let text = String::from_utf8(doc_bytes(&fake)).unwrap();
        assert!(!text.contains("api_key"), "{text}");
        drop(guard);
    }

    fn doc_bytes(fake: &FakeHost) -> Vec<u8> {
        fake.value_of("state").unwrap()
    }

    #[test]
    fn hourly_job_never_writes_eaquel_or_lower_totals() {
        // Emby 只有 3 集, 订阅 10 集, TMDB 10 集 → 不该有任何 PATCH
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, &intents_body());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, &instances_body());
        fake.route_prefix(
            "GET",
            "GET /api/plugin-host/emby/episodes?",
            200,
            br#"{"items":[{"index_number":1},{"index_number":2},{"index_number":3}]}"#,
        );
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 200, &calendar_body());
        fake.route_prefix(
            "GET",
            "GET /api/tmdb/tv/",
            200,
            br#"{"seasons":[{"season_number":5,"episode_count":10},{"season_number":1,"episode_count":5}]}"#,
        );
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let result = job(&mut runtime, "align");
        assert_eq!(result["patched"], 0, "{result}");
        assert!(fake.patches().is_empty(), "只增: 相等或更小一律不发请求");
        let doc = stored(&fake);
        assert_eq!(doc.align.skipped, 2);
        drop(guard);
    }

    #[test]
    fn emby_unparsable_records_sample_and_writes_nothing_for_that_entry() {
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, &intents_body());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, &instances_body());
        fake.route_prefix(
            "GET",
            "GET /api/plugin-host/emby/episodes?",
            200,
            r#"{"episode_count":12,"note":"只有数字"}"#.as_bytes(),
        );
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 200, &calendar_body());
        fake.route_prefix("GET", "GET /api/tmdb/tv/", 200, &tmdb_body());
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let result = job(&mut runtime, "align");
        assert_eq!(result["failed"], 2, "{result}");
        assert!(fake.patches().is_empty(), "解析失败绝不允许写");

        let doc = stored(&fake);
        assert_eq!(doc.debug.emby_episodes.status, "unparsed");
        assert!(doc.debug.emby_episodes.sample.contains("episode_count"));
        assert!(doc.debug.emby_episodes.sample.len() <= SAMPLE_MAX);
        assert!(doc.align.items.iter().all(|item| item.action == "failed"));
        drop(guard);
    }

    #[test]
    fn pool_list_failure_skips_the_whole_round_with_zero_writes() {
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 500, b"boom");
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, &instances_body());
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let result = job(&mut runtime, "align");
        assert_eq!(result["status"], "failed");
        assert!(fake.patches().is_empty());
        assert!(fake.value_of("state").is_some(), "只写 debug, 不写业务数据");
        let doc = stored(&fake);
        assert!(doc.align.last_error.contains("订阅池"), "{:?}", doc.align.last_error);
        drop(guard);
    }

    #[test]
    fn missing_emby_instances_skip_alignment_but_still_report() {
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, &intents_body());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, br#"{"items":[]}"#);
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 200, &calendar_body());
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let result = job(&mut runtime, "align");
        assert_eq!(result["status"], "accepted");
        assert_eq!(result["patched"], 0);
        assert!(fake.patches().is_empty(), "没有实例 → 零 PATCH");
        let doc = stored(&fake);
        assert!(doc.debug.last_errors.iter().any(|error| error.step == "emby.select"));
        assert!(doc.align.items.is_empty());
        drop(guard);
    }

    #[test]
    fn patch_limit_is_enforced_across_the_round() {
        let fake = FakeHost::new();
        // 20 条都要补订, 但配置只允许 2 条
        let mut items = Vec::new();
        for index in 0..20 {
            items.push(format!(
                r#"{{"id":{index},"tmdb_id":{index},"season":1,"media_type":"tv",
                   "title":"剧{index}","total_episodes_known":1,"state":"partial"}}"#
            ));
        }
        let body = format!(r#"{{"code":"ok","data":[{}],"counts":{{}}}}"#, items.join(","));
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, body.as_bytes());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, &instances_body());
        fake.route_prefix(
            "GET",
            "GET /api/plugin-host/emby/episodes?",
            200,
            br#"{"items":[{"index_number":1},{"index_number":2}]}"#,
        );
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 200, &calendar_body());
        fake.route_prefix("PATCH", "PATCH /api/subscribe/pool/intents/", 200, b"{}");
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let _ = action(&mut runtime, "settings-update", json!({"max_patch_per_run": 2}));
        let result = job(&mut runtime, "align");
        assert_eq!(result["patched"], 2, "{result}");
        assert_eq!(fake.patches().len(), 2, "单轮 PATCH 不得超过配置上限");
        drop(guard);
    }

    #[test]
    fn dry_run_writes_nothing_but_still_reports() {
        let (fake, mut runtime) = harness();
        let guard = fake.install();
        // 替身必须先装好, 运行时才读得到宿主存储(顺序反了会走到 Unavailable 分支)。
        runtime.ensure_loaded();
        let _ = action(&mut runtime, "settings-update", json!({"dry_run": true}));
        let result = job(&mut runtime, "align");
        assert_eq!(result["patched"], 0);
        assert!(fake.patches().is_empty(), "dry-run 绝不写");
        let doc = stored(&fake);
        assert!(doc.align.items.iter().any(|item| item.action == "dry-run"));
        drop(guard);
    }

    #[test]
    fn trim_suggestions_are_read_only() {
        let fake = FakeHost::new();
        fake.route_prefix(
            "GET",
            "GET /api/subscribe/pool/intents?",
            200,
            r#"{"code":"ok","data":[{"id":41,"tmdb_id":1396,"season":5,"media_type":"tv",
                 "title":"绝命毒师","total_episodes_known":16,"state":"caught_up"}],"counts":{}}"#.as_bytes(),
        );
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, &instances_body());
        fake.route_prefix(
            "GET",
            "GET /api/plugin-host/emby/episodes?",
            200,
            br#"{"items":[{"index_number":1},{"index_number":2},{"index_number":3},
                        {"index_number":4},{"index_number":5},{"index_number":6},
                        {"index_number":7},{"index_number":8},{"index_number":9},
                        {"index_number":10},{"index_number":11},{"index_number":12},
                        {"index_number":13},{"index_number":14},{"index_number":15},
                        {"index_number":16}]}"#,
        );
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 200, &calendar_body());
        fake.route_prefix(
            "GET",
            "GET /api/tmdb/tv/",
            200,
            br#"{"seasons":[{"season_number":5,"episode_count":10}]}"#,
        );
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let result = job(&mut runtime, "align");
        assert_eq!(result["patched"], 0, "{result}");
        assert!(fake.patches().is_empty(), "减方向永不写");
        let doc = stored(&fake);
        assert_eq!(doc.trim_suggestions.len(), 1);
        assert_eq!(doc.trim_suggestions[0].target_upper, 10);
        drop(guard);
    }

    #[test]
    fn daily_report_is_sent_once_per_local_day() {
        let (fake, mut runtime) = harness();
        let guard = fake.install();
        // 替身必须先装好, 运行时才读得到宿主存储(顺序反了会走到 Unavailable 分支)。
        runtime.ensure_loaded();
        // 固定时间 + 打开日报; 测试钩子只在本线程生效
        let fixed = 1_790_000_000u64; // 2026-09-23T16:53:20Z 附近, 本地 +08 = 次日 00:53
        clock::testhooks::set_now(Some(fixed * 1_000_000_000));
        let _ = action(
            &mut runtime,
            "settings-update",
            json!({"report": {"enabled": true, "hour": 0, "tz_offset_minutes": 480}}),
        );
        let first = job(&mut runtime, "align");
        assert_eq!(first["report"]["status"], "accepted", "{first}");
        let posts = fake
            .requests()
            .into_iter()
            .filter(|request| request.method == "POST")
            .count();
        assert_eq!(posts, 1, "第一轮必须发一次日报");

        // 同一自然日再跑一轮: 不再发
        let second = job(&mut runtime, "align");
        assert_eq!(second["report"]["status"], "idle");
        let posts = fake
            .requests()
            .into_iter()
            .filter(|request| request.method == "POST")
            .count();
        assert_eq!(posts, 1, "同一自然日只发一次");

        let doc = stored(&fake);
        assert_eq!(doc.daily.sent_total, 1);
        assert!(!doc.daily.last_sent_date.is_empty());
        clock::testhooks::set_now(None);
        drop(guard);
    }

    #[test]
    fn suppressed_reports_are_retried() {
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, &intents_body());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, &instances_body());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/episodes?", 200, &episodes_body());
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 200, &calendar_body());
        fake.route_prefix("GET", "GET /api/tmdb/tv/", 200, &tmdb_body());
        fake.route(
            "POST",
            "/api/notifications/plugin",
            200,
            br#"{"data":{"event":"plugin_notification","accepted":false,"suppressed":true,"suppression_reason":"quiet_hours"}}"#,
        );
        fake.route_prefix("PATCH", "PATCH /api/subscribe/pool/intents/", 200, b"{}");
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        clock::testhooks::set_now(Some(1_790_000_000_000_000_000));
        let _ = action(
            &mut runtime,
            "settings-update",
            json!({"report": {"enabled": true, "hour": 0}}),
        );
        let _ = job(&mut runtime, "align");
        let doc = stored(&fake);
        assert_eq!(doc.daily.last_result, "suppressed");
        assert!(doc.daily.last_sent_date.is_empty(), "suppressed 不记日期, 下一小时重试");
        assert_eq!(doc.daily.last_error, "quiet_hours");
        clock::testhooks::set_now(None);
        drop(guard);
    }

    #[test]
    fn calendar_failure_does_not_block_alignment() {
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, &intents_body());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, &instances_body());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/episodes?", 200, &episodes_body());
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 503, b"nope");
        fake.route_prefix("GET", "GET /api/tmdb/tv/", 200, &tmdb_body());
        fake.route_prefix("PATCH", "PATCH /api/subscribe/pool/intents/", 200, b"{}");
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let result = job(&mut runtime, "align");
        // 两条 tv 都按 Emby 缺口补订(42 的 TMDB 季缺失 → target=0, 仍会按缺口补)
        assert_eq!(result["patched"], 2, "日历失败不影响对齐: {result}");
        let doc = stored(&fake);
        assert_eq!(doc.debug.air_calendar.status, "http_error");
        assert_eq!(doc.debug.air_calendar.sample, "nope");
        drop(guard);
    }

    // ── align-now ──

    #[test]
    fn align_now_reuses_the_six_hour_cache_without_probing_emby() {
        let fake = FakeHost::new();
        let at = clock::now_rfc3339();
        // 缓存: 上一轮已把 41 补到 16 集, Emby 那边只看得到 12 集。
        // 订阅池现在也报 16 集 → 缓存判定"无缺口", 本轮既不该探 Emby 也不该写。
        fake.set(
            "state",
            format!(
                r#"{{"schema_version":1,"revision":7,
                    "emby_instances":[{{"id":3,"name":"客厅","is_default":true,"key_ready":true}}],
                    "align":{{"items":[{{"intent_id":41,"tmdb_id":1396,"season":5,"title":"绝命毒师",
                        "total_known":16,"emby_have_max":12,"emby_have_count":3,"gap_max":0,
                        "from_total":10,"to_total":16,"action":"patched","reason":"","at":"{at}"}}]}}}}"#
            )
            .as_bytes(),
        );
        fake.route_prefix(
            "GET",
            "GET /api/subscribe/pool/intents?",
            200,
            r#"{"code":"ok","data":[{"id":41,"tmdb_id":1396,"season":5,"media_type":"tv",
                 "title":"绝命毒师","total_episodes_known":16,"state":"caught_up"}],"counts":{}}"#.as_bytes(),
        );
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let calls_before = crate::host::observed_calls();

        let result = action(&mut runtime, "align-now", json!({}));
        assert_eq!(result["status"], "accepted");
        assert_eq!(result["budget_hit"], false, "{result}");
        assert_eq!(result["patched"], 0, "缓存已判定无缺口, 不该再写: {result}");
        assert!(fake.patches().is_empty(), "缓存命中时零 PATCH");
        assert!(fake.puts().is_empty(), "align-now 不落盘(预算约束)");
        let calls = crate::host::observed_calls() - calls_before;
        assert_eq!(calls, 1, "缓存命中 → 只该读 1 页订阅池, 0 次 Emby 探测, 实际 {calls}");
        drop(guard);
    }

    #[test]
    fn align_now_ignores_a_stale_cache_and_probes_anyway() {
        // 缓存里记的是 7 小时前的探测(超出 6 小时新鲜窗口) → 必须重新实测
        let fake = FakeHost::new();
        let stale_at = clock::rfc3339_from_unix(clock::now_unix_secs() - 7 * 3600);
        fake.set(
            "state",
            format!(
                r#"{{"schema_version":1,"revision":7,
                    "emby_instances":[{{"id":3,"name":"客厅","is_default":true,"key_ready":true}}],
                    "align":{{"items":[{{"intent_id":41,"tmdb_id":1396,"season":5,"title":"绝命毒师",
                        "total_known":10,"emby_have_max":12,"emby_have_count":3,"gap_max":2,
                        "from_total":10,"to_total":16,"action":"patched","reason":"","at":"{stale_at}"}}]}}}}"#
            )
            .as_bytes(),
        );
        fake.route_prefix(
            "GET",
            "GET /api/subscribe/pool/intents?",
            200,
            r#"{"code":"ok","data":[{"id":41,"tmdb_id":1396,"season":5,"media_type":"tv",
                 "title":"绝命毒师","total_episodes_known":10,"state":"partial"}],"counts":{}}"#.as_bytes(),
        );
        fake.route_prefix("GET", "GET /api/plugin-host/emby/episodes?", 200, &episodes_body());
        fake.route_prefix("PATCH", "PATCH /api/subscribe/pool/intents/", 200, b"{}");
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();

        let result = action(&mut runtime, "align-now", json!({}));
        assert_eq!(result["patched"], 1, "过期缓存必须重新实测: {result}");
        assert_eq!(fake.patches().len(), 1);
        let body = crate::host::decode_response_body(&crate::host::HostCallResponse {
            status: 200,
            headers: Default::default(),
            body_base64: fake.patches()[0].body_base64.clone(),
        })
        .unwrap();
        assert_eq!(String::from_utf8_lossy(&body), r#"{"total_episodes":12}"#);
        assert!(fake.puts().is_empty(), "align-now 不落盘");
        drop(guard);
    }

    #[test]
    fn align_now_probes_no_more_than_three_times_and_patches_at_most_five() {
        let fake = FakeHost::new();
        // 8 条都要补订, 没有缓存可复用
        let mut items = Vec::new();
        for index in 0..8 {
            items.push(format!(
                r#"{{"id":{index},"tmdb_id":{index},"season":1,"media_type":"tv",
                   "title":"剧{index}","total_episodes_known":1,"state":"partial"}}"#
            ));
        }
        let body = format!(r#"{{"code":"ok","data":[{}],"counts":{{}}}}"#, items.join(","));
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, body.as_bytes());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, &instances_body());
        fake.route_prefix(
            "GET",
            "GET /api/plugin-host/emby/episodes?",
            200,
            br#"{"items":[{"index_number":1},{"index_number":2}]}"#,
        );
        fake.route_prefix("PATCH", "PATCH /api/subscribe/pool/intents/", 200, b"{}");
        let guard = fake.install();
        // 先让替身里有一份带实例列表的状态文档, 再让一个全新的运行时加载它
        fake.set(
            "state",
            r#"{"schema_version":1,"revision":1,"emby_instances":[{"id":3,"name":"客厅","is_default":true,"key_ready":true}]}"#.as_bytes(),
        );
        let mut fresh = Runtime::new();
        fresh.ensure_loaded();
        let result = action(&mut fresh, "align-now", json!({}));
        assert_eq!(result["patched"], 3, "只有 3 条能拿到实测覆盖: {result}");
        assert_eq!(fake.patches().len(), 3);
        let calls = crate::host::observed_calls();
        assert!(calls <= 1 + 5 + 3, "host.call 总数超预算: {calls}");
        drop(guard);
    }

    #[test]
    fn align_now_budget_hit_shape() {
        let (fake, mut runtime) = harness();
        let guard = fake.install();
        // 替身必须先装好, 运行时才读得到宿主存储(顺序反了会走到 Unavailable 分支)。
        runtime.ensure_loaded();
        // 把预算压到 0 秒: 第一次判定就该超时
        let result = action(&mut runtime, "align-now", json!({}));
        // 预算正常时不是 budget_hit; 形状断言覆盖两支
        assert!(result.get("patched").is_some());
        assert!(result.get("planned").is_some());
        assert!(result.get("skipped").is_some());
        assert!(result.get("budget_hit").is_some());
        drop(guard);
    }

    // ── probe-dump ──

    #[test]
    fn probe_dump_records_both_endpoints_and_persists() {
        let (fake, mut runtime) = harness();
        let guard = fake.install();
        // 替身必须先装好, 运行时才读得到宿主存储(顺序反了会走到 Unavailable 分支)。
        runtime.ensure_loaded();
        let _ = job(&mut runtime, "align");
        let result = action(&mut runtime, "probe-dump", json!({}));
        assert_eq!(result["status"], "accepted");
        assert_eq!(result["emby"]["http_status"], 200, "{result}");
        assert!(result["emby"]["shape"].as_str().unwrap_or_default().contains("params="));
        assert_eq!(result["calendar"]["http_status"], 200);
        assert!(result["state_version"].as_str().unwrap_or_default().starts_with("state-v"));

        let doc = stored(&fake);
        assert_eq!(doc.debug.emby_episodes.status, "ok");
        assert!(!doc.debug.emby_episodes.sample.is_empty(), "probe-dump 必须留原文样本");
        assert!(doc.debug.emby_episodes.sample.len() <= SAMPLE_MAX);
        assert_eq!(doc.debug.air_calendar.status, "ok");
        assert!(!doc.settings.probe.emby_episodes_shape.is_empty());
        drop(guard);
    }

    #[test]
    fn probe_dump_reports_unparsed_without_panicking() {
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, &instances_body());
        fake.route_prefix(
            "GET",
            "GET /api/plugin-host/emby/episodes?",
            200,
            br#"{"episode_count":12}"#,
        );
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 200, b"<html>502</html>");
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, &intents_body());
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let result = action(&mut runtime, "probe-dump", json!({}));
        assert_eq!(result["status"], "accepted");
        assert_eq!(result["emby"]["shape"], "");
        let doc = stored(&fake);
        assert_eq!(doc.debug.emby_episodes.status, "unparsed");
        assert_eq!(doc.debug.air_calendar.status, "unparsed");
        drop(guard);
    }

    // ── 幂等与重入 ──

    #[test]
    fn patch_idempotency_keys_are_unique_per_business_write() {
        let (fake, mut runtime) = harness();
        let guard = fake.install();
        // 替身必须先装好, 运行时才读得到宿主存储(顺序反了会走到 Unavailable 分支)。
        runtime.ensure_loaded();
        let _ = job(&mut runtime, "align");
        // 夹具里两条 tv 都有缺口(见 intents_body): 41 → 16, 42 → 12
        assert_eq!(fake.patches().len(), 2);
        let first = fake.patches()[0].headers["idempotency-key"].clone();
        assert!(first.starts_with("chase-patch-41-10-16-"), "{first}");
        // 重置状态文档(模拟下一轮同一条目再次需要补订), 但 run_seq 递增
        fake.set(
            "state",
            br#"{"schema_version":1,"revision":9,"align":{"items":[]}}"#,
        );
        let mut next = Runtime::new();
        next.ensure_loaded();
        let _ = job(&mut next, "align");
        let keys: Vec<String> = fake
            .patches()
            .iter()
            .map(|request| request.headers["idempotency-key"].clone())
            .collect();
        // 两轮 × 两条 tv, 顺序: [41, 42] × 2
        assert_eq!(keys.len(), 4, "{keys:?}");
        assert!(keys[0].starts_with("chase-patch-41-10-16-"), "{keys:?}");
        assert!(keys[1].starts_with("chase-patch-42-5-12-"), "{keys:?}");
        assert!(keys[2].starts_with("chase-patch-41-10-16-"), "{keys:?}");
        assert!(keys[3].starts_with("chase-patch-42-5-12-"), "{keys:?}");
        // 同一条目跨轮必须换幂等键(同一轮内两条本来就不同条目、不同键)
        assert_ne!(keys[0], keys[2], "不同轮次必须换幂等键: {keys:?}");
        assert_ne!(keys[1], keys[3], "不同轮次必须换幂等键: {keys:?}");
        assert!(keys.iter().all(|key| (16..=128).contains(&key.len())));
        drop(guard);
    }

    #[test]
    fn job_results_are_never_rpc_errors_on_business_failures() {
        let fake = FakeHost::new();
        fake.fail_all(true);
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        // 所有端点都失败: job 也只返回正常 result
        let value = call(
            &mut runtime,
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"job","payload":{"id":"align"}}}}"#,
        );
        assert!(value.get("error").is_none(), "{value}");
        assert!(value["result"]["status"].is_string());
        drop(guard);
    }

    // ─────────────────────── state 视图组装 ───────────────────────

    #[test]
    fn state_op_reports_the_persisted_version_and_etag() {
        let (fake, mut runtime) = harness();
        let guard = fake.install();
        runtime.ensure_loaded();

        let first = call(
            &mut runtime,
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"state","payload":{}}}}"#,
        );
        assert_eq!(first["result"]["state_version"], "state-v0");
        assert_eq!(first["result"]["etag"], "\"state-v0\"");
        assert!(first["result"]["state"]["settings"].is_object());

        let _ = job(&mut runtime, "align"); // 落盘一次 → revision 1
        let after = call(
            &mut runtime,
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"state","payload":{}}}}"#,
        );
        assert_eq!(after["result"]["state_version"], "state-v1");
        assert_eq!(after["result"]["etag"], "\"state-v1\"");
        assert_eq!(after["result"]["state"]["revision"], 1);
        assert!(after["result"]["state"]["align"]["items"].is_array());
        assert_eq!(after["result"]["state"]["schema_version"], 1);

        // 版本一致 + if_none_match 命中 → 304 形态, 不重发文档
        let not_modified = call(
            &mut runtime,
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"state","payload":{"if_none_match":"\"state-v1\""}}}}"#,
        );
        assert_eq!(not_modified["result"]["not_modified"], true, "{not_modified}");
        assert!(not_modified["result"].get("state").is_none());

        // 版本对不上 → 完整文档
        let mismatch = call(
            &mut runtime,
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"state","payload":{"if_none_match":"\"state-v0\""}}}}"#,
        );
        assert!(mismatch["result"]["state"].is_object(), "{mismatch}");
        drop(guard);
    }

    #[test]
    fn state_op_tolerates_null_payload_and_rejects_opaque_ones() {
        let (fake, mut runtime) = harness();
        let guard = fake.install();
        runtime.ensure_loaded();
        // payload: null → 零值结构体, 合法
        let ok = call(
            &mut runtime,
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"state","payload":null}}}"#,
        );
        assert!(ok["result"]["state"].is_object(), "{ok}");
        // 字符串 payload → -32602
        let bad = call(
            &mut runtime,
            r#"{"method":"runtime.invoke","params":{"envelope":{"op":"state","payload":"x"}}}"#,
        );
        assert_eq!(bad["error"]["code"], -32602, "实际 {bad}");
        drop(guard);
    }

    // ─────────────────── probe 快照的 2KB 上限 ───────────────────

    /// 超大原文(远大于 2KB)在业务路径上也必须被截断 —— 不能把宿主整段响应塞进 state。
    #[test]
    fn probe_dump_truncates_oversized_samples_to_2kb() {
        let huge_emby = format!(r#"{{"unknown":[{}{}]}}"#, "1,".repeat(4000), "2");
        let huge_calendar = format!(r#"{{"unknown":"{}"}}"#, "剧".repeat(3000));
        assert!(huge_emby.len() > SAMPLE_MAX * 2);
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, &instances_body());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/episodes?", 200, huge_emby.as_bytes());
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 200, huge_calendar.as_bytes());
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, &intents_body());
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();

        let result = action(&mut runtime, "probe-dump", json!({}));
        assert_eq!(result["status"], "accepted", "{result}");
        let doc = stored(&fake);
        assert_eq!(doc.debug.emby_episodes.status, "unparsed");
        assert!(doc.debug.emby_episodes.sample.len() <= SAMPLE_MAX);
        assert!(!doc.debug.emby_episodes.sample.is_empty(), "必须在 ≤2KB 内留证");
        assert_eq!(doc.debug.air_calendar.status, "unparsed");
        assert!(doc.debug.air_calendar.sample.len() <= SAMPLE_MAX);
        assert!(
            std::str::from_utf8(doc.debug.air_calendar.sample.as_bytes()).is_ok(),
            "截断必须落在 UTF-8 边界"
        );
        // 响应里回给前端的 preview 更短(200B), 不把 2KB 原文塞进 RPC 响应
        assert!(result["emby"]["sample_preview"].as_str().unwrap_or_default().len() <= 200);
        assert!(result["calendar"]["sample_preview"].as_str().unwrap_or_default().len() <= 200);
        // 整份文档仍然远小于 256KB
        assert!(doc_bytes(&fake).len() <= crate::model::MAX_STATE_BYTES);
        drop(guard);
    }

    // ────────────── 解析失败 ⇒ 零写入 + debug 原文 (闭环) ──────────────

    /// 订阅池列表解析失败: 整轮零写入, 且规格要求的 ≤2KB 原文必须落在 state.debug。
    #[test]
    fn job_pool_failure_records_the_raw_sample_in_debug() {
        let fake = FakeHost::new();
        let body = format!(r#"{{"code":"ok","data":[{{"nope":"{}"}}]}}"#, "x".repeat(4096));
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, body.as_bytes());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, &instances_body());
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let result = job(&mut runtime, "align");
        assert_eq!(result["status"], "failed");
        assert!(fake.patches().is_empty(), "整轮跳过: 零 PATCH");

        let doc = stored(&fake);
        assert_eq!(doc.debug.pool_intents.status, "unparsed");
        assert!(doc.debug.pool_intents.sample.starts_with("{\"code\""), "留的是原文片段");
        assert!(doc.debug.pool_intents.sample.len() <= SAMPLE_MAX);
        assert!(doc.align.last_error.contains("订阅池"), "{:?}", doc.align.last_error);
        drop(guard);
    }

    #[test]
    fn refresh_records_the_pool_sample_in_memory() {
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, b"<html>503</html>");
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 200, &calendar_body());
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let result = action(&mut runtime, "refresh", json!({}));
        assert_eq!(result["status"], "accepted");
        assert!(
            result["message"].as_str().unwrap_or_default().contains("订阅池读取失败"),
            "{result}"
        );
        let debug = &runtime.state_doc().debug;
        assert_eq!(debug.pool_intents.status, "unparsed");
        assert!(debug.pool_intents.sample.contains("html"), "{:?}", debug.pool_intents.sample);
        assert!(debug.pool_intents.sample.len() <= SAMPLE_MAX);
        drop(guard);
    }

    /// 规格 ⑤ 降级 4: 实例层不可用 ⇒ 整段跳过, 且日报必须报出「本轮未对齐: <原因>」。
    #[test]
    fn report_carries_the_unavailable_emby_reason() {
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, &intents_body());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 502, b"bad gateway");
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 200, &calendar_body());
        fake.route("POST", "/api/notifications/plugin", 200, br#"{"data":{"accepted":true}}"#);
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        clock::testhooks::set_now(Some(1_790_000_000_000_000_000));
        let _ = action(
            &mut runtime,
            "settings-update",
            json!({"report": {"enabled": true, "hour": 0, "tz_offset_minutes": 480}}),
        );

        let result = job(&mut runtime, "align");
        assert_eq!(result["patched"], 0, "{result}");
        assert!(fake.patches().is_empty(), "实例层不可用 → 零 PATCH");

        let posts: Vec<crate::host::HostCallRequest> = fake
            .requests()
            .into_iter()
            .filter(|request| request.method == "POST")
            .collect();
        assert_eq!(posts.len(), 1, "未对齐也要发日报(带原因)");
        let body = crate::host::decode_response_body(&crate::host::HostCallResponse {
            status: 200,
            headers: Default::default(),
            body_base64: posts[0].body_base64.clone(),
        })
        .unwrap();
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("本轮未对齐"), "{text}");
        assert!(text.contains("502"), "{text}");
        clock::testhooks::set_now(None);
        drop(guard);
    }

    #[test]
    fn alignment_blocked_reason_is_kept_in_align_last_error() {
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, &intents_body());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, br#"{"items":[]}"#);
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 200, &calendar_body());
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let result = job(&mut runtime, "align");
        assert_eq!(result["patched"], 0);
        let doc = stored(&fake);
        assert!(doc.align.last_error.contains("本轮未对齐"), "{:?}", doc.align.last_error);
        assert_eq!(doc.debug.emby_episodes.status, "skipped");
        drop(guard);
    }

    // ─────────────────────── align-now 前台限量 ───────────────────────

    /// 全新安装(state 里还没有实例列表)时, 用户钉住的实例 id 可以直接用:
    /// 探测预算仍是 3, host.call 总数仍 ≤ 1 + max_patch + 3。
    #[test]
    fn align_now_uses_a_pinned_instance_when_no_list_is_known_yet() {
        let fake = FakeHost::new();
        fake.set("state", br#"{"schema_version":1,"revision":4,"settings":{"emby_proxy_id":3}}"#);
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, &intents_body());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/episodes?", 200, &episodes_body());
        fake.route_prefix("PATCH", "PATCH /api/subscribe/pool/intents/", 200, b"{}");
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();

        let before = crate::host::observed_calls();
        let result = action(&mut runtime, "align-now", json!({}));
        assert_eq!(result["status"], "accepted", "{result}");
        assert_eq!(result["patched"], 2, "两条 tv 订阅都按实测覆盖补订: {result}");
        assert_eq!(fake.patches().len(), 2);
        let calls = crate::host::observed_calls() - before;
        assert!(calls <= 1 + 5 + 3, "host.call 总数超预算: {calls}");
        let body = crate::host::decode_response_body(&crate::host::HostCallResponse {
            status: 200,
            headers: Default::default(),
            body_base64: fake.patches()[0].body_base64.clone(),
        })
        .unwrap();
        assert_eq!(String::from_utf8_lossy(&body), r#"{"total_episodes":12}"#);
        assert!(fake.puts().is_empty(), "align-now 不落盘(预算约束)");
        drop(guard);
    }

    /// 拿不到实例列表、配置又是"跟随宿主默认"(-1)时不猜: 零探测、零写入、可读原因。
    #[test]
    fn align_now_without_a_list_and_a_default_pin_degrades_without_writes() {
        let fake = FakeHost::new();
        fake.set("state", br#"{"schema_version":1,"revision":4}"#);
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, &intents_body());
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let result = action(&mut runtime, "align-now", json!({}));
        assert_eq!(result["status"], "accepted");
        assert_eq!(result["patched"], 0);
        assert_eq!(result["planned"], 0);
        assert_eq!(result["skipped"], 2, "两条 tv 都因没有实例而跳过");
        assert!(fake.patches().is_empty());
        assert!(fake.puts().is_empty());
        assert!(runtime
            .state_doc()
            .debug
            .last_errors
            .iter()
            .any(|error| error.step == "emby.select"));
        drop(guard);
    }

    #[test]
    fn align_now_changes_idempotency_keys_between_invocations() {
        let (fake, mut runtime) = harness();
        // 钉住实例 id, 两次 align-now 都能真的补订(否则会因没有实例列表而整段跳过)
        fake.set("state", br#"{"schema_version":1,"revision":1,"settings":{"emby_proxy_id":3}}"#);
        let guard = fake.install();
        runtime.ensure_loaded();
        let _ = action(&mut runtime, "align-now", json!({}));
        let _ = action(&mut runtime, "align-now", json!({}));
        let keys: Vec<String> = fake
            .patches()
            .iter()
            .map(|request| request.headers.get("idempotency-key").cloned().unwrap_or_default())
            .collect();
        assert_eq!(keys.len(), 4, "两轮 × 两条 tv: {keys:?}");
        assert_ne!(keys[0], keys[1], "同一轮内的两条条目各有各的键");
        assert_ne!(keys[0], keys[2], "同一条目在下一轮必须换幂等键(否则宿主会判重)");
        assert_ne!(keys[1], keys[3]);
        assert!(keys.iter().all(|key| key.starts_with("chase-patch-")));
        drop(guard);
    }

    // ──────────────── job: 分页 / 双预算 / 同剧缓存 ────────────────

    #[test]
    fn job_walks_pool_pages_until_a_short_page() {
        let mut items = Vec::new();
        for index in 0..intents::LIMIT_MAX {
            items.push(format!(
                r#"{{"id":{},"tmdb_id":{},"season":1,"media_type":"tv","title":"剧{index}",
                   "total_episodes_known":1,"state":"expired"}}"#,
                index + 1,
                index + 1000
            ));
        }
        let first = format!(r#"{{"code":"ok","data":[{}],"counts":{{}}}}"#, items.join(","));
        let second = r#"{"code":"ok","data":[{"id":9999,"tmdb_id":42,"season":1,"media_type":"tv","title":"末页","total_episodes_known":1,"state":"expired"}],"counts":{}}"#
            .as_bytes()
            .to_vec();
        let fake = FakeHost::new();
        fake.route_prefix(
            "GET",
            "GET /api/subscribe/pool/intents?media_type=tv&limit=500&offset=0",
            200,
            first.as_bytes(),
        );
        fake.route_prefix(
            "GET",
            "GET /api/subscribe/pool/intents?media_type=tv&limit=500&offset=500",
            200,
            &second,
        );
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, &instances_body());
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 200, &calendar_body());
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let result = job(&mut runtime, "align");
        assert_eq!(result["pages"], 2, "满页必须继续翻页: {result}");
        assert_eq!(result["intents_seen"], 501);
        assert_eq!(result["patched"], 0, "全部 expired, 只计数不写");
        assert!(fake.patches().is_empty());
        let paths = fake.business_paths();
        assert!(paths.iter().any(|path| path.contains("offset=0")), "{paths:?}");
        assert!(paths.iter().any(|path| path.contains("offset=500")), "{paths:?}");
        let doc = stored(&fake);
        assert_eq!(doc.align.pages, 2);
        assert_eq!(doc.stats.tv_intents, 501);
        assert_eq!(doc.align.items.len(), ALIGN_ITEMS_MAX, "逐条结果按上限裁剪");
        drop(guard);
    }

    #[test]
    fn job_caps_emby_probes_by_budget() {
        let mut items = Vec::new();
        for index in 0..3 {
            items.push(format!(
                r#"{{"id":{},"tmdb_id":{},"season":1,"media_type":"tv","title":"剧{index}",
                   "total_episodes_known":1,"state":"partial"}}"#,
                index + 1,
                index + 1396
            ));
        }
        let body = format!(r#"{{"code":"ok","data":[{}],"counts":{{}}}}"#, items.join(","));
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, body.as_bytes());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, &instances_body());
        fake.route_prefix(
            "GET",
            "GET /api/plugin-host/emby/episodes?",
            200,
            br#"{"items":[{"index_number":1},{"index_number":2}]}"#,
        );
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 200, &calendar_body());
        fake.route_prefix("GET", "GET /api/tmdb/tv/", 200, br#"{"seasons":[]}"#);
        fake.route_prefix("PATCH", "PATCH /api/subscribe/pool/intents/", 200, b"{}");
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let _ = action(&mut runtime, "settings-update", json!({"emby_probe_budget": 1}));

        let result = job(&mut runtime, "align");
        assert_eq!(result["patched"], 1, "{result}");
        assert_eq!(fake.patches().len(), 1);
        let emby_calls = fake
            .business_paths()
            .iter()
            .filter(|path| path.contains("/api/plugin-host/emby/episodes"))
            .count();
        assert_eq!(emby_calls, 1, "预算 1 → 只许 1 次 host.call");

        let doc = stored(&fake);
        assert!(
            doc.align.items.iter().any(|item| item.reason.contains("预算用尽")),
            "{:?}",
            doc.align.items.iter().map(|item| &item.reason).collect::<Vec<_>>()
        );
        drop(guard);
    }

    #[test]
    fn job_probes_each_show_and_season_once() {
        let body = r#"{"code":"ok","data":[
            {"id":41,"tmdb_id":1396,"season":5,"media_type":"tv","title":"绝命毒师","total_episodes_known":1,"state":"partial"},
            {"id":42,"tmdb_id":1396,"season":5,"media_type":"tv","title":"绝命毒师","total_episodes_known":2,"state":"partial"}
        ],"counts":{}}"#;
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, body.as_bytes());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, &instances_body());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/episodes?", 200, &episodes_body());
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 200, &calendar_body());
        fake.route_prefix("GET", "GET /api/tmdb/tv/", 200, &tmdb_body());
        fake.route_prefix("PATCH", "PATCH /api/subscribe/pool/intents/", 200, b"{}");
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let result = job(&mut runtime, "align");
        assert_eq!(result["patched"], 2, "两条都按同一份覆盖判定: {result}");
        assert_eq!(fake.patches().len(), 2);
        let paths = fake.business_paths();
        assert_eq!(
            paths.iter().filter(|path| path.contains("/api/plugin-host/emby/episodes")).count(),
            1,
            "同一 (实例, 剧, 季) 本轮只探一次: {paths:?}"
        );
        assert_eq!(
            paths.iter().filter(|path| path.contains("/api/tmdb/tv/")).count(),
            1,
            "TMDB 目标每 (剧, 季) 也只取一次: {paths:?}"
        );
        drop(guard);
    }

    #[test]
    fn job_does_not_re_probe_a_show_that_already_failed() {
        let body = r#"{"code":"ok","data":[
            {"id":41,"tmdb_id":1396,"season":5,"media_type":"tv","title":"绝命毒师","total_episodes_known":1,"state":"partial"},
            {"id":42,"tmdb_id":1396,"season":5,"media_type":"tv","title":"绝命毒师","total_episodes_known":2,"state":"partial"}
        ],"counts":{}}"#;
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, body.as_bytes());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, &instances_body());
        // 只有数字, 没有逐集信息 → 三个候选参数全部 unparsed
        fake.route_prefix(
            "GET",
            "GET /api/plugin-host/emby/episodes?",
            200,
            br#"{"episode_count":12}"#,
        );
        fake.route_prefix("GET", "GET /api/subscribe/air-calendar", 200, &calendar_body());
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        let result = job(&mut runtime, "align");
        assert_eq!(result["failed"], 1, "第一条探测失败: {result}");
        assert_eq!(result["skipped"], 1, "第二条不再重复消耗探测预算");
        assert!(fake.patches().is_empty(), "解析失败绝不允许写");
        let emby_calls = fake
            .business_paths()
            .iter()
            .filter(|path| path.contains("/api/plugin-host/emby/episodes"))
            .count();
        assert_eq!(emby_calls, 3, "矩阵三个候选各一次, 不因第二条再涨");
        let doc = stored(&fake);
        assert!(
            doc.align.items.iter().any(|item| item.reason.contains("不重复消耗预算")),
            "{:?}",
            doc.align.items.iter().map(|item| &item.reason).collect::<Vec<_>>()
        );
        assert!(doc.debug.emby_episodes.sample.contains("episode_count"));
        drop(guard);
    }

    // ──────────────── job: 状态机 / 日报去重 / 只读动作 ────────────────

    #[test]
    fn job_is_skipped_when_the_plugin_is_disabled() {
        let (fake, mut runtime) = harness();
        let guard = fake.install();
        runtime.ensure_loaded();
        let _ = action(&mut runtime, "settings-update", json!({"enabled": false}));
        let result = job(&mut runtime, "align");
        assert_eq!(result["status"], "skipped");
        assert!(fake.patches().is_empty());
        // 停用状态本身要落盘(用户配置不能丢)
        assert!(!stored(&fake).settings.enabled);
        drop(guard);
    }

    #[test]
    fn refresh_never_persists_and_keeps_the_revision() {
        let (fake, mut runtime) = harness();
        let guard = fake.install();
        runtime.ensure_loaded();
        let _ = job(&mut runtime, "align");
        let revision = runtime.revision();
        let puts = fake.puts().len();
        let patches = fake.patches().len();
        let _ = action(&mut runtime, "refresh", json!({}));
        let _ = action(&mut runtime, "refresh", json!({}));
        assert_eq!(runtime.revision(), revision, "只读动作不动 revision");
        assert_eq!(fake.puts().len(), puts, "refresh 零写入");
        assert_eq!(fake.patches().len(), patches, "refresh 不发 PATCH");
        drop(guard);
    }

    #[test]
    fn notification_http_failure_is_retried_next_round() {
        let (fake, mut runtime) = harness();
        fake.route("POST", "/api/notifications/plugin", 500, b"boom");
        let guard = fake.install();
        runtime.ensure_loaded();
        clock::testhooks::set_now(Some(1_790_000_000_000_000_000));
        let _ = action(
            &mut runtime,
            "settings-update",
            json!({"report": {"enabled": true, "hour": 0, "tz_offset_minutes": 480}}),
        );

        let first = job(&mut runtime, "align");
        assert_eq!(first["report"]["status"], "failed", "{first}");
        let doc = stored(&fake);
        assert_eq!(doc.daily.last_result, "failed");
        assert!(doc.daily.last_sent_date.is_empty(), "发送失败不得记日期");
        assert!(!doc.daily.last_error.is_empty());

        // 同一个自然日再跑一轮: 因为没记上日期, 必须重试
        let second = job(&mut runtime, "align");
        assert_ne!(second["report"]["status"], "idle", "失败后必须允许重试: {second}");
        let posts = fake.requests().iter().filter(|request| request.method == "POST").count();
        assert_eq!(posts, 2);
        clock::testhooks::set_now(None);
        drop(guard);
    }

    #[test]
    fn notification_deduplicated_counts_as_sent_for_the_day() {
        let (fake, mut runtime) = harness();
        fake.route(
            "POST",
            "/api/notifications/plugin",
            200,
            br#"{"data":{"event":"plugin_notification","accepted":false,"deduplicated":true}}"#,
        );
        let guard = fake.install();
        runtime.ensure_loaded();
        clock::testhooks::set_now(Some(1_790_000_000_000_000_000));
        let _ = action(
            &mut runtime,
            "settings-update",
            json!({"report": {"enabled": true, "hour": 0, "tz_offset_minutes": 480}}),
        );

        let first = job(&mut runtime, "align");
        assert_eq!(first["report"]["status"], "deduplicated", "{first}");
        let doc = stored(&fake);
        assert!(!doc.daily.last_sent_date.is_empty(), "宿主已有当日记录 → 同样记日期");
        assert_eq!(doc.daily.sent_total, 1);

        let second = job(&mut runtime, "align");
        assert_eq!(second["report"]["status"], "idle", "宿主去重也算当天已发: {second}");
        let posts = fake.requests().iter().filter(|request| request.method == "POST").count();
        assert_eq!(posts, 1);
        clock::testhooks::set_now(None);
        drop(guard);
    }

    // ──────────────── settings-update / 加载三态的补充 ────────────────

    #[test]
    fn settings_update_accepts_loose_numbers_and_probe_fingerprints() {
        let (fake, mut runtime) = harness();
        let guard = fake.install();
        runtime.ensure_loaded();
        let result = action(
            &mut runtime,
            "settings-update",
            json!({
                "max_raise_per_run": "7",
                "report": {"tz_offset_minutes": "-300", "enabled": true},
                "probe": {"emby_episodes_shape": "params=proxy_id,tmdb_id,season;list=items"},
                "junk": {"report": {"hour": 1}}
            }),
        );
        assert_eq!(result["status"], "succeeded", "{result}");
        let settings = runtime.state_doc().settings.clone();
        assert_eq!(settings.max_raise_per_run, 7, "数字串也收(宿主版本差异)");
        assert_eq!(settings.report.tz_offset_minutes, -300);
        assert!(settings.report.enabled);
        assert_eq!(settings.report.hour, 9, "没传的键保持原值, 不被清零");
        assert_eq!(settings.probe.emby_episodes_shape, "params=proxy_id,tmdb_id,season;list=items");
        assert!(settings.probe.air_calendar_shape.is_empty());
        // 落盘后的文档同样带着这些值
        let persisted = stored(&fake);
        assert_eq!(persisted.settings.report.tz_offset_minutes, -300);
        drop(guard);
    }

    /// 认不出的状态文档(未来版本)禁止落盘 —— 默认值绝不能覆盖用户数据。
    #[test]
    fn unrecognizable_state_documents_block_persistence() {
        let fake = FakeHost::new();
        fake.set("state", br#"{"schema_version":9,"revision":3,"settings":{"enabled":true}}"#);
        fake.route_prefix("GET", "GET /api/subscribe/pool/intents?", 200, &intents_body());
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, &instances_body());
        let guard = fake.install();
        let mut runtime = Runtime::new();
        runtime.ensure_loaded();
        assert!(!runtime.storage_ok(), "认不出就按不可用处理");
        let result = job(&mut runtime, "align");
        assert_eq!(result["status"], "skipped", "{result}");
        assert!(fake.puts().is_empty(), "一次 PUT 都不许发");
        drop(guard);
    }

    // ──────────────── 自由函数的小口径断言 ────────────────

    #[test]
    fn helper_functions_map_endpoints_and_states() {
        assert_eq!(endpoint_of("job.emby.episodes"), "emby");
        assert_eq!(endpoint_of("job.air-calendar"), "subscribe.air-calendar");
        assert_eq!(endpoint_of("refresh.intents"), "subscribe.pool.intents");
        assert_eq!(endpoint_of("job.patch"), "subscribe.pool.intents");
        assert_eq!(endpoint_of("job.notify"), "notifications.plugin");
        assert_eq!(endpoint_of("other"), "other");
        assert_eq!(display_state(""), "未知");
        assert_eq!(display_state("partial"), "partial");
    }

    #[test]
    fn push_align_item_drops_the_oldest_skipped_row() {
        let mut items: Vec<AlignItem> = Vec::new();
        for index in 0..ALIGN_ITEMS_MAX {
            let action = if index == 0 { "skipped" } else { "patched" };
            items.push(AlignItem {
                intent_id: index as i64,
                action: action.to_string(),
                ..Default::default()
            });
        }
        push_align_item(
            &mut items,
            AlignItem { intent_id: 999, action: "patched".into(), ..Default::default() },
        );
        assert_eq!(items.len(), ALIGN_ITEMS_MAX);
        assert_eq!(items[0].intent_id, 1, "被丢的是最旧的 skipped, 而不是补订结果");
        assert_eq!(items.last().unwrap().intent_id, 999);
    }

    #[test]
    fn freshness_window_rejects_unparsable_and_future_timestamps() {
        let now = clock::now_unix_secs();
        assert!(is_fresh(&clock::rfc3339_from_unix(now - 60), CACHE_FRESH_SECS));
        assert!(is_fresh(&clock::rfc3339_from_unix(now), CACHE_FRESH_SECS));
        assert!(!is_fresh(&clock::rfc3339_from_unix(now - 7 * 3600), CACHE_FRESH_SECS));
        assert!(!is_fresh("garbage", CACHE_FRESH_SECS), "认不出就不新鲜");
        assert!(!is_fresh("", CACHE_FRESH_SECS));
        assert!(!is_fresh(&clock::rfc3339_from_unix(now + 3600), CACHE_FRESH_SECS), "未来不算新鲜");
    }
}
