// 登录态解析 —— 只保留「手动粘贴 Cookie」这一条路径。
//
// 宿主新规约：插件不得读取 CookieCloud（那是跨应用的登录凭据），因此 v3 不再提供
// CookieCloud 同步入口，也不做自建 CookieCloud 的协议与解密；用户在设置里粘贴
// 浏览器里的豆瓣 Cookie 即可。45 分钟的解析缓存沿用旧契约（状态文档 cookie 字段）。

/** 手动 cookie → {header, uid}：必须有 dbcl2，否则视为未登录。 */
export function parseManualCookie(raw) {
  const text = String(raw ?? '').trim()
  if (text === '' || !text.includes('=')) return { header: '', uid: '' }
  let dbcl2 = ''
  for (const part of text.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1)
    if (name === 'dbcl2') dbcl2 = value
  }
  if (dbcl2 === '') return { header: '', uid: '' }
  const uid = dbcl2.split(':', 1)[0]
  return { header: text, uid }
}

/** 解析缓存 TTL（45 分钟）。 */
export const COOKIE_CACHE_TTL_MS = 45 * 60 * 1_000

/**
 * 缓存新鲜度（wish.rs `cookie_cache_fresh`）：header/uid 非空且 fetched_at 在 TTL 内。
 * fetched_at 解析失败一律不新鲜；时间戳在未来（时钟回拨）仍算新鲜。
 */
export function cookieCacheFresh(cache, nowNanos, parseRfc3339) {
  if (!cache || cache.header === '' || cache.uid === '') return false
  const fetchedAt = parseRfc3339(cache.fetched_at)
  if (fetchedAt === null) return false
  const elapsed = BigInt(nowNanos) - BigInt(fetchedAt)
  return elapsed < BigInt(COOKIE_CACHE_TTL_MS) * 1_000_000n
}
