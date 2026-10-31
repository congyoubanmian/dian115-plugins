// 网易云 / QQ 音乐的网络层 —— 从 plugins/music-rs/src/{netease,qq}.rs 的网络函数移植。
//
// 传输层换成 v3 `ctx.http.request`（宿主发出、同一会话与代理；HTTP 错误状态作为
// status 返回，连接和超时抛错 —— 见 docs/network.md）。cookie 仍由插件 KV 持有
// （cookies.netease / cookies.qq），按旧契约手工构造 Cookie 头（neteaseCookieHeader /
// qqCookieHeader），与 Rust 版逐字节同形。页面与后台共用本文件；`deps = {http, kv, crypto}`
// 由调用方装配（页面无 crypto，但页面不需要取链）。

import {
  SEARCH_URL, QR_UNIKEY_URL, QR_LOGIN_URL, SONG_URL_API, ACCOUNT_URL, USER_PLAYLIST_URL,
  PLAYLIST_DETAIL_URL, SONG_DETAIL_URL, CHROME_UA, DESKTOP_UA, LOGIN_PAGE, MUSIC_REFERER,
  QR_REFERER, FORM_CONTENT_TYPE, LEVELS,
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
  CHROME_UA as QQ_UA, QQ_MUSICU, QQ_SEARCH_API, qualityLadder, guidFromNanos,
  songUrlRequestBody, parseVkeyResponse, parseSearch,
} from './qq.js'

/** 单曲取链结果（Go neteaseSongURL 的返回元组；SongUrl 契约字段 url/ext/level/size）。 */
export const SONG_URL_FALLBACK_EXT = 'flac'

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

/** 一次 ctx.http.request：返回 {status, headers, text}；网络失败抛错（与旧 host.call 语义一致）。 */
export async function httpRequest(deps, { method = 'GET', url, headers = {}, body = null, timeoutSeconds = 120 }) {
  const options = {
    url,
    method,
    headers,
    timeout_seconds: timeoutSeconds,
    response_type: 'text',
  }
  if (body !== null && body !== undefined) options.body = body
  const result = await deps.http.request(options)
  return { status: result.status, headers: result.headers ?? {}, text: result.body ?? '' }
}

/** POST x-www-form-urlencoded（Go hostCall + base64 请求体的等价形态：body 字符串 +
 *  content-type 头，编码用 Go QueryEscape 语义的 formEncode，逐字节对齐 Rust 版）。 */
export function postForm(deps, url, headers, form) {
  return httpRequest(deps, {
    method: 'POST',
    url,
    headers: { ...headers, 'content-type': FORM_CONTENT_TYPE },
    body: form,
  })
}

/** 响应 JSON 解析（失败抛错，文案与 Rust 版同前缀）。 */
export function parseJson(text, message) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${message}: ${error.message}`)
  }
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

/** 扫码创建（Go neteaseQRCreate）：返回 {key, qr_content}（qr_content 是登录页 URL，前端自己画）。 */
export async function neteaseQrCreate(deps) {
  const form = formEncode([['type', '3']])
  const response = await postForm(deps, QR_UNIKEY_URL, {
    'user-agent': DESKTOP_UA,
    referer: QR_REFERER,
    ...ipHeaders(),
  }, form)
  const out = parseJson(response.text, '获取二维码失败')
  const unikey = typeof out?.unikey === 'string' ? out.unikey : ''
  if (out?.code !== 200 || !unikey) throw new Error('获取二维码失败')
  return { key: unikey, qr_content: `${LOGIN_PAGE}?codekey=${queryEscape(unikey)}` }
}

/** 扫码轮询（Go neteaseQRPoll）：返回 {status, message, code, logged_in?}。
 *  803 时解析 body/set-cookie 里的登录 cookie 并落 KV；宿主剥离 set-cookie 且 body
 *  不带 cookie 时给出引导文案，绝不静默保存空表冒充登录成功。 */
export async function neteaseQrPoll(deps, key) {
  const form = formEncode([['key', key], ['type', '3']])
  const response = await postForm(deps, QR_LOGIN_URL, {
    'user-agent': DESKTOP_UA,
    referer: QR_REFERER,
    ...ipHeaders(),
  }, form)
  // Go netease.go:214 忽略解包错误 → 零值（code=0, status=""）。
  const out = (() => {
    try { return JSON.parse(response.text) } catch { return {} }
  })()
  const code = typeof out?.code === 'number' ? out.code : 0
  const message = typeof out?.message === 'string' ? out.message : ''
  const status = { 800: 'expired', 801: 'waiting', 802: 'scanned', 803: 'success' }[code] ?? ''
  const result = { status, message, code }
  if (code !== 803) return result
  // cookie 在 body 和 Set-Cookie 都可能有（sidecar server.mjs:149-157）。
  let cookies = parseCookieString(typeof out?.cookie === 'string' ? out.cookie : '')
  for (const line of setCookieLines(response.headers)) {
    const pair = parseSetCookie(line)
    if (pair) cookies = mergeJars(cookies, { [pair[0]]: pair[1] })
  }
  const hasLogin = (cookies.MUSIC_U && cookies.MUSIC_U !== '') || (cookies.MUSIC_A && cookies.MUSIC_A !== '')
  if (hasLogin) {
    // Go netease.go:225 忽略落盘错误（登录态以 KV 为准，失败不改变本次结果）。
    try { await saveCookies(deps.kv, 'netease', cookies) } catch { /* 忽略 */ }
    result.logged_in = true
  } else {
    result.logged_in = false
    result.message =
      '扫码成功，但宿主代理剥离了登录 Cookie，无法自动保存登录态。请在浏览器登录 ' +
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

/** 按音质阶梯取链（Go qqSongURL 流程 + sidecar 档位裁剪）。 */
export async function qqSongUrl(deps, mid, level) {
  const cookies = await loadCookies(deps.kv, 'qq')
  const uin = uinFromCookies(cookies)
  const guid = guidFromNanos(nowNanos())
  const ladder = qualityLadder(level)
  const body = songUrlRequestBody(mid, uin, guid, ladder)
  const response = await httpRequest(deps, {
    method: 'POST',
    url: QQ_MUSICU,
    headers: {
      'content-type': 'application/json',
      'user-agent': QQ_UA,
      referer: 'https://y.qq.com/',
      cookie: qqCookieHeader(cookies),
    },
    body,
  })
  const parsed = parseVkeyResponse(response.text, ladder)
  if (parsed.error) throw new Error(parsed.error)
  return { url: parsed.url, ext: parsed.ext, level: parsed.level, size: 0 }
}

/** 按来源取直链（download.rs resolve_song_url）。 */
export function resolveSongUrl(deps, source, songId, level) {
  switch (source) {
    case 'netease': return neteaseSongUrl(deps, songId, level)
    case 'qq': return qqSongUrl(deps, songId, level)
    default: return Promise.reject(new Error(`未知音乐源: ${source}`))
  }
}
