// 任务队列核心向量测试 —— 向量来自 plugins/music-rs/src/tasks.rs 的单元测试。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TASKS_KEY, TASKS_IDX_KEY, TASK_KEY_PREFIX, taskKey, keyIsHostSafe,
  outName, sanitizeComponent, displayName, indexEntryOf, sortIndex, stateView,
  requeueTask, extractCallbackData, RETRY_PREFIX, MAX_ATTEMPTS, STATE_TASKS_LIMIT,
  STATUS_QUEUED, STATUS_DOWNLOADING, STATUS_COPYING, STATUS_DONE, STATUS_FAILED,
} from '../lib/tasks-core.js'

test('constants keep the legacy contract', () => {
  assert.equal(TASKS_KEY, 'tasks')
  assert.equal(TASKS_IDX_KEY, 'tasks.idx')
  assert.equal(TASK_KEY_PREFIX, 'task.')
  assert.equal(RETRY_PREFIX, 'retry:')
  assert.equal(MAX_ATTEMPTS, 3)
  assert.equal(STATE_TASKS_LIMIT, 200)
})

test('out_name follows sidecar rules (tasks.rs vectors)', () => {
  assert.equal(outName('周杰伦', '晴天', 'flac'), '周杰伦 - 晴天.flac')
  assert.equal(outName('A/B:C*?"<>|D', 'E\\F', 'FLAC'), 'A_B_C______D - E_F.flac')
  assert.equal(outName('', '晴天', ''), '未知 - 晴天.flac')
  assert.equal(outName('  周杰伦  ', '  晴天  ', '.mp3'), '周杰伦 - 晴天.mp3')
  assert.equal(outName('周杰伦', '', 'flac'), '周杰伦 - 未知.flac')
  assert.equal(sanitizeComponent('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j')
})

test('storage keys satisfy the host key regex', () => {
  assert.ok(keyIsHostSafe(TASKS_IDX_KEY), `索引键非法: ${TASKS_IDX_KEY}`)
  assert.ok(keyIsHostSafe(TASKS_KEY))
  for (const id of [shortIdOf('a'), '0', 'zzzzzzzz', 'a1b2c3d4']) {
    const key = taskKey(id)
    assert.ok(keyIsHostSafe(key), `分片键非法: ${key}`)
  }
  for (const bad of ['', '.task', '-x', 'tasks.', 'tasks..a', 'tasks:a', 'a b', 'a/b']) {
    assert.ok(!keyIsHostSafe(bad), `本该非法的键被判合法: ${JSON.stringify(bad)}`)
  }
  assert.ok(!keyIsHostSafe('a'.repeat(161)), '超 160 字符必须拒绝')
  assert.ok(keyIsHostSafe('a'.repeat(160)), '160 字符应当合法')
})
function shortIdOf(seed) {
  // 直接内联 base36 短 id（避免引入 queue-store 的依赖）。
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(seed)) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return (hash % 2821109907456n).toString(36)
}

test('index projection truncates error and sorts by updated_ms desc', () => {
  const task = {
    id: 'abc', source: 'netease', song_id: '1', status: 'failed', name: '歌', singers: '歌手',
    quality: 'lossless', error: 'x'.repeat(300), updated_ms: 10,
  }
  const entry = indexEntryOf(task)
  assert.equal(entry.error.length <= 120 + '...(truncated)'.length, true)
  assert.ok(entry.error.endsWith('...(truncated)'))
  const index = [
    { id: 'a', updated_ms: 1 }, { id: 'b', updated_ms: 3 }, { id: 'c', updated_ms: 2 },
  ]
  sortIndex(index)
  assert.deepEqual(index.map((e) => e.id), ['b', 'c', 'a'])
  // 同 updated_ms 按 id 倒序，顺序稳定。
  const tied = [{ id: 'a', updated_ms: 1 }, { id: 'b', updated_ms: 1 }]
  sortIndex(tied)
  assert.deepEqual(tied.map((e) => e.id), ['b', 'a'])
})

test('stateView caps to 200 entries', () => {
  const big = Array.from({ length: 300 }, (_, i) => ({ id: String(i), updated_ms: i }))
  assert.equal(stateView(big).length, 200)
  assert.equal(stateView(big)[0].id, '299')
})

test('requeueTask resets failed tasks only', () => {
  let now = 100
  const task = { id: 'x', status: STATUS_FAILED, attempts: 3, retry_round: 1, error: 'boom', job_ref: 'j', cd2_ref: 'c', updated_ms: 0 }
  assert.equal(requeueTask(task, () => ++now), true)
  assert.equal(task.status, STATUS_QUEUED)
  assert.equal(task.attempts, 0)
  assert.equal(task.retry_round, 2)
  assert.equal(task.error, '')
  assert.equal(task.job_ref, '')
  assert.equal(task.updated_ms, 101)
  assert.equal(requeueTask({ id: 'x', status: STATUS_DONE }, () => 0), false, '非失败态不重置')
})

test('extractCallbackData reads all host projections', () => {
  assert.equal(extractCallbackData({ callback: { data: 'retry:abc' } }), 'retry:abc')
  assert.equal(extractCallbackData({ callback_query: { data: 'retry:abc' } }), 'retry:abc')
  assert.equal(extractCallbackData({ data: 'retry:abc' }), 'retry:abc')
  assert.equal(extractCallbackData({ callback_data: 'retry:abc' }), 'retry:abc')
  assert.equal(extractCallbackData({}), null)
  assert.equal(extractCallbackData(null), null)
})

test('displayName prefers singers - name', () => {
  assert.equal(displayName({ name: '晴天', singers: '周杰伦' }), '周杰伦 - 晴天')
  assert.equal(displayName({ name: '晴天', singers: '' }), '晴天')
})

test('status constants', () => {
  assert.deepEqual(
    [STATUS_QUEUED, STATUS_DOWNLOADING, STATUS_COPYING, STATUS_DONE, STATUS_FAILED],
    ['queued', 'downloading', 'copying', 'done', 'failed'],
  )
})
