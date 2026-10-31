// QQ 音乐纯逻辑 —— 从 plugins/music-rs/src/qq.rs 逐函数移植。
// 网络请求由调用方（lib/music-api.js）发；本文件只做参数构造与响应解析。

import { queryEncode, queryEscape, parseQuery, hash33 } from './encoding.js'

/** Go main.go:15 的 chromeUA。 */
export const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

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
 *  qq.rs QR_UNAVAILABLE 原文。 */
export const QR_UNAVAILABLE = 'QQ 扫码登录受宿主 broker 限制暂不可用，请使用手动粘贴 Cookie'
/** 所有音质都取不到链接时的报错（Go qqSongURL 原文，含绿钻提示）。 */
export const NO_LINK_ERROR = '所有音质均未获取到链接（需要绿钻且歌曲有对应音源）'

/** 音质阶梯（sidecar fetch-worker.mjs:106 的 QQ_LADDER，比 Go 多一档 O801/ogg）：
 *  母带 → … → 128k 的命中顺序，文件名 = 前缀 + mid + mid + "." + 扩展名。 */
export const QUALITY_LADDER = [
  ['AI00', 'flac'],
  ['Q001', 'flac'],
  ['Q000', 'flac'],
  ['F000', 'flac'],
  ['O801', 'ogg'],
  ['M800', 'mp3'],
  ['M500', 'mp3'],
]

/** 用户档位 → QUALITY_LADDER 的起点（sidecar fetch-worker.mjs:109）；未知档位返回 null（用全档）。 */
export function qualityStart(level) {
  switch (String(level ?? '').trim()) {
    case 'master': return 0
    case 'flac': return 3
    case '320': return 5
    case '128': return 6
    default: return null
  }
}

/** 按用户档位裁剪后的取链阶梯（未知/空档位 → 完整阶梯）。
 *  Rust 返回切片（&QUALITY_LADDER[start..]，start=0 即整条），这里同样在 start<=0
 *  时返回原数组本身，保持引用语义（测试对拍）。 */
export function qualityLadder(level) {
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

/** qqSongURL 的 POST body（键排序形态）。`ladder` 由调用方按用户档位裁剪。 */
export function songUrlRequestBody(mid, uin, guid, ladder) {
  const filenames = ladder.map(([code, ext]) => `${code}${mid}${mid}.${ext}`)
  return sortedStringify({
    comm: { uin, format: 'json', ct: 20, cv: 0 },
    req_1: {
      module: 'music.vkey.GetVkey',
      method: 'UrlGetVkey',
      param: {
        guid,
        songmid: [mid],
        songtype: [0],
        uin,
        loginflag: 1,
        platform: '20',
        filename: filenames,
      },
    },
  })
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

/** qqPollQR 的 `'([^']*)'`（ptuiCB 参数列表）：依次取出单引号内的内容，空串也算一个。 */
export function parseJsArgs(body) {
  const text = String(body ?? '')
  const args = []
  let index = 0
  while (index < text.length) {
    if (text[index] !== "'") {
      index += 1
      continue
    }
    const start = index + 1
    const end = text.indexOf("'", start)
    if (end === -1) break
    args.push(text.slice(start, end))
    index = end + 1
  }
  return args
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

/**
 * qqSongURL 的响应体 → `{url, ext, level}`；没有任何 http 开头的 purl 时报
 * NO_LINK_ERROR，JSON 解析失败报「QQ 取链解析失败」。ladder 必须与请求体同一条。
 */
export function parseVkeyResponse(body, ladder) {
  let parsed
  try {
    parsed = JSON.parse(String(body ?? ''))
  } catch {
    return { error: 'QQ 取链解析失败' }
  }
  const midurlinfo = parsed?.req_1?.data?.midurlinfo
  if (!Array.isArray(midurlinfo)) return { error: 'QQ 取链解析失败' }
  for (let index = 0; index < midurlinfo.length; index++) {
    const purl = typeof midurlinfo[index]?.purl === 'string' ? midurlinfo[index].purl : ''
    if (purl.startsWith('http')) {
      // Go 这里是 ladder[i]，越界会 panic；这里跳过越界条目。
      if (index < ladder.length) {
        const [code, ext] = ladder[index]
        return { url: purl, ext, level: code }
      }
    }
  }
  return { error: NO_LINK_ERROR }
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
