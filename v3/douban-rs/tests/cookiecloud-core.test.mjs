// CookieCloud 核心测试 —— 向量来自 plugins/douban-rs/tests/cookiecloud_vectors.rs 共用的
// cookiecloud_vectors.json（脱敏构造的解密回归向量）。
// 双通道验证：node:crypto 适配器（宿主 ctx.crypto 的行为基准）+ jobs/crypto.js 的纯 JS 兜底。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash, createDecipheriv } from 'node:crypto'

import {
  ccKeyMaterial, evpBytesToKey, aesCbcDecrypt, cookieCloudDecrypt,
  doubanCookieFromCloud, doubanCookieFromSnapshot, parseManualCookie, cookieCacheFresh, COOKIE_CACHE_TTL_MS,
} from '../lib/cookiecloud-core.js'
import { parseRfc3339 } from '../lib/clock.js'
import { pureMd5Hex, base64Encode, base64Decode } from '../jobs/crypto.js'

const DOC = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/cookiecloud_vectors.json', import.meta.url)), 'utf8'))
const FIXED_NOW = 1_790_676_009_000_000_000

/**
 * node:crypto 适配器 —— 宿主 ctx.crypto 的行为基准（ctx.crypto 是 v3 后台标准库契约；
 * 插件不做未经真机验证的 AES 兜底，见 jobs/crypto.js 的说明）。
 */
const nodeCrypto = {
  md5Hex: (bytes) => createHash('md5').update(bytes).digest('hex'),
  md5Bytes: (bytes) => createHash('md5').update(bytes).digest(),
  aesCbcDecrypt: (key, iv, data) => {
    const algorithm = key.length === 16 ? 'aes-128-cbc' : 'aes-256-cbc'
    const decipher = createDecipheriv(algorithm, key, iv)
    return new Uint8Array(Buffer.concat([decipher.update(data), decipher.final()]))
  },
  base64Decode,
  base64Encode,
}

/** 纯 JS 适配器：只覆盖 MD5 与 base64 兜底（AES 无兜底）。 */
const pureCrypto = {
  md5Hex: pureMd5Hex,
  md5Bytes: (bytes) => {
    const hex = pureMd5Hex(bytes)
    const out = new Uint8Array(hex.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    return out
  },
  base64Decode,
  base64Encode,
}

const vector = (name) => DOC.vectors.find((entry) => entry.name === name)

test('密钥材料是 md5 hex 文本的前 16 字节（node:crypto 与纯 JS MD5 一致）', () => {
  for (const crypto of [nodeCrypto, pureCrypto]) {
    const material = ccKeyMaterial(DOC.uuid, DOC.password, crypto)
    assert.equal(material.length, 16)
    assert.equal(new TextDecoder().decode(material), DOC.material)
  }
  // 纯 JS MD5 必须与 node:crypto 逐字节一致（兜底路径的前提）
  const probe = new TextEncoder().encode('cc-test-uuid-cc-test-pass')
  assert.equal(pureMd5Hex(probe), createHash('md5').update(probe).digest('hex'))
})

test('每个向量都能解密回逐字节明文（node:crypto 基准）', () => {
  assert.ok(DOC.vectors.length >= 5, '至少覆盖 legacy 三形态 + fixed + 非 JSON 明文')
  for (const vectorEntry of DOC.vectors) {
    const plain = cookieCloudDecrypt(
      vectorEntry.encrypted, vectorEntry.crypto_type, DOC.uuid, DOC.password, nodeCrypto, nodeCrypto,
    )
    assert.equal(new TextDecoder().decode(plain), vectorEntry.plaintext, `${vectorEntry.name} 明文不一致`)
  }
})

test('EVP_BytesToKey 与 openssl（md5，1 轮）一致（MD5 双实现）', () => {
  for (const crypto of [nodeCrypto, pureCrypto]) {
    for (const vectorEntry of DOC.vectors) {
      const materialBytes = new TextEncoder().encode(DOC.material)
      let key
      let iv
      if (vectorEntry.salt_hex) {
        const salt = hexDecode(vectorEntry.salt_hex)
        ;({ key, iv } = evpBytesToKey(materialBytes, salt, crypto))
      } else {
        key = materialBytes
        iv = new Uint8Array(16)
      }
      assert.equal(bytesHex(key), vectorEntry.key_hex, `${vectorEntry.name} key`)
      assert.equal(bytesHex(iv), vectorEntry.iv_hex, `${vectorEntry.name} iv`)
    }
  }
})

test('错误口令/篡改密文 → 填充校验失败', () => {
  const entry = vector('legacy_modern_array')
  const crypto = nodeCrypto
  assert.throws(
    () => cookieCloudDecrypt(entry.encrypted, 'legacy', DOC.uuid, DOC.wrong_password, crypto, crypto),
    /填充校验失败（密钥不对或数据损坏）/,
  )
  assert.throws(
    () => cookieCloudDecrypt(DOC.tampered_legacy_b64, 'legacy', DOC.uuid, DOC.password, crypto, crypto),
    /填充校验失败（密钥不对或数据损坏）/,
  )
  assert.throws(
    () => cookieCloudDecrypt(DOC.tampered_fixed_b64, 'aes-128-cbc-fixed', DOC.uuid, DOC.password, crypto, crypto),
    /填充校验失败（密钥不对或数据损坏）/,
  )
})

test('格式与长度守卫的文案与 Go 一致', () => {
  const crypto = nodeCrypto
  assert.throws(
    () => cookieCloudDecrypt(DOC.unknown_format_b64, 'legacy', DOC.uuid, DOC.password, crypto, crypto),
    /未知密文格式/,
  )
  assert.throws(
    () => cookieCloudDecrypt(DOC.nonblock_b64, 'aes-128-cbc-fixed', DOC.uuid, DOC.password, crypto, crypto),
    /密文长度非法 \(10\)/,
  )
  assert.throws(
    () => cookieCloudDecrypt('', 'aes-128-cbc-fixed', DOC.uuid, DOC.password, crypto, crypto),
    /密文长度非法 \(0\)/,
  )
  assert.throws(
    () => cookieCloudDecrypt('!!!not-base64!!!', 'legacy', DOC.uuid, DOC.password, crypto, crypto),
    /密文 base64 解码失败/,
  )
  assert.throws(
    () => cookieCloudDecrypt('QUJD', 'legacy', DOC.uuid, DOC.password, crypto, crypto),
    /未知密文格式/,
  )
  // 非法密钥长度
  assert.throws(() => aesCbcDecrypt(new Uint8Array(16), new Uint8Array(20), new Uint8Array(16), crypto), /非法密钥长度 20/)
  // 全零 key/密文 → 填充校验失败
  assert.throws(() => aesCbcDecrypt(new Uint8Array(16), new Uint8Array(16), new Uint8Array(16), crypto), /填充校验失败/)
})

test('base64 容忍缺失的 = 填充（Go StdEncoding 宽容尾部）', () => {
  const entry = vector('legacy_modern_array')
  assert.ok(entry.encrypted.endsWith('=='), '这条向量必须带 base64 padding')
  const unpadded = entry.encrypted.replace(/=+$/, '')
  for (const input of [entry.encrypted, unpadded]) {
    const plain = cookieCloudDecrypt(input, 'legacy', DOC.uuid, DOC.password, nodeCrypto, nodeCrypto)
    assert.equal(new TextDecoder().decode(plain), entry.plaintext)
  }
  // base64 自实现的往返
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
  assert.deepEqual(base64Decode(base64Encode(bytes)), bytes)
})

test('纯 JS base64 的非法输入要抛错', () => {
  assert.throws(() => base64Decode('!!!not-base64!!!'), /illegal base64/)
  assert.throws(() => base64Decode('A'), /illegal base64/)
  assert.equal(base64Decode('').length, 0)
})

test('douban_cookie_from_cloud 认两种形态、字典序先见先得', () => {
  const data = {
    'a.douban.com': [
      { name: 'dbcl2', value: '"123456789:tok"', domain: '.douban.com' },
      { name: 'ck', value: 'ckv' },
      { name: 'empty', value: '' },
    ],
    'www.douban.com': { dbcl2: '999:other', bid: 'bidv' },
    'other.com': { dbcl2: 'nope' },
  }
  const { header, uid, count } = doubanCookieFromCloud(data)
  assert.equal(uid, '123456789')
  assert.equal(count, 3, 'dbcl2/ck/bid；空值条目被跳过，other.com 被忽略')
  assert.equal(header, 'bid=bidv; ck=ckv; dbcl2="123456789:tok"')
})

test('douban_cookie_from_cloud 无 dbcl2 时返回空 header', () => {
  assert.deepEqual(doubanCookieFromCloud({ 'example.com': [{ name: 'sid', value: 'x' }] }), { header: '', uid: '', count: 0 })
  assert.deepEqual(doubanCookieFromCloud({ 'douban.com': [{ name: 'ck', value: 'v' }] }), { header: '', uid: '', count: 1 })
  assert.deepEqual(doubanCookieFromCloud({ 'douban.com': [1, 2, 3] }), { header: '', uid: '', count: 0 })
})

test('douban_cookie_from_snapshot 解析宿主 CookieCloudSnapshot', () => {
  const snapshot = {
    revision: 'r1',
    domains: [{ domain: 'douban.com', cookie_count: 2 }],
    cookies: [
      { name: 'bid', value: 'bidv', domain: '.douban.com', path: '/', host_only: false, secure: false, http_only: false },
      { name: 'dbcl2', value: '"123456789:tok"', domain: '.douban.com', path: '/', host_only: false, secure: false, http_only: false },
      { name: 'ck', value: '', domain: '.douban.com', path: '/', host_only: false, secure: false, http_only: false },
      { name: 'ignored', value: 'x', domain: 'example.com', path: '/', host_only: false, secure: false, http_only: false },
    ],
  }
  const { header, uid, count } = doubanCookieFromSnapshot(snapshot)
  assert.equal(uid, '123456789')
  assert.equal(count, 2, '空值条目与非豆瓣域被跳过')
  assert.equal(header, 'bid=bidv; dbcl2="123456789:tok"')
})

test('parse_manual_cookie 向量（wish.rs 用例）', () => {
  assert.deepEqual(parseManualCookie('  dbcl2=123456789:tok; ck=abc  '), { header: 'dbcl2=123456789:tok; ck=abc', uid: '123456789' })
  assert.deepEqual(parseManualCookie('dbcl2=999:tok'), { header: 'dbcl2=999:tok', uid: '999' })
  assert.equal(parseManualCookie('').header, '')
  assert.equal(parseManualCookie('no-equals').header, '')
  assert.equal(parseManualCookie('ck=abc').header, '')
  assert.equal(parseManualCookie('123456789:tok').header, '')
  assert.equal(parseManualCookie('dbcl2=;ck=x').header, '')
  assert.equal(parseManualCookie('dbcl2=999').uid, '999')
})

test('cookie 缓存 TTL 45 分钟（严格小于；脏时间戳不新鲜）', () => {
  const fresh = (offsetMinutes) => ({
    header: 'dbcl2=x',
    uid: '1',
    source: 'cookiecloud',
    fetched_at: rfc3339Of(FIXED_NOW - offsetMinutes * 60 * 1_000_000_000),
  })
  assert.equal(COOKIE_CACHE_TTL_MS, 45 * 60 * 1000)
  assert.ok(cookieCacheFresh(fresh(0), FIXED_NOW, parseRfc3339))
  assert.ok(cookieCacheFresh(fresh(44), FIXED_NOW, parseRfc3339))
  assert.ok(!cookieCacheFresh(fresh(45), FIXED_NOW, parseRfc3339), '45 分钟整已过期（Go 严格小于）')
  assert.ok(!cookieCacheFresh(fresh(60), FIXED_NOW, parseRfc3339))
  assert.ok(!cookieCacheFresh({ header: '', uid: '', source: '', fetched_at: '' }, FIXED_NOW, parseRfc3339))
  const broken = fresh(1)
  broken.fetched_at = 'garbage'
  assert.ok(!cookieCacheFresh(broken, FIXED_NOW, parseRfc3339))
  const noUid = fresh(1)
  noUid.uid = ''
  assert.ok(!cookieCacheFresh(noUid, FIXED_NOW, parseRfc3339))
  // 时间戳在未来（时钟回拨）仍算新鲜
  const future = fresh(1)
  future.fetched_at = rfc3339Of(FIXED_NOW + 60 * 1_000_000_000)
  assert.ok(cookieCacheFresh(future, FIXED_NOW, parseRfc3339))
})

// ── 测试工具 ──
function hexDecode(text) {
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}
function bytesHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}
function rfc3339Of(nanos) {
  const d = new Date(Math.floor(nanos / 1_000_000))
  const pad = (v) => String(v).padStart(2, '0')
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
}
