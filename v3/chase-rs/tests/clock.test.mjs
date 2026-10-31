// 时间换算测试 —— 对照 plugins/chase-rs/src/clock.rs 的用例。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  civilFromDays,
  dateFromDays,
  datePlusDays,
  daysFromCivil,
  isFresh,
  localDate,
  localHour,
  normalizeDate,
  parseDateDays,
  parseRfc3339Secs,
  rfc3339FromUnix,
} from '../lib/clock.js'

test('Unix 秒 → RFC3339（UTC）', () => {
  assert.equal(rfc3339FromUnix(0), '1970-01-01T00:00:00Z')
  assert.equal(rfc3339FromUnix(1_760_000_000), '2025-10-09T08:53:20Z')
  assert.equal(rfc3339FromUnix(1_791_504_000), '2026-10-09T00:00:00Z')
})

test('RFC3339 解析：Z / 偏移 / 非法形态', () => {
  assert.equal(parseRfc3339Secs('2026-10-09T00:00:00Z'), 1_791_504_000)
  // +08:00 的同一时刻
  assert.equal(parseRfc3339Secs('2026-10-09T08:00:00+08:00'), 1_791_504_000)
  assert.equal(parseRfc3339Secs('2026-10-08T20:00:00-04:00'), 1_791_504_000)
  assert.equal(parseRfc3339Secs('2026-10-09 00:00:00'), null, '空格分隔不是自家格式')
  assert.equal(parseRfc3339Secs('nope'), null)
  assert.equal(parseRfc3339Secs('2026-13-09T00:00:00Z'), null)
  assert.equal(parseRfc3339Secs('2026-10-09T24:00:00Z'), null)
})

test('civil_from_days / days_from_civil 互逆', () => {
  assert.deepEqual(civilFromDays(0), [1970, 1, 1])
  assert.deepEqual(civilFromDays(19_722), [2023, 12, 31])
  assert.equal(daysFromCivil(1970, 1, 1), 0)
  assert.equal(daysFromCivil(2023, 12, 31), 19_722)
  for (const [y, m, d] of [[2026, 10, 9], [2000, 2, 29], [1900, 3, 1]]) {
    const days = daysFromCivil(y, m, d)
    assert.deepEqual(civilFromDays(days), [y, m, d])
  }
})

test('本地日期/小时按固定偏移换算', () => {
  const now = 1_791_504_000 // 2026-10-09T00:00:00Z
  assert.equal(localDate(0, now), '2026-10-09')
  assert.equal(localDate(480, now), '2026-10-09')
  assert.equal(localDate(-120, now), '2026-10-08')
  assert.equal(localHour(480, now), 8)
  assert.equal(localHour(0, now), 0)
  // 同一天 23:30 UTC + 480 分钟 = 次日 07:30
  const lateNight = 1_791_504_000 + 23 * 3600 + 30 * 60
  assert.equal(localDate(480, lateNight), '2026-10-10')
  assert.equal(localHour(480, lateNight), 7)
})

test('parseDateDays / datePlusDays / normalizeDate', () => {
  assert.equal(parseDateDays('2026-10-09'), daysFromCivil(2026, 10, 9))
  // 与 clock.rs 同语义：只校验分隔符与月/日范围（1-12 / 1-31），不做月长核对
  assert.equal(parseDateDays('2026-02-30'), daysFromCivil(2026, 2, 30))
  assert.equal(parseDateDays('2026-13-01'), null)
  assert.equal(parseDateDays('2026/10/09'), null)
  assert.equal(parseDateDays('oops'), null)
  assert.equal(datePlusDays('2026-10-01', 7), '2026-10-08')
  assert.equal(datePlusDays('2026-10-31', 1), '2026-11-01')
  assert.equal(datePlusDays('oops', 1), null)
  assert.equal(normalizeDate('2026-10-01T12:00:00Z'), '2026-10-01')
  assert.equal(normalizeDate('2026/10/03'), '2026-10-03')
  assert.equal(normalizeDate('2026-10-04'), '2026-10-04')
  assert.equal(normalizeDate('没有日期'), null)
})

test('isFresh 的窗口边界（解析不出就当作不新鲜）', () => {
  const now = 1_791_504_000 // 2026-10-09T00:00:00Z
  assert.equal(isFresh('2026-10-09T00:00:00Z', 3600, now), true)
  // 窗口 3599 秒：恰好 1 小时前的时刻已经不新鲜
  assert.equal(isFresh('2026-10-08T23:00:00Z', 3599, now), false)
  assert.equal(isFresh('2026-10-08T23:00:00Z', 3600, now), true)
  assert.equal(isFresh('2026-10-08T22:59:59Z', 3600, now), false)
  assert.equal(isFresh('oops', 3600, now), false)
  assert.equal(isFresh('', 3600, now), false)
})
