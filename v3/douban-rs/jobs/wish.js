// 想看同步 —— plugins/douban-rs/src/wish.rs 的 v3 形态。
//
// 从 CookieCloud（宿主内置 / 自建）或手动粘贴的 cookie 拉取用户的 kind=mark 列表
// （电影 + 剧集），新条目先过墓碑/过滤器守卫，再走既有 TMDB 匹配 + 聚合订阅链路。
//
// subscribe_inline 语义（wish.rs sync_wish_list）：
// - false（前台动作，~10s 硬预算）：只拉列表 + 入队，订阅交给后台任务；
// - true（后台 job）：立刻订阅（auto_subscribe 为真时）。

import { wishItemsFromInterests, parseInterestsResponse, wishInterestsUrl, WISH_PAGE_SIZE, WISH_MAX_PAGES } from '../lib/wish-core.js'
import { candidateFromWishItem, regionDegradedLog } from '../lib/filter-core.js'
import { newQueueItem } from '../lib/model.js'
import { nowRfc3339, nowUnixNanos, rfc3339 } from '../lib/clock.js'
import { doubanGetWithCookie } from './httpx.js'
import { doubanCookie } from './cookiecloud.js'
import { subscribeQueueItem, processDue } from './subscribe-engine.js'

/** 拉取单类型想看列表（分页，上限 WISH_MAX_PAGES 页；终止条件与 Go 一致）。 */
export async function fetchWish(session, ctx, header, uid, wantType) {
  const items = []
  for (let page = 0; page < WISH_MAX_PAGES; page += 1) {
    const url = wishInterestsUrl(uid, wantType, page * WISH_PAGE_SIZE)
    const got = await doubanGetWithCookie(ctx, url, header)
    if (got.error) throw new Error(`HTTP ${got.status}: ${got.error}`)
    let parsed
    try {
      parsed = JSON.parse(got.text)
    } catch {
      throw new Error('响应解析失败: 语法错误')
    }
    const response = parseInterestsResponse(parsed)
    if (response === null) throw new Error('响应解析失败: 类型不符')
    items.push(...wishItemsFromInterests(response.interests))
    if (response.interests.length < WISH_PAGE_SIZE || items.length >= response.total) break
  }
  return items
}

/**
 * wish.rs sync_wish_list：全量同步想看，已处理的跳过。
 * 返回 {done: boolean}；失败写 wish_info.last_status = failed + 原因。
 */
export async function syncWishList(session, ctx, invocationId, { deep } = {}) {
  const flat = session.flatSync()
  if (!flat.wish_sync_enabled) return { done: false }
  const info = { ...session.doc.wish_info }
  const seen = { ...(session.doc.wish_seen ?? {}) }

  let header
  let uid
  let source
  try {
    const cookie = await doubanCookie(session, ctx)
    header = cookie.header
    uid = cookie.uid
    source = cookie.source
  } catch (error) {
    info.last_status = 'failed'
    info.last_error = error.message
    info.last_sync = nowRfc3339()
    session.doc.wish_info = info
    session.log('warning', `想看同步跳过: ${error.message}`)
    return { done: false }
  }
  info.enabled = true
  info.uid = uid
  info.source = source
  info.last_error = ''

  const all = []
  const merged = new Set()
  for (const wantType of ['movie', 'tv']) {
    try {
      const items = await fetchWish(session, ctx, header, uid, wantType)
      // movie/tv 两个查询的响应会重叠（豆瓣对 type 过滤不严格），按条目去重
      for (const item of items) {
        if (merged.has(item.douban_ref)) continue
        merged.add(item.douban_ref)
        all.push({ ...item, added_at: nowRfc3339() })
      }
    } catch (error) {
      info.last_status = 'failed'
      info.last_error = `${wantType} 拉取失败: ${error.message}`
      session.log('warning', `想看(${wantType})拉取失败: ${error.message}`)
    }
  }
  if (all.length === 0 && info.last_status === 'failed') {
    info.last_sync = nowRfc3339()
    session.doc.wish_info = info
    await session.persist()
    return { done: false }
  }

  let newCount = 0
  for (const item of all) {
    if (seen[item.douban_ref] === true) continue
    newCount += 1
    seen[item.douban_ref] = true
    // 自动路径两道守卫（顺序固定：墓碑先于过滤）；先写 seen 再守卫：
    // 被拦的条目下一轮同步不再当"新条目"重判重记日志
    const candidate = candidateFromWishItem(item)
    const guardMessage = session.noResubGuard(candidate)
    if (guardMessage !== null) {
      session.log('info', guardMessage)
      continue
    }
    const decision = session.canSubscribe(candidate, flat)
    if (!decision.allowed) {
      const reason = decision.reason ?? ''
      session.log('info', `已过滤自动订阅：${item.title}（${reason}）`)
      continue
    }
    if (decision.region_skipped) {
      session.log('warning', regionDegradedLog(item.title))
    }
    const buildQueueItem = () => ({
      ...newQueueItem(),
      douban_ref: item.douban_ref,
      title: item.title,
      list: 'wish',
      poster_url: item.poster_url,
      url: `https://www.douban.com/subject/${item.douban_ref}/`,
      media_type: item.type,
      year: item.year,
      rating: item.rating,
      entered_at: nowRfc3339(),
      state: 'observing',
    })
    if (deep && flat.auto_subscribe) {
      const queued = { ...buildQueueItem(), due_at: '' }
      await subscribeQueueItem(session, ctx, invocationId, queued, flat)
    } else {
      // 前台（或未开自动订阅）：只入观察队列；自动订阅开着 → due_at=现在，后台接手立即订
      const duplicate = (session.doc.queue.items ?? []).some((entry) => entry.douban_ref === item.douban_ref)
      if (!duplicate) {
        let dueAt = nowRfc3339()
        if (!flat.auto_subscribe) {
          const shiftedNanos = nowUnixNanos() + (flat.observe_period_hours ?? 0) * 3_600_000_000_000
          if (shiftedNanos > 0) dueAt = rfc3339(shiftedNanos)
        }
        if (!Array.isArray(session.doc.queue.items)) session.doc.queue.items = []
        session.doc.queue.items.push({ ...buildQueueItem(), due_at: dueAt })
      }
    }
  }

  info.last_sync = nowRfc3339()
  info.last_count = all.length
  info.last_new = newCount
  info.last_status = 'succeeded'
  session.doc.wish = all
  session.doc.wish_seen = seen
  session.doc.wish_info = info
  if (newCount > 0) {
    const suffix = flat.auto_subscribe ? '自动订阅' : '入观察队列'
    session.log('info', `想看同步完成: 共 ${all.length} 条, 新增 ${newCount} (已${suffix})`)
  }
  return { done: true }
}

/** action wish-sync（wish.rs action_wish_sync；前台只入队、后台才订阅）。 */
export async function actionWishSync(session, ctx, invocationId, { deep } = {}) {
  const flat = await session.settings()
  if (!flat.wish_sync_enabled) {
    return { status: 'failed', message: '请先在设置中开启「同步我的想看」' }
  }
  await syncWishList(session, ctx, invocationId, { deep })
  const info = session.doc.wish_info
  if (info.last_status !== 'succeeded') {
    return { status: 'failed', message: info.last_error }
  }
  if (deep) {
    return { status: 'succeeded', message: `想看同步完成：共 ${info.last_count} 条，新增 ${info.last_new}` }
  }
  return {
    status: 'succeeded',
    message: `想看已同步：共 ${info.last_count} 条，新增 ${info.last_new} 条已入队；订阅由后台任务自动完成（每 30 分钟检查）`,
  }
}

/** job wish-sync 的完整编排：想看同步 + 到期订阅 + 墓碑判定（runtime.rs job_dispatch）。 */
export async function runWishSyncJob(session, ctx, invocationId) {
  const flat = await session.settings()
  if (flat.wish_sync_enabled) {
    await syncWishList(session, ctx, invocationId, { deep: true })
  }
  await processDue(session, ctx, invocationId, flat)
  // 墓碑判定：到期条目处理完之后扫一次历史（节流 >= 6 小时）
  if (session.noResubScanDue()) {
    await session.resolveNoResubFromHistory()
    session.doc.no_resub_scan_at = nowRfc3339()
  }
  await session.persist()
  return { status: 'accepted', message: '想看与到期订阅已处理' }
}
