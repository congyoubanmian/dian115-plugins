// 判定层测试 —— 移植自 plugins/chase-rs/src/align.rs 的核心不变量。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTION_DRY_RUN,
  ACTION_PATCHED,
  ACTION_SKIPPED,
  Decision,
  Evidence,
  coverageOf,
  decide,
  parseTargetUpper,
  shouldSuggestTrim,
  trimReason,
  TRIM_CHECK_LIMIT,
} from '../lib/align.js'
import { TARGET_UPPER_LIMIT } from '../lib/state.js'
import { FLAT_DEFAULTS, toNested } from '../lib/settings.js'
import { Coverage, parseCoverage } from '../lib/emby.js'

const SETTINGS = toNested({ ...FLAT_DEFAULTS, max_raise_per_run: 20 })
function settingsOf(maxRaise) {
  return toNested({ ...FLAT_DEFAULTS, max_raise_per_run: maxRaise })
}

test('emby 有更多集时按缺口抬升', () => {
  const evidence = Evidence.fromCoverage(10, coverageOf([1, 2, 3, 12]), 0)
  assert.equal(evidence.have_max, 12)
  assert.equal(evidence.gap_max, 12)
  const decision = decide(evidence, SETTINGS, false)
  assert.equal(decision.action, ACTION_PATCHED)
  assert.equal(decision.from_total, 10)
  assert.equal(decision.to_total, 12)
  assert.equal(decision.have_count, 4)
  assert.equal(decision.writes(), true)
  assert.equal(decision.raised(), 2)
})

test('没有 Emby 缺口也抬升到 TMDB 目标', () => {
  const evidence = Evidence.fromCoverage(10, coverageOf([1, 2, 3]), 12)
  const decision = decide(evidence, SETTINGS, false)
  assert.equal(decision.action, ACTION_PATCHED)
  assert.equal(decision.to_total, 12)
  assert.equal(decision.gap_max, 0)
})

test('只增：相等或更小一律不写', () => {
  const decision = decide(Evidence.fromCoverage(13, coverageOf([1, 2, 3]), 13), SETTINGS, false)
  assert.equal(decision.action, ACTION_SKIPPED)
  assert.equal(decision.to_total, 13)
  assert.equal(decision.writes(), false)
  assert.ok(decision.reason.includes('无缺口'), decision.reason)
  // TMDB 目标更小也一样（减方向只出建议）
  assert.equal(decide(Evidence.fromCoverage(13, coverageOf([1, 2, 3]), 5), SETTINGS, false).writes(), false)
})

test('抬升超过单条上限按元数据异常跳过', () => {
  const evidence = Evidence.fromCoverage(2, coverageOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 0)
  const decision = decide(evidence, settingsOf(3), false)
  assert.equal(decision.action, ACTION_SKIPPED)
  assert.ok(decision.reason.includes('超过单条上限'), decision.reason)
  assert.equal(decision.writes(), false)
})

test('目标夹到硬上限', () => {
  const decision = decide(Evidence.fromCoverage(1, coverageOf([1]), 10_000), settingsOf(200), false)
  assert.equal(decision.to_total, TARGET_UPPER_LIMIT)
  assert.equal(decision.action, ACTION_SKIPPED)
})

test('dry-run 产出待补订判定但绝不写', () => {
  const decision = decide(Evidence.fromCoverage(10, coverageOf([1, 2, 12]), 0), SETTINGS, true)
  assert.equal(decision.action, ACTION_DRY_RUN)
  assert.equal(decision.to_total, 12)
  assert.equal(decision.writes(), false)
})

test('只有缺集列表也参与缺口计算，但覆盖记未知(-1)', () => {
  const coverage = coverageOf([], [12])
  coverage.have = null
  coverage.missing = new Set([12])
  coverage.count_hint = 3
  const evidence = Evidence.fromCoverage(10, coverage, 0)
  assert.equal(evidence.have_max, null)
  assert.equal(evidence.gap_max, 12)
  const decision = decide(evidence, SETTINGS, false)
  assert.equal(decision.have_max, -1, '未知必须是 -1, 不是 0')
  assert.equal(decision.action, ACTION_SKIPPED)
})

test('缓存证据喂 align-now：带目标与不带目标两种口径', () => {
  const evidence = Evidence.fromCache(10, 14, 14, 0)
  assert.equal(evidence.have_max, 14)
  assert.equal(evidence.gap_max, 14)
  assert.equal(evidence.target_upper, 0, '缓存行没有目标时才是 0')
  assert.equal(decide(evidence, SETTINGS, false).to_total, 14)

  const withTarget = Evidence.fromCache(10, 14, 3, 16)
  assert.equal(withTarget.target_upper, 16)
  assert.equal(decide(withTarget, SETTINGS, false).to_total, 16)

  const unknown = Evidence.fromCache(10, -1, -1, 0)
  assert.equal(unknown.have_max, null)
  assert.equal(decide(unknown, SETTINGS, false).action, ACTION_SKIPPED)
  assert.equal(Evidence.fromCache(10, 14, 14, -3).target_upper, 0, '负数目标夹掉')
})

test('减方向建议需要整季入库且目标更小', () => {
  const full = coverageOf([1, 2, 3, 4, 5])
  assert.equal(shouldSuggestTrim(5, full, 3, true), true)
  assert.equal(shouldSuggestTrim(5, full, 3, false), false, '状态不是 caught_up/landed')
  assert.equal(shouldSuggestTrim(5, full, 5, true), false, '目标不小于订阅')
  assert.equal(shouldSuggestTrim(0, full, 3, true), false)
  assert.equal(shouldSuggestTrim(10_000, full, 3, true), false, '超过逐集核对上限')

  assert.equal(shouldSuggestTrim(5, coverageOf([1, 2, 4, 5]), 3, true), false, '缺一集不算全部入库')
  const missingOnly = coverageOf([], [9])
  missingOnly.have = null
  assert.equal(shouldSuggestTrim(5, missingOnly, 3, true), false, '没有逐集覆盖不给建议')
})

test('trim 文案可读', () => {
  const reason = trimReason(13, 10)
  assert.ok(reason.includes('13') && reason.includes('10') && reason.includes('建议裁剪'), reason)
})

test('parseTargetUpper 只认该季，绝不回退整剧集数', () => {
  const body = {
    id: 1396, name: '绝命毒师', number_of_episodes: 62,
    seasons: [{ season_number: 4, episode_count: 13 }, { season_number: 5, episode_count: 16 }],
  }
  assert.equal(parseTargetUpper(body, 5), 16)
  assert.equal(parseTargetUpper(body, 4), 13)
  // 第 9 季缺失时不得回退到全剧 24 集
  assert.throws(() => parseTargetUpper({ id: 1, number_of_episodes: 24, seasons: [{ season_number: 1, episode_count: 12 }] }, 9))
  assert.throws(() => parseTargetUpper({ number_of_episodes: 8 }, 3))
  assert.throws(() => parseTargetUpper({ seasons: 'nope', number_of_episodes: 8 }, 5))
  // 松散数值：数字串也收；别名键也认
  assert.equal(parseTargetUpper({ seasons: [{ season_number: '2', episode_count: '7' }] }, 2), 7)
  assert.equal(parseTargetUpper({ seasons: [{ season: 2, number_of_episodes: 9 }] }, 2), 9)
  // 信封下探一层
  assert.equal(parseTargetUpper({ code: 'ok', data: { seasons: [{ season_number: 5, episode_count: 16 }] } }, 5), 16)
  // 顶层有 seasons 时以顶层为准
  assert.equal(parseTargetUpper({
    seasons: [{ season_number: 5, episode_count: 16 }],
    data: { seasons: [{ season_number: 5, episode_count: 99 }] },
  }, 5), 16)
})

test('parseTargetUpper 夹取与非法结构', () => {
  assert.equal(parseTargetUpper({ seasons: [{ season_number: 1, episode_count: 99_999 }] }, 1), TARGET_UPPER_LIMIT)
  assert.equal(parseTargetUpper({ seasons: [{ season_number: 1, episode_count: -3 }] }, 1), 0)
  assert.throws(() => parseTargetUpper({ seasons: [] }, 1))
  assert.throws(() => parseTargetUpper({ seasons: [{ season_number: 1 }] }, 1))
  assert.throws(() => parseTargetUpper([], 1))
  assert.throws(() => parseTargetUpper('<html>502</html>', 1))
})

test('缺季时按纯 Emby 缺口补订，绝不抬到全剧集数', () => {
  const target = 0
  const evidence = Evidence.fromCoverage(10, coverageOf([1, 2, 12]), target)
  const decision = decide(evidence, settingsOf(3), false)
  assert.equal(decision.action, ACTION_PATCHED)
  assert.equal(decision.to_total, 12, '按该季缺口补到 12, 不是全剧 62')
  // 反面：若把 62 当该季目标，52 > 上限 3 → 跳过
  const polluted = Evidence.fromCoverage(10, coverageOf([1, 2, 12]), 62)
  assert.equal(decide(polluted, settingsOf(3), false).action, ACTION_SKIPPED)
})

test('负数输入夹到 0 且绝不写', () => {
  const evidence = new Evidence({
    from_total: -5, have_max: -1, have_count: -1, gap_max: -3, target_upper: -7,
  })
  const decision = decide(evidence, SETTINGS, false)
  assert.equal(decision.action, ACTION_SKIPPED)
  assert.equal(decision.from_total, 0)
  assert.equal(decision.have_max, -1)
  assert.equal(decision.gap_max, 0)
  assert.equal(decision.writes(), false)
})

test('缓存里的 0 集是已知事实，不是未知', () => {
  const evidence = Evidence.fromCache(10, 0, 0, 0)
  assert.equal(evidence.have_max, 0)
  const decision = decide(evidence, SETTINGS, false)
  assert.equal(decision.have_max, 0)
  assert.equal(decision.action, ACTION_SKIPPED)
})

test('未知覆盖绝不报成无缺口', () => {
  const missingOnly = coverageOf([], [12])
  missingOnly.have = null
  const evidence = Evidence.fromCoverage(10, missingOnly, 0)
  evidence.target_note = 'HTTP 错误'
  const decision = decide(evidence, SETTINGS, false)
  assert.equal(decision.action, ACTION_SKIPPED)
  assert.equal(decision.have_max, -1)
  assert.ok(decision.reason.includes('覆盖未知'), decision.reason)
  assert.ok(!decision.reason.includes('无缺口'), `未知覆盖绝不能说成无缺口: ${decision.reason}`)
  assert.ok(decision.reason.includes('未知(HTTP 错误)'), decision.reason)
})

test('该季 0 集（未收录）独立于未知与无缺口', () => {
  const evidence = Evidence.fromCoverage(10, coverageOf([]), 0)
  assert.equal(evidence.have_max, null)
  assert.equal(evidence.have_count, 0)
  const decision = decide(evidence, SETTINGS, false)
  assert.equal(decision.action, ACTION_SKIPPED)
  assert.equal(decision.have_count, 0, '已知 0 集必须与未知 -1 区分')
  assert.ok(decision.reason.includes('Emby 该季 0 集'), decision.reason)
  assert.ok(!decision.reason.includes('无缺口'), decision.reason)
  assert.ok(!decision.reason.includes('覆盖未知'), decision.reason)
})

test('覆盖已核实但目标未知：不是无缺口', () => {
  // 同一份证据在目标已知时是 PATCH
  const known = Evidence.fromCoverage(10, coverageOf([1, 2, 12]), 12)
  known.target_known = true
  assert.equal(decide(known, SETTINGS, false).action, ACTION_PATCHED)
  // 目标未知时只能跳过，但理由不许冒充"已核实的无缺口"
  const unknown = Evidence.fromCoverage(10, coverageOf([1, 2, 3]), 0)
  const decision = decide(unknown, SETTINGS, false)
  assert.equal(decision.action, ACTION_SKIPPED)
  assert.ok(!decision.reason.includes('无缺口'), decision.reason)
  assert.ok(decision.reason.includes('覆盖已核实但目标未知'), decision.reason)
  assert.ok(decision.reason.includes('未参与判定'), decision.reason)
  // 目标真的取到时才允许说无缺口
  const knownNoGap = Evidence.fromCoverage(10, coverageOf([1, 2, 3]), 10)
  knownNoGap.target_known = true
  assert.ok(decide(knownNoGap, SETTINGS, false).reason.includes('无缺口: 订阅 10 集'))
})

test('实测宿主的区间契约回归：covered_episodes:"" + needed_episodes:"1-24"', () => {
  const raw = { complete: false, covered_episodes: '', needed_episodes: '1-24' }
  const parsed = parseCoverage(raw)
  assert.equal(parsed.haveCount(), 0, '空串 = 一集都没有(已知事实)')
  assert.equal(parsed.missingMax(), 24)

  // (a) 目标未知：归类必须是「该季 0 集」而不是「覆盖未知」
  const evidence = Evidence.fromCoverage(16, parsed, 0)
  assert.equal(evidence.have_max, null)
  assert.equal(evidence.have_count, 0)
  const decision = decide(evidence, SETTINGS, false)
  assert.equal(decision.action, ACTION_SKIPPED)
  assert.ok(decision.reason.includes('Emby 该季 0 集'), decision.reason)
  assert.ok(!decision.reason.includes('覆盖未知'), decision.reason)
  assert.equal(decision.have_max, -1)
  assert.equal(decision.have_count, 0)

  // (b) 目标已知且需要抬升：补订理由里同样不许出现"覆盖未知"
  const known = Evidence.fromCoverage(16, parsed, 24)
  assert.equal(known.target_known, true)
  const raised = decide(known, SETTINGS, false)
  assert.equal(raised.action, ACTION_PATCHED)
  assert.equal(raised.to_total, 24)
  assert.ok(raised.reason.includes('TMDB 目标 24 集'), raised.reason)
  assert.ok(raised.reason.includes('Emby 该季 0 集'), raised.reason)
  assert.ok(!raised.reason.includes('覆盖未知'), raised.reason)

  // (c) 只有缺集列表、真没解析出逐集覆盖才是「覆盖未知」
  const missingOnly = coverageOf([], [12])
  missingOnly.have = null
  const unknown = Evidence.fromCoverage(10, missingOnly, 0)
  assert.equal(unknown.have_count, null, '没拿到逐集覆盖时绝不能说 0 条')
  assert.ok(decide(unknown, SETTINGS, false).reason.includes('覆盖未知'))
})

test('Decision.writes/raised 基本口径', () => {
  const decision = new Decision({
    action: ACTION_PATCHED, from_total: 10, to_total: 16, have_max: 12, have_count: 12, gap_max: 12, reason: '',
  })
  assert.equal(decision.writes(), true)
  assert.equal(decision.raised(), 6)
})

test('逐集核对上限边界', () => {
  const edge = new Coverage({
    have: new Set(Array.from({ length: TRIM_CHECK_LIMIT }, (_, index) => index + 1)),
    missing: null, count_hint: null, shape: '',
  })
  assert.equal(shouldSuggestTrim(TRIM_CHECK_LIMIT, edge, 10, true), true, '上限本身允许逐集核对')
  edge.have.add(TRIM_CHECK_LIMIT + 1)
  assert.equal(shouldSuggestTrim(TRIM_CHECK_LIMIT + 1, edge, 10, true), false, '超过上限就放弃')
})
