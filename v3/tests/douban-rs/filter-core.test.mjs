// 过滤器与墓碑核心测试 —— 向量来自 plugins/douban-rs/src/filter.rs 内嵌测试。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseRate, parseYear, reasonRating, reasonYear, reasonRegion, regionsMatch,
  canSubscribe, parseTmdbRef, historyEntryQualifies, intentIsCompleted, queueItemRating,
  candidateFromWishItem, candidateFromQueueItem,
  FILTERED_QUEUE_STATE, NO_RESUB_QUEUE_STATE, COMPLETED_INTENT_STATES, NO_RESUB_CONFIRM_TEXT,
} from '../../douban-rs/lib/filter-core.js'

test('parse_rate：空串/脏值 → null，数字原样', () => {
  assert.equal(parseRate('8.0'), 8)
  assert.equal(parseRate(' 8.6 '), 8.6)
  assert.equal(parseRate(''), null)
  assert.equal(parseRate('暂无评分'), null)
  assert.equal(parseRate('inf'), null)
  assert.equal(parseRate('NaN'), null)
})

test('parse_year 只认开头的十进制数字、按数值比较', () => {
  assert.equal(parseYear('2026'), 2026)
  assert.equal(parseYear('2026-08-14'), 2026)
  assert.equal(parseYear('9'), 9)
  assert.equal(parseYear(''), null)
  assert.equal(parseYear('x2026'), null)
  assert.ok(parseYear('9') < parseYear('10'), '数值比较，不是字符串序')
})

test('过滤原因文案已冻结', () => {
  assert.equal(reasonRating(8.6, 8.7), '评分不足（8.6 < 8.7）')
  assert.equal(reasonRating(5.8, 8.7), '评分不足（5.8 < 8.7）')
  assert.equal(reasonRating(null, 8.7), '无评分条目按低于阈值处理（疑似无数据, min_rating=8.7）')
  assert.equal(reasonYear(2024, 2025), '年份不足（2024 < 2025）')
  assert.equal(reasonYear(null, 2020), '无年份条目按低于阈值处理（min_year=2020）')
  assert.equal(reasonRegion(['美国', '加拿大'], ['日本']), '地区不符（美国/加拿大 ∉ 日本）')
  assert.equal(reasonRegion([], ['日本']), '地区不符（无地区数据 ∉ 日本）')
})

test('regions_match 任一精确相等即命中', () => {
  assert.ok(regionsMatch(['美国', '加拿大'], ['日本', '美国']))
  assert.ok(!regionsMatch(['美国'], ['日本']))
  assert.ok(!regionsMatch([], ['日本']))
  assert.ok(!regionsMatch(['美国'], []))
})

test('can_subscribe 三段判定与降级语义', () => {
  // ① 评分：min_rating > 0 时无评分按"低于阈值"
  const settings = { min_rating: 8.7, min_year: 0, regions: [] }
  let decision = canSubscribe(candidateFromWishItem({ douban_ref: '1', title: '奥德赛', type: 'movie', year: '2026', rating: 8.6 }), settings)
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, '评分不足（8.6 < 8.7）')

  decision = canSubscribe({ douban_ref: '1', title: 'x', kind: 'movie', year: '2026', rating: null, countries: null }, settings)
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, '无评分条目按低于阈值处理（疑似无数据, min_rating=8.7）')

  decision = canSubscribe({ douban_ref: '1', title: '南京照相馆', kind: 'movie', year: '2025', rating: 8.7, countries: null }, settings)
  assert.equal(decision.allowed, true)

  // ② 年份：数值比较；解析不出按"低于阈值"
  const yearSettings = { min_rating: 0, min_year: 2020, regions: [] }
  decision = canSubscribe({ douban_ref: '1', title: 'x', kind: 'movie', year: '2019', rating: null, countries: null }, yearSettings)
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, '年份不足（2019 < 2020）')
  decision = canSubscribe({ douban_ref: '1', title: 'x', kind: 'movie', year: '', rating: null, countries: null }, yearSettings)
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, '无年份条目按低于阈值处理（min_year=2020）')

  // ③ 地区：countries = null → 放行 + region_skipped；空表 → 拦；命中 → 放行
  const regionSettings = { min_rating: 0, min_year: 0, regions: ['日本'] }
  decision = canSubscribe({ douban_ref: '1', title: 'x', kind: 'movie', year: '', rating: null, countries: null }, regionSettings)
  assert.deepEqual(decision, { allowed: true, reason: null, region_skipped: true })
  decision = canSubscribe({ douban_ref: '1', title: 'x', kind: 'movie', year: '', rating: null, countries: [] }, regionSettings)
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, '地区不符（无地区数据 ∉ 日本）')
  decision = canSubscribe({ douban_ref: '1', title: 'x', kind: 'movie', year: '', rating: null, countries: ['意大利', '日本'] }, regionSettings)
  assert.deepEqual(decision, { allowed: true, reason: null, region_skipped: false })

  // 无阈值 → 全放行
  assert.deepEqual(
    canSubscribe({ douban_ref: '1', title: 'x', kind: 'movie', year: '', rating: null, countries: null }, { min_rating: 0, min_year: 0, regions: [] }),
    { allowed: true, reason: null, region_skipped: false },
  )
})

test('queue_item_rating：0 = 未知 → null', () => {
  assert.equal(queueItemRating({ rating: 8.7 }), 8.7)
  assert.equal(queueItemRating({ rating: 0 }), null)
})

test('candidate_from_queue_item 带上 media_type/year', () => {
  const candidate = candidateFromQueueItem({ douban_ref: '36808876', title: '奥德赛', media_type: 'tv', year: '2026', rating: 0 }, null)
  assert.equal(candidate.kind, 'tv')
  assert.equal(candidate.year, '2026')
  assert.equal(candidate.rating, null)
})

test('parse_tmdb_ref 只认 tmdb:<type>:<id> 形态', () => {
  assert.deepEqual(parseTmdbRef('tmdb:movie:1077295'), { mediaType: 'movie', id: 1077295 })
  assert.deepEqual(parseTmdbRef('tmdb:tv:1500536'), { mediaType: 'tv', id: 1500536 })
  assert.equal(parseTmdbRef('tmdb:movie:'), null)
  assert.equal(parseTmdbRef('tmdb::123'), null)
  assert.equal(parseTmdbRef('movie:123'), null)
  assert.equal(parseTmdbRef(''), null)
  assert.equal(parseTmdbRef('tmdb:movie:abc'), null)
})

test('history_entry_qualifies 的四条硬条件', () => {
  const good = { action: 'subscribe', result: 'succeeded', intent_id: 171, tmdb_ref: 'tmdb:movie:1077295' }
  assert.ok(historyEntryQualifies(good))
  assert.ok(!historyEntryQualifies({ ...good, action: 'skip' }))
  assert.ok(!historyEntryQualifies({ ...good, result: 'failed' }))
  assert.ok(!historyEntryQualifies({ ...good, intent_id: 0 }))
  assert.ok(!historyEntryQualifies({ ...good, tmdb_ref: 'tmdb:movie:' }))
})

test('intent_is_completed：landed/caught_up 算完成，failed/expired 不算', () => {
  assert.deepEqual(COMPLETED_INTENT_STATES, ['landed', 'caught_up'])
  assert.ok(intentIsCompleted('landed'))
  assert.ok(intentIsCompleted('caught_up'))
  assert.ok(!intentIsCompleted('failed'))
  assert.ok(!intentIsCompleted('expired'))
  assert.ok(!intentIsCompleted('pending'))
})

test('终态与确认文案常量与旧实现一致', () => {
  assert.equal(FILTERED_QUEUE_STATE, 'filtered')
  assert.equal(NO_RESUB_QUEUE_STATE, 'no_resub')
  assert.equal(NO_RESUB_CONFIRM_TEXT, '该条目此前订阅过、现在已被你删除：自动订阅不会重订它，确认要手动订阅吗？')
})
