// 纯 Uint8Array bencode 解析器（零 Node Buffer 依赖，兼容 DIAN115 v3 后台与浏览器）。
//
// 设计要点：
// - 只用 Uint8Array + TextDecoder，不调用 Buffer / buf.toString('latin1')
// - parseTorrentMeta() 解析顶层元数据、info_hash 区间、文件列表与 pieces 切片，
//   解析 info 字典时跳过把整个 pieces 复制成字符串，避免大种子内存峰值。

const UTF8 = typeof TextDecoder === 'function' ? new TextDecoder('utf-8', { fatal: false }) : null

function decodeUtf8(bytes) {
  if (!(bytes instanceof Uint8Array)) return String(bytes ?? '')
  if (UTF8) return UTF8.decode(bytes)
  // 兜底 UTF-8 解码
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b0 = bytes[i++]
    if (b0 < 0x80) {
      out += String.fromCharCode(b0)
    } else if ((b0 & 0xe0) === 0xc0 && i < bytes.length) {
      const b1 = bytes[i++]
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f))
    } else if ((b0 & 0xf0) === 0xe0 && i + 1 < bytes.length) {
      const b1 = bytes[i++]
      const b2 = bytes[i++]
      out += String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f))
    } else if ((b0 & 0xf8) === 0xf0 && i + 2 < bytes.length) {
      const b1 = bytes[i++]
      const b2 = bytes[i++]
      const b3 = bytes[i++]
      const cp = (((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f)) - 0x10000
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
    } else {
      out += '\ufffd'
    }
  }
  return out
}

function decodeAscii(buf, start, end) {
  let s = ''
  for (let i = start; i < end; i++) s += String.fromCharCode(buf[i])
  return s
}

function parseAsciiInt(buf, start, end) {
  if (start >= end) return NaN
  let i = start
  let neg = false
  if (buf[i] === 0x2d) { // '-'
    neg = true
    i++
    if (i >= end) return NaN
  }
  let val = 0
  for (; i < end; i++) {
    const d = buf[i] - 0x30
    if (d < 0 || d > 9) return NaN
    val = val * 10 + d
  }
  return neg ? -val : val
}

function findByte(buf, byte, from, end) {
  for (let i = from; i < end; i++) {
    if (buf[i] === byte) return i
  }
  return -1
}

function ensureBytes(input) {
  if (input instanceof Uint8Array) return input
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (Array.isArray(input)) return new Uint8Array(input)
  return null
}

// 从 i 开始跳过一个完整的 bencode 值，返回其后的下标。
function skipValue(buf, i, end) {
  if (i >= end) return end
  const c = buf[i]
  if (c === 0x69) { // 'i' <digits> 'e'
    const e = findByte(buf, 0x65, i + 1, end)
    return e < 0 ? end : e + 1
  }
  if (c === 0x6c) { // 'l' ... 'e'
    let p = i + 1
    while (p < end && buf[p] !== 0x65) {
      const next = skipValue(buf, p, end)
      if (next <= p) return end
      p = next
    }
    return p < end ? p + 1 : end
  }
  if (c === 0x64) { // 'd' (<key><value>)* 'e'
    let p = i + 1
    while (p < end && buf[p] !== 0x65) {
      const kEnd = skipValue(buf, p, end)
      if (kEnd <= p) return end
      const vEnd = skipValue(buf, kEnd, end)
      if (vEnd <= kEnd) return end
      p = vEnd
    }
    return p < end ? p + 1 : end
  }
  if (c >= 0x30 && c <= 0x39) { // <len>:<bytes>
    const colon = findByte(buf, 0x3a, i, end)
    if (colon < 0) return end
    const len = parseAsciiInt(buf, i, colon)
    if (!Number.isFinite(len) || len < 0) return end
    return Math.min(colon + 1 + len, end)
  }
  return end
}

// 在字典体 [start, end) 内按 key 查找，返回值的 { valueStart, valueEnd }。
function dictFind(buf, start, end, key) {
  let p = start
  while (p < end && buf[p] !== 0x65) {
    const colon = findByte(buf, 0x3a, p, end)
    if (colon < 0) return null
    const kLen = parseAsciiInt(buf, p, colon)
    if (!Number.isFinite(kLen) || kLen < 0) return null
    const kStart = colon + 1
    const kEnd = kStart + kLen
    if (kEnd > end) return null
    const vStart = kEnd
    const vEnd = skipValue(buf, vStart, end)
    if (vEnd <= vStart) return null
    if (kLen === key.length && decodeAscii(buf, kStart, kEnd) === key) {
      return { valueStart: vStart, valueEnd: vEnd }
    }
    p = vEnd
  }
  return null
}

function decodeAt(buf, i, end, skipKeys = null) {
  if (i >= end) return { value: null, next: end }
  const c = buf[i]
  if (c === 0x69) { // 'i'
    const e = findByte(buf, 0x65, i + 1, end)
    if (e < 0) return { value: 0, next: end }
    return { value: parseAsciiInt(buf, i + 1, e), next: e + 1 }
  }
  if (c === 0x6c) { // 'l'
    const arr = []
    let p = i + 1
    while (p < end && buf[p] !== 0x65) {
      const r = decodeAt(buf, p, end, skipKeys)
      arr.push(r.value)
      if (r.next <= p) break
      p = r.next
    }
    return { value: arr, next: p < end ? p + 1 : end }
  }
  if (c === 0x64) { // 'd'
    const obj = {}
    let p = i + 1
    while (p < end && buf[p] !== 0x65) {
      const k = decodeAt(buf, p, end, null)
      if (k.next <= p) break
      const key = k.value instanceof Uint8Array ? decodeUtf8(k.value) : String(k.value ?? '')
      if (skipKeys && skipKeys.has(key)) {
        const vEnd = skipValue(buf, k.next, end)
        p = vEnd
        continue
      }
      const v = decodeAt(buf, k.next, end, skipKeys)
      obj[key] = v.value
      if (v.next <= k.next) break
      p = v.next
    }
    return { value: obj, next: p < end ? p + 1 : end }
  }
  if (c >= 0x30 && c <= 0x39) {
    const colon = findByte(buf, 0x3a, i, end)
    if (colon < 0) return { value: new Uint8Array(0), next: end }
    const len = parseAsciiInt(buf, i, colon)
    if (!Number.isFinite(len) || len < 0) return { value: new Uint8Array(0), next: end }
    const start = colon + 1
    const stop = Math.min(start + len, end)
    return { value: buf.subarray(start, stop), next: stop }
  }
  return { value: null, next: end }
}

export function decode(raw) {
  const buf = ensureBytes(raw)
  if (!buf || !buf.length) return null
  return decodeAt(buf, 0, buf.length).value
}

// 返回顶层 info 字典的 [start, end) 字节区间，用于算 info_hash（sha1 of bencoded info）。
export function findInfoRange(raw) {
  const buf = ensureBytes(raw)
  if (!buf || buf.length < 2 || buf[0] !== 0x64) return null
  const info = dictFind(buf, 1, buf.length, 'info')
  if (!info || buf[info.valueStart] !== 0x64) return null
  return [info.valueStart, info.valueEnd]
}

// 快速定位 info.pieces，返回 { pieces: Uint8Array } 或 null
export function readTorrentPieces(raw) {
  const buf = ensureBytes(raw)
  if (!buf || buf.length < 2 || buf[0] !== 0x64) return null
  const info = dictFind(buf, 1, buf.length, 'info')
  if (!info || buf[info.valueStart] !== 0x64) return null
  const pieces = dictFind(buf, info.valueStart + 1, info.valueEnd, 'pieces')
  if (!pieces) return null
  const colon = findByte(buf, 0x3a, pieces.valueStart, pieces.valueEnd)
  if (colon < 0) return null
  const len = parseAsciiInt(buf, pieces.valueStart, colon)
  if (!Number.isFinite(len) || len <= 0) return null
  const start = colon + 1
  const stop = Math.min(start + len, pieces.valueEnd)
  return { pieces: buf.subarray(start, stop) }
}

// 校验字节流是不是合法 .torrent（防 200 HTML 错页混入）
export function isValidTorrentBytes(raw) {
  const buf = ensureBytes(raw)
  if (!buf || buf.length < 16 || buf[0] !== 0x64) return false
  return findInfoRange(buf) !== null
}

function extractHost(urlStr) {
  const s = String(urlStr || '').trim()
  if (!s) return ''
  try {
    return new URL(s).hostname.toLowerCase()
  } catch {
    const m = s.match(/^[a-z]+:\/\/([^/:?#]+)/i)
    return m ? m[1].toLowerCase() : ''
  }
}

// 一次解析种子全部核心元数据（跳过把 pieces 复制为额外对象，兼顾速度与内存）
export function parseTorrentMeta(raw) {
  const buf = ensureBytes(raw)
  if (!buf || buf.length < 2 || buf[0] !== 0x64) return null

  const infoRange = findInfoRange(buf)
  if (!infoRange) return null
  const piecesObj = readTorrentPieces(buf)
  if (!piecesObj || !piecesObj.pieces.length) return null

  // 解码除 pieces 以外的所有字段
  const root = decodeAt(buf, 0, buf.length, new Set(['pieces'])).value
  if (!root || typeof root !== 'object' || !root.info) return null
  const info = root.info

  const nameBytes = info['name.utf-8'] || info.name
  const name = nameBytes instanceof Uint8Array ? decodeUtf8(nameBytes) : String(nameBytes || '')

  const files = []
  let totalSize = 0
  if (Array.isArray(info.files)) {
    for (const f of info.files) {
      if (!f || typeof f !== 'object') continue
      const parts = f['path.utf-8'] || f.path || []
      const relParts = Array.isArray(parts)
        ? parts.map((p) => (p instanceof Uint8Array ? decodeUtf8(p) : String(p || '')))
        : []
      const rel = relParts.join('/')
      const length = Number(f.length) || 0
      totalSize += length
      files.push({ path: name ? name + '/' + rel : rel, length })
    }
  } else {
    const length = Number(info.length) || 0
    totalSize = length
    if (name) files.push({ path: name, length })
  }

  const announce = root.announce instanceof Uint8Array ? decodeUtf8(root.announce) : ''
  const announceUrls = []
  if (announce) announceUrls.push(announce)
  if (Array.isArray(root['announce-list'])) {
    for (const tier of root['announce-list']) {
      if (Array.isArray(tier)) {
        for (const u of tier) {
          const s = u instanceof Uint8Array ? decodeUtf8(u) : String(u || '')
          if (s && !announceUrls.includes(s)) announceUrls.push(s)
        }
      } else if (tier instanceof Uint8Array) {
        const s = decodeUtf8(tier)
        if (s && !announceUrls.includes(s)) announceUrls.push(s)
      }
    }
  }

  const hostSet = new Set()
  for (const u of announceUrls) {
    const h = extractHost(u)
    if (h) hostSet.add(h)
  }

  return {
    name,
    files,
    totalSize,
    isMultiFile: Array.isArray(info.files),
    pieceLength: Number(info['piece length']) || 0,
    isPrivate: Number(info.private) === 1,
    announce,
    announceUrls,
    announceHosts: [...hostSet],
    pieces: piecesObj.pieces,
    infoRange
  }
}

// 兼容旧导出：从种子解出 [{ path, length }]
export function torrentFiles(raw) {
  const meta = parseTorrentMeta(raw)
  return meta ? meta.files : null
}
