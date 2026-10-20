#!/usr/bin/env node
// 打包并签名 DIAN115 插件包(.d115p) —— Rust 版豆瓣中心。
//
// 签名/完整性/市场披露的公共实现已抽到 tools/plugin-tools/(与 Go 版
// plugins/douban-center/scripts/package.mjs 的签名逻辑逐条对齐, 签名逻辑不插件化):
//   * manifest.publisher.key_id 由签名公钥推导(ed25519:<base64url(sha256(rawpub))>);
//   * integrity.json 覆盖除自身与 signature.json 外的全部 ZIP 成员, 按 UTF-8 路径字节排序;
//   * 签名消息 = UTF8("DIAN115-PLUGIN-PACKAGE-V1") 0x00 RFC8785-JCS(manifest) 0x00 RFC8785-JCS(integrity)
//     (docs/plugin-platform/developer-guide.md §9 "Package, sign and publish");
//   * 私钥走环境变量 DIAN115_PLUGIN_SIGNING_KEY(未设置时回退到插件目录下的
//     developer-ed25519-private.pem, 与 Go 版一致; 该文件名在 .gitignore 内)。
//
// 与其它插件的差异(有意为之, 留在本文件里以参数传入公共主线):
//   * WASM 产物直接取 target/wasm32-unknown-unknown/release/plugin.wasm(不再有 build/runtime 中转);
//   * 前端资产直接复用 douban-center 的 build/frontend/dist/assets(Vue 前端与运行时解耦);
//   * ZIP 用 node:zlib 写, 不依赖 yazl —— 本插件目录没有 node_modules, CI 里也无需 npm install;
//     ZIP 实现有意不与其它插件合并(固定 DOS 时间戳, 避免产物字节漂移)。
//
// 用法:
//   node package.mjs                # 打包(需要先构建好 wasm 与 douban-center 前端)
//   node package.mjs --generate-key # 本地开发: 首次生成开发者私钥再打包
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../../tools/plugin-tools/digest.mjs'
import { buildSignedPackage } from '../../tools/plugin-tools/build-signed-package.mjs'
import { buildMarketEntry } from '../../tools/plugin-tools/market-entry.mjs'
import { assertZipSize, parseJSON } from '../../tools/plugin-tools/package-files.mjs'
import { readPrivateKey, writeDevelopmentPrivateKey } from '../../tools/plugin-tools/signing.mjs'

// 本插件目录 = plugins/douban-rs
const root = dirname(fileURLToPath(import.meta.url))
const centerRoot = resolve(join(root, '..', 'douban-center'))
const manifestTemplatePath = join(root, 'manifest.template.json')
const marketTemplatePath = join(root, 'market-entry.template.json')
const wasmPath = join(root, 'target', 'wasm32-unknown-unknown', 'release', 'plugin.wasm')
const uiAssetsRoot = join(centerRoot, 'build', 'frontend', 'dist', 'assets')
// 图标: 本插件目录若自带 icon.svg 优先, 否则沿用 douban-center 的(测试身份阶段复用同一图标)。
const localIconPath = join(root, 'icon.svg')
const iconPath = existsSync(localIconPath) ? localIconPath : join(centerRoot, 'frontend', 'icon.svg')
const releasesRoot = join(root, 'releases')
const keyPath = resolve(process.env.DIAN115_PLUGIN_SIGNING_KEY || join(root, 'developer-ed25519-private.pem'))
const generateKey = process.argv.includes('--generate-key')

function loadPrivateKey() {
  if (!existsSync(keyPath)) {
    if (!generateKey) {
      throw new Error(`Signing key not found: ${keyPath}\nRun node package.mjs --generate-key once for local development, or set DIAN115_PLUGIN_SIGNING_KEY.`)
    }
    writeDevelopmentPrivateKey(keyPath)
    process.stdout.write(`Generated development signing key: ${keyPath}\n`)
  }
  return readPrivateKey(readFileSync(keyPath))
}

// ---------------------------------------------------------------------------
// 最小 ZIP 写入器(store/deflate 二选一, 这里用 deflate) —— 与 yazl 产物同构:
// 固定 DOS 时间戳, 因此同样的输入产出同样的字节。
// (有意不抽到 tools/plugin-tools: 各插件保留自己的 ZIP 实现, 避免产物字节漂移。)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}

const DOS_DATE_1980_01_01 = 0x0021 // yazl/RFC1952 允许的最早时间, 保证可复现
const DOS_TIME_MIDNIGHT = 0x0000

function zipPackage(outputPath, files) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8')
    const raw = Buffer.from(file.data)
    const deflated = deflateRawSync(raw)
    const body = deflated.length < raw.length ? deflated : raw
    const method = body === deflated ? 8 : 0
    const crc = crc32(raw)
    const mode = (file.executable ? 0o100755 : 0o100644) >>> 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME_MIDNIGHT, 10)
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    localParts.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4) // made by: UNIX, zip 3.0
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(DOS_TIME_MIDNIGHT, 12)
    central.writeUInt16LE(DOS_DATE_1980_01_01, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra length
    central.writeUInt16LE(0, 32) // comment length
    central.writeUInt16LE(0, 34) // disk number start
    central.writeUInt16LE(0, 36) // internal attributes
    central.writeUInt32LE((mode << 16) >>> 0, 38) // external attributes: unix mode
    central.writeUInt32LE(offset, 42) // local header offset
    centralParts.push(central, name)

    offset += local.length + name.length + body.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4) // disk number
  end.writeUInt16LE(0, 6) // central directory disk
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20) // comment length
  // 写盘前校验 ZIP 最终大小上限(package-format-v1.md), 合法时字节与原先完全一致。
  const bundle = Buffer.concat([...localParts, centralDirectory, end])
  assertZipSize(bundle)
  writeFileSync(outputPath, bundle, { mode: 0o644 })
}

// ---------------------------------------------------------------------------

if (!existsSync(wasmPath)) {
  throw new Error(`Missing ${wasmPath}; 先构建 WASM 运行时(node build.mjs, 或按 README 用 rust:1-slim 容器构建)`)
}
if (!existsSync(uiAssetsRoot)) {
  throw new Error(`Missing ${uiAssetsRoot}; Rust 版复用 douban-center 的前端产物, 先在 plugins/douban-center 执行 npm run build:ui`)
}
if (!existsSync(join(uiAssetsRoot, 'remoteEntry.js'))) {
  throw new Error(`Missing ${join(uiAssetsRoot, 'remoteEntry.js')}; douban-center 前端产物不完整, 重新构建`)
}
if (!existsSync(iconPath)) throw new Error(`Missing icon: ${iconPath}`)

const privateKey = loadPrivateKey()
const manifest = parseJSON(manifestTemplatePath)
const { keyId, files } = buildSignedPackage({
  privateKey,
  manifest,
  wasmBytes: readFileSync(wasmPath),
  iconBytes: readFileSync(iconPath),
  uiAssetsRoot,
})

mkdirSync(releasesRoot, { recursive: true })
const packageName = `${manifest.id}-${manifest.version}.d115p`
const outputPath = join(releasesRoot, packageName)
zipPackage(outputPath, files)
const packageDigest = sha256(readFileSync(outputPath)).toString('hex')

const marketEntry = buildMarketEntry(marketTemplatePath, manifest, packageDigest)
writeFileSync(join(releasesRoot, 'market-entry.generated.json'), `${JSON.stringify(marketEntry, null, 2)}\n`)

// 注意: market-entry.template.json 是 conformance 的输入(官方 project-check.mjs
// 会读取它并与 manifest 比对), 必须由人工维护; buildMarketEntry 只读取它生成
// releases/market-entry.generated.json, 绝不回写模板 —— 否则打包会把人工维护的
// 字段覆盖掉, 并可能把仅市场索引需要的字段(如 runtime.memory_mb)带进模板,
// 污染 CI 的 conformance。

process.stdout.write(`Package: ${outputPath}\n`)
process.stdout.write(`SHA-256: ${packageDigest}\n`)
process.stdout.write(`Publisher key ID: ${keyId}\n`)
process.stdout.write(`Market entry: ${join(releasesRoot, 'market-entry.generated.json')}\n`)
