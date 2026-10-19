// 三插件打包主线的公共部分 —— 从私钥推导 keyId, 到产出含 integrity.json/signature.json
// 的最终 ZIP 成员清单。逐字等价于原三个 package.mjs 里的同一段主线:
//   1. manifest.publisher.key_id = ed25519:<base64url(sha256(rawpub))>;
//   2. 主体文件 = manifest.json + frontend/icon.svg + runtime/plugin.wasm + frontend/dist/assets/**
//      (资产按 UTF-8 路径字节排序);
//   3. integrity.json 覆盖上述全部成员(schema_version 1, sha256);
//   4. 签名消息 = UTF8("DIAN115-PLUGIN-PACKAGE-V1") 0x00 JCS(manifest) 0x00 JCS(integrity);
//   5. 追加 integrity.json / signature.json 后再整体按路径排序。
//
// 插件差异(路径/图标/资产根/ZIP 写法/私钥加载策略)留在各插件 package.mjs 里。
import { buildBaseFiles, buildIntegrity, assertWasmModule, renderJSONBytes, sortFilesByPath } from './package-files.mjs'
import { buildSignature, buildSignedMessage, deriveKeyId, rawPublicKey } from './signing.mjs'

/**
 * @param {{
 *   privateKey: import('node:crypto').KeyObject,
 *   manifest: Record<string, unknown>,
 *   wasmBytes: Uint8Array,
 *   iconBytes: Uint8Array,
 *   uiAssetsRoot: string,
 * }} args
 * @returns {{
 *   manifest: Record<string, unknown>,
 *   publicKey: Buffer,
 *   keyId: string,
 *   files: {path: string, data: Uint8Array, executable: boolean}[],
 *   integrity: unknown,
 *   signature: Record<string, unknown>,
 * }}
 */
export function buildSignedPackage({ privateKey, manifest, wasmBytes, iconBytes, uiAssetsRoot }) {
  const publicKey = rawPublicKey(privateKey)
  const keyId = deriveKeyId(publicKey)
  manifest.publisher.key_id = keyId
  const manifestBytes = renderJSONBytes(manifest)

  assertWasmModule(wasmBytes)
  const files = sortFilesByPath(buildBaseFiles({ manifestBytes, wasmBytes, iconBytes, uiAssetsRoot }))
  const { value: integrity, bytes: integrityBytes } = buildIntegrity(files)
  const signedMessage = buildSignedMessage(manifest, integrity)
  const signature = buildSignature({ privateKey, publicKey, keyId, signedMessage })

  files.push({ path: 'integrity.json', data: integrityBytes, executable: false })
  files.push({ path: 'signature.json', data: renderJSONBytes(signature), executable: false })
  sortFilesByPath(files)
  return { manifest, publicKey, keyId, files, integrity, signature }
}
