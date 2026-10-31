// 时间与日历换算 —— 对照 plugins/chase-rs/src/clock.rs。
//
// 纯整数算法（Howard Hinnant civil_from_days / days_from_civil），全部 UTC 秒 +
// 固定分钟偏移，DST 不参与：日报的"本地小时"是用户显式配置的固定偏移。
// v3 里不再有 WASI：墙钟就是 Date.now()；带 `now` 参数的形态供测试与纯函数复用。

/** 当前 Unix 秒。 */
export function nowUnixSecs() {
  return Math.floor(Date.now() / 1000)
}

/** 当前 UTC 时间的 RFC3339 文本（`2026-10-01T12:34:56Z`，秒级）。 */
export function nowRfc3339(now = nowUnixSecs()) {
  return rfc3339FromUnix(now)
}

/** Unix 秒 → RFC3339（UTC）。 */
export function rfc3339FromUnix(seconds) {
  const secs = Math.max(0, Math.floor(seconds))
  const days = Math.floor(secs / 86_400)
  const rest = secs % 86_400
  const [year, month, day] = civilFromDays(days)
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(Math.floor(rest / 3600))}:${pad(Math.floor((rest % 3600) / 60))}:${pad(rest % 60)}Z`
}

/** RFC3339 文本 → Unix 秒。只吃自家格式（`YYYY-MM-DDTHH:MM:SS[Z|±HH:MM]`，秒级）；认不出返回 null。 */
export function parseRfc3339Secs(text) {
  if (typeof text !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})?$/.exec(text)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (hour > 23 || minute > 59 || second > 60) return null
  let seconds = daysFromCivil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second
  const suffix = match[7]
  if (suffix && suffix !== 'Z') {
    const offsetHour = Number(suffix.slice(1, 3))
    const offsetMinute = Number(suffix.slice(4, 6))
    const offset = offsetHour * 3600 + offsetMinute * 60
    seconds += suffix[0] === '+' ? -offset : offset
  }
  return seconds
}

/** 天数 → (年, 月, 日)。以 1970-01-01 为第 0 天。 */
export function civilFromDays(days) {
  const z = days + 719_468
  const era = Math.floor(z / 146_097)
  const doe = z - era * 146_097 // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365)
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)) // [0, 365]
  const mp = Math.floor((5 * doy + 2) / 153) // [0, 11]
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1 // [1, 31]
  const m = mp < 10 ? mp + 3 : mp - 9 // [1, 12]
  return [m <= 2 ? y + 1 : y, m, d]
}

/** (年, 月, 日) → 天数。 */
export function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yoe = y - era * 400 // [0, 399]
  const mp = month > 2 ? month - 3 : month + 9 // [0, 11]
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1 // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy // [0, 146096]
  return era * 146_097 + doe - 719_468
}

/** 带偏移的"本地"天数与秒内时刻。 */
function localParts(offsetMinutes, now = nowUnixSecs()) {
  const shifted = Math.floor(now) + Math.floor(offsetMinutes) * 60
  return [Math.floor(shifted / 86_400), ((shifted % 86_400) + 86_400) % 86_400]
}

/** 本地日期（`YYYY-MM-DD`），偏移取自 settings.report.tz_offset_minutes。 */
export function localDate(offsetMinutes, now = nowUnixSecs()) {
  const [days] = localParts(offsetMinutes, now)
  return dateFromDays(days)
}

/** 本地小时（0-23）。 */
export function localHour(offsetMinutes, now = nowUnixSecs()) {
  const [, seconds] = localParts(offsetMinutes, now)
  return Math.floor(seconds / 3600)
}

/** 天数 → `YYYY-MM-DD`。 */
export function dateFromDays(days) {
  const [year, month, day] = civilFromDays(days)
  const pad = (value) => String(value).padStart(2, '0')
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`
}

/** 日期加减天数；输入不是 `YYYY-MM-DD` 时返回 null（不猜）。 */
export function datePlusDays(date, delta) {
  const days = parseDateDays(date)
  return days === null ? null : dateFromDays(days + delta)
}

/** `YYYY-MM-DD` → 天数；非法输入（长度/分隔/范围）返回 null。 */
export function parseDateDays(date) {
  if (typeof date !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return daysFromCivil(year, month, day)
}

/** 把任意日期文本归一成 `YYYY-MM-DD`（取前 10 字符并校验；`2026/10/01` 形态单独归一）。 */
export function normalizeDate(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed.length < 10) return null
  const head = trimmed.slice(0, 10)
  if (parseDateDays(head) !== null) return head
  const slashed = head.replaceAll('/', '-')
  if (parseDateDays(slashed) !== null) return slashed
  return null
}

/** RFC3339 时刻是否在 `secs` 秒以内（解析不出就当作不新鲜）。 */
export function isFresh(at, secs, now = nowUnixSecs()) {
  const then = parseRfc3339Secs(at)
  if (then === null) return false
  return now >= then && now - then <= secs
}
