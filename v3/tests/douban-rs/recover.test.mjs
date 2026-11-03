// 中断恢复测试：doSubscribe 的前后检查点 + recoverSubscribe 按宿主订阅池真实状态判定三态。
// 覆盖「中断 → recover → 不重复执行外部写」：订阅已创建 → complete（不再重复 POST）；
// 明确没创建 → resume（重跑受宿主去重读保护）；读不到 → attention。
import test from 'node:test'
import assert from 'node:assert/strict'

import { doSubscribe, recoverSubscribe, queryPoolIntent } from '../../douban-rs/jobs/subscribe-engine.js'
import { run as runSubscribeJob, recover as recoverSubscribeJob } from '../../douban-rs/jobs/subscribe.js'
import { recover as recoverRefreshChartsJob } from '../../douban-rs/jobs/refresh-charts.js'
import { recover as recoverWishSyncJob } from '../../douban-rs/jobs/wish-sync.js'
import { newStateDoc, newQueueItem } from '../../douban-rs/lib/model.js'

// ─────────────────────────── 假宿主 ───────────────────────────

/**
 * 内存宿主：订阅池是可变数组（POST 真的追加条目，模拟宿主落账）。
 * opts.postStatus：POST 创建订阅的应答码（500 用来模拟「写请求失败」）。
 * opts.poolStatus：订阅池 GET 的应答码（500 用来模拟恢复时读不到真实状态）。
 */
function makeCtx({ postStatus = 200, poolStatus = 200, state = null } = {}) {
  const pool = []
  let nextId = 501
  const apiCalls = []
  const posts = []
  const checkpoints = []
  const notifies = []
  const kv = new Map()
  if (state !== null) kv.set('state', { value: state, revision: 1 })
  const id = 'douban.rs'
  const storageBase = `/api/extensions/v3/${id}/storage`

  async function apiHandle(method, path, body) {
    apiCalls.push({ method, path, body })
    const storageMatch = /^\/api\/extensions\/v3\/[^/]+\/storage\/(.+)$/.exec(path)
    if (storageMatch) {
      const key = decodeURIComponent(storageMatch[1])
      if (method === 'GET') {
        if (!kv.has(key)) {
          const error = new Error('not found')
          error.status = 404
          throw error
        }
        return { revision: kv.get(key).revision, value: kv.get(key).value }
      }
      if (method === 'PUT') {
        const current = kv.get(key)
        if (current && body?.expected_revision !== undefined && body.expected_revision !== current.revision) {
          const error = new Error('revision conflict')
          error.status = 409
          throw error
        }
        const revision = (current?.revision ?? 0) + 1
        kv.set(key, { value: body.value, revision })
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
    if (method === 'POST' && path === '/api/subscribe/pool/intents') {
      posts.push({ body })
      if (postStatus >= 400) {
        const error = new Error(`HTTP ${postStatus}`)
        error.status = postStatus
        throw error
      }
      const created = { id: nextId++, tmdb_id: body.tmdb_id, media_type: body.media_type, title: body.title, state: 'pending' }
      pool.push(created)
      return { code: 'ok', data: { id: created.id } }
    }
    const error = new Error(`no api route: ${method} ${path}`)
    error.status = 404
    throw error
  }

  return {
    id,
    pool,
    apiCalls,
    posts,
    checkpoints,
    notifies,
    kv,
    api: {
      get: (path) => apiHandle('GET', path),
      post: (path, body) => apiHandle('POST', path, body),
      put: (path, body) => apiHandle('PUT', path, body),
      patch: (path, body) => apiHandle('PATCH', path, body),
    },
    http: { request: async () => { throw new Error('not used') } },
    settings: { get: async () => ({}) },
    storage: {
      get: async (key) => {
        const hit = kv.get(key)
        if (!hit) {
          const error = new Error('not found')
          error.status = 404
          throw error
        }
        return JSON.parse(JSON.stringify(hit.value))
      },
      set: async (key, value, expectedRevision) => {
        const hit = kv.get(key)
        if (expectedRevision !== undefined && hit && hit.revision !== expectedRevision) {
          const error = new Error('conflict')
          error.status = 412
          throw error
        }
        kv.set(key, { value: JSON.parse(JSON.stringify(value)), revision: (hit?.revision ?? 0) + 1 })
        return (hit?.revision ?? 0) + 1
      },
      remove: async (key) => { kv.delete(key) },
    },
    notify: async (payload) => { notifies.push(payload); return { accepted: true } },
    sleep: async () => {},
    task: {
      id: 'run-recover-2',
      update: async () => {},
      log: async () => {},
      checkpoint: async (value) => { checkpoints.push(value) },
    },
  }
}

/** doSubscribe 需要的最小会话桩（历史写入只收不验）。 */
function makeSession(queueItems = []) {
  return {
    doc: { queue: { items: queueItems }, settings: { subscribe_source_filter: [] } },
    history: [],
    addHistoryAndLog(entry) { this.history.push(entry) },
    log() {},
  }
}

const Q = { douban_ref: 'db:subj:100', title: '沙丘', list: 'hot', media_type: 'movie' }
const ITEM = { id: 77, media_type: 'movie', title: '沙丘', name: '', original_title: '', release_date: '2026-01-01', poster_path: '', backdrop_path: '', vote_average: 7 }

// ─────────────────────────── 检查点写入 ───────────────────────────

test('doSubscribe：创建订阅前后各写一条检查点（含定位字段）', async () => {
  const ctx = makeCtx()
  const session = makeSession()
  const outcome = await doSubscribe(session, ctx, 'inv-1', Q, ITEM, {})
  assert.equal(outcome.status, 'succeeded')
  assert.equal(outcome.intent_id, 501)
  assert.equal(ctx.pool.length, 1, '宿主订阅池里多了一条')
  const stages = ctx.checkpoints.map((entry) => entry.stage)
  assert.deepEqual(stages, ['before-create-intent', 'after-create-intent'], JSON.stringify(stages))
  const before = ctx.checkpoints[0]
  assert.equal(before.douban_ref, 'db:subj:100')
  assert.equal(before.tmdb_id, 77)
  assert.equal(before.media_type, 'movie')
  assert.equal(before.tmdb_ref, 'tmdb:movie:77')
  assert.equal(before.task_ref, 'run-recover-2')
  assert.ok(before.updated_at !== '')
  const after = ctx.checkpoints[1]
  assert.equal(after.intent_id, 501)
  assert.equal(after.tmdb_id, 77)
})

// ─────────────────────────── recover 三态 ───────────────────────────

test('中断在创建之后（订阅池里确实有了）→ complete，recover 零写请求', async () => {
  const ctx = makeCtx()
  await doSubscribe(makeSession(), ctx, 'inv-1', Q, ITEM, {})
  const after = ctx.checkpoints.find((entry) => entry.stage === 'after-create-intent')
  const postsBefore = ctx.posts.length
  const callsBefore = ctx.apiCalls.length
  const decision = await recoverSubscribe(ctx, after)
  assert.equal(decision.action, 'complete')
  assert.equal(decision.result.status, 'succeeded')
  assert.equal(decision.result.intent_id, 501)
  // recover 只读订阅池，绝不补发 POST。
  assert.equal(ctx.posts.length, postsBefore)
  assert.ok(ctx.apiCalls.length > callsBefore, 'recover 发起了核对读')
  assert.ok(ctx.apiCalls.slice(callsBefore).every((call) => call.method !== 'POST'))
})

test('中断在创建之后但订阅池查不到（自称成功却没落账）→ attention', async () => {
  const ctx = makeCtx()
  const decision = await recoverSubscribe(ctx, {
    stage: 'after-create-intent',
    task_ref: 'run-x', douban_ref: 'db:subj:100', tmdb_ref: 'tmdb:movie:77', tmdb_id: 77, media_type: 'movie', intent_id: 501,
  })
  assert.equal(decision.action, 'attention')
})

test('中断在创建之前（明确没创建）→ resume，重跑只建一次', async () => {
  const ctx = makeCtx({ postStatus: 500 })
  const outcome = await doSubscribe(makeSession(), ctx, 'inv-1', Q, ITEM, {})
  assert.equal(outcome.status, 'failed')
  const before = ctx.checkpoints.find((entry) => entry.stage === 'before-create-intent')
  assert.ok(before, 'POST 失败时检查点停在 before')
  assert.ok(!ctx.checkpoints.some((entry) => entry.stage === 'after-create-intent'))
  assert.equal(ctx.pool.length, 0, '订阅池没被写')

  const decision = await recoverSubscribe(ctx, before)
  assert.equal(decision.action, 'resume')

  // 宿主按 resume 重跑：创建成功且只建一条。
  const retryCtx = makeCtx()
  const again = await doSubscribe(makeSession(), retryCtx, 'inv-2', Q, ITEM, {})
  assert.equal(again.status, 'succeeded')
  assert.equal(retryCtx.posts.length, 1, '重跑只发一次创建请求')
  assert.equal(retryCtx.pool.length, 1)
})

test('中断在创建之前但订阅池已有同类订阅（宿主去重实际已建）→ complete', async () => {
  const ctx = makeCtx()
  ctx.pool.push({ id: 900, tmdb_id: 77, media_type: 'movie', title: '沙丘', state: 'pending' })
  const decision = await recoverSubscribe(ctx, {
    stage: 'before-create-intent',
    task_ref: 'run-x', douban_ref: 'db:subj:100', tmdb_ref: 'tmdb:movie:77', tmdb_id: 77, media_type: 'movie',
  })
  assert.equal(decision.action, 'complete')
  assert.equal(decision.result.intent_id, 900)
})

test('恢复时订阅池读不到（HTTP 500 / 结构不认识）→ attention，不猜', async () => {
  const failing = makeCtx({ poolStatus: 500 })
  const decision = await recoverSubscribe(failing, {
    stage: 'before-create-intent',
    task_ref: 'run-x', tmdb_id: 77, media_type: 'movie', tmdb_ref: 'tmdb:movie:77',
  })
  assert.equal(decision.action, 'attention')
})

test('批量入口（wish-sync / refresh-charts）：订阅池命中只代表最后一条 → resume', async () => {
  const ctx = makeCtx()
  ctx.pool.push({ id: 900, tmdb_id: 77, media_type: 'movie', title: '沙丘', state: 'pending' })
  const hit = await recoverSubscribe(ctx, {
    stage: 'after-create-intent', task_ref: 'run-x', tmdb_id: 77, media_type: 'movie', intent_id: 900,
  }, { batch: true })
  assert.equal(hit.action, 'resume')
})

test('周期入口（refresh-charts / wish-sync）recover 落 attention 收敛为 resume，手动 subscribe 保留三态', async () => {
  const failing = makeCtx({ poolStatus: 500 })
  const checkpoint = {
    stage: 'before-create-intent',
    task_ref: 'run-x', tmdb_id: 77, media_type: 'movie', tmdb_ref: 'tmdb:movie:77',
  }
  // 判定层如实三态：订阅池读不到 → attention。
  assert.equal((await recoverSubscribe(failing, checkpoint)).action, 'attention')
  // 周期 job（不允许重叠）的壳收敛为 resume：无人值守的调度不能停在「需要核对」。
  assert.equal((await recoverRefreshChartsJob(failing, checkpoint)).action, 'resume')
  assert.equal((await recoverWishSyncJob(failing, checkpoint)).action, 'resume')
  // subscribe 是页面手动入口，三态原样透传。
  assert.equal((await recoverSubscribeJob(failing, checkpoint)).action, 'attention')
})

test('无检查点：读插件状态里的非终态条目逐个查池', async () => {
  // 状态里有条目带 tmdb_ref 且池里已存在 → complete。
  const doc = newStateDoc()
  doc.queue.items = [{ ...newQueueItem(), douban_ref: 'db:subj:9', title: '三体', tmdb_ref: 'tmdb:tv:1234', media_type: 'tv', state: 'watching' }]
  const withHit = makeCtx({ state: JSON.parse(JSON.stringify(doc)) })
  withHit.pool.push({ id: 901, tmdb_id: 1234, media_type: 'tv', title: '三体', state: 'partial' })
  assert.equal((await recoverSubscribe(withHit, null)).action, 'complete')

  // 池里没有 → 明确没创建 → resume。
  const withMiss = makeCtx({ state: JSON.parse(JSON.stringify(doc)) })
  assert.equal((await recoverSubscribe(withMiss, undefined)).action, 'resume')

  // 全新安装（连状态都没有）→ 没有可核对的外部写 → resume。
  const fresh = makeCtx()
  assert.equal((await recoverSubscribe(fresh, null)).action, 'resume')

  // 状态读不到 → attention。
  const broken = makeCtx()
  broken.storage.get = async () => { const e = new Error('boom'); e.status = 500; throw e }
  broken.api.get = async (path) => { const e = new Error('boom'); e.status = 500; throw e }
  assert.equal((await recoverSubscribe(broken, null)).action, 'attention')
})

test('job 壳：subscribe 的 recover 走同一判定，run 结束补写 completed 检查点', async () => {
  const ctx = makeCtx()
  // 快照里没有该条目 → 订阅失败返回，但整轮跑完了 → completed 检查点带结果。
  const result = await runSubscribeJob(ctx, { douban_ref: 'db:subj:404' })
  assert.equal(result.status, 'failed')
  const completed = ctx.checkpoints.find((entry) => entry.stage === 'completed')
  assert.ok(completed, 'job 壳结束要写 completed 检查点')
  assert.deepEqual(completed.result, result)
  // completed 检查点 → complete(result)。
  const decision = await recoverSubscribeJob(ctx, completed)
  assert.deepEqual(decision, { action: 'complete', result })
  // 无检查点 → 与 recoverSubscribe 一致（全新安装 → resume）。
  assert.equal((await recoverSubscribeJob(ctx, null)).action, 'resume')
})

test('queryPoolIntent：与 hostIntentExists 不同，读不到时不按「不存在」处理', async () => {
  const ok = makeCtx()
  ok.pool.push({ id: 901, tmdb_id: 1234, media_type: 'tv', title: '三体', state: 'partial' })
  assert.deepEqual(await queryPoolIntent(ok, 1234, 'tv'), { ok: true, exists: true, id: 901 })
  assert.deepEqual(await queryPoolIntent(ok, 1, 'movie'), { ok: true, exists: false, id: 0 })
  const bad = makeCtx({ poolStatus: 503 })
  assert.deepEqual(await queryPoolIntent(bad, 1234, 'tv'), { ok: false, exists: false, id: 0 })
})
