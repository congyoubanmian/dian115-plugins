// 榜单抓取 + 刷新编排 —— plugins/douban-rs/src/charts.rs 的 v3 形态。
//
// refresh_now 的顺序与 Go/Rust 版逐句一致（每步都有 diag 面包屑）：
// 1. refreshing 防重入（v3 用宿主任务队列的不重叠保证 + 会话内标志）；
// 2. 按 source_cost 稳定排序启用榜单，逐榜抓取并记日志，超预算跳过剩余榜单；
// 3. 组装快照（失败榜单不进快照，摘要里列"失败榜："），写 last_run；
// 4. filterAndEnqueue（黑名单 + 入观察队列）；
// 5. deep_refresh 时 process_due（前台预算塞不下聚合订阅）；
// 6. syncWishList（第二参数 = deep_refresh）；
// 7. bump + persist。
//
// 预算：前台动作 6.5s、后台任务 8 分钟（charts.rs ACTION_BUDGET_MS / JOB_BUDGET_MS）。

import { defaultSettings } from '../lib/model.js'
import { orderedEnabledKeys, parseSubjectsJson, parseComingHtml, parseChartHtml, subjectsJsonUrl, filterAndEnqueue, parseRateOrZero } from '../lib/charts-parse.js'
import { nowRfc3339, nowUnixNanos } from '../lib/clock.js'
import { goQuote } from '../lib/text.js'
import { POSTER_LOOKUP_LIMIT } from '../lib/poster-core.js'
import { doubanGet } from './httpx.js'
import { moviePoster } from './poster.js'
import { processDue } from './subscribe-engine.js'
import { syncWishList } from './wish.js'

/** 前台动作预算（charts.rs ACTION_BUDGET_MS）。 */
export const ACTION_BUDGET_MS = 6_500
/** 后台任务预算（charts.rs JOB_BUDGET_MS）。 */
export const JOB_BUDGET_MS = 8 * 60 * 1_000

/** charts.rs fetch_list：按 cfg.source 分派；未知来源报 `未知榜单来源 "x"`。 */
export async function fetchList(session, cfg, ctx, { deep } = {}) {
  if (cfg.source === 'subjects_json') return fetchSubjectsJson(session, cfg, ctx)
  if (cfg.source === 'coming_html') return fetchComing(session, cfg.limit, ctx)
  if (cfg.source === 'chart_html') return fetchChart(session, cfg.limit, ctx, { deep })
  throw new Error(`未知榜单来源 ${goQuote(cfg.source)}`)
}

/** charts.rs fetch_subjects_json：j/search_subjects + 标题空白跳过。 */
export async function fetchSubjectsJson(session, cfg, ctx) {
  const url = subjectsJsonUrl(cfg)
  const got = await doubanGet(ctx, url, 'application/json, text/plain;q=0.9')
  if (got.error) throw new Error(got.error)
  let payload
  try {
    payload = JSON.parse(got.text)
  } catch {
    throw new Error('响应解析失败: 语法错误')
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('响应解析失败: 类型不符')
  }
  return parseSubjectsJson(payload)
}

/** charts.rs fetch_coming：/cinema/later/ 页面（豆瓣已把 /later/ 301 到它）。 */
export async function fetchComing(session, limit, ctx) {
  const got = await doubanGet(ctx, 'https://movie.douban.com/cinema/later/', 'text/html,application/xhtml+xml;q=0.9')
  if (got.error) throw new Error(got.error)
  return parseComingHtml(got.text, limit)
}

/** charts.rs fetch_chart：/chart 一周口碑榜；deep_refresh 且未超限额时逐条补海报。 */
export async function fetchChart(session, limit, ctx, { deep } = {}) {
  const got = await doubanGet(ctx, 'https://movie.douban.com/chart', 'text/html,application/xhtml+xml;q=0.9')
  if (got.error) throw new Error(got.error)
  return parseChartHtml(got.text, limit, {
    deep,
    posterLookupLimit: POSTER_LOOKUP_LIMIT,
    lookupPoster: deep ? (title, id) => moviePoster(session, ctx, title, id) : undefined,
  })
}

/** charts.rs fetch_enabled_lists：按成本排序串行抓取 + 超预算跳过剩余榜单。 */
export async function fetchEnabledLists(session, ctx, docSettings, budgetMs, { deep } = {}) {
  const keys = orderedEnabledKeys(docSettings)
  const started = nowUnixNanos()
  const results = []
  for (const key of keys) {
    const config = docSettings?.lists?.[key] ?? defaultSettings().lists[key]
    const used = Number(nowUnixNanos() - started) / 1_000_000
    if (used > budgetMs) {
      session.log('warning', `本次已用 ${Math.floor(used / 1_000)} 秒, 跳过剩余榜单(下轮自动刷新会补齐)`)
      break
    }
    session.log('info', `开始抓取榜单 ${key} source=${config.source}`)
    try {
      const items = await fetchList(session, config, ctx, { deep })
      session.log('info', `榜单 ${key} 抓到 ${items.length} 条`)
      results.push({ key, items, error: null })
    } catch (error) {
      session.log('warning', `榜单 ${key} 抓取失败: ${error.message}`)
      results.push({ key, items: null, error: error.message })
    }
  }
  return results
}

/**
 * charts.rs refresh_now：一次完整刷新。
 * 返回 {ok: boolean, message}；防重入失败返回 {ok:false, message:'榜单刷新正在进行中'}。
 */
export async function refreshNow(session, ctx, invocationId, { deep } = {}) {
  if (session.refreshing) {
    throw new Error('榜单刷新正在进行中')
  }
  session.refreshing = true
  try {
    const flat = await session.settings()
    const docSettings = session.doc.settings
    await session.trace('refresh:start')

    // 1. 串行抓取各榜单
    const budget = deep ? JOB_BUDGET_MS : ACTION_BUDGET_MS
    const results = await fetchEnabledLists(session, ctx, docSettings, budget, { deep })
    await session.trace('lists:done')

    // 2. 组装快照（失败榜单不进快照）
    const lists = {}
    const failures = []
    for (const result of results) {
      if (result.error === null) lists[result.key] = result.items
      else failures.push(`${result.key}: ${result.error}`)
    }
    const fetchedAt = nowRfc3339()
    const snapshot = { fetched_at: fetchedAt, lists }

    // 3. 黑名单过滤 + 入观察队列（media_type 取该榜单配置的 kind）
    const now = nowUnixNanos()
    const outcome = filterAndEnqueue({
      snapshot,
      docSettings,
      queueItems: session.doc.queue.items,
      blackState: session.doc.blackstate,
      history: session.doc.history,
      nowNanos: now,
      nowRfc3339: fetchedAt,
      observePeriodHours: flat.observe_period_hours ?? docSettings.observe_period_hours,
      mediaTypeOf: (list) => docSettings?.lists?.[list]?.type ?? '',
    })
    session.doc.queue.items = outcome.queueItems
    session.doc.blackstate = outcome.blackState
    session.doc.last_run = fetchedAt
    session.doc.snapshot = snapshot

    // 4. 到期条目订阅（仅后台预算塞得下）
    let subscribed = 0
    let needsReview = 0
    let errMsg = ''
    if (deep) {
      const due = await processDue(session, ctx, invocationId, flat)
      subscribed = due.subscribed
      needsReview = due.needs_review
      errMsg = due.message ?? ''
    }

    // 5. 摘要
    const listCount = Object.keys(lists).length
    let summary = `榜单刷新完成：${listCount} 榜，新增订阅 ${subscribed}，待人工确认 ${needsReview}`
    if (!deep) summary += '；订阅由后台任务处理'
    if (failures.length > 0) summary += `；失败榜：${failures.join('；')}`
    if (errMsg !== '') summary += `；${errMsg}`
    session.log('info', summary)

    // 6. 同步「我的想看」（仅配置了登录态来源且开启时）
    await syncWishList(session, ctx, invocationId, { deep })

    session.bump('succeeded', summary)
    await session.persist()
    return { ok: true, message: summary, subscribed, needs_review: needsReview, failures }
  } finally {
    session.refreshing = false
  }
}

/** parseRateOrZero 再导出（job 入口/测试对齐旧 API 用）。 */
export { parseRateOrZero }
