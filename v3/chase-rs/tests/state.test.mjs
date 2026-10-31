// 状态文档模型测试 —— 移植自 plugins/chase-rs/src/model.rs 的核心用例。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  bumpRevision,
  enforceLimits,
  forgetTmdbTarget,
  log,
  MAX_STATE_BYTES,
  newStateDoc,
  normalizeStateDoc,
  pushAlignItem,
  recordAttempt,
  recordError,
  rememberTmdbTarget,
  sanitizeForPersist,
  SCHEMA_VERSION,
  serializeState,
  tmdbTargetOf,
  TMDB_TARGETS_MAX,
  ALIGN_ITEMS_MAX,
  INSTANCES_MAX,
  LOGS_MAX,
  DEBUG_ATTEMPTS_MAX,
  PROBE_BOOK_MAX,
  SAMPLE_MAX,
} from '../lib/state.js'
import { containsForbiddenKey, isForbiddenKey, sampleText, truncateUtf8 } from '../lib/loose.js'

test('缺键的快照槽位是 never，不是空串', () => {
  const fresh = newStateDoc()
  assert.equal(fresh.debug.emby_episodes.status, 'never')
  assert.equal(fresh.debug.air_calendar.status, 'never')
  assert.equal(fresh.debug.pool_intents.status, 'never')
  assert.equal(fresh.debug.pool_intents.http_status, 0)
  // 旧文档缺 debug.* 键 → 槽位是 never（可直接展示的状态词）
  const missing = normalizeStateDoc({ schema_version: SCHEMA_VERSION, revision: 2 })
  assert.equal(missing.debug.pool_intents.status, 'never')
  const blank = normalizeStateDoc({ schema_version: SCHEMA_VERSION, debug: {} })
  assert.equal(blank.debug.emby_episodes.status, 'never')
  assert.deepEqual(blank.debug.attempts, [])
})

test('认不出的文档返回 null（禁止落盘）', () => {
  assert.equal(normalizeStateDoc({ schema_version: 9 }), null)
  assert.equal(normalizeStateDoc(null), null)
  assert.equal(normalizeStateDoc('nope'), null)
  assert.equal(normalizeStateDoc({}), null, '缺 schema_version 也不认')
  assert.notEqual(normalizeStateDoc({ schema_version: SCHEMA_VERSION }), null)
})

test('旧文档缺键能读，未知键忽略', () => {
  const legacy = normalizeStateDoc({ schema_version: SCHEMA_VERSION, revision: 3, future_key: true })
  assert.equal(legacy.revision, 3)
  assert.equal(legacy.align.patched, 0)
  assert.equal(legacy.stats.tv_intents, 0)
})

test('TMDB 目标簿：更新/遗忘/封顶', () => {
  const doc = newStateDoc()
  rememberTmdbTarget(doc, 1396, 5, 16, '2026-10-04T00:00:00Z')
  rememberTmdbTarget(doc, 1399, 1, 10, '2026-10-04T00:00:00Z')
  assert.equal(tmdbTargetOf(doc, 1396, 5).episode_count, 16)
  // 同一季再次成功 → 更新而不是重复
  rememberTmdbTarget(doc, 1396, 5, 17, '2026-10-04T01:00:00Z')
  assert.equal(doc.tmdb_targets.length, 2)
  assert.equal(tmdbTargetOf(doc, 1396, 5).episode_count, 17)
  // 取数失败 → 忘掉该季（不拿旧值冒充）
  forgetTmdbTarget(doc, 1396, 5)
  assert.equal(tmdbTargetOf(doc, 1396, 5), null)
  assert.notEqual(tmdbTargetOf(doc, 1399, 1), null)
  // 上限裁剪：只留最新的 50 条
  for (let index = 0; index < 80; index += 1) {
    rememberTmdbTarget(doc, index, 1, 12, '2026-10-04T02:00:00Z')
  }
  enforceLimits(doc)
  assert.equal(doc.tmdb_targets.length, TMDB_TARGETS_MAX)
  assert.ok(doc.tmdb_targets.every((target) => target.tmdb_id !== 1399), '最旧的被裁掉')
})

test('日志与错误有界，保留最新的', () => {
  const doc = newStateDoc()
  for (let index = 0; index < 80; index += 1) {
    log(doc, 'info', `line-${index}`, '2026-10-04T00:00:00Z')
    recordError(doc, 'step', `err-${index}`, '2026-10-04T00:00:00Z')
  }
  assert.equal(doc.logs.length, LOGS_MAX)
  assert.equal(doc.logs[0].message, 'line-30')
  assert.equal(doc.debug.last_errors.length, 10)
  log(doc, 'warning', '剧'.repeat(500), 'at')
  assert.ok(new TextEncoder().encode(doc.logs.at(-1).message).length <= 400)
})

test('record_attempt 有界并截断字段', () => {
  const doc = newStateDoc()
  for (let index = 0; index < 30; index += 1) {
    recordAttempt(doc, `endpoint-${index}`, 'p'.repeat(500), 200, 's'.repeat(500), 'at')
  }
  assert.equal(doc.debug.attempts.length, DEBUG_ATTEMPTS_MAX)
  assert.equal(doc.debug.attempts[0].endpoint, 'endpoint-10', '保留最新的')
  assert.ok(doc.debug.attempts[0].params.length <= 200)
  assert.ok(doc.debug.attempts[0].shape.length <= 200)
  assert.ok(doc.debug.updated_at !== '')
})

test('enforce_limits 封顶每个列表并丢最旧的', () => {
  const doc = newStateDoc()
  for (let index = 0; index < 80; index += 1) {
    doc.align.items.push({ intent_id: index, action: 'skipped', reason: '', title: '' })
    doc.trim_suggestions.push({ intent_id: index })
    doc.emby_instances.push({ id: index, name: '', is_default: false, key_ready: false, at: '' })
  }
  doc.calendar.days.push({
    date: '2026-10-01',
    items: Array.from({ length: 30 }, (_, index) => ({ episode: index })),
  })
  enforceLimits(doc)
  assert.equal(doc.align.items.length, ALIGN_ITEMS_MAX)
  assert.equal(doc.align.items[0].intent_id, 30, '丢最旧的')
  assert.equal(doc.trim_suggestions.length, 50)
  assert.equal(doc.emby_instances.length, INSTANCES_MAX)
  assert.equal(doc.calendar.days[0].items.length, 20)
})

test('超限文档先裁诊断再落盘，业务数据不被挤掉', () => {
  const doc = newStateDoc()
  doc.debug.emby_episodes.sample = 'x'.repeat(MAX_STATE_BYTES / 2)
  doc.debug.air_calendar.sample = 'x'.repeat(MAX_STATE_BYTES / 2)
  doc.debug.pool_intents.sample = 'x'.repeat(MAX_STATE_BYTES / 2)
  doc.align.items.push({ intent_id: 1, action: 'patched', reason: '', title: '' })
  const text = serializeState(doc)
  assert.ok(text.length <= MAX_STATE_BYTES, `实际 ${text.length} 字节`)
  const parsed = JSON.parse(text)
  assert.ok(parsed.debug.emby_episodes.sample.length <= SAMPLE_MAX)
  assert.equal(parsed.align.items.length, 1, '业务数据不许被诊断挤掉')
  assert.equal(parsed.schema_version, SCHEMA_VERSION)
})

test('状态文档永不出现凭据键名', () => {
  const doc = newStateDoc()
  doc.emby_instances.push({ id: 3, name: '客厅', is_default: true, key_ready: true, at: '2026-10-01T00:00:00Z' })
  doc.debug.emby_episodes.sample = sampleText({ api_key: 'leak', items: [{ index_number: 1 }] }, SAMPLE_MAX)
  assert.equal(isForbiddenKey('api_key_configured'), true)
  assert.equal(isForbiddenKey('key_ready'), false)
  assert.equal(containsForbiddenKey(doc), null, 'sanitizeForPersist 之前文档就必须干净')
  sanitizeForPersist(doc)
  const text = JSON.stringify(doc)
  assert.ok(!text.includes('api_key'), text.slice(0, 200))
  assert.equal(doc.emby_instances[0].key_ready, true)
  assert.ok(!doc.debug.emby_episodes.sample.includes('leak'), '样本也要脱敏')
})

test('pushAlignItem 满 50 条时优先丢最旧的 skipped', () => {
  const items = []
  for (let index = 0; index < ALIGN_ITEMS_MAX; index += 1) {
    pushAlignItem(items, { intent_id: index, action: index < 10 ? 'skipped' : 'patched' })
  }
  pushAlignItem(items, { intent_id: 999, action: 'patched' })
  assert.equal(items.length, ALIGN_ITEMS_MAX)
  assert.equal(items[0].intent_id, 1, '最旧的 skipped（intent 0）先被丢掉')
  assert.ok(items.some((item) => item.intent_id === 999), '新行保留')
})

test('bumpRevision 只增不减', () => {
  const doc = newStateDoc()
  bumpRevision(doc)
  bumpRevision(doc)
  assert.equal(doc.revision, 2)
})

test('truncateUtf8 按 UTF-8 边界截断', () => {
  assert.equal(truncateUtf8('abc', 10), 'abc')
  assert.equal(truncateUtf8('abc', 2), 'ab')
  const cjk = '追剧管家'
  // 每个汉字 3 字节
  assert.equal(truncateUtf8(cjk, 6), '追剧')
  assert.equal(truncateUtf8(cjk, 7), '追剧', '半个码点回退')
  assert.equal(new TextEncoder().encode(truncateUtf8(cjk, 7)).length, 6)
})
