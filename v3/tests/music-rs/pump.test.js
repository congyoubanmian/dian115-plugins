// pump 管线端到端测试 —— 假宿主（ctx.storage/api/http/files/notify/crypto）覆盖：
// 入队 → 取链（注入 node:crypto 复刻 eapi）→ save_to 暂存 → 定名 → move 入库 → done；
// 失败重试（attempts 上限 + 通知按钮 callback_data）、downloading/copying 中断残留恢复。
// 对照 plugins/music-rs/src/download.rs 的集成测试（FakeHost）移植。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import { pump, STAGING_SUBDIR, DOWNLOAD_TIMEOUT_SECONDS, channelSummary, looksLikeDirectWriteUnsupported, targetName } from '../../music-rs/lib/pump.js'
import { enqueue, loadIndex, loadTask, persistTask } from '../../music-rs/lib/queue-store.js'
import { createKv } from '../../music-rs/lib/kv.js'
import { buildDeps, readSettings } from '../../music-rs/jobs/runtime.js'
import { normalizeSettings } from '../../music-rs/lib/settings.js'
import { DEFAULT_QUALITY } from '../../music-rs/lib/settings.js'

// ─────────────────────────── 假宿主 ───────────────────────────

function makeHost({ songUrlBodies = null, refuseDirectWrite = false, hostApi = '3.9', withExists = true } = {}) {
  const kvStore = new Map()
  const files = new Map() // path → size
  const calls = { http: [], files: [], notify: [] }
  const failMoveFor = new Set() // 目标已存在的文件名（move 抛错）
  let httpHandler = null
  let saveToHandler = null // (options) => 结果 | 抛错；null = 默认 2xx 写盘

  const storage = {
    async get(key) {
      const hit = kvStore.get(key)
      if (!hit) throw Object.assign(new Error('not found'), { status: 404 })
      return JSON.parse(JSON.stringify(hit.value))
    },
    async set(key, value, expectedRevision) {
      const hit = kvStore.get(key)
      if (expectedRevision !== undefined) {
        const current = hit ? hit.revision : 0
        if (current !== expectedRevision) throw Object.assign(new Error('conflict'), { status: 412 })
      }
      kvStore.set(key, { value: JSON.parse(JSON.stringify(value)), revision: (hit?.revision ?? 0) + 1 })
      return { revision: (hit?.revision ?? 0) + 1 }
    },
    async remove(key) {
      const hit = kvStore.get(key)
      if (!hit) throw Object.assign(new Error('not found'), { status: 404 })
      kvStore.delete(key)
    },
    async list() { return [] },
  }

  const ctx = {
    id: 'music.rs',
    signal: undefined,
    // 宿主上报的插件 API 版本：3.9 起 save_to 可直写宿主/CD2 目标目录
    plugin: { id: 'music.rs', name: '音乐下载', version: '1.2.0', generation: 'g', revision: 'r', host_api: hostApi },
    storage,
    api: {
      async get(path) {
        const key = decodeURIComponent(path.replace(/^\/api\/extensions\/v3\/music\.rs\/storage\//, ''))
        const hit = kvStore.get(key)
        if (!hit) throw Object.assign(new Error('not found'), { status: 404 })
        return { value: JSON.parse(JSON.stringify(hit.value)), revision: hit.revision }
      },
    },
    settings: {
      async get() {
        const hit = kvStore.get('settings')
        return hit ? JSON.parse(JSON.stringify(hit.value)) : {}
      },
      async set(value) { return storage.set('settings', value) },
    },
    http: {
      async request(options) {
        calls.http.push(options)
        if (options.save_to) {
          // 宿主不支持 3.9 直写目标目录时（绝对路径）抛错，插件应回落暂存→定名→move。
          if (refuseDirectWrite && String(options.save_to).startsWith('/')) {
            throw new Error('save_to 写绝对路径需要宿主插件 API 3.9')
          }
          if (saveToHandler) {
            const custom = await saveToHandler(options)
            if (custom !== undefined) return custom
          }
          // save_to：模拟 2xx 流式写盘。
          files.set(options.save_to, 4321)
          return { status: 200, url: options.url, headers: {}, body: '', cached: false, path: options.save_to, size: 4321, sha256: 'deadbeef' }
        }
        if (httpHandler) return httpHandler(options)
        return { status: 200, url: options.url, headers: {}, body: '{}', cached: false }
      },
    },
    files: {
      async call(options) {
        calls.files.push(options)
        if (options.operation === 'exists') {
          if (!withExists) throw new Error('unexpected files op: exists')
          return files.has(options.path)
        }
        if (options.operation === 'list') {
          return [...files.keys()].map((path) => ({ name: path.split('/').pop(), path, is_dir: false, size: files.get(path) ?? 0 }))
        }
        if (options.operation === 'rename') {
          if (!files.has(options.path)) throw new Error('文件不存在')
          const dir = options.path.split('/').slice(0, -1).join('/')
          const target = `${dir}/${options.name}`
          files.set(target, files.get(options.path))
          files.delete(options.path)
          return { path: target }
        }
        if (options.operation === 'move') {
          const name = options.path.split('/').pop()
          if (failMoveFor.has(name)) throw new Error('目标已存在')
          if (!files.has(options.path)) throw new Error('文件不存在')
          const target = `${options.destination_dir}/${name}`
          if (files.has(target) && !options.overwrite) throw new Error('目标已存在')
          const size = files.get(options.path) ?? 0
          files.set(target, size)
          files.delete(options.path)
          return { backend: 'system', items: [{ source: options.path, path: target, size }] }
        }
        if (options.operation === 'remove') {
          for (const path of options.paths ?? []) files.delete(path)
          return {}
        }
        throw new Error(`unexpected files op: ${options.operation}`)
      },
    },
    notify: async (options) => {
      calls.notify.push(options)
      return { accepted: true, channels: [{ channel: 'telegram', dropped: [] }] }
    },
    crypto: {
      md5: (data, output) => createHash('md5').update(data).digest(output),
      aesEncrypt: ({ key, data, padding, output }) => {
        assert.equal(padding, 'pkcs7')
        const cipher = createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null)
        return Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]).toString('hex')
      },
    },
    task: {
      async update() {},
      async log() {},
      async checkpoint() {},
      id: 'task-1',
    },
  }
  // 网易云 eapi 取链应答器：第一档就命中。
  httpHandler = (options) => {
    assert.equal(options.method, 'POST')
    const index = calls.http.filter((c) => !c.save_to).length
    const body = Array.isArray(songUrlBodies) ? songUrlBodies[Math.min(index, songUrlBodies.length - 1)] : null
    if (body !== null) return { status: 200, url: options.url, headers: {}, body, cached: false }
    return {
      status: 200, url: options.url, headers: {}, cached: false,
      body: JSON.stringify({ data: [{ url: 'https://cdn.example.com/song.flac', type: 'flac', level: 'lossless', size: 1024 }] }),
    }
  }
  return { ctx, kvStore, files, calls, failMoveFor, setSaveTo(handler) { saveToHandler = handler } }
}

async function seedEnqueued(host, overrides = {}) {
  return enqueue(createKv(host.ctx), {
    source: 'netease',
    song_id: '186016',
    name: '晴天',
    singers: '周杰伦',
    album: '叶惠美',
    quality: DEFAULT_QUALITY,
    ...overrides,
  })
}

async function runPump(host) {
  const deps = buildDeps(host.ctx)
  deps.settings = await readSettings(host.ctx)
  return pump(host.ctx, deps)
}

// ─────────────────────────── 用例 ───────────────────────────

test('pump full pipeline: url → save_to 直写目标目录 → done（API 3.9）', async () => {
  const host = makeHost()
  const { task } = await seedEnqueued(host)
  const summary = await runPump(host)
  assert.deepEqual(summary.completed, [task.id])
  assert.deepEqual(summary.started, [task.id])
  assert.equal(summary.failed.length, 0)
  // 取链请求带 eapi 表单；下载请求带 save_to。
  const download = host.calls.http.find((c) => c.save_to)
  assert.ok(download, '必须有 save_to 下载请求')
  const target = `${normalizeSettings(null).target_dir}/周杰伦 - 晴天.flac`
  assert.equal(download.save_to, target, 'API 3.9：直写目标目录，不经暂存')
  assert.equal(download.timeout_seconds, DOWNLOAD_TIMEOUT_SECONDS)
  assert.ok(download.url.startsWith('https://cdn.example.com/'))
  // 直写路径没有定名与 move。
  assert.equal(host.calls.files.find((c) => c.operation === 'rename'), undefined)
  assert.equal(host.calls.files.find((c) => c.operation === 'move'), undefined)
  assert.ok(host.files.has(target), '文件已在目标目录')
  // 任务落盘为 done。
  const done = await loadTask(createKv(host.ctx), task.id)
  assert.equal(done.status, 'done')
  assert.equal(done.out_name, '周杰伦 - 晴天.flac')
  assert.equal(done.staged_path, target)
  assert.equal(done.error, '')
  const index = await loadIndex(createKv(host.ctx))
  assert.equal(index[0].status, 'done')
})

test('宿主不支持 3.9 直写时回落：暂存 → 定名 → move → done', async () => {
  const host = makeHost({ hostApi: '3.5' })
  const { task } = await seedEnqueued(host)
  const summary = await runPump(host)
  assert.deepEqual(summary.completed, [task.id])
  const rename = host.calls.files.find((c) => c.operation === 'rename')
  assert.equal(rename.name, '周杰伦 - 晴天.flac')
  const move = host.calls.files.find((c) => c.operation === 'move')
  assert.equal(move.destination_dir, normalizeSettings(null).target_dir)
  const done = await loadTask(createKv(host.ctx), task.id)
  assert.equal(done.status, 'done')
})

test('pump reports link failure and requeues until MAX_ATTEMPTS then notifies with retry button', async () => {
  const host = makeHost({ songUrlBodies: Array.from({ length: 24 }, () => '{"data":[]}') })
  await host.ctx.storage.set('settings', { max_active: 4 })
  const { task } = await seedEnqueued(host)
  // 失败回队的任务等下一轮重试（同一轮不连烧尝试）：三轮 pump 才用尽 3 次。
  const messages = []
  for (let round = 1; round <= 2; round++) {
    const partial = await runPump(host)
    messages.push(...partial.messages)
    assert.deepEqual(partial.failed, [], `第 ${round} 轮只回队不终态`)
    assert.equal((await loadTask(createKv(host.ctx), task.id)).attempts, round)
  }
  const summary = await runPump(host)
  summary.messages.unshift(...messages)
  assert.deepEqual(summary.failed, [task.id])
  const stored = await loadTask(createKv(host.ctx), task.id)
  assert.equal(stored.status, 'failed')
  assert.equal(stored.attempts, 3)
  assert.match(stored.error, /所有音质均未获取到链接/)
  // 重试过程可见：messages 里留下前两次的「将重试」。
  assert.ok(summary.messages.some((m) => m.includes('第 1 次尝试失败')), summary.messages.join(' | '))
  assert.ok(summary.messages.some((m) => m.includes('第 2 次尝试失败')))
  // 终态通知带 Telegram 重试按钮（callback_data = retry:<短id>）。
  assert.equal(host.calls.notify.length, 1)
  const notification = host.calls.notify[0]
  assert.equal(notification.level, 'error')
  assert.match(notification.title, /下载失败/)
  assert.match(notification.dedupe_key, /^dl-fail-/)
  assert.deepEqual(notification.buttons, [[{ text: '重试', callback_data: `retry:${task.id}` }]])
  assert.match(notification.body, /在插件「下载任务」里可一键重试/)
})

test('pump counts move failure on copying and finishes after the target frees up', async () => {
  // 宿主 API 3.5（无直写能力）→ 走暂存→定名→move，move 失败才有场景
  const host = makeHost({ hostApi: '3.5' })
  const { task } = await seedEnqueued(host)
  // 第 1 轮：入库失败（目标已存在）→ copying + attempts=1，暂存文件保留。
  host.failMoveFor.add('周杰伦 - 晴天.flac')
  const first = await runPump(host)
  assert.equal(first.completed.length, 0)
  const kv = createKv(host.ctx)
  const stored = await loadTask(kv, task.id)
  assert.equal(stored.status, 'copying')
  // Rust copy_failure 语义：下载启动 +1、入库失败再 +1 —— 同轮下载+入库失败计 2 次。
  assert.equal(stored.attempts, 2)
  assert.match(stored.error, /入库失败/)
  assert.ok(host.files.has(`${STAGING_SUBDIR}/周杰伦 - 晴天.flac`), '入库失败时暂存文件保留')
  // 第 2 轮（目标腾出）：copying 残留重试入库 → done，且不重新下载。
  const httpBefore = host.calls.http.length
  host.failMoveFor.clear()
  const second = await runPump(host)
  assert.deepEqual(second.completed, [task.id])
  assert.equal(host.calls.http.length, httpBefore, 'copying 重试不发任何网络请求')
  const done = await loadTask(kv, task.id)
  assert.equal(done.status, 'done')
})

test('pump recovers downloading residue as interrupted attempt', async () => {
  const host = makeHost()
  const { task } = await seedEnqueued(host)
  // 手工把任务摆成 downloading 残留（上一轮被宿主杀掉：分片与索引都停在 downloading）。
  const kv = createKv(host.ctx)
  const stored = await loadTask(kv, task.id)
  stored.status = 'downloading'
  stored.attempts = 0
  await persistTask(kv, stored)
  const summary = await runPump(host)
  // ① 按 fail 语义 attempts+1 回 queued；③ 接着把它正常跑完（本轮尚无收尾占用门禁）。
  const after = await loadTask(kv, task.id)
  assert.equal(after.status, 'done', 'downloading 残留先计一次中断、再由 ③ 正常推进到完成')
  assert.equal(after.attempts, 2)
  assert.deepEqual(summary.completed, [task.id])
  // attempts 已达上限的 downloading 残留 → 直接 failed + 通知（③ 的门禁随后停轮）。
  const host2 = makeHost()
  const seeded = await seedEnqueued(host2)
  const kv2 = createKv(host2.ctx)
  const residue = await loadTask(kv2, seeded.task.id)
  residue.status = 'downloading'
  residue.attempts = 2
  await persistTask(kv2, residue)
  const summary2 = await runPump(host2)
  const failed = await loadTask(kv2, seeded.task.id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.attempts, 3)
  assert.deepEqual(summary2.failed, [seeded.task.id])
  assert.equal(host2.calls.notify.length, 1)
})

test('pump retries copying residue without re-downloading', async () => {
  const host = makeHost()
  const { task } = await seedEnqueued(host)
  // 手工摆成 copying 残留：定名后的文件还在暂存目录（分片与索引一致）。
  const kv = createKv(host.ctx)
  const stored = await loadTask(kv, task.id)
  stored.status = 'copying'
  stored.staged_path = `${STAGING_SUBDIR}/周杰伦 - 晴天.flac`
  stored.out_name = '周杰伦 - 晴天.flac'
  await persistTask(kv, stored)
  host.files.set(stored.staged_path, 4321)
  const httpBefore = host.calls.http.length
  const summary = await runPump(host)
  assert.deepEqual(summary.completed, [task.id])
  assert.equal(host.calls.http.length, httpBefore, 'copying 重试不发任何网络请求')
  const move = host.calls.files.find((c) => c.operation === 'move')
  assert.equal(move.path, stored.staged_path)
})

test('pump respects max_active (starts and finishes up to max_active per round)', async () => {
  const host = makeHost()
  const kv = createKv(host.ctx)
  const a = await seedEnqueued(host, { song_id: '1' })
  const b = await seedEnqueued(host, { song_id: '2' })
  await seedEnqueued(host, { song_id: '3' })
  // 队列取序与分片 Rust pump 一致：从排序后的索引头取第一个 queued
  // （索引按 updated_ms 倒序、同值按 id 倒序，见 tasks-core.sortIndex）。
  // 这里直接按索引顺序取队首，不猜「id 最大的那条」——三条任务入队跨毫秒时
  // updated_ms 不同，队首由时间戳决定，猜 id 会偶发失败。
  const index = await loadIndex(kv)
  const head = index.find((entry) => entry.status === 'queued')?.id
  const summary = await runPump(host)
  // max_active=2（默认）：本轮新开并完成 2 首，从队首开始；第 3 首等下一轮。
  assert.equal(summary.started.length, 2)
  assert.equal(summary.completed.length, 2)
  assert.equal(summary.completed[0], head)
  assert.equal(summary.queued, 1)
  assert.ok(summary.messages.some((m) => m.includes('1 个排队任务等待下一轮')), summary.messages.join(' | '))
  const statuses = await Promise.all([a, b].map(async (x) => (await loadTask(kv, x.task.id)).status))
  assert.ok(statuses.every((s) => s === 'queued' || s === 'done'))
})

test('直写遇到目标目录同名文件：挑「 (2)」不覆盖用户原有文件', async () => {
  const host = makeHost()
  const dir = normalizeSettings(null).target_dir
  host.files.set(`${dir}/周杰伦 - 晴天.flac`, 999)
  const { task } = await seedEnqueued(host)
  const summary = await runPump(host)
  assert.deepEqual(summary.completed, [task.id])
  const download = host.calls.http.find((c) => c.save_to)
  assert.equal(download.save_to, `${dir}/周杰伦 - 晴天 (2).flac`)
  assert.equal(host.files.get(`${dir}/周杰伦 - 晴天.flac`), 999, '原有文件不被覆盖')
  const done = await loadTask(createKv(host.ctx), task.id)
  assert.equal(done.out_name, '周杰伦 - 晴天 (2).flac')
})

test('直写返回非 2xx：不删目标路径上的文件，回队重试', async () => {
  const host = makeHost()
  const { task } = await seedEnqueued(host)
  host.setSaveTo(() => ({ status: 403, url: 'x', headers: {}, body: 'forbidden', cached: false }))
  const summary = await runPump(host)
  assert.deepEqual(summary.completed, [])
  assert.equal(host.calls.files.find((c) => c.operation === 'remove'), undefined, '非 2xx 宿主不落文件，不应 remove')
  assert.equal(host.calls.http.filter((c) => c.save_to).length, 1, '非 2xx 不回落暂存重下')
  const stored = await loadTask(createKv(host.ctx), task.id)
  assert.equal(stored.status, 'queued')
  assert.match(stored.error, /HTTP 403/)
})

test('直写遇到网络错误不回落暂存（避免同一轮重复下载）；能力缺失才回落', async () => {
  const host = makeHost()
  const { task } = await seedEnqueued(host)
  host.setSaveTo(() => { throw new Error('POST /api/extensions/v3/music.rs/http: connection reset') })
  await runPump(host)
  assert.equal(host.calls.http.filter((c) => c.save_to).length, 1)
  const stored = await loadTask(createKv(host.ctx), task.id)
  assert.equal(stored.status, 'queued')
  assert.match(stored.error, /connection reset/)

  const host2 = makeHost({ refuseDirectWrite: true })
  const seeded = await seedEnqueued(host2)
  const summary2 = await runPump(host2)
  assert.deepEqual(summary2.completed, [seeded.task.id])
  assert.equal(host2.calls.http.filter((c) => c.save_to).length, 2, '能力缺失：直写失败后暂存重下一次')
})

test('直写返回空文件：删掉本任务写出的空文件并回队', async () => {
  const host = makeHost()
  const { task } = await seedEnqueued(host)
  host.setSaveTo((options) => {
    host.files.set(options.save_to, 0)
    return { status: 200, url: 'x', headers: {}, body: '', cached: false, path: options.save_to, size: 0 }
  })
  await runPump(host)
  const target = `${normalizeSettings(null).target_dir}/周杰伦 - 晴天.flac`
  assert.equal(host.files.has(target), false)
  const stored = await loadTask(createKv(host.ctx), task.id)
  assert.equal(stored.status, 'queued')
  assert.match(stored.error, /空文件/)
})

test('回落路径：move 失败后下一轮用已定名的暂存路径入库（不再找 .part）', async () => {
  const host = makeHost({ hostApi: '3.5' })
  const { task } = await seedEnqueued(host)
  host.failMoveFor.add('周杰伦 - 晴天.flac')
  await runPump(host)
  const kv = createKv(host.ctx)
  const stored = await loadTask(kv, task.id)
  assert.equal(stored.status, 'copying')
  assert.equal(stored.staged_path, `${STAGING_SUBDIR}/周杰伦 - 晴天.flac`, '定名后立即落盘新暂存路径')
  host.failMoveFor.clear()
  const second = await runPump(host)
  assert.deepEqual(second.completed, [task.id])
  const moves = host.calls.files.filter((c) => c.operation === 'move')
  assert.equal(moves.at(-1).path, `${STAGING_SUBDIR}/周杰伦 - 晴天.flac`)
  assert.equal(moves.at(-1).overwrite, false)
})

test('回落路径：目标目录已有同名文件时定名为「 (2)」再 move', async () => {
  const host = makeHost({ hostApi: '3.5' })
  const dir = normalizeSettings(null).target_dir
  host.files.set(`${dir}/周杰伦 - 晴天.flac`, 1)
  const { task } = await seedEnqueued(host)
  const summary = await runPump(host)
  assert.deepEqual(summary.completed, [task.id])
  assert.equal(host.files.get(`${dir}/周杰伦 - 晴天.flac`), 1)
  assert.ok(host.files.has(`${dir}/周杰伦 - 晴天 (2).flac`))
})

test('copying 残留：暂存文件已不在但目标已在 → 视为上轮 move 已成功', async () => {
  const host = makeHost()
  const { task } = await seedEnqueued(host)
  const kv = createKv(host.ctx)
  const stored = await loadTask(kv, task.id)
  stored.status = 'copying'
  stored.staged_path = `${STAGING_SUBDIR}/周杰伦 - 晴天.flac`
  stored.out_name = '周杰伦 - 晴天.flac'
  await persistTask(kv, stored)
  host.files.set(`${normalizeSettings(null).target_dir}/周杰伦 - 晴天.flac`, 4321)
  const summary = await runPump(host)
  assert.deepEqual(summary.completed, [task.id])
  assert.equal(host.calls.files.find((c) => c.operation === 'move'), undefined)
  // 两边都不在 → 回队重新下载。
  const host2 = makeHost()
  const seeded = await seedEnqueued(host2)
  const kv2 = createKv(host2.ctx)
  const residue = await loadTask(kv2, seeded.task.id)
  residue.status = 'copying'
  residue.staged_path = `${STAGING_SUBDIR}/${seeded.task.id}.part`
  residue.out_name = '周杰伦 - 晴天.flac'
  await persistTask(kv2, residue)
  await runPump(host2)
  const after = await loadTask(kv2, seeded.task.id)
  assert.equal(after.status, 'done', '回队后本轮 ③ 重新下载完成')
  assert.ok(host2.calls.http.some((c) => c.save_to))
})

test('宿主不支持 files.exists 时仍能完成（存在性未知按原名继续）', async () => {
  const host = makeHost({ withExists: false })
  const { task } = await seedEnqueued(host)
  const summary = await runPump(host)
  assert.deepEqual(summary.completed, [task.id])
})

test('pump 上报任务级计数 total/done/failed', async () => {
  const host = makeHost()
  const updates = []
  host.ctx.task.update = async (value) => { updates.push(value) }
  await seedEnqueued(host, { song_id: '1' })
  await seedEnqueued(host, { song_id: '2' })
  await runPump(host)
  assert.ok(updates.length >= 2)
  const last = updates.at(-1)
  assert.deepEqual({ total: last.total, done: last.done, failed: last.failed }, { total: 2, done: 2, failed: 0 })
  assert.ok(updates.every((u) => u.total === 2))
})

test('channelSummary 优先读 deliveries，其次 suppressed / channels', () => {
  assert.equal(channelSummary({ deliveries: [
    { channel: 'telegram', status: 'sent' },
    { channel: 'wecom', status: 'skipped', reason: 'quiet_hours' },
    { channel: 'bark', status: 'failed', error: '超时' },
  ] }), 'telegram 已送达 · wecom 跳过:quiet_hours · bark 失败:超时')
  assert.equal(channelSummary({ suppressed: true, suppression_reason: 'no_channel_enabled' }), '无(no_channel_enabled)')
  assert.equal(channelSummary({ channels: [{ channel: 'telegram', dropped: ['buttons'] }] }), 'telegram(丢:buttons)')
  assert.equal(channelSummary({}), null)
})

test('looksLikeDirectWriteUnsupported 不把普通网络错误当成能力缺失', () => {
  assert.equal(looksLikeDirectWriteUnsupported(new Error('POST /api/extensions/v3/music.rs/http: timeout')), false)
  assert.equal(looksLikeDirectWriteUnsupported(new Error('save_to 写绝对路径需要宿主插件 API 3.9')), true)
  assert.equal(looksLikeDirectWriteUnsupported(Object.assign(new Error('x'), { status: 403 })), true)
  assert.equal(looksLikeDirectWriteUnsupported(new Error('目标路径不允许写入')), true)
})

test('targetName 与 outName 同一套清洗规则', () => {
  assert.equal(targetName({ singers: 'A/B', name: 'C' }, '.MP3'), 'A_B - C.mp3')
  assert.equal(targetName({ singers: '', name: 'C' }, ''), '未知 - C.flac')
})
