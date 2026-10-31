// 防御式 JSON 解析层 —— 对照 plugins/chase-rs/src/raw.rs 的松散取数与脱敏纪律。
//
// 三条纪律（与旧 Rust 实现逐条对应）：
// 1. 绝不默认零值继续：解析不出来就返回 null，调用方跳过该条并留诊断原文；
// 2. 类型宽松：数字可以来自 JSON number，也可以是纯数字字符串；
// 3. 脱敏：写进状态文档前递归丢弃键名命中凭据模式的子字段。

/** 宿主返回值已经是对象；字符串则 JSON.parse，其余原样。失败抛 Error（调用方按 unparsed 归类）。 */
export function decodeJson(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') throw new Error('响应正文为空')
    return JSON.parse(trimmed)
  }
  if (value === null || value === undefined) throw new Error('响应正文为空')
  return value
}

/** 宽松取非负整数：JSON number（整数值）或纯数字字符串；布尔按 0/1；负数一律不认。 */
export function looseU64(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return null
    return value
  }
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '' || !/^\d+$/.test(trimmed)) return null
    const parsed = Number(trimmed)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

/** 宽松取整数（允许负号，用于 emby_proxy_id 这类可能为 -1 的配置）。 */
export function looseI64(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return null
    return value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^[+-]?\d+$/.test(trimmed)) return null
    const parsed = Number(trimmed)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

/** 宽松取字符串：字符串原样；数字/布尔转文本；null/对象/数组不认。 */
export function looseString(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return null
}

/** 对象里第一个命中的候选键（null 视为缺失，与 raw.rs first_of 一致）。 */
export function firstOf(obj, keys) {
  if (!obj || typeof obj !== 'object') return null
  for (const key of keys) {
    const value = obj[key]
    if (value !== null && value !== undefined) return value
  }
  return null
}

export function firstI64(obj, keys) {
  const value = firstOf(obj, keys)
  return value === null ? null : looseI64(value)
}

export function firstU64(obj, keys) {
  const value = firstOf(obj, keys)
  return value === null ? null : looseU64(value)
}

export function firstString(obj, keys) {
  const value = firstOf(obj, keys)
  return value === null ? null : looseString(value)
}

/** 对象里第一个候选键为 true 的布尔（is_default 这类标记）。 */
export function firstBool(obj, keys) {
  if (!obj || typeof obj !== 'object') return false
  return keys.some((key) => obj[key] === true)
}

/** 下探一层：若 value 是对象，取第一个命中的候选键。 */
export function descend(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return firstOf(value, keys)
}

/** 取数组：value 本身是数组，或对象里第一个命中的候选键是数组。 */
export function arrayAt(value, keys) {
  if (Array.isArray(value)) return value
  const inner = descend(value, keys)
  return Array.isArray(inner) ? inner : null
}

/** 按 UTF-8 字节截断（不劈开码点），对照 raw.rs truncate_bytes。 */
export function truncateUtf8(text, maxBytes) {
  const source = text === null || text === undefined ? '' : String(text)
  if (maxBytes <= 0) return ''
  if (source.length <= maxBytes && byteLength(source) <= maxBytes) return source
  const bytes = new TextEncoder().encode(source)
  if (bytes.length <= maxBytes) return source
  let cut = maxBytes
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut -= 1
  return new TextDecoder('utf-8').decode(bytes.subarray(0, cut))
}

function byteLength(text) {
  return new TextEncoder().encode(text).length
}

const FORBIDDEN_PATTERNS = [
  'cookie',
  'token',
  'secret',
  'password',
  'authorization',
  'api_key',
  'api-key',
  'apikey',
]

/** 键名命中凭据模式（大小写不敏感）。 */
export function isForbiddenKey(key) {
  const lowered = String(key).toLowerCase()
  return FORBIDDEN_PATTERNS.some((pattern) => lowered.includes(pattern))
}

/** 全文档递归找第一个命中的凭据键名；没有则返回 null。 */
export function containsForbiddenKey(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = containsForbiddenKey(item)
      if (found) return found
    }
    return null
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (isForbiddenKey(key)) return key
      const found = containsForbiddenKey(child)
      if (found) return found
    }
  }
  return null
}

/** 就地递归删除凭据键名命中的子字段（对照 raw.rs sanitize）。 */
export function sanitize(value) {
  if (Array.isArray(value)) {
    for (const item of value) sanitize(item)
    return value
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (isForbiddenKey(key)) delete value[key]
    }
    for (const child of Object.values(value)) sanitize(child)
  }
  return value
}

/** 探测原文样本：JSON 就脱敏后重序列化，否则按文本截断（≤maxBytes 字节）。 */
export function sampleText(value, maxBytes) {
  try {
    const decoded = decodeJson(typeof value === 'string' ? value : structuredCloneSafe(value))
    sanitize(decoded)
    return truncateUtf8(JSON.stringify(decoded), maxBytes)
  } catch {
    const text = typeof value === 'string' ? value : stringifyLossy(value)
    return truncateUtf8(text, maxBytes)
  }
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value)
    } catch {
      /* 不可克隆对象走字符串路径 */
    }
  }
  return value
}

function stringifyLossy(value) {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
