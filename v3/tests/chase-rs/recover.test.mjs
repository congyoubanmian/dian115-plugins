// 中断恢复测试：sendPatch 的前后检查点 + recoverAlign 按订阅池真实状态判定三态。
// 覆盖「中断 → recover → 不重复执行外部写」：PATCH 已落地 → complete（不再重写）；
// PATCH 未落地 → resume（重跑受只增守卫保护，不会写同一个值）；读不到 → attention。
import test from 'node:test'
import assert from 'node:assert/strict'

import { runHourlyAlign, recoverAlign } from '../../chase-rs/jobs/runtime.js'
import { run as runAlignJob, recover as recoverAlignJob } from '../../chase-rs/jobs/align.js'
import { run as runAlignNowJob, recover as recoverAlignNowJob } from '../../chase-rs/jobs/align-now.js'
import { normalizeFlat } from '../../chase-rs/lib/settings.js'
import { newStateDoc } from '../../chase-rs/lib/state.js'

// ─────────────────────────── 假宿主 ───────────────────────────

/**
 * 内存宿主：订阅池是可变数组（PATCH 会真的改 total_episodes_known，模拟宿主落账）。
 * opts.patchStatus：PATCH 路由的应答码（默认 200；500 用来模拟「写请求失败」）。
 * opts.poolStatus：订阅池 GET 的应答码（500 用来模拟恢复时读不到真实状态）。
 */
function makeCtx({ patchStatus = 200, poolStatus = 200, settings = {}, seedState = null } = {}) {
  const pool = [
    { id: 41, tmdb_id: 1396, season: 5, media_type: 'tv', title: '绝命毒师', total_episodes_known: 10, state: 'partial' },
    { id: 42, tmdb_id: 1399, season: 1, media_type: 'tv', title: '权力的游戏', total_episodes_known: 5, state: 'caught_up' },
  ]
  const calls = []
  const patches = []
  const checkpoints = []
  const kv = new Map()
  if (seedState) kv.set('state', { value: seedState, revision: 1 })
  const id = 'chase.rs'
  const storagePath = `/api/extensions/v3/${id}/storage`

  async function handle(method, path, body) {
    calls.push([method, path])
    if (path === `${storagePath}/state`) {
      if (method === 'GET') {
        if (!kv.has('state')) {
          const error = new Error('not found')
          error.status = 404
          throw error
        }
        return { revision: kv.get('state').revision, value: kv.get('state').value }
      }
      if (method === 'PUT') {
        const current = kv.get('state')
        if (current && body.expected_revision !== undefined && body.expected_revision !== current.revision) {
          const error = new Error('revision conflict')
          error.status = 409
          throw error
        }
        const revision = (current?.revision ?? 0) + 1
        kv.set('state', { value: body.value, revision })
        return { revision }
      }
    }
    if (method === 'GET' && path.startsWith('/api/subscribe/pool/intents?')) {
      if (poolStatus >= 400) {
        const error = new Error(`HTTP ${poolStatus}`)
        error.status = poolStatus
        throw error
      }
      return { code: 'ok', data: pool.map((entry) => ({ ...entry })) }
    }
    if (method === 'PATCH' && path.startsWith('/api/subscribe/pool/intents/')) {
      const match = /\/api\/subscribe\/pool\/intents\/(\d+)\/episodes$/.exec(path)
      const entry = match ? pool.find((item) => item.id === Number(match[1])) : null
      patches.push({ path, body, applied: false })
      if (patchStatus >= 400) {
        const error = new Error(`HTTP ${patchStatus}`)
        error.status = patchStatus
        throw error
      }
      if (entry) {
        entry.total_episodes_known = body.total_episodes
        patches[patches.length - 1].applied = true
      }
      return {}
    }
    if (method === 'GET' && path === '/api/plugin-host/emby/instances') {
      return { items: [{ id: 3, name: '客厅', is_default: true, api_key_configured: true }] }
    }
    if (method === 'GET' && path.startsWith('/api/plugin-host/emby/episodes?')) {
      return { items: [{ index_number: 1 }, { index_number: 2 }, { index_number: 12 }], missing: [11], episode_count: 3 }
    }
    if (method === 'GET' && path === '/api/subscribe/air-calendar') {
      return { items: [] }
    }
    if (method === 'GET' && path.startsWith('/api/tmdb/tv/')) {
      return { id: 1396, name: '绝命毒师', number_of_episodes: 62, seasons: [{ season_number: 5, episode_count: 16 }, { season_number: 1, episode_count: 12 }] }
    }
    const error = new Error(`no route: ${method} ${path}`)
    error.status = 404
    throw error
  }

  return {
    id,
    pool,
    calls,
    patches,
    checkpoints,
    kv,
    api: {
      get: (path) => handle('GET', path),
      post: (path, body) => handle('POST', path, body),
      put: (path, body) => handle('PUT', path, body),
      patch: (path, body) => handle('PATCH', path, body),
    },
    settings: { get: async () => settings },
    notify: async () => ({ event: 'plugin_notification_message', accepted: true }),
    task: {
      id: 'run-recover-1',
      update: async () => {},
      log: async () => {},
      checkpoint: async (value) => { checkpoints.push(value) },
    },
  }
}

const SETTINGS = normalizeFlat({})

// ─────────────────────────── 检查点写入 ───────────────────────────

test('整点对齐：每次 PATCH 前后各写一条检查点，整轮结束再写 completed', async () => {
  const ctx = makeCtx()
  const result = await runAlignJob(ctx)
  assert.equal(result.status, 'accepted')
  assert.equal(ctx.patches.length, 2)
  const stages = ctx.checkpoints.map((entry) => entry.stage)
  assert.deepEqual(stages, [
    'before-patch-episodes', 'after-patch-episodes',
    'before-patch-episodes', 'after-patch-episodes',
    'completed',
  ], JSON.stringify(stages))
  // 写前检查点带业务定位字段 + task_ref + updated_at。
  const before = ctx.checkpoints[0]
  assert.equal(before.intent_id, 41)
  assert.equal(before.from_total, 10)
  assert.equal(before.to_total, 16)
  assert.equal(before.media_type, 'tv')
  assert.equal(before.task_ref, 'run-recover-1')
  assert.ok(before.updated_at !== '')
  // 写后检查点记录同一目标。
  const after = ctx.checkpoints[1]
  assert.equal(after.intent_id, 41)
  assert.equal(after.to_total, 16)
  // 整轮 completed 在最后，带结果。
  const completed = ctx.checkpoints[ctx.checkpoints.length - 1]
  assert.equal(completed.stage, 'completed')
  assert.equal(completed.result.patched, 2)
})

test('立即对齐：同样写前后检查点（job 壳入口）', async () => {
  // align-now 在全新安装 + 默认配置时不猜实例、全部跳过 —— 预置实例列表让它真正发 PATCH。
  const seeded = newStateDoc()
  seeded.emby_instances.push({ id: 3, name: '客厅', is_default: true, key_ready: true, at: '2026-10-01T00:00:00Z' })
  const ctx = makeCtx({ seedState: seeded })
  const result = await runAlignNowJob(ctx)
  assert.equal(result.patched, 2, JSON.stringify(result))
  const stages = ctx.checkpoints.map((entry) => entry.stage)
  assert.ok(stages.includes('before-patch-episodes') && stages.includes('after-patch-episodes'), JSON.stringify(stages))
  assert.equal(stages[stages.length - 1], 'completed')
})

// ─────────────────────────── recover 三态 ───────────────────────────

test('中断在 PATCH 之后（写已落地）→ complete，且 recover 自身零写请求', async () => {
  const ctx = makeCtx()
  await runHourlyAlign(ctx)
  assert.equal(ctx.patches.length, 2)
  const after = ctx.checkpoints.find((entry) => entry.stage === 'after-patch-episodes' && entry.intent_id === 41)
  assert.ok(after, '必须有 after-patch-episodes 检查点')
  const patchesBefore = ctx.patches.length
  const callsBefore = ctx.calls.length
  const decision = await recoverAlignJob(ctx, after)
  assert.equal(decision.action, 'complete')
  assert.equal(decision.result.status, 'succeeded')
  assert.equal(decision.result.intent_id, 41)
  assert.equal(decision.result.total_episodes, 16, '订阅池真实值')
  // recover 只读订阅池，绝不补发 PATCH。
  assert.equal(ctx.patches.length, patchesBefore)
  assert.ok(ctx.calls.length > callsBefore, 'recover 发起了核对读')
  assert.ok(ctx.calls.slice(callsBefore).every(([method]) => method !== 'PATCH'))
})

test('中断在 PATCH 之后但订阅池没到位（矛盾）→ attention', async () => {
  const ctx = makeCtx()
  // 手工构造：宿主回 200 但订阅池没抬（比如宿主侧回滚了）。
  const decision = await recoverAlign(ctx, {
    stage: 'after-patch-episodes',
    task_ref: 'run-x', intent_id: 41, from_total: 10, to_total: 16,
  })
  assert.equal(decision.action, 'attention')
})

test('中断在 PATCH 之前（明确没写）→ resume，重跑只补一次、不重复写', async () => {
  const ctx = makeCtx({ patchStatus: 500 })
  await runHourlyAlign(ctx)
  const before = ctx.checkpoints.find((entry) => entry.stage === 'before-patch-episodes' && entry.intent_id === 41)
  assert.ok(before, 'PATCH 失败时检查点停在 before')
  assert.ok(!ctx.checkpoints.some((entry) => entry.stage === 'after-patch-episodes'))
  assert.equal(ctx.pool.find((entry) => entry.id === 41).total_episodes_known, 10, '订阅池没被写')

  const decision = await recoverAlignJob(ctx, before)
  assert.equal(decision.action, 'resume')

  // 宿主按 resume 重跑同一 job：只增守卫保证 intent 41 恰好补一次到 16。
  const retryCtx = makeCtx()
  retryCtx.pool.splice(0, retryCtx.pool.length, ...ctx.pool.map((entry) => ({ ...entry })))
  await runHourlyAlign(retryCtx)
  const applied41 = retryCtx.patches.filter((entry) => entry.applied && entry.path.endsWith('/41/episodes'))
  assert.equal(applied41.length, 1, '重跑对 intent 41 只落一次外部写')
  assert.equal(applied41[0].body.total_episodes, 16)
  assert.equal(retryCtx.pool.find((entry) => entry.id === 41).total_episodes_known, 16)
})

test('中断在 PATCH 之前但订阅池已到目标值（写其实落地了）→ complete', async () => {
  const ctx = makeCtx()
  ctx.pool.find((entry) => entry.id === 41).total_episodes_known = 16
  const decision = await recoverAlign(ctx, {
    stage: 'before-patch-episodes',
    task_ref: 'run-x', intent_id: 41, from_total: 10, to_total: 16,
  })
  assert.equal(decision.action, 'complete')
  assert.equal(decision.result.intent_id, 41)
})

test('恢复时订阅池读不到（HTTP 500 / 结构不认识）→ attention，不猜', async () => {
  const failing = makeCtx({ poolStatus: 500 })
  const decision = await recoverAlign(failing.ctx ?? failing, {
    stage: 'before-patch-episodes',
    task_ref: 'run-x', intent_id: 41, from_total: 10, to_total: 16,
  })
  assert.equal(decision.action, 'attention')
})

test('订阅池里查不到这条 intent / 无检查点 / 阶段未知 → attention', async () => {
  const ctx = makeCtx()
  // intent 不在池里：定位不到真实状态。
  const ghost = await recoverAlign(ctx, {
    stage: 'before-patch-episodes', task_ref: 'run-x', intent_id: 999, from_total: 3, to_total: 9,
  })
  assert.equal(ghost.action, 'attention')
  // 无检查点。
  assert.equal((await recoverAlign(ctx, null)).action, 'attention')
  assert.equal((await recoverAlign(ctx, undefined)).action, 'attention')
  // 阶段未知。
  assert.equal((await recoverAlign(ctx, { stage: 'somewhere' })).action, 'attention')
})

test('旧词表 completed → complete(result)；job 壳 recover 与 runtime 版一致', async () => {
  const ctx = makeCtx()
  const decision = await recoverAlignJob(ctx, { stage: 'completed', result: { patched: 2 } })
  assert.deepEqual(decision, { action: 'complete', result: { patched: 2 } })
  const same = await recoverAlignNowJob(ctx, { stage: 'completed', result: { patched: 1 } })
  assert.deepEqual(same, { action: 'complete', result: { patched: 1 } })
  assert.equal(SETTINGS.enabled, true, '夹具设置未被改动')
})

test('整点对齐（周期任务）recover 落 attention 收敛为 resume，不让每小时调度停摆', async () => {
  const failing = makeCtx({ poolStatus: 500 })
  const checkpoint = {
    stage: 'before-patch-episodes',
    task_ref: 'run-x', intent_id: 41, from_total: 10, to_total: 16,
  }
  // runtime 版仍如实三态：订阅池读不到 → attention。
  assert.equal((await recoverAlign(failing, checkpoint)).action, 'attention')
  // 整点 job 壳收敛为 resume：不允许重叠的周期任务停在「需要核对」就没人能解开。
  assert.equal((await recoverAlignJob(failing, checkpoint)).action, 'resume')
  // align-now 是页面手动入口，保留三态原样透传。
  assert.equal((await recoverAlignNowJob(failing, checkpoint)).action, 'attention')
})
