// 订阅池（/api/subscribe/pool/intents）的解析与 PATCH 组包 —— 对照 intents.rs。
//
// 契约：GET 返回 PoolIntentListResult{code, data:[PoolIntent], counts}。解析仍按防御式：
// 根可以是数组（裸列表）或对象；对象里 `data` 优先，再退 items/records/list。
// 每条的 id / tmdb_id / total_episodes_known / season / media_type 缺一不可 —— 缺了就
// 跳过该条（不填默认值继续：0 集订阅会算出假缺口，season 缺省会打到特别篇上，
// media_type 缺省会把电影当追剧条目）。非空数组却一条都解不出 ⇒ 形状不匹配（整轮跳过）。

import { firstI64, firstOf, firstString, truncateUtf8 } from './loose.js'

/** 单页最大条数（schema 上限）。 */
export const LIMIT_MAX = 500
/** 一轮最多读几页（2000 条）。 */
export const PAGES_MAX = 4
/** 只有 media_type=tv 参与对齐。 */
export const MEDIA_TYPE = 'tv'

/** 该条是否可参与增方向对齐（expired / failed 只计数，不写）。 */
export function actionable(intent) {
  return intent.state !== 'expired' && intent.state !== 'failed'
}

/** 减方向建议只在"已追平/已落地"的状态上给。 */
export function trimCandidate(intent) {
  return intent.state === 'caught_up' || intent.state === 'landed'
}

/** 列表请求路径。 */
export function listPath(limit, offset) {
  return `/api/subscribe/pool/intents?media_type=${MEDIA_TYPE}&limit=${Math.min(limit, LIMIT_MAX)}&offset=${offset}`
}

/** PATCH 的路径。 */
export function patchPath(id) {
  return `/api/subscribe/pool/intents/${id}/episodes`
}

/** 幂等键：`chase-patch-<intent_id>-<from>-<to>-<run_seq>`（同一业务重试复用同值）。 */
export function patchIdempotencyKey(intentId, fromTotal, toTotal, runSeq) {
  return `chase-patch-${intentId}-${fromTotal}-${toTotal}-${runSeq}`
}

/** 原串能否被严格解析并逐字节往返一致（否则绝不写回）。 */
export function strictRoundtrip(text) {
  if (typeof text !== 'string' || text === '') return null
  try {
    const value = JSON.parse(text)
    const encoded = JSON.stringify(value)
    return encoded === text ? text : null
  } catch {
    return null
  }
}

/** 组装 PATCH body：默认只写 total_episodes；两个集数字符串仅在严格往返一致时带上。 */
export function patchBody(newTotal, needed, covered) {
  const body = { total_episodes: newTotal }
  const neededOk = needed ? strictRoundtrip(needed) : null
  const coveredOk = covered ? strictRoundtrip(covered) : null
  if (neededOk !== null) body.needed_episodes = neededOk
  if (coveredOk !== null) body.covered_episodes = coveredOk
  return body
}

/** 解析单条；关键字段缺失即 null。 */
export function parseIntent(element) {
  if (!element || typeof element !== 'object' || Array.isArray(element)) return null
  const id = firstI64(element, ['id', 'intent_id'])
  if (id === null) return null
  const tmdbId = firstI64(element, ['tmdb_id', 'tmdbId'])
  if (tmdbId === null) return null
  const totalKnown = firstI64(element, ['total_episodes_known', 'total_episodes'])
  if (totalKnown === null) return null
  const mediaType = firstString(element, ['media_type'])
  if (mediaType === null || mediaType === '') return null
  const season = firstI64(element, ['season'])
  if (season === null) return null
  const title = firstString(element, ['title', 'name']) ?? ''
  const state = firstString(element, ['state']) ?? ''
  const neededRaw = firstString(element, ['needed_episodes'])
  const coveredRaw = firstString(element, ['covered_episodes'])
  return {
    id,
    tmdb_id: tmdbId,
    season: Math.max(0, season),
    title: truncateUtf8(title, 160),
    total_known: Math.max(0, totalKnown),
    state,
    media_type: mediaType,
    needed_episodes: neededRaw && neededRaw !== '' ? neededRaw : null,
    covered_episodes: coveredRaw && coveredRaw !== '' ? coveredRaw : null,
  }
}

/**
 * 解析一页订阅池（信封 + 逐条）。
 * 返回 {items, skipped}；整体认不出时抛 Error（调用方记 debug 并跳过该轮）。
 */
export function parseList(value) {
  let array
  if (Array.isArray(value)) {
    array = value
  } else if (value && typeof value === 'object') {
    const code = typeof value.code === 'string' ? value.code : null
    if (code !== null && code !== 'ok') throw new Error(`宿主返回 code=${code}`)
    const located = firstOf(value, ['data', 'items', 'records', 'list'])
    if (Array.isArray(located)) {
      array = located
    } else if (located && typeof located === 'object') {
      const inner = firstOf(located, ['items', 'records', 'list'])
      if (Array.isArray(inner)) array = inner
      else throw new Error('订阅池列表结构未识别: data 不是数组')
    } else {
      throw new Error('订阅池列表结构未识别: 缺少 data 数组')
    }
  } else {
    throw new Error('订阅池响应不是对象或数组')
  }

  const items = []
  let skipped = 0
  for (const element of array) {
    const intent = parseIntent(element)
    if (intent) items.push(intent)
    else skipped += 1
  }
  if (items.length === 0 && skipped > 0) {
    throw new Error(`订阅池 ${skipped} 条条目全部缺少关键字段`)
  }
  return { items, skipped }
}
