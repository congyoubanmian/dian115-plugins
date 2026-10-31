// TMDB 匹配与聚合订阅 —— plugins/douban-rs/src/subscribe.rs 纯函数部分的移植。
//
// 置信度口径照抄 Go（main.go:867）：标题/原名完全相同 +0.7，互相包含 +0.4，
// media_type 相符 +0.25，评分 >= 6 再 +0.05；没有任何标题命中 → 第一个候选 + 0 分。
// 阈值 0.5：低于它或 id == 0 一律 needs_review。

import { normalizeTitle } from './text.js'

/** 匹配置信度阈值（main.go:1391 / main.go:1745）。 */
export const CONFIDENCE_THRESHOLD = 0.5
/** 失败重试上限（main.go:1366 的 q.Attempt < 3）。 */
export const MAX_ATTEMPT = 3
/** 宿主订阅池列表查询的单次条数上限（main.go:960 同款 ?limit=200）。 */
export const HOST_POOL_INTENTS_LIMIT = 200

/** GET /api/subscribe/pool/intents?limit=<上限>（两处调用共用，防 drift）。 */
export function poolIntentsPath() {
  return `/api/subscribe/pool/intents?limit=${HOST_POOL_INTENTS_LIMIT}`
}

/** TMDB 搜索条目（main.go:822 TmdbItem；字段与 v3 openapi TmdbItem 一致）。 */
export function newTmdbItem() {
  return {
    id: 0, title: '', name: '', original_title: '', original_name: '', media_type: '',
    release_date: '', first_air_date: '', poster_path: '', backdrop_path: '', vote_average: 0,
  }
}

/** 从搜索响应提取 results（缺字段/类型不符 → 空数组；响应整体 null → 空结果不报错）。 */
export function parseTmdbSearchResult(data) {
  if (data === null || data === undefined) return []
  const results = Array.isArray(data?.results) ? data.results : []
  return results.map((raw) => ({
    ...newTmdbItem(),
    id: typeof raw?.id === 'number' ? Math.trunc(raw.id) : 0,
    title: String(raw?.title ?? ''),
    name: String(raw?.name ?? ''),
    original_title: String(raw?.original_title ?? ''),
    original_name: String(raw?.original_name ?? ''),
    media_type: String(raw?.media_type ?? ''),
    release_date: String(raw?.release_date ?? ''),
    first_air_date: String(raw?.first_air_date ?? ''),
    poster_path: String(raw?.poster_path ?? ''),
    backdrop_path: String(raw?.backdrop_path ?? ''),
    vote_average: typeof raw?.vote_average === 'number' ? raw.vote_average : 0,
  }))
}

/**
 * main.go:867 matchTMDB：返回最佳候选与置信度(0..1)。
 * results 为空 → 零值 + 0；一个候选都没有标题命中 → 第一个候选 + 0 分。
 */
export function matchTmdb(results, query, wantType) {
  if (!Array.isArray(results) || results.length === 0) return { best: newTmdbItem(), score: 0 }
  const q = normalizeTitle(query)
  let best = results[0]
  let bestScore = -1
  for (const candidate of results) {
    let score = 0
    let matched = false
    for (const raw of [candidate.title, candidate.name, candidate.original_title, candidate.original_name]) {
      const title = normalizeTitle(raw)
      if (title === q) {
        score += 0.7
        matched = true
      } else if (title !== '' && (title.includes(q) || q.includes(title))) {
        score += 0.4
        matched = true
      }
    }
    if (!matched) continue
    if (wantType !== '' && candidate.media_type === wantType) score += 0.25
    if (candidate.vote_average >= 6.0) score += 0.05
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  if (bestScore < 0) bestScore = 0
  return { best, score: bestScore }
}

/** main.go:908 tmdbTitle：title 为空时退回 name。 */
export function tmdbTitle(item) {
  return item?.title !== '' && item?.title ? item.title : String(item?.name ?? '')
}

/** main.go:915 tmdbYear：release_date 前 4 位，退回 first_air_date 前 4 位。 */
export function tmdbYear(item) {
  const release = String(item?.release_date ?? '')
  const firstAir = String(item?.first_air_date ?? '')
  if (release.length >= 4) return release.slice(0, 4)
  if (firstAir.length >= 4) return firstAir.slice(0, 4)
  return ''
}

/** main.go:929 poolIntentCreateRequest（字段就是 v3 openapi PoolIntentCreateRequest 的子集）。 */
export function buildIntentBody({ item, wantType, title, year, enabledSources }) {
  if (!item || item.id === 0) throw new Error('TMDB 条目无效')
  const season = item.media_type === 'movie' || wantType === 'movie' ? 0 : 1
  const body = {
    tmdb_id: item.id,
    media_type: item.media_type !== '' ? item.media_type : wantType,
    season,
    title,
    episode_scope_mode: 'follow',
  }
  if (year !== '') body.year = year
  if (item.poster_path !== '') body.poster_path = item.poster_path
  if (item.backdrop_path !== '') body.backdrop_path = item.backdrop_path
  if (Array.isArray(enabledSources) && enabledSources.length > 0) body.enabled_sources = enabledSources
  return body
}

/** main.go:941 poolIntentResult：创建订阅响应 → intent id（code != ok 报错文案与 Go 一致）。 */
export function parseIntentCreateResult(data) {
  const code = String(data?.code ?? '')
  if (code !== 'ok') {
    throw new Error(`创建订阅返回异常 code=${JSON.stringify(code)}`)
  }
  const id = data?.data?.id
  if (typeof id !== 'number') throw new Error('创建订阅响应解析失败')
  return Math.trunc(id)
}

/** main.go:948 poolIntentListResult：宿主订阅池列表 → 条目数组（解析失败返回 null）。 */
export function parseIntentList(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.data)) return null
  return data.data.map((raw) => ({
    id: typeof raw?.id === 'number' ? Math.trunc(raw.id) : 0,
    tmdb_id: typeof raw?.tmdb_id === 'number' ? Math.trunc(raw.tmdb_id) : 0,
    media_type: String(raw?.media_type ?? ''),
    title: String(raw?.title ?? ''),
    state: String(raw?.state ?? ''),
  }))
}

/** main.go:959 hostIntentExists 的判定段：同 (tmdb_id, media_type) 是否已有订阅。 */
export function intentExists(entries, tmdbId, mediaType) {
  for (const entry of entries ?? []) {
    if (entry.tmdb_id === tmdbId && (mediaType === '' || entry.media_type === mediaType)) {
      return { exists: true, id: entry.id }
    }
  }
  return { exists: false, id: 0 }
}
