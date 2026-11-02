// base64 编解码 —— jobs 环境没有 Node 内置模块，自带一份实现，保证宿主与测试行为一致。
// （原先随 CookieCloud 的 crypto 适配层一起放在 jobs/crypto.js；CookieCloud 下线后
//  只剩 base64 还在用，MD5/AES 兜底实现一并移除。）

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 标准 base64 解码（容忍缺失的 `=` 填充，等价 Go base64.StdEncoding 的宽容尾部）。 */
export function base64Decode(text) {
  const clean = String(text ?? '').replace(/[\r\n\t ]/g, '').replace(/=+$/, '')
  if (clean === '') return new Uint8Array(0)
  if (/[^A-Za-z0-9+/]/.test(clean)) throw new Error('illegal base64 data')
  const remainder = clean.length % 4
  if (remainder === 1) throw new Error('illegal base64 data')
  const length = Math.floor(clean.length / 4) * 3 + (remainder === 0 ? 0 : remainder - 1)
  const out = new Uint8Array(length)
  let buffer = 0
  let bits = 0
  let pointer = 0
  for (const ch of clean) {
    const value = B64_ALPHABET.indexOf(ch)
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[pointer++] = (buffer >> bits) & 0xff
    }
  }
  return out
}

/** 标准 base64 编码（补 padding；get-poster 的 dataURL 用）。 */
export function base64Encode(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? 0)
  let out = ''
  let i = 0
  for (; i + 3 <= data.length; i += 3) {
    const n = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
    out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63] + B64_ALPHABET[(n >> 6) & 63] + B64_ALPHABET[n & 63]
  }
  const rest = data.length - i
  if (rest === 1) {
    const n = data[i] << 16
    out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63] + '=='
  } else if (rest === 2) {
    const n = (data[i] << 16) | (data[i + 1] << 8)
    out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63] + B64_ALPHABET[(n >> 6) & 63] + '='
  }
  return out
}
