// releases/market-entry.generated.json 的公共构造 —— 市场披露必须与签名 Manifest 完全一致:
//   * id/name/version/description/author/homepage/sha256 按 manifest 与包摘要覆盖;
//   * 运行时类型/信任级别按 manifest 推导, 不能写死(wasm 插件写成 process 会与清单不符,
//     市场校验会拒绝);
//   * 市场披露按 market-index.schema.json 收敛为 runtime 4 键; manifest 侧的 memory_mb
//     是宿主内存限制, 不受影响。
import { parseJSON } from './package-files.mjs'

/**
 * @param {string} marketTemplatePath market-entry.template.json 的路径(人工维护, 只读不回写)
 * @param {Record<string, unknown>} manifest 已注入 key_id 的签名 Manifest
 * @param {string} packageDigest 打包产物的 sha256 hex
 * @returns {Record<string, unknown>}
 */
export function buildMarketEntry(marketTemplatePath, manifest, packageDigest) {
  const marketEntry = /** @type {Record<string, unknown>} */ (parseJSON(marketTemplatePath))
  marketEntry.id = manifest.id
  marketEntry.name = manifest.name
  marketEntry.version = manifest.version
  marketEntry.description = manifest.description
  marketEntry.author = manifest.publisher.name
  marketEntry.homepage = manifest.homepage
  marketEntry.sha256 = packageDigest
  const runtimeKind = manifest.runtime.kind === 'wasm' ? 'wasm' : 'process'
  marketEntry.runtime = {
    kind: runtimeKind,
    protocol: manifest.runtime.protocol,
    autostart: true,
    trust_level: runtimeKind === 'wasm' ? 'wasm-sandbox' : 'isolated-process',
  }
  marketEntry.permissions = manifest.permissions
  marketEntry.tags = manifest.tags || []
  return marketEntry
}
