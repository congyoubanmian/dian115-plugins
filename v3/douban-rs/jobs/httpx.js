// 出站 HTTP —— runtime.rs `httpGet` / wish.rs `httpGetWithCookie` 的 v3 形态。
//
// v3 的 ctx.http.request 走宿主统一会话（Cookie/代理/超时由宿主管理），这里只负责：
// - 固定请求头（豆瓣防盗链 Referer、桌面 UA、想看接口的 iPhone UA）；
// - Go `(body, status, err)` 三元组语义：传输失败 status=0；HTTP >= 400 → 空 body +
//   `HTTP <status>`；成功返回字节与文本。
// 文案与旧实现逐字一致（wish 的 `HTTP %d: %w`、CookieCloud 的 `CookieCloud 不可达: ...`
// 都依赖这里的 status/err 形态）。

import { goLossy } from '../lib/text.js'
import { base64Decode } from '../lib/base64.js'
import { WISH_USER_AGENT, WISH_REFERER } from '../lib/wish-core.js'

/** 豆瓣网页抓取的桌面 UA（runtime.rs BROWSER_USER_AGENT）。 */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
/** 豆瓣图片 CDN 防盗链 Referer（少了会 418）。 */
export const DOUBAN_REFERER = 'https://movie.douban.com/'

/**
 * 出站 GET 三元组（runtime.rs HttpResult）。
 * 返回 {body: Uint8Array, text: string, status, error: string|null}。
 */
export async function httpGet(ctx, url, { accept, userAgent = BROWSER_USER_AGENT, referer = DOUBAN_REFERER, cookie, timeoutSeconds } = {}) {
  const headers = { accept }
  if (userAgent) headers['user-agent'] = userAgent
  if (referer) headers.referer = referer
  if (cookie) headers.cookie = cookie
  const options = { url, method: 'GET', headers, response_type: 'base64' }
  if (timeoutSeconds) options.timeout_seconds = timeoutSeconds
  let result
  try {
    result = await ctx.http.request(options)
  } catch (error) {
    return { body: new Uint8Array(0), text: '', status: 0, error: error?.message || String(error) }
  }
  const status = typeof result?.status === 'number' ? result.status : 0
  if (status >= 400) {
    return { body: new Uint8Array(0), text: '', status, error: `HTTP ${status}` }
  }
  let bytes = new Uint8Array(0)
  if (result?.body_base64) {
    try {
      bytes = base64Decode(result.body_base64)
    } catch {
      return { body: new Uint8Array(0), text: '', status, error: 'base64 解码失败' }
    }
  } else if (typeof result?.body === 'string' && result.body !== '') {
    bytes = new TextEncoder().encode(result.body)
  }
  return { body: bytes, text: goLossy(bytes), status, error: null }
}

/** runtime.rs `http_get`：豆瓣网页/接口 GET（桌面 UA + 防盗链 Referer；accept 由调用方给）。 */
export function doubanGet(ctx, url, accept) {
  return httpGet(ctx, url, { accept })
}

/** wish.rs `http_get_with_cookie`：带 cookie 的 m 站 GET（iPhone UA + 想看 referer）。 */
export function doubanGetWithCookie(ctx, url, cookie) {
  return httpGet(ctx, url, {
    accept: 'application/json',
    userAgent: WISH_USER_AGENT,
    referer: WISH_REFERER,
    cookie,
  })
}
