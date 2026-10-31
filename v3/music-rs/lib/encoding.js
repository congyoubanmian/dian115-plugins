// 编码与摘要原语 —— 从 plugins/music-rs/src/{netease,qq,tasks,download,util}.rs 逐函数移植。
//
// 全部是纯函数（随机源经参数注入），页面与后台共用，node --test 直接覆盖。
// 语义锚点都标注了 Rust/Go 出处，向量来自 plugins/music-rs/tests/{netease,qq,cookiecloud_vectors}.rs。

// ─────────────────────────── Go url.QueryEscape ───────────────────────────

const HEX = '0123456789ABCDEF'

/** Go `url.QueryEscape`：RFC 3986 unreserved（A-Za-z0-9-_.~）原样，空格转 `+`，
 *  其余字节按 UTF-8 逐字节 `%XX`（大写十六进制）。 */
export function queryEscape(text) {
  let out = ''
  for (const byte of new TextEncoder().encode(String(text))) {
    if (
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d || byte === 0x5f || byte === 0x2e || byte === 0x7e
    ) {
      out += String.fromCharCode(byte)
    } else if (byte === 0x20) {
      out += '+'
    } else {
      out += '%' + HEX[byte >> 4] + HEX[byte & 0x0f]
    }
  }
  return out
}

/** Go `url.QueryUnescape`：`+` → 空格，`%XX` → 字节；非法转义 / 非 UTF-8 → null。 */
export function queryUnescape(text) {
  const bytes = new TextEncoder().encode(String(text))
  const out = []
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    if (b === 0x2b) {
      out.push(0x20)
      i += 1
    } else if (b === 0x25) {
      if (i + 2 >= bytes.length) return null
      const high = digitValue(bytes[i + 1])
      const low = digitValue(bytes[i + 2])
      if (high === -1 || low === -1) return null
      out.push((high << 4) | low)
      i += 3
    } else {
      out.push(b)
      i += 1
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(out))
  } catch {
    return null
  }
}

function digitValue(byte) {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10
  return -1
}

/** Go `url.Values.Encode`：键按字节序排序，值逐个 QueryEscape，以 `&` 连接。 */
export function queryEncode(pairs) {
  return [...pairs]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${queryEscape(k)}=${queryEscape(v)}`)
    .join('&')
}

/** Go `url.Values.Encode()` 的同名语义（netease.rs `form_encode`）：按键排序后 k=v 用 & 连接。 */
export const formEncode = queryEncode

/** Go `url.PathEscape`（encodePathSegment 模式）：未保留字符与 $&+=:@ 原样，其余 %XX 大写
 *  （RFC 3986 §3.3：`;` `/` `,` `?` 留给段语义，一律转义 —— Go shouldEscape 同款）。
 *  cookiecloud.rs `path_escape` 的移植（v3 里 CookieCloud 走宿主，这里供 UUID 拼路径兜底）。 */
export function pathEscape(text) {
  let out = ''
  for (const byte of new TextEncoder().encode(String(text))) {
    const keep =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d || byte === 0x5f || byte === 0x2e || byte === 0x7e ||
      byte === 0x24 || byte === 0x26 || byte === 0x2b || byte === 0x3a ||
      byte === 0x3d || byte === 0x40
    out += keep ? String.fromCharCode(byte) : '%' + HEX[byte >> 4] + HEX[byte & 0x0f]
  }
  return out
}

// ─────────────────────────── Go url.ParseQuery ───────────────────────────

/** Go `url.ParseQuery`（同名键取第一个值，对齐 Values.Get）：含 `;` 的段跳过、
 *  空段跳过、转义失败的段跳过。 */
export function parseQuery(raw) {
  const values = new Map()
  for (const pair of String(raw).split('&')) {
    if (pair === '' || pair.includes(';')) continue
    const eq = pair.indexOf('=')
    const rawKey = eq === -1 ? pair : pair.slice(0, eq)
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1)
    const key = queryUnescape(rawKey)
    if (key === null) continue
    const value = queryUnescape(rawValue)
    if (value === null) continue
    if (!values.has(key)) values.set(key, value)
  }
  return values
}

// ─────────────────────────── QQ qqHash33 ───────────────────────────

/** Go `qqHash33`（qq.go:23）：33 进制滚动哈希，取低 31 位。
 *  Rust 用 i32 回绕运算（低 32 位与 Go 的 u64 回绕逐位相同），JS 用 |0 模拟同样的 32 位回绕。 */
export function hash33(text) {
  let hash = 0
  for (const ch of String(text)) {
    const code = ch.codePointAt(0) | 0
    hash = (hash + ((hash << 5) + code)) | 0
  }
  return hash & 0x7fffffff
}

// ─────────────────────────── 短 id（tasks.rs）───────────────────────────

/** FNV-1a 64 位（无依赖的稳定散列）。JS 用 BigInt 保持 64 位回绕语义。 */
export function fnv1a64(bytes) {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return hash
}

const BASE36_DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'
/** Go `strconv.FormatInt(v, 36)` 的小写 base36。 */
export function base36(value) {
  let v = BigInt(value)
  if (v === 0n) return '0'
  let out = ''
  while (v > 0n) {
    out = BASE36_DIGITS[Number(v % 36n)] + out
    v /= 36n
  }
  return out
}

/** 短 id 的取值空间：36^8，保证 base36 结果不超过 8 字符。 */
const ID_SPACE = 2821109907456n

/** 由种子得到 ≤8 字符的 base36 短 id（tasks.rs `short_id`）。 */
export function shortId(seed) {
  return base36(fnv1a64(new TextEncoder().encode(String(seed))) % ID_SPACE)
}

/** 分配一个队列内唯一的短 id：同种子碰撞时追加 `#n` 重散列（tasks.rs `allocate_id`）。 */
export function allocateId(existing, seed) {
  const taken = new Set(existing.map(String))
  for (let attempt = 0; attempt < 64; attempt++) {
    const probe = attempt === 0 ? String(seed) : `${seed}#${attempt}`
    const id = shortId(probe)
    if (!taken.has(id)) return id
  }
  return shortId(`${seed}#${Date.now()}`)
}

// ─────────────────────────── 随机国内 IP 头（netease.rs）───────────────────────────

/** sidecar `server.mjs:81` 的国内 IP 前缀表。 */
const CN_PREFIXES = [
  [116, 255],
  [116, 228],
  [218, 192],
  [124, 0],
  [14, 132],
  [183, 14],
  [58, 14],
  [113, 116],
  [120, 230],
]

/** 随机国内 IP 头（sidecar `server.mjs:79-89`）：网易云风控按 X-Real-IP / X-Forwarded-For
 *  判定客户端位置，缺失时报 8821「请切换其他登录方式」。`rng` 注入 [0,1) 随机源（纯函数）。 */
export function ipHeaders(rng = Math.random) {
  const value = Math.floor(rng() * 0xffffffff) >>> 0
  const prefix = CN_PREFIXES[value % CN_PREFIXES.length]
  const third = (Math.floor(value / 0x100) % 254) + 1
  const fourth = (Math.floor(value / 0x10000) % 254) + 1
  const ip = `${prefix[0]}.${prefix[1]}.${third}.${fourth}`
  return { 'x-real-ip': ip, 'x-forwarded-for': ip }
}

// ─────────────────────────── 文本截断（util.rs）───────────────────────────

/** util.rs `TRUNC_LIMIT`：错误文案尾巴的字节上限。 */
export const TRUNC_LIMIT = 200

/** util.rs `trunc`：按 UTF-8 字节截断到 `limit`，截断处补 "...(truncated)"。
 *  用 code point 保守截断（不劈开代理对），长度按字节复核。 */
export function trunc(text, limit = TRUNC_LIMIT) {
  const raw = String(text ?? '')
  const bytes = new TextEncoder().encode(raw)
  if (bytes.length <= limit) return raw
  const suffix = '...(truncated)'
  const budget = Math.max(0, limit - suffix.length)
  let out = ''
  let used = 0
  for (const ch of raw) {
    const size = new TextEncoder().encode(ch).length
    if (used + size > budget) break
    out += ch
    used += size
  }
  return out + suffix
}

/** download.rs `truncate_chars`：按字符数（code point）截断。 */
export function truncateChars(text, limit) {
  const raw = String(text ?? '')
  const chars = [...raw]
  return chars.length <= limit ? raw : chars.slice(0, limit).join('')
}

/** 时间戳：宿主 JS 有真实时钟，统一毫秒。 */
export function nowMs() {
  return Date.now()
}

/** 纳秒时间戳（BigInt）：供 requestId / guidFromNanos / qrShowT 复刻 Go UnixNano 语义。 */
export function nowNanos() {
  return BigInt(Date.now()) * 1000000n
}

/** RFC3339（clock.rs `now_rfc3339` 的宿主形态）：秒级精度 UTC。 */
export function nowRfc3339() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}
