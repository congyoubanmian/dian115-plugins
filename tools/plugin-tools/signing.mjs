// Ed25519 包签名 —— 三个插件 package.mjs 共用的实现(签名逻辑不插件化, 保持一套实现):
//   * 签名域分隔: docs/plugin-platform/developer-guide.md §9 "Package, sign and publish";
//   * signature.json 结构与 keyId 推导逐字对齐原三个插件里的同一份代码。
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { base64url, sha256 } from './digest.mjs'
import { canonicalize } from './jcs.mjs'

// 签名消息的域分隔前缀, 同时是 signature.json 的 domain 字段。
export const PACKAGE_SIGNING_DOMAIN = 'DIAN115-PLUGIN-PACKAGE-V1'

/**
 * 从 SPKI DER 里取末尾 32 字节的 Ed25519 raw 公钥。
 * @param {import('node:crypto').KeyObject} privateKey
 * @returns {Buffer}
 */
export function rawPublicKey(privateKey) {
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  if (spki.length < 32) throw new Error('Invalid Ed25519 SPKI public key')
  return spki.subarray(spki.length - 32)
}

/**
 * manifest.publisher.key_id 的推导: ed25519:<base64url(sha256(rawpub))>。
 * @param {Uint8Array} publicKey
 * @returns {string}
 */
export function deriveKeyId(publicKey) {
  return `ed25519:${base64url(sha256(publicKey))}`
}

/**
 * 生成一把本地开发用 Ed25519 私钥并写入 keyPath(pkcs8 PEM, 0600)。
 * 只写文件不打印 —— 各插件保留自己的提示文案。
 * @param {string} keyPath
 */
export function writeDevelopmentPrivateKey(keyPath) {
  const pair = generateKeyPairSync('ed25519')
  mkdirSync(dirname(keyPath), { recursive: true })
  writeFileSync(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
}

/**
 * 签名消息 = UTF8(domain) 0x00 RFC8785-JCS(manifest) 0x00 RFC8785-JCS(integrity)。
 * @param {unknown} manifest
 * @param {unknown} integrity
 * @returns {Buffer}
 */
export function buildSignedMessage(manifest, integrity) {
  return Buffer.concat([
    Buffer.from(`${PACKAGE_SIGNING_DOMAIN}\0`, 'utf8'),
    Buffer.from(canonicalize(manifest), 'utf8'),
    Buffer.from([0]),
    Buffer.from(canonicalize(integrity), 'utf8'),
  ])
}

/**
 * signature.json 的结构(不含序列化, 序列化统一走 renderJSONBytes)。
 * @param {{
 *   privateKey: import('node:crypto').KeyObject,
 *   publicKey: Uint8Array,
 *   keyId: string,
 *   signedMessage: Uint8Array,
 * }} args
 */
export function buildSignature({ privateKey, publicKey, keyId, signedMessage }) {
  return {
    schema_version: 1,
    algorithm: 'Ed25519',
    canonicalization: 'RFC8785-JCS',
    domain: PACKAGE_SIGNING_DOMAIN,
    key_id: keyId,
    public_key: base64url(publicKey),
    signature: base64url(sign(null, signedMessage, privateKey)),
  }
}

/** 仅供各插件 loadPrivateKey 收尾用: 读入 PEM 私钥。 */
export function readPrivateKey(pem) {
  return createPrivateKey(pem)
}
