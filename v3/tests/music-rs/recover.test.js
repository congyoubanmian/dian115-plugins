// 中断恢复测试：pump 的前后检查点 + recoverPump 按目标目录里的真实文件判定三态。
// 覆盖「中断 → recover → 不重复执行外部写」：文件已入库 → complete（不再重下）；
// 暂存还在 → resume（只重做入库、零网络请求）；读不到 → attention。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import { run as runPumpJob, recover as recoverPumpJob } from '../../music-rs/jobs/queue-pump.js'
import { pump, recoverPump, STAGING_SUBDIR } from '../../music-rs/lib/pump.js'
import { enqueue, loadTask, persistTask } from '../../music-rs/lib/queue-store.js'
import { createKv } from '../../music-rs/lib/kv.js'
import { buildDeps, readSettings } from '../../music-rs/jobs/runtime.js'
import { normalizeSettings, DEFAULT_QUALITY } from '../../music-rs/lib/settings.js'

// ─────────────────────────── 假宿主 ───────────────────────────

function makeHost({ hostApi = '3.9', failMoveFor = new Set(), filesBroken = false } = {}) {
  const kvStore = new Map()
  const files = new Map() // path → size
  const calls = { http: [], files: [], notify: [], checkpoints: [] }
  const targetDir = normalizeSettings(null).target_dir

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
    async remove(key) { kvStore.delete(key) },
  }

  const ctx = {
    id: 'music.rs',
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
    },
    http: {
      async request(options) {
        calls.http.push(options)
        if (options.save_to) {
          files.set(options.save_to, 4321)
          return { status: 200, url: options.url, headers: {}, body: '', cached: false, path: options.save_to, size: 4321, sha256: 'deadbeef' }
        }
        return {
          status: 200, url: options.url, headers: {}, cached: false,
          body: JSON.stringify({ data: [{ url: 'https://cdn.example.com/song.flac', type: 'flac', level: 'lossless', size: 1024 }] }),
        }
      },
    },
    files: {
      async call(options) {
        calls.files.push(options)
        if (filesBroken && (options.operation === 'exists' || options.operation === 'stat')) {
          throw new Error('目标目录不可读')
        }
        if (options.operation === 'exists') return files.has(options.path)
        if (options.operation === 'stat') {
          if (!files.has(options.path)) {
            const error = new Error('not found')
            error.status = 404
            throw error
          }
          return { name: options.path.split('/').pop(), path: options.path, is_dir: false, size: files.get(options.path) ?? 0, modified: '', backend: 'local' }
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
          const size = files.get(options.path) ?? 0
          files.delete(options.path)
          files.set(`${options.destination_dir}/${name}`, size)
          return { backend: 'system', items: [{ source: options.path, path: `${options.destination_dir}/${name}`, size }] }
        }
        if (options.operation === 'remove') {
          for (const path of options.paths ?? []) files.delete(path)
          return {}
        }
        throw new Error(`unexpected files op: ${options.operation}`)
      },
    },
    notify: async (options) => { calls.notify.push(options); return { accepted: true } },
    crypto: {
      md5: (data, output) => createHash('md5').update(data).digest(output),
      aesEncrypt: ({ key, data, padding, output }) => {
        assert.equal(padding, 'pkcs7')
        const cipher = createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null)
        return Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]).toString(output)
      },
    },
    task: {
      id: 'task-recover-1',
      async update() {},
      async log() {},
      async checkpoint(value) { calls.checkpoints.push(value) },
    },
  }
  return { ctx, kvStore, files, calls, targetDir }
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

// ─────────────────────────── 检查点写入 ───────────────────────────

test('直写链路（API 3.9）：下载前写 before-download、成功后写 after-download，job 壳最后写 completed', async () => {
  const host = makeHost()
  const { task } = await seedEnqueued(host)
  const summary = await runPumpJob(host.ctx)
  assert.deepEqual(summary.completed, [task.id])
  const stages = host.calls.checkpoints.map((entry) => entry.stage)
  assert.deepEqual(stages, ['before-download', 'after-download', 'completed'], JSON.stringify(stages))
  const before = host.calls.checkpoints[0]
  assert.equal(before.out_name, '周杰伦 - 晴天.flac')
  assert.equal(before.target_path, `${host.targetDir}/周杰伦 - 晴天.flac`)
  assert.equal(before.task_ref, 'task-recover-1')
  assert.ok(before.updated_at !== '')
  const after = host.calls.checkpoints[1]
  assert.equal(after.direct, true)
  assert.equal(after.size, 4321)
  assert.equal(after.path, after.target_path)
  // 整轮 completed 必须最后写（单任务检查点会被下一首覆盖）。
  const completed = host.calls.checkpoints[2]
  assert.deepEqual(completed.result.completed, [task.id])
})

test('回落链路（API 3.5）：下载后写 after-download(暂存)，入库前写 before-move、成功后写 after-move', async () => {
  const host = makeHost({ hostApi: '3.5' })
  const { task } = await seedEnqueued(host)
  const summary = await runPumpJob(host.ctx)
  assert.deepEqual(summary.completed, [task.id])
  const stages = host.calls.checkpoints.map((entry) => entry.stage)
  assert.deepEqual(stages, ['before-download', 'after-download', 'before-move', 'after-move', 'completed'], JSON.stringify(stages))
  const after = host.calls.checkpoints[1]
  assert.equal(after.direct, false)
  assert.equal(after.staging_path, `${STAGING_SUBDIR}/${task.id}.part`, '下载落在暂存的 .part 文件')
  assert.equal(after.target_path, `${host.targetDir}/周杰伦 - 晴天.flac`)
  const beforeMove = host.calls.checkpoints[2]
  assert.equal(beforeMove.staging_path, `${STAGING_SUBDIR}/周杰伦 - 晴天.flac`, '入库前已是定名后的路径')
})

// ─────────────────────────── recover 三态 ───────────────────────────

test('中断在直写之后（文件已在目标目录）→ complete，recover 零网络请求', async () => {
  const host = makeHost()
  await seedEnqueued(host)
  await runPumpJob(host.ctx)
  const after = host.calls.checkpoints.find((entry) => entry.stage === 'after-download')
  const httpBefore = host.calls.http.length
  const decision = await recoverPumpJob(host.ctx, after)
  assert.equal(decision.action, 'complete')
  assert.equal(decision.result.status, 'succeeded')
  assert.equal(decision.result.path, `${host.targetDir}/周杰伦 - 晴天.flac`)
  assert.equal(host.calls.http.length, httpBefore, 'recover 不重新下载')
})

test('整轮 completed 检查点 → complete(result)', async () => {
  const host = makeHost()
  await seedEnqueued(host)
  const summary = await runPumpJob(host.ctx)
  const completed = host.calls.checkpoints[host.calls.checkpoints.length - 1]
  const decision = await recoverPump(host.ctx, completed)
  assert.equal(decision.action, 'complete')
  assert.deepEqual(decision.result, summary)
  // 旧词表 done 同样按 complete 处理（历史任务兼容）。
  assert.equal((await recoverPump(host.ctx, { stage: 'done', result: { x: 1 } })).action, 'complete')
})

test('中断在下载之前（明确没写）→ resume；目标已存在 → complete', async () => {
  const host = makeHost()
  const { task } = await seedEnqueued(host)
  const target = `${host.targetDir}/周杰伦 - 晴天.flac`
  const decision = await recoverPump(host.ctx, {
    stage: 'before-download', task_ref: 't', song_id: task.id, out_name: '周杰伦 - 晴天.flac', target_path: target,
  })
  assert.equal(decision.action, 'resume')
  // 目标文件已在（比如宿主其实写完了）→ 写已落地 → complete。
  host.files.set(target, 4321)
  const landed = await recoverPump(host.ctx, {
    stage: 'before-download', task_ref: 't', song_id: task.id, out_name: '周杰伦 - 晴天.flac', target_path: target,
  })
  assert.equal(landed.action, 'complete')
})

test('写前预检没读到目标目录（target_checked=false）：目标在也不认作本任务落地 → attention', async () => {
  const host = makeHost()
  const target = `${host.targetDir}/周杰伦 - 晴天.flac`
  host.files.set(target, 999)
  const checkpoint = {
    stage: 'before-download', task_ref: 't', song_id: 'a1', out_name: '周杰伦 - 晴天.flac',
    target_path: target, target_checked: false,
  }
  assert.equal((await recoverPump(host.ctx, checkpoint)).action, 'attention')
  host.files.delete(target)
  assert.equal((await recoverPump(host.ctx, checkpoint)).action, 'resume')
})

test('中断在入库之前：暂存还在 → resume（重跑只入库、零网络）；都没了 → attention', async () => {
  const failMoveFor = new Set(['周杰伦 - 晴天.flac'])
  const host = makeHost({ hostApi: '3.5', failMoveFor })
  const { task } = await seedEnqueued(host)
  await runPump(host)
  const beforeMove = host.calls.checkpoints.find((entry) => entry.stage === 'before-move')
  assert.ok(beforeMove, '入库前必须有 before-move 检查点')
  assert.equal(host.files.has(`${STAGING_SUBDIR}/周杰伦 - 晴天.flac`), true, '暂存文件还在')
  assert.equal(host.files.has(`${host.targetDir}/周杰伦 - 晴天.flac`), false, '目标目录还没有文件')

  const decision = await recoverPumpJob(host.ctx, beforeMove)
  assert.equal(decision.action, 'resume')

  // 宿主按 resume 重跑：copying 残留只重试入库，不重新下载。
  failMoveFor.clear()
  const httpBefore = host.calls.http.length
  const again = await runPumpJob(host.ctx)
  assert.deepEqual(again.completed, [task.id])
  assert.equal(host.calls.http.length, httpBefore, 'resume 重跑不重新下载')
  assert.equal(host.files.has(`${host.targetDir}/周杰伦 - 晴天.flac`), true, '文件最终在目标目录')

  // 目标与暂存都没有（文件丢了）→ 无法确认 → attention。
  host.files.delete(`${host.targetDir}/周杰伦 - 晴天.flac`)
  const empty = await recoverPump(host.ctx, { ...beforeMove, staging_path: `${STAGING_SUBDIR}/ghost.flac` })
  assert.equal(empty.action, 'attention')
})

test('中断在入库之后：大小一致 → complete；大小不一致 → attention；文件不在 → resume', async () => {
  const host = makeHost()
  const target = `${host.targetDir}/周杰伦 - 晴天.flac`
  host.files.set(target, 4321)
  const checkpoint = {
    stage: 'after-move', task_ref: 't', song_id: 'a1', out_name: '周杰伦 - 晴天.flac',
    target_path: target, size: 4321,
  }
  assert.equal((await recoverPump(host.ctx, checkpoint)).action, 'complete')
  const mismatch = await recoverPump(host.ctx, { ...checkpoint, size: 999 })
  assert.equal(mismatch.action, 'attention')
  host.files.delete(target)
  assert.equal((await recoverPump(host.ctx, checkpoint)).action, 'resume')
})

test('中断在暂存下载之后：目标在 → complete；暂存在 → resume（继续入库）；都没有 → attention', async () => {
  const host = makeHost()
  const target = `${host.targetDir}/周杰伦 - 晴天.flac`
  const staged = `${STAGING_SUBDIR}/周杰伦 - 晴天.flac`
  const checkpoint = {
    stage: 'after-download', task_ref: 't', song_id: 'a1', out_name: '周杰伦 - 晴天.flac',
    target_path: target, staging_path: staged, direct: false,
  }
  // 都没有 → attention。
  assert.equal((await recoverPump(host.ctx, checkpoint)).action, 'attention')
  // 暂存在 → 继续入库 → resume。
  host.files.set(staged, 4321)
  assert.equal((await recoverPump(host.ctx, checkpoint)).action, 'resume')
  // 目标在（宿主其实已完成入库）→ complete。
  host.files.delete(staged)
  host.files.set(target, 4321)
  assert.equal((await recoverPump(host.ctx, checkpoint)).action, 'complete')
})

test('无检查点：按 KV 队列的在途任务判定；队列读不到 → attention', async () => {
  // 队列空 → 没有外部写可核对 → complete。
  const idle = makeHost()
  assert.equal((await recoverPump(idle.ctx, null)).action, 'complete')
  // 有 copying 在途 → resume。
  const busy = makeHost()
  const { task } = await seedEnqueued(busy)
  const kv = createKv(busy.ctx)
  const stored = await loadTask(kv, task.id)
  stored.status = 'copying'
  stored.staged_path = `${STAGING_SUBDIR}/周杰伦 - 晴天.flac`
  await persistTask(kv, stored)
  assert.equal((await recoverPump(busy.ctx, undefined)).action, 'resume')
  // 队列读不到 → attention。
  const broken = makeHost()
  broken.ctx.storage.get = async () => { const e = new Error('boom'); e.status = 500; throw e }
  assert.equal((await recoverPump(broken.ctx, null)).action, 'attention')
})

test('目标目录不可读（exists 抛错）→ attention，不猜', async () => {
  const host = makeHost({ filesBroken: true })
  await seedEnqueued(host)
  const decision = await recoverPump(host.ctx, {
    stage: 'before-download', task_ref: 't', song_id: 'a1', out_name: '周杰伦 - 晴天.flac',
    target_path: `${host.targetDir}/周杰伦 - 晴天.flac`,
  })
  assert.equal(decision.action, 'attention')
})

test('queue-pump（周期任务）recover 落 attention 收敛为 resume，不让 5 分钟调度停摆', async () => {
  const host = makeHost({ filesBroken: true })
  const checkpoint = {
    stage: 'before-download', task_ref: 't', song_id: 'a1', out_name: '周杰伦 - 晴天.flac',
    target_path: `${host.targetDir}/周杰伦 - 晴天.flac`,
  }
  // recoverPump 本体如实三态：目标目录读不到 → attention。
  assert.equal((await recoverPump(host.ctx, checkpoint)).action, 'attention')
  // 周期 job 壳收敛为 resume：不允许重叠的任务停在「需要核对」就没人能解开。
  assert.equal((await recoverPumpJob(host.ctx, checkpoint)).action, 'resume')
})

test('未知阶段（旧词表 pump）→ resume，沿用既有幂等残留恢复', async () => {
  const host = makeHost()
  assert.equal((await recoverPump(host.ctx, { stage: 'pump' })).action, 'resume')
  assert.equal((await recoverPump(host.ctx, { stage: 'somewhere-else' })).action, 'resume')
})

// ─────────────────────── complete 之后 KV 队列收敛 ───────────────────────

test('直写落盘后、persistTask(done) 前中断：recover complete 同时把 KV 任务收敛为 done，下一轮 pump 不再误报', async () => {
  const host = makeHost()
  const { task } = await seedEnqueued(host)
  // 摆成窗口态：save_to 已把文件写进目标目录，但 KV 还停在 downloading。
  const target = `${host.targetDir}/周杰伦 - 晴天.flac`
  const kv = createKv(host.ctx)
  const stored = await loadTask(kv, task.id)
  stored.status = 'downloading'
  stored.out_name = '周杰伦 - 晴天.flac'
  await persistTask(kv, stored)
  host.files.set(target, 4321)

  // 中断时的检查点 = before-download（写前检查点），目标文件已在 → complete。
  const decision = await recoverPumpJob(host.ctx, {
    stage: 'before-download', task_ref: 't', song_id: task.id, out_name: '周杰伦 - 晴天.flac',
    target_path: target, staging_path: `${STAGING_SUBDIR}/${task.id}.part`,
  })
  assert.equal(decision.action, 'complete')

  // KV 已收敛：分片与索引都是 done，下一轮 pump 不重排、不误报、不发失败通知。
  const settled = await loadTask(kv, task.id)
  assert.equal(settled.status, 'done')
  assert.equal(settled.error, '')
  assert.equal(settled.staged_path, target, 'staged_path 指向文件真实去向')
  const index = host.kvStore.get('tasks.idx').value
  assert.equal(index.find((entry) => entry.id === task.id).status, 'done')

  const httpBefore = host.calls.http.length
  const summary = await runPumpJob(host.ctx)
  assert.deepEqual(summary.failed, [], '不把已入库的歌终态失败')
  assert.deepEqual(summary.completed, [])
  assert.equal(host.calls.notify.length, 0, '不发失败通知')
  assert.equal(host.calls.http.length, httpBefore, '不重新下载')
  assert.equal(host.files.has(target), true, '目标文件原样保留')
})

test('after-move 检查点后、persistTask(done) 前中断：recover complete 把 copying 残留收敛为 done', async () => {
  const host = makeHost()
  const { task } = await seedEnqueued(host)
  const target = `${host.targetDir}/周杰伦 - 晴天.flac`
  const kv = createKv(host.ctx)
  const stored = await loadTask(kv, task.id)
  stored.status = 'copying'
  stored.out_name = '周杰伦 - 晴天.flac'
  stored.staged_path = `${STAGING_SUBDIR}/周杰伦 - 晴天.flac`
  await persistTask(kv, stored)
  host.files.set(target, 4321)

  const decision = await recoverPumpJob(host.ctx, {
    stage: 'after-move', task_ref: 't', song_id: task.id, out_name: '周杰伦 - 晴天.flac',
    target_path: target, staging_path: `${STAGING_SUBDIR}/周杰伦 - 晴天.flac`, size: 4321,
  })
  assert.equal(decision.action, 'complete')
  const settled = await loadTask(kv, task.id)
  assert.equal(settled.status, 'done')
  assert.equal(settled.size, 4321, '记账字段按检查点补齐')
  assert.equal(host.kvStore.get('tasks.idx').value.find((entry) => entry.id === task.id).status, 'done')
})

test('complete 收敛只动在途任务：done 不重写，failed 不翻案，任务缺失静默跳过', async () => {
  const host = makeHost()
  const kv = createKv(host.ctx)
  const target = `${host.targetDir}/周杰伦 - 晴天.flac`
  host.files.set(target, 4321)
  // failed：失败通知已发过，recover 不把它改成 done。
  const failed = await seedEnqueued(host, { song_id: '111111' })
  const failedTask = await loadTask(kv, failed.task.id)
  failedTask.status = 'failed'
  failedTask.error = '历史失败'
  await persistTask(kv, failedTask)
  assert.equal((await recoverPump(host.ctx, {
    stage: 'before-download', song_id: failed.task.id, target_path: target,
  })).action, 'complete')
  assert.equal((await loadTask(kv, failed.task.id)).status, 'failed')
  assert.equal((await loadTask(kv, failed.task.id)).error, '历史失败')
  // done：幂等跳过（updated_ms 不变）。
  const done = await seedEnqueued(host, { song_id: '222222' })
  const doneTask = await loadTask(kv, done.task.id)
  doneTask.status = 'done'
  await persistTask(kv, doneTask)
  const before = doneTask.updated_ms
  assert.equal((await recoverPump(host.ctx, {
    stage: 'before-download', song_id: done.task.id, target_path: target,
  })).action, 'complete')
  assert.equal((await loadTask(kv, done.task.id)).updated_ms, before)
  // 分片缺失（任务已被清理）：不抛错，照常 complete。
  assert.equal((await recoverPump(host.ctx, {
    stage: 'before-download', song_id: 'ghost99', target_path: target,
  })).action, 'complete')
})
