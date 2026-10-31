// job 入口测试 —— queue-pump 的 run/recover 与 tg-callback 的回调语义。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import { run as runPump, recover as recoverPump } from '../jobs/queue-pump.js'
import { run as runCallback } from '../jobs/tg-callback.js'
import { enqueue, loadTask } from '../lib/queue-store.js'
import { createKv } from '../lib/kv.js'
import { STAGING_SUBDIR } from '../lib/pump.js'
import { DEFAULT_QUALITY } from '../lib/settings.js'

function makeHost() {
  const kvStore = new Map()
  const files = new Map()
  const notifyCalls = []
  const ctx = {
    id: 'music.rs',
    storage: {
      async get(key) {
        const hit = kvStore.get(key)
        if (!hit) throw Object.assign(new Error('not found'), { status: 404 })
        return JSON.parse(JSON.stringify(hit.value))
      },
      async set(key, value, expectedRevision) {
        const hit = kvStore.get(key)
        if (expectedRevision !== undefined) {
          const current = hit ? hit.revision : undefined
          if (current !== expectedRevision) throw Object.assign(new Error('conflict'), { status: 412 })
        }
        kvStore.set(key, { value: JSON.parse(JSON.stringify(value)), revision: (hit?.revision ?? 0) + 1 })
        return { revision: (hit?.revision ?? 0) + 1 }
      },
      async remove(key) { kvStore.delete(key) },
    },
    api: {
      async get(path) {
        const key = decodeURIComponent(path.replace(/^\/api\/extensions\/v3\/music\.rs\/storage\//, ''))
        const hit = kvStore.get(key)
        if (!hit) throw Object.assign(new Error('not found'), { status: 404 })
        return { value: JSON.parse(JSON.stringify(hit.value)), revision: hit.revision }
      },
    },
    settings: { async get() { return kvStore.get('settings')?.value ?? {} } },
    http: {
      async request(options) {
        if (options.save_to) {
          files.set(options.save_to, 10)
          return { status: 200, headers: {}, body: '', path: options.save_to, size: 10, sha256: 'x' }
        }
        return { status: 200, headers: {}, cached: false, body: JSON.stringify({ data: [{ url: 'https://cdn.example.com/s.flac', type: 'flac', level: 'lossless', size: 1 }] }) }
      },
    },
    files: {
      async call(options) {
        if (options.operation === 'list') {
          return [...files.keys()].map((path) => ({ name: path.split('/').pop(), path, is_dir: false, size: 1 }))
        }
        if (options.operation === 'rename') {
          const dir = options.path.split('/').slice(0, -1).join('/')
          const target = `${dir}/${options.name}`
          files.set(target, files.get(options.path))
          files.delete(options.path)
          return { path: target }
        }
        if (options.operation === 'move') {
          files.delete(options.path)
          return { backend: 'system', items: [] }
        }
        if (options.operation === 'remove') {
          for (const path of options.paths ?? []) files.delete(path)
          return {}
        }
        throw new Error(`unexpected op ${options.operation}`)
      },
    },
    notify: async (options) => { notifyCalls.push(options); return { accepted: true } },
    crypto: {
      md5: (data, output) => createHash('md5').update(data).digest(output),
      aesEncrypt: ({ key, data, padding, output }) => {
        const c = createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null)
        return Buffer.concat([c.update(Buffer.from(data)), c.final()]).toString('hex')
      },
    },
    task: { async update() {}, async log() {}, async checkpoint() {}, id: 't' },
  }
  return { ctx, kvStore, files, notifyCalls }
}

function await_import() {
  // 兼容占位（不再需要 node:crypto 延迟引用）。
  return { createCipheriv }
}

test('queue-pump run completes a queued task and stores the summary', async () => {
  const host = makeHost()
  await enqueue(createKv(host.ctx), { source: 'netease', song_id: '1', name: '歌', singers: '歌手', album: '', quality: DEFAULT_QUALITY })
  const summary = await runPump(host.ctx, {})
  assert.equal(summary.completed.length, 1)
  const state = host.kvStore.get('state').value
  assert.equal(state.last_pump.completed.length, 1)
  assert.ok(state.last_pump.at)
  // recover：completed 检查点 → complete。
  const decision = await recoverPump(host.ctx, { stage: 'done', result: summary })
  assert.equal(decision.action, 'complete')
  // 未到 done 的中断 → resume（pump 幂等）。
  const resume = await recoverPump(host.ctx, { stage: 'pump' })
  assert.equal(resume.action, 'resume')
})

test('tg-callback requeues the failed task and notifies', async () => {
  const host = makeHost()
  const kv = createKv(host.ctx)
  const { task } = await enqueue(kv, { source: 'qq', song_id: '9', name: '歌名', singers: '歌手', album: '', quality: DEFAULT_QUALITY })
  task.status = 'failed'
  task.error = 'boom'
  await kv.set(`task.${task.id}`, task)
  // 索引条目同步为 failed（persistTask 的投影由 enqueue+手动 set 模拟）。
  const outcome = await runCallback(host.ctx, { callback: { data: `retry:${task.id}` } })
  assert.equal(outcome.handled, true)
  assert.match(outcome.answer, /已重新排队/)
  const after = await loadTask(kv, task.id)
  assert.equal(after.status, 'queued')
  assert.equal(after.retry_round, 1)
  assert.equal(host.notifyCalls.length, 1)
  assert.match(host.notifyCalls[0].title, /已重新排队/)
  // 非本插件的按钮 → handled:false。
  const other = await runCallback(host.ctx, { callback: { data: 'other:1' } })
  assert.equal(other.handled, false)
  // 缺回调数据 → 抛错（宿主重投）。
  await assert.rejects(runCallback(host.ctx, {}), /缺少回调数据/)
  // 不存在的任务 → 静默确认。
  const ghost = await runCallback(host.ctx, { callback: { data: 'retry:zzzz' } })
  assert.match(ghost.answer, /任务不存在或已被清理/)
})
