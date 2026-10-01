//! 对齐决策: 只增不减 + 生成 PATCH 计划。
//!
//! 这里是整条业务链上唯一的"判定"层 —— 输入是订阅池里的 `total_episodes_known`、
//! Emby 覆盖(见 [`crate::emby::Coverage`])与该季 TMDB 的 `episode_count`, 输出是一个
//! [`Decision`]。它**不做任何 IO**, 因此可以逐条穷举测试。
//!
//! # 规则(逐条对应设计规格 ⑥⑦⑧)
//!
//! ```text
//! new_total = max(total_episodes_known, target_upper, max(H))
//! ```
//!
//! - `new_total <= total_episodes_known` ⇒ 跳过(**只增**: 相等或更小一律不发请求);
//! - `new_total - total_episodes_known > max_raise_per_run` ⇒ 跳过并记异常
//!   (一次抬升超过配置上限说明元数据脏了, 不能盲目写);
//! - `new_total` 再夹到 [`TARGET_UPPER_LIMIT`] 以内;
//! - `target_upper` 只取**该季**的 TMDB 集数(见 [`parse_target_upper`]): 季缺失或
//!   取不到 ⇒ 0(只用 Emby 缺口判定), **绝不用整部剧的 `number_of_episodes` 顶替**;
//! - 减方向(缩小 total)永远只出现在 [`crate::model::TrimSuggestion`] 里, 不产生写请求。

use crate::emby::Coverage;
use crate::model::{Settings, TARGET_UPPER_LIMIT};

/// 动作: 真的补订。
pub const ACTION_PATCHED: &str = "patched";
/// 动作: dry-run 下判定要补但没写。
pub const ACTION_DRY_RUN: &str = "dry-run";
/// 动作: 跳过(无缺口 / 超上限 / 状态不参与)。
pub const ACTION_SKIPPED: &str = "skipped";
/// 动作: 失败(Emby 解析失败 / PATCH 非 200)。
pub const ACTION_FAILED: &str = "failed";

/// 减方向建议里"已有集覆盖查验"的集数上限: 超过这个数就不逐集核对(避免病态循环)。
pub const TRIM_CHECK_LIMIT: i64 = 5000;

/// 判定所需的全部证据。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Evidence {
    /// 订阅里已知的总集数。
    pub from_total: i64,
    /// Emby 已有集的最大集号(未知 = `None`)。
    pub have_max: Option<i64>,
    /// Emby 已有集的条数(未知 = `None`)。
    pub have_count: Option<i64>,
    /// 缺口上沿(集号; 0 = 无缺口)。
    pub gap_max: i64,
    /// 该季 TMDB 的目标集数(取不到 = 0)。
    pub target_upper: i64,
}

impl Evidence {
    /// 从 Emby 覆盖与 TMDB 目标组装证据。
    pub fn from_coverage(from_total: i64, coverage: &Coverage, target_upper: i64) -> Evidence {
        Evidence {
            from_total,
            have_max: coverage.have_max(),
            have_count: coverage.have_count(),
            gap_max: coverage.gap_max(from_total),
            target_upper,
        }
    }

    /// 从缓存(align-now 复用 `state.align.items` 里的 6 小时内结果)组装证据。
    pub fn from_cache(from_total: i64, have_max: i64, have_count: i64) -> Evidence {
        let have_max = if have_max >= 0 { Some(have_max) } else { None };
        Evidence {
            from_total,
            have_max,
            have_count: if have_count >= 0 { Some(have_count) } else { None },
            gap_max: have_max.filter(|max| *max > from_total).unwrap_or(0),
            target_upper: 0,
        }
    }
}

/// 判定结果(直接映射成 `state.align.items` 的一行)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub action: &'static str,
    pub from_total: i64,
    pub to_total: i64,
    /// 状态文档里的 `emby_have_max`(-1 = 未知)。
    pub have_max: i64,
    /// 状态文档里的 `emby_have_count`(-1 = 未知)。
    pub have_count: i64,
    pub gap_max: i64,
    pub reason: String,
}

impl Decision {
    /// 该判定是否会产生一次 PATCH。
    pub fn writes(&self) -> bool {
        self.action == ACTION_PATCHED
    }

    /// 抬升幅度(仅补订时有意义)。
    pub fn raised(&self) -> i64 {
        (self.to_total - self.from_total).max(0)
    }
}

/// 核心判定。
pub fn decide(evidence: &Evidence, settings: &Settings, dry_run: bool) -> Decision {
    let from_total = evidence.from_total.max(0);
    let have_max = evidence.have_max.unwrap_or(-1);
    let have_count = evidence.have_count.unwrap_or(-1);
    let target_upper = evidence.target_upper.clamp(0, TARGET_UPPER_LIMIT);
    let new_total = from_total
        .max(target_upper)
        .max(evidence.have_max.unwrap_or(0).max(0))
        .min(TARGET_UPPER_LIMIT);

    let base = Decision {
        action: ACTION_SKIPPED,
        from_total,
        to_total: from_total,
        have_max,
        have_count,
        gap_max: evidence.gap_max.max(0),
        reason: String::new(),
    };

    if new_total <= from_total {
        return Decision {
            reason: format!(
                "无缺口: 订阅 {from_total} 集, Emby 已有 {have_max} 集, TMDB 目标 {target_upper} 集"
            ),
            ..base
        };
    }

    let raise = new_total - from_total;
    if raise > i64::from(settings.max_raise_per_run) {
        return Decision {
            // 这里回的是"本来打算补到多少"(已夹到硬上限) —— 纯展示值, 便于界面说明
            // 被跳过的原因; `action = skipped` 所以 [`Decision::writes`] 为 false,
            // 一次请求都不会发, 且 `send_patch` 里还有第二道只增+幅度校验兜底。
            to_total: new_total,
            reason: format!(
                "抬升 {raise} 集超过单条上限 {} 集(视为元数据异常, 不写)",
                settings.max_raise_per_run
            ),
            ..base
        };
    }

    Decision {
        action: if dry_run { ACTION_DRY_RUN } else { ACTION_PATCHED },
        from_total,
        to_total: new_total,
        have_max,
        have_count,
        gap_max: evidence.gap_max.max(0),
        reason: format!("抬升 {from_total} → {new_total} 集"),
    }
}

/// 减方向建议的判定(只读, 永不触发写)。
///
/// 条件: 状态 ∈ {caught_up, landed}、Emby 已覆盖 `[1..total_known]`、且
/// `total_known > target_upper`(订阅比 TMDB 的季集数还多 —— 多半是元数据改过)。
pub fn should_suggest_trim(
    from_total: i64,
    coverage: &Coverage,
    target_upper: i64,
    trim_candidate: bool,
) -> bool {
    if !trim_candidate {
        return false;
    }
    if from_total <= 0 || from_total > TRIM_CHECK_LIMIT {
        return false;
    }
    if target_upper <= 0 || from_total <= target_upper {
        return false;
    }
    coverage.covers_range(1, from_total)
}

/// 建议文案。
pub fn trim_reason(from_total: i64, target_upper: i64) -> String {
    format!("订阅 {from_total} 集已全部入库, 该季 TMDB 只有 {target_upper} 集, 建议裁剪到 {target_upper}")
}

// ─────────────────────────── TMDB 目标集数 ───────────────────────────

/// `GET /api/tmdb/tv/:id` 里**该季**的集数。
///
/// 多候选键名 + 松散数值(JSON 数字或数字串都收), 这是本次唯一**强类型已知**的响应
/// (宿主 TMDB 代理), 但仍按防御式解析处理:
///
/// 1. 顶层 `seasons[]` 里找 `season_number == season` 的那一季, 取其 `episode_count`
///    (兜底 `number_of_episodes`);
/// 2. 找不到该季 ⇒ `Err(原因)`: 调用方把 `target_upper` 当 0(只用 Emby 缺口判定),
///    **绝不猜一个数字**。
///
/// 特别注意: 顶层 `number_of_episodes` 是 `TmdbTVDetail` 里**整部剧**的集数
/// (openapi-v1.yaml:6755 的必填字段, 与 `number_of_seasons` / `seasons` 并列),
/// **不能**当作某一季的目标 —— [`decide`] 把 `target_upper` 当新总数下限
/// (见本模块顶部规则), 整剧数字会把单季订阅抬到全剧集数: 落在
/// `max_raise_per_run` 内就 PATCH 出一个与该季不符的总数, 超出则按"元数据异常"
/// 跳过并连带压掉本可成立的按季补订。因此这里**不做整剧回退**。
///
/// 返回值再夹到 `[0, TARGET_UPPER_LIMIT]`。
pub fn parse_target_upper(raw: &[u8], season: i64) -> Result<i64, String> {
    let value = crate::raw::decode_json(raw)?;
    let object = value
        .as_object()
        .ok_or_else(|| "TMDB 详情不是对象".to_string())?;

    if let Some(seasons) = object.get("seasons").and_then(serde_json::Value::as_array) {
        for entry in seasons {
            let Some(entry) = entry.as_object() else { continue };
            let number = crate::raw::first_i64(entry, &["season_number", "season", "number"]);
            if number != Some(season) {
                continue;
            }
            if let Some(count) = crate::raw::first_i64(
                entry,
                &["episode_count", "number_of_episodes", "episodes_count"],
            ) {
                return Ok(count.clamp(0, TARGET_UPPER_LIMIT));
            }
        }
        return Err(format!(
            "TMDB 详情的 seasons[] 里没有第 {season} 季的集数(顶层 number_of_episodes 是整部剧的集数, 不能当该季目标)"
        ));
    }

    Err(format!(
        "TMDB 详情缺少 seasons[](不是数组): 无法确定第 {season} 季的集数, 整剧的 number_of_episodes 不能当该季目标"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn coverage(episodes: &[i64], missing: &[i64]) -> Coverage {
        Coverage {
            have: Some(episodes.iter().copied().collect::<BTreeSet<i64>>()),
            missing: if missing.is_empty() {
                None
            } else {
                Some(missing.iter().copied().collect())
            },
            count_hint: None,
            shape: "list=items;index=index_number;missing=n/a".to_string(),
        }
    }

    fn settings(max_raise: u8) -> Settings {
        let mut settings = Settings::default();
        settings.max_raise_per_run = max_raise;
        settings
    }

    #[test]
    fn raises_when_emby_has_more_episodes_than_subscription() {
        let evidence = Evidence::from_coverage(10, &coverage(&[1, 2, 3, 12], &[]), 0);
        assert_eq!(evidence.have_max, Some(12));
        assert_eq!(evidence.gap_max, 12);
        let decision = decide(&evidence, &settings(20), false);
        assert_eq!(decision.action, ACTION_PATCHED);
        assert_eq!(decision.from_total, 10);
        assert_eq!(decision.to_total, 12);
        assert_eq!(decision.have_count, 4);
        assert!(decision.writes());
        assert_eq!(decision.raised(), 2);
    }

    #[test]
    fn raises_to_tmdb_target_even_without_emby_gap() {
        // Emby 只有 3 集, 但 TMDB 该季有 12 集 → 抬到 12 (后续集数由订阅池去追)
        let evidence = Evidence::from_coverage(10, &coverage(&[1, 2, 3], &[]), 12);
        let decision = decide(&evidence, &settings(20), false);
        assert_eq!(decision.action, ACTION_PATCHED);
        assert_eq!(decision.to_total, 12);
        assert_eq!(decision.gap_max, 0);
    }

    #[test]
    fn never_lowers_and_never_writes_equal_values() {
        // Emby 比订阅少 → 只增原则下什么都不做
        let evidence = Evidence::from_coverage(13, &coverage(&[1, 2, 3], &[]), 13);
        let decision = decide(&evidence, &settings(20), false);
        assert_eq!(decision.action, ACTION_SKIPPED);
        assert_eq!(decision.to_total, 13);
        assert!(!decision.writes());
        assert!(decision.reason.contains("无缺口"), "{}", decision.reason);

        // TMDB 目标更小也一样(减方向只出建议)
        let evidence = Evidence::from_coverage(13, &coverage(&[1, 2, 3], &[]), 5);
        assert!(!decide(&evidence, &settings(20), false).writes());
    }

    #[test]
    fn oversized_raise_is_skipped_as_metadata_anomaly() {
        let evidence = Evidence::from_coverage(2, &coverage(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], &[]), 0);
        let decision = decide(&evidence, &settings(3), false);
        assert_eq!(decision.action, ACTION_SKIPPED);
        assert!(decision.reason.contains("超过单条上限"), "{}", decision.reason);
        assert!(!decision.writes());
    }

    #[test]
    fn target_is_clamped_to_the_hard_limit() {
        let evidence = Evidence::from_coverage(1, &coverage(&[1], &[]), 10_000);
        let decision = decide(&evidence, &settings(200), false);
        assert_eq!(decision.to_total, TARGET_UPPER_LIMIT);
        // 2000-1 = 1999 > 200 → 仍然被单条上限挡下
        assert_eq!(decision.action, ACTION_SKIPPED);
    }

    #[test]
    fn dry_run_reports_the_patch_but_never_marks_it_patched() {
        let evidence = Evidence::from_coverage(10, &coverage(&[1, 2, 12], &[]), 0);
        let decision = decide(&evidence, &settings(20), true);
        assert_eq!(decision.action, ACTION_DRY_RUN);
        assert_eq!(decision.to_total, 12);
        assert!(!decision.writes(), "dry-run 绝不产生写请求");
    }

    #[test]
    fn missing_list_contributes_gap_without_have_list() {
        // 只有缺集列表: can't raise from H, but the gap is still visible
        let coverage = Coverage {
            have: None,
            missing: Some(BTreeSet::from([12])),
            count_hint: Some(3),
            shape: String::new(),
        };
        let evidence = Evidence::from_coverage(10, &coverage, 0);
        assert_eq!(evidence.have_max, None);
        assert_eq!(evidence.gap_max, 12);
        let decision = decide(&evidence, &settings(20), false);
        assert_eq!(decision.have_max, -1, "未知必须是 -1, 不是 0");
        assert_eq!(decision.action, ACTION_SKIPPED);
    }

    #[test]
    fn cached_evidence_feeds_align_now() {
        let evidence = Evidence::from_cache(10, 14, 14);
        assert_eq!(evidence.have_max, Some(14));
        assert_eq!(evidence.gap_max, 14);
        assert_eq!(evidence.target_upper, 0, "缓存路径没有 TMDB 目标");
        let decision = decide(&evidence, &settings(20), false);
        assert_eq!(decision.action, ACTION_PATCHED);
        assert_eq!(decision.to_total, 14);

        // 缓存里记录的是 -1(未知) → 不能据此补订
        let unknown = Evidence::from_cache(10, -1, -1);
        assert_eq!(unknown.have_max, None);
        assert_eq!(decide(&unknown, &settings(20), false).action, ACTION_SKIPPED);
    }

    #[test]
    fn trim_suggestion_needs_full_coverage_and_smaller_target() {
        let full = coverage(&[1, 2, 3, 4, 5], &[]);
        assert!(should_suggest_trim(5, &full, 3, true));
        assert!(!should_suggest_trim(5, &full, 3, false), "状态不是 caught_up/landed");
        assert!(!should_suggest_trim(5, &full, 5, true), "目标不小于订阅");
        assert!(!should_suggest_trim(0, &full, 3, true));
        assert!(!should_suggest_trim(10_000, &full, 3, true), "超过逐集核对上限");

        // 缺一集就不算"全部入库"
        let incomplete = coverage(&[1, 2, 4, 5], &[]);
        assert!(!should_suggest_trim(5, &incomplete, 3, true));
        // 只有缺集列表(没有逐集覆盖) → 不能给减方向建议
        let missing_only = Coverage {
            have: None,
            missing: Some(BTreeSet::from([9])),
            count_hint: None,
            shape: String::new(),
        };
        assert!(!should_suggest_trim(5, &missing_only, 3, true));
    }

    #[test]
    fn trim_reason_is_human_readable() {
        let reason = trim_reason(13, 10);
        assert!(reason.contains("13"), "{reason}");
        assert!(reason.contains("10"), "{reason}");
        assert!(reason.contains("建议裁剪"), "{reason}");
    }

    // ── TMDB 目标集数 ──

    #[test]
    fn target_upper_reads_the_matching_season() {
        let body = r#"{"id":1396,"name":"绝命毒师","number_of_episodes":62,
            "seasons":[{"season_number":4,"episode_count":13},
                       {"season_number":5,"episode_count":16}]}"#.as_bytes();
        assert_eq!(parse_target_upper(body, 5).unwrap(), 16);
        assert_eq!(parse_target_upper(body, 4).unwrap(), 13);
    }

    #[test]
    fn target_upper_never_falls_back_to_the_series_total() {
        // 该季不在 seasons[] 里 → 拿不到"该季"集数: 顶层 number_of_episodes 是整部剧的
        // 集数(TmdbTVDetail 必填字段), 对这个多季剧是系统性高估 → Err, 不猜。
        let body = br#"{"id":1,"number_of_episodes":24,"seasons":[{"season_number":1,"episode_count":12}]}"#;
        assert!(parse_target_upper(body, 9).is_err(), "第 9 季缺失时不得回退到全剧 24 集");
        // seasons 缺失(或不是数组)时同样不猜整剧集数
        assert!(parse_target_upper(br#"{"number_of_episodes":8}"#, 3).is_err());
        assert!(parse_target_upper(br#"{"seasons":"nope","number_of_episodes":8}"#, 5).is_err());
        // 松散数值: 数字串也收
        assert_eq!(parse_target_upper(br#"{"seasons":[{"season_number":"2","episode_count":"7"}]}"#, 2).unwrap(), 7);
        // 别名键
        assert_eq!(parse_target_upper(br#"{"seasons":[{"season":2,"number_of_episodes":9}]}"#, 2).unwrap(), 9);
    }

    #[test]
    fn missing_season_target_cannot_raise_a_single_season_to_the_series_total() {
        // 整部剧 62 集, seasons[] 里没有第 3 季 → 该季目标取不到(0), 只用 Emby 缺口判定:
        // 缺口是 12 → 补到 12; 绝不能把订阅从 10 抬到 62(旧回退行为)。
        let body = r#"{"id":1,"number_of_episodes":62,"seasons":[{"season_number":1,"episode_count":12}]}"#.as_bytes();
        let target = parse_target_upper(body, 3).unwrap_or(0);
        assert_eq!(target, 0, "缺季时调用方按 0 处理");

        let evidence = Evidence::from_coverage(10, &coverage(&[1, 2, 12], &[]), target);
        let decision = decide(&evidence, &settings(3), false);
        assert_eq!(decision.action, ACTION_PATCHED);
        assert_eq!(decision.to_total, 12, "按该季缺口补到 12, 不是全剧 62");

        // 反面: 若把 62 当该季目标, 52 > 上限 3 → 按"元数据异常"跳过, 连 10→12 的补订都没了。
        let polluted = Evidence::from_coverage(10, &coverage(&[1, 2, 12], &[]), 62);
        assert_eq!(decide(&polluted, &settings(3), false).action, ACTION_SKIPPED);
    }

    #[test]
    fn target_upper_clamps_and_rejects_unknown_shapes() {
        let huge = br#"{"seasons":[{"season_number":1,"episode_count":99999}]}"#;
        assert_eq!(parse_target_upper(huge, 1).unwrap(), TARGET_UPPER_LIMIT);
        // 负数不是合法的集数: 夹到 0(判定层再把 0 当作"没有目标")
        let negative = br#"{"seasons":[{"season_number":1,"episode_count":-3}]}"#;
        assert_eq!(parse_target_upper(negative, 1).unwrap(), 0);
        // 认不出结构 → Err, 绝不猜数字
        assert!(parse_target_upper(br#"{"seasons":[]}"#, 1).is_err());
        assert!(parse_target_upper(br#"{"seasons":[{"season_number":1}]}"#, 1).is_err());
        assert!(parse_target_upper(b"[]", 1).is_err());
        assert!(parse_target_upper(b"<html>502</html>", 1).is_err());
        assert!(parse_target_upper(b"", 1).is_err());
    }

    // ── 补: 只增语义的边界与缓存形态 ──

    #[test]
    fn decide_clamps_negative_inputs_and_never_writes_from_them() {
        let evidence = Evidence {
            from_total: -5,
            have_max: Some(-1),
            have_count: Some(-1),
            gap_max: -3,
            target_upper: -7,
        };
        let decision = decide(&evidence, &settings(20), false);
        assert_eq!(decision.action, ACTION_SKIPPED);
        assert_eq!(decision.from_total, 0, "负集数夹到 0, 不参与抬升");
        assert_eq!(decision.have_max, -1, "未知仍是 -1");
        assert_eq!(decision.gap_max, 0);
        assert!(!decision.writes());
    }

    #[test]
    fn cached_zero_coverage_is_known_zero_not_unknown() {
        let evidence = Evidence::from_cache(10, 0, 0);
        assert_eq!(evidence.have_max, Some(0), "缓存里的 0 集是已知事实");
        let decision = decide(&evidence, &settings(20), false);
        assert_eq!(decision.have_max, 0, "已知 0 与未知 -1 必须区分开");
        assert_eq!(decision.action, ACTION_SKIPPED);
        // 未知(-1)时缓存路径不产生任何结论
        let unknown = Evidence::from_cache(10, -1, -1);
        assert_eq!(unknown.have_count, None);
        assert_eq!(decide(&unknown, &settings(20), false).action, ACTION_SKIPPED);
    }

    #[test]
    fn trim_suggestions_stop_at_the_enumeration_limit() {
        let edge = Coverage {
            have: Some((1..=TRIM_CHECK_LIMIT).collect()),
            missing: None,
            count_hint: None,
            shape: String::new(),
        };
        assert!(should_suggest_trim(TRIM_CHECK_LIMIT, &edge, 10, true), "上限本身允许逐集核对");
        let over = Coverage {
            have: Some((1..=TRIM_CHECK_LIMIT + 1).collect()),
            ..edge.clone()
        };
        assert!(
            !should_suggest_trim(TRIM_CHECK_LIMIT + 1, &over, 10, true),
            "超过逐集核对上限就放弃(避免病态循环)"
        );
    }

    #[test]
    fn trim_needs_coverage_of_the_whole_subscription_range() {
        // 已有集比订阅还多, 且完全覆盖 [1..5] → 可以建议
        let superset = coverage(&[1, 2, 3, 4, 5, 6], &[]);
        assert!(should_suggest_trim(5, &superset, 3, true));
        // 中间缺一集就不算"全部入库"
        let holed = coverage(&[1, 2, 4, 5, 6], &[]);
        assert!(!should_suggest_trim(5, &holed, 3, true));
        // 目标等于订阅 → 没有可裁剪的空间
        assert!(!should_suggest_trim(5, &superset, 5, true));
    }

    #[test]
    fn target_upper_takes_the_first_matching_season_and_zero_counts() {
        let duplicate =
            br#"{"seasons":[{"season_number":5,"episode_count":0},{"season_number":5,"episode_count":16}]}"#;
        assert_eq!(parse_target_upper(duplicate, 5).unwrap(), 0, "同季取第一条");
        // 松散的季号/集数混搭
        assert_eq!(
            parse_target_upper(br#"{"seasons":[{"season":"5","episode_count":"16"}]}"#, 5).unwrap(),
            16
        );
        // seasons 不是数组时也不能拿整剧集数充数 → Err
        assert!(parse_target_upper(br#"{"seasons":"nope","number_of_episodes":8}"#, 5).is_err());
        // seasons 里混入非对象元素也不 panic
        assert_eq!(
            parse_target_upper(br#"{"seasons":[1,"x",{"season_number":5,"episode_count":9}]}"#, 5)
                .unwrap(),
            9
        );
    }
}
