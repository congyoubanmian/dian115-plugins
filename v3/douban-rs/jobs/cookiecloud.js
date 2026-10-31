// CookieCloud —— plugins/douban-rs/src/cookiecloud.rs 的 v3 形态。
//
// v3 优先走宿主内置 CookieCloud（ctx.cookiecloud('read', {domains:['douban.com']})，
// 宿主负责解密与配置）；用户自建 CookieCloud 服务（settings 里显式填写地址/UUID/口令）
// 时回退旧协议 GET {server}/get/{uuid} + 插件内解密（lib/cookiecloud-core）；
// 再回退手动粘贴 cookie。45 分钟 TTL 的解密缓存沿用旧契约（状态文档 cookie 字段）。

import { doubanCookieFromSnapshot, doubanCookieFromCloud, cookieCloudDecrypt, parseManualCookie, cookieCacheFresh as cacheFresh, MAX_COOKIE_CLOUD_BYTES } from '../lib/cookiecloud-core.js'
import { nowRfc3339, nowUnixNanos, parseRfc3339 } from '../lib/clock.js'
import { pathEscape } from '../lib/text.js'
import { doubanGet } from './httpx.js'
import { makeCrypto } from './crypto.js'

/** 拉取并解出豆瓣登录态 → {header, uid, source}；失败抛错（文案与旧实现一致）。 */
export async function doubanCookie(session, ctx) {
  const flat = session.flatSync()
  const cached = session.doc.cookie
  if (cookieCacheFresh(session)) {
    return { header: cached.header, uid: cached.uid, source: cached.source }
  }
  // ① 自建 CookieCloud（旧协议，显式配置了地址/UUID/口令时优先 —— 与旧版一致，
  //    自建服务的拉取失败不回退宿主内置，避免两份配置互相干扰）
  const hasLegacy =
    flat.cookiecloud_url !== '' && flat.cookiecloud_uuid !== '' && flat.cookiecloud_key !== ''
  if (hasLegacy) {
    try {
      const data = await cookieCloudPull(session, ctx, flat.cookiecloud_url, flat.cookiecloud_uuid, flat.cookiecloud_key)
      const extracted = doubanCookieFromCloud(data)
      if (extracted.header !== '') {
        session.doc.cookie = {
          header: extracted.header, uid: extracted.uid, source: 'cookiecloud', fetched_at: nowRfc3339(),
        }
        return { header: extracted.header, uid: extracted.uid, source: 'cookiecloud' }
      }
      throw new NoDoubanCookieError()
    } catch (error) {
      if (error instanceof NoDoubanCookieError) {
        throw new Error('CookieCloud 同步数据里没有豆瓣登录 cookie（浏览器需登录 douban.com）')
      }
      return manualFallback(flat, error)
    }
  }
  // ② 宿主内置 CookieCloud（v3 主路径；能力缺席才算"未配置"）
  if (typeof ctx?.cookiecloud === 'function') {
    let snapshot
    try {
      snapshot = await ctx.cookiecloud('read', { domains: ['douban.com'] })
    } catch (error) {
      return manualFallback(flat, error)
    }
    const extracted = doubanCookieFromSnapshot(snapshot)
    if (extracted.header !== '') {
      session.doc.cookie = {
        header: extracted.header, uid: extracted.uid, source: 'cookiecloud', fetched_at: nowRfc3339(),
      }
      return { header: extracted.header, uid: extracted.uid, source: 'cookiecloud' }
    }
    throw new Error('CookieCloud 同步数据里没有豆瓣登录 cookie（浏览器需登录 douban.com）')
  }
  // ③ 只有手动 cookie
  if (flat.manual_cookie !== '') {
    const manual = parseManualCookie(flat.manual_cookie)
    if (manual.header !== '') return { header: manual.header, uid: manual.uid, source: 'manual' }
    throw new Error('手动 cookie 里缺少 dbcl2')
  }
  throw new Error('未配置 CookieCloud 或手动豆瓣 cookie')
}

/** 解密成功但无豆瓣登录态的内部哨兵（旧实现的 terminal 分支）。 */
class NoDoubanCookieError extends Error {}

/** CookieCloud 拉取失败后的手动 cookie 回退（文案与旧实现一致）。 */
function manualFallback(flat, error) {
  if (flat.manual_cookie === '') {
    throw new Error(`CookieCloud 拉取失败: ${error.message}`)
  }
  const manual = parseManualCookie(flat.manual_cookie)
  if (manual.header !== '') return { header: manual.header, uid: manual.uid, source: 'manual' }
  throw new Error(`CookieCloud 拉取失败: ${error.message}；手动 cookie 也无效`)
}

/** 缓存新鲜度（45 分钟 TTL；lib/cookiecloud-core 的严格判定 + 会话时钟）。 */
export function cookieCacheFresh(session) {
  return cacheFresh(session.doc.cookie, nowUnixNanos(), parseRfc3339)
}

/**
 * 自建 CookieCloud 拉取（cookiecloud.rs cookie_cloud_pull）：
 * GET {server}/get/{uuid} → {encrypted, crypto_type} → 解密 → cookie_data 域名表。
 */
export async function cookieCloudPull(session, ctx, serverRaw, uuidRaw, key) {
  const server = String(serverRaw ?? '').trim().replace(/\/+$/, '')
  const uuid = String(uuidRaw ?? '').trim()
  if (server === '' || uuid === '') throw new Error('CookieCloud 地址或 UUID 未配置')
  const url = `${server}/get/${pathEscape(uuid)}`
  const got = await doubanGet(ctx, url, 'application/json')
  if (got.error) throw new Error(`CookieCloud 不可达: ${got.error}`)
  if (got.status === 200 && got.text.includes('Not Found')) {
    throw new Error('CookieCloud 无此 UUID 数据（浏览器扩展还没同步过）')
  }
  let result
  try {
    result = JSON.parse(got.text)
  } catch {
    throw new Error('CookieCloud 响应异常（UUID 不存在或服务端版本过旧）')
  }
  const encrypted = String(result?.encrypted ?? '')
  const cryptoType = String(result?.crypto_type ?? '')
  if (encrypted === '') throw new Error('CookieCloud 响应异常（UUID 不存在或服务端版本过旧）')
  if (encrypted.length > MAX_COOKIE_CLOUD_BYTES) {
    throw new Error(
      `同步数据过大(${(encrypted.length / 1_048_576).toFixed(1)}MB, 上限 ${Math.round(MAX_COOKIE_CLOUD_BYTES / 1024)}KB)：` +
        '请在浏览器 CookieCloud 扩展里把「需要同步的域名」设为 douban.com 后重新同步',
    )
  }
  const crypto = makeCrypto(ctx)
  const plainBytes = cookieCloudDecrypt(encrypted, cryptoType, uuid, key, crypto, crypto)
  let doc
  try {
    doc = JSON.parse(new TextDecoder().decode(plainBytes))
  } catch {
    throw new Error('CookieCloud 解密后解析失败')
  }
  const cookieData = doc && typeof doc === 'object' ? doc.cookie_data : null
  if (!cookieData || typeof cookieData !== 'object') {
    throw new Error('CookieCloud 解密后解析失败')
  }
  return cookieData
}

/** action cookiecloud-test（wish.rs action_cookie_cloud_test 的 v3 形态）。 */
export async function actionCookieCloudTest(session, ctx) {
  const flat = await session.settings()
  const hasHostCloud = typeof ctx?.cookiecloud === 'function'
  const hasLegacy =
    flat.cookiecloud_url !== '' && flat.cookiecloud_uuid !== '' && flat.cookiecloud_key !== ''
  if (!hasHostCloud && !hasLegacy) {
    return { status: 'failed', message: '请先在宿主配置 CookieCloud，或填写自建 CookieCloud 地址/UUID/密钥并保存' }
  }
  let data = null
  let domainCount = 0
  try {
    if (hasLegacy) {
      data = await cookieCloudPull(session, ctx, flat.cookiecloud_url, flat.cookiecloud_uuid, flat.cookiecloud_key)
      domainCount = Object.keys(data ?? {}).length
    } else {
      const snapshot = await ctx.cookiecloud('read', { domains: ['douban.com'] })
      const extracted = doubanCookieFromSnapshot(snapshot)
      domainCount = Array.isArray(snapshot?.domains) ? snapshot.domains.length : 0
      data = extracted
    }
  } catch (error) {
    return { status: 'failed', message: error.message }
  }
  const extracted = data && typeof data.header === 'string'
    ? data
    : doubanCookieFromCloud(data)
  if (extracted.header === '') {
    return {
      status: 'failed',
      message: `解密成功(同步 ${domainCount} 个域名, 豆瓣 cookie ${extracted.count} 个)，但没有 dbcl2——浏览器需要登录 douban.com`,
    }
  }
  // 测试成功顺便热身解密缓存 + 落盘
  session.doc.cookie = {
    header: extracted.header, uid: extracted.uid, source: 'cookiecloud', fetched_at: nowRfc3339(),
  }
  await session.persist()
  return {
    status: 'succeeded',
    message: `连接成功：同步 ${domainCount} 个域名，豆瓣登录有效 (uid=${extracted.uid})`,
    uid: extracted.uid,
  }
}

/** 兜底：错误信息里的响应体回显（旧 trunc 语义）。 */
export function truncateEcho(bytes) {
  return trunc(bytes)
}
