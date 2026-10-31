// 想看同步 —— plugins/douban-rs/src/wish.rs 纯函数部分的移植。
//
// 只收 type 是 movie/tv 的条目：实测 type=tv 的响应里混进了 movie 和 book
// （夹具 wish_tv.json 里就有那条 book），书目拿去 TMDB 匹配会订阅到同名电影。

import { newWishItem } from './model.js'

/** 想看列表分页大小（wish.rs WISH_PAGE_SIZE）。 */
export const WISH_PAGE_SIZE = 50
/** 想看列表最多翻几页（wish.rs WISH_MAX_PAGES）。 */
export const WISH_MAX_PAGES = 4
/** 想看接口的 UA（wish.rs WISH_USER_AGENT，iPhone Safari）。 */
export const WISH_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
/** 想看接口的 referer（m 站登录态形态）。 */
export const WISH_REFERER = 'https://m.douban.com/mine/wish/'

/**
 * 豆瓣 rexxar 的 subject.id 时而字符串时而数字（wish.rs WishFlexString）：
 * 字符串原样、数字/布尔取原文、null/缺失 → 空串。
 */
export function flexId(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return ''
}

/** 想看接口响应里的单条兴趣 → WishItem（id 空白/type 非影视跳过；rating 取 subject.rating.value）。 */
export function wishItemsFromInterests(interests) {
  const items = []
  for (const interest of Array.isArray(interests) ? interests : []) {
    const subject = interest?.subject ?? {}
    const id = flexId(subject.id).trim()
    if (id === '') continue
    const kind = String(subject.type ?? '')
    if (kind !== 'movie' && kind !== 'tv') continue
    items.push({
      ...newWishItem(),
      douban_ref: id,
      title: String(subject.title ?? ''),
      year: String(subject.year ?? ''),
      type: kind,
      poster_url: String(subject.pic?.large ?? ''),
      rating: typeof subject.rating?.value === 'number' ? subject.rating.value : 0,
    })
  }
  return items
}

/** 想看接口响应 → {interests, total}（解析失败返回 null，文案由调用方给）。 */
export function parseInterestsResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  if (data.interests !== undefined && data.interests !== null && !Array.isArray(data.interests)) return null
  return {
    interests: Array.isArray(data.interests) ? data.interests : [],
    total: typeof data.total === 'number' ? data.total : 0,
  }
}

/** 想看列表请求 URL（fetchWish）：m.douban.com rexxar，按 uid/type/start/limit 分页。 */
export function wishInterestsUrl(uid, wantType, start) {
  return `https://m.douban.com/rexxar/api/v2/user/${uid}/interests?kind=mark&type=${wantType}&start=${start}&limit=${WISH_PAGE_SIZE}`
}
