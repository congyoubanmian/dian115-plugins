// 编排层端到端测试：用假宿主 ctx 跑刷新/想看/订阅/守卫/动作全链路，
// 对照 plugins/douban-rs/src/{runtime.rs,charts.rs,wish.rs,subscribe.rs} 内嵌测试的核心不变量。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Session, observeRemove, blacklistAdd, blacklistRemove, archive, noResubClear, settingsUpdate, openSource } from '../../douban-rs/jobs/runtime.js'
import { refreshNow } from '../../douban-rs/jobs/charts.js'
import { runWishSyncJob, syncWishList } from '../../douban-rs/jobs/wish.js'
import { processDue, subscribeQueueItem, subscribeQueueNow, subscribeFromSnapshot } from '../../douban-rs/jobs/subscribe-engine.js'
import { getPoster } from '../../douban-rs/jobs/poster.js'
import { parseStateDoc, defaultSettings } from '../../douban-rs/lib/model.js'
import { setFixedNow } from '../../douban-rs/lib/clock.js'

const readFixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
const CHART_HTML = readFixture('chart_listcont2.html')
const COMING_HTML = readFixture('coming_showing_soon.html')
const SUBJECTS_JSON = readFixture('search_subjects.json')
const STATE_RAW = JSON.parse(readFixture('state_val.json'))
const WISH_MOVIE = readFixture('wish_movie.json')
const WISH_TV = readFixture('wish_tv.json')
const SUBJECT_DETAIL_TV = readFixture('subject_detail_tv.json')

const FIXED_NOW = 1_790_676_009_000_000_000
const NOW_ISO = '2026-09-29T10:00:09Z'

// ─────────────────────────── 假宿主 ───────────────────────────

/**
 * 最小内存宿主：业务 API 路由 + 插件存储 KV（revision 乐观锁）+ 设置 + 出站 http 路由
 * + CookieCloud 快照 + 通知捕获。
 * apiRoutes: [{method, match(path), data, status}]
 * httpRoutes: [{match(url), text, status, bytes}]（text 优先于 bytes）
 */
function makeCtx({ apiRoutes = [], httpRoutes = [], settings = {}, storage = {} } = {}) {
  const apiCalls = []
  const httpCalls = []
  const notifies = []
  const kv = new Map(Object.entries(storage))
  const id = 'douban.rs'
  const storageBase = `/api/extensions/v3/${id}/storage`

  async function apiHandle(method, path, body) {
    apiCalls.push({ method, path, body })
    // 插件存储端点（Session / persistFlatSettings 走这里）
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
    const route = apiRoutes.find((candidate) => candidate.method === method && candidate.match(path))
    if (!route) {
      const error = new Error(`no api route: ${method} ${path}`)
      error.status = 404
      throw error
    }
    if ((route.status ?? 200) >= 400) {
      const error = new Error(route.message ?? `HTTP ${route.status}`)
      error.status = route.status
      error.data = route.data
      throw error
    }
    return typeof route.data === 'function' ? route.data(body) : route.data
  }

  async function httpHandle(options) {
    httpCalls.push(options)
    const route = httpRoutes.find((candidate) => candidate.match(options.url))
    if (!route) return { status: 404, headers: {}, body_base64: Buffer.from('not found').toString('base64') }
    const status = route.status ?? 200
    if (status >= 400) return { status, headers: {}, body_base64: Buffer.from(route.text ?? '').toString('base64') }
    const raw = route.bytes ?? Buffer.from(route.text ?? '', 'utf8')
    return { status, headers: route.headers ?? {}, body_base64: raw.toString('base64') }
  }

  return {
    id,
    apiCalls,
    httpCalls,
    notifies,
    kv,
    api: {
      get: (path) => apiHandle('GET', path),
      post: (path, body) => apiHandle('POST', path, body),
      put: (path, body) => apiHandle('PUT', path, body),
      patch: (path, body) => apiHandle('PATCH', path, body),
    },
    http: { request: (options) => httpHandle(options) },
    settings: { get: async () => settings },
    notify: async (payload) => {
      notifies.push(payload)
      return { event: 'plugin_notification_message', accepted: true, deliveries: [{ channel: 'telegram', status: 'sent' }] }
    },
    sleep: async () => {},
    task: { id: 'run-test-1', update: async () => {}, checkpoint: async () => {}, log: async () => {} },
  }
}

/** 打开会话并固定时钟；opts.state 预置 state 键，opts.settings 预置 settings 键。 */
async function openSession(ctx, { state = null, settingsKv = null, settingsInput = {} } = {}) {
  if (state !== null) ctx.kv.set('state', { value: state, revision: 1 })
  if (settingsKv !== null) ctx.kv.set('settings', { value: settingsKv, revision: 1 })
  const originalGet = ctx.settings.get
  ctx.settings.get = async () => settingsInput
  setFixedNow(FIXED_NOW)
  return Session.open(ctx)
}

// ─────────────────────────── 会话三态与账号键 ───────────────────────────

test('会话三态：loaded / fresh / unavailable，unavailable 禁止落盘', async () => {
  // loaded
  let ctx = makeCtx()
  let session = await openSession(ctx, { state: STATE_RAW })
  assert.equal(session.loadedKind, 'loaded')
  assert.ok(session.persistAllowed)
  assert.equal(Object.keys(session.doc.settings.lists).length, 5)
  assert.equal(session.doc.queue.items.length, 109)
  await session.trace('load', { state_result: session.loadedKind })

  // fresh（404 两次确认）
  ctx = makeCtx()
  session = await openSession(ctx)
  assert.equal(session.loadedKind, 'fresh')
  assert.ok(session.persistAllowed)
  assert.equal(Object.keys(session.doc.settings.lists).length, 5, '默认榜单')
  const puts = ctx.apiCalls.filter((call) => call.method === 'PUT' && call.path.endsWith('/storage/state'))
  assert.equal(puts.length, 0, '加载本身不写 state 键（只写 diag 面包屑）')
  const diagPuts = ctx.apiCalls.filter((call) => call.method === 'PUT' && call.path.endsWith('/storage/diag'))
  assert.equal(diagPuts.length, 1)

  // unavailable：存储读取抛 500
  ctx = makeCtx()
  ctx.api.get = async (path) => {
    if (path.includes('/storage/')) {
      const error = new Error('boom')
      error.status = 500
      throw error
    }
    const error = new Error('no route')
    error.status = 404
    throw error
  }
  session = await Session.open(ctx)
  assert.equal(session.loadedKind, 'unavailable')
  assert.ok(!session.persistAllowed)
  const outcome = await session.persist()
  assert.ok(outcome.skipped, '不可读期间禁止落盘')
  assert.ok(
    (session.doc.logs ?? []).some((entry) => entry.message.includes('宿主存储持续不可读')),
    '必须留下警告日志',
  )
})

test('foreign 文档拒绝落盘（避免默认值覆盖未知内容）', async () => {
  const ctx = makeCtx()
  const session = await openSession(ctx, { state: { unexpected: true } })
  assert.equal(session.loadedKind, 'foreign')
  const outcome = await session.persist()
  assert.ok(outcome.skipped)
  assert.ok(
    (session.doc.logs ?? []).some((entry) => entry.message.includes('宿主存储内容无法识别')),
  )
})

test('账号键只覆盖非空字段', async () => {
  const ctx = makeCtx()
  ctx.kv.set('account', {
    value: { manual_cookie: 'dbcl2=123456789:token', wish_sync_enabled: false },
    revision: 1,
  })
  const session = await openSession(ctx, { state: STATE_RAW })
  assert.equal(session.doc.settings.manual_cookie, 'dbcl2=123456789:token')
  assert.ok(session.doc.settings.wish_sync_enabled, 'false 不能把 true 覆盖掉')
})

// ─────────────────────────── 前台刷新（deep=false） ───────────────────────────

function chartHttpRoutes() {
  return [
    { match: (url) => url.startsWith('https://movie.douban.com/j/search_subjects?'), text: SUBJECTS_JSON },
    { match: (url) => url.startsWith('https://movie.douban.com/chart'), text: CHART_HTML },
    { match: (url) => url.startsWith('https://movie.douban.com/cinema/later/'), text: COMING_HTML },
  ]
}

/** 与旧 charts.rs 测试的 refresh_settings 对齐：3 个启用榜单（成本 1 < 2 < 3）。 */
function refreshSettings() {
  const settings = defaultSettings()
  settings.lists = {
    upcoming: { source: 'coming_html', type: 'movie', tag: '', sort: '', limit: 20, enabled: true },
    movie_wom: { source: 'chart_html', type: 'movie', tag: '', sort: '', limit: 20, enabled: true },
    hot: { source: 'subjects_json', type: 'movie', tag: '热门', sort: 'recommend', limit: 30, enabled: true },
  }
  return { ...settings, observe_period_hours: 24, max_logs: 200 }
}

test('前台刷新：按成本抓 3 榜 → 快照 → 黑名单入队 → 摘要；不订阅不问 TMDB', async () => {
  const ctx = makeCtx({
    httpRoutes: chartHttpRoutes(),
    settings: { observe_period_hours: 24, max_logs: 200, auto_subscribe: false, wish_sync_enabled: false },
  })
  const session = await openSession(ctx, { settingsInput: ctx.settingsFallback })
  session.doc.settings = refreshSettings()
  const result = await refreshNow(session, ctx, 'inv_front', { deep: false })

  // 快照：3 个启用的榜单
  const lists = session.doc.snapshot.lists
  assert.equal(Object.keys(lists).length, 3)
  assert.equal(lists.hot.length, 6)
  assert.equal(lists.movie_wom.length, 10)
  assert.equal(lists.upcoming.length, 6)
  assert.equal(session.doc.snapshot.fetched_at, NOW_ISO)
  assert.equal(session.doc.last_run, NOW_ISO)

  // 入队：22 条抓取结果里 2 条与更早的榜单同 ref → 去重后 20 条
  const queued = session.doc.queue.items
  assert.equal(queued.length, 20)
  assert.equal(new Set(queued.map((item) => item.douban_ref)).size, 20)
  assert.ok(queued.every((item) => item.state === 'observing' && item.attempt === 0))
  assert.ok(queued.every((item) => item.due_at === '2026-09-30T10:00:09Z'), 'due = now + 24h')
  assert.equal(queued[0].list, 'upcoming')
  assert.equal(queued[0].douban_ref, 'db:subj:36828393')
  assert.equal(queued[19].list, 'movie_wom')
  assert.equal(queued[19].douban_ref, 'db:subj:37002986')

  // 摘要：前台不订阅
  const messages = (session.doc.logs ?? []).map((entry) => entry.message)
  assert.ok(messages.includes('榜单刷新完成：3 榜，新增订阅 0，待人工确认 0；订阅由后台任务处理'), messages.join(' | '))

  // 出站：只有 3 次页面 GET，带防盗链头；无 TMDB/订阅池请求
  assert.equal(ctx.httpCalls.length, 3)
  for (const call of ctx.httpCalls) {
    assert.equal(call.headers.referer, 'https://movie.douban.com/')
    assert.ok(String(call.headers['user-agent']).includes('Chrome/126'))
  }
  assert.equal(ctx.apiCalls.filter((call) => call.path.startsWith('/api/tmdb/')).length, 0)
  assert.ok(result.ok)

  // 落盘
  assert.ok(ctx.kv.has('state'), '必须落过盘')
})

test('黑名单命中记入 blackstate 并跳过入队', async () => {
  const ctx = makeCtx({ httpRoutes: chartHttpRoutes(), settings: { wish_sync_enabled: false } })
  const session = await openSession(ctx, { settingsInput: {} })
  session.doc.settings = refreshSettings()
  session.doc.settings.blacklist = ['兽']
  await refreshNow(session, ctx, 'inv_front', { deep: false })
  assert.equal(session.doc.blackstate.hits, 1, '快照里只有《野兽之心》命中')
  assert.equal(session.doc.blackstate.recent[0].title, '野兽之心')
  assert.ok(!session.doc.queue.items.some((item) => item.douban_ref === 'db:subj:36828393'))
})

test('已订阅过的 ref 跳过入队（历史成功）', async () => {
  const ctx = makeCtx({ httpRoutes: chartHttpRoutes(), settings: { wish_sync_enabled: false } })
  const session = await openSession(ctx, { settingsInput: {} })
  session.doc.settings = refreshSettings()
  const upcoming = session.doc.snapshot.lists?.upcoming
  void upcoming
  // 先构造历史：把 hot 榜第一条当作已成功订阅
  session.doc.history = [{ douban_ref: 'db:subj:36850814', action: 'subscribe', result: 'succeeded', created_at: NOW_ISO }]
  await refreshNow(session, ctx, 'inv_front', { deep: false })
  assert.ok(!session.doc.queue.items.some((item) => item.douban_ref === 'db:subj:36850814'))
})

// ─────────────────────────── 想看同步 ───────────────────────────

function wishHttpRoutes() {
  return [
    { match: (url) => url.includes('/interests?kind=mark&type=movie'), text: WISH_MOVIE },
    { match: (url) => url.includes('/interests?kind=mark&type=tv'), text: WISH_TV },
  ]
}


function wishCtx(extra = {}) {
  return makeCtx({
    httpRoutes: wishHttpRoutes(),
    settings: { wish_sync_enabled: true, auto_subscribe: false, observe_period_hours: 5 },
    ...extra,
  })
}

async function openWishSession(ctx) {
  const session = await openSession(ctx, { settingsInput: { wish_sync_enabled: true, auto_subscribe: false, observe_period_hours: 5 } })
  // 预热解密缓存（douban_cookie 走缓存路径，不重复拉 CookieCloud）
  session.doc.cookie = { header: 'dbcl2=123456789:testToken; ck=testCk', uid: '123456789', source: 'manual', fetched_at: NOW_ISO }
  return session
}

test('想看同步：movie+tv 去重入队，due = now + 观察期；二次同步不重复', async () => {
  const ctx = wishCtx()
  const session = await openWishSession(ctx)
  const result = await syncWishList(session, ctx, 'invocation_0001', { deep: false })
  assert.ok(result.done)

  const info = session.doc.wish_info
  assert.equal(info.last_status, 'succeeded')
  assert.equal(info.uid, '123456789')
  assert.equal(info.source, 'manual')
  assert.equal(info.last_sync, NOW_ISO)
  assert.deepEqual([info.last_count, info.last_new], [3, 3])

  assert.equal(session.doc.wish.length, 3, 'movie+tv 重叠的 3 条被去重')
  assert.equal(session.doc.wish_seen ? Object.keys(session.doc.wish_seen).length : 0, 3)

  const queue = session.doc.queue.items
  assert.equal(queue.length, 3)
  assert.equal(queue[0].douban_ref, '36808876')
  assert.equal(queue[0].list, 'wish')
  assert.equal(queue[0].state, 'observing')
  assert.equal(queue[0].entered_at, NOW_ISO)
  assert.equal(queue[0].due_at, '2026-09-29T15:00:09Z', '24h 观察期换成 5h')
  assert.equal(queue[0].url, 'https://www.douban.com/subject/36808876/')
  assert.equal(queue[0].rating > 0, true, '入队带评分')
  assert.ok(session.doc.queue.items.every((item) => item.media_type !== ''), '入队带类型')

  const messages = (session.doc.logs ?? []).map((entry) => entry.message)
  assert.ok(messages.includes('想看同步完成: 共 3 条, 新增 3 (已入观察队列)'), messages.join(' | '))

  // 第二次同步：都见过了 → 不新增、队列不重复
  await syncWishList(session, ctx, 'invocation_0001', { deep: false })
  assert.deepEqual([session.doc.wish_info.last_count, session.doc.wish_info.last_new], [3, 0])
  assert.equal(session.doc.queue.items.length, 3)
})

test('想看同步（自动订阅开）：due = now，后台接手立即订', async () => {
  const ctx = makeCtx({
    httpRoutes: wishHttpRoutes(),
    settings: { wish_sync_enabled: true, auto_subscribe: true },
  })
  const session = await openSession(ctx, { settingsInput: { wish_sync_enabled: true, auto_subscribe: true } })
  session.doc.cookie = { header: 'dbcl2=123456789:testToken; ck=testCk', uid: '123456789', source: 'manual', fetched_at: NOW_ISO }
  await syncWishList(session, ctx, 'invocation_0001', { deep: false })
  assert.equal(session.doc.queue.items[0].due_at, NOW_ISO)
})

test('过滤器与墓碑守卫在入队前生效', async () => {
  // min_rating = 8.7：奥德赛(8.6)与人生路不熟(5.8)被拦，只有南京照相馆(8.7)过线
  const ctx = wishCtx({ settings: { wish_sync_enabled: true, auto_subscribe: false, min_rating: 8.7 } })
  const session = await openSession(ctx, { settingsInput: { wish_sync_enabled: true, auto_subscribe: false, min_rating: 8.7 } })
  session.doc.cookie = { header: 'dbcl2=123456789:testToken; ck=testCk', uid: '123456789', source: 'manual', fetched_at: NOW_ISO }
  await syncWishList(session, ctx, 'invocation_0001', { deep: false })

  const queue = session.doc.queue.items
  assert.equal(queue.length, 1, '被滤掉的条目不进观察队列')
  assert.equal(queue[0].douban_ref, '36809864')
  assert.equal(queue[0].rating, 8.7)
  const messages = (session.doc.logs ?? []).map((entry) => entry.message)
  assert.ok(messages.includes('已过滤自动订阅：奥德赛（评分不足（8.6 < 8.7））'), messages.join(' | '))
  assert.ok(messages.includes('已过滤自动订阅：人生路不熟（评分不足（5.8 < 8.7））'))
  assert.deepEqual([session.doc.wish_info.last_count, session.doc.wish_info.last_new], [3, 3], '守卫只拦订阅/入队，不改想看统计')

  // 墓碑守卫：命中的条目不入队，记一条跳过日志；被拦条目已写 seen，再跑不重复记日志
  const ctx2 = wishCtx()
  const session2 = await openSession(ctx2, { settingsInput: { wish_sync_enabled: true, auto_subscribe: false } })
  session2.doc.cookie = { header: 'dbcl2=123456789:testToken; ck=testCk', uid: '123456789', source: 'manual', fetched_at: NOW_ISO }
  session2.doc.history = [{ douban_ref: '36809864', tmdb_ref: 'tmdb:movie:123', action: 'subscribe', result: 'succeeded', intent_id: 9, created_at: NOW_ISO }]
  session2.doc.no_resub = { '36809864': { tmdb_ref: 'tmdb:movie:123', intent_id: 9, at: NOW_ISO, reason: '宿主已无该 tmdb 订阅' } }
  await syncWishList(session2, ctx2, 'invocation_0001', { deep: false })
  assert.ok(!session2.doc.queue.items.some((item) => item.douban_ref === '36809864'), '墓碑命中的条目不入队')
  assert.equal(session2.doc.queue.items.length, 2, '另外两条不受影响')
  const messages2 = (session2.doc.logs ?? []).map((entry) => entry.message)
  assert.equal(messages2.filter((message) => message.includes('已删除不重订')).length, 1)
  await syncWishList(session2, ctx2, 'invocation_0001', { deep: false })
  assert.equal(
    (session2.doc.logs ?? []).filter((entry) => entry.message.includes('已删除不重订')).length,
    1,
    'seen 之后再不重复记墓碑日志',
  )
})

// ─────────────────────────── 工具 ───────────────────────────

function defaultQueueEntry(doubanRef, title) {
  return {
    douban_ref: doubanRef,
    title,
    list: 'wish',
    poster_url: '',
    url: `https://www.douban.com/subject/${doubanRef}/`,
    tmdb_ref: '',
    media_type: '',
    year: '',
    rating: 0,
    poster_path: '',
    entered_at: NOW_ISO,
    due_at: NOW_ISO,
    state: 'observing',
    attempt: 0,
    last_error: '',
  }
}

// ─────────────────────────── 到期订阅（process_due / do_subscribe） ───────────────────────────

function subscribeApiRoutes() {
  return [
    {
      method: 'GET',
      match: (path) => path.startsWith('/api/tmdb/search'),
      data: { results: [{ id: 11, title: '奥德赛', media_type: 'movie', vote_average: 7.5 }] },
    },
    { method: 'GET', match: (path) => path.startsWith('/api/subscribe/pool/intents'), data: { code: 'ok', data: [], counts: {} } },
    { method: 'POST', match: (path) => path === '/api/subscribe/pool/intents', data: { code: 'ok', data: { id: 171 } } },
  ]
}

test('process_due：到期条目走 TMDB 匹配 + 聚合订阅 + 历史；未到期保留', async () => {
  const ctx = makeCtx({ apiRoutes: subscribeApiRoutes(), settings: { notify_on_subscribe: true } })
  const session = await openSession(ctx, { settingsInput: { notify_on_subscribe: true } })
  session.doc.queue.items = [
    { ...defaultQueueEntry('36808876', '奥德赛'), due_at: '2026-09-28T10:00:00Z', rating: 8.6, media_type: 'movie' },
    { ...defaultQueueEntry('37247814', '还没到期的'), due_at: '2026-10-05T10:00:00Z' },
  ]
  const flat = { notify_on_subscribe: true }
  const outcome = await processDue(session, ctx, 'invocation_0002', flat)

  assert.deepEqual([outcome.subscribed, outcome.needs_review], [1, 0])
  assert.equal(ctx.apiCalls.filter((call) => call.method === 'POST').length, 1)
  const postBody = ctx.apiCalls.find((call) => call.method === 'POST').body
  assert.equal(postBody.tmdb_id, 11)
  assert.equal(postBody.media_type, 'movie')
  assert.equal(postBody.season, 0, '电影 season=0')
  assert.equal(postBody.episode_scope_mode, 'follow')

  assert.equal(session.doc.stats.total, 1)
  assert.equal(session.doc.stats.by_list.wish, 1)
  assert.equal(session.doc.history.length, 1)
  assert.equal(session.doc.history[0].intent_id, 171)
  assert.equal(session.doc.history[0].result, 'succeeded')
  // 旧语义：processDue 里已订阅的到期条目不再留在队列；未到期的原样保留
  assert.equal(session.doc.queue.items.length, 1)
  assert.equal(session.doc.queue.items[0].douban_ref, '37247814')
  assert.equal(session.doc.queue.items[0].state, 'observing')
  assert.equal(ctx.notifies.length, 1, 'notify_on_subscribe 开 → 发订阅通知')
})

test('process_due：置信不足 → 不留队列；TMDB 失败且 attempt < 3 → 保留 needs_review', async () => {
  // ① 置信不足（匹配不到）→ 到期条目不留队列
  let ctx = makeCtx({
    apiRoutes: [
      { method: 'GET', match: (path) => path.startsWith('/api/tmdb/search'), data: { results: [{ id: 5, title: '完全不相关的片子', media_type: 'movie', vote_average: 3 }] } },
      { method: 'GET', match: (path) => path.startsWith('/api/subscribe/pool/intents'), data: { code: 'ok', data: [], counts: {} } },
    ],
  })
  let session = await openSession(ctx)
  session.doc.queue.items = [{ ...defaultQueueEntry('36808876', '奥德赛'), due_at: '2026-09-28T10:00:00Z' }]
  let outcome = await processDue(session, ctx, 'invocation_0003', {})
  assert.deepEqual([outcome.subscribed, outcome.needs_review], [0, 1])
  assert.equal(session.doc.queue.items.length, 0, 'Go 语义：needs_review 的到期条目不再留在队列')

  // ② TMDB 搜索失败 + attempt < 3 → 保留为 needs_review（attempt 不自增）
  ctx = makeCtx({
    apiRoutes: [{ method: 'GET', match: (path) => path.startsWith('/api/tmdb/search'), status: 500 }],
  })
  session = await openSession(ctx)
  session.doc.queue.items = [{ ...defaultQueueEntry('11111111', '失败一次的'), due_at: '2026-09-28T10:00:00Z', attempt: 1 }]
  outcome = await processDue(session, ctx, 'invocation_0003', {})
  assert.deepEqual([outcome.subscribed, outcome.needs_review], [0, 1])
  assert.equal(session.doc.queue.items.length, 1)
  const kept = session.doc.queue.items[0]
  assert.equal(kept.douban_ref, '11111111')
  assert.equal(kept.state, 'needs_review')
  assert.equal(kept.attempt, 1, 'attempt 不自增（Go 同款）')
  assert.ok(kept.last_error.startsWith('TMDB 搜索失败:'))

  // ③ 失败 + attempt >= 3 → 丢弃并写 result: failed 的历史（不计统计）
  ctx = makeCtx({
    apiRoutes: [{ method: 'GET', match: (path) => path.startsWith('/api/tmdb/search'), status: 500 }],
  })
  session = await openSession(ctx)
  session.doc.queue.items = [{ ...defaultQueueEntry('dead', '奥德赛'), due_at: '2026-09-28T10:00:00Z', attempt: 3 }]
  outcome = await processDue(session, ctx, 'invocation_0003', {})
  assert.deepEqual([outcome.subscribed, outcome.needs_review], [0, 0])
  assert.equal(session.doc.queue.items.length, 0)
  assert.equal(session.doc.history[0].result, 'failed')
  assert.equal(session.doc.history[0].douban_ref, 'dead')
  assert.equal(session.doc.stats.total, 0, '失败历史不计入统计')

  // ④ 空队列：keep 是非 null 数组（Go 的非 nil 切片 → []）
  ctx = makeCtx({})
  session = await openSession(ctx)
  session.doc.queue.items = null
  await processDue(session, ctx, 'invocation_0003', {})
  assert.deepEqual(session.doc.queue.items, [])
})

test('process_due：被过滤/墓碑是终态，直接保留不重判', async () => {
  const ctx = makeCtx({})
  const session = await openSession(ctx)
  session.doc.queue.items = [
    { ...defaultQueueEntry('filtered-one', '被过滤的'), state: 'filtered', due_at: '2026-09-01T00:00:00Z' },
    { ...defaultQueueEntry('no-resub-one', '被墓碑的'), state: 'no_resub', due_at: '2026-09-01T00:00:00Z' },
    { ...defaultQueueEntry('review-one', '待确认的'), state: 'needs_review', due_at: '2026-09-01T00:00:00Z' },
  ]
  const outcome = await processDue(session, ctx, 'invocation_0004', {})
  assert.deepEqual([outcome.subscribed, outcome.needs_review], [0, 0])
  assert.equal(session.doc.queue.items.length, 3, '终态原样保留')
})

test('subscribe_from_snapshot：快照条目立即订阅（手动入口，不拦墓碑但带确认）', async () => {
  const ctx = makeCtx({
    apiRoutes: [
      // TMDB 搜索按快照条目标题《罗斯》返回命中
      { method: 'GET', match: (path) => path.includes('q=%E7%BD%97%E6%96%AF'), data: { results: [{ id: 11, title: '罗斯', media_type: 'movie', vote_average: 7.5 }] } },
      { method: 'GET', match: (path) => path.startsWith('/api/subscribe/pool/intents'), data: { code: 'ok', data: [], counts: {} } },
      { method: 'POST', match: (path) => path === '/api/subscribe/pool/intents', data: { code: 'ok', data: { id: 171 } } },
    ],
  })
  const session = await openSession(ctx, { state: STATE_RAW })
  // 快照里的条目：movie_wom[0] = db:subj:35322132（罗斯）
  const found = Object.values(session.doc.snapshot.lists).flat().find((item) => item.douban_ref === 'db:subj:35322132')
  assert.ok(found, '夹具快照必须有该条目')
  session.doc.no_resub = { [found.douban_ref]: { tmdb_ref: 'tmdb:movie:1', intent_id: 1, at: NOW_ISO, reason: 'x' } }
  const result = await subscribeFromSnapshot(session, ctx, 'inv_5', found.douban_ref)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.intent_id, 171)
  assert.equal(result.no_resub_confirm, '该条目此前订阅过、现在已被你删除：自动订阅不会重订它，确认要手动订阅吗？')

  // 不存在的 ref
  const miss = await subscribeFromSnapshot(session, ctx, 'inv_5', 'db:subj:1')
  assert.deepEqual(miss, { status: 'failed', message: '榜单快照中未找到该条目' })
})

test('subscribe_queue_now：队列条目立即订阅；min_rating 拦下时标 filtered', async () => {
  const ctx = makeCtx({ apiRoutes: subscribeApiRoutes(), settings: { min_rating: 0 } })
  const session = await openSession(ctx, { settingsInput: { min_rating: 0 } })
  session.doc.queue.items = [{ ...defaultQueueEntry('36808876', '奥德赛'), due_at: '2026-10-01T00:00:00Z', rating: 8.6, media_type: 'movie' }]
  const ok = await subscribeQueueNow(session, ctx, 'inv_6', '36808876')
  assert.equal(ok.status, 'succeeded')
  assert.equal(ok.intent_id, 171)
  assert.equal(session.doc.queue.items[0].state, 'subscribed')

  // min_rating=9 → 过滤
  const ctx2 = makeCtx({ settings: { min_rating: 9 } })
  const session2 = await openSession(ctx2, { settingsInput: { min_rating: 9 } })
  session2.doc.queue.items = [{ ...defaultQueueEntry('36808876', '奥德赛'), rating: 8.6 }]
  const blocked = await subscribeQueueNow(session2, ctx2, 'inv_6', '36808876')
  assert.equal(blocked.status, 'failed')
  assert.equal(blocked.message, '评分不足（8.6 < 9.0）')
  assert.equal(session2.doc.queue.items[0].state, 'filtered')
})

test('匹配回退：直配失败 → rexxar 详情（aka）→ 命中', async () => {
  const ctx = makeCtx({
    apiRoutes: [
      // 直配"列奥纳多"不命中；aka 候选"莱昂纳多"命中
      { method: 'GET', match: (path) => path.includes('q=%E5%88%97%E5%A5%A5%E7%BA%B3%E5%A4%9A'), data: { results: [{ id: 9, title: '别的', media_type: 'tv', vote_average: 3 }] } },
      { method: 'GET', match: (path) => path.includes('q=%E8%8E%B1%E6%98%82%E7%BA%B3%E5%A4%9A'), data: { results: [{ id: 88, title: '莱昂纳多', media_type: 'tv', vote_average: 7.8 }] } },
      { method: 'GET', match: (path) => path.startsWith('/api/subscribe/pool/intents'), data: { code: 'ok', data: [], counts: {} } },
      { method: 'POST', match: (path) => path === '/api/subscribe/pool/intents', data: { code: 'ok', data: { id: 88 } } },
    ],
    httpRoutes: [
      { match: (url) => url === 'https://m.douban.com/rexxar/api/v2/tv/34862797', text: SUBJECT_DETAIL_TV },
    ],
  })
  const session = await openSession(ctx)
  const q = { ...defaultQueueEntry('34862797', '列奥纳多'), due_at: '2026-09-01T00:00:00Z', media_type: 'tv' }
  const outcome = await subscribeQueueItem(session, ctx, 'inv_7', q, {})
  assert.equal(outcome.status, 'succeeded')
  assert.equal(outcome.intent_id, 88)
  const messages = (session.doc.logs ?? []).map((entry) => entry.message)
  assert.ok(messages.some((message) => message.includes('TMDB 回退匹配: 列奥纳多 经 莱昂纳多 命中')), messages.join(' | '))
  assert.equal(ctx.apiCalls.filter((call) => call.method === 'POST')[0].body.season, 1, '剧集 season=1')
})

// ─────────────────────────── job wish-sync 编排 ───────────────────────────

test('job wish-sync：想看同步 + 到期订阅 + 墓碑判定 + 落盘，返回 accepted', async () => {
  const ctx = makeCtx({
    httpRoutes: wishHttpRoutes(),
    apiRoutes: [
      { method: 'GET', match: (path) => path.startsWith('/api/tmdb/search'), data: { results: [{ id: 11, title: '奥德赛', media_type: 'movie', vote_average: 7.5 }] } },
      // 墓碑判定：池里有同 (tmdb_id, media_type) 的订阅 → 不写墓碑
      { method: 'GET', match: (path) => path.startsWith('/api/subscribe/pool/intents'), data: { code: 'ok', data: [{ id: 171, tmdb_id: 11, media_type: 'movie', title: '奥德赛', state: 'pending' }], counts: {} } },
      { method: 'POST', match: (path) => path === '/api/subscribe/pool/intents', data: { code: 'ok', data: { id: 171 } } },
    ],
    settings: { wish_sync_enabled: true, auto_subscribe: true },
  })
  const session = await openSession(ctx, { state: STATE_RAW, settingsInput: { wish_sync_enabled: true, auto_subscribe: true } })
  session.doc.cookie = { header: 'dbcl2=123456789:testToken; ck=testCk', uid: '123456789', source: 'manual', fetched_at: NOW_ISO }
  // 历史：36808876 曾订阅成功（池里仍有）→ 不写墓碑
  session.doc.history = [{ douban_ref: '36808876', tmdb_ref: 'tmdb:movie:11', title: '奥德赛', action: 'subscribe', result: 'succeeded', intent_id: 171, created_at: NOW_ISO }]

  const result = await runWishSyncJob(session, ctx, 'invocation_0008')
  assert.deepEqual(result, { status: 'accepted', message: '想看与到期订阅已处理' })
  assert.equal(session.doc.wish_info.last_status, 'succeeded')
  assert.equal(session.doc.no_resub, null, '池里仍有订阅 → 不写墓碑')
  assert.equal(session.doc.no_resub_scan_at, NOW_ISO, '扫描时间已记录')
  assert.ok(ctx.kv.has('state'), '必须落盘')
})

test('墓碑判定：订阅消失 → 写墓碑；池被截断 → 跳过', async () => {
  // ① 池里查不到 → 写墓碑
  let ctx = makeCtx({
    apiRoutes: [{ method: 'GET', match: (path) => path.startsWith('/api/subscribe/pool/intents'), data: { code: 'ok', data: [], counts: {} } }],
  })
  let session = await openSession(ctx)
  session.doc.history = [{ douban_ref: '36808876', tmdb_ref: 'tmdb:movie:11', title: '奥德赛', action: 'subscribe', result: 'succeeded', intent_id: 171, created_at: NOW_ISO }]
  const added = await session.resolveNoResubFromHistory()
  assert.equal(added, 1)
  assert.ok(session.doc.no_resub['36808876'])
  assert.equal(session.doc.no_resub['36808876'].tmdb_ref, 'tmdb:movie:11')
  const messages = (session.doc.logs ?? []).map((entry) => entry.message)
  assert.ok(messages.some((message) => message.includes('墓碑记录：奥德赛（36808876）')), messages.join(' | '))

  // ② 已完成的订阅换了形态 → 不算删
  ctx = makeCtx({
    apiRoutes: [{ method: 'GET', match: (path) => path.startsWith('/api/subscribe/pool/intents'), data: { code: 'ok', data: [{ id: 172, tmdb_id: 11, media_type: 'tv', title: 'x', state: 'landed' }], counts: {} } }],
  })
  session = await openSession(ctx)
  session.doc.history = [{ douban_ref: '36808876', tmdb_ref: 'tmdb:movie:11', title: '奥德赛', action: 'subscribe', result: 'succeeded', intent_id: 171, created_at: NOW_ISO }]
  assert.equal(await session.resolveNoResubFromHistory(), 0)

  // ③ 池条数达上限（可能被截断）→ 跳过判定
  const bigPool = Array.from({ length: 200 }, (_, index) => ({ id: index, tmdb_id: index, media_type: 'movie', title: `x${index}`, state: 'pending' }))
  ctx = makeCtx({
    apiRoutes: [{ method: 'GET', match: (path) => path.startsWith('/api/subscribe/pool/intents'), data: { code: 'ok', data: bigPool, counts: {} } }],
  })
  session = await openSession(ctx)
  session.doc.history = [{ douban_ref: '36808876', tmdb_ref: 'tmdb:movie:11', title: '奥德赛', action: 'subscribe', result: 'succeeded', intent_id: 171, created_at: NOW_ISO }]
  assert.equal(await session.resolveNoResubFromHistory(), 0, '宁可漏判不可误判')
  assert.ok((session.doc.logs ?? []).some((entry) => entry.message.includes('可能被截断')))
})

// ─────────────────────────── 动作级测试 ───────────────────────────

test('observe-remove / blacklist-add / blacklist-remove / no-resub-clear / archive / open-source', async () => {
  const ctx = makeCtx()
  const session = await openSession(ctx, { state: STATE_RAW })
  const queueBefore = session.doc.queue.items.length

  // observe-remove：原地过滤
  const target = session.doc.queue.items[0].douban_ref
  assert.deepEqual(observeRemove(session, target), { status: 'succeeded', message: '已从观察队列移除' })
  assert.equal(session.doc.queue.items.length, queueBefore - 1)

  // blacklist-add：空关键词报错；成功后进 settings.blacklist；重复添加幂等
  assert.deepEqual(blacklistAdd(session, ''), { status: 'failed', message: '关键词不能为空' })
  assert.deepEqual(blacklistAdd(session, '烂片'), { status: 'succeeded', message: '已添加黑名单关键词：烂片' })
  assert.deepEqual(blacklistAdd(session, ' 烂片 '), { status: 'succeeded', message: '关键词已存在' }, 'trim 后重复')

  // blacklist-remove：不校验空关键词
  assert.deepEqual(blacklistRemove(session, ''), { status: 'succeeded', message: '已移除黑名单关键词：' })

  // open-source：先快照后队列
  assert.deepEqual(openSource(session, 'db:subj:36828393').status, 'succeeded')
  assert.equal(openSource(session, 'db:subj:missing').status, 'failed')

  // no-resub-clear：空墓碑集幂等
  assert.deepEqual(noResubClear(session), { status: 'succeeded', message: '已清除重订限制（0 条）' })
  session.doc.no_resub = { 'x': { tmdb_ref: '', intent_id: 0, at: '', reason: '' } }
  assert.deepEqual(noResubClear(session), { status: 'succeeded', message: '已清除重订限制（1 条）' })
  assert.equal(session.doc.no_resub, null)

  // archive：清历史/日志/黑名单命中，重置统计；不清墓碑
  session.doc.no_resub = { 'x': { tmdb_ref: '', intent_id: 0, at: '', reason: '' } }
  assert.deepEqual(archive(session), { status: 'succeeded', message: '已归档历史与日志' })
  assert.equal(session.doc.history, null)
  assert.equal(session.doc.logs, null)
  assert.equal(session.doc.blackstate.hits, 0)
  assert.equal(session.doc.stats.total, 0)
  assert.ok(session.doc.no_resub, '墓碑集跟着归档消失就会在下一轮自动重订')
})

test('settings-update：lists 合并保存、黑名单替换、账号字段变化作废 cookie 缓存', async () => {
  const ctx = makeCtx()
  const session = await openSession(ctx, { state: STATE_RAW })
  const before = session.doc.settings.lists.cn_wom

  const result = await settingsUpdate(session, {
    lists: { hot: { ...session.doc.settings.lists.hot, limit: 5 } },
    blacklist: ['烂片', '注水'],
    manual_cookie: '  dbcl2=123456789:token  ',
    wish_sync_enabled: true,
    observe_period_hours: 12,
    auto_subscribe: false,
    min_rating: 7.5,
    min_year: 2015,
    regions: ['日本', '美国'],
    subscribe_source_filter: ['wish'],
  })
  assert.equal(result.status, 'succeeded')

  // lists 合并：hot 更新，cn_wom 原样
  assert.equal(session.doc.settings.lists.hot.limit, 5)
  assert.deepEqual(session.doc.settings.lists.cn_wom, before)
  assert.equal(session.doc.settings.lists.upcoming.source, 'coming_html')
  assert.deepEqual(session.doc.settings.blacklist, ['烂片', '注水'])
  // 账号字段 trim
  assert.equal(session.doc.settings.manual_cookie, 'dbcl2=123456789:token')
  // cookie 缓存作废
  assert.deepEqual(session.doc.cookie, { header: '', uid: '', source: '', fetched_at: '' })
  // settings KV 已保存（扁平键）
  const savedSettings = ctx.kv.get('settings')?.value ?? {}
  assert.equal(savedSettings.observe_period_hours, 12)
  assert.equal(savedSettings.auto_subscribe, false)
  assert.equal(savedSettings.min_rating, 7.5)
  assert.equal(savedSettings.regions, '日本,美国')
  assert.ok(ctx.kv.has('account'), '账号字段变化要写账号键')
})

// ─────────────────────────── 海报动作 ───────────────────────────

test('get-poster：镜像回退 + dataURL 缓存', async () => {
  const jpeg = Buffer.alloc(64)
  jpeg[0] = 0xff
  jpeg[1] = 0xd8
  jpeg[2] = 0xff
  const ctx = makeCtx({
    httpRoutes: [
      { match: (url) => url.includes('img9.doubanio.com'), text: '<html>418</html>' },
      { match: (url) => url.includes('img3.doubanio.com'), bytes: jpeg },
    ],
  })
  const session = await openSession(ctx)
  const url = 'https://img9.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg'
  const result = await getPoster(session, ctx, { poster_url: url })
  assert.equal(result.status, 'succeeded')
  assert.ok(result.url.startsWith('data:image/jpeg;base64,'))
  // 命中缓存：不再发请求
  const callsAfterFirst = ctx.httpCalls.length
  const again = await getPoster(session, ctx, { poster_url: url })
  assert.equal(again.url, result.url)
  assert.equal(ctx.httpCalls.length, callsAfterFirst)
})

test('douban_cookie：只用手动 cookie；缺失或不含 dbcl2 → 报错', async () => {
  const { doubanCookie } = await import('../../douban-rs/jobs/cookie.js')
  // ① 没有任何手动 cookie
  let ctx = makeCtx({})
  let session = await openSession(ctx, { settingsInput: {} })
  assert.throws(() => doubanCookie(session), /未配置手动豆瓣 cookie/)

  // ② 手动 cookie 有效（会写进 45 分钟缓存）
  ctx = makeCtx({})
  session = await openSession(ctx, { settingsInput: { manual_cookie: '  dbcl2=123456789:manual; ck=m  ' } })
  const manual = await doubanCookie(session)
  assert.deepEqual(manual, { header: 'dbcl2=123456789:manual; ck=m', uid: '123456789', source: 'manual' })
  assert.equal(session.doc.cookie.uid, '123456789')

  // ③ 手动 cookie 里没有 dbcl2 → 报错
  ctx = makeCtx({})
  session = await openSession(ctx, { settingsInput: { manual_cookie: 'foo=bar' } })
  assert.throws(() => doubanCookie(session), /手动 cookie 里缺少 dbcl2/)
})

test('parseStateDoc 解析 STATE_RAW 夹具（会话层依赖）', () => {
  const doc = parseStateDoc(STATE_RAW)
  assert.ok(doc !== null && doc.settings.lists !== null)
  assert.equal(doc.queue.items.length, 109)
})
