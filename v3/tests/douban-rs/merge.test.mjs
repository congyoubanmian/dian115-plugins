// 状态文档三方合并（CAS 冲突时把本会话改动叠到对方新版本上，而不是整份覆盖）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { merge3, mergeStateDocs } from '../../douban-rs/lib/merge.js'

const q = (ref, extra = {}) => ({ douban_ref: ref, title: ref, state: 'observing', ...extra })

test('只有一方改过的字段取改过的一方', () => {
  const base = { a: 1, b: 1, settings: { x: 1 } }
  const ours = { a: 2, b: 1, settings: { x: 1 } }
  const theirs = { a: 1, b: 3, settings: { x: 9 } }
  assert.deepEqual(mergeStateDocs(base, ours, theirs), { a: 2, b: 3, settings: { x: 9 } })
})

test('队列按 douban_ref 合并：双方增删改都保留', () => {
  const base = { queue: { items: [q('1'), q('2'), q('3')] } }
  // 本会话：删 1、改 2、新增 4
  const ours = { queue: { items: [q('2', { state: 'needs_review' }), q('3'), q('4')] } }
  // 对方（例如前台移除动作）：删 3、新增 5
  const theirs = { queue: { items: [q('1'), q('2'), q('5')] } }
  const merged = mergeStateDocs(base, ours, theirs)
  assert.deepEqual(merged.queue.items.map((item) => item.douban_ref), ['2', '5', '4'])
  assert.equal(merged.queue.items[0].state, 'needs_review')
})

test('history / logs 只追加；对方清空（归档）后只补本会话新增的', () => {
  const base = { history: [{ id: 1 }], logs: [{ m: 'a' }] }
  const ours = { history: [{ id: 2 }, { id: 1 }], logs: [{ m: 'a' }, { m: 'b' }] }
  const theirs = { history: null, logs: [{ m: 'a' }, { m: 'c' }] }
  const merged = mergeStateDocs(base, ours, theirs)
  assert.deepEqual(merged.history, [{ id: 2 }])
  assert.deepEqual(merged.logs, [{ m: 'a' }, { m: 'c' }, { m: 'b' }])
})

test('墓碑集被对方清空：只留本会话新写的', () => {
  const base = { no_resub: { old: { title: 'old' } } }
  const ours = { no_resub: { old: { title: 'old' }, fresh: { title: 'fresh' } } }
  const theirs = { no_resub: null }
  assert.deepEqual(mergeStateDocs(base, ours, theirs).no_resub, { fresh: { title: 'fresh' } })
})

test('双方都改的标量以本会话为准；基线缺失时退化为本会话整份', () => {
  assert.equal(merge3(1, 2, 3), 2)
  const ours = { a: 1 }
  assert.equal(mergeStateDocs(null, ours, { a: 2 }), ours)
})
