// 对齐决策：只增不减 + 生成 PATCH 计划 —— 对照 align.rs。
//
// 整条业务链上唯一的"判定"层：输入是订阅池的 total_episodes_known、Emby 覆盖
// （lib/emby.js Coverage）与该季 TMDB 的 episode_count，输出是一个 Decision。
// 它不做任何 IO，因此可以逐条穷举测试。
//
// 规则：new_total = max(total_known, target_upper, max(H))
// - new_total <= total_known ⇒ 跳过（只增：相等或更小一律不发请求）；
// - 抬升超过 max_raise_per_run ⇒ 跳过并记异常（元数据脏了不能盲目写）；
// - new_total 夹到 TARGET_UPPER_LIMIT 以内；
// - target_upper 只取该季的 TMDB 集数；取不到 ⇒ 记 0 但 target_known=false
//   （不参与抬升，也不冒充"该季 0 集"），绝不用整剧的 number_of_episodes 顶替；
// - 跳过的文案按证据分四类（互斥）：无缺口 / 覆盖未知 / Emby 该季 0 集 /
//   覆盖已核实但目标未知 —— 后三类都不是无缺口；
// - 减方向（缩小 total）永远只出现在建议里，不产生写请求。

import { TARGET_UPPER_LIMIT } from './state.js'
import { Coverage } from './emby.js'
import { looseI64 } from './loose.js'

/** 动作：真的补订。 */
export const ACTION_PATCHED = 'patched'
/** 动作：dry-run 下判定要补但没写。 */
export const ACTION_DRY_RUN = 'dry-run'
/** 动作：跳过。 */
export const ACTION_SKIPPED = 'skipped'
/** 动作：失败（Emby 解析失败 / PATCH 非 200）。 */
export const ACTION_FAILED = 'failed'

/** 减方向建议里"已有集覆盖查验"的集数上限：超过就不逐集核对（避免病态循环）。 */
export const TRIM_CHECK_LIMIT = 5000

/** 判定所需的全部证据。 */
export class Evidence {
  constructor({
    from_total = 0,
    have_max = null,
    have_count = null,
    gap_max = 0,
    target_upper = 0,
    target_known = false,
    target_note = '',
    have_note = '',
  }) {
    this.from_total = from_total
    this.have_max = have_max
    this.have_count = have_count
    this.gap_max = gap_max
    this.target_upper = target_upper
    this.target_known = target_known
    this.target_note = target_note
    this.have_note = have_note
  }

  /** 从 Emby 覆盖与 TMDB 目标组装证据。0 一律先视为"未知"（target_known=true 由调用方覆盖）。 */
  static fromCoverage(fromTotal, coverage, targetUpper) {
    return new Evidence({
      from_total: fromTotal,
      have_max: coverage.haveMax(),
      have_count: coverage.haveCount(),
      gap_max: coverage.gapMax(fromTotal),
      target_upper: targetUpper,
      target_known: targetUpper > 0,
      have_note: coverage.unknownNote(),
    })
  }

  /** 从缓存（align-now 复用 state.align.items 里的 6 小时内结果）组装证据。 */
  static fromCache(fromTotal, haveMax, haveCount, targetUpper) {
    const have = haveMax >= 0 ? haveMax : null
    return new Evidence({
      from_total: fromTotal,
      have_max: have,
      have_count: haveCount >= 0 ? haveCount : null,
      gap_max: have !== null && have > fromTotal ? have : 0,
      target_upper: Math.max(0, targetUpper),
      target_known: targetUpper > 0,
      have_note: have === null ? '缓存行没有可用的覆盖值' : '',
    })
  }
}

/** 判定结果（直接映射成 state.align.items 的一行）。 */
export class Decision {
  constructor({ action, from_total, to_total, have_max, have_count, gap_max, reason }) {
    this.action = action
    this.from_total = from_total
    this.to_total = to_total
    this.have_max = have_max
    this.have_count = have_count
    this.gap_max = gap_max
    this.reason = reason
  }

  writes() {
    return this.action === ACTION_PATCHED
  }

  raised() {
    return Math.max(0, this.to_total - this.from_total)
  }
}

/** 核心判定。 */
export function decide(evidence, settings, dryRun) {
  const fromTotal = Math.max(0, evidence.from_total)
  const haveMax = evidence.have_max === null ? -1 : evidence.have_max
  const haveCount = evidence.have_count === null ? -1 : evidence.have_count
  const targetUpper = Math.min(Math.max(evidence.target_upper, 0), TARGET_UPPER_LIMIT)
  const haveValue = evidence.have_max === null ? 0 : Math.max(0, evidence.have_max)
  const newTotal = Math.min(Math.max(fromTotal, targetUpper, haveValue), TARGET_UPPER_LIMIT)

  // 「该季一集都没有」：解析成功且逐集覆盖是空集（区间契约的 covered_episodes:""）。
  // 不管是否同时给了缺集列表：缺集列表只是补充证据，"探到了 0 集"这个事实不变。
  const haveAbsent = evidence.have_max === null && evidence.have_count === 0
  const targetText = evidence.target_known
    ? `${targetUpper} 集`
    : evidence.target_note === ''
      ? '未知(该季取数失败)'
      : `未知(${evidence.target_note})`

  const base = {
    action: ACTION_SKIPPED,
    from_total: fromTotal,
    to_total: fromTotal,
    have_max: haveMax,
    have_count: haveCount,
    gap_max: Math.max(0, evidence.gap_max),
  }

  if (newTotal <= fromTotal) {
    if (haveAbsent) {
      return new Decision({
        ...base,
        reason: `Emby 该季 0 集(未收录/未入库): 订阅 ${fromTotal} 集, TMDB 目标 ${targetText}`,
      })
    }
    if (evidence.have_max === null) {
      // 覆盖未知：不允许写"无缺口"（那是把"没探到"说成"已核实"）。
      const note = evidence.have_note === '' ? '本季覆盖未取到(响应没有逐集覆盖字段)' : evidence.have_note
      return new Decision({
        ...base,
        reason: `覆盖未知(${note}): 订阅 ${fromTotal} 集, TMDB 目标 ${targetText}, 不参与判定`,
      })
    }
    if (!evidence.target_known) {
      // 覆盖已核实但目标未知：不是「无缺口」。同一份证据在目标已知时可能抬升，
      // 这一行的判定本可能藏着缺口，绝不能冒充"已核实无缺口"。
      return new Decision({
        ...base,
        reason: `覆盖已核实但目标未知: 订阅 ${fromTotal} 集, Emby 已有 ${haveMax} 集, TMDB 目标 ${targetText}, 未参与判定`,
      })
    }
    return new Decision({
      ...base,
      reason: `无缺口: 订阅 ${fromTotal} 集, Emby 已有 ${haveMax} 集, TMDB 目标 ${targetUpper} 集`,
    })
  }

  const raise = newTotal - fromTotal
  if (raise > settings.max_raise_per_run) {
    return new Decision({
      // to_total 回的是"本来打算补到多少"（纯展示值）：action=skipped 不发任何请求，
      // 发送层还有第二道只增+幅度校验兜底。
      action: ACTION_SKIPPED,
      from_total: fromTotal,
      to_total: newTotal,
      have_max: haveMax,
      have_count: haveCount,
      gap_max: Math.max(0, evidence.gap_max),
      reason: `抬升 ${raise} 集超过单条上限 ${settings.max_raise_per_run} 集(视为元数据异常, 不写)`,
    })
  }

  // 抬升时也把覆盖/目标的诚实状态带上：覆盖未知并不意味着目标不可用。
  let coverageNote = ''
  if (haveAbsent) {
    coverageNote = '; Emby 该季 0 集'
  } else if (evidence.have_max === null) {
    const note = evidence.have_note === '' ? '本季覆盖未取到(响应没有逐集覆盖字段)' : evidence.have_note
    coverageNote = `; Emby 覆盖未知(${note}), 未参与`
  }

  return new Decision({
    action: dryRun ? ACTION_DRY_RUN : ACTION_PATCHED,
    from_total: fromTotal,
    to_total: newTotal,
    have_max: haveMax,
    have_count: haveCount,
    gap_max: Math.max(0, evidence.gap_max),
    reason: `抬升 ${fromTotal} → ${newTotal} 集(TMDB 目标 ${targetText}${coverageNote})`,
  })
}

/**
 * 减方向建议的判定（只读，永不触发写）。
 * 条件：trim_candidate（caught_up/landed）、[1..total_known] 全部入库、且 total_known > target_upper。
 */
export function shouldSuggestTrim(fromTotal, coverage, targetUpper, trimCandidateFlag) {
  if (!trimCandidateFlag) return false
  if (fromTotal <= 0 || fromTotal > TRIM_CHECK_LIMIT) return false
  if (targetUpper <= 0 || fromTotal <= targetUpper) return false
  return coverage.coversRange(1, fromTotal)
}

/** 建议文案。 */
export function trimReason(fromTotal, targetUpper) {
  return `订阅 ${fromTotal} 集已全部入库, 该季 TMDB 只有 ${targetUpper} 集, 建议裁剪到 ${targetUpper}`
}

/**
 * `GET /api/tmdb/tv/:id` 里该季的集数。
 *
 * 多候选键名 + 松散数值，但仍按防御式解析：
 * 1. 顶层 seasons[] 里找 season_number == season 的那一季，取其 episode_count；
 *    宿主多包一层 {code, data:{...}} 信封时下探 data 再找；
 * 2. 找不到该季 ⇒ 抛 Error：调用方把 target_upper 当 0 并标记为未知
 *    （只用 Emby 缺口判定），绝不猜一个数字。
 *
 * 特别注意：顶层 number_of_episodes 是整部剧的集数，不能当作某一季的目标 ——
 * 整剧数字会把单季订阅抬到全剧集数。因此这里不做整剧回退。
 */
export function parseTargetUpper(value, season) {
  const object = tmdbDetailObject(value)
  if (!object) throw new Error('TMDB 详情不是对象')

  if (Array.isArray(object.seasons)) {
    for (const entry of object.seasons) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const number = firstNumber(entry, ['season_number', 'season', 'number'])
      if (number !== season) continue
      const count = firstNumber(entry, ['episode_count', 'number_of_episodes', 'episodes_count'])
      if (count !== null) return Math.min(Math.max(count, 0), TARGET_UPPER_LIMIT)
    }
    throw new Error(`TMDB 详情的 seasons[] 里没有第 ${season} 季的集数(顶层 number_of_episodes 是整部剧的集数, 不能当该季目标)`)
  }
  throw new Error(`TMDB 详情缺少 seasons[](不是数组): 无法确定第 ${season} 季的集数, 整剧的 number_of_episodes 不能当该季目标`)
}

function firstNumber(obj, keys) {
  for (const key of keys) {
    if (obj[key] === undefined || obj[key] === null) continue
    const parsed = looseI64(obj[key])
    if (parsed !== null) return parsed
  }
  return null
}

/** 定位 TMDB 详情对象：优先顶层；顶层没有 seasons[] 时下探一层 data 信封。 */
function tmdbDetailObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (Array.isArray(value.seasons)) return value
  const inner = value.data
  if (inner && typeof inner === 'object' && !Array.isArray(inner) && Array.isArray(inner.seasons)) {
    return inner
  }
  return value
}

/** 测试辅助：构造一个逐集覆盖（对齐 align.rs 单测里的 coverage() 夹具）。 */
export function coverageOf(episodes, missing = []) {
  return new Coverage({
    have: new Set(episodes),
    missing: missing.length > 0 ? new Set(missing) : null,
    count_hint: null,
    shape: 'list=items;index=index_number;missing=n/a',
  })
}
