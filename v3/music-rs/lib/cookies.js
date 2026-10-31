// 会话 cookie 的解析 / 白名单清洗 / 合并 / 登录态判定 —— 从 plugins/music-rs/src/
// {netease,qq,cookiecloud}.rs 逐函数移植。KV 键沿用旧契约：`cookies.netease` / `cookies.qq`。

import { NETEASE_COOKIE_NAMES } from './eapi.js'

/** 会话 cookie 的 KV 键（本插件契约；旧 Go 版存在 state.sessions）。 */
export const NETEASE_COOKIE_KEY = 'cookies.netease'
export const QQ_COOKIE_KEY = 'cookies.qq'

/** cookie 头固定前缀（Go netease.go:53；与 eapi payload 的 header 同源）。 */
export const COOKIE_BASE = 'os=pc; appver=; osver=; deviceId=pyncm!'

/** QQ 会话 cookie 白名单（qq.rs QQ_COOKIE_NAMES，qq.go:68-71）。 */
export const QQ_COOKIE_NAMES = [
  'qrsig', 'uin', 'skey', 'p_skey', 'ptui_loginuin', 'luin', 'qqmusic_key', 'musickey',
  'wxuin', 'wxunionid', 'euin', 'tmeLoginType', 'qqmusic_u',
]

/** 解析 `name=value; name2=value2`（Go netease.go:219-224 的 SplitN("=", 2)）：
 *  值里的 `=` 保留、没有 `=` 的段忽略、名字为空的段忽略、同名后者覆盖前者。 */
export function parseCookieString(cookie) {
  const cookies = {}
  for (const pair of String(cookie ?? '').split(';')) {
    const trimmed = pair.trim()
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    cookies[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
  }
  return cookies
}

/** 解析单条 Set-Cookie 行（sidecar server.mjs:154-157）：只取分号前的 name=value。 */
export function parseSetCookie(line) {
  const first = String(line ?? '').split(';')[0] ?? ''
  const eq = first.indexOf('=')
  if (eq <= 0) return null
  const name = first.slice(0, eq).trim()
  if (!name) return null
  return [name, first.slice(eq + 1)]
}

/** 响应头里所有 set-cookie 行的值（宿主当前会剥掉这个头，拿到就用）。 */
export function setCookieLines(headers) {
  const lines = []
  for (const [name, values] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === 'set-cookie') {
      for (const value of Array.isArray(values) ? values : [values]) lines.push(value)
    }
  }
  return lines
}

/** 网易云 cookie 头（Go netease.go:51-61 neteaseCookieHeader）：固定前缀 + MUSIC_U +
 *  __csrf_token（其余 cookie 不回显）。键存在就回显，不看值是否为空。 */
export function neteaseCookieHeader(cookies) {
  let header = COOKIE_BASE
  if (cookies && 'MUSIC_U' in cookies) header += `; MUSIC_U=${cookies.MUSIC_U}`
  if (cookies && '__csrf_token' in cookies) header += `; __csrf_token=${cookies.__csrf_token}`
  return header
}

/** QQ cookie 头（Go qqCookieHeader / sidecar server.mjs:76 cookieOf）：k=v 以 `; ` 连接，
 *  键按字典序（Rust BTreeMap 语义，形态稳定）。 */
export function qqCookieHeader(cookies) {
  return Object.keys(cookies ?? {})
    .sort()
    .map((name) => `${name}=${cookies[name]}`)
    .join('; ')
}

/** 合并写入语义（sidecar server.mjs:158）：旧值保留、新值覆盖 —— 扫码/同步只带回
 *  部分 cookie 时，不能让已有的会话字段凭空消失。返回新 jar（不落盘）。 */
export function mergeJars(current, incoming) {
  return { ...(current ?? {}), ...(incoming ?? {}) }
}

/** Go `qqCookieUin`：`uin` 去掉一个 `o` 前缀、再去掉一个 `0` 前缀；
 *  键不存在返回 "0"，键存在但为空返回空串。 */
export function uinFromCookies(cookies) {
  const raw = cookies?.uin
  if (raw === undefined) return '0'
  let uin = raw
  if (uin.startsWith('o')) uin = uin.slice(1)
  if (uin.startsWith('0')) uin = uin.slice(1)
  return uin
}

/** 扫码链路的来源（qq.rs LoginKind）。 */
export const LOGIN_KIND_QQ = 'qq'
export const LOGIN_KIND_WX = 'wx'

/** Go qqPollQR / qqPollWXQR 的 cookie 规范化：补齐 uin 与 qqmusic_key（就地修改）。 */
export function normalizeCookies(jar, kind = LOGIN_KIND_QQ) {
  if (!jar.uin) {
    const candidates = kind === LOGIN_KIND_WX ? ['wxuin'] : ['ptui_loginuin', 'luin', 'wxuin']
    for (const name of candidates) {
      if (jar[name]) {
        jar.uin = jar[name]
        break
      }
    }
  }
  if (!jar.qqmusic_key) {
    for (const name of ['p_skey', 'skey', 'musickey']) {
      if (jar[name]) {
        jar.qqmusic_key = jar[name]
        break
      }
    }
  }
  return jar
}

/** 手动粘贴网易云 Cookie 头的清洗（netease.rs save_cookie_string 的纯部分）：
 *  只保留白名单内非空的名字；至少要有 MUSIC_U（或 MUSIC_A）才算有效。
 *  返回 `{jar}` 或 `{error}`。 */
export function cleanNeteaseCookieString(raw) {
  const parsed = parseCookieString(raw)
  const jar = {}
  for (const [name, value] of Object.entries(parsed)) {
    if (NETEASE_COOKIE_NAMES.includes(name) && value !== '') jar[name] = value
  }
  const hasLogin = (jar.MUSIC_U && jar.MUSIC_U !== '') || (jar.MUSIC_A && jar.MUSIC_A !== '')
  if (!hasLogin) {
    return { error: '未找到 MUSIC_U(或 MUSIC_A); 请确认复制的是已登录 music.163.com 的 Cookie 头' }
  }
  return { jar }
}

/** 手动粘贴 QQ cookie 串的清洗（qq.rs save_cookie_string 的纯部分）：
 *  白名单过滤 + 值取第一个 `=` 之后的全部并 trim + normalizeCookies 补齐。
 *  缺少 qqmusic_key（且无法补齐）视为无效。 */
export function cleanQqCookieString(raw) {
  const jar = {}
  for (const segment of String(raw ?? '').split(';')) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const name = trimmed.slice(0, eq).trim()
    if (!QQ_COOKIE_NAMES.includes(name)) continue
    jar[name] = trimmed.slice(eq + 1).trim()
  }
  normalizeCookies(jar, LOGIN_KIND_QQ)
  if (!jar.qqmusic_key) {
    return { error: '粘贴的 cookie 缺少登录凭据（需要 qqmusic_key, 或可补齐的 p_skey/skey/musickey）' }
  }
  return { jar }
}

// ─────────────────────────── CookieCloud（v3 宿主内置）───────────────────────────

/** CookieCloud 域名键归一化：去首尾空白与开头的 `.`（通配形态）、结尾的 `.`（FQDN）。 */
function normalizeDomain(domain) {
  return String(domain ?? '').trim().replace(/^\./, '').replace(/\.$/, '')
}

/** 网易云登录域：`music.163.com` 及其子域（后缀精确匹配，xmusic.163.com 不算）。 */
export function isNeteaseCloudDomain(domain) {
  const host = normalizeDomain(domain)
  return host === 'music.163.com' || host.endsWith('.music.163.com')
}

/** QQ 音乐登录域：`qq.com` 及其所有子域（y.qq.com / music.qq.com / .qq.com 通配桶的并集）。 */
export function isQqCloudDomain(domain) {
  const host = normalizeDomain(domain)
  return host === 'qq.com' || host.endsWith('.qq.com')
}

/**
 * 从 CookieCloud 快照里按域 + 白名单提取 cookie（cookiecloud.rs extract_cookies_from_cloud）。
 *
 * `snapshot.cookies` 是宿主 `ctx.cookiecloud('read')` 返回的
 * `[{name,value,domain,...}]`（core-types.d.ts Cookie）；为兼容旧版形态也接受
 * 旧 `{域: [{name,value}] | {name:value}}` 文档。同名先见先得（结果确定）。
 */
export function extractCookiesFromSnapshot(snapshot, domainMatch, whitelist) {
  const jar = {}
  const entries = Array.isArray(snapshot?.cookies) ? snapshot.cookies : legacyEntries(snapshot)
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const domain = entry.domain ?? entry.__domain ?? ''
    if (!domainMatch(domain)) continue
    if (!whitelist.includes(entry.name)) continue
    if (entry.value === undefined || entry.value === null || entry.value === '') continue
    if (!(entry.name in jar)) jar[entry.name] = entry.value
  }
  return jar
}

/** 旧版 `{域: [...]|{...}}` 文档 → 扁平条目（BTreeMap 字典序遍历语义：按键排序）。 */
function legacyEntries(snapshot) {
  const data = snapshot?.cookie_data ?? snapshot?.domains ?? null
  if (!data || typeof data !== 'object') return []
  const entries = []
  for (const domain of Object.keys(data).sort()) {
    const raw = data[domain]
    if (Array.isArray(raw)) {
      for (const item of raw) entries.push({ ...item, domain })
    } else if (raw && typeof raw === 'object') {
      for (const name of Object.keys(raw)) entries.push({ name, value: raw[name], domain })
    }
  }
  return entries
}

/** 登录态摘要（绝不回显 cookie 值，宿主禁止凭据出现在响应里）。 */
export function neteaseLoginInfo(jar) {
  const cookies = jar ?? {}
  return {
    logged_in: Object.keys(cookies).length > 0,
    has_music_u: 'MUSIC_U' in cookies,
  }
}

/** QQ 登录态（qq.rs login_status）：以「有 qqmusic_key 凭据」为准。 */
export function qqLoginInfo(jar) {
  const cookies = jar ?? {}
  const hasKey = typeof cookies.qqmusic_key === 'string' && cookies.qqmusic_key !== ''
  return {
    source: 'qq',
    logged_in: hasKey,
    has_key: hasKey,
    uin: uinFromCookies(cookies),
  }
}
