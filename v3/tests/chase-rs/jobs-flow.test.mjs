// 编排层端到端测试：用假宿主 ctx 跑整点对齐 / 立即对齐 / 只读刷新，
// 对照 plugins/chase-rs/src/runtime.rs 内嵌测试的核心不变量。
import test from 'node:test'
import assert from 'node:assert/strict'

import { runAlignNow, runHourlyAlign, runRefresh } from '../../chase-rs/jobs/runtime.js'
import { newStateDoc } from '../../chase-rs/lib/state.js'
import { normalizeFlat } from '../../chase-rs/lib/settings.js'

// ─────────────────────────── 假宿主 ───────────────────────────

/**
 * 最小内存宿主：业务 API 路由 + 插件存储 KV（revision 乐观锁）+ 设置 + 通知捕获。
 * routes: [{method, match(path), data, status}]
 */
function makeCtx({ routes = [], settings = {}, storage = {}, failStorageRead = false } = {}) {
  const calls = []
  const patches = []
  const notifies = []
  const kv = new Map(Object.entries(storage))
  const id = 'chase.rs'
  const storagePath = `/api/extensions/v3/${id}/storage`

  async function handle(method, path, body) {
    // 插件存储端点（loadRuntimeState / persist 走这里）
    if (path === `${storagePath}/state`) {
      if (method === 'GET') {
        calls.push(['GET', path])
        if (failStorageRead) {
          const error = new Error('storage unavailable')
          error.status = 500
          throw error
        }
        if (!kv.has('state')) {
          const error = new Error('not found')
          error.status = 404
          throw error
        }
        return { revision: kv.get('state').revision, value: kv.get('state').value }
      }
      if (method === 'PUT') {
        calls.push(['PUT', path])
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
    // 业务路由
    const route = routes.find((candidate) => candidate.method === method && candidate.match(path))
    calls.push([method, path])
    if (!route) {
      const error = new Error(`no route: ${method} ${path}`)
      error.status = 404
      throw error
    }
    if (method === 'PATCH') patches.push({ path, body })
    if ((route.status ?? 200) >= 400) {
      const error = new Error(route.message ?? `HTTP ${route.status}`)
      error.status = route.status
      error.data = route.data
      throw error
    }
    return route.data
  }

  return {
    id,
    calls,
    patches,
    notifies,
    kv,
    api: {
      get: (path) => handle('GET', path),
      post: (path, body) => handle('POST', path, body),
      put: (path, body) => handle('PUT', path, body),
      patch: (path, body) => handle('PATCH', path, body),
    },
    settings: { get: async () => settings },
    notify: async (options) => {
      notifies.push(options)
      return { event: 'plugin_notification_message', accepted: true }
    },
    task: { update: async () => {}, checkpoint: async () => {}, log: async () => {} },
  }
}

// ─────────────────────────── 夹具（与 runtime.rs 测试一致） ───────────────────────────

// 注：41 订阅 5 集而 Emby 夹具已有到第 12 集 → 两条 tv 都是"有缺口"条目。
const INTENTS_BODY = {
  code: 'ok',
  data: [
    { id: 41, tmdb_id: 1396, season: 5, media_type: 'tv', title: '绝命毒师', total_episodes_known: 10, state: 'partial' },
    { id: 42, tmdb_id: 1399, season: 1, media_type: 'tv', title: '权力的游戏', total_episodes_known: 5, state: 'caught_up' },
    { id: 43, tmdb_id: 1, season: 1, media_type: 'movie', title: '电影', total_episodes_known: 1, state: 'pending' },
  ],
  counts: {},
}

const INSTANCES_BODY = { items: [{ id: 3, name: '客厅', is_default: true, api_key_configured: true }] }

const EPISODES_BODY = {
  items: [{ index_number: 1 }, { index_number: 2 }, { index_number: 12 }],
  missing: [11],
  episode_count: 3,
}

function calendarBody(today) {
  return {
    items: [
      { tmdb_id: 1396, season: 5, episode: 1, title: '绝命毒师', air_date: today, air_time: '12:00' },
    ],
  }
}

const TMDB_BODY = {
  id: 1396,
  name: '绝命毒师',
  number_of_episodes: 62,
  poster_path: '/poster.jpg',
  seasons: [{ season_number: 5, episode_count: 16 }],
}

function baseRoutes(today) {
  return [
    { method: 'GET', match: (path) => path.startsWith('/api/subscribe/pool/intents?'), data: INTENTS_BODY },
    { method: 'GET', match: (path) => path === '/api/plugin-host/emby/instances', data: INSTANCES_BODY },
    { method: 'GET', match: (path) => path.startsWith('/api/plugin-host/emby/episodes?'), data: EPISODES_BODY },
    { method: 'GET', match: (path) => path === '/api/subscribe/air-calendar', data: calendarBody(today) },
    { method: 'GET', match: (path) => path.startsWith('/api/tmdb/tv/'), data: TMDB_BODY },
    { method: 'PATCH', match: (path) => path.startsWith('/api/subscribe/pool/intents/'), data: {} },
  ]
}

const TODAY = new Date(Date.now() + 480 * 60_000).toISOString().slice(0, 10)

function baseCtx(extra = {}) {
  return makeCtx({
    routes: baseRoutes(TODAY),
    settings: normalizeFlat(extra.settings ?? {}),
    ...extra,
  })
}

function storedDoc(ctx) {
  assert.ok(ctx.kv.has('state'), '必须落过盘')
  return ctx.kv.get('state').value
}

// ─────────────────────────── 整点对齐 ───────────────────────────

test('整点对齐只增补订并逐条记录', async () => {
  const ctx = baseCtx()
  const result = await runHourlyAlign(ctx)
  assert.equal(result.status, 'accepted')
  assert.equal(result.patched, 2, JSON.stringify(result))

  assert.equal(ctx.patches.length, 2)
  assert.equal(ctx.patches[0].path, '/api/subscribe/pool/intents/41/episodes')
  // Emby 已有 12 集, TMDB 16 集, 订阅 10 集 → 抬到 16
  assert.deepEqual(ctx.patches[0].body, { total_episodes: 16 })

  // 第二条 (tmdb 1399 第 1 季): TMDB 夹具只有第 5 季 → 该季目标取不到, target=0,
  // 只按 Emby 缺口判定: 已有到第 12 集, 订阅 5 集 → 抬到 12。
  // (旧的"缺季回退整剧 62 集"会把它误判成抬升 57 集的元数据异常。)
  assert.equal(ctx.patches[1].path, '/api/subscribe/pool/intents/42/episodes')
  assert.deepEqual(ctx.patches[1].body, { total_episodes: 12 })

  const doc = storedDoc(ctx)
  assert.equal(doc.align.patched, 2)
  assert.equal(doc.align.matched, 2)
  assert.equal(doc.align.items.length, 2)
  assert.equal(doc.align.items[0].target_known, true)
  assert.equal(doc.align.items[0].target_upper, 16)
  assert.equal(
    doc.align.items[0].poster,
    'https://image.tmdb.org/t/p/w342/poster.jpg',
    '海报从同一份 TMDB 详情解析，写完整 w342 地址',
  )
  assert.equal(doc.posters.find((poster) => poster.tmdb_id === 1396).path, '/poster.jpg')
  const tmdbCalls = ctx.calls.filter(([method, path]) => method === 'GET' && path.startsWith('/api/tmdb/tv/'))
  assert.equal(tmdbCalls.length, 2, '海报与集数出自同一响应，不额外请求')
  assert.ok(tmdbCalls.every(([, path]) => path.includes('raw_episode_counts=true')))
  assert.equal(doc.align.items[1].target_known, false, '缺季目标记未知')
  assert.equal(doc.calendar.days.length, 1)
  assert.equal(doc.stats.tv_intents, 2, 'movie 不参与')
  assert.equal(doc.revision, 1)
  // 键名不得出现凭据模式
  const text = JSON.stringify(doc)
  assert.ok(!text.includes('api_key'), text.slice(0, 200))
})

test('整点对齐：目标命中缓存时首轮回填海报（不带 raw，最多 5 个）', async () => {
  const seeded = newStateDoc()
  seeded.emby_instances.push({ id: 3, name: '客厅', is_default: true, key_ready: true, at: '2026-10-01T00:00:00Z' })
  const freshAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  seeded.tmdb_targets.push(
    { tmdb_id: 1396, season: 5, episode_count: 16, at: freshAt },
    { tmdb_id: 1399, season: 1, episode_count: 10, at: freshAt },
  )
  const ctx = makeCtx({ routes: baseRoutes(TODAY), storage: { state: { value: seeded, revision: 1 } } })
  await runHourlyAlign(ctx)

  const tmdbCalls = ctx.calls.filter(([method, path]) => method === 'GET' && path.startsWith('/api/tmdb/tv/'))
  assert.deepEqual(
    tmdbCalls.map(([, path]) => path).sort(),
    ['/api/tmdb/tv/1396', '/api/tmdb/tv/1399'],
    '缓存命中不再取集数；海报回填只发不带 raw 的详情请求',
  )
  const doc = storedDoc(ctx)
  assert.ok(
    doc.align.items.every((item) => item.poster === 'https://image.tmdb.org/t/p/w342/poster.jpg'),
    JSON.stringify(doc.align.items),
  )
  assert.equal(doc.posters.length, 2)
})

test('整点对齐绝不写相等或更小的总数', async () => {
  const ctx = makeCtx({
    routes: [
      { method: 'GET', match: (path) => path.startsWith('/api/subscribe/pool/intents?'), data: INTENTS_BODY },
      { method: 'GET', match: (path) => path === '/api/plugin-host/emby/instances', data: INSTANCES_BODY },
      // Emby 只有 3 集, 订阅 10 集, TMDB 10 集 → 不该有任何 PATCH
      { method: 'GET', match: (path) => path.startsWith('/api/plugin-host/emby/episodes?'), data: { items: [{ index_number: 1 }, { index_number: 2 }, { index_number: 3 }] } },
      { method: 'GET', match: (path) => path === '/api/subscribe/air-calendar', data: calendarBody(TODAY) },
      { method: 'GET', match: (path) => path.startsWith('/api/tmdb/tv/'), data: { seasons: [{ season_number: 5, episode_count: 10 }, { season_number: 1, episode_count: 5 }] } },
    ],
  })
  const result = await runHourlyAlign(ctx)
  assert.equal(result.patched, 0, JSON.stringify(result))
  assert.equal(ctx.patches.length, 0, '只增: 相等或更小一律不发请求')
  const doc = storedDoc(ctx)
  assert.equal(doc.align.skipped, 2)
  assert.ok(doc.align.items.every((item) => item.action === 'skipped'))
})

test('存储不可用：整轮只读、绝不落盘', async () => {
  const ctx = makeCtx({ routes: baseRoutes(TODAY), failStorageRead: true })
  const result = await runHourlyAlign(ctx)
  assert.equal(result.status, 'skipped')
  assert.ok(!ctx.kv.has('state'), 'unavailable 时绝不许落盘')
  assert.equal(ctx.calls.filter(([method]) => method === 'PUT').length, 0)
})

test('插件停用：跳过本轮', async () => {
  const ctx = baseCtx({ settings: { enabled: false } })
  const result = await runHourlyAlign(ctx)
  assert.equal(result.status, 'skipped')
  assert.equal(result.message, '插件已停用')
})

test('订阅池整体不可解析：整轮跳过（零 PATCH）并留原文', async () => {
  const ctx = makeCtx({
    routes: [
      { method: 'GET', match: (path) => path.startsWith('/api/subscribe/pool/intents?'), data: '<html>maintenance</html>' },
    ],
  })
  const result = await runHourlyAlign(ctx)
  assert.equal(result.status, 'failed')
  assert.ok(result.message.includes('订阅池不可解析'), result.message)
  assert.equal(ctx.patches.length, 0, '零业务写入')
  const doc = storedDoc(ctx)
  // 200 + 结构认不出 → unparsed（kind()：只有非 2xx 或传输失败才是 http_error）
  assert.equal(doc.debug.pool_intents.status, 'unparsed')
  assert.ok(doc.debug.pool_intents.sample.includes('maintenance'), '≤2048 字节原文留档')
  assert.ok(doc.debug.pool_intents.sample.length <= 2048)
})

test('Emby 未收录（404 + 正文）与结构失败分开归类', async () => {
  const ctx = makeCtx({
    routes: [
      { method: 'GET', match: (path) => path.startsWith('/api/subscribe/pool/intents?'), data: INTENTS_BODY },
      { method: 'GET', match: (path) => path === '/api/plugin-host/emby/instances', data: INSTANCES_BODY },
      { method: 'GET', match: (path) => path.startsWith('/api/plugin-host/emby/episodes?'), status: 404, data: { error: '没有该剧' } },
      { method: 'GET', match: (path) => path === '/api/subscribe/air-calendar', data: calendarBody(TODAY) },
      { method: 'GET', match: (path) => path.startsWith('/api/tmdb/tv/'), data: TMDB_BODY },
    ],
  })
  const result = await runHourlyAlign(ctx)
  assert.equal(result.absent, 2, '两条 tv 都是未收录（独立分类，不算 failed）')
  assert.equal(result.failed, 0)
  const doc = storedDoc(ctx)
  assert.ok(doc.align.items.every((item) => item.reason.includes('Emby 未收录')), '未收录行带固定措辞（前端徽章依据）')
  assert.equal(ctx.patches.length, 0)
  // 探测记账记 absent，下轮按"没探过"重新排队
  assert.ok(doc.probe_book.every((entry) => entry.emby === 'absent'))
})

test('dry-run：判定要补但绝不发 PATCH', async () => {
  const ctx = baseCtx({ settings: { dry_run: true } })
  const result = await runHourlyAlign(ctx)
  assert.equal(ctx.patches.length, 0, 'dry-run 绝不产生写请求')
  assert.equal(result.patched, 0)
  const doc = storedDoc(ctx)
  assert.ok(doc.align.items.every((item) => item.action === 'dry-run'))
  assert.ok(doc.align.items.every((item) => item.reason.includes('待补订') || item.reason.includes('抬升')))
})

test('auto_bump 关闭：只判定不写 PATCH', async () => {
  const ctx = baseCtx({ settings: { auto_bump: false } })
  const result = await runHourlyAlign(ctx)
  assert.equal(ctx.patches.length, 0)
  const doc = storedDoc(ctx)
  assert.ok(doc.align.items.every((item) => item.reason.includes('auto_bump=false')))
  assert.equal(result.patched, 0)
})

test('日报：到点发送一次，当天不再发', async () => {
  const ctx = baseCtx({ settings: { report_enabled: true, report_hour: 0 } })
  const first = await runHourlyAlign(ctx)
  assert.equal(first.report.status, 'accepted', JSON.stringify(first.report))
  assert.equal(ctx.notifies.length, 1)
  assert.equal(ctx.notifies[0].dedupe_key, `chase-daily-${TODAY}`)
  assert.ok(ctx.notifies[0].title.startsWith(`追剧管家 ${TODAY}`), ctx.notifies[0].title)
  assert.ok(!JSON.stringify(ctx.notifies[0]).includes('"buttons"'), '不带按钮')
  assert.equal(ctx.notifies[0].body.includes('① 今日播出(1)'), true, ctx.notifies[0].body)
  assert.equal(ctx.notifies[0].body.includes('② 本次补订(2)'), true, ctx.notifies[0].body)
  const doc = storedDoc(ctx)
  assert.equal(doc.daily.last_sent_date, TODAY)

  // 第二轮：同一自然日不再发
  const second = await runHourlyAlign(ctx)
  assert.equal(second.report.status, 'idle')
  assert.equal(ctx.notifies.length, 1)
})

test('日报未开启或未到点：idle', async () => {
  const off = baseCtx()
  const result = await runHourlyAlign(off)
  assert.equal(result.report.status, 'idle')
  assert.equal(off.notifies.length, 0)

  const late = baseCtx({ settings: { report_enabled: true, report_hour: 23 } })
  // 用极小概率命中的小时难以稳定测试，这里只验证 hour=23 且当前本地小时 < 23 时 idle
  const hour = new Date(Date.now() + 480 * 60_000).getUTCHours()
  const outcome = await runHourlyAlign(late)
  if (hour < 23) assert.equal(outcome.report.status, 'idle')
})

test('补订建议（减方向）：caught_up + 全覆盖 + 目标更小', async () => {
  // Emby 有 1-10 集（订阅 10 集全覆盖），TMDB S1 = 8 集 → 建议裁剪到 8
  const ctx = makeCtx({
    routes: [
      { method: 'GET', match: (path) => path.startsWith('/api/subscribe/pool/intents?'), data: { code: 'ok', data: [
        { id: 42, tmdb_id: 1399, season: 1, media_type: 'tv', title: '权力的游戏', total_episodes_known: 10, state: 'caught_up' },
      ] } },
      { method: 'GET', match: (path) => path === '/api/plugin-host/emby/instances', data: INSTANCES_BODY },
      { method: 'GET', match: (path) => path.startsWith('/api/plugin-host/emby/episodes?'), data: { covered_episodes: '1-10', needed_episodes: '' } },
      { method: 'GET', match: (path) => path === '/api/subscribe/air-calendar', data: calendarBody(TODAY) },
      { method: 'GET', match: (path) => path.startsWith('/api/tmdb/tv/'), data: { seasons: [{ season_number: 1, episode_count: 8 }] } },
    ],
  })
  const result = await runHourlyAlign(ctx)
  assert.equal(result.patched, 0, '减方向永不产生写请求')
  const doc = storedDoc(ctx)
  assert.equal(doc.trim_suggestions.length, 1)
  assert.equal(doc.trim_suggestions[0].target_upper, 8)
  assert.ok(doc.trim_suggestions[0].reason.includes('建议裁剪'), doc.trim_suggestions[0].reason)
})

test('已核实无缺口行在 5 小时窗口内复用缓存（不重复探测 Emby）', async () => {
  // 第一轮：Emby = TMDB = 订阅 → 无缺口
  const routes = [
    { method: 'GET', match: (path) => path.startsWith('/api/subscribe/pool/intents?'), data: { code: 'ok', data: [
      { id: 41, tmdb_id: 1396, season: 5, media_type: 'tv', title: '绝命毒师', total_episodes_known: 12, state: 'partial' },
    ] } },
    { method: 'GET', match: (path) => path === '/api/plugin-host/emby/instances', data: INSTANCES_BODY },
    { method: 'GET', match: (path) => path.startsWith('/api/plugin-host/emby/episodes?'), data: { covered_episodes: '1-12', needed_episodes: '' } },
    { method: 'GET', match: (path) => path === '/api/subscribe/air-calendar', data: calendarBody(TODAY) },
    { method: 'GET', match: (path) => path.startsWith('/api/tmdb/tv/'), data: { seasons: [{ season_number: 5, episode_count: 12 }] } },
  ]
  const first = makeCtx({ routes })
  await runHourlyAlign(first)
  const doc = storedDoc(first)
  assert.equal(doc.align.items[0].action, 'skipped')
  assert.ok(doc.align.items[0].reason.includes('无缺口'), doc.align.items[0].reason)

  // 第二轮：复用缓存行 → 不再调用 emby/episodes 与 tmdb
  const second = makeCtx({
    routes,
    storage: { state: { value: doc, revision: first.kv.get('state').revision } },
  })
  const result = await runHourlyAlign(second)
  assert.equal(result.reused, 1, JSON.stringify(result))
  assert.equal(result.target_calls, 0)
  assert.equal(
    second.calls.filter(([method, path]) => method === 'GET' && path.startsWith('/api/plugin-host/emby/episodes')).length,
    0,
    '复用行不重复探测 Emby',
  )
  const secondDoc = storedDoc(second)
  assert.ok(secondDoc.align.items[0].reason.includes('复用缓存'), secondDoc.align.items[0].reason)
})

// ─────────────────────────── 立即对齐 ───────────────────────────

test('立即对齐：限量补订并落盘（v3 无常驻内存）', async () => {
  // 预置一份带 emby_instances 的状态（相当于先跑过一次探测诊断）：
  // 全新安装且配置是默认 -1 时不猜默认实例（与旧实现一致，条目全部跳过）。
  const seeded = newStateDoc()
  seeded.emby_instances.push({ id: 3, name: '客厅', is_default: true, key_ready: true, at: '2026-10-01T00:00:00Z' })
  const ctx = makeCtx({
    routes: baseRoutes(TODAY),
    storage: { state: { value: seeded, revision: 1 } },
  })
  const result = await runAlignNow(ctx)
  assert.equal(result.status, 'accepted')
  assert.equal(result.patched, 2, JSON.stringify(result))
  assert.equal(ctx.patches.length, 2)
  // align-now 不新增 TMDB 取数（探测量全给 Emby）：状态里没有该季目标 → 按纯 Emby 缺口补到 12
  assert.deepEqual(ctx.patches[0].body, { total_episodes: 12 })
  assert.deepEqual(ctx.patches[1].body, { total_episodes: 12 })
  const doc = storedDoc(ctx)
  assert.equal(doc.align.patched, 2, 'v3 把结果落盘（旧版只写内存）')
})

test('立即对齐：默认配置 + 无实例列表时不猜实例，全部跳过', async () => {
  const ctx = baseCtx()
  const result = await runAlignNow(ctx)
  assert.equal(result.status, 'accepted')
  assert.equal(result.patched, 0, '-1 不猜默认实例（旧实现同语义）')
  assert.equal(ctx.patches.length, 0)
  const doc = storedDoc(ctx)
  assert.equal(doc.align.skipped, 2)
})

test('立即对齐复用 6 小时内缓存行（零探测）', async () => {
  // 先跑一轮整点对齐得到「已核实无缺口」行（订阅 = Emby = TMDB = 12）
  const routes = [
    { method: 'GET', match: (path) => path.startsWith('/api/subscribe/pool/intents?'), data: { code: 'ok', data: [
      { id: 41, tmdb_id: 1396, season: 5, media_type: 'tv', title: '绝命毒师', total_episodes_known: 12, state: 'partial' },
    ] } },
    { method: 'GET', match: (path) => path === '/api/plugin-host/emby/instances', data: INSTANCES_BODY },
    { method: 'GET', match: (path) => path.startsWith('/api/plugin-host/emby/episodes?'), data: { covered_episodes: '1-12', needed_episodes: '' } },
    { method: 'GET', match: (path) => path === '/api/subscribe/air-calendar', data: calendarBody(TODAY) },
    { method: 'GET', match: (path) => path.startsWith('/api/tmdb/tv/'), data: { seasons: [{ season_number: 5, episode_count: 12 }] } },
  ]
  const first = makeCtx({ routes })
  await runHourlyAlign(first)
  const doc = storedDoc(first)

  const second = makeCtx({
    routes,
    storage: { state: { value: doc, revision: first.kv.get('state').revision } },
  })
  const result = await runAlignNow(second)
  assert.equal(result.patched, 0, '缓存行显示已核实无缺口')
  assert.equal(
    second.calls.filter(([method, path]) => method === 'GET' && path.startsWith('/api/plugin-host/emby/episodes')).length,
    0,
    '命中缓存不再探测',
  )
  assert.equal(
    second.calls.filter(([method, path]) => method === 'GET' && path.startsWith('/api/tmdb/tv/')).length,
    0,
    '命中缓存不再取 TMDB 目标',
  )
  const secondDoc = storedDoc(second)
  assert.ok(secondDoc.align.items[0].at === doc.align.items[0].at, '缓存行保留原始核实时刻')
})

test('立即对齐：订阅池读取失败返回 failed', async () => {
  const ctx = makeCtx({
    routes: [
      { method: 'GET', match: (path) => path.startsWith('/api/subscribe/pool/intents?'), status: 500, data: { error: 'boom' } },
    ],
  })
  const result = await runAlignNow(ctx)
  assert.equal(result.status, 'failed')
  assert.ok(result.message.includes('订阅池读取失败'), result.message)
})

// ─────────────────────────── 只读刷新 ───────────────────────────

test('只读刷新：零 PATCH，更新计数与日历', async () => {
  const ctx = baseCtx()
  const result = await runRefresh(ctx)
  assert.equal(result.status, 'accepted')
  assert.equal(result.tv_intents, 2, '夹具里的 movie 条目不计数')
  assert.equal(result.calendar_days, 1)
  assert.equal(ctx.patches.length, 0, 'refresh 零 PATCH')
  assert.ok(ctx.calls.every(([method]) => method !== 'PATCH'))
  const doc = storedDoc(ctx)
  assert.equal(doc.stats.tv_intents, 2)
  assert.equal(doc.calendar.days.length, 1)
})

test('只读刷新：订阅池失败但日历成功，仍返回 accepted', async () => {
  const ctx = makeCtx({
    routes: [
      { method: 'GET', match: (path) => path.startsWith('/api/subscribe/pool/intents?'), status: 503, data: 'nope' },
      { method: 'GET', match: (path) => path === '/api/subscribe/air-calendar', data: calendarBody(TODAY) },
    ],
  })
  const result = await runRefresh(ctx)
  assert.equal(result.status, 'accepted')
  assert.ok(result.message.includes('订阅池读取失败'), result.message)
  assert.equal(result.calendar_days, 1)
  assert.equal(ctx.patches.length, 0)
})

// ─────────────────────────── 回归：缓存 / 日报重试 / 刷新计数 ───────────────────────────

test('立即对齐：整点任务没探过的行（预算用尽, 无覆盖值）不当缓存，照样补探', async () => {
  const seeded = newStateDoc()
  seeded.emby_instances.push({ id: 3, name: '客厅', is_default: true, key_ready: true, at: '2026-10-01T00:00:00Z' })
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  seeded.align.items.push({
    intent_id: 41, tmdb_id: 1396, season: 5, title: '绝命毒师', total_known: 10,
    emby_have_max: -1, emby_have_count: -1, gap_max: 0, target_upper: 0, target_known: false,
    from_total: 10, to_total: 10, action: 'skipped', reason: 'Emby 探测预算用尽(120 次调用): 本轮跳过, 下轮优先', at: now,
  })
  const ctx = makeCtx({ routes: baseRoutes(TODAY), storage: { state: { value: seeded, revision: 1 } } })
  const result = await runAlignNow(ctx)
  const probes = ctx.calls.filter(([method, path]) => method === 'GET' && path.startsWith('/api/plugin-host/emby/episodes'))
  assert.ok(probes.length >= 1, '没有覆盖观测的行必须重新探测')
  assert.ok(ctx.patches.some((patch) => patch.path.includes('/41/')), JSON.stringify(ctx.patches))
  assert.equal(result.patched, 2)
})

test('日报：发送抛错后同一天换新去重键重试', async () => {
  const ctx = baseCtx({ settings: { report_enabled: true, report_hour: 0 } })
  let fail = true
  ctx.notify = async (options) => {
    ctx.notifies.push(options)
    if (fail) throw new Error('所有渠道发送失败')
    return { event: 'plugin_notification_message', accepted: true }
  }
  const first = await runHourlyAlign(ctx)
  assert.equal(first.report.status, 'failed')
  assert.equal(ctx.notifies[0].dedupe_key, `chase-daily-${TODAY}`)
  assert.equal(storedDoc(ctx).daily.last_sent_date, '')

  fail = false
  const second = await runHourlyAlign(ctx)
  assert.equal(second.report.status, 'accepted', JSON.stringify(second.report))
  assert.equal(ctx.notifies[1].dedupe_key, `chase-daily-${TODAY}-r1`, '投递未确认的键不能复用')
  assert.equal(storedDoc(ctx).daily.last_sent_date, TODAY)
})

test('只读刷新：不改写上一轮对齐的「已判定」计数', async () => {
  const ctx = baseCtx()
  await runHourlyAlign(ctx)
  const before = storedDoc(ctx).stats.matched
  const result = await runRefresh(ctx)
  assert.equal(result.matched, before)
  assert.equal(storedDoc(ctx).stats.matched, before)
})

test('日报：同键不同内容冲突（上一轮已送达但没落账）→ 记为已发，不换新键再发一份', async () => {
  const ctx = baseCtx({ settings: { report_enabled: true, report_hour: 0 } })
  ctx.notify = async (options) => {
    ctx.notifies.push(options)
    const error = new Error('dedupe_key 冲突：相同键已用于不同内容')
    error.status = 409
    throw error
  }
  const first = await runHourlyAlign(ctx)
  assert.equal(first.report.status, 'deduplicated', JSON.stringify(first.report))
  const daily = storedDoc(ctx).daily
  assert.equal(daily.last_sent_date, TODAY)
  assert.equal(daily.last_result, 'deduplicated')
  assert.equal(daily.retry_seq ?? 0, 0, '冲突不能换新键重试')

  await runHourlyAlign(ctx)
  assert.equal(ctx.notifies.length, 1, '当天不再重发')
})
