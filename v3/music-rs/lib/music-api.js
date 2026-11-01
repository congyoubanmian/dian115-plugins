// 网易云 / QQ 音乐的网络层 —— 从 plugins/music-rs/src/{netease,qq}.rs 的网络函数移植。
//
// 传输层换成 v3 `ctx.http.request`（宿主发出、同一会话与代理；HTTP 错误状态作为
// status 返回，连接和超时抛错 —— 见 docs/network.md）。cookie 仍由插件 KV 持有
// （cookies.netease / cookies.qq），按旧契约手工构造 Cookie 头（neteaseCookieHeader /
// qqCookieHeader），与 Rust 版逐字节同形。页面与后台共用本文件；`deps = {http, kv, crypto}`
// 由调用方装配（页面无 crypto，但页面不需要取链）。
//
// 扫码登录走宿主 session（v3-kit/docs/network.md:15「插件内不同 session 独立记忆登录态」）：
// 登录链路的临时 Cookie（网易云 unikey 会话、QQ 的 qrsig 与 graph.qq.com 授权 Cookie）
// 只落在宿主 session jar 里，不进插件 KV、不进日志、不回显页面；插件 KV 里只保存
// 换到的登录凭据（网易云 MUSIC_U / QQ 的 uin+musickey）。

import {
  SEARCH_URL, QR_UNIKEY_URL, QR_LOGIN_URL, SONG_URL_API, ACCOUNT_URL, USER_PLAYLIST_URL,
  PLAYLIST_DETAIL_URL, SONG_DETAIL_URL, CHROME_UA, DESKTOP_UA, LOGIN_PAGE, MUSIC_REFERER,
  QR_REFERER, FORM_CONTENT_TYPE, LEVELS, NETEASE_COOKIE_NAMES,
  eapiParams, songUrlPayload, requestId, levelLadder,
} from './eapi.js'
import {
  parseCookieString, parseSetCookie, setCookieLines, neteaseCookieHeader, qqCookieHeader,
  uinFromCookies, NETEASE_COOKIE_KEY, QQ_COOKIE_KEY, mergeJars,
} from './cookies.js'
import { queryEscape, formEncode, ipHeaders, nowNanos, trunc } from './encoding.js'
import {
  mapSearchSong, createPlaylistIndex, parsePlaylistDetail, slicePlaylistPage,
  songDetailForm, parseSongDetail, playlistPage,
} from './netease.js'
import {
  CHROME_UA as QQ_UA, QQ_API_UA, QQ_MUSICU, QQ_SEARCH_API, qualityLadder, guidFromNanos,
  songUrlRequestBody, songDetailRequestBody, parseQqSongDetail, parseVkeyResponse, parseSearch,
  NO_LINK_ERROR, QQ_AUTH_UA, QQ_QR_TTL_SECS, QQ_AUTHORIZE_ENDPOINT, QQ_CHECK_SIG_HOST,
  QQ_CHECK_SIG_PATH, QQ_LOGIN_JUMP_HOST, QQ_LOGIN_JUMP_PATH, QQ_AUTH_COOKIE_DOMAIN, QQ_GTK_SEED,
  authorizeForm, base64Bytes, hash33Seed, isPng, parseAuthorizeRedirect, parseQqQrStatus,
  parseQQLoginResponse, ptqrLoginUrl, ptqrShowUrl, qqLoginRequestBody, randomHex, randomUuid,
  trustedLoginUrl,
  // 歌单 / 每日推荐 / 我喜欢（musicu）
  authenticatedComm, musicuRequestBody, parseMusicuResponse, checkDissDataStatus, qqHasMore,
  ownedPlaylistsParam, favoritePlaylistsParam, dailySongsParam, likedSongsParam,
  publicPlaylistSongsParam, ownedPlaylistSongsParam, parseQqPlaylistList, parseQqSongList,
  parseQqPlaylistInfo, qqTargetKind, numberField,
  QQ_MODULE_PLAYLIST_BASE_READ, QQ_MODULE_PLAYLIST_FAV_READ, QQ_MODULE_AI_DISS_INFO,
  QQ_MODULE_DISS_INFO, QQ_METHOD_GET_PLAYLIST_BY_UIN, QQ_METHOD_GET_PLAYLIST_FAV_INFO,
  QQ_METHOD_UNIFORM_GET_DISSINFO, QQ_METHOD_CGI_GET_DISS,
  QQ_FAV_PAGE_SIZE, QQ_FAV_MAX_OFFSET, QQ_LIKED_MAX_OFFSET, QQ_SONG_PAGE_SIZE,
} from './qq.js'
import { PLAYLIST_PAGE_SIZE } from './constants.js'

/** 单曲取链结果（Go neteaseSongURL 的返回元组；SongUrl 契约字段 url/ext/level/size）。 */
export const SONG_URL_FALLBACK_EXT = 'flac'

/** 宿主 session 名：每条登录链路一个独立 jar，登录态不与业务请求串味。 */
export const NETEASE_LOGIN_SESSION = 'netease'
export const QQ_LOGIN_SESSION = 'qq'
/** QQ 音乐换凭据专用 session：这一步绝不能带 graph.qq.com 的全局授权 Cookie。 */
export const QQ_MUSICU_SESSION = 'qq-musicu'

// ─────────────────────────── cookie 读写 ───────────────────────────

/** 从 KV 读会话 cookie（键 cookies.<source>）；缺失/损坏 → 空表。 */
export async function loadCookies(kv, source) {
  const raw = await kv.get(source === 'qq' ? QQ_COOKIE_KEY : NETEASE_COOKIE_KEY)
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

/** 合并写入会话 cookie（旧值保留、新值覆盖）。 */
export async function saveCookies(kv, source, cookies) {
  const key = source === 'qq' ? QQ_COOKIE_KEY : NETEASE_COOKIE_KEY
  const merged = mergeJars(await loadCookies(kv, source), cookies)
  await kv.set(key, merged)
  return merged
}

// ─────────────────────────── 传输小工具 ───────────────────────────

/** 一次 ctx.http.request：返回 {status, headers, text, url, bodyBase64}；网络失败抛错
 *  （与旧 host.call 语义一致）。
 *
 *  session：宿主按 session 独立记忆 Cookie（登录链路各自一个）。
 *  followRedirects：false 时拿原始 3xx（OAuth 授权要读 location 头自己校验）；
 *  默认交给宿主跟随，这样重定向每一跳的 Set-Cookie 都会记进 session jar（network.md:15）。
 *  responseType：'base64' 取二进制（QQ 的 PNG 二维码）。
 *  url：响应自报的 URL（跟随跳转后的落点）。重定向白名单一律以**响应的 location 头**
 *  为准 —— 跟随后再校验就晚了，白名单外的目标已经被请求过。 */
export async function httpRequest(deps, {
  method = 'GET', url, headers = {}, body = null, timeoutSeconds = 120,
  session = '', followRedirects = null, maxRedirects = null, responseType = 'text',
}) {
  const options = {
    url,
    method,
    headers,
    timeout_seconds: timeoutSeconds,
    response_type: responseType,
  }
  if (body !== null && body !== undefined) options.body = body
  if (session) options.session = session
  if (followRedirects !== null) options.follow_redirects = followRedirects
  if (maxRedirects !== null) options.max_redirects = maxRedirects
  const result = await deps.http.request(options)
  return {
    status: result.status,
    headers: result.headers ?? {},
    text: result.body ?? '',
    url: result.url ?? url,
    bodyBase64: result.body_base64 ?? '',
  }
}

/** POST x-www-form-urlencoded（Go hostCall + base64 请求体的等价形态：body 字符串 +
 *  content-type 头，编码用 Go QueryEscape 语义的 formEncode，逐字节对齐 Rust 版）。 */
export function postForm(deps, url, headers, form, options = {}) {
  return httpRequest(deps, {
    method: 'POST',
    url,
    headers: { ...headers, 'content-type': FORM_CONTENT_TYPE },
    body: form,
    ...options,
  })
}

/** 读宿主 session 里对某个 URL 生效的 Cookie（{name,value,...} 列表）。
 *  宿主没提供 cookies()（老宿主）时返回空数组，调用方走各自的兜底分支。 */
export async function sessionCookies(deps, url, session) {
  if (typeof deps?.http?.cookies !== 'function') return []
  try {
    const list = await deps.http.cookies({ url, session })
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** 从宿主 Cookie 列表里取某个名字的值（取不到返回空串）。 */
export function cookieValue(cookies, name) {
  for (const cookie of cookies ?? []) {
    if (cookie?.name === name && typeof cookie.value === 'string' && cookie.value !== '') {
      return cookie.value
    }
  }
  return ''
}

/** Cookie 的 Domain 归一化：去首尾空白与开头的 `.`（通配形态），转小写。 */
function normalizeCookieDomain(domain) {
  return String(domain ?? '').trim().replace(/^\./, '').toLowerCase()
}

/**
 * 从宿主 Cookie 列表里取某个名字的值，且 Domain 必须精确等于 domain。
 *
 * 宿主 jar 语义是「对该 URL 生效的全部 Cookie」（network.md:15），更宽的域
 * （如 `.qq.com`）里的同名 Cookie 也会被返回 —— 那不是我们要的凭据。
 * 参考实现 auth.go:284-295 的 authCookie 要求 Domain 精确等于 graph.qq.com。
 * 域对不上就当没有（取不到返回空串）。
 */
export function cookieValueForDomain(cookies, name, domain) {
  const want = normalizeCookieDomain(domain)
  if (!want) return ''
  for (const cookie of cookies ?? []) {
    if (cookie?.name !== name) continue
    if (typeof cookie.value !== 'string' || cookie.value === '') continue
    if (normalizeCookieDomain(cookie?.domain) !== want) continue
    return cookie.value
  }
  return ''
}

/**
 * 从响应的 Set-Cookie 头里取某个名字的值，且 Domain 属性精确等于 domain。
 *
 * 取不到返回空串。宿主把 Domain 属性带在 Set-Cookie 行里（形如
 * `p_uin=o001; Domain=graph.qq.com; Path=/`）；没有 Domain 属性的行按
 * 「域对不上」处理，不作数（与 authCookie 的精确比较一致）。
 */
export function setCookieValueForDomain(headers, name, domain) {
  const want = normalizeCookieDomain(domain)
  if (!want) return ''
  for (const line of setCookieLines(headers ?? {})) {
    const pair = parseSetCookie(line)
    if (!pair || pair[0] !== name || pair[1] === '') continue
    const matched = String(line).match(/;\s*domain\s*=\s*([^;]+)/i)
    if (!matched) continue
    if (normalizeCookieDomain(matched[1]) !== want) continue
    return pair[1]
  }
  return ''
}

/** 清空宿主 session 的 Cookie（宿主没有单条删除 API，只能整段 replace —— 见 network.md:24）。 */
export async function clearSessionCookies(deps, session) {
  if (typeof deps?.http?.importCookies !== 'function') return false
  try {
    await deps.http.importCookies({ session, cookies: [], replace: true })
    return true
  } catch {
    return false
  }
}

/** 响应 JSON 解析（失败抛错，文案与 Rust 版同前缀）。 */
export function parseJson(text, message) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${message}: ${error.message}`)
  }
}

/** 从响应头里取某个头（大小写不敏感；宿主把值给成字符串数组）。 */
function responseHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return ''
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue
    return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')
  }
  return ''
}

/**
 * 图片经宿主 HTTP 取回并转成 data URL（歌单封面用）。
 *
 * 页面不把第三方图片地址直接绑到 <img>：离线/CSP/代理环境下浏览器会绕过宿主直连
 * 网易云 CDN。response_type:'base64' 让宿主带回二进制，再由页面拼 data URL。
 */
export async function imageDataUrl(deps, url) {
  const target = typeof url === 'string' ? url.trim() : ''
  if (!/^https?:\/\//i.test(target)) throw new Error('图片地址无效')
  const response = await deps.http.request({
    url: target,
    method: 'GET',
    headers: {
      referer: MUSIC_REFERER,
      'user-agent': CHROME_UA,
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
    response_type: 'base64',
    timeout_seconds: 30,
    cache_seconds: 86400,
  })
  const status = Number(response?.status ?? 0)
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    throw new Error(`图片获取失败: HTTP ${status || '?'}`)
  }
  const raw = response?.body_base64
  let body = ''
  if (typeof raw === 'string') {
    body = raw
  } else if (raw instanceof Uint8Array) {
    let binary = ''
    for (const byte of raw) binary += String.fromCharCode(byte)
    body = btoa(binary)
  }
  if (body === '') throw new Error('图片响应为空')
  const contentType = responseHeader(response?.headers, 'content-type') || 'image/jpeg'
  const mime = contentType.split(';')[0].trim().toLowerCase()
  return `data:${mime.startsWith('image/') ? mime : 'image/jpeg'};base64,${body}`
}

// ─────────────────────────── 网易云 ───────────────────────────

/** 单曲搜索（Go neteaseSearch）：page 从 1 起，每页 30 条。返回 {songs, total, page}。 */
export async function neteaseSearch(deps, query, page) {
  const offset = (page - 1) * 30
  const form = formEncode([
    ['s', query],
    ['type', '1'],
    ['limit', '30'],
    ['offset', String(offset)],
  ])
  const response = await postForm(deps, SEARCH_URL, {
    'user-agent': CHROME_UA,
    referer: MUSIC_REFERER,
    ...ipHeaders(),
  }, form)
  const parsed = parseJson(response.text, '搜索解析失败')
  const songs = (Array.isArray(parsed?.result?.songs) ? parsed.result.songs : []).map(mapSearchSong)
  return { songs, total: parsed?.result?.songCount ?? 0, page }
}

/** 扫码创建（Go neteaseQRCreate）：返回 {key, qr_content}（qr_content 是登录页 URL，前端自己画）。
 *  走宿主 session 'netease'，登录态 Cookie 由宿主按会话记住。 */
export async function neteaseQrCreate(deps) {
  const form = formEncode([['type', '3']])
  const response = await postForm(deps, QR_UNIKEY_URL, {
    'user-agent': DESKTOP_UA,
    referer: QR_REFERER,
    ...ipHeaders(),
  }, form, { session: NETEASE_LOGIN_SESSION })
  const out = parseJson(response.text, '获取二维码失败')
  const unikey = typeof out?.unikey === 'string' ? out.unikey : ''
  if (out?.code !== 200 || !unikey) throw new Error('获取二维码失败')
  return { key: unikey, qr_content: `${LOGIN_PAGE}?codekey=${queryEscape(unikey)}` }
}

/** 网易云登录 Cookie 的三个来源：响应体 cookie → 宿主 session jar → 响应头 Set-Cookie。
 *  宿主 jar 里可能有 interface.music.163.com 的 host-only Cookie，所以两个域名都读一遍。 */
async function neteaseLoginCookies(deps, response, out) {
  let cookies = parseCookieString(typeof out?.cookie === 'string' ? out.cookie : '')
  for (const url of ['https://music.163.com', 'https://interface.music.163.com']) {
    for (const cookie of await sessionCookies(deps, url, NETEASE_LOGIN_SESSION)) {
      const name = String(cookie?.name ?? '')
      if (!NETEASE_COOKIE_NAMES.includes(name)) continue
      if (typeof cookie?.value !== 'string' || cookie.value === '') continue
      cookies = mergeJars(cookies, { [name]: cookie.value })
    }
  }
  for (const line of setCookieLines(response.headers)) {
    const pair = parseSetCookie(line)
    if (pair) cookies = mergeJars(cookies, { [pair[0]]: pair[1] })
  }
  return cookies
}

/** 扫码轮询（Go neteaseQRPoll）：返回 {status, message, code, logged_in?}。
 *  803 时把登录 cookie 落 KV（响应体 / 宿主 session jar / Set-Cookie 三个来源取并集）；
 *  三个来源都拿不到时给出引导文案，绝不静默保存空表冒充登录成功。 */
export async function neteaseQrPoll(deps, key) {
  const form = formEncode([['key', key], ['type', '3']])
  const response = await postForm(deps, QR_LOGIN_URL, {
    'user-agent': DESKTOP_UA,
    referer: QR_REFERER,
    ...ipHeaders(),
  }, form, { session: NETEASE_LOGIN_SESSION })
  // Go netease.go:214 忽略解包错误 → 零值（code=0, status=""）。
  const out = (() => {
    try { return JSON.parse(response.text) } catch { return {} }
  })()
  const code = typeof out?.code === 'number' ? out.code : 0
  const message = typeof out?.message === 'string' ? out.message : ''
  const status = { 800: 'expired', 801: 'waiting', 802: 'scanned', 803: 'success' }[code] ?? ''
  const result = { status, message, code }
  if (code !== 803) return result
  const cookies = await neteaseLoginCookies(deps, response, out)
  const hasLogin = (cookies.MUSIC_U && cookies.MUSIC_U !== '') || (cookies.MUSIC_A && cookies.MUSIC_A !== '')
  if (hasLogin) {
    // 落盘失败就不能算登录成功：KV 里一条凭据都没进去，报「登录成功」会让页面弹出
    // 「登录态已保存」，刷新后标签又变回未登录（与 QQ 链路 persistQqCredential 一致：
    // 存不进去就抛错，poll 失败即不返回 success）。
    try {
      await saveCookies(deps.kv, 'netease', cookies)
    } catch (error) {
      throw new Error(`扫码成功，但保存登录态失败：${error?.message ?? error}`)
    }
    result.logged_in = true
  } else {
    result.logged_in = false
    result.message =
      '扫码成功，但宿主会话里没有 MUSIC_U/MUSIC_A，无法自动保存登录态。请在浏览器登录 ' +
      'music.163.com 后复制 Cookie 头，用登录卡的「手动粘贴 Cookie」完成登录。'
  }
  return result
}

/** 登录账号（sidecar server.mjs:281-291 neteaseAccount）：POST 空 body 拿 profile.userId。 */
async function neteaseAccount(deps, cookies) {
  const response = await postForm(deps, ACCOUNT_URL, playlistFormHeaders(cookies), '')
  const parsed = parseJson(response.text, '账号解析失败')
  const userId = parsed?.profile?.userId
  if (!userId) throw new Error('未登录或登录态失效')
  return { userId, nickname: parsed?.profile?.nickname ?? '' }
}

/** 歌单链路 GET 的请求头（sidecar server.mjs:297-302/312-316：referer + UA + cookie + IP 头）。 */
function playlistHeaders(cookies) {
  return {
    referer: MUSIC_REFERER,
    'user-agent': CHROME_UA,
    cookie: neteaseCookieHeader(cookies),
    ...ipHeaders(),
  }
}

/** 歌单链路 POST 的请求头：补 content-type（sidecar server.mjs:282-288/326-332）。 */
function playlistFormHeaders(cookies) {
  return { ...playlistHeaders(cookies), 'content-type': FORM_CONTENT_TYPE }
}

/** 我的歌单列表（sidecar server.mjs:293-307 neteasePlaylists）：先拿 uid，再从 offset 0
 *  起按 100 一页翻 user/playlist（上限 2000）。返回 {playlists, count}。 */
export async function neteasePlaylists(deps) {
  const cookies = await loadCookies(deps.kv, 'netease')
  const { userId, nickname } = await neteaseAccount(deps, cookies)
  const out = []
  let offset = 0
  while (offset < 2000) {
    const url = `${USER_PLAYLIST_URL}?uid=${userId}&limit=100&offset=${offset}&includeVideo=true`
    const response = await httpRequest(deps, { url, headers: playlistHeaders(cookies) })
    const parsed = parseJson(response.text, '歌单解析失败')
    const list = Array.isArray(parsed?.playlist) ? parsed.playlist : []
    for (const item of list) {
      // `p.creator?.nickname || nickname`：空串/缺失都回退登录昵称。
      const creator = (typeof item?.creator?.nickname === 'string' && item.creator.nickname !== '')
        ? item.creator.nickname
        : nickname
      out.push({
        id: item?.id === undefined || item?.id === null ? '' : String(item.id),
        name: item?.name ?? '',
        cover: item?.coverImgUrl ?? '',
        count: item?.trackCount ?? 0,
        creator,
      })
    }
    if (list.length < 100) break
    offset += 100
  }
  return { playlists: out, count: out.length }
}

/** 一次 v6 全量索引（0.3.15 带缓存形态）：整批只 GET 一次，之后各页纯本地切片。 */
export async function neteasePlaylistIndex(deps) {
  const cookies = await loadCookies(deps.kv, 'netease')
  const url = `${PLAYLIST_DETAIL_URL}?id=${queryEscape(String(deps.playlistId))}&n=0`
  const response = await httpRequest(deps, { url, headers: playlistHeaders(cookies) })
  const parsed = parsePlaylistDetail(response.text)
  if (parsed.error) throw new Error(parsed.error)
  return createPlaylistIndex(parsed.index)
}

/** 索引当页歌曲：本地切片 + 每 200 个 id 一批 POST v3 song/detail。 */
export async function neteasePlaylistSongsFromIndex(deps, index, page, pageSize) {
  const pageIds = slicePlaylistPage(index, page, pageSize)
  if (!pageIds.length) return playlistPage(index.name, index.total, page, pageSize, [])
  const cookies = await loadCookies(deps.kv, 'netease')
  const songs = []
  for (let at = 0; at < pageIds.length; at += 200) {
    const chunk = pageIds.slice(at, at + 200)
    const response = await postForm(deps, SONG_DETAIL_URL, playlistFormHeaders(cookies), songDetailForm(chunk))
    const parsed = parseSongDetail(response.text)
    if (parsed.error) throw new Error(parsed.error)
    songs.push(...parsed.songs)
  }
  return playlistPage(index.name, index.total, page, pageSize, songs)
}

/** 歌单的歌曲页（对外行为与 0.3.14 逐字不变：1×v6 + 当页 v3）。 */
export async function neteasePlaylistSongs(deps, playlistId, page, pageSize) {
  const index = await neteasePlaylistIndex({ ...deps, playlistId })
  return neteasePlaylistSongsFromIndex(deps, index, page, pageSize)
}

/** 按音质向下逐级取链（Go neteaseSongURL）：level 命中 LEVELS 就从那一档开始，
 *  未命中（含空串）从最高档开始；每档发一次 eapi 请求，解包失败 / data 为空 /
 *  直链不以 http 开头都继续下一档；网络错误立即返回。 */
export async function neteaseSongUrl(deps, songId, level) {
  const cookies = await loadCookies(deps.kv, 'netease')
  const headers = {
    'user-agent': CHROME_UA,
    cookie: neteaseCookieHeader(cookies),
  }
  let lastTail = ''
  for (const current of levelLadder(level)) {
    const payload = songUrlPayload(songId, current)
    const params = eapiParams(SONG_URL_API, payload, deps.crypto)
    const form = formEncode([['params', params]])
    const response = await postForm(deps, SONG_URL_API, headers, form)
    lastTail = trunc(response.text)
    let data
    try {
      data = JSON.parse(response.text)?.data
    } catch {
      continue // Go netease.go:158：解不出来就试下一档。
    }
    const item = Array.isArray(data) ? data[0] : null
    if (!item) continue
    const url = typeof item.url === 'string' ? item.url : ''
    if (!url.startsWith('http')) continue
    const ext = typeof item.type === 'string' && item.type !== '' ? item.type : SONG_URL_FALLBACK_EXT
    return {
      url,
      ext,
      level: typeof item.level === 'string' ? item.level : '',
      size: typeof item.size === 'number' ? item.size : 0,
    }
  }
  throw new Error(`所有音质均未获取到链接（需要 SVIP 且歌曲有对应音源）; 最后响应: ${lastTail}`)
}

/** 取链请求参数（测试与 pump 共用）：payload + params。 */
export function neteaseEapiParams(crypto, songId, level) {
  return eapiParams(SONG_URL_API, songUrlPayload(songId, level), crypto)
}

/** 音质阶梯（re-export 供 pump/UI 共用）。 */
export { LEVELS, levelLadder, requestId, nowNanos }

// ─────────────────────────── QQ ───────────────────────────

/** 扫码会话表：key → {qrsig, expiresAt}。
 *  qrsig 是 QQ 下发的签名 Cookie，只留在宿主 session 与这张表里，
 *  绝不进返回值、日志或错误消息（页面拿到的 key 是不透明随机串）。 */
const qqQrSessions = new Map()

/** 清掉过期的扫码会话（新建二维码时顺手清，避免表无限增长）。 */
function sweepQqQrSessions() {
  const now = Date.now()
  for (const [key, entry] of qqQrSessions) {
    if (now > entry.expiresAt) qqQrSessions.delete(key)
  }
}

/** 扫码会话过期清理（读取时顺手清掉过期的）。 */
function takeQqQrSession(key) {
  const id = String(key ?? '')
  const entry = qqQrSessions.get(id)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    qqQrSessions.delete(id)
    return null
  }
  return entry
}

/** 从宿主 session（或响应头）里取 qrsig；取不到返回空串。 */
async function readQqQrSig(deps, headers) {
  const cookies = await sessionCookies(deps, 'https://xui.ptlogin2.qq.com', QQ_LOGIN_SESSION)
  const fromSession = cookieValue(cookies, 'qrsig')
  if (fromSession) return fromSession
  // 兜底：宿主若把 Set-Cookie 透传出来，也能直接取到。
  for (const line of setCookieLines(headers ?? {})) {
    const pair = parseSetCookie(line)
    if (pair && pair[0] === 'qrsig' && pair[1]) return pair[1]
  }
  return ''
}

/**
 * QQ 扫码取码（参考实现 auth.go 的 QRKey）：返回 {key, image, expires_in}。
 *
 * image 是 PNG 的 data URL（QQ 的二维码是图片，不能像网易云那样本地编码）；
 * key 是不透明随机串（二维码签名 qrsig 属于 Cookie，不回显页面，页面拿它轮询即可）。
 * 取不到签名或图片不是 PNG 时明确报错，绝不返回半成品。
 */
export async function qqQrCreate(deps) {
  sweepQqQrSessions()
  const response = await httpRequest(deps, {
    method: 'GET',
    url: ptqrShowUrl(randomHex(8)),
    headers: { 'user-agent': QQ_AUTH_UA, referer: 'https://xui.ptlogin2.qq.com/' },
    session: QQ_LOGIN_SESSION,
    responseType: 'base64',
  })
  const status = Number(response.status ?? 0)
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    throw new Error(`获取二维码失败: HTTP ${status || '?'}`)
  }
  if (!isPng(base64Bytes(response.bodyBase64))) {
    throw new Error('登录服务返回的二维码图片无效（Q202），请刷新重试')
  }
  const qrsig = await readQqQrSig(deps, response.headers)
  if (!qrsig) throw new Error('QQ 未返回二维码签名（Q201），请刷新重试')
  const key = randomHex(16)
  qqQrSessions.set(key, { qrsig, expiresAt: Date.now() + QQ_QR_TTL_SECS * 1000 })
  return {
    key,
    image: `data:image/png;base64,${response.bodyBase64}`,
    expires_in: QQ_QR_TTL_SECS,
  }
}

/**
 * QQ 扫码轮询（参考实现 auth.go 的 QRCheck）：返回 {status, message, logged_in}。
 *
 * waiting/scanned/expired 直接回状态；success 时走完整授权链
 * （check_sig → login_jump → authorize → musicu QQLogin）换 QQ 音乐凭据并落 KV。
 */
export async function qqQrPoll(deps, key) {
  const entry = takeQqQrSession(key)
  // 页面刷新后内存表会丢，退回宿主 session 里仍在的 qrsig。
  const qrsig = entry?.qrsig || (await readQqQrSig(deps, null))
  if (!qrsig) throw new Error('二维码已失效（Q203），请刷新重试')
  const response = await httpRequest(deps, {
    method: 'GET',
    url: ptqrLoginUrl(qrsig),
    headers: {
      'user-agent': QQ_AUTH_UA,
      referer: 'https://xui.ptlogin2.qq.com/',
      cookie: `qrsig=${qrsig}`,
    },
    session: QQ_LOGIN_SESSION,
  })
  const parsed = parseQqQrStatus(response.text)
  if (parsed.error) throw new Error(parsed.error)
  if (parsed.status !== 'success') {
    return { status: parsed.status, message: parsed.message ?? '', logged_in: false }
  }
  const warning = await exchangeQqLogin(deps, parsed.check_sig)
  const result = { status: 'success', message: '登录成功', logged_in: true }
  // 登录本身成功但收尾没做完（如宿主 session 清不掉）——如实带一个告警给页面。
  if (warning) result.warning = warning
  return result
}

/** 授权链：check_sig → login_jump → authorize → musicu QQLogin → 落 KV → 清宿主 session。
 *  返回空串表示一切正常；返回非空串是给用户看的告警（如宿主 session 清不掉）。 */
async function exchangeQqLogin(deps, checkSigUrl) {
  // 1) check_sig：目标必须是白名单里的 host + path，否则直接拒绝（不发请求）。
  const sig = trustedLoginUrl(checkSigUrl, QQ_CHECK_SIG_HOST, QQ_CHECK_SIG_PATH)
  if (!sig) throw new Error('QQ 授权跳转目标异常')
  // 这一步必须关掉自动重定向：宿主默认跟随 Location（network.md:13「follow_redirects:false
  // 返回原始 3xx，max_redirects 默认 10」），那样白名单外的目标在校验之前就已经被请求过。
  // 参考实现 auth.go:61 同样把 CheckRedirect 设成 http.ErrUseLastResponse：拿原始 302 →
  // 校验 Location 头 → 自己显式 GET。
  const jumped = await httpRequest(deps, {
    method: 'GET',
    url: sig.toString(),
    headers: { 'user-agent': QQ_AUTH_UA, referer: 'https://xui.ptlogin2.qq.com/' },
    session: QQ_LOGIN_SESSION,
    followRedirects: false,
  })
  // 跳转目标必须还是 graph.qq.com 的 login_jump；不合法就不发任何请求。
  const landed = trustedLoginUrl(responseHeader(jumped.headers, 'location'), QQ_LOGIN_JUMP_HOST, QQ_LOGIN_JUMP_PATH)
  if (!landed) throw new Error('QQ 授权跳转目标异常')

  // 2) 授权 Cookie（graph.qq.com 域）：优先取 check_sig 那一次响应自己的 Set-Cookie
  //    （参考实现 auth.go:490-501 就是从这里取），再退回宿主 session jar；
  //    两边都要求 Domain 精确等于 graph.qq.com（auth.go:284-295 的 authCookie）。
  const graph = await sessionCookies(deps, 'https://graph.qq.com', QQ_LOGIN_SESSION)
  const pUin = qqAuthCookie(jumped.headers, graph, 'p_uin')
  const pSkey = qqAuthCookie(jumped.headers, graph, 'p_skey')
  const pOauth = qqAuthCookie(jumped.headers, graph, 'pt_oauth_token')
  if (!pUin || !pSkey || !pOauth) {
    throw new Error('QQ 授权 Cookie 不完整（缺 p_skey/p_uin/pt_oauth_token）')
  }

  // 3) 显式跳到 login_jump（目标已过白名单；同样不自动跟随，下一跳由本插件自己决定）。
  await httpRequest(deps, {
    method: 'GET',
    url: landed.toString(),
    headers: { 'user-agent': QQ_AUTH_UA, referer: 'https://xui.ptlogin2.qq.com/' },
    session: QQ_LOGIN_SESSION,
    followRedirects: false,
  })

  // 4) authorize：换 code（state 必须与发出的一致）。
  const state = randomHex(16)
  const code = await requestQqAuthorizeCode(deps, state, { pUin, pSkey, pOauth })

  // 5) 换 QQ 音乐凭据（独立 session，不带 graph.qq.com 的 Cookie）。
  const credential = await requestQqCredential(deps, code)

  // 6) 落 KV（只存 QQ 音乐自己的凭据，不存 graph.qq.com 的全局授权 Cookie）。
  await persistQqCredential(deps, credential)

  // 7) 清掉宿主 session 里的 qrsig 与 graph.qq.com 全局凭据。清不掉要说出来 ——
  //    宿主 session 的 Cookie 跨重启保留（network.md:15），留着就等于把全局凭据留在宿主里。
  const cleared = await clearSessionCookies(deps, QQ_LOGIN_SESSION)
  return cleared ? '' : '登录成功，但没能清掉宿主会话里的 QQ 授权 Cookie，请手动清除浏览器中的 QQ 登录态'
}

/** graph.qq.com 的授权 Cookie 取值（Domain 必须精确等于 graph.qq.com）。 */
function qqAuthCookie(headers, jar, name) {
  const fromResponse = setCookieValueForDomain(headers, name, QQ_AUTH_COOKIE_DOMAIN)
  if (fromResponse) return fromResponse
  return cookieValueForDomain(jar, name, QQ_AUTH_COOKIE_DOMAIN)
}

/** authorize：拿到 302 的 code（host/path/state/code 四道校验都过才返回）。 */
async function requestQqAuthorizeCode(deps, state, { pUin, pSkey, pOauth }) {
  const form = authorizeForm({
    state,
    ui: randomUuid(),
    gTk: hash33Seed(pSkey, QQ_GTK_SEED),
    authTime: Date.now(),
  })
  const headers = {
    'content-type': FORM_CONTENT_TYPE,
    'user-agent': QQ_AUTH_UA,
    cookie: [`p_uin=${pUin}`, `p_skey=${pSkey}`, `pt_oauth_token=${pOauth}`].join('; '),
  }
  const raw = await httpRequest(deps, {
    method: 'POST',
    url: QQ_AUTHORIZE_ENDPOINT,
    headers,
    body: form,
    session: QQ_LOGIN_SESSION,
    followRedirects: false,
  })
  const location = responseHeader(raw.headers, 'location')
  if (!location) {
    // 拿不到 location 头就没有 code 可取。绝不再发一次同样的 POST ——
    // authorize 是变更类请求，宿主契约是「请求不自动重发变更动作」（network.md:13）。
    throw new Error('QQ 授权未返回跳转地址')
  }
  const parsed = parseAuthorizeRedirect(location, state)
  if (parsed.error) throw new Error(parsed.error)
  return parsed.code
}

/** musicu 的 QQLogin：换 QQ 音乐自己的凭据（不带任何 Cookie）。 */
async function requestQqCredential(deps, code) {
  const response = await httpRequest(deps, {
    method: 'POST',
    url: QQ_MUSICU,
    headers: {
      'content-type': 'application/json',
      'user-agent': QQ_API_UA,
      referer: 'https://y.qq.com/',
    },
    body: qqLoginRequestBody(code),
    session: QQ_MUSICU_SESSION,
  })
  const parsed = parseQQLoginResponse(response.text)
  if (parsed.error) throw new Error(parsed.error)
  return parsed.value
}

/** QQ 音乐凭据 → 插件 jar（cookies.qq）。
 *  形态对齐参考实现 client.go 的 Cookie：uin / qqmusic_uin / qm_keyst / qqmusic_key，
 *  外加 tmeLoginType（QQ 互联登录 = 2）与 encryptUin（账号标识，收藏歌单 / 我喜欢
 *  接口的 uin 参数要用它 —— 参考实现 auth_response.go:110）。宿主 session 里已有的
 *  QQ 音乐 Cookie 只用来补缺口，graph.qq.com 的全局授权 Cookie（p_skey /
 *  pt_oauth_token / p_uin）绝不落 KV。 */
async function persistQqCredential(deps, credential) {
  const host = await sessionCookies(deps, 'https://y.qq.com', QQ_LOGIN_SESSION)
  const musicid = String(Number(credential.musicid))
  const jar = {
    uin: musicid,
    qqmusic_uin: musicid,
    qqmusic_key: credential.musickey,
    qm_keyst: credential.musickey,
    tmeLoginType: String(credential.loginType),
  }
  // encryptUin 只有一个来源：QQLogin 响应。响应里没有就写空串（不沿用旧值 ——
  // 换账号时留着上一个账号的标识会让收藏歌单读到别人的数据）。
  jar.encryptUin = String(credential.encryptUin ?? '')
  // 账号标识是跟着账号走的：记下它属于哪个 uin，换账号后不再拿它去读收藏。
  jar.encryptUinFor = musicid
  const hostUin = cookieValue(host, 'uin') || cookieValue(host, 'qqmusic_uin')
  const hostKey = cookieValue(host, 'qqmusic_key') || cookieValue(host, 'qm_keyst')
  if (!jar.uin && hostUin) jar.uin = hostUin
  if (!jar.qqmusic_key && hostKey) {
    jar.qqmusic_key = hostKey
    jar.qm_keyst = hostKey
  }
  if (!jar.uin || !jar.qqmusic_key) throw new Error('QQ 音乐未返回登录凭据（L205）')
  await saveCookies(deps.kv, 'qq', jar)
}

// ─────────────────── QQ 歌单 / 每日推荐 / 我喜欢 ───────────────────
//
// 四个接口都是 POST JSON 到 u.y.qq.com/cgi-bin/musicu.fcg，登录态放在信封 comm 里
// （参考实现 client.go:101-165 与 auth_device.go:41）。凭据只来自插件 KV 的
// cookies.qq；错误消息只报「模块/方法 + 状态码」，不贴响应尾段（响应里可能带账号信息）。

/** QQ uin 归一：去掉 o 前缀与前导零。
 *  cookie 里的 uin（o0010001）与 QQLogin 的 musicid（10001）是同一个账号的两种写法，
 *  比对账号归属时要先归一。 */
function normalizeQqUin(value) {
  let uin = String(value ?? '').trim()
  if (uin.startsWith('o') || uin.startsWith('O')) uin = uin.slice(1)
  return uin.replace(/^0+(?=\d)/, '')
}

/**
 * 账号 musicid（参考实现 library.go:29 用的 s.MusicID —— QQLogin 响应的 musicid，
 * 规范十进制：既没有 o 前缀，也不补零）。
 *
 * 扫码登录落盘时 jar.uin 就是这个 musicid（persistQqCredential 写的是
 * String(Number(musicid))）；手动粘贴 Cookie 只能拿到浏览器 cookie 里的
 * 「o + 补零」形态（o0000010001），归一（去 o、去全部前导零）后才是同一个账号 id。
 * 有损归一（只去一个 o、一个 0）会把补零后的 id 发给账号级接口（如 GetPlaylistByUin）。
 */
function qqMusicId(jar) {
  const raw = typeof jar?.uin === 'string' && jar.uin !== ''
    ? jar.uin
    : typeof jar?.qqmusic_uin === 'string' && jar.qqmusic_uin !== '' ? jar.qqmusic_uin : ''
  const id = normalizeQqUin(raw)
  return id === '' ? '0' : id
}

/** QQ 登录态摘要（只从插件 KV 的 cookies.qq 取）。
 *  内部用：里面带凭据本身，绝不能进返回值、日志或错误消息。 */
function qqSession(cookies) {
  const jar = cookies ?? {}
  const musicKey = typeof jar.qqmusic_key === 'string' ? jar.qqmusic_key : ''
  const stored = typeof jar.encryptUin === 'string' ? jar.encryptUin : ''
  // encryptUin 是跟着账号走的：它属于 jar.encryptUinFor 那个 uin。换账号（手动粘贴
  // 别的账号的 Cookie）后就不能再拿它去读收藏歌单 —— 那会读到别人的歌单。
  const owner = typeof jar.encryptUinFor === 'string' ? jar.encryptUinFor : ''
  const mine = owner === '' || normalizeQqUin(owner) === qqMusicId(jar)
  return {
    // 账号级接口（GetPlaylistByUin）与信封 comm.qq 都用规范 musicid，不用补零形态。
    uin: qqMusicId(jar),
    musicKey,
    encryptUin: mine ? stored : '',
    loginType: Number(jar.tmeLoginType) || 1,
    loggedIn: musicKey !== '',
  }
}

/** QQ 歌单功能的登录态摘要（不含任何凭据值，可以回显给页面）。
 *  has_account_id = 有 encryptUin：收藏歌单 / 我喜欢接口的 uin 参数要用它，
 *  它只有一个来源（QQLogin 响应），手动粘贴 Cookie 登录拿不到。 */
export function qqLibraryInfo(cookies) {
  const session = qqSession(cookies)
  return {
    source: 'qq',
    logged_in: session.loggedIn,
    has_account_id: session.encryptUin !== '',
  }
}

/** 自建歌单登记表：tid → 拥有者 uin（参考实现 client.go:36 RememberOwnedPlaylist）。
 *  用来决定取曲目走「自建接口」（带 enc_host_uin）还是「公开接口」；带上拥有者是为了
 *  换账号后不把上一个账号的歌单当成自建的。 */
const qqOwnedPlaylists = new Map()

/** 记住自建歌单的 tid（列表接口读到后调用）。 */
export function rememberOwnedPlaylists(items, ownerUin = '') {
  for (const item of items ?? []) {
    const tid = Number(item?.id)
    if (Number.isFinite(tid) && tid > 0 && item?.kind !== 'liked') {
      qqOwnedPlaylists.set(tid, String(ownerUin ?? ''))
    }
  }
}

/** 某个 tid 是不是当前账号自建的歌单。 */
export function isOwnedQqPlaylist(tid, ownerUin = '') {
  const owner = qqOwnedPlaylists.get(Number(tid))
  return owner !== undefined && owner === String(ownerUin ?? '')
}

/**
 * musicu 请求（登录态 comm + 单个 req_0）。
 *
 * 登录态与 authst 只来自插件 KV 的 cookies.qq；没登录直接报错（这四个接口匿名调用
 * 只会回空壳：实测 80030 / 80050 / 80120 / 10004，不能当成「空的歌单」）。
 */
export async function qqRpc(deps, module, method, param) {
  const cookies = await loadCookies(deps.kv, 'qq')
  return qqRpcWith(deps, cookies, module, method, param)
}

/** qqRpc 的内部形态：复用同一份 cookie 表，避免重复读 KV。 */
async function qqRpcWith(deps, cookies, module, method, param) {
  const session = qqSession(cookies)
  if (!session.loggedIn) throw new Error('未登录 QQ 音乐，请先扫码登录')
  const comm = authenticatedComm({ uin: session.uin, musicKey: session.musicKey, loginType: session.loginType })
  const response = await httpRequest(deps, {
    method: 'POST',
    url: QQ_MUSICU,
    headers: {
      'content-type': 'application/json',
      'user-agent': QQ_API_UA,
      referer: 'https://y.qq.com/',
      cookie: qqCookieHeader(cookies),
    },
    body: musicuRequestBody(comm, module, method, param),
  })
  const parsed = parseMusicuResponse(response.text)
  if (parsed.error) throw new Error(`${module}/${method}: ${parsed.error}`)
  const checked = checkDissDataStatus(parsed.value)
  if (checked.error) throw new Error(`${module}/${method}: ${checked.error}`)
  return checked.value
}

/**
 * 我的歌单：我创建的 + 收藏的。
 *
 * 返回 {playlists, count, created, favorites, notice}。缺 encryptUin（账号标识，
 * 只有 QQLogin 响应里有）时只返回我创建的，并在 notice 里说明收藏读不到 ——
 * 不静默失败，也不把「读不到」说成「没有收藏」。
 */
export async function qqPlaylists(deps) {
  const cookies = await loadCookies(deps.kv, 'qq')
  const session = qqSession(cookies)
  if (!session.loggedIn) throw new Error('未登录 QQ 音乐，请先扫码登录')
  const owned = await qqRpcWith(
    deps, cookies, QQ_MODULE_PLAYLIST_BASE_READ, QQ_METHOD_GET_PLAYLIST_BY_UIN,
    ownedPlaylistsParam(session.uin),
  )
  const items = parseQqPlaylistList(owned?.v_playlist, 'created')
  const liked = items.filter((item) => item.kind === 'liked')
  const created = items.filter((item) => item.kind !== 'liked')
  rememberOwnedPlaylists(created, session.uin)
  let favorites = []
  let notice = ''
  if (!session.encryptUin) {
    notice = '未取得账号标识（encryptUin），收藏的歌单读不到；请重新扫码登录后再试'
  } else {
    try {
      favorites = await qqFavoritePlaylists(deps, cookies, session.encryptUin)
    } catch (error) {
      // 撞到分页硬上限：已读到的部分照样交给用户（参考实现 library.go:93
      // 「返回部分结果 + 错误」，由调用方决定怎么展示），错误说明放在 notice 里。
      favorites = Array.isArray(error?.playlists) ? error.playlists : []
      notice = String(error?.message ?? error)
    }
  }
  const playlists = [...liked, ...created, ...favorites]
  return { playlists, count: playlists.length, created, favorites, notice }
}

/**
 * 收藏的歌单（参考实现 library.go:69-93）。
 *
 * 游标 = offset，步进 = 本页实际条数（不是 size）；终止条件三选一：没有下一页、
 * 本页 0 条、本页 0 条新 tid（QQ 的收藏列表会重复列出同一个 tid）。
 */
async function qqFavoritePlaylists(deps, cookies, encryptUin) {
  const out = []
  const seen = new Set()
  let offset = 0
  while (offset < QQ_FAV_MAX_OFFSET) {
    const page = await qqRpcWith(
      deps, cookies, QQ_MODULE_PLAYLIST_FAV_READ, QQ_METHOD_GET_PLAYLIST_FAV_INFO,
      favoritePlaylistsParam(encryptUin, offset, QQ_FAV_PAGE_SIZE),
    )
    const entries = Array.isArray(page?.v_list) ? page.v_list : []
    let fresh = 0
    for (const item of parseQqPlaylistList(entries, 'fav')) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      out.push(item)
      fresh += 1
    }
    if (!qqHasMore(page) || entries.length === 0 || fresh === 0) return out
    offset += entries.length
  }
  // 撞到硬上限：如实报「未能完整读取」，已读到的部分挂在 error.playlists 上。
  const error = new Error('QQ 音乐收藏歌单过多，未能完整读取')
  error.playlists = out
  throw error
}

/**
 * 歌单曲目（target 支持歌单 id、'201' 我喜欢、'202' 每日推荐）。
 *
 * 返回 {songs, total, name, has_more}。total 是整单曲目数（页接口恒带，
 * 整单入队按它判取尽）。
 */
export async function qqPlaylistSongs(deps, target, begin = 0, num = QQ_SONG_PAGE_SIZE) {
  const cookies = await loadCookies(deps.kv, 'qq')
  const session = qqSession(cookies)
  if (!session.loggedIn) throw new Error('未登录 QQ 音乐，请先扫码登录')
  const kind = qqTargetKind(target)
  const offset = Math.max(0, Math.trunc(begin) || 0)
  const size = Math.max(1, Math.trunc(num) || QQ_SONG_PAGE_SIZE)
  if (kind === 'daily') return qqDailySongsInternal(deps, cookies, session, offset, size)
  if (kind === 'liked') return qqLikedSongsInternal(deps, cookies, session, offset, size)
  return qqPlaylistSongsInternal(deps, cookies, session, target, offset, size)
}

/** 每日推荐（薄封装）：一次取回全部，没有游标。 */
export async function qqDailyRecommendations(deps) {
  const cookies = await loadCookies(deps.kv, 'qq')
  const session = qqSession(cookies)
  if (!session.loggedIn) throw new Error('未登录 QQ 音乐，请先扫码登录')
  return qqDailySongsInternal(deps, cookies, session, 0, Number.MAX_SAFE_INTEGER)
}

/** 我喜欢（薄封装）：游标 = song_begin，步进 = 本页条数。 */
export async function qqLikedSongs(deps, begin = 0, num = QQ_SONG_PAGE_SIZE) {
  const cookies = await loadCookies(deps.kv, 'qq')
  const session = qqSession(cookies)
  if (!session.loggedIn) throw new Error('未登录 QQ 音乐，请先扫码登录')
  return qqLikedSongsInternal(deps, cookies, session, begin, num)
}

/**
 * 每日推荐缓存：账号 → {at, songs, total, name}。
 *
 * 每日推荐接口本身没有游标（dailySongsParam 不带 song_begin / song_num，参考实现
 * library.go:102 同样如此），只能整份取回再本地切片；不缓存的话每翻一页都要把整份
 * 列表重拉一遍（浏览时一页一次、整单入队时每页一次），翻页成本随页数线性放大。
 */
const qqDailyCache = new Map()

/** 每日推荐缓存的存活时间（毫秒）：QQ 每天换一次榜，短 TTL 足够覆盖一次浏览。 */
const QQ_DAILY_CACHE_TTL_MS = 5 * 60 * 1000

/** 每日推荐（参考实现 library.go:97-109 uniform_get_Dissinfo dirid=202）。
 *  整份取回后按 offset/size 本地切片；整份结果按账号缓存，翻页不再重拉。 */
async function qqDailySongsInternal(deps, cookies, session, offset = 0, size = QQ_SONG_PAGE_SIZE) {
  const account = session.uin
  const cached = qqDailyCache.get(account)
  let list = cached && Date.now() - cached.at < QQ_DAILY_CACHE_TTL_MS ? cached : null
  if (!list) {
    const data = await qqRpcWith(
      deps, cookies, QQ_MODULE_AI_DISS_INFO, QQ_METHOD_UNIFORM_GET_DISSINFO, dailySongsParam(),
    )
    const parsed = parseQqSongList(data)
    const info = parseQqPlaylistInfo(data)
    list = {
      at: Date.now(),
      songs: parsed.songs,
      total: parsed.total,
      name: info.name || '每日推荐',
    }
    qqDailyCache.set(account, list)
  }
  const songs = list.songs.slice(offset, offset + size)
  return {
    songs,
    total: list.total,
    name: list.name,
    has_more: offset + songs.length < list.total,
  }
}

/**
 * 「我喜欢」的跨页去重表：账号 → 已读到的 mid 集合。
 *
 * 参考实现 library.go:122-145：跨页用 seen 集合去重，本页没有新歌就报错
 * 「未能完整读取」（QQ 偶尔把同一页再回一次，不去重的话页面上会出现重复歌曲）。
 */
const qqLikedSeen = new Map()

/** 某账号的「我喜欢」去重表（账号维度隔离：换账号后不会把上一个账号的歌算成重复）。 */
function qqLikedSeenSet(account) {
  let seen = qqLikedSeen.get(account)
  if (!seen) {
    seen = new Set()
    qqLikedSeen.set(account, seen)
  }
  return seen
}

/** 我喜欢（参考实现 library.go:111-150 CgiGetDiss dirid=201）。
 *  enc_host_uin 必须是账号的 encryptUin，否则接口直接报参数错。 */
async function qqLikedSongsInternal(deps, cookies, session, offset = 0, size = QQ_SONG_PAGE_SIZE) {
  if (!session.encryptUin) throw new Error('QQ 音乐登录凭证缺少账号标识，请重新登录')
  if (offset >= QQ_LIKED_MAX_OFFSET) throw new Error('QQ 音乐喜欢歌曲列表过多，未能完整读取')
  const seen = qqLikedSeenSet(`${session.uin}:${session.encryptUin}`)
  // 第一页 = 新一轮读取：从头开始去重（否则重开歌单会被判成「重复页」）。
  if (offset === 0) seen.clear()
  const data = await qqRpcWith(
    deps, cookies, QQ_MODULE_DISS_INFO, QQ_METHOD_CGI_GET_DISS,
    likedSongsParam(session.encryptUin, offset, size),
  )
  if (!('songlist' in data) || data.songlist === null) {
    throw new Error('QQ 音乐未返回我喜欢列表的曲目')
  }
  const parsed = parseQqSongList(data)
  const info = parseQqPlaylistInfo(data)
  const fresh = parsed.songs.filter((song) => {
    if (seen.has(song.id)) return false
    seen.add(song.id)
    return true
  })
  if (parsed.songs.length > 0 && fresh.length === 0) {
    throw new Error('QQ 音乐喜欢歌曲列表未能完整读取（接口重复返回同一页）')
  }
  return {
    songs: fresh,
    total: parsed.total,
    name: info.name || '我喜欢',
    has_more: qqSongsHaveMore(data, parsed.songs.length, offset),
  }
}

/**
 * 还有下一页吗？（参考实现 library.go:141 的终止条件：hasmore 为假，或已读满
 * total_song_num 就停 —— 不能只看 hasmore，否则 QQ 一直回 hasmore=1 时会一直报
 * 「还有下一页」。）
 *
 * @param {object} data 接口返回的 data
 * @param {number} count 本页实际读到的条数（去重前）
 * @param {number} offset 本页游标（已读条数 = offset + count）
 */
function qqSongsHaveMore(data, count, offset = 0) {
  if (!qqHasMore(data)) return false
  if (count <= 0) return false
  const total = numberField(data, 'total_song_num')
  if (total > 0 && offset + count >= total) return false
  return true
}

/**
 * 「成功但空壳」的判定：songlist 是空的，可整单还有歌（total_song_num > 0）。
 *
 * 私密 / 不可访问的歌单用公开接口读回来就是这样：code=0、songlist=[]、但写着
 * 共 N 首。当成「0 首但共 N 首」会让页面卡在 0/N（没有「加载更多」按钮）。
 * 参考实现 catalog.go:93-107：这种壳要改走自建接口。
 */
function qqShellPlaylistError(total) {
  return new Error(`QQ 音乐未返回歌单曲目（歌单共 ${total} 首，但接口没给曲目）`)
}

/** 歌单曲目（公开 / 自建）：自建歌单走带 enc_host_uin 的接口，公开歌单先走公开接口。 */
async function qqPlaylistSongsInternal(deps, cookies, session, target, offset, size) {
  const tid = Number(target)
  if (!Number.isFinite(tid) || tid <= 0) throw new Error('歌单标识无效')
  if (isOwnedQqPlaylist(tid, session.uin) && session.encryptUin) {
    return qqOwnedPlaylistSongs(deps, cookies, session, tid, offset, size)
  }
  try {
    return await qqPublicPlaylistSongs(deps, cookies, tid, offset, size)
  } catch (error) {
    // 私密歌单用公开接口只会回「成功但空」的壳：带 encryptUin 时改走自建接口重试。
    if (!session.encryptUin) throw error
    return qqOwnedPlaylistSongs(deps, cookies, session, tid, offset, size)
  }
}

/** 公开歌单曲目（参考实现 catalog.go:178-214 uniform_get_Dissinfo disstid=...）。 */
async function qqPublicPlaylistSongs(deps, cookies, tid, offset, size) {
  const data = await qqRpcWith(
    deps, cookies, QQ_MODULE_AI_DISS_INFO, QQ_METHOD_UNIFORM_GET_DISSINFO,
    publicPlaylistSongsParam(tid, offset, size),
  )
  if (!('songlist' in data) || data.songlist === null) {
    throw new Error('QQ 音乐未返回歌单曲目')
  }
  const parsed = parseQqSongList(data)
  const info = parseQqPlaylistInfo(data)
  // 「成功但空壳」不当成空歌单：抛出去让上层改走自建接口（私密歌单）。
  if (parsed.songs.length === 0 && parsed.total > 0) {
    throw qqShellPlaylistError(parsed.total)
  }
  return {
    songs: parsed.songs,
    total: parsed.total,
    name: info.name,
    has_more: qqSongsHaveMore(data, parsed.songs.length, offset),
  }
}

/** 自建 / 私密歌单曲目（参考实现 catalog.go:115-149 CgiGetDiss disstid=...）。 */
async function qqOwnedPlaylistSongs(deps, cookies, session, tid, offset, size) {
  const data = await qqRpcWith(
    deps, cookies, QQ_MODULE_DISS_INFO, QQ_METHOD_CGI_GET_DISS,
    ownedPlaylistSongsParam(tid, session.encryptUin, offset, size),
  )
  if (!('songlist' in data) || data.songlist === null) {
    throw new Error('QQ 音乐未返回歌单曲目')
  }
  const parsed = parseQqSongList(data)
  const info = parseQqPlaylistInfo(data)
  if (parsed.songs.length === 0 && parsed.total > 0) {
    throw qqShellPlaylistError(parsed.total)
  }
  return {
    songs: parsed.songs,
    total: parsed.total,
    name: info.name,
    has_more: qqSongsHaveMore(data, parsed.songs.length, offset),
  }
}

/** 歌单的歌曲页（与网易云同形：{name,total,page,page_size,songs}）。
 *  整单入队状态机（lib/queue-pages.js）按 page*page_size >= total 判取尽。 */
export async function qqPlaylistSongsPage(deps, target, page = 1, pageSize = PLAYLIST_PAGE_SIZE) {
  const pageNo = Math.max(1, Math.trunc(page) || 1)
  const size = Math.max(1, Math.trunc(pageSize) || PLAYLIST_PAGE_SIZE)
  const begin = (pageNo - 1) * size
  const result = await qqPlaylistSongs(deps, target, begin, size)
  return playlistPage(result.name, result.total, pageNo, size, result.songs)
}

/** 单曲搜索（Go qqSearch）：page 从 1 起，每页 20 条。 */
export async function qqSearch(deps, query, page) {
  const cookies = await loadCookies(deps.kv, 'qq')
  const url = `${QQ_SEARCH_API}?${(() => {
    // search_params（qq.rs）：Go url.Values.Encode 形态。
    const pairs = [['w', query], ['format', 'json'], ['p', String(page)], ['n', '20']]
    return pairs.sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${queryEscape(k)}=${queryEscape(v)}`).join('&')
  })()}`
  const response = await httpRequest(deps, {
    url,
    headers: {
      'user-agent': QQ_UA,
      referer: 'https://y.qq.com/',
      cookie: qqCookieHeader(cookies),
    },
  })
  const parsed = parseSearch(response.text, page)
  if (parsed.error) throw new Error(parsed.error)
  return parsed.value
}

/** 取链返回的 size：按命中档位对应详情里的文件大小（详情失败时为 0）。 */
function qqQualitySize(code, detail) {
  if (code === 'F000') return detail.size_flac
  if (code === 'M800') return detail.size320
  if (code === 'M500') return detail.size128
  return 0
}

/** 按音质阶梯取链（对齐参考项目 Lilt internal/qqmusic/playback.go）：
 *
 *  1. 先请求歌曲详情拿 media_mid（文件名需要它；翻唱/多版本与 songmid 不同）；
 *  2. 登录态按用户档位请求 F000/M800/M500，匿名只请求 M500；
 *  3. 逐档请求 vkey，空 purl 继续下一档；purl 是相对路径时用响应 sip 拼域名。
 *
 *  旧实现把整条阶梯塞进一次请求、只认绝对 purl、用 songmid 顶替 media_mid，
 *  遇到 QQ 返回相对 purl 或 media_mid 不同的歌就误报“所有音质都没链接”。
 */
export async function qqSongUrl(deps, mid, level) {
  const cookies = await loadCookies(deps.kv, 'qq')
  const musicKey = typeof cookies.qqmusic_key === 'string' ? cookies.qqmusic_key : ''
  const loggedIn = musicKey !== ''
  const uin = uinFromCookies(cookies)
  const loginType = Number(cookies.tmeLoginType) || 1
  const guid = guidFromNanos(nowNanos())
  const headers = {
    'content-type': 'application/json',
    'user-agent': QQ_API_UA,
    referer: 'https://y.qq.com/',
  }
  // 与参考项目一致：只有登录态才带 cookie（匿名请求带会话 cookie 反而可能被拒）。
  if (loggedIn) headers.cookie = qqCookieHeader(cookies)

  let detail = { media_mid: mid, size128: 0, size320: 0, size_flac: 0 }
  try {
    const detailResponse = await httpRequest(deps, {
      method: 'POST',
      url: QQ_MUSICU,
      headers,
      body: songDetailRequestBody(mid),
    })
    const parsedDetail = parseQqSongDetail(detailResponse.text)
    if (!parsedDetail.error) detail = parsedDetail.value
  } catch {
    // 详情拿不到就按 songmid 兜底：多数歌的 media_mid 等于 songmid，取链接口仍可能返回。
  }

  let lastError = NO_LINK_ERROR
  // 登录态就按登录态的阶梯来（F000/M800/M500），全失败即报错。
  // 不再回落到匿名 comm：匿名请求本来就带不上会话（服务端不放行），一旦服务端按
  // 残留 cookie 放行，用户选「无损 FLAC」会静默拿到 128K 的文件（pump 按返回的
  // ext 把文件命名成 .mp3），且没有任何提示。
  const ladder = loggedIn ? qualityLadder(level, true) : qualityLadder(level, false)
  const requestMusicKey = loggedIn ? musicKey : ''
  for (const [code, ext] of ladder) {
    const body = songUrlRequestBody({
      mid, mediaMid: detail.media_mid, guid, code, ext, uin, musicKey: requestMusicKey, loginType,
    })
    const response = await httpRequest(deps, { method: 'POST', url: QQ_MUSICU, headers, body })
    const parsed = parseVkeyResponse(response.text, code, ext)
    if (!parsed.error) {
      return { url: parsed.url, ext: parsed.ext, level: parsed.level, size: qqQualitySize(code, detail) }
    }
    lastError = parsed.error
  }
  throw new Error(lastError)
}

/** 按来源取直链（download.rs resolve_song_url）。 */
export function resolveSongUrl(deps, source, songId, level) {
  switch (source) {
    case 'netease': return neteaseSongUrl(deps, songId, level)
    case 'qq': return qqSongUrl(deps, songId, level)
    default: return Promise.reject(new Error(`未知音乐源: ${source}`))
  }
}
