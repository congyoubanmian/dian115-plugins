// 包内文件清单与 integrity.json —— 三个插件 package.mjs 共用的纯逻辑:
//   * integrity.json 覆盖除自身与 signature.json 外的全部 ZIP 成员, 按 UTF-8 路径字节排序;
//   * manifest/integrity/signature 落盘统一为 2 空格缩进 + 结尾换行。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { sha256 } from './digest.mjs'

/**
 * @param {string} path
 * @returns {unknown}
 */
export function parseJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * 落盘 JSON 的统一序列化(与原实现逐字等价: JSON.stringify(v, null, 2) + '\n')。
 * @param {unknown} value
 * @returns {Buffer}
 */
export function renderJSONBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * 本地路径 → ZIP 成员路径(正斜杠), 拒绝越出 prefix 的路径。
 * @param {string} localPath
 * @param {string} prefix
 * @returns {string}
 */
export function packagePath(localPath, prefix) {
  const value = relative(prefix, localPath).split(sep).join('/')
  if (!value || value.startsWith('../') || value.includes('/../')) throw new Error(`Unsafe package path: ${localPath}`)
  return value
}

/**
 * 递归列出目录下的文件, 同层按文件名字典序展开。
 * @param {string} directory
 * @returns {string[]}
 */
export function walk(directory) {
  const result = []
  for (const name of readdirSync(directory).sort()) {
    const full = join(directory, name)
    const info = statSync(full)
    if (info.isDirectory()) result.push(...walk(full))
    else if (info.isFile()) result.push(full)
  }
  return result
}

/**
 * WASM 头的魔数 + 版本, 外加 reactor ABI 导出名 —— 防止把别的东西(或旧的非插件产物)打进包里。
 * @param {Buffer} buffer
 */
export function assertWasmModule(buffer) {
  if (buffer.length < 8 || buffer.subarray(0, 4).toString('hex') !== '0061736d') {
    throw new Error('target/wasm32-unknown-unknown/release/plugin.wasm 不是 WASM 模块')
  }
  if (buffer.readUInt32LE(4) !== 1) throw new Error('plugin.wasm 版本不是 1')
  if (!buffer.includes(Buffer.from('dian115_handle', 'utf8'))) {
    throw new Error('plugin.wasm 未导出 dian115_handle(dian115:wasm@1 ABI); 请先构建正确的运行时')
  }
}

/**
 * ZIP 成员按 UTF-8 路径字节排序(原地排序, 与原实现一致)。
 * @param {{path: string, data: Uint8Array, executable: boolean}[]} files
 * @returns {typeof files}
 */
export function sortFilesByPath(files) {
  return files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
}

/**
 * 打包主体文件(manifest.json / frontend/icon.svg / runtime/plugin.wasm + 前端资产),
 * 不含 integrity.json 与 signature.json(由 build-signed-package.mjs 追加)。
 * @param {{
 *   manifestBytes: Uint8Array,
 *   wasmBytes: Uint8Array,
 *   iconBytes: Uint8Array,
 *   uiAssetsRoot: string,
 * }} args
 */
export function buildBaseFiles({ manifestBytes, wasmBytes, iconBytes, uiAssetsRoot }) {
  const files = [
    { path: 'manifest.json', data: manifestBytes, executable: false },
    { path: 'frontend/icon.svg', data: iconBytes, executable: false },
    { path: 'runtime/plugin.wasm', data: wasmBytes, executable: true },
  ]
  for (const localPath of walk(uiAssetsRoot)) {
    const path = `frontend/dist/assets/${packagePath(localPath, uiAssetsRoot)}`
    files.push({ path, data: readFileSync(localPath), executable: false })
  }
  return files
}

/**
 * integrity.json: schema_version 1 + sha256, 按 files 顺序逐文件记录 size 与 sha256。
 * @param {{path: string, data: Uint8Array, executable: boolean}[]} files
 * @returns {{value: unknown, bytes: Buffer}}
 */
export function buildIntegrity(files) {
  const value = {
    schema_version: 1,
    algorithm: 'sha256',
    files: files.map((file) => ({
      path: file.path,
      size: file.data.length,
      sha256: sha256(file.data).toString('hex'),
    })),
  }
  return { value, bytes: renderJSONBytes(value) }
}
