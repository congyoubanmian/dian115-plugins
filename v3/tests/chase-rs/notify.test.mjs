// 日报模块测试 —— 移植自 plugins/chase-rs/src/notify.rs 的核心用例。
import test from 'node:test'
import assert from 'node:assert/strict'

import { applyOutcome, compose, dedupeKey, shouldSend, BODY_MAX, TITLE_MAX } from '../../chase-rs/lib/notify.js'
import { FLAT_DEFAULTS, toNested } from '../../chase-rs/lib/settings.js'

function calendarItem(season, episode, title, time) {
  return { tmdb_id: 1, season, episode, title, time }
}

function alignItem(id, title, from, to, action) {
  return {
    intent_id: id, tmdb_id: 1, season: 1, title, total_known: from,
    emby_have_max: to, emby_have_count: to, gap_max: to, target_upper: 0,
    target_known: false, from_total: from, to_total: to, action, reason: '', at: '',
  }
}

test('日报包含三个段落', () => {
  const today = [calendarItem(1, 3, '权力的游戏', '20:00')]
  const patched = [
    alignItem(7, '绝命毒师', 10, 13, 'patched'),
    alignItem(8, '某剧', 5, 5, 'skipped'),
  ]
  const { title, body } = compose('2026-10-01', today, patched, 4, 1, 'Emby 覆盖解析失败')

  assert.ok(title.startsWith('追剧管家 2026-10-01'), title)
  assert.ok(new TextEncoder().encode(title).length <= TITLE_MAX)
  assert.ok(body.includes('① 今日播出(1)'), body)
  assert.ok(body.includes('20:00 权力的游戏 S1E3'), body)
  assert.ok(body.includes('② 本次补订(1)'), body)
  assert.ok(body.includes('绝命毒师 S1: 10 → 13'), body)
  assert.ok(body.includes('③ 跳过 4 条, 失败 1 条'), body)
  assert.ok(body.includes('Emby 覆盖解析失败'), body)
  assert.ok(!body.includes('某剧'), 'skipped 不该出现在补订段')
  assert.ok(new TextEncoder().encode(body).length <= BODY_MAX)
})

test('空轮次与 dry-run 的措辞', () => {
  const { title, body } = compose('2026-10-01', [], [], 0, 0, '')
  assert.equal(title, '追剧管家 2026-10-01: 补订 0 条')
  assert.ok(body.includes('今日没有订阅剧集更新'), body)
  assert.ok(body.includes('本轮没有需要补订的条目'), body)
  assert.ok(!body.includes('首个原因'), body)

  const dry = [alignItem(1, '某剧', 1, 2, 'dry-run')]
  const dryResult = compose('2026-10-01', [], dry, 0, 0, '')
  assert.ok(dryResult.body.includes('dry-run'), dryResult.body)
  assert.ok(dryResult.body.includes('② 本次补订(1) [dry-run 未写入]'), dryResult.body)
  assert.equal(dryResult.title, '追剧管家 2026-10-01: 补订 0 条', 'dry-run 不算真补订')
})

test('超长 CJK 文本按 UTF-8 边界截断', () => {
  const today = Array.from({ length: 20 }, (_, index) => calendarItem(1, index + 1, '很长的剧名在此重复', '08:00'))
  const patched = Array.from({ length: 20 }, (_, index) => alignItem(index + 1, '另一部非常长的剧名', 1, 2, 'patched'))
  const { title, body } = compose('2026-10-01', today, patched, 99, 88, '原因'.repeat(200))
  assert.ok(new TextEncoder().encode(title).length <= TITLE_MAX, `标题 ${new TextEncoder().encode(title).length} 字节`)
  assert.ok(new TextEncoder().encode(body).length <= BODY_MAX, `正文 ${new TextEncoder().encode(body).length} 字节`)
  assert.ok(!title.includes('\uFFFD') && !body.includes('\uFFFD'), '截断必须落在 UTF-8 边界')
  assert.ok(body.includes('…另有'), '超出上限要有省略提示')
})

test('should_send 尊重开关/日期/小时', () => {
  const report = toNested({ ...FLAT_DEFAULTS, report_enabled: true, report_hour: 9 }).report
  assert.equal(shouldSend(report, '', '2026-10-01', 9), true)
  assert.equal(shouldSend(report, '', '2026-10-01', 23), true)
  assert.equal(shouldSend(report, '', '2026-10-01', 8), false, '没到点')
  assert.equal(shouldSend(report, '2026-10-01', '2026-10-01', 9), false, '当天已发过')
  assert.equal(shouldSend(report, '2026-09-30', '2026-10-01', 9), true, '新的一天可以再发')
  const off = toNested({ ...FLAT_DEFAULTS, report_enabled: false }).report
  assert.equal(shouldSend(off, '', '2026-10-01', 12), false)
  assert.equal(shouldSend(report, '', '', 12), false, '日期为空(时钟异常)不发')
  const midnight = toNested({ ...FLAT_DEFAULTS, report_enabled: true, report_hour: 0 }).report
  assert.equal(shouldSend(midnight, '', '2026-10-01', 0), true)
})

test('dedupe_key 按天稳定', () => {
  assert.equal(dedupeKey('2026-10-01'), 'chase-daily-2026-10-01')
  assert.notEqual(dedupeKey('2026-10-01'), dedupeKey('2026-10-02'))
})

test('落账：accepted / deduplicated 都记日期', () => {
  let daily = {}
  applyOutcome(daily, '2026-10-01', { accepted: true }, '2026-10-01T09:00:00Z')
  assert.equal(daily.last_sent_date, '2026-10-01')
  assert.equal(daily.last_result, 'accepted')
  assert.equal(daily.sent_total, 1)

  daily = { last_error: '上一轮的旧错误', sent_total: 0 }
  applyOutcome(daily, '2026-10-01', { deduplicated: true }, '2026-10-01T09:00:00Z')
  assert.equal(daily.last_sent_date, '2026-10-01', '宿主已有当日记录 → 同样记日期')
  assert.equal(daily.last_result, 'deduplicated')
  assert.equal(daily.sent_total, 1)
  assert.equal(daily.last_error, '', '这一轮成功了, 旧错误要清掉')
  assert.equal(daily.last_at, '2026-10-01T09:00:00Z')
})

test('落账：suppressed 不记日期只记原因', () => {
  const daily = {}
  applyOutcome(daily, '2026-10-02', { suppressed: true, suppression_reason: 'quiet_hours' }, 'at')
  assert.equal(daily.last_sent_date, undefined, 'suppressed 不记日期')
  assert.equal(daily.last_result, 'suppressed')
  assert.equal(daily.last_error, 'quiet_hours')
})

test('落账：全 false 算失败', () => {
  const daily = {}
  applyOutcome(daily, '2026-10-03', {}, 'at')
  assert.equal(daily.last_result, 'failed')
  assert.equal(daily.last_sent_date, undefined)
})

test('落账：通道能力原地更新，不残留旧通道', () => {
  const daily = {}
  applyOutcome(daily, '2026-10-01', {
    accepted: true,
    channels: [{ channel: 'wecom', preserved: ['link_buttons'], dropped: ['callback_buttons'] }],
  }, 'at')
  assert.equal(daily.notify_channels.length, 1)
  assert.equal(daily.notify_channels[0].channel, 'wecom')
  // 下一次上报没有 channels（老宿主回滚）→ 原地清空
  applyOutcome(daily, '2026-10-02', { accepted: true }, 'at')
  assert.equal(daily.notify_channels.length, 0)
})
