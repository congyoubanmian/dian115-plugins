// 订阅过滤器 + 已删除不重订 —— plugins/douban-rs/src/filter.rs 纯函数部分的移植。
//
// deviations（与 filter.rs 模块头一致，v3 保持同款语义）：
// 1. 地区过滤只在详情已取到时生效（countries = null 表示详情没取到 → 放行 + region_skipped）；
// 2. 无评分条目在 min_rating > 0 时按"低于阈值"处理；
// 3. chart 口碑榜的 rate/year 实测常为空串 → 空串 = 没有数据，与第 2 条同口径；
// 4. min_year 按数值比较，不是字符串序；
// 5. "已完成"取宿主 PoolIntent.state 的 landed + caught_up（failed/expired 不算）。

/** 队列条目被过滤器拦下后的终态。 */
export const FILTERED_QUEUE_STATE = 'filtered'
/** 队列条目被墓碑拦下后的终态。 */
export const NO_RESUB_QUEUE_STATE = 'no_resub'
/** 宿主 PoolIntent.state 里代表"已完成/已落地"的取值。 */
export const COMPLETED_INTENT_STATES = ['landed', 'caught_up']
/** 手动订阅按钮遇到墓碑时的确认文案。 */
export const NO_RESUB_CONFIRM_TEXT = '该条目此前订阅过、现在已被你删除：自动订阅不会重订它，确认要手动订阅吗？'
/** 墓碑扫描的最小间隔（6 小时，纳秒）。 */
export const NO_RESUB_SCAN_MIN_INTERVAL_NANOS = 6 * 3_600_000_000_000
/** 墓碑值里的默认原因文案。 */
export const NO_RESUB_REASON = '宿主已无该 tmdb 订阅'

/** 被墓碑拦下时的日志/last_error 文案。 */
export function noResubGuardMessage(title) {
  return `已删除不重订，跳过自动订阅：${title}`
}

/** 地区判定降级时的日志文案。 */
export function regionDegradedLog(title) {
  return `地区过滤降级: 详情未取到，跳过地区判定（${title}）`
}

/** PoolIntent.state 是否属于"已完成/已落地"。 */
export function intentIsCompleted(state) {
  return COMPLETED_INTENT_STATES.includes(state)
}

/** `tmdb:<media_type>:<id>` → (media_type, tmdb_id)；形态不符返回 null。 */
export function parseTmdbRef(tmdbRef) {
  const text = String(tmdbRef ?? '')
  if (!text.startsWith('tmdb:')) return null
  const rest = text.slice('tmdb:'.length)
  const colon = rest.indexOf(':')
  if (colon <= 0) return null
  const mediaType = rest.slice(0, colon)
  const idText = rest.slice(colon + 1)
  if (mediaType === '') return null
  if (!/^-?[0-9]+$/.test(idText)) return null
  const id = Number(idText)
  if (!Number.isSafeInteger(id)) return null
  return { mediaType, id }
}

/** 历史条目是否是"订阅成功且有宿主 intent"的合格候选（判定流程第 1 条）。 */
export function historyEntryQualifies(entry) {
  return (
    entry?.action === 'subscribe' &&
    entry?.result === 'succeeded' &&
    entry?.intent_id !== 0 &&
    parseTmdbRef(entry?.tmdb_ref) !== null
  )
}

/** 地区白名单比对：任一项与 countries 里任一项精确相等即命中。 */
export function regionsMatch(countries, regions) {
  return (countries ?? []).some((country) => (regions ?? []).some((region) => region === country))
}

/** 豆瓣评分字符串 → 数值（ChartItem::rate；解析不出返回 null）。 */
export function parseRate(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

/** 豆瓣年份字符串 → 数值（只认开头的十进制数字；按数值比较）。 */
export function parseYear(text) {
  const match = /^[0-9]+/.exec(String(text ?? '').trim())
  if (!match) return null
  const value = Number(match[0])
  return Number.isSafeInteger(value) ? value : null
}

/** 过滤原因文案：评分（含"无评分"降级口径）。文案已冻结，测试按它断言。 */
export function reasonRating(rating, minRating) {
  if (rating !== null && rating !== undefined) {
    return `评分不足（${rating.toFixed(1)} < ${minRating.toFixed(1)}）`
  }
  return `无评分条目按低于阈值处理（疑似无数据, min_rating=${minRating.toFixed(1)}）`
}

/** 过滤原因文案：年份。 */
export function reasonYear(year, minYear) {
  if (year !== null && year !== undefined) return `年份不足（${year} < ${minYear}）`
  return `无年份条目按低于阈值处理（min_year=${minYear}）`
}

/** 过滤原因文案：地区（countries 为 null 表示详情没取到 —— 那是降级放行，不走这里）。 */
export function reasonRegion(countries, regions) {
  const left = !countries || countries.length === 0 ? '无地区数据' : countries.join('/')
  return `地区不符（${left} ∉ ${regions.join('/')}）`
}

/**
 * 过滤判定（filter.rs can_subscribe；三项都满足才放行）：
 * ① min_rating > 0 且 rating 为 null 或 < min_rating → 拦；
 * ② min_year > 0 且 year 解析不出或 < min_year → 拦；
 * ③ regions 非空：countries = null → 放行 + region_skipped；Some([]) → 拦；
 *    否则白名单与列表任一精确相等才放行。
 * candidate: {douban_ref, title, kind, year: string|null, rating: number|null, countries: string[]|null}
 */
export function canSubscribe(candidate, settings) {
  const minRating = settings.min_rating ?? 0
  const minYear = settings.min_year ?? 0
  if (minRating > 0) {
    const rating = candidate.rating
    if (rating === null || rating === undefined || !(rating >= minRating)) {
      return { allowed: false, reason: reasonRating(rating ?? null, minRating), region_skipped: false }
    }
  }
  if (minYear > 0) {
    const year = parseYear(candidate.year ?? '')
    if (year === null || year < minYear) {
      return { allowed: false, reason: reasonYear(year, minYear), region_skipped: false }
    }
  }
  const regions = settings.regions ?? []
  if (regions.length > 0) {
    if (candidate.countries === null || candidate.countries === undefined) {
      return { allowed: true, reason: null, region_skipped: true }
    }
    if (regionsMatch(candidate.countries, regions)) {
      return { allowed: true, reason: null, region_skipped: false }
    }
    return { allowed: false, reason: reasonRegion(candidate.countries, regions), region_skipped: false }
  }
  return { allowed: true, reason: null, region_skipped: false }
}

/** QueueItem 上的评分视图：入队时带上的 rating（0 = 未知 → null）。 */
export function queueItemRating(item) {
  return item?.rating > 0 ? item.rating : null
}

/** wish 想看条目 → 过滤候选（rating 0 = 未知）。 */
export function candidateFromWishItem(item) {
  return {
    douban_ref: item.douban_ref,
    title: item.title,
    kind: item.type,
    year: item.year,
    rating: item.rating > 0 ? item.rating : null,
    countries: null,
  }
}

/** 观察队列条目 → 过滤候选。 */
export function candidateFromQueueItem(item, rating) {
  return {
    douban_ref: item.douban_ref,
    title: item.title,
    kind: item.media_type,
    year: item.year,
    rating: rating ?? null,
    countries: null,
  }
}
