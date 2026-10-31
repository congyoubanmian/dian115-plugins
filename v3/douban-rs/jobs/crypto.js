// 加解密与编解码适配层 —— cookiecloud.rs 的原语需求在 v3 宿主能力上的接线。
//
// lib/cookiecloud-core.js 只依赖这个适配器接口：
//   { md5Hex(bytes) → hex文本, md5Bytes(bytes) → 字节, aesCbcDecrypt(key, iv, data) → 明文字节,
//     base64Decode(text) → 字节, base64Encode(bytes) → 文本 }
// jobs 侧用 ctx.crypto / ctx.codec 实现；测试侧用 node:crypto 实现同款接口。
// ctx.crypto / ctx.codec 是 v3 宿主后台标准库（developer-guide「后台标准库」），属契约能力；
// AES 不做插件内兜底实现（未经真机验证的密码学代码比明确报错更危险），缺席时明确抛错。
// MD5 的纯 JS 实现保留为兜底（已被 cookiecloud 向量与 node:crypto 双向对拍），
// base64 内联一份纯 JS 实现（jobs 环境没有 Node 内置模块，自带实现保证宿主/测试行为一致）。

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

/** 构造面向 lib/cookiecloud-core.js 的 crypto 适配器。 */
export function makeCrypto(ctx) {
  const hostCrypto = ctx?.crypto ?? null
  return {
    md5Hex(bytes) {
      if (hostCrypto?.md5) return hostCrypto.md5(bytes, 'hex')
      return pureMd5Hex(bytes)
    },
    md5Bytes(bytes) {
      const hex = hostCrypto?.md5 ? hostCrypto.md5(bytes, 'hex') : pureMd5Hex(bytes)
      const out = new Uint8Array(hex.length / 2)
      for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
      return out
    },
    aesCbcDecrypt(key, iv, data) {
      if (!hostCrypto?.aesDecrypt) {
        throw new Error('宿主未提供 ctx.crypto，无法解密 CookieCloud 数据')
      }
      const plain = hostCrypto.aesDecrypt({ mode: 'cbc', key, iv, data, padding: 'pkcs7', output: 'bytes' })
      return plain instanceof Uint8Array ? plain : new Uint8Array(plain)
    },
    base64Decode,
    base64Encode,
  }
}

// ─────────────────── 纯 JS 兜底实现（仅 MD5 与 base64） ───────────────────

/** MD5 的纯 JS 实现（RFC 1321；仅作宿主 ctx.crypto 缺席时的 MD5 兜底，已被向量对拍）。 */
export function pureMd5Hex(input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input ?? 0)
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ]
  const K = new Int32Array(64)
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0
  const bitLen = data.length * 8
  const padded = new Uint8Array((((data.length + 8) >> 6) + 1) << 6)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, bitLen >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(bitLen / 2 ** 32), true)
  let a0 = 0x67452301 | 0
  let b0 = 0xefcdab89 | 0
  let c0 = 0x98badcfe | 0
  let d0 = 0x10325476 | 0
  const m = new Int32Array(16)
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getInt32(chunk + i * 4, true)
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i++) {
      let f
      let g
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      const tmp = d
      d = c
      c = b
      const sum = (a + f + K[i] + m[g]) | 0
      b = (b + ((sum << s[i]) | (sum >>> (32 - s[i])))) | 0
      a = tmp
    }
    a0 = (a0 + a) | 0
    b0 = (b0 + b) | 0
    c0 = (c0 + c) | 0
    d0 = (d0 + d) | 0
  }
  const out = new Uint8Array(16)
  const outView = new DataView(out.buffer)
  outView.setInt32(0, a0, true)
  outView.setInt32(4, b0, true)
  outView.setInt32(8, c0, true)
  outView.setInt32(12, d0, true)
  return [...out].map((b) => b.toString(16).padStart(2, '0')).join('')
}
