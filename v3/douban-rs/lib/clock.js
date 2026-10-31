// 墙钟时间 —— plugins/douban-rs/src/clock.rs 的逐函数移植。
//
// v3 的 jobs 跑在宿主 JS VM 里，Date 是语言内置全局（不是 Node 内置模块），可用。
// 时间戳口径与旧实现一致：Unix 纳秒（Date 只有毫秒精度，低 6 位恒为 0 —— 旧实现
// 只用到秒级精度与毫秒级时差，纳秒只是统一单位）。测试可用 setFixedNow 固定时钟。

/** RFC3339 文本的固定形态（clock.rs RFC3339_EXAMPLE）。 */
export const RFC3339_EXAMPLE = '2026-09-29T10:00:09Z'

// ── 测试钩子（clock.rs testhooks 的等价物） ──

let fixedNowNanos = null
const recordedSleeps = []

/** 固定"现在"（纳秒）；传 null 恢复真实时钟。仅测试使用。 */
export function setFixedNow(nanos) {
  fixedNowNanos = nanos === undefined ? null : nanos
}

/** 取走并清空已记录的 sleep 序列（测试断言用）。 */
export function takeSleeps() {
  return recordedSleeps.splice(0)
}

/** 当前 UTC 时间（Unix 纳秒）。 */
export function nowUnixNanos() {
  if (fixedNowNanos !== null) return fixedNowNanos
  return Date.now() * 1_000_000
}

/** 当前时间的 RFC3339(UTC) 文本。 */
export function nowRfc3339() {
  return rfc3339(nowUnixNanos())
}

/** Unix 纳秒 → `YYYY-MM-DDTHH:MM:SSZ`（clock.rs rfc3339）。 */
export function rfc3339(nanos) {
  const ms = Math.floor(Number(nanos) / 1_000_000)
  const epoch = ms >= 0 ? ms : 0
  const d = new Date(epoch)
  const pad = (v, w = 2) => String(v).padStart(w, '0')
  return (
    `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  )
}

/** 当前月份（clock.rs current_month；统计口径）。 */
export function currentMonth() {
  return monthOf(nowUnixNanos())
}

/** Unix 纳秒 → `YYYY-MM`。 */
export function monthOf(nanos) {
  const d = new Date(Math.floor(Number(nanos) / 1_000_000))
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** 定长数字段（clock.rs parse_digits）：全是 ASCII 数字才算数。 */
function parseDigitsAt(text, start, len) {
  if (start + len > text.length) return null
  let value = 0
  for (let i = start; i < start + len; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x30 || code > 0x39) return null
    value = value * 10 + (code - 0x30)
  }
  return value
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year, month) {
  if ([1, 3, 5, 7, 8, 10, 12].includes(month)) return 31
  if ([4, 6, 9, 11].includes(month)) return 30
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return 0
}

/**
 * 严格 RFC3339 解析（clock.rs parse_rfc3339 的逐分支移植）：
 * `YYYY-MM-DDTHH:MM:SS` + 时区（Z / ±HH:MM）+ 可选小数秒。
 * 非法输入（含缺时区、越界字段、1970 之前）返回 null —— 到期判定/缓存新鲜度
 * 都依赖"解析失败按已到期/不新鲜"的口径，绝不放宽。
 */
export function parseRfc3339(text) {
  if (typeof text !== 'string' || text.length < 20) return null
  if (text[4] !== '-' || text[7] !== '-' || text[10] !== 'T' || text[13] !== ':' || text[16] !== ':') return null
  const year = parseDigitsAt(text, 0, 4)
  const month = parseDigitsAt(text, 5, 2)
  const day = parseDigitsAt(text, 8, 2)
  const hour = parseDigitsAt(text, 11, 2)
  const minute = parseDigitsAt(text, 14, 2)
  const second = parseDigitsAt(text, 17, 2)
  if (year === null || month === null || day === null || hour === null || minute === null || second === null) return null
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
  if (hour > 23 || minute > 59 || second > 59) return null
  // 可选小数秒：截断到纳秒
  let index = 19
  let nanos = 0
  if (text[index] === '.') {
    index += 1
    const start = index
    while (index < text.length && text[index] >= '0' && text[index] <= '9') index += 1
    if (index === start) return null
    let scale = 100_000_000
    for (let i = start; i < index; i++) {
      if (scale === 0) break
      nanos += (text.charCodeAt(i) - 0x30) * scale
      scale = Math.floor(scale / 10)
    }
  }
  // 时区：Z 或 ±HH:MM
  let offsetSeconds = 0
  const tzMark = text[index]
  if (tzMark === 'Z' || tzMark === 'z') {
    index += 1
  } else if (tzMark === '+' || tzMark === '-') {
    const sign = tzMark === '-' ? -1 : 1
    if (text[index + 3] !== ':') return null
    const offsetHour = parseDigitsAt(text, index + 1, 2)
    const offsetMinute = parseDigitsAt(text, index + 4, 2)
    if (offsetHour === null || offsetMinute === null) return null
    if (offsetHour > 23 || offsetMinute > 59) return null
    offsetSeconds = sign * (offsetHour * 3600 + offsetMinute * 60)
    index += 6
  } else {
    return null
  }
  if (index !== text.length) return null
  const days = daysFromCivil(year, month, day)
  const seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offsetSeconds
  if (seconds < 0) return null
  return seconds * 1_000_000_000 + nanos
}

/** Howard Hinnant `days_from_civil`（clock.rs 同款，避免 Date 的解析宽容）。 */
export function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const mp = month > 2 ? month - 3 : month + 9
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146_097 + doe - 719_468
}

/** `Math.floor` 语义的除法（负数向 -∞），供纳秒算术使用。 */
export function floorDiv(a, b) {
  return Math.floor(a / b)
}

/**
 * 会话幂等键前缀（clock.rs session_nonce）：base36(会话起点纳秒)。
 * 进程内缓存一次；宿主保留幂等记录的时间窗口内不会重复。
 */
let sessionNonceCache = null
export function sessionNonce() {
  if (sessionNonceCache === null) sessionNonceCache = base36(nowUnixNanos())
  return sessionNonceCache
}

/** 仅供测试重置会话前缀。 */
export function resetSessionNonce() {
  sessionNonceCache = null
}

/** Go `strconv.FormatInt(v, 36)` 的小写 base36。 */
export function base36(value) {
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz'
  let v = BigInt(Math.floor(Number(value)))
  if (v < 0n) v = 0n
  if (v === 0n) return '0'
  let out = ''
  while (v > 0n) {
    out = digits[Number(v % 36n)] + out
    v /= 36n
  }
  return out
}

/** 休眠毫秒（jobs 用 ctx.sleep；本模块保留记录版供纯逻辑测试）。 */
export function recordSleep(ms) {
  recordedSleeps.push(ms)
}
