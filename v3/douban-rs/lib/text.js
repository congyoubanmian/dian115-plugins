// 文本与编码小工具 —— plugins/douban-rs/src/{util.rs,charts.rs,subscribe.rs,poster.rs}
// 里纯函数部分的集中移植（语义锚点逐条标注出处）。

/** util.rs TRUNC_LIMIT：错误信息回显按字节截断的窗口。 */
export const TRUNC_LIMIT = 200

/**
 * util.rs `go_lossy`：逐字节 U+FFFD 替换（Go encoding/json 语义）。
 * Go 的 DecodeRune 对任何非法/残缺序列都只消费 1 个字节并产出 1 个 U+FFFD，
 * TextDecoder 则把残序列合并成一个替换符 —— 所以这里按 RFC 3629 接受表
 * （含超长编码、代理区、>U+10FFFF 的拒绝）手写解码，逐字节对齐。
 */
const UTF8_CONT = 0x80
const UTF8_CONT_MAX = 0xbf

function utf8SequenceLength(data, i) {
  const b0 = data[i]
  if (b0 < 0x80) return 1
  const cont = (p, lo = UTF8_CONT, hi = UTF8_CONT_MAX) =>
    p < data.length && data[p] >= lo && data[p] <= hi
  if (b0 >= 0xc2 && b0 <= 0xdf) {
    if (!cont(i + 1)) return 0
    return 2
  }
  if (b0 === 0xe0) {
    if (!cont(i + 1, 0xa0)) return 0
    if (!cont(i + 2)) return 0
    return 3
  }
  if (b0 >= 0xe1 && b0 <= 0xec) {
    if (!cont(i + 1) || !cont(i + 2)) return 0
    return 3
  }
  if (b0 === 0xed) {
    if (!cont(i + 1, UTF8_CONT, 0x9f)) return 0
    if (!cont(i + 2)) return 0
    return 3
  }
  if (b0 >= 0xee && b0 <= 0xef) {
    if (!cont(i + 1) || !cont(i + 2)) return 0
    return 3
  }
  if (b0 === 0xf0) {
    if (!cont(i + 1, 0x90)) return 0
    if (!cont(i + 2) || !cont(i + 3)) return 0
    return 4
  }
  if (b0 >= 0xf1 && b0 <= 0xf3) {
    if (!cont(i + 1) || !cont(i + 2) || !cont(i + 3)) return 0
    return 4
  }
  if (b0 === 0xf4) {
    if (!cont(i + 1, UTF8_CONT, 0x8f)) return 0
    if (!cont(i + 2) || !cont(i + 3)) return 0
    return 4
  }
  return 0
}

export function goLossy(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? 0)
  let out = ''
  let i = 0
  while (i < data.length) {
    const len = utf8SequenceLength(data, i)
    if (len === 0) {
      out += '\uFFFD'
      i += 1
      continue
    }
    if (len === 1) {
      out += String.fromCharCode(data[i])
      i += 1
      continue
    }
    const leadMask = len === 2 ? 0x1f : len === 3 ? 0x0f : 0x07
    let cp = data[i] & leadMask
    for (let k = 1; k < len; k++) cp = cp * 64 + (data[i + k] & 0x3f)
    out += String.fromCodePoint(cp)
    i += len
  }
  return out
}

/** util.rs `trunc`：超 200 字节截断后按 Go 语义还原成字符串。 */
export function trunc(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes ?? ''))
  const n = Math.min(data.length, TRUNC_LIMIT)
  return goLossy(data.subarray(0, n))
}

/**
 * util.rs `stringVal`：action input 取值的 Go `stringVal` 语义。
 * null/undefined → ''；字符串原样；其余标量按字面；对象/数组给紧凑 JSON。
 */
export function stringVal(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/** charts.rs `collapse_space`：标题里的连续空白（Go \s = [\t\n\f\r ]）压成一个空格。 */
export function collapseSpace(text) {
  return String(text ?? '').replace(/[\t\n\f\r ]+/g, ' ')
}

/** charts.rs `parseWant`：从「1,234 人想看」取数字，无匹配 0。 */
export function parseWant(text) {
  const match = /([0-9,]+)[\t\n\f\r ]*人?[\t\n\f\r ]*想看/.exec(String(text ?? ''))
  if (!match) return 0
  const digits = match[1].replace(/,/g, '')
  const value = Number.parseInt(digits, 10)
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

/** charts.rs `sourceCost`：抓取成本排序（subjects_json 1 < chart_html 2 < coming_html 3 < 其他 4）。 */
export function sourceCost(source) {
  if (source === 'subjects_json') return 1
  if (source === 'chart_html') return 2
  if (source === 'coming_html') return 3
  return 4
}

/**
 * charts.rs `sectionAfter`：字节查找截段落（取代大页面上的惰性正则）。
 * 找不到锚点 → 原样返回；open/close 找不到就保持不动。
 */
export function sectionAfter(html, anchor, openTag, closeTag) {
  const anchorAt = html.indexOf(anchor)
  if (anchorAt < 0) return html
  let start = anchorAt
  let end = html.length
  if (openTag !== '') {
    const openAt = html.indexOf(openTag, anchorAt)
    if (openAt >= 0) start = openAt
  }
  if (closeTag !== '') {
    const closeAt = html.indexOf(closeTag, anchorAt)
    if (closeAt >= 0) end = closeAt
  }
  return html.slice(start, end)
}

/**
 * charts.rs `query_escape`（Go url.QueryEscape）：
 * 放行 A-Za-z0-9-_.~，空格变 +，其余按 UTF-8 字节 %XX。
 */
export function queryEscape(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''))
  const hex = '0123456789ABCDEF'
  let out = ''
  for (const byte of bytes) {
    const isUnreserved =
      (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d || byte === 0x5f || byte === 0x2e || byte === 0x7e
    if (isUnreserved) out += String.fromCharCode(byte)
    else if (byte === 0x20) out += '+'
    else out += `%${hex[byte >> 4]}${hex[byte & 0x0f]}`
  }
  return out
}

/**
 * cookiecloud.rs/poster.rs/subject.rs `path_escape`（Go url.PathEscape，encodePathSegment）：
 * 放行 A-Za-z0-9-_.~ 与 $ & + : = @，其余（含 / ; , ?）%XX。
 */
export function pathEscape(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''))
  const hex = '0123456789ABCDEF'
  let out = ''
  for (const byte of bytes) {
    const keep =
      (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d || byte === 0x5f || byte === 0x2e || byte === 0x7e ||
      byte === 0x24 || byte === 0x26 || byte === 0x2b || byte === 0x3a || byte === 0x3d || byte === 0x40
    if (keep) out += String.fromCharCode(byte)
    else out += `%${hex[byte >> 4]}${hex[byte & 0x0f]}`
  }
  return out
}

/** charts.rs `go_quote`：Go `%q` 的最小等价物（诊断文案 `未知榜单来源 "x"`）。 */
export function goQuote(text) {
  let out = '"'
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0)
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (code < 0x20) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += ch
  }
  return out + '"'
}

/**
 * subscribe.rs `normalizeTitle`：小写 + trim + 全角标点折算（（→( ）→) ：→: ·→空格
 * ，→, 。！？删除），用于标题比较。
 */
export function normalizeTitle(text) {
  const lowered = String(text ?? '').toLowerCase()
  const trimmed = lowered.trim()
  let out = ''
  for (const ch of trimmed) {
    if (ch === '（') out += '('
    else if (ch === '）') out += ')'
    else if (ch === '：') out += ':'
    else if (ch === '·') out += ' '
    else if (ch === '，') out += ','
    else if (ch === '。' || ch === '！' || ch === '？') { /* 删除 */ }
    else out += ch
  }
  return out
}

/** subscribe.rs `safeKey`：只保留 [A-Za-z0-9_-]，空结果给 unknown（幂等键必须可打印 ASCII）。 */
export function safeKey(text) {
  const raw = String(text ?? '')
  if (raw === '') return 'unknown'
  const filtered = raw.replace(/[^A-Za-z0-9_-]/g, '')
  return filtered === '' ? 'unknown' : filtered
}

/**
 * runtime.rs `log` 的截断（Go `main.go:1077`）：超 400 字节时逐字节回退到合法
 * UTF-8 边界再追加 `…(截断)`。
 */
export function truncateUtf8Boundary(text, limit) {
  const raw = String(text ?? '')
  const bytes = new TextEncoder().encode(raw)
  if (bytes.length <= limit) return raw
  let cut = limit
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut -= 1
  return goLossy(bytes.subarray(0, cut)) + '…(截断)'
}
