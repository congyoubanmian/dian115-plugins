// QQ 音乐纯逻辑 —— 参数构造与响应解析；网络请求由 lib/music-api.js 发。
// 取链流程对齐参考项目 Lilt（github.com/Amamiya23/mygo-qyin，internal/qqmusic）：
// 先读歌曲详情拿 media_mid，再按档位逐次请求 vkey；purl 可能是相对路径，需要拼 sip 域名。
// 扫码登录（取码 → ptuiCB 状态 → check_sig → OAuth → 换 QQ 音乐凭据）同样对齐
// 参考项目 internal/qqmusic/auth.go + auth_response.go：参数、严格状态解析、重定向白名单
// 与凭据字段校验都在本文件，网络与宿主 session 记账在 lib/music-api.js。
// 旧版（plugins/music-rs/src/qq.rs）的纯逻辑移植仍保留，供微信扫码等旧链路使用。

import { queryEncode, queryEscape, parseQuery, hash33 } from './encoding.js'
import { songVipTag } from './vip-tag.js'

/** Go main.go:15 的 chromeUA。 */
export const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

/** musicu 取链/详情接口用的 UA —— 参考 Lilt internal/qqmusic/client.go 的 QQMusic UA。
 *  QQ 的 vkey 接口对 UA 敏感，浏览器 UA 容易拿到空 purl。 */
export const QQ_API_UA = 'QQMusic 14090008(android 10)'

export const QQ_QR_SHOW = 'https://ssl.ptlogin2.qq.com/ptqrshow'
export const QQ_QR_CHECK = 'https://ssl.ptlogin2.qq.com/ptqrlogin'
export const QQ_WX_CONNECT = 'https://open.weixin.qq.com/connect/qrconnect'
export const QQ_WX_CHECK = 'https://lp.open.weixin.qq.com/connect/l/qrconnect'
export const QQ_WX_APP_ID = 'wx48db31d50e334801'
export const QQ_WX_REDIRECT =
  'https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/'
/** 登录/取链共用的 JSON 接口。 */
export const QQ_MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
/** 搜索接口。 */
export const QQ_SEARCH_API = 'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp'
/** 微信扫码登录页里的二维码图片前缀。 */
export const QQ_WX_QRCODE_IMG = 'https://open.weixin.qq.com/connect/qrcode/'

export const QQ_QR_TTL_SECS = 120
export const QQ_WX_QR_TTL_SECS = 300

/** QQ 扫码登录不可用（宿主剥离外部响应 Set-Cookie；v3 同一宿主行为，替代路径是手动粘贴）。
 *  qq.rs QR_UNAVAILABLE 原文。
 *  ⚠️ 已废弃：v3 宿主按 session 记 Cookie，QQ 扫码已由 lib/music-api.js 的
 *  qqQrCreate / qqQrPoll 实现；这个常量只保留给还没接线的旧页面调用点（手动粘贴仍是回退）。 */
export const QR_UNAVAILABLE = 'QQ 扫码登录受宿主 broker 限制暂不可用，请使用手动粘贴 Cookie'
/** 所有音质都取不到链接时的报错（Go qqSongURL 原文，含绿钻提示）。 */
export const NO_LINK_ERROR = '所有音质均未获取到链接（需要绿钻且歌曲有对应音源）'

/** 取链音质阶梯：SQ 无损 → 320k → 128k。
 *  参考 Lilt playback.go：只请求这三档。母带/全景声（AI00/Q001/Q000）普通账号基本
 *  返回空 purl，放进来只会多打几次空请求。文件名 = 前缀 + songmid + media_mid + 扩展名。 */
export const QUALITY_LADDER = [
  ['F000', 'flac'],
  ['M800', 'mp3'],
  ['M500', 'mp3'],
]

/** 用户档位 → QUALITY_LADDER 的起点；未知档位返回 null（用全档）。 */
export function qualityStart(level) {
  switch (String(level ?? '').trim()) {
    case 'master':
    case 'flac': return 0
    case '320': return 1
    case '128': return 2
    default: return null
  }
}

/** 按用户档位裁剪后的取链阶梯；未登录只能拿 128k（匿名 vkey 只放行 M500）。
 *  未知/空档位 → 完整阶梯；start=0 时返回原数组（保持引用语义）。 */
export function qualityLadder(level, loggedIn = true) {
  if (!loggedIn) return [QUALITY_LADDER[2]]
  const start = qualityStart(level)
  return !start ? QUALITY_LADDER : QUALITY_LADDER.slice(start)
}

// ─────────────────────────── 请求参数构造 ───────────────────────────

/** Go `fmt.Sprintf("%.17f", float64(UnixNano)/1e18)`。JS Number(BigInt) 的舍入与
 *  Go u64→f64 一致（同为就近舍入），toFixed(17) 复刻 %.17f。 */
export function qrShowT(nanos) {
  const n = typeof nanos === 'bigint' ? nanos : BigInt(Math.trunc(Number(nanos) || 0))
  return (Number(n) / 1e18).toFixed(17)
}

/** qqCreateQR 的 query（Go url.Values.Encode 排序结果）。 */
export function qrShowParams(nanos) {
  return queryEncode([
    ['appid', '716027609'],
    ['e', '2'],
    ['l', 'M'],
    ['s', '3'],
    ['d', '72'],
    ['v', '4'],
    ['t', qrShowT(nanos)],
    ['daid', '383'],
    ['pt_3rd_aid', '100497308'],
  ])
}

/** qqPollQR 的 query：ptqrtoken = hash33(qrsig)，action = 0-0-<ms>。 */
export function qrLoginParams(qrsig, nowMs) {
  return queryEncode([
    ['u1', 'https://graph.qq.com/oauth2.0/login_jump'],
    ['ptqrtoken', String(hash33(qrsig))],
    ['ptredirect', '100'],
    ['h', '1'],
    ['t', '1'],
    ['g', '1'],
    ['from_ui', '1'],
    ['ptlang', '2052'],
    ['action', `0-0-${nowMs}`],
    ['js_ver', '21072115'],
    ['js_type', '1'],
    ['login_sig', ''],
    ['pt_uistyle', '40'],
    ['aid', '716027609'],
    ['daid', '383'],
    ['pt_3rd_aid', '100497308'],
    ['has_onekey', '1'],
    ['pttype', '1'],
    ['service', 'ptqrlogin'],
    ['nodirect', '0'],
  ])
}

/** qqCreateWXQR 的登录页 query。 */
export function wxLoginParams(state) {
  return queryEncode([
    ['appid', QQ_WX_APP_ID],
    ['redirect_uri', QQ_WX_REDIRECT],
    ['response_type', 'code'],
    ['scope', 'snsapi_login'],
    ['state', state],
    ['href', 'https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect'],
  ])
}

/** qqPollWXQR 的轮询 query。 */
export function wxCheckParams(uuid, nowMs) {
  return queryEncode([['uuid', uuid], ['_', String(nowMs)]])
}

/** qqSearch 的 query（w/format/p/n，每页 20 条）。 */
export function searchParams(query, page) {
  return queryEncode([
    ['w', query],
    ['format', 'json'],
    ['p', String(page)],
    ['n', '20'],
  ])
}

/** qqSongURL 的 guid（Go `UnixNano % 1e10`）。 */
export function guidFromNanos(nanos) {
  const n = typeof nanos === 'bigint' ? nanos : BigInt(Math.trunc(Number(nanos) || 0))
  return (n % 10000000000n).toString()
}

/** 序列化成 Go `json.Marshal(map)` 的形态：对象键递归排序（serde_json BTreeMap 语义），
 *  数组保持原序。 */
function sortedStringify(value) {
  if (Array.isArray(value)) return `[${value.map(sortedStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${sortedStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** 取链文件名：前缀 + songmid + media_mid + 扩展名。
 *  media_mid 与 songmid 不一定相同（翻唱/多版本），用 songmid 顶替会被服务端判成
 *  无音源、返回空 purl —— 参考 Lilt playback.go 的 filename 拼接。 */
export function qualityFilename(code, ext, mid, mediaMid) {
  return `${code}${mid}${mediaMid || mid}.${ext}`
}

/**
 * 登录态 comm（参考 Lilt internal/qqmusic/auth_device.go:41-48 authenticatedComm）。
 *
 * 形如 {ct:11,cv:14090008,v:14090008,chid:'10003505',tmeAppID:'qqmusic',
 * qq:<uin>,authst:<musickey>,tmeLoginType:<2>} —— 微信设备字段不在这里（参考实现
 * 只在微信登录路径上补设备信息）。
 */
export function authenticatedComm({ uin, musicKey, loginType } = {}) {
  return {
    ct: 11,
    cv: 14090008,
    v: 14090008,
    chid: '10003505',
    tmeAppID: 'qqmusic',
    qq: String(uin ?? ''),
    authst: String(musicKey ?? ''),
    tmeLoginType: Number(loginType) || 1,
  }
}

/** 单档取链的 POST body（键排序形态）。
 *  - 登录态：music.vkey.GetVkey / UrlGetVkey，comm 带 qq/authst/tmeLoginType；
 *  - 匿名：vkey.GetVkeyServer / CgiGetVkey，uin=0、loginflag=1、platform=20。
 *  参考 Lilt internal/qqmusic/playback.go 与 auth_device.go:authenticatedComm。 */
export function songUrlRequestBody(options) {
  const { mid, mediaMid, guid, code, ext, uin, musicKey, loginType } = options
  const filename = qualityFilename(code, ext, mid, mediaMid)
  const loggedIn = typeof musicKey === 'string' && musicKey !== ''
  if (loggedIn) {
    return sortedStringify({
      comm: authenticatedComm({ uin, musicKey, loginType }),
      req_0: {
        module: 'music.vkey.GetVkey',
        method: 'UrlGetVkey',
        param: { ctx: 0, filename: [filename], guid, songmid: [mid], songtype: [0], uin },
      },
    })
  }
  return sortedStringify({
    comm: { ct: 24, cv: 0 },
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: { filename: [filename], guid, loginflag: 1, platform: '20', songmid: [mid], songtype: [0], uin: '0' },
    },
  })
}

/** 歌曲详情 POST body：拿 media_mid 与各档文件大小（决定 filename 与返回的 size）。
 *  参考 Lilt catalog.go:SongDetails（music.pf_song_detail_svr / get_song_detail_yqq）。
 *  只传 song_mid：实测 song_id 传 "0" 会返回 code 404，省略后按 mid 能查到。 */
export function songDetailRequestBody(mid) {
  return sortedStringify({
    comm: { ct: 24, cv: 0 },
    req_0: {
      module: 'music.pf_song_detail_svr',
      method: 'get_song_detail_yqq',
      param: { song_mid: mid, song_type: 0 },
    },
  })
}

/** 歌曲详情 → {media_mid, size128, size320, size_flac}；解析失败返回 {error}。 */
export function parseQqSongDetail(body) {
  let parsed
  try {
    parsed = JSON.parse(String(body ?? ''))
  } catch {
    return { error: 'QQ 歌曲详情解析失败' }
  }
  const data = parsed?.req_0?.data ?? parsed?.data
  const track = data?.track_info
  if (!track || typeof track !== 'object') return { error: 'QQ 歌曲详情解析失败' }
  const file = track.file && typeof track.file === 'object' ? track.file : {}
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)
  const mediaMid = typeof file.media_mid === 'string' && file.media_mid !== ''
    ? file.media_mid
    : typeof track.strMediaMid === 'string' ? track.strMediaMid : ''
  return {
    value: {
      media_mid: mediaMid,
      size128: num(file.size_128mp3 ?? track.size128),
      size320: num(file.size_320mp3 ?? track.size320),
      size_flac: num(file.size_flac ?? track.sizeflac),
    },
  }
}

/** qqPollWXQR 用 wx_code 换 cookie 的 POST body（tmeLoginType 取 Go 版的 "1"）。 */
export function wxLoginPayload(code) {
  return sortedStringify({
    comm: {
      tmeAppID: 'qqmusic',
      tmeLoginType: '1',
      g_tk: 5381,
      platform: 'yqq',
      ct: 24,
      cv: 0,
    },
    req: {
      module: 'music.login.LoginServer',
      method: 'Login',
      param: { strAppid: QQ_WX_APP_ID, code },
    },
  })
}

// ─────────────────────────── 响应解析 ───────────────────────────

/** 扫描文本里的单引号字符串参数（parseJsArgs 与严格版 ptuiCB 解析共用同一套扫描）。
 *  - loose=true：旧语义（未闭合的引号就到此为止），供 parseJsArgs 用；
 *  - strict=true：转义感知（\' 不结束字符串）+ 严格串格式校验，非法即整体失败。
 *  返回 [{value, start, end}]（start 是开引号位置，end 是闭引号之后的位置）；strict 失败返回 null。 */
function scanQuotedArgs(text, strict) {
  const args = []
  let index = 0
  while (index < text.length) {
    if (text[index] !== "'") {
      index += 1
      continue
    }
    const start = index
    const contentStart = index + 1
    let end = -1
    if (strict) {
      let cursor = contentStart
      while (cursor < text.length) {
        const ch = text[cursor]
        if (ch === '\\') { cursor += 2; continue }
        if (ch === "'") { end = cursor; break }
        cursor += 1
      }
      if (end === -1) return null
    } else {
      end = text.indexOf("'", contentStart)
      if (end === -1) break
    }
    const raw = text.slice(contentStart, end)
    if (strict && !PTUI_ARG_RE.test(raw)) return null
    args.push({ value: strict ? decodePtuiEscapes(raw) : raw, start, end: end + 1 })
    index = end + 1
  }
  return args
}

/** qqPollQR 的 `'([^']*)'`（ptuiCB 参数列表）：依次取出单引号内的内容，空串也算一个。 */
export function parseJsArgs(body) {
  return scanQuotedArgs(String(body ?? ''), false).map((item) => item.value)
}

/** ptuiCB 状态码 → 状态名（Go statusMap）。 */
export function qqStatusOf(code) {
  switch (code) {
    case '0': return 'success'
    case '65': return 'expired'
    case '66': return 'waiting'
    case '67': return 'scanned'
    default: return 'failed'
  }
}

/** wx_errcode 状态码 → 状态名（Go stMap）。 */
export function wxStatusOf(code) {
  switch (code) {
    case '405': return 'success'
    case '408': return 'waiting'
    case '404':
    case '402': return 'expired'
    default: return 'failed'
  }
}

/** Go `\s`（RE2）：[ \t\n\f\r]。 */
function skipAsciiSpace(text) {
  let i = 0
  while (i < text.length && ' \t\n\f\r'.includes(text[i])) i++
  return text.slice(i)
}

/** 从 wx_errcode 的第一次可匹配出现处取数字（正则 `wx_errcode\s*=\s*'?([0-9]+)'?`）。 */
export function parseWxErrcode(body) {
  const text = String(body ?? '')
  const marker = 'wx_errcode'
  let from = 0
  for (;;) {
    const offset = text.indexOf(marker, from)
    if (offset === -1) return null
    const start = offset + marker.length
    let rest = skipAsciiSpace(text.slice(start))
    if (rest.startsWith('=')) {
      rest = skipAsciiSpace(rest.slice(1))
      if (rest.startsWith("'")) rest = rest.slice(1)
      const digits = /^[0-9]+/.exec(rest)
      if (digits) return digits[0]
    }
    from = start
  }
}

/** 从 wx_code 的第一次可匹配出现处取值（捕获可以为空串）。 */
export function parseWxCode(body) {
  const text = String(body ?? '')
  const marker = 'wx_code'
  let from = 0
  for (;;) {
    const offset = text.indexOf(marker, from)
    if (offset === -1) return null
    const start = offset + marker.length
    let rest = skipAsciiSpace(text.slice(start))
    if (rest.startsWith('=')) {
      rest = skipAsciiSpace(rest.slice(1))
      const quoted = rest.startsWith('"') || rest.startsWith("'")
      if (quoted) {
        const end = rest.slice(1).search(/["']/)
        if (end !== -1) return rest.slice(1, end + 1)
      }
    }
    from = start
  }
}

function isUuidChar(ch) {
  return /[A-Za-z0-9_-]/.test(ch)
}

/** 在 marker 之后取一段 [A-Za-z0-9_-]；首个不满足的出现处继续向后找。 */
function captureAfterMarker(text, marker) {
  let from = 0
  for (;;) {
    const offset = text.indexOf(marker, from)
    if (offset === -1) return null
    const start = offset + marker.length
    let captured = ''
    for (const ch of text.slice(start)) {
      if (!isUuidChar(ch)) break
      captured += ch
    }
    if (captured) return captured
    from = start
  }
}

/** 第二条正则 `window\.QRLogin\.uuid\s*=\s*"([^"]+)"`。 */
function qrloginUuid(html) {
  const marker = 'window.QRLogin.uuid'
  let from = 0
  for (;;) {
    const offset = html.indexOf(marker, from)
    if (offset === -1) return null
    const start = offset + marker.length
    let rest = skipAsciiSpace(html.slice(start))
    if (rest.startsWith('=')) {
      rest = skipAsciiSpace(rest.slice(1))
      if (rest.startsWith('"')) {
        const end = rest.indexOf('"', 1)
        if (end !== -1 && end > 1) return rest.slice(1, end)
      }
    }
    from = start
  }
}

/** qqCreateWXQR 的三条 uuid 正则，按顺序取第一个命中的。 */
export function extractWxUuid(html) {
  const byMarker = captureAfterMarker(String(html ?? ''), 'connect/l/qrconnect?uuid=')
  if (byMarker) return byMarker
  const byQrLogin = qrloginUuid(String(html ?? ''))
  if (byQrLogin) return byQrLogin
  return captureAfterMarker(String(html ?? ''), '/connect/qrcode/')
}

/** 扫码 key 指向哪条链路（server.mjs 由 key 里的 type=wx 判定）。 */
export function loginKindOf(key) {
  return parseQuery(key).get('type') === 'wx' ? 'wx' : 'qq'
}

/** QQ 直链域名的兜底（参考 Lilt playback.go 的 `dl.stream.qqmusic.qq.com`）。 */
export const QQ_STREAM_FALLBACK_DOMAIN = 'http://dl.stream.qqmusic.qq.com/'

/** 只接受 QQ 音乐自己的流媒体域名，避免被响应里的任意 URL 带跑。 */
function validStreamDomain(raw) {
  try {
    const url = new URL(String(raw))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return url.hostname === 'qqmusic.qq.com'
      || url.hostname.endsWith('.qqmusic.qq.com')
      || url.hostname.endsWith('.qq.com')
  } catch {
    return false
  }
}

/** purl 可能是相对路径（`M800midmedia.mp3?vkey=...`），按 sip 里的域名拼成完整 URL。
 *  选域名顺序对齐 Lilt：优先非 `http://ws…` 的合法域名，其次任意合法域名，最后兜底域名。 */
export function resolveStreamUrl(sip, purl) {
  const raw = String(purl ?? '')
  if (/^https?:\/\//i.test(raw)) return raw
  const domains = Array.isArray(sip) ? sip : []
  const preferred = domains.find((domain) => validStreamDomain(domain) && !String(domain).startsWith('http://ws'))
  const domain = preferred || domains.find((candidate) => validStreamDomain(candidate)) || QQ_STREAM_FALLBACK_DOMAIN
  try {
    return new URL(raw, domain).toString()
  } catch {
    return `${String(domain).replace(/\/?$/, '/')}${raw.replace(/^\//, '')}`
  }
}

/**
 * 单档取链的响应体 → `{url, ext, level}`。
 * 取第一条非空 purl（不再按下标和 ladder 对位）；相对 purl 用响应里的 sip 拼域名。
 * JSON 解析失败报「QQ 取链解析失败」，没有任何 purl 时报 NO_LINK_ERROR。
 */
export function parseVkeyResponse(body, code, ext) {
  let parsed
  try {
    parsed = JSON.parse(String(body ?? ''))
  } catch {
    return { error: 'QQ 取链解析失败' }
  }
  const data = parsed?.req_0?.data ?? parsed?.req_1?.data
  const midurlinfo = data?.midurlinfo
  if (!Array.isArray(midurlinfo)) return { error: 'QQ 取链解析失败' }
  const hit = midurlinfo.find((entry) => typeof entry?.purl === 'string' && entry.purl !== '')
  if (!hit) return { error: NO_LINK_ERROR }
  return { url: resolveStreamUrl(data?.sip, hit.purl), ext, level: code }
}

/** qqSearch 的响应体 → {songs, page}（Go 匿名结构体 + 逐条映射）。 */
export function parseSearch(body, page) {
  let parsed
  try {
    parsed = JSON.parse(String(body ?? ''))
  } catch (error) {
    return { error: `搜索解析失败: ${error.message}` }
  }
  const list = parsed?.data?.song?.list
  if (!Array.isArray(list)) return { error: '搜索解析失败: data.song.list 缺失' }
  const songs = list.map((song) => {
    const singers = (Array.isArray(song?.singer) ? song.singer : [])
      .map((singer) => (typeof singer?.name === 'string' ? singer.name : ''))
      .filter((name) => name !== '')
    const quality = Number(song?.sizeflac) > 0 ? 'flac' : Number(song?.size320) > 0 ? '320' : '128'
    return {
      id: song?.songmid ?? '',
      name: song?.songname ?? '',
      singers: singers.join('/'),
      album: song?.albumname ?? '',
      duration_s: song?.interval ?? 0,
      source: 'qq',
      quality,
    }
  })
  return { value: { songs, page } }
}

// ─────────────────────── QQ 扫码登录（xui.ptlogin2.qq.com）───────────────────────
//
// 纯逻辑部分：端点常量、参数构造、严格 ptuiCB 解析、重定向白名单、OAuth 授权表单与
// QQLogin 响应解析。对齐参考项目 internal/qqmusic/auth.go 与 auth_response.go。
// 网络请求（以及宿主 session 里的 Cookie 记账）在 lib/music-api.js。

/** QQ 扫码取码端点（参考实现 auth.go 的 QRKey）。 */
export const QQ_QR_SHOW_ENDPOINT = 'https://xui.ptlogin2.qq.com/ssl/ptqrshow'
/** QQ 扫码轮询端点（参考实现 auth.go 的 QRCheck）。 */
export const QQ_QR_LOGIN_ENDPOINT = 'https://xui.ptlogin2.qq.com/ssl/ptqrlogin'
/** OAuth 授权跳转端点（check_sig 之后跳到它）。 */
export const QQ_LOGIN_JUMP_ENDPOINT = 'https://graph.qq.com/oauth2.0/login_jump'
/** OAuth 授权端点（用 p_skey 换 code）。 */
export const QQ_AUTHORIZE_ENDPOINT = 'https://graph.qq.com/oauth2.0/authorize'
/** QQ 音乐换凭据端点（与 QQ_MUSICU 同一个）。 */
export const QQ_MUSICU_LOGIN_ENDPOINT = QQ_MUSICU

/** QQ 扫码的应用 id / 三方 id（参考实现 auth.go 的 url.Values）。 */
export const QQ_QR_APP_ID = '716027609'
export const QQ_QR_PT_3RD_AID = '100497308'
/** 扫码/授权链路的 UA（参考实现 auth.go 的默认 UA）。 */
export const QQ_AUTH_UA = 'Mozilla/5.0'
/** OAuth 客户端 id（QQ 音乐网页登录）。 */
export const QQ_OAUTH_CLIENT_ID = '100497308'
/** OAuth scope。 */
export const QQ_OAUTH_SCOPE = 'get_user_info,get_app_friends'
/** OAuth openapi 版本。 */
export const QQ_OAUTH_OPENAPI = '1010_1030'
/** OAuth redirect_uri（QQ 音乐网页登录的回调页）。 */
export const QQ_OAUTH_REDIRECT_URI =
  'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/'
/** check_sig 只允许这个 host + path（参考实现 auth.go 的 trustedLoginURL）。 */
export const QQ_CHECK_SIG_HOST = 'ssl.ptlogin2.graph.qq.com'
export const QQ_CHECK_SIG_PATH = '/check_sig'
/** login_jump 只允许这个 host + path。 */
export const QQ_LOGIN_JUMP_HOST = 'graph.qq.com'
export const QQ_LOGIN_JUMP_PATH = '/oauth2.0/login_jump'
/** 授权 Cookie（p_uin / p_skey / pt_oauth_token）的 Domain：必须精确等于它，
 *  更宽的域（.qq.com）里的同名 Cookie 不是这次的授权凭据
 *  （参考实现 auth.go:284-295 的 authCookie）。 */
export const QQ_AUTH_COOKIE_DOMAIN = 'graph.qq.com'
/** OAuth 回调只允许这个 host + path。 */
export const QQ_REDIRECT_HOST = 'y.qq.com'
export const QQ_REDIRECT_PATH = '/portal/wx_redirect.html'
/** g_tk 的 hash33 种子（参考实现 auth.go 的 hash33(skey, 5381)）。 */
export const QQ_GTK_SEED = 5381
/** PNG magic（8 字节）——用于校验 ptqrshow 的图片。 */
export const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** ptuiCB 的外壳前缀。 */
const PTUI_PREFIX = 'ptuiCB('
/** ptuiCB 参数的严格形态：不含裸引号/反斜杠/换行；转义只允许 \' \\ \n \r \t \xNN \uNNNN。 */
const PTUI_ARG_RE = /^(?:[^'\\\r\n]|\\(?:['\\nrt]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}))*$/
/** 无法识别的扫码状态（空响应、非 ptuiCB、畸形参数都归到这里）。 */
export const QQ_QR_UNKNOWN_STATUS = 'QQ 返回了无法识别的扫码状态，请刷新二维码重试'

/** 带种子的 QQ hash33（参考实现 auth.go 的 hash33(s, initial)）：h = h*33 + c，取低 31 位。 */
export function hash33Seed(text, initial = 0) {
  let hash = initial | 0
  for (const ch of String(text)) {
    const code = ch.codePointAt(0) | 0
    hash = (hash * 33 + code) | 0
  }
  return hash & 0x7fffffff
}

/** 随机字节：优先宿主 WebView 的 crypto.getRandomValues，取不到退回 Math.random。
 *  页面 ctx 没有 ctx.crypto（见 v3-kit/docs/sdk/index.d.ts），因此这里用全局 crypto；
 *  退化路径只影响本地 CSRF 随机量（state/ui/t），不影响换凭据的正确性。 */
function randomBytes(length) {
  const out = new Uint8Array(length)
  const source = globalThis.crypto
  if (source && typeof source.getRandomValues === 'function') {
    source.getRandomValues(out)
    return out
  }
  for (let i = 0; i < length; i += 1) out[i] = Math.floor(Math.random() * 256)
  return out
}

/** 随机 hex（n 字节 → 2n 个小写 hex 字符）。 */
export function randomHex(byteLength) {
  return Array.from(randomBytes(byteLength))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** 随机 UUID 形态（8-4-4-4-12，参考实现 auth.go 的 ui 参数）。 */
export function randomUuid() {
  const hex = randomHex(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** ptqrshow 的 query（Go url.Values.Encode 排序结果；t 是 8 字节随机 hex）。 */
export function ptqrShowParams(t) {
  return queryEncode([
    ['appid', QQ_QR_APP_ID],
    ['e', '2'],
    ['l', 'M'],
    ['s', '3'],
    ['d', '72'],
    ['v', '4'],
    ['t', String(t)],
    ['daid', '383'],
    ['pt_3rd_aid', QQ_QR_PT_3RD_AID],
    ['u1', QQ_LOGIN_JUMP_ENDPOINT],
  ])
}

/** ptqrshow 的完整 URL。 */
export function ptqrShowUrl(t) {
  return `${QQ_QR_SHOW_ENDPOINT}?${ptqrShowParams(t)}`
}

/** ptqrlogin 的 query：ptqrtoken = hash33(qrsig)。 */
export function ptqrLoginParams(qrsig) {
  return queryEncode([
    ['u1', QQ_LOGIN_JUMP_ENDPOINT],
    ['from_ui', '1'],
    ['aid', QQ_QR_APP_ID],
    ['daid', '383'],
    ['pt_3rd_aid', QQ_QR_PT_3RD_AID],
    ['ptqrtoken', String(hash33Seed(qrsig, 0))],
  ])
}

/** ptqrlogin 的完整 URL。 */
export function ptqrLoginUrl(qrsig) {
  return `${QQ_QR_LOGIN_ENDPOINT}?${ptqrLoginParams(qrsig)}`
}

/** 解 ptuiCB 参数里的转义（\' \\ \n \r \t \xNN \uNNNN）。 */
export function decodePtuiEscapes(raw) {
  let out = ''
  const text = String(raw ?? '')
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    i += 1
    const esc = text[i]
    if (esc === 'n') out += '\n'
    else if (esc === 'r') out += '\r'
    else if (esc === 't') out += '\t'
    else if (esc === 'x' || esc === 'u') {
      const size = esc === 'x' ? 2 : 4
      const code = Number.parseInt(text.slice(i + 1, i + 1 + size), 16)
      if (Number.isFinite(code)) {
        out += String.fromCodePoint(code)
        i += size
      } else {
        out += esc
      }
    } else out += esc ?? ''
  }
  return out
}

/**
 * 严格解析 ptuiCB 状态响应（参考实现 auth.go 的 parsePtui）。
 *
 * 只接受 `ptuiCB('a','b',...)` 这种完整外壳：参数必须是带引号的字符串（6~7 个），
 * 逗号分隔无空格以外的杂质；`'ptuiCB(66)'`、尾逗号、`;alert(1)`、空响应一律判为畸形，
 * 避免把注入内容当成状态。返回 {values} 或 {error}。
 */
export function parsePtui(body) {
  let text = String(body ?? '').trim()
  if (text.endsWith(';')) text = text.slice(0, -1)
  if (!text.startsWith(PTUI_PREFIX) || !text.endsWith(')')) return { error: QQ_QR_UNKNOWN_STATUS }
  const inner = text.slice(PTUI_PREFIX.length, -1)
  const scanned = scanQuotedArgs(inner, true)
  if (!scanned) return { error: QQ_QR_UNKNOWN_STATUS }
  const values = []
  let cursor = 0
  for (const item of scanned) {
    const gap = inner.slice(cursor, item.start).trim()
    if (values.length === 0) {
      if (gap !== '') return { error: QQ_QR_UNKNOWN_STATUS }
    } else if (gap !== ',') {
      return { error: QQ_QR_UNKNOWN_STATUS }
    }
    values.push(item.value)
    cursor = item.end
  }
  if (inner.slice(cursor).trim() !== '') return { error: QQ_QR_UNKNOWN_STATUS }
  if (values.length < 6 || values.length > 7) return { error: QQ_QR_UNKNOWN_STATUS }
  return { values }
}

/**
 * ptuiCB 状态码 → 扫码状态（参考实现 auth.go 的 QRCheck 映射）。
 * '0' 时 check_sig 是 args[2]（后续还要过重定向白名单）；未知状态码按服务端文案返回 failed。
 */
export function parseQqQrStatus(body) {
  const parsed = parsePtui(body)
  if (parsed.error) return parsed
  const args = parsed.values
  switch (args[0]) {
    case '66': return { status: 'waiting', message: '', code: '66' }
    case '67': return { status: 'scanned', message: '请在手机 QQ 上确认登录', code: '67' }
    case '65': return { status: 'expired', message: '二维码已失效', code: '65' }
    case '0': return { status: 'success', message: '登录成功', check_sig: args[2] ?? '', code: '0' }
    default: return { status: 'failed', message: args[4] ?? '', code: args[0] }
  }
}

/** 取原始 URL 的 authority（host[:port][@userinfo] 部分），不做规范化。 */
function rawAuthority(raw) {
  const text = String(raw ?? '')
  const schemeEnd = text.indexOf('://')
  if (schemeEnd === -1) return ''
  const rest = text.slice(schemeEnd + 3)
  const end = rest.search(/[/?#]/)
  return end === -1 ? rest : rest.slice(0, end)
}

/**
 * 重定向白名单（参考实现 auth.go 的 trustedLoginURL）：只接受 https + 精确 host
 * （显式端口、userinfo 都算不等 → 拒绝）+ 精确 path，且不带 fragment。不合法返回 null。
 */
export function trustedLoginUrl(raw, host, path) {
  let url
  try {
    url = new URL(String(raw ?? ''))
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  // 用原始 authority 比较：URL 解析器会抹掉 https 的默认端口 :443，
  // 而参考实现要求 host 逐字相等（Go 的 u.Host 保留显式端口）。
  if (rawAuthority(raw) !== String(host)) return null
  if (url.pathname !== String(path)) return null
  if (url.username !== '' || url.password !== '') return null
  if (url.hash !== '') return null
  return url
}

/** OAuth 授权表单（Go url.Values.Encode 排序结果；字段集与参考实现 auth.go 一致）。 */
export function authorizeForm({ state, ui, gTk, authTime }) {
  return queryEncode([
    ['response_type', 'code'],
    ['client_id', QQ_OAUTH_CLIENT_ID],
    ['redirect_uri', QQ_OAUTH_REDIRECT_URI],
    ['scope', QQ_OAUTH_SCOPE],
    ['state', String(state)],
    ['switch', ''],
    ['from_ptlogin', '1'],
    ['src', '1'],
    ['update_auth', '1'],
    ['openapi', QQ_OAUTH_OPENAPI],
    ['g_tk', String(gTk)],
    ['auth_time', String(authTime)],
    ['ui', String(ui)],
  ])
}

/**
 * OAuth 回调解析：只接受 y.qq.com 的 /portal/wx_redirect.html，且 code 形如
 * ^[A-F0-9]{32}$、state 必须等于自己发出去的那个。任何不匹配都拒绝（不拿未校验的 code 去换凭据）。
 */
export function parseAuthorizeRedirect(location, expectedState) {
  let url
  try {
    url = new URL(String(location ?? ''))
  } catch {
    return { error: 'QQ 授权跳转目标异常' }
  }
  if (url.protocol !== 'https:') return { error: 'QQ 授权跳转目标异常' }
  if (rawAuthority(location) !== QQ_REDIRECT_HOST || url.pathname !== QQ_REDIRECT_PATH) {
    return { error: 'QQ 授权跳转目标异常' }
  }
  const codes = url.searchParams.getAll('code')
  const states = url.searchParams.getAll('state')
  if (codes.length !== 1 || states.length !== 1) return { error: 'QQ 授权 state/code 校验失败' }
  if (!/^[A-F0-9]{32}$/.test(codes[0])) return { error: 'QQ 授权 state/code 校验失败' }
  if (states[0] !== String(expectedState)) return { error: 'QQ 授权 state/code 校验失败' }
  return { code: codes[0] }
}

/** QQLogin 换凭据的请求体（JSON；键序按 Go json.Marshal 的 map 排序语义）。 */
export function qqLoginRequestBody(code) {
  return sortedStringify({
    comm: { ct: 24, cv: 0, g_tk: 5381, platform: 'yqq' },
    req: {
      module: 'QQConnectLogin.LoginServer',
      method: 'QQLogin',
      param: { code: String(code) },
    },
  })
}

/** 取文本字段（兼容字符串与数字两种 JSON 形态；参考实现 auth_response.go 的 text()）。 */
function textField(data, ...keys) {
  for (const key of keys) {
    const value = data?.[key]
    if (typeof value === 'string' && value !== '') return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

/** 取整数字段（兼容数字与数字字符串；参考实现的 loginOptionalInt）。 */
function intField(data, key) {
  const value = data?.[key]
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10)
  return 0
}

/**
 * QQLogin 响应 → 登录凭据（参考实现 auth_response.go 的 decodeQQLoginResponse，expectedType=2）。
 *
 * 校验：顶层 code 与 req.code 都必须是 0；data.musicid 必须是 >0 的数字；
 * data.musickey 非空；data.loginType 必须是 2（QQ 互联路径，微信路径才是 1）。
 * 返回 {value:{musicid,musickey,loginType,...}} 或 {error}。
 */
export function parseQQLoginResponse(body, nowMsValue = Date.now()) {
  let parsed
  try {
    parsed = JSON.parse(String(body ?? ''))
  } catch {
    return { error: 'QQ 音乐登录响应无法解析（L201）' }
  }
  const code = parsed?.code
  const req = parsed?.req
  if (typeof code !== 'number' || !req || typeof req?.code !== 'number') {
    return { error: 'QQ 音乐未返回登录状态（L202）' }
  }
  if (code !== 0 || req.code !== 0) {
    return { error: `QQ 音乐拒绝登录（服务码 ${code}/${req.code}）` }
  }
  const data = req.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: 'QQ 音乐未返回登录数据（L203）' }
  }
  const musicid = textField(data, 'musicid').trim()
  if (!/^\d+$/.test(musicid) || Number(musicid) <= 0) {
    return { error: 'QQ 音乐返回的账号标识无效（L204）' }
  }
  const musickey = textField(data, 'musickey')
  if (musickey === '') return { error: 'QQ 音乐未返回登录凭据（L205）' }
  const loginType = intField(data, 'loginType')
  if (loginType !== 2) {
    return { error: `QQ 音乐返回未支持的登录类型（${loginType}）` }
  }
  const createdAt = intField(data, 'musickeyCreateTime')
  const expiresIn = intField(data, 'keyExpiresIn')
  if (createdAt > 0 && expiresIn > 0 && nowMsValue >= (createdAt + expiresIn) * 1000) {
    return { error: 'QQ 音乐返回的登录凭据已过期，请重新扫码' }
  }
  return {
    value: {
      musicid,
      musickey,
      loginType,
      nick: textField(data, 'nick', 'nickname'),
      logo: textField(data, 'logo'),
      encryptUin: textField(data, 'encryptUin'),
      openid: textField(data, 'openid'),
      unionid: textField(data, 'unionid'),
      refreshToken: textField(data, 'refresh_token'),
      refreshKey: textField(data, 'refresh_key'),
      musickeyCreateTime: createdAt,
      keyExpiresIn: expiresIn,
    },
  }
}

/** base64 文本 → 字节（浏览器与 Node 都有 atob）。 */
export function base64Bytes(text) {
  const raw = String(text ?? '')
  if (raw === '') return new Uint8Array(0)
  let binary
  try {
    binary = atob(raw)
  } catch {
    return new Uint8Array(0)
  }
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i) & 0xff
  return out
}

/** 是否 PNG（校验 magic，等价参考实现 auth.go 的 png.DecodeConfig）。 */
export function isPng(bytes) {
  if (!bytes || bytes.length < PNG_MAGIC.length) return false
  return PNG_MAGIC.every((byte, index) => bytes[index] === byte)
}

// ─────────────────── QQ 歌单 / 每日推荐 / 我喜欢（musicu RPC）───────────────────
//
// 参数与响应解析对齐参考实现 Lilt（mygo-qyin/internal/qqmusic）：
// - library.go:23-150  我创建的歌单 / 收藏的歌单 / 每日推荐 / 我喜欢
// - catalog.go:114-214 公开歌单与自建（私密）歌单的曲目分页
// - client.go:101-165  musicu 信封与两级状态码
// 网络请求在 lib/music-api.js；这里只有纯逻辑。

/** 歌单类接口的模块名（参考实现 library.go / catalog.go 的 rpc 调用）。 */
export const QQ_MODULE_PLAYLIST_BASE_READ = 'music.musicasset.PlaylistBaseRead'
export const QQ_MODULE_PLAYLIST_FAV_READ = 'music.musicasset.PlaylistFavRead'
export const QQ_MODULE_AI_DISS_INFO = 'music.srfDissInfo.aiDissInfo'
export const QQ_MODULE_DISS_INFO = 'music.srfDissInfo.DissInfo'

/** 方法名。 */
export const QQ_METHOD_GET_PLAYLIST_BY_UIN = 'GetPlaylistByUin'
export const QQ_METHOD_GET_PLAYLIST_FAV_INFO = 'CgiGetPlaylistFavInfo'
export const QQ_METHOD_UNIFORM_GET_DISSINFO = 'uniform_get_Dissinfo'
export const QQ_METHOD_CGI_GET_DISS = 'CgiGetDiss'

/** 「我喜欢」的 dirId（参考实现 library.go:36、:126）。 */
export const QQ_DIR_ID_LIKED = 201
/** 「每日推荐」的 dirId（参考实现 library.go:102）。 */
export const QQ_DIR_ID_DAILY = 202
/** 收藏歌单每页条数（参考实现 library.go:75）。 */
export const QQ_FAV_PAGE_SIZE = 100
/** 收藏歌单分页硬上限（参考实现 library.go:73：offset < 10000）。 */
export const QQ_FAV_MAX_OFFSET = 10000
/** 「我喜欢」分页硬上限（参考实现 library.go:124：song_begin < 100000）。 */
export const QQ_LIKED_MAX_OFFSET = 100000
/** 歌单曲目分页硬上限（参考实现 catalog.go:120：最多 100 页）。 */
export const QQ_PLAYLIST_MAX_PAGES = 100

/** 歌单曲目每页条数（与插件契约的 PLAYLIST_PAGE_SIZE=100 对齐）。 */
export const QQ_SONG_PAGE_SIZE = 100

/** 取整数字段（兼容数字与数字字符串；第一个能解析成整数的键胜出）。
 *  参考实现 client.go:282 number()。 */
export function numberField(source, ...keys) {
  for (const key of keys) {
    const value = source?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10)
  }
  return 0
}

/** musicu 请求体（登录态 comm + 单个 req_0；参考实现 client.go:116 的信封）。 */
export function musicuRequestBody(comm, module, method, param) {
  return sortedStringify({ comm, req_0: { module, method, param } })
}

/** 我创建的歌单（参考实现 library.go:29 GetPlaylistByUin）。 */
export function ownedPlaylistsParam(uin) {
  return { uin: String(uin ?? '') }
}

/** 收藏的歌单（参考实现 library.go:75 CgiGetPlaylistFavInfo）。 */
export function favoritePlaylistsParam(encryptUin, offset = 0, size = QQ_FAV_PAGE_SIZE) {
  return {
    uin: String(encryptUin ?? ''),
    offset: Math.trunc(offset) || 0,
    size: Math.trunc(size) || QQ_FAV_PAGE_SIZE,
  }
}

/** 每日推荐（参考实现 library.go:102 uniform_get_Dissinfo dirid=202）。 */
export function dailySongsParam() {
  return { dirid: QQ_DIR_ID_DAILY, optype: 3, tag: 1, userinfo: 0, pic_dpi: 300 }
}

/** 我喜欢（参考实现 library.go:126 CgiGetDiss dirid=201）。 */
export function likedSongsParam(encryptUin, songBegin = 0, songNum = QQ_SONG_PAGE_SIZE) {
  return {
    disstid: 0,
    dirid: QQ_DIR_ID_LIKED,
    tag: true,
    song_begin: Math.trunc(songBegin) || 0,
    song_num: Math.trunc(songNum) || QQ_SONG_PAGE_SIZE,
    userinfo: true,
    orderlist: true,
    enc_host_uin: String(encryptUin ?? ''),
  }
}

/** 公开歌单曲目（参考实现 catalog.go:184 uniform_get_Dissinfo disstid=...）。 */
export function publicPlaylistSongsParam(tid, songBegin = 0, songNum = QQ_SONG_PAGE_SIZE) {
  return {
    disstid: numberField({ disstid: tid }, 'disstid'),
    userinfo: 1,
    tag: 1,
    orderlist: 1,
    song_begin: Math.trunc(songBegin) || 0,
    song_num: Math.trunc(songNum) || QQ_SONG_PAGE_SIZE,
    onlysonglist: 0,
    enc_host_uin: '',
  }
}

/** 自建 / 私密歌单曲目（参考实现 catalog.go:122 CgiGetDiss disstid=...）。
 *  自建歌单必须带 enc_host_uin（= 账号的 encryptUin），否则只回空壳。 */
export function ownedPlaylistSongsParam(tid, encryptUin, songBegin = 0, songNum = QQ_SONG_PAGE_SIZE) {
  return {
    disstid: numberField({ disstid: tid }, 'disstid'),
    dirid: 0,
    tag: true,
    song_begin: Math.trunc(songBegin) || 0,
    song_num: Math.trunc(songNum) || QQ_SONG_PAGE_SIZE,
    userinfo: true,
    orderlist: true,
    enc_host_uin: String(encryptUin ?? ''),
  }
}

/** 业务码 → 提示文案（只讲状态码语义，不带任何账号信息）。
 *  80030/80050/80120/10004 是「未登录 / 登录态失效」的实测业务码。 */
export function qqCodeHint(code) {
  switch (Number(code)) {
    case 80030:
    case 80050:
    case 80120:
    case 10004:
      return '未登录或登录态已失效'
    case -100008:
      return '请求参数被拒（登录态缺少账号标识）'
    default:
      return ''
  }
}

/**
 * musicu 信封 → {value: data} 或 {error}。
 *
 * 两级状态码都要查：信封 code / req_0.code / req_0.subcode（参考实现
 * client.go:148-157），再查方法内的 data.code / data.subcode（参考实现
 * catalog.go:158-176 —— DissInfo 家族会在 200 信封里回内层错误）。
 * 错误消息只报「模块/方法 + 状态码」，不贴响应尾段（响应里可能带账号信息）。
 */
export function parseMusicuResponse(body) {
  let parsed
  try {
    parsed = JSON.parse(String(body ?? ''))
  } catch {
    return { error: 'QQ 音乐响应解析失败' }
  }
  const code = parsed?.code
  const req = parsed?.req_0
  if (typeof code !== 'number' || !req || typeof req?.code !== 'number') {
    return { error: 'QQ 音乐未返回请求状态' }
  }
  const subcode = typeof req.subcode === 'number' ? req.subcode : 0
  if (code !== 0 || req.code !== 0 || subcode !== 0) {
    const business = req.code !== 0 ? req.code : subcode
    const hint = qqCodeHint(business) || qqCodeHint(code)
    const tail = hint ? `：${hint}` : ''
    return { error: `QQ 音乐接口错误（网关 ${code} / 业务 ${business}）${tail}` }
  }
  const data = req.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: 'QQ 音乐未返回数据' }
  }
  return { value: data }
}

/** 方法内的 data.code / data.subcode 检查（参考实现 catalog.go:158-169）。 */
export function checkDissDataStatus(data) {
  const source = data && typeof data === 'object' ? data : {}
  for (const key of ['code', 'subcode']) {
    if (!(key in source)) continue
    const value = source[key]
    if (typeof value === 'number') {
      if (value !== 0) return { error: `QQ 音乐接口错误（数据 ${key} ${value}）` }
      continue
    }
    if (typeof value === 'string') {
      if (value !== '0') return { error: `QQ 音乐接口错误（数据 ${key} ${value}）` }
      continue
    }
    return { error: `QQ 音乐接口错误（数据 ${key} 不可解析）` }
  }
  return { value: source }
}

/** hasmore 判定（参考实现 library.go:96 libraryMore / catalog.go:151 playlistHasMore）：
 *  数字 1、布尔 true、字符串 '1'/'true' 都算「还有下一页」。 */
export function qqHasMore(data) {
  const value = data?.hasmore
  if (value === true) return true
  if (typeof value === 'number') return value === 1
  if (typeof value === 'string') return value === '1' || value === 'true'
  return false
}

/** 歌曲封面（album.mid → QQ 图床直链；参考实现 client.go:257-262 albumCover）。
 *  QQ 只认固定尺寸，别自己改尺寸后缀。 */
export function qqAlbumCover(mid) {
  const value = String(mid ?? '').trim()
  if (value === '') return ''
  return `https://y.gtimg.cn/music/photo_new/T002R500x500M000${value}.jpg?max_age=2592000`
}

/**
 * 歌单条目 → 插件契约形状（字段与回退顺序对齐参考实现 library.go:33 libraryPlaylist）。
 *
 * kind 是归属维度（'created' 我创建的 / 'fav' 收藏的 / 'liked' 我喜欢）——
 * UI 侧的 PlaylistItem 已有 kind / private / special 字段（见 v3-ui/src/music-rs/types.ts）。
 * 「我喜欢」是 dirId=201 的伪歌单，没有可用的 tid：用 201 当标识，
 * 取曲目走 CgiGetDiss(dirid=201)。
 */
export function mapQqPlaylist(entry, kind = 'created') {
  const source = entry && typeof entry === 'object' ? entry : {}
  const tid = numberField(source, 'tid', 'dissid', 'id')
  const dirId = numberField(source, 'dirId', 'dirid')
  const dirShow = numberField(source, 'dirShow', 'dir_show')
  const item = {
    id: '',
    name: textField(source, 'dirName', 'dissname', 'title', 'name'),
    cover: textField(source, 'bigpicUrl', 'picUrl', 'picurl', 'coverUrl', 'logo', 'albumPicUrl'),
    count: numberField(source, 'songNum', 'songnum', 'song_cnt'),
    creator: textField(source, 'nick', 'nickname', 'host_nick'),
    kind,
    dirId,
    private: dirShow === 2,
  }
  if (dirId === QQ_DIR_ID_LIKED) {
    item.id = String(QQ_DIR_ID_LIKED)
    item.kind = 'liked'
  } else {
    item.id = tid > 0 ? String(tid) : ''
  }
  return item
}

/** 歌单条目数组 → 插件契约形状（跳过没有 id 的条目；参考实现 library.go:60）。 */
export function parseQqPlaylistList(entries, kind = 'created') {
  const list = Array.isArray(entries) ? entries : []
  const out = []
  for (const entry of list) {
    const item = mapQqPlaylist(entry, kind)
    if (!item.id) continue
    out.push(item)
  }
  return out
}

/**
 * 文件大小：先读 file 子对象，取不到（0）再回退顶层字段
 * （参考实现 client.go:361-372 —— 先 file.size_128mp3，为 0 时回退顶层 size128）。
 */
function qqFileSize(file, source, keys) {
  for (const key of keys) {
    const value = numberField(file, key)
    if (value > 0) return value
  }
  for (const key of keys) {
    const value = numberField(source, key)
    if (value > 0) return value
  }
  return 0
}

/**
 * 歌单曲目 → 插件契约形状。
 *
 * id 必须是 mid（字符串）：入队后 song_id 直接进取链（qqSongUrl 用 mid 拼文件名），
 * 数字 id 取不到链。
 */
export function mapQqSong(entry) {
  const source = entry && typeof entry === 'object' ? entry : {}
  const mid = textField(source, 'mid', 'songmid', 'songMid')
  if (!mid) return null
  const album = source.album && typeof source.album === 'object' ? source.album : {}
  const file = source.file && typeof source.file === 'object' ? source.file : {}
  const singerList = Array.isArray(source.singer) ? source.singer
    : Array.isArray(source.singers) ? source.singers : []
  const singers = singerList
    .map((singer) => textField(singer, 'name', 'singername'))
    .filter((name) => name !== '')
    .join('/')
  const qualities = []
  if (qqFileSize(file, source, ['size_flac', 'sizeflac']) > 0) qualities.push('flac')
  if (qqFileSize(file, source, ['size_320mp3', 'size320']) > 0) qualities.push('320')
  if (qqFileSize(file, source, ['size_128mp3', 'size128']) > 0) qualities.push('128')
  const albumMid = textField(album, 'mid', 'albummid', 'album_mid')
  // 无付费/会员标识时不输出 vip 键，保持原有对象形状。
  const vip = songVipTag({ pay: source.pay })
  return {
    id: mid,
    name: textField(source, 'title', 'name', 'songname'),
    singers,
    album: textField(album, 'name', 'title') || textField(source, 'albumname', 'album_name'),
    cover: qqAlbumCover(albumMid),
    duration_ms: numberField(source, 'interval') * 1000,
    source: 'qq',
    qualities,
    ...(vip ? { vip } : {}),
  }
}

/** 歌单曲目列表 → {songs, total}（total 取 total_song_num，缺失回退 dirinfo.songnum）。 */
export function parseQqSongList(data) {
  const source = data && typeof data === 'object' ? data : {}
  const list = Array.isArray(source.songlist) ? source.songlist : []
  const songs = []
  for (const entry of list) {
    const song = mapQqSong(entry)
    if (song) songs.push(song)
  }
  const info = source.dirinfo && typeof source.dirinfo === 'object' ? source.dirinfo : {}
  const total = numberField(source, 'total_song_num') || numberField(info, 'songnum') || songs.length
  return { songs, total }
}

/** 歌单详情（uniform_get_Dissinfo 的 data.dirinfo）→ {name, cover, count, creator}。 */
export function parseQqPlaylistInfo(data) {
  const source = data && typeof data === 'object' ? data : {}
  const info = source.dirinfo && typeof source.dirinfo === 'object' ? source.dirinfo : {}
  return {
    name: textField(info, 'title'),
    cover: textField(info, 'picurl', 'picurl2'),
    count: numberField(info, 'songnum') || numberField(source, 'total_song_num'),
    creator: textField(info, 'host_nick'),
  }
}

/** 目标归一化：'daily'/'202' → 每日推荐，'liked'/'201' → 我喜欢，其余按歌单 id 处理。 */
export function qqTargetKind(target) {
  const value = String(target ?? '').trim().toLowerCase()
  if (value === 'daily' || value === 'qq-daily' || value === String(QQ_DIR_ID_DAILY)) return 'daily'
  if (value === 'liked' || value === 'qq-liked' || value === String(QQ_DIR_ID_LIKED)) return 'liked'
  return 'playlist'
}
