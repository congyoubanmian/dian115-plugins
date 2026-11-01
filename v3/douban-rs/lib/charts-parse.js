// 榜单解析 —— plugins/douban-rs/src/charts.rs 纯函数部分的移植。
//
// 9 条正则逐条对齐 Go 的 ASCII 类：Go 的 \d / \s 是 ASCII 类（JS 正则的 \d 同为
// ASCII；\s 比 Go 多吃 \v 与 Unicode 空白，因此显式写成 [\t\n\f\r ]）。
// 期望值全部来自旧仓库 tests/fixtures 的真实页面摘录（charts_parse.rs 对拍过）。

import { collapseSpace, parseWant, queryEscape, sourceCost, sectionAfter, goQuote } from './text.js'
import { newChartItem, newQueueItem } from './model.js'
import { rfc3339 } from './clock.js'

/** Go `main.go:516` reWant：`([\d,]+)\s*人?\s*想看`（已在 text.js parseWant）。 */
export { parseWant, sourceCost, sectionAfter, queryEscape, goQuote }

/** Go `main.go:520` reNo：`class="no">\s*(\d+)`。 */
const RE_NO = /class="no">[\t\n\f\r ]*([0-9]+)/
/** Go `main.go:523` reName（chart 页行：subject 链接 + 标题）。 */
const RE_NAME = /<a[^>]*href="https:\/\/movie\.douban\.com\/subject\/([0-9]+)\/"[^>]*>[\t\n\f\r ]*([^<]+)/
/** Go `main.go:525` reItemMod（coming 页块，(?s) 点号跨行）。 */
const RE_ITEM_MOD = /<div class="item mod[^"]*">[\s\S]*?<\/div>[\t\n\f\r ]*<\/div>/g
/** Go `main.go:526` reItemSubj。 */
const RE_ITEM_SUBJ = /<h3>[\t\n\f\r ]*<a[^>]*href="https:\/\/movie\.douban\.com\/subject\/([0-9]+)\/"[^>]*>[\t\n\f\r ]*([^<]+)/
/** Go `main.go:527` reItemImg。 */
const RE_ITEM_IMG = /<img[^>]+src="([^"]+)"/

/** Go `main.go:597` `j/search_subjects` 响应 → 条目（标题 trim 后为空跳过；limit 由 URL page_limit 服务端生效）。 */
export function parseSubjectsJson(payload) {
  const subjects = Array.isArray(payload?.subjects) ? payload.subjects : []
  const items = []
  for (const subject of subjects) {
    const title = String(subject?.title ?? '').trim()
    if (title === '') continue
    items.push({
      ...newChartItem(),
      douban_ref: `db:subj:${subject?.id ?? ''}`,
      title,
      rate: String(subject?.rate ?? ''),
      poster_url: String(subject?.cover ?? ''),
      url: String(subject?.url ?? ''),
    })
  }
  return items
}

/** Go `main.go:711` fetchChart 的解析段：`#listCont2` 里每个 `<li class="clearfix">` 一行。
 *  deep_refresh 的海报回调是网络请求（async）；这里必须 await，否则 Promise 会被写进
 *  poster_url，JSON 落盘后变成 {}，下一次读取整份状态文档都会被判为无法识别。 */
export async function parseChartHtml(html, limit, hooks = {}) {
  const items = []
  const seen = new Set()
  const segment = sectionAfter(html, 'id="listCont2"', '', '</ul>')
  const rows = segment.match(/<li class="clearfix">[\s\S]*?<\/li>/g) ?? []
  for (const row of rows) {
    const captures = RE_NAME.exec(row)
    RE_NAME.lastIndex = 0
    if (!captures) continue
    const id = captures[1]
    if (seen.has(id)) continue
    seen.add(id)
    const title = collapseSpace(captures[2]).trim()
    if (title === '') continue
    const rankMatch = RE_NO.exec(row)
    const rank = rankMatch ? rankMatch[1] : ''
    // 口碑榜 HTML 不带海报：deep_refresh 时只对前 POSTER_LOOKUP_LIMIT 条按标题补
    let poster = ''
    if (hooks.lookupPoster && items.length < (hooks.posterLookupLimit ?? 8)) {
      poster = await hooks.lookupPoster(title, id)
    }
    items.push({
      ...newChartItem(),
      douban_ref: `db:subj:${id}`,
      title,
      rank,
      hotness: parseWant(row),
      poster_url: typeof poster === 'string' ? poster : '',
      url: `https://movie.douban.com/subject/${id}/`,
    })
    // Go 是 append 后再比 len >= limit：limit=0/负数也会收下第一条
    if (items.length >= limit) break
  }
  return items
}

/** Go `main.go:629` fetchComing 的解析段：`#showing-soon` 里每个 `<div class="item mod...">` 一条。 */
export function parseComingHtml(html, limit) {
  const items = []
  const seen = new Set()
  const segment = sectionAfter(html, 'id="showing-soon"', '', '')
  RE_ITEM_MOD.lastIndex = 0
  for (const block of segment.match(RE_ITEM_MOD) ?? []) {
    RE_ITEM_MOD.lastIndex = 0
    const captures = RE_ITEM_SUBJ.exec(block)
    if (!captures) continue
    const id = captures[1]
    if (seen.has(id)) continue
    seen.add(id)
    const title = collapseSpace(captures[2]).trim()
    if (title === '') continue
    let poster = ''
    const image = RE_ITEM_IMG.exec(block)
    if (image && image[1].startsWith('http')) poster = image[1]
    items.push({
      ...newChartItem(),
      douban_ref: `db:subj:${id}`,
      title,
      hotness: parseWant(block),
      poster_url: poster,
      url: `https://movie.douban.com/subject/${id}/`,
    })
    // Go 是 append 后再比 len >= limit：limit=0/负数也会收下第一条
    if (items.length >= limit) break
  }
  return items
}

/** `j/search_subjects` 的请求 URL（fetchSubjectsJSON；QueryEscape 与 Go 逐字节一致）。 */
export function subjectsJsonUrl(config) {
  return (
    'https://movie.douban.com/j/search_subjects' +
    `?type=${queryEscape(config.type)}&tag=${queryEscape(config.tag)}` +
    `&sort=${queryEscape(config.sort)}&page_limit=${config.limit}&page_start=0`
  )
}

/** charts.rs `ordered_enabled_keys`：启用榜单按 source_cost 稳定排序，平手按键字典序。 */
export function orderedEnabledKeys(docSettings) {
  const lists = docSettings?.lists ?? {}
  return Object.keys(lists)
    .filter((key) => lists[key]?.enabled)
    .sort((a, b) => {
      const cost = sourceCost(lists[a].source) - sourceCost(lists[b].source)
      return cost !== 0 ? cost : a < b ? -1 : a > b ? 1 : 0
    })
}

/**
 * Go `main.go:1292` checkItem 的判定段（黑名单 → 已订阅 → 已在队列）。
 * 返回 {hit: keyword|null, skip: reason|null}；入队由调用方完成。
 */
export function checkItemDecision(item, list, blacklist, history, queueItems) {
  void list
  for (const keyword of blacklist ?? []) {
    if (keyword !== '' && item.title.includes(keyword)) {
      return { hit: keyword, skip: 'blacklist' }
    }
  }
  for (const entry of history ?? []) {
    if (entry.douban_ref === item.douban_ref && entry.result === 'succeeded' && entry.action === 'subscribe') {
      return { hit: null, skip: 'subscribed' }
    }
  }
  for (const existing of queueItems ?? []) {
    if (existing.douban_ref === item.douban_ref) return { hit: null, skip: 'queued' }
  }
  return { hit: null, skip: null }
}

/**
 * Go `main.go:1264` filterAndEnqueue：黑名单命中统计 + 条目入观察队列。
 * 纯函数：返回新的 {queueItems, blackState}，不修改入参。
 * nil 队列语义与 Go 一致：没有任何条目入队时保持 null（不物化空数组）。
 */
export function filterAndEnqueue({ snapshot, docSettings, queueItems, blackState, history, nowNanos, nowRfc3339, observePeriodHours, mediaTypeOf }) {
  const blacklist = docSettings?.blacklist ?? []
  const hits = new Map() // title -> keyword
  const lists = snapshot?.lists ?? {}
  const period = observePeriodHours > 0 ? observePeriodHours : 24
  let nextQueue = Array.isArray(queueItems) ? [...queueItems] : null
  const queuedRefs = () => (Array.isArray(nextQueue) ? nextQueue : [])
  const check = (item, list) => {
    const decision = checkItemDecision(item, list, blacklist, history, queuedRefs())
    if (decision.hit !== null) {
      hits.set(item.title, decision.hit)
      return
    }
    if (decision.skip !== null) return
    if (!Array.isArray(nextQueue)) nextQueue = []
    const dueNanos = nowNanos + period * 3_600_000_000_000
    nextQueue.push({
      ...newQueueItem(),
      douban_ref: item.douban_ref,
      title: item.title,
      list,
      poster_url: item.poster_url,
      url: item.url,
      media_type: mediaTypeOf(list) ?? '',
      year: item.year,
      rating: parseRateOrZero(item.rate),
      entered_at: nowRfc3339,
      due_at: rfc3339(dueNanos),
      state: 'observing',
    })
  }
  const upcoming = lists.upcoming ?? null
  if (Array.isArray(upcoming)) {
    for (const item of upcoming) check(item, 'upcoming')
  }
  for (const [key, items] of Object.entries(lists)) {
    if (key === 'upcoming') continue
    if (Array.isArray(items)) {
      for (const item of items) check(item, key)
    }
  }
  const nextBlackState = { ...blackState }
  if (hits.size > 0) {
    nextBlackState.hits = (nextBlackState.hits ?? 0) + hits.size
    const recent = Array.isArray(nextBlackState.recent) ? [...nextBlackState.recent] : []
    for (const [title, keyword] of hits) {
      recent.unshift({ title, keyword, at: nowRfc3339 })
      if (recent.length > 20) recent.length = 20
    }
    nextBlackState.recent = recent
  }
  return { queueItems: nextQueue, blackState: nextBlackState }
}

/** charts.rs checkItem 入队时带的评分（filter.rs parse_rate；解析不出 = 0）。 */
export function parseRateOrZero(text) {
  const value = Number(String(text ?? '').trim())
  return Number.isFinite(value) ? value : 0
}
