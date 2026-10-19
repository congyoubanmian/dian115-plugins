// 哈希与编码小工具 —— 三个插件 package.mjs 共用的纯函数。
import { createHash } from 'node:crypto'

/**
 * @param {Uint8Array | string} value
 * @returns {Buffer}
 */
export function sha256(value) {
  return createHash('sha256').update(value).digest()
}

/**
 * @param {Uint8Array | string} value
 * @returns {string}
 */
export function base64url(value) {
  return Buffer.from(value).toString('base64url')
}
