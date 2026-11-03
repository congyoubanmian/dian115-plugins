// pump 管线端到端测试 —— 假宿主（ctx.storage/api/http/files/notify/crypto）覆盖：
// 入队 → 取链（注入 node:crypto 复刻 eapi）→ save_to 暂存 → 定名 → move 入库 → done；
// 失败重试（attempts 上限 + 通知按钮 callback_data）、downloading/copying 中断残留恢复。
// 对照 plugins/music-rs/src/download.rs 的集成测试（FakeHost）移植。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import { pump, STAGING_SUBDIR, DOWNLOAD_TIMEOUT_SECONDS } from '../../music-rs/lib/pump.js'
import { enqueue, loadIndex, loadTask, persistTask } from '../../music-rs/lib/queue-store.js'
import { createKv } from '../../music-rs/lib/kv.js'
import { buildDeps, readSettings } from '../../music-rs/jobs/runtime.js'
import { normalizeSettings } from '../../music-rs/lib/settings.js'
import { DEFAULT_QUALITY } from '../../music-rs/lib/settings.js'

// ─────────────────────────── 假宿主 ───────────────────────────

function makeHost({ songUrlBodies = null, refuseDirectWrite = false, hostApi = '3.9', targetAppearsAfterStaging = false } = {}) {
  const kvStore = new Map()
  const files = new Map() // path → size
  const calls = { http: [], files: [], notify: [] }
  const failMoveFor = new Set() // 目标已存在的文件名（move 抛错）
  let httpHandler = null
  let stagingDownloaded = false // 模拟「下载期间目标目录被塞进同名文件」的竞态
  const defaultTarget = `${normalizeSettings(null).target_dir}/周杰伦 - 晴天.flac`

  const storage = {
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
          // save_to：模拟 2xx 流式写盘。
          files.set(options.save_to, 4321)
          if (String(options.save_to).startsWith('downloads/')) stagingDownloaded = true
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
          // 竞态注入：暂存下载落盘后，目标目录才出现同名文件（move 前预检的用例）。
          if (targetAppearsAfterStaging && options.path === defaultTarget) return stagingDownloaded
          return files.has(options.path)
        }
        if (options.operation === 'stat') {
          if (!files.has(options.path)) throw Object.assign(new Error('not found'), { status: 404 })
          return { name: options.path.split('/').pop(), path: options.path, is_dir: false, size: files.get(options.path) ?? 0 }
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
          files.delete(options.path)
          return { backend: 'system', items: [{ source: options.path, path: `${options.destination_dir}/${name}`, size: files.get(options.path) ?? 0 }] }
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
  return { ctx, kvStore, files, calls, failMoveFor }
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
  // 宿主 save_to 响应里的完整性字段记进 done 任务（可追溯；索引条目不投影）。
  assert.equal(done.size, 4321)
  assert.equal(done.sha256, 'deadbeef')
  const index = await loadIndex(createKv(host.ctx))
  assert.equal(index[0].status, 'done')
  assert.equal(index[0].sha256, undefined, '索引不投影 sha256，保持紧凑')
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
  // move 不改内容：完整性字段沿用下载响应里宿主算好的值。
  assert.equal(done.size, 4321)
  assert.equal(done.sha256, 'deadbeef')
})

test('pump reports link failure and requeues until MAX_ATTEMPTS then notifies with retry button', async () => {
  const host = makeHost({ songUrlBodies: Array.from({ length: 24 }, () => '{"data":[]}') })
  // 放宽单轮新开上限（默认 2），让一轮 pump 内跑满 3 次尝试。
  await host.ctx.storage.set('settings', { max_active: 4 })
  const { task } = await seedEnqueued(host)
  // 一轮 pump 会循环推进直到收尾：取链失败 → 回 queued（第 1、2 次）→ 第 3 次用尽 → failed + 通知。
  const summary = await runPump(host)
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
  // dedupe_key 稳定化：只含任务 id（同任务重复失败不再换键，10 分钟窗口内去重生效）。
  assert.equal(notification.dedupe_key, `dl-fail-${task.id}`)
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

test('pump respects max_active and the one-finalization gate', async () => {
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
  // max_active=2：本轮最多新开 2 首；但收尾门禁（一次 pump 最多收尾 1 首）在第一首
  // 完成后停止新开 —— 所以恰好 started=1，完成的是队首。
  assert.equal(summary.started.length, 1)
  assert.deepEqual(summary.completed, [head])
  const aTask = await loadTask(kv, a.task.id)
  const bTask = await loadTask(kv, b.task.id)
  assert.ok([aTask.status, bTask.status].every((s) => s === 'queued' || s === 'done'))
})

test('同名预检：直写前发现目标已存在 → 终态失败, 不发下载请求', async () => {
  const host = makeHost()
  const { task } = await seedEnqueued(host)
  // 目标目录里已经有同名文件（上一首歌/用户手动放的）。
  const target = `${normalizeSettings(null).target_dir}/周杰伦 - 晴天.flac`
  host.files.set(target, 999)
  const summary = await runPump(host)
  assert.deepEqual(summary.failed, [task.id])
  // 没有发生任何下载：预检直接终态失败。
  assert.equal(host.calls.http.find((c) => c.save_to), undefined)
  const stored = await loadTask(createKv(host.ctx), task.id)
  assert.equal(stored.status, 'failed')
  assert.equal(stored.attempts, 1, '终态失败不再累计 attempts（重试改变不了结果）')
  assert.ok(stored.error.includes('目标已存在'), stored.error)
  assert.ok(stored.error.includes(target), '错误信息写明目标路径')
  // 通知带稳定 dedupe_key（只含任务 id）。
  assert.equal(host.calls.notify.length, 1)
  assert.equal(host.calls.notify[0].dedupe_key, `dl-fail-${task.id}`)
  assert.match(host.calls.notify[0].body, new RegExp(target.slice(0, 20)))
})

test('同名预检：move 前发现目标已出现（下载期间被占用）→ 终态失败, 不入库', async () => {
  // API 3.5 走回落：暂存下载成功，但下载期间目标目录出现同名文件 → move 前预检拦下。
  const host = makeHost({ hostApi: '3.5', targetAppearsAfterStaging: true })
  const { task } = await seedEnqueued(host)
  const target = `${normalizeSettings(null).target_dir}/周杰伦 - 晴天.flac`
  const summary = await runPump(host)
  assert.deepEqual(summary.failed, [task.id])
  // 下载发生了（暂存落盘），但入库 move 没有发生。
  assert.ok(host.calls.http.find((c) => c.save_to), '暂存下载已发生')
  assert.equal(host.calls.files.find((c) => c.operation === 'move'), undefined)
  const stored = await loadTask(createKv(host.ctx), task.id)
  assert.equal(stored.status, 'failed')
  assert.ok(stored.error.includes(target), '错误信息写明目标路径')
  // 暂存文件保留（与 copyFailure 终态语义一致，由用户处理）。
  assert.ok(host.files.has(`${STAGING_SUBDIR}/周杰伦 - 晴天.flac`))
})

test('copying 残留入库前发现目标已存在 → 终态失败, 不再重试入库', async () => {
  const host = makeHost({ hostApi: '3.5' })
  const { task } = await seedEnqueued(host)
  // 手工摆成 copying 残留，且目标目录已有同名文件。
  const kv = createKv(host.ctx)
  const stored = await loadTask(kv, task.id)
  stored.status = 'copying'
  stored.staged_path = `${STAGING_SUBDIR}/周杰伦 - 晴天.flac`
  stored.out_name = '周杰伦 - 晴天.flac'
  await persistTask(kv, stored)
  host.files.set(stored.staged_path, 4321)
  host.files.set(`${normalizeSettings(null).target_dir}/周杰伦 - 晴天.flac`, 100)
  const summary = await runPump(host)
  assert.deepEqual(summary.failed, [task.id])
  assert.equal(host.calls.files.find((c) => c.operation === 'move'), undefined)
  const failed = await loadTask(kv, task.id)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /目标已存在/)
  assert.equal(host.calls.notify.length, 1)
  assert.equal(host.calls.notify[0].dedupe_key, `dl-fail-${task.id}`)
})
