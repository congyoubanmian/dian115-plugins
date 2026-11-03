// TMDB 匹配与聚合订阅 —— plugins/douban-rs/src/{subscribe.rs, subject.rs} 的 v3 形态。
//
// 宿主接口（v3 ctx.api，路由与旧 host.call 同名）：
// - GET /api/tmdb/search?q=<query>          → tmdbSearch
// - GET /api/subscribe/pool/intents?limit=  → hostIntentExists
// - POST /api/subscribe/pool/intents        → createSubscription
// 匹配增强（功能 1）：标题直配失败时用豆瓣详情（rexxar original_title/aka）回退重搜。
// 宿主去重 → 创建订阅 → 写历史 → 回填队列（doSubscribe）。
//
// v3 差异：ctx.api 不暴露自定义请求头，旧版 `dc-sub-<invocation>-<tmdb_id>` 幂等键
// 不再携带 —— 幂等由宿主任务队列 business_key + 宿主侧 (tmdb_id, media_type) 去重保底。
//
// （job 入口在 jobs/subscribe.js / jobs/subscribe-now.js，这两个是薄壳。）

import { CONFIDENCE_THRESHOLD, MAX_ATTEMPT, matchTmdb, tmdbTitle, tmdbYear, buildIntentBody, parseIntentCreateResult, intentExists, parseTmdbSearchResult } from '../lib/subscribe-core.js'
import { listPoolIntents } from './runtime.js'
import { queryEscape } from '../lib/text.js'
import { nowUnixNanos, parseRfc3339, rfc3339 } from '../lib/clock.js'
import { candidateFromQueueItem, queueItemRating, FILTERED_QUEUE_STATE, NO_RESUB_QUEUE_STATE, regionDegradedLog } from '../lib/filter-core.js'
import { doubanSubjectId, rexxarSubjectDetail } from './subject.js'
import { newHistoryEntry, newQueueItem } from '../lib/model.js'

/** subscribe.rs tmdb_search：GET /api/tmdb/search?q=（accept JSON；失败文案与 Go 一致）。 */
export async function tmdbSearch(ctx, query) {
  const path = `/api/tmdb/search?q=${queryEscape(query)}`
  let result
  try {
    result = await ctx.api.get(path)
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : 0
    if (status >= 400) throw new Error(`TMDB 搜索失败 HTTP ${status}`)
    throw new Error(error?.message || String(error))
  }
  return { results: parseTmdbSearchResult(result) }
}

/**
 * 功能 1 匹配增强：直配失败 → 豆瓣详情回退重搜（original_title → aka，取过阈值者）。
 * 返回 {item, confidence, fallbackHit}；直配的 Err 原样上抛，回退期间的失败忽略。
 */
export async function matchTmdbWithDetailFallback(session, ctx, query, doubanRef, kind) {
  const res = await tmdbSearch(ctx, query)
  const preferType = kind === 'movie' || kind === 'tv' ? kind : ''
  const direct = matchTmdb(res.results, query, '', preferType)
  if (direct.score >= CONFIDENCE_THRESHOLD && direct.best.id !== 0) {
    return { item: direct.best, confidence: direct.score, fallbackHit: null }
  }
  const subjectId = doubanSubjectId(doubanRef)
  if (subjectId === '') return { item: direct.best, confidence: direct.score, fallbackHit: null }
  const detail = await rexxarSubjectDetail(session, ctx, kind, subjectId)
  if (detail === null) return { item: direct.best, confidence: direct.score, fallbackHit: null }
  let hit = null
  for (const candidate of detail.fallback_titles) {
    let candidateRes
    try {
      candidateRes = await tmdbSearch(ctx, candidate)
    } catch {
      continue
    }
    const evaluated = matchTmdb(candidateRes.results, candidate, '', preferType)
    if (evaluated.score < CONFIDENCE_THRESHOLD || evaluated.best.id === 0) continue
    if (hit === null || evaluated.score > hit.confidence) {
      hit = { item: evaluated.best, confidence: evaluated.score, fallbackHit: candidate }
    }
  }
  if (hit !== null) return hit
  return { item: direct.best, confidence: direct.score, fallbackHit: null }
}

/**
 * 宿主是否已有同 (tmdb_id, media_type) 的订阅：按 media_type 分页读完订阅池。
 * 查询失败返回 {exists:false, error}：调用方必须放弃创建 —— 无法核对就不能证明没订过，
 * 否则宿主瞬时故障或订阅池超过单页上限时会重复创建（旧版"失败当不存在"的口径已废弃）。
 */
export async function hostIntentExists(ctx, tmdbId, mediaType) {
  const listing = await listPoolIntents(ctx, { mediaType })
  if (listing === null) return { exists: false, id: 0, error: '宿主订阅池查询失败' }
  const found = intentExists(listing.entries, tmdbId, mediaType)
  if (found.exists) return found
  if (listing.truncated) return { exists: false, id: 0, error: '宿主订阅池条目过多，无法确认是否已订阅' }
  return found
}

/** subscribe.rs create_subscription：创建聚合订阅（body 形态 = v3 openapi PoolIntentCreateRequest）。 */
export async function createSubscription(session, ctx, item, wantType, title, year) {
  let body
  try {
    body = buildIntentBody({
      item,
      wantType,
      title,
      year,
      enabledSources: session.doc.settings.subscribe_source_filter ?? [],
    })
  } catch (error) {
    throw new Error(error.message)
  }
  let result
  try {
    result = await ctx.api.post('/api/subscribe/pool/intents', body)
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : 0
    if (status >= 400) throw new Error(`创建订阅失败 HTTP ${status}`)
    throw new Error(error?.message || String(error))
  }
  return parseIntentCreateResult(result)
}

/**
 * subscribe.rs process_due：处理到期条目 —— 守卫（墓碑 → 过滤）→ TMDB 匹配 → 创建订阅。
 * 返回 {subscribed, needs_review, message}（message 恒空串，保留三元组拼法）。
 */
export async function processDue(session, ctx, invocationId, flat) {
  const now = nowUnixNanos()
  const keep = []
  const due = []
  const items = Array.isArray(session.doc.queue.items) ? session.doc.queue.items : []
  for (const item of items) {
    // 被过滤 / 被墓碑拦下的是终态，直接保留（不要掉进到期判定）
    if (item.state === 'needs_review' || item.state === FILTERED_QUEUE_STATE || item.state === NO_RESUB_QUEUE_STATE) {
      keep.push(item)
      continue
    }
    const dueAt = dueAtNanos(item.due_at)
    if (dueAt !== null && dueAt > now) {
      keep.push(item)
      continue
    }
    due.push(item)
  }

  let subscribed = 0
  let needsReview = 0
  let retrying = 0
  for (const q of due) {
    // 自动路径两道前置守卫（顺序固定：墓碑先于过滤）
    const rating = queueItemRating(q)
    const candidate = candidateFromQueueItem(q, rating)
    const guardMessage = session.noResubGuard(candidate)
    if (guardMessage !== null) {
      keep.push({ ...q, state: NO_RESUB_QUEUE_STATE, last_error: guardMessage })
      session.log('info', guardMessage)
      continue
    }
    const decision = session.canSubscribe(candidate, flat)
    if (!decision.allowed) {
      const reason = decision.reason ?? ''
      session.markQueueItemFiltered(q.douban_ref, reason)
      keep.push({ ...q, state: FILTERED_QUEUE_STATE, last_error: reason })
      continue
    }
    if (decision.region_skipped) {
      session.log('warning', regionDegradedLog(q.title))
    }
    const outcome = await subscribeQueueItem(session, ctx, invocationId, q, flat)
    if (outcome.status === 'succeeded') {
      subscribed += 1
      continue
    }
    const next = settleUnsubscribed(session, q, outcome)
    keep.push(next)
    if (next.state === 'needs_review') needsReview += 1
    else retrying += 1
  }
  session.doc.queue.items = keep
  return { subscribed, needs_review: needsReview, retrying, message: '' }
}

/** 失败重试的退避：第 n 次失败后 n 小时再试（定时任务每 30 分钟扫一次到期条目）。 */
export const RETRY_BACKOFF_NANOS = 3_600_000_000_000

/**
 * 自动路径里没订上的条目怎么留队（返回新的队列条目，调用方负责放回队列）：
 * - needs_review（TMDB 置信不足）→ 留队待人工确认 + 一条 needs_review 历史；
 * - failed（宿主/网络等可重试错误）→ attempt+1；未达上限按退避延后重试，
 *   达到上限转 needs_review 并写 failed 历史。条目始终留在队列里，不会悄悄消失。
 */
export function settleUnsubscribed(session, q, outcome) {
  const history = { ...newHistoryEntry(), douban_ref: q.douban_ref, title: q.title, list: q.list, action: 'subscribe', message: outcome.message, tmdb_ref: q.tmdb_ref ?? '' }
  if (outcome.status === 'needs_review') {
    session.addHistoryAndLog({ ...history, result: 'needs_review' }, `TMDB 匹配待确认：${q.title} (${outcome.message})`)
    return { ...q, state: 'needs_review', last_error: outcome.message }
  }
  const attempt = (Number.isFinite(q.attempt) ? q.attempt : 0) + 1
  if (attempt < MAX_ATTEMPT) {
    session.log('warning', `订阅失败，稍后重试（第 ${attempt} 次）：${q.title} (${outcome.message})`)
    return {
      ...q,
      state: 'observing',
      attempt,
      last_error: outcome.message,
      due_at: rfc3339(nowUnixNanos() + attempt * RETRY_BACKOFF_NANOS),
    }
  }
  session.addHistoryAndLog({ ...history, result: 'failed' }, `订阅失败（已重试 ${attempt} 次，转人工确认）：${q.title} (${outcome.message})`)
  return { ...q, state: 'needs_review', attempt, last_error: outcome.message }
}

/** 到期判定：解析失败按已到期（clock.rs parse_rfc3339 的口径，尊重固定时钟）。 */
function dueAtNanos(text) {
  return parseRfc3339(text)
}

/**
 * subscribe.rs subscribe_queue_item：匹配并订阅单个队列条目。
 * 返回 {status, intent_id, message}，status ∈ succeeded | needs_review | failed。
 */
export async function subscribeQueueItem(session, ctx, invocationId, q, flat) {
  let matched
  try {
    matched = await matchTmdbWithDetailFallback(session, ctx, q.title, q.douban_ref, q.media_type)
  } catch (error) {
    return { status: 'failed', intent_id: 0, message: `TMDB 搜索失败: ${error.message}` }
  }
  if (matched.fallbackHit !== null) {
    session.log('info', `TMDB 回退匹配: ${q.title} 经 ${matched.fallbackHit} 命中`)
  }
  if (matched.confidence < CONFIDENCE_THRESHOLD || matched.item.id === 0) {
    return {
      status: 'needs_review',
      intent_id: 0,
      message: `TMDB 匹配置信不足 (${matched.confidence.toFixed(2)})`,
    }
  }
  return doSubscribe(session, ctx, invocationId, q, matched.item, flat)
}

/** subscribe.rs do_subscribe：宿主去重 → 创建订阅 → 写历史 → 回填队列。 */
export async function doSubscribe(session, ctx, invocationId, q, item, flat) {
  void invocationId
  const tmdbRef = `tmdb:${item.media_type}:${item.id}`
  const exists = await hostIntentExists(ctx, item.id, item.media_type)
  if (exists.error) {
    return { status: 'failed', intent_id: 0, message: `无法核对宿主已有订阅，暂不创建: ${exists.error}` }
  }
  if (exists.exists) {
    for (const entry of session.doc.queue.items ?? []) {
      if (entry.douban_ref === q.douban_ref) {
        entry.state = 'subscribed'
        entry.tmdb_ref = tmdbRef
      }
    }
    session.addHistoryAndLog(
      {
        ...newHistoryEntry(),
        douban_ref: q.douban_ref,
        tmdb_ref: tmdbRef,
        title: q.title,
        list: q.list,
        action: 'subscribe',
        result: 'succeeded',
        message: '已存在同类聚合订阅，跳过重复创建',
        intent_id: exists.id,
      },
      `已存在订阅，跳过：${q.title}`,
    )
    if (flat?.notify_on_subscribe) await notifySubscribe(session, ctx, q.title, '已存在同类聚合订阅，跳过重复创建', `${q.douban_ref}:exists:${exists.id}`)
    return { status: 'succeeded', intent_id: exists.id, message: '' }
  }
  const title = tmdbTitle(item)
  const year = tmdbYear(item)
  let intentId
  try {
    intentId = await createSubscription(session, ctx, item, '', title, year)
  } catch (error) {
    return { status: 'failed', intent_id: 0, message: `创建聚合订阅失败: ${error.message}` }
  }
  session.addHistoryAndLog(
    {
      ...newHistoryEntry(),
      douban_ref: q.douban_ref,
      tmdb_ref: tmdbRef,
      title: q.title,
      list: q.list,
      action: 'subscribe',
      result: 'succeeded',
      message: '订阅成功',
      intent_id: intentId,
    },
    `已创建聚合订阅：${q.title}`,
  )
  for (const entry of session.doc.queue.items ?? []) {
    if (entry.douban_ref === q.douban_ref) {
      entry.state = 'subscribed'
      entry.tmdb_ref = tmdbRef
      entry.media_type = item.media_type
      entry.year = year
      entry.poster_path = item.poster_path
    }
  }
  if (flat?.notify_on_subscribe) await notifySubscribe(session, ctx, q.title, '订阅成功', `${q.douban_ref}:created:${intentId}`)
  return { status: 'succeeded', intent_id: intentId, message: '' }
}

/**
 * 订阅结果通知（v3 ctx.notify；旧版宿主拒绝插件通知 payload，v3 恢复）。
 * dedupe_key 按"豆瓣条目 + 结果 + 宿主订阅 ID"区分：宿主会永久记住每个键，
 * 同键不同内容直接报冲突、同键同内容不再发送 —— 只按标题做键会让同名条目/
 * 删除后重订的通知永远发不出去。同一次订阅被恢复重跑时键相同，正好去重。
 */
export async function notifySubscribe(session, ctx, title, detail, dedupeRef = title) {
  try {
    await ctx.notify({
      title: `豆瓣订阅：${title}`,
      body: detail,
      level: 'success',
      dedupe_key: `douban.rs:subscribe:${dedupeRef}`.slice(0, 200),
    })
  } catch (error) {
    session.log('warning', `订阅通知发送失败: ${error?.message ?? String(error)}`)
  }
}

/**
 * subscribe.rs subscribe_from_snapshot —— action `subscribe`（榜单条目立即订阅）。
 * 手动入口：不加 can_subscribe/墓碑守卫；响应里带墓碑确认文案（有则填）。
 */
export async function subscribeFromSnapshot(session, ctx, invocationId, doubanRef) {
  const flat = await session.settings()
  const lists = session.doc.snapshot.lists ?? {}
  let found = null
  let foundList = ''
  for (const key of Object.keys(lists).sort()) {
    const items = lists[key]
    if (!Array.isArray(items)) continue
    const item = items.find((entry) => entry.douban_ref === doubanRef)
    if (item) {
      found = item
      foundList = key
      break
    }
  }
  if (found === null) return { status: 'failed', message: '榜单快照中未找到该条目' }
  const foundKind = session.doc.settings.lists?.[foundList]?.type ?? ''
  let matched
  try {
    matched = await matchTmdbWithDetailFallback(session, ctx, found.title, found.douban_ref, foundKind)
  } catch (error) {
    return { status: 'failed', message: `TMDB 搜索失败: ${error.message}` }
  }
  if (matched.fallbackHit !== null) {
    session.log('info', `TMDB 回退匹配: ${found.title} 经 ${matched.fallbackHit} 命中`)
  }
  if (matched.confidence < CONFIDENCE_THRESHOLD || matched.item.id === 0) {
    return {
      status: 'failed',
      message: `TMDB 匹配置信不足 (${matched.confidence.toFixed(2)})，无法自动订阅`,
    }
  }
  const q = { ...newQueueItem(), douban_ref: found.douban_ref, title: found.title, url: found.url }
  const outcome = await doSubscribe(session, ctx, invocationId, q, matched.item, flat)
  if (outcome.status === 'succeeded') {
    for (const entry of session.doc.queue.items ?? []) {
      if (entry.douban_ref === q.douban_ref) entry.state = 'subscribed'
    }
    await session.persist()
    const payload = { status: 'succeeded', message: '订阅成功', intent_id: outcome.intent_id }
    const confirm = session.noResubConfirmation(q.douban_ref)
    if (confirm !== null) payload.no_resub_confirm = confirm
    return payload
  }
  session.addHistoryAndLog(
    {
      ...newHistoryEntry(),
      douban_ref: q.douban_ref,
      title: q.title,
      list: q.list,
      action: 'subscribe',
      result: 'failed',
      message: outcome.message,
    },
    `订阅失败：${q.title} (${outcome.message})`,
  )
  await session.persist()
  return { status: 'failed', message: outcome.message }
}

/**
 * subscribe.rs subscribe_queue_now —— action `subscribe-now`（队列条目立即订阅）。
 * 手动入口：不拦墓碑，但应用过滤器（唯一"手动 + 过滤判定"的入口）。
 */
export async function subscribeQueueNow(session, ctx, invocationId, doubanRef) {
  const flat = await session.settings()
  const q = (session.doc.queue.items ?? []).find((item) => item.douban_ref === doubanRef)
  if (!q) return { status: 'failed', message: '观察队列中未找到该条目' }
  const decision = session.canSubscribe(candidateFromQueueItem(q, queueItemRating(q)), flat)
  if (!decision.allowed) {
    const reason = decision.reason ?? ''
    session.markQueueItemFiltered(doubanRef, reason)
    await session.persist()
    return { status: 'failed', message: reason }
  }
  if (decision.region_skipped) {
    session.log('warning', regionDegradedLog(q.title))
  }
  const outcome = await subscribeQueueItem(session, ctx, invocationId, q, flat)
  if (outcome.status === 'succeeded') {
    for (const entry of session.doc.queue.items ?? []) {
      if (entry.douban_ref === doubanRef) entry.state = 'subscribed'
    }
    await session.persist()
    const payload = { status: 'succeeded', message: '订阅成功', intent_id: outcome.intent_id }
    const confirm = session.noResubConfirmation(doubanRef)
    if (confirm !== null) payload.no_resub_confirm = confirm
    return payload
  }
  if (outcome.status === 'needs_review') {
    session.addHistoryAndLog(
      {
        ...newHistoryEntry(),
        douban_ref: q.douban_ref,
        title: q.title,
        list: q.list,
        action: 'subscribe',
        result: 'needs_review',
        message: outcome.message,
      },
      `TMDB 匹配待确认：${q.title} (${outcome.message})`,
    )
    for (const entry of session.doc.queue.items ?? []) {
      if (entry.douban_ref === doubanRef) {
        entry.state = 'needs_review'
        entry.last_error = outcome.message
      }
    }
    await session.persist()
    return { status: 'failed', message: outcome.message }
  }
  session.addHistoryAndLog(
    {
      ...newHistoryEntry(),
      douban_ref: q.douban_ref,
      title: q.title,
      list: q.list,
      action: 'subscribe',
      result: 'failed',
      message: outcome.message,
    },
    `订阅失败：${q.title} (${outcome.message})`,
  )
  await session.persist()
  return { status: 'failed', message: outcome.message }
}
