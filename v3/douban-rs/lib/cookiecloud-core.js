// CookieCloud 核心 —— plugins/douban-rs/src/cookiecloud.rs 纯逻辑部分的移植。
//
// 协议（旧 cookiecloud.go / cookiecloud.rs）：
// - legacy（默认）：`"U2FsdGVkX1"` 开头（OpenSSL Salted）+ EVP_BytesToKey(md5) AES-256-CBC
// - `aes-128-cbc-fixed`：裸 base64 密文，key = 密钥材料，IV = 16 字节 0
// 两种模式的口令/密钥材料都是 `md5(uuid + "-" + password)` 的 hex 文本前 16 个字符
// （是 hex 文本的前 16 字节，不是摘要的前 16 字节）。
//
// v3 里 CookieCloud 默认走宿主内置能力（ctx.cookiecloud('read')，宿主负责解密），
// 本模块的解密链用于用户自建 CookieCloud 服务（settings 里显式填写地址/UUID/口令）
// 的回退路径。加解密原语经 crypto 适配器注入：jobs 用 ctx.crypto / ctx.codec，
// 测试用 node:crypto —— 本模块自身保持纯函数。

/** 密文长度上限（cookiecloud.rs MAX_COOKIE_CLOUD_BYTES）：base64 文本 512KB。 */
export const MAX_COOKIE_CLOUD_BYTES = 512 << 10

/**
 * cookiecloud.rs `cc_key_material`：md5(uuid + "-" + password) 的 hex 文本前 16 个字节。
 * crypto.md5Hex(Uint8Array) → 32 位小写 hex 字符串。
 */
export function ccKeyMaterial(uuid, password, crypto) {
  const encoder = new TextEncoder()
  const input = new Uint8Array(
    encoder.encode(String(uuid ?? '')).length + 1 + encoder.encode(String(password ?? '')).length,
  )
  input.set(encoder.encode(String(uuid ?? '')), 0)
  input.set(encoder.encode('-'), encoder.encode(String(uuid ?? '')).length)
  input.set(encoder.encode(String(password ?? '')), encoder.encode(String(uuid ?? '')).length + 1)
  const hexText = crypto.md5Hex(input)
  const material = hexText.slice(0, 16)
  return new TextEncoder().encode(material)
}

/** cookiecloud.rs `evp_bytes_to_key`（OpenSSL 兼容 KDF，MD5 一轮）：48 字节 = key(32) + iv(16)。 */
export function evpBytesToKey(passphrase, salt, crypto) {
  const out = new Uint8Array(48)
  let previous = new Uint8Array(0)
  let filled = 0
  while (filled < 48) {
    const hasher = new Uint8Array(previous.length + passphrase.length + salt.length)
    hasher.set(previous, 0)
    hasher.set(passphrase, previous.length)
    hasher.set(salt, previous.length + passphrase.length)
    previous = crypto.md5Bytes(hasher)
    out.set(previous, filled)
    filled += 16
  }
  return { key: out.slice(0, 32), iv: out.slice(32, 48) }
}

/**
 * cookiecloud.rs `aes_cbc_decrypt`：AES-CBC 解密 + PKCS7 去填充。
 * crypto.aesCbcDecrypt(key, iv, data) → 明文字节；填充不合法时抛错
 * （错误文案与旧实现一致：`填充校验失败（密钥不对或数据损坏）`）。
 */
export function aesCbcDecrypt(data, key, iv, crypto) {
  if (key.length !== 16 && key.length !== 32) {
    throw new Error(`非法密钥长度 ${key.length}`)
  }
  if (data.length === 0 || data.length % 16 !== 0) {
    throw new Error(`密文长度非法 (${data.length})`)
  }
  try {
    const plain = crypto.aesCbcDecrypt(key, iv, data)
    if (plain === null || plain === undefined || plain.length === 0) {
      throw new Error('填充校验失败（密钥不对或数据损坏）')
    }
    return plain
  } catch (error) {
    if (String(error?.message ?? '').startsWith('非法密钥长度') || String(error?.message ?? '').startsWith('密文长度非法')) throw error
    throw new Error('填充校验失败（密钥不对或数据损坏）')
  }
}

/** 容忍缺失 `=` 填充的 base64 解码（cookiecloud.rs decode_ciphertext_base64：先 Std 再 RawStd）。 */
export function decodeCiphertextBase64(encrypted, codec) {
  try {
    return codec.base64Decode(String(encrypted ?? ''))
  } catch {
    try {
      return codec.base64DecodeUnpadded(String(encrypted ?? ''))
    } catch {
      throw new Error('密文 base64 解码失败')
    }
  }
}

/** cookiecloud.rs `cookie_cloud_decrypt`：按 crypto_type 分派两条解密路径。 */
export function cookieCloudDecrypt(encrypted, cryptoType, uuid, password, crypto, codec) {
  const material = ccKeyMaterial(uuid, password, crypto)
  let raw
  try {
    raw = decodeCiphertextBase64(encrypted, codec)
  } catch (error) {
    throw new Error(`密文 base64 解码失败: ${error.message ?? ''}`.trim())
  }
  if (cryptoType === 'aes-128-cbc-fixed') {
    return aesCbcDecrypt(raw, material, new Uint8Array(16), crypto)
  }
  // legacy：OpenSSL Salted 格式
  const salted = new TextEncoder().encode('Salted__')
  if (raw.length < 32 || !equalsBytes(raw.subarray(0, 8), salted)) {
    throw new Error('未知密文格式')
  }
  const salt = raw.subarray(8, 16)
  const { key, iv } = evpBytesToKey(material, salt, crypto)
  return aesCbcDecrypt(raw.subarray(16), key, iv, crypto)
}

function equalsBytes(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * cookiecloud.rs `douban_cookie_from_cloud`：旧版 `{域名: cookie 集合}` 文档 →
 * `(cookie 头, uid, jar 大小)`。域名含 douban.com 的才收；新版数组形态
 * （[{name,value}]）与旧版对象形态（{name:value}）都要认；同名先见先得（按域名字典序）。
 */
export function doubanCookieFromCloud(cookieData) {
  const jar = new Map()
  const domains = Object.keys(cookieData ?? {}).sort()
  for (const domain of domains) {
    if (!domain.includes('douban.com')) continue
    const raw = cookieData[domain]
    if (Array.isArray(raw)) {
      for (const cookie of raw) {
        const name = String(cookie?.name ?? '')
        const value = String(cookie?.value ?? '')
        if (name !== '' && value !== '' && !jar.has(name)) jar.set(name, value)
      }
      continue
    }
    if (raw && typeof raw === 'object') {
      for (const [name, value] of Object.entries(raw)) {
        if (!jar.has(name)) jar.set(name, String(value ?? ''))
      }
    }
  }
  return finishDoubanJar(jar)
}

/**
 * v3 宿主 `ctx.cookiecloud('read')` 快照 → 同款三元组。
 * 快照形态：{cookies: [{name, value, domain, ...}]}（core-types.d.ts CookieCloudSnapshot）。
 * 为保证结果确定，先按域名字典序、再按出现顺序"先见先得"。
 */
export function doubanCookieFromSnapshot(snapshot) {
  const entries = Array.isArray(snapshot?.cookies) ? snapshot.cookies : []
  const jar = new Map()
  const sorted = [...entries].sort((a, b) => (String(a?.domain ?? '') < String(b?.domain ?? '') ? -1 : String(a?.domain ?? '') > String(b?.domain ?? '') ? 1 : 0))
  for (const entry of sorted) {
    const domain = String(entry?.domain ?? '')
    if (!domain.includes('douban.com')) continue
    const name = String(entry?.name ?? '')
    const value = String(entry?.value ?? '')
    if (name === '' || value === '') continue
    if (!jar.has(name)) jar.set(name, value)
  }
  return finishDoubanJar(jar)
}

function finishDoubanJar(jar) {
  const dbcl2 = jar.get('dbcl2') ?? ''
  if (dbcl2 === '') return { header: '', uid: '', count: jar.size }
  // dbcl2 的值可能带引号（dbcl2="123:token"），uid 是冒号前段去掉引号
  const uid = dbcl2.split(':', 1)[0].replace(/^"+|"+$/g, '')
  // 旧实现用 BTreeMap 存 jar：header 键按字典序（结果确定）
  const header = [...jar.keys()].sort().map((name) => `${name}=${jar.get(name)}`).join('; ')
  return { header, uid, count: jar.size }
}

/**
 * wish.rs `parse_manual_cookie`：接受整段 cookie 头或仅 `dbcl2=xxx`；
 * 没有 `=` 或没有 dbcl2 时返回空。header 是 trim 后的整段原文。
 */
export function parseManualCookie(raw) {
  const text = String(raw ?? '').trim()
  if (text === '' || !text.includes('=')) return { header: '', uid: '' }
  let dbcl2 = ''
  for (const part of text.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1)
    if (name === 'dbcl2') dbcl2 = value
  }
  if (dbcl2 === '') return { header: '', uid: '' }
  const uid = dbcl2.split(':', 1)[0]
  return { header: text, uid }
}

/**
 * wish.rs `cookie_cache_fresh`：header/uid 非空且 fetched_at 在 45 分钟 TTL 内。
 * fetched_at 解析失败一律不新鲜；时间戳在未来（时钟回拨）仍算新鲜。
 */
export const COOKIE_CACHE_TTL_MS = 45 * 60 * 1_000

export function cookieCacheFresh(cache, nowNanos, parseRfc3339) {
  if (!cache || cache.header === '' || cache.uid === '') return false
  const fetchedAt = parseRfc3339(cache.fetched_at)
  if (fetchedAt === null) return false
  const elapsed = BigInt(nowNanos) - BigInt(fetchedAt)
  return elapsed < BigInt(COOKIE_CACHE_TTL_MS) * 1_000_000n
}
