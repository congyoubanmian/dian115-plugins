// 设置与队列纯逻辑测试（settings.rs / queue-pages.rs / queue-store.js / logs.js）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TARGET_DIR, DEFAULT_QUALITY, DEFAULT_MAX_ACTIVE, MAX_ACTIVE_CAP,
  normalizeSettings, applySettingsPatch, settingsView,
} from '../lib/settings.js'
import { queuePlaylistPages, queueAllSkipped, PLAYLIST_QUEUE_MAX_PAGES } from '../lib/queue-pages.js'
import { PLAYLIST_PAGE_SIZE } from '../lib/constants.js'
import { enqueue, retry, adopt, clearFinished, persistTask, loadIndex, loadTask } from '../lib/queue-store.js'
import { createKv } from '../lib/kv.js'
import { appendEntry, LOG_LIMIT, LOG_MESSAGE_LIMIT } from '../lib/logs.js'
import { taskKey, TASKS_IDX_KEY } from '../lib/tasks-core.js'

// ─────────────────────────── 假 KV（CAS 语义同宿主）───────────────────────────

function fakeKv() {
  // 方法经 api 引用自身属性（store / failRemove 可在测试中随时替换），闭包不绑死。
  const api = { store: new Map(), failRemove: null }
  const kv = {
    store: api.store,
    failRemove: null,
    async get(key) {
      const hit = api.store.get(key)
      return hit ? JSON.parse(JSON.stringify(hit.value)) : null
    },
    async getMeta(key) {
      const hit = api.store.get(key)
      return hit ? { value: JSON.parse(JSON.stringify(hit.value)), revision: hit.revision } : { value: null, revision: undefined }
    },
    async set(key, value, expectedRevision) {
      const hit = api.store.get(key)
      if (expectedRevision !== undefined) {
        const current = hit ? hit.revision : undefined
        if (current !== expectedRevision) {
          const error = new Error('conflict')
          error.status = 412
          throw error
        }
      }
      api.store.set(key, { value: JSON.parse(JSON.stringify(value)), revision: (hit?.revision ?? 0) + 1 })
      return { revision: (hit?.revision ?? 0) + 1 }
    },
    async remove(key) {
      const hit = api.store.get(key)
      if (!hit) {
        const error = new Error('not found')
        error.status = 404
        throw error
      }
      if (kv.failRemove?.has(key)) throw Object.assign(new Error('storage unavailable'), { status: 500 })
      api.store.delete(key)
    },
  }
  return kv
}

// ─────────────────────────── settings ───────────────────────────

test('settings defaults and normalization', () => {
  assert.equal(DEFAULT_TARGET_DIR, '/CloudNAS/115open/音乐/音乐下载')
  assert.equal(DEFAULT_QUALITY, 'jymaster')
  assert.equal(DEFAULT_MAX_ACTIVE, 2)
  assert.equal(MAX_ACTIVE_CAP, 16)
  assert.deepEqual(normalizeSettings(null), {
    target_dir: DEFAULT_TARGET_DIR, quality: DEFAULT_QUALITY, max_active: 2, notify_on_fail: true,
  })
  assert.equal(normalizeSettings({ target_dir: '  ' }).target_dir, DEFAULT_TARGET_DIR)
  assert.equal(normalizeSettings({ max_active: 0 }).max_active, 2, '0 回默认')
  assert.equal(normalizeSettings({ max_active: 99 }).max_active, 2, '超上限回默认')
  assert.equal(normalizeSettings({ max_active: 5 }).max_active, 5)
  assert.equal(normalizeSettings({ notify_on_fail: false }).notify_on_fail, false)
  assert.equal(normalizeSettings({ notify_on_fail: null }).notify_on_fail, true, '缺省视为开')
})

test('settings patch merges only known keys and drops legacy ones', () => {
  const next = applySettingsPatch({ target_dir: '/a', quality: 'hires', max_active: 3, notify_on_fail: false, cookiecloud_url: 'http://x', cd2_token: 't', staging_dir: '/old' }, {
    target_dir: '/b ',
    quality: '',
    max_active: 0,
  })
  assert.deepEqual(next, { target_dir: '/b', quality: 'hires', max_active: 3, notify_on_fail: false })
  const flipped = applySettingsPatch(next, { notify_on_fail: true, max_active: 16 })
  assert.equal(flipped.notify_on_fail, true)
  assert.equal(flipped.max_active, 16)
  assert.equal(settingsView(next).target_dir, '/b', 'v3 无宿主路径过滤，路径原样展示')
})

// ─────────────────────────── queue-pages ───────────────────────────

function makePlaylistFetch(total, failPage = null) {
  const calls = []
  return {
    calls,
    async fetch(page, pageSize) {
      calls.push(page)
      if (page === failPage) throw new Error(`第 ${page} 页取歌失败: 网络`)
      const start = (page - 1) * pageSize
      const songs = []
      for (let id = start; id < Math.min(start + pageSize, total); id++) {
        songs.push({ id: String(id), name: `歌${id}`, singers: '歌手', album: '专辑' })
      }
      return { songs, total, name: '大歌单' }
    },
  }
}

test('queuePlaylistPages batches 5 pages of 100 and continues via next_page', async () => {
  const { calls, fetch } = makePlaylistFetch(1000)
  const enqueued = []
  const result = await queuePlaylistPages(
    async (song) => { enqueued.push(song.id); return { deduped: false } },
    fetch,
    { startPage: 1, batchPages: 5 },
  )
  assert.equal(result.status, 'succeeded')
  assert.equal(result.data.queued, 500)
  assert.equal(result.data.deduped, 0)
  assert.equal(result.data.total_seen, 500)
  assert.equal(result.data.next_page, 6)
  assert.equal(result.data.has_more, true)
  assert.deepEqual(calls, [1, 2, 3, 4, 5])
  assert.equal(enqueued.length, 500)
  // 续批从 next_page 起，不重复处理已入队的页。
  const second = await queuePlaylistPages(async () => ({ deduped: true }), fetch, { startPage: 6, batchPages: 5 })
  assert.equal(second.data.deduped, 500)
  assert.deepEqual(calls, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
})

test('queuePlaylistPages stops at total even when song/detail under-returns', async () => {
  // total=250：第 3 页覆盖到 300 >= 250 → 取尽（即便该页只有 50 首）。
  // next_page = 处理到的最后一页 + 1（Rust queue_all_result(*counts, page + 1, ...)）。
  const { fetch } = makePlaylistFetch(250)
  let queued = 0
  const result = await queuePlaylistPages(async () => { queued++; return {} }, fetch, { startPage: 1, batchPages: 10 })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.data.has_more, false)
  assert.equal(result.data.next_page, 4)
  assert.equal(queued, 250)
})

test('queuePlaylistPages reports page failures without rollback', async () => {
  const { fetch } = makePlaylistFetch(1000, 3)
  const enqueued = []
  const result = await queuePlaylistPages(
    async (song) => { enqueued.push(song.id); return {} },
    fetch,
    { startPage: 1, batchPages: 5 },
  )
  assert.equal(result.status, 'failed')
  assert.match(result.message, /第 3 页取歌失败/)
  assert.equal(result.data.queued, 200, '已入队的不回滚')
  assert.equal(result.data.next_page, 3, '失败页号即下次起始页')
  assert.equal(result.data.has_more, true)
})

test('queuePlaylistPages clamps batch_pages and counts empty ids as skipped', async () => {
  const { fetch } = makePlaylistFetch(300)
  let queued = 0
  const result = await queuePlaylistPages(
    async () => { queued++; return {} },
    async (page) => (page === 1 ? { songs: [{ id: '' }, { id: '1' }], total: 300 } : fetch(page)),
    { startPage: 0, batchPages: 99 },
  )
  // 缺 id 的歌由状态机记账 skipped（不调用 enqueueOne），不计入 queued。
  assert.equal(result.data.skipped, 1)
  assert.equal(queued, 1)
  assert.ok(result.data.next_page <= PLAYLIST_QUEUE_MAX_PAGES + 1)
  assert.equal(PLAYLIST_PAGE_SIZE, 100)
})

test('queueAllSkipped keeps the cursor at the requested start page', () => {
  const skipped = queueAllSkipped(6)
  assert.equal(skipped.status, 'skipped')
  assert.equal(skipped.skipped, 'queue_busy')
  assert.equal(skipped.data.next_page, 6)
  assert.equal(skipped.data.has_more, true)
  assert.equal(skipped.data.queued, 0)
})

// ─────────────────────────── queue-store ───────────────────────────

test('enqueue creates deduped ids and reuses active duplicates', async () => {
  const kv = fakeKv()
  const first = await enqueue(kv, { source: 'netease', song_id: '1', name: '歌', singers: '歌手', album: '专辑', quality: 'jymaster' })
  assert.equal(first.deduped, false)
  assert.ok(first.task.id.length <= 8)
  assert.equal(first.task.status, 'queued')
  assert.equal(first.task.out_name, '歌手 - 歌.flac')
  // 同 source+song_id+quality 的 queued 任务 → 复用。
  const second = await enqueue(kv, { source: 'netease', song_id: '1', name: '歌', singers: '歌手', album: '专辑', quality: 'jymaster' })
  assert.equal(second.deduped, true)
  assert.equal(second.task.id, first.task.id)
  // 不同音质 → 新任务。
  const third = await enqueue(kv, { source: 'netease', song_id: '1', name: '歌', singers: '歌手', album: '专辑', quality: 'hires' })
  assert.equal(third.deduped, false)
  assert.notEqual(third.task.id, first.task.id)
  const index = await loadIndex(kv)
  assert.equal(index.length, 2)
  // 校验失败。
  await assert.rejects(enqueue(kv, { source: '', song_id: '1', quality: 'x' }), /缺少音乐来源/)
  await assert.rejects(enqueue(kv, { source: 'netease', song_id: '', quality: 'x' }), /缺少歌曲标识/)
  await assert.rejects(enqueue(kv, { source: 'netease', song_id: '1', quality: '' }), /缺少音质/)
})

test('persistTask updates index in place and retry requeues failed tasks', async () => {
  const kv = fakeKv()
  const { task } = await enqueue(kv, { source: 'netease', song_id: '1', name: '歌', singers: '歌手', album: '', quality: 'jymaster' })
  task.status = 'failed'
  task.error = 'boom'
  await persistTask(kv, task)
  let index = await loadIndex(kv)
  assert.equal(index[0].status, 'failed')
  assert.match(index[0].error, /boom/)
  const outcome = await retry(kv, task.id)
  assert.equal(outcome.message, '已重新排队')
  const after = await loadTask(kv, task.id)
  assert.equal(after.status, 'queued')
  assert.equal(after.attempts, 0)
  assert.equal(after.retry_round, 1)
  // 非失败态 → 无需重试。
  const again = await retry(kv, task.id)
  assert.equal(again.status, 'queued')
  await assert.rejects(retry(kv, 'nope'), /任务不存在/)
  await assert.rejects(retry(kv, ''), /缺少任务 id/)
})

test('adopt reattaches orphan shards idempotently', async () => {
  const kv = fakeKv()
  const { task } = await enqueue(kv, { source: 'qq', song_id: '2', name: '歌', singers: '歌手', album: '', quality: 'flac' })
  // 模拟孤儿：从索引里拿掉。
  await kv.set(TASKS_IDX_KEY, [])
  const outcome = await adopt(kv, task.id)
  assert.equal(outcome.adopted, true)
  assert.equal(outcome.name, '歌手 - 歌')
  const again = await adopt(kv, task.id)
  assert.equal(again.adopted, false)
  assert.match(again.message, /已在索引里/)
  await assert.rejects(adopt(kv, 'ghost'), /分片不存在/)
})

test('clearFinished removes done/failed and keeps entries whose shard delete failed', async () => {
  const kv = fakeKv()
  const a = (await enqueue(kv, { source: 'netease', song_id: '1', name: 'A', singers: 'S', album: '', quality: 'q' })).task
  const b = (await enqueue(kv, { source: 'netease', song_id: '2', name: 'B', singers: 'S', album: '', quality: 'q' })).task
  const c = (await enqueue(kv, { source: 'netease', song_id: '3', name: 'C', singers: 'S', album: '', quality: 'q' })).task
  a.status = 'done'; b.status = 'failed'; c.status = 'queued'
  await persistTask(kv, a); await persistTask(kv, b); await persistTask(kv, c)
  // 让 b 的分片删除失败（模拟宿主 500）：索引里保留该条目，避免分片成孤儿。
  kv.failRemove = new Set([taskKey(b.id)])
  await assert.rejects(clearFinished(kv), /清理失败 1 条/)
  const index = await loadIndex(kv)
  assert.equal(index.length, 2, 'a 删除成功被移除；b 保留；c 不动')
  assert.deepEqual(index.map((e) => e.id).sort(), [b.id, c.id].sort())
  // 修复后再清一次。
  kv.failRemove = null
  const removed = await clearFinished(kv)
  assert.equal(removed, 1)
  assert.equal((await loadIndex(kv)).length, 1)
})

// ─────────────────────────── logs ───────────────────────────

test('logs append with truncation and rolling cap', () => {
  let logs = []
  for (let i = 0; i < LOG_LIMIT + 10; i++) logs = appendEntry(logs, 'info', `m${i}`)
  assert.equal(logs.length, LOG_LIMIT)
  assert.equal(logs[0].message, `m${10}`, '尾部截断：最早的被挤出')
  assert.equal(logs.at(-1).message, `m${LOG_LIMIT + 9}`)
  const long = appendEntry([], 'warning', 'x'.repeat(LOG_MESSAGE_LIMIT + 50))
  assert.ok(long[0].message.length <= LOG_MESSAGE_LIMIT + '...(truncated)'.length)
  assert.ok(long[0].message.endsWith('...(truncated)'))
})
