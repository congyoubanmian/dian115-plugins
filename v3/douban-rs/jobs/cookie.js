// 豆瓣登录态 —— 手动 Cookie（宿主新规约禁止插件读取 CookieCloud）。
//
// 取值顺序：状态文档里的解析缓存（45 分钟 TTL）→ 设置里的手动 Cookie。
// 没有可用登录态时抛错，文案说清下一步，不静默降级。

import { parseManualCookie, cookieCacheFresh as cacheFresh } from '../lib/cookie.js'
import { nowRfc3339, nowUnixNanos, parseRfc3339 } from '../lib/clock.js'

/** 取豆瓣登录态 → {header, uid, source}；没有可用登录态时抛错。 */
export function doubanCookie(session) {
  const flat = session.flatSync()
  const cached = session.doc.cookie
  if (cookieCacheFresh(session)) {
    return { header: cached.header, uid: cached.uid, source: cached.source }
  }
  if (flat.manual_cookie !== '') {
    const manual = parseManualCookie(flat.manual_cookie)
    if (manual.header !== '') {
      session.doc.cookie = {
        header: manual.header, uid: manual.uid, source: 'manual', fetched_at: nowRfc3339(),
      }
      return { header: manual.header, uid: manual.uid, source: 'manual' }
    }
    throw new Error('手动 cookie 里缺少 dbcl2')
  }
  throw new Error('未配置手动豆瓣 cookie（请在设置里粘贴浏览器里的豆瓣 Cookie）')
}

/** 缓存新鲜度（45 分钟 TTL）。 */
export function cookieCacheFresh(session) {
  return cacheFresh(session.doc.cookie, nowUnixNanos(), parseRfc3339)
}
