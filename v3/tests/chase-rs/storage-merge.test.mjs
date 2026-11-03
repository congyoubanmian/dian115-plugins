// 存储并发：读快照一致性 + CAS 冲突时的三方合并（不整份覆盖并发任务的结果）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { loadRuntimeState, Session } from '../../chase-rs/jobs/runtime.js'
import { log, mergeStateDocs, newStateDoc } from '../../chase-rs/lib/state.js'

function kvCtx(initial) {
  const kv = { value: initial.value, revision: initial.revision }
  const path = '/api/extensions/v3/chase.rs/storage/state'
  return {
    kv,
    plugin: { id: 'chase.rs' },
    api: {
      get: async (requested) => {
        assert.equal(requested, path)
        return { value: JSON.parse(JSON.stringify(kv.value)), revision: kv.revision }
      },
      put: async (requested, body) => {
        assert.equal(requested, path)
        if (body.expected_revision !== kv.revision) {
          const error = new Error('revision conflict')
          error.status = 409
          throw error
        }
        kv.value = body.value
        kv.revision += 1
        return { revision: kv.revision }
      },
    },
  }
}

test('读状态：值与版本号取自同一次信封读取', async () => {
  const stale = newStateDoc()
  stale.last_message = '旧'
  const latest = newStateDoc()
  latest.last_message = '新'
  const ctx = kvCtx({ value: latest, revision: 5 })
  ctx.storage = { get: async () => stale }
  const loaded = await loadRuntimeState(ctx)
  assert.equal(loaded.kind, 'loaded')
  assert.equal(loaded.revision, 5)
  assert.equal(loaded.doc.last_message, '新', '旧值配新版本号会让 CAS 放行过期文档')
})

test('CAS 冲突：合并对方写下的字段，而不是整份覆盖', async () => {
  const base = newStateDoc()
  log(base, 'info', '初始', '2026-10-01T00:00:00Z')
  const ctx = kvCtx({ value: base, revision: 1 })
  const session = new Session(ctx, await loadRuntimeState(ctx))

  // 本会话（例如只读刷新）改日历并记一条日志
  session.doc.calendar.fetched_at = '2026-10-01T01:00:00Z'
  log(session.doc, 'info', '刷新', '2026-10-01T01:00:00Z')

  // 与此同时整点对齐已落盘：发了日报、写了对齐结果
  const other = JSON.parse(JSON.stringify(base))
  other.daily.last_sent_date = '2026-10-01'
  other.align.patched = 3
  log(other, 'info', '对齐完成', '2026-10-01T00:30:00Z')
  ctx.kv.value = other
  ctx.kv.revision = 2

  const outcome = await session.persist()
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  const stored = ctx.kv.value
  assert.equal(stored.daily.last_sent_date, '2026-10-01', '对方的日报落账必须保留')
  assert.equal(stored.align.patched, 3)
  assert.equal(stored.calendar.fetched_at, '2026-10-01T01:00:00Z', '本会话的改动必须写入')
  assert.deepEqual(stored.logs.map((entry) => entry.message), ['初始', '对齐完成', '刷新'])
  assert.ok(stored.revision > other.revision)
})

test('三方合并：子键粒度，双方都改的键以本会话为准', () => {
  const base = newStateDoc()
  const ours = JSON.parse(JSON.stringify(base))
  const theirs = JSON.parse(JSON.stringify(base))
  ours.stats.tv_intents = 9
  ours.status = 'accepted'
  theirs.stats.matched = 4
  theirs.status = 'failed'
  const merged = mergeStateDocs(base, ours, theirs)
  assert.equal(merged.stats.tv_intents, 9)
  assert.equal(merged.stats.matched, 4)
  assert.equal(merged.status, 'accepted')
})
