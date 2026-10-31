// 网易云 eapi 取链协议 —— 从 plugins/music-rs/src/netease.rs 逐函数移植。
//
// AES-ECB / MD5 由宿主 ctx.crypto 提供（developer-guide.md:62）：调用方把
// `{md5, aesEcbEncryptHex}` 注入 `eapiParams`；本模块只负责明文装配，密钥不动。
// 页面 ctx 没有 crypto，但页面不需要取链（取链只在后台 pump 里发生）。

/** eapi 密钥（Go netease.go:37）：16 字节。 */
export const EAPI_KEY = 'e82ckenh8dichen8'
/** eapi 明文里的固定分隔符（Go netease.go:36）。 */
const EAPI_SEPARATOR = '-36cd479b6b5-'

/** 搜索接口（Go netease.go:70）。 */
export const SEARCH_URL = 'https://music.163.com/api/cloudsearch/pc'
/** 扫码取 unikey（Go netease.go:175）。 */
export const QR_UNIKEY_URL = 'https://interface.music.163.com/api/login/qrcode/unikey'
/** 扫码轮询（Go netease.go:201）。 */
export const QR_LOGIN_URL = 'https://interface.music.163.com/api/login/qrcode/client/login'
/** eapi 取链（Go netease.go:133）。 */
export const SONG_URL_API = 'https://interface3.music.163.com/eapi/song/enhance/player/url/v1'
/** 登录账号查询（sidecar server.mjs:282 neteaseAccount）。 */
export const ACCOUNT_URL = 'https://music.163.com/api/nuser/account/get'
/** 用户歌单列表（sidecar server.mjs:297）。 */
export const USER_PLAYLIST_URL = 'https://music.163.com/api/user/playlist'
/** 歌单详情（`n=0` 拿全量 trackIds，不受 1000 截断）。 */
export const PLAYLIST_DETAIL_URL = 'https://music.163.com/api/v6/playlist/detail'
/** 歌曲详情批量（每 200 个 id 一批）。 */
export const SONG_DETAIL_URL = 'https://music.163.com/api/v3/song/detail'

/** 通用 UA（Go main.go:15 = sidecar server.mjs:18）。 */
export const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
/** 扫码用桌面客户端 UA（Go main.go:16 = sidecar server.mjs:20）。 */
export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.0.18.203152'

/** 扫码登录页（Go netease.go:192 的 qr_content 前缀）。 */
export const LOGIN_PAGE = 'https://music.163.com/login'
/** 搜索/常规接口的 Referer。 */
export const MUSIC_REFERER = 'https://music.163.com/'
/** 扫码接口的 Referer（sidecar server.mjs:114/133 用 http 形态）。 */
export const QR_REFERER = 'http://music.163.com/'
/** 表单 Content-Type。 */
export const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded'

/** 音质阶梯，由高到低（Go main.go:21 = sidecar fetch-worker.mjs:104）；
 *  `songUrl` 从命中档位向下逐级尝试。 */
export const LEVELS = [
  'jymaster', 'jyeffect', 'sky', 'hires', 'lossless', 'dolby', 'exhigh', 'standard',
]

/** 升序档位表（sidecar server.mjs:308 NETEASE_LEVEL_ORDER；歌单详情用它算 qualities）。
 *  注意它与 LEVELS 不互为反转：两份来源对 dolby 的位次不同，各自照抄原样。 */
export const LEVELS_ASCENDING = [
  'standard', 'exhigh', 'lossless', 'hires', 'sky', 'jyeffect', 'dolby', 'jymaster',
]

/** 手动粘贴白名单：已知的网易云 cookie 名（netease.rs NETEASE_COOKIE_NAMES）。 */
export const NETEASE_COOKIE_NAMES = [
  'MUSIC_U', 'MUSIC_A', 'MUSIC_A_T', 'MUSIC_R_T', 'MUSIC_SNS', 'NMTID', '__csrf',
  '__csrf_token', '_ntes_nuid', '_ntes_nnid',
]

// ─────────────────────────── eapi ───────────────────────────

/** Go `strings.Replace(apiURL, "/eapi/", "/api/", 1)`：只换 pathname 里的第一处
 *  （0.3.9 对齐 agent fetch-worker.mjs:38 —— 只取 pathname 去掉 scheme+host）。 */
export function eapiPath(apiUrl) {
  let pathname = String(apiUrl)
  const schemeEnd = pathname.indexOf('://')
  if (schemeEnd !== -1) {
    const after = pathname.slice(schemeEnd + 3)
    const slash = after.indexOf('/')
    pathname = slash === -1 ? '/' : after.slice(slash)
  }
  const index = pathname.indexOf('/eapi/')
  if (index === -1) return pathname
  return pathname.slice(0, index) + '/api/' + pathname.slice(index + '/eapi/'.length)
}

/** 取链 payload（0.3.9 对齐 agent fetch-worker.mjs:85-88 真机验证过的形态）：
 *  header 是闭合 JSON、无 requestId、无 immerseType。
 *  键序必须与 serde_json BTreeMap 的字典序一致（encodeType/header/ids/level）——
 *  这改变 eapi 密文字节，JSON.stringify 按插入序输出，所以按序插入。 */
export function songUrlPayload(songId, level) {
  return {
    encodeType: 'flac',
    header: '{"os":"pc","appver":"","osver":"","deviceId":"pyncm!"}',
    ids: [String(songId)],
    level,
  }
}

/** Go netease.go:127 的 `time.Now().UnixNano() % 1e8`：纳秒时间戳的后 8 位。 */
export function requestId(nanos) {
  const n = typeof nanos === 'bigint' ? nanos : BigInt(Math.trunc(Number(nanos) || 0))
  return Number(n % 100000000n)
}

/** eapi 摘要明文：`path-36cd479b6b5-<payload 紧凑 JSON>-36cd479b6b5-<md5 hex>`，
 *  其中 md5 = md5("nobody" + path + "use" + json + "md5forencrypt")。 */
export function eapiPlaintext(apiUrl, payload, md5Hex) {
  const path = eapiPath(apiUrl)
  const payloadJson = JSON.stringify(payload)
  const digest = md5Hex(`nobody${path}use${payloadJson}md5forencrypt`)
  return { path, plaintext: `${path}${EAPI_SEPARATOR}${payloadJson}${EAPI_SEPARATOR}${digest}` }
}

/** eapi 请求参数（Go netease.go:31 neteaseEapiParams）：hex(AES-ECB(明文))。
 *  `crypto = {md5Hex(text), aesEcbEncryptHex(key, data)}` 由宿主 ctx.crypto 适配
 *  （jobs/runtime.js），测试注入 node:crypto 同语义实现。 */
export function eapiParams(apiUrl, payload, crypto) {
  const { plaintext } = eapiPlaintext(apiUrl, payload, crypto.md5Hex)
  return crypto.aesEcbEncryptHex(EAPI_KEY, plaintext)
}

/** Go netease.go:113-119：从 `level` 命中处向下逐级尝试；未命中（含空串）从最高档开始。 */
export function levelLadder(level) {
  const start = LEVELS.indexOf(level)
  return LEVELS.slice(start === -1 ? 0 : start)
}

/** 歌单歌曲的候选音质（sidecar server.mjs:340-341）：升序表里 `max_level` 的位次
 *  决定保留多少档，命中返回升序表 [0..=maxIdx] 的反转（高在前），未命中返回空表。 */
export function qualitiesForLevel(maxLevel) {
  const maxIndex = LEVELS_ASCENDING.indexOf(maxLevel)
  if (maxIndex === -1) return []
  return LEVELS_ASCENDING.slice(0, maxIndex + 1).reverse()
}
