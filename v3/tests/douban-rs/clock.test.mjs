// clock 纯逻辑测试 —— 向量来自 plugins/douban-rs/src/clock.rs 内嵌测试。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  rfc3339, parseRfc3339, monthOf, base36, nowUnixNanos, nowRfc3339,
  setFixedNow, takeSleeps, recordSleep, sessionNonce, resetSessionNonce,
} from '../../douban-rs/lib/clock.js'

const FIXED_NOW = 1_790_676_009_000_000_000

test('rfc3339 与 Go 格式逐字节一致', () => {
  const cases = [
    [0, '1970-01-01T00:00:00Z'],
    [1_700_000_000_000_000_000, '2023-11-14T22:13:20Z'],
    [FIXED_NOW, '2026-09-29T10:00:09Z'],
    [1_790_647_215_000_000_000, '2026-09-29T02:00:15Z'],
    [1_893_456_000_000_000_000, '2030-01-01T00:00:00Z'],
  ]
  for (const [nanos, want] of cases) assert.equal(rfc3339(nanos), want, `nanos=${nanos}`)
})

test('rfc3339 处理闰日与跨年', () => {
  assert.equal(rfc3339(1_709_164_800_000_000_000), '2024-02-29T00:00:00Z')
  assert.equal(rfc3339(1_735_689_599_000_000_000), '2024-12-31T23:59:59Z')
  assert.equal(rfc3339(1_735_689_600_000_000_000), '2025-01-01T00:00:00Z')
  // 2100 不是闰年（百年例外）
  assert.equal(rfc3339(4_107_542_400_000_000_000), '2100-03-01T00:00:00Z')
})

test('monthOf 与 Go 布局一致', () => {
  assert.equal(monthOf(FIXED_NOW), '2026-09')
  assert.equal(monthOf(0), '1970-01')
  assert.equal(monthOf(1_709_164_800_000_000_000), '2024-02')
})

test('parseRfc3339 对插件时间戳逐字节往返', () => {
  const cases = [
    [0, '1970-01-01T00:00:00Z'],
    [1_700_000_000_000_000_000, '2023-11-14T22:13:20Z'],
    [FIXED_NOW, '2026-09-29T10:00:09Z'],
    [1_790_647_215_000_000_000, '2026-09-29T02:00:15Z'],
    [1_709_164_800_000_000_000, '2024-02-29T00:00:00Z'],
    [1_735_689_600_000_000_000, '2025-01-01T00:00:00Z'],
  ]
  for (const [nanos, text] of cases) {
    const parsed = parseRfc3339(text)
    assert.equal(parsed, nanos, `text=${text}`)
    assert.equal(rfc3339(parsed), text, `往返: ${text}`)
  }
})

test('parseRfc3339 接受偏移量与小数秒', () => {
  assert.equal(parseRfc3339('2026-09-29T18:00:09+08:00'), FIXED_NOW)
  assert.equal(parseRfc3339('2026-09-29T02:00:09-08:00'), FIXED_NOW)
  assert.equal(parseRfc3339('2026-09-29T10:00:09.5Z'), FIXED_NOW + 500_000_000)
  assert.equal(parseRfc3339('2026-09-29T10:00:09.000Z'), FIXED_NOW)
})

test('parseRfc3339 拒绝非法输入（Go err != nil 口径）', () => {
  const cases = [
    '',
    'not a time',
    '2026-09-29',
    '2026-09-29T10:00:09',
    '2026-09-29 10:00:09Z',
    '2026-13-29T10:00:09Z',
    '2026-02-30T10:00:09Z',
    '2025-02-29T10:00:09Z',
    '2026-09-29T24:00:09Z',
    '2026-09-29T10:60:09Z',
    '2026-09-29T10:00:09X',
    '1969-12-31T23:59:59Z',
  ]
  for (const text of cases) assert.equal(parseRfc3339(text), null, `不该解出来: ${text}`)
})

test('base36 与 strconv.FormatInt 一致', () => {
  assert.equal(base36(0), '0')
  assert.equal(base36(35), 'z')
  assert.equal(base36(36), '10')
  assert.equal(base36(1_790_676_009_000_000_000), 'dlrpo22a54w0')
})

test('固定时钟驱动 now；sleep 只记录', () => {
  setFixedNow(FIXED_NOW)
  assert.equal(nowRfc3339(), '2026-09-29T10:00:09Z')
  assert.equal(nowUnixNanos(), FIXED_NOW)
  setFixedNow(null)
  assert.equal(rfc3339(nowUnixNanos()).length, '2026-09-29T10:00:09Z'.length)

  takeSleeps()
  recordSleep(300)
  recordSleep(200)
  assert.deepEqual(takeSleeps(), [300, 200])
  assert.deepEqual(takeSleeps(), [])
})

test('sessionNonce 会话内稳定且是小写 base36', () => {
  resetSessionNonce()
  const first = sessionNonce()
  assert.equal(first, sessionNonce())
  assert.ok(first.length > 0)
  assert.match(first, /^[0-9a-z]+$/)
  resetSessionNonce()
})
