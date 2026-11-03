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

/** 登录态失效的统一提示（Cookie 过期/被登出/粘贴不完整都会落到这里）。 */
export const WISH_LOGIN_EXPIRED = '豆瓣登录态已失效，请在设置里重新粘贴浏览器里的豆瓣 Cookie（需含 dbcl2）'

/** 最终地址是否是豆瓣登录页（未登录的请求会被重定向到 accounts/passport）。 */
export function isDoubanLoginUrl(url) {
  const text = String(url ?? '')
  return /^https?:\/\/(accounts|passport)\.douban\.com\//i.test(text) || /^https?:\/\/[^/]*douban\.com\/(accounts\/)?(passport\/)?login/i.test(text)
}

/**
 * rexxar 错误体（{code, msg, localized_message}）→ 文案；不是错误体返回 null。
 * 豆瓣对过期/无效凭据回 code 103/106 或 msg 含 need_login / invalid_credencial。
 */
export function rexxarErrorMessage(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  if (Array.isArray(data.interests)) return null
  if (data.code === undefined && data.msg === undefined) return null
  const msg = String(data.msg ?? '')
  const code = Number(data.code ?? 0)
  if (code === 103 || code === 106 || /login|credencial|credential|token/i.test(msg)) return WISH_LOGIN_EXPIRED
  const localized = String(data.localized_message ?? '').trim()
  return `豆瓣返回错误 code=${code}${msg ? ` ${msg}` : ''}${localized ? `（${localized}）` : ''}`
}

/** 想看接口的 HTTP 失败 → 文案（401/403 视为登录态失效）。 */
export function wishHttpErrorMessage(status, error) {
  if (status === 401 || status === 403) {
    return `豆瓣拒绝访问（HTTP ${status}）：多半是登录态已失效，请在设置里重新粘贴豆瓣 Cookie；刚频繁请求过也可能是临时风控`
  }
  return `HTTP ${status}: ${error}`
}
