#!/usr/bin/env node
// 打包并签名 DIAN115 插件包(.d115p) —— Rust 版豆瓣中心。
//
// 与 Go 版 plugins/douban-center/scripts/package.mjs 的签名逻辑逐条对齐:
//   * manifest.publisher.key_id 由签名公钥推导(ed25519:<base64url(sha256(rawpub))>);
//   * integrity.json 覆盖除自身与 signature.json 外的全部 ZIP 成员, 按 UTF-8 路径字节排序;
//   * 签名消息 = UTF8("DIAN115-PLUGIN-PACKAGE-V1") 0x00 RFC8785-JCS(manifest) 0x00 RFC8785-JCS(integrity)
//     (docs/plugin-platform/developer-guide.md §9 "Package, sign and publish");
//   * 私钥走环境变量 DIAN115_PLUGIN_SIGNING_KEY(未设置时回退到插件目录下的
//     developer-ed25519-private.pem, 与 Go 版一致; 该文件名在 .gitignore 内)。
//
// 与 Go 版的差异(有意为之):
//   * WASM 产物直接取 target/wasm32-unknown-unknown/release/plugin.wasm(不再有 build/runtime 中转);
//   * 前端资产直接复用 douban-center 的 build/frontend/dist/assets(Vue 前端与运行时解耦);
//   * ZIP 用 node:zlib 写, 不依赖 yazl —— 本插件目录没有 node_modules, CI 里也无需 npm install。
//
// 用法:
//   node package.mjs                # 打包(需要先构建好 wasm 与 douban-center 前端)
//   node package.mjs --generate-key # 本地开发: 首次生成开发者私钥再打包
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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

function sha256(value) {
  return createHash('sha256').update(value).digest()
}

function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

// RFC 8785 (JCS): 键按 UTF-8 码元排序, 数字用 ECMAScript Number::toString, 不允许 NaN/Infinity。
function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS does not allow non-finite numbers')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
  }
  throw new Error(`JCS does not support ${typeof value}`)
}

function parseJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function loadPrivateKey() {
  if (!existsSync(keyPath)) {
    if (!generateKey) {
      throw new Error(`Signing key not found: ${keyPath}\nRun node package.mjs --generate-key once for local development, or set DIAN115_PLUGIN_SIGNING_KEY.`)
    }
    const pair = generateKeyPairSync('ed25519')
    mkdirSync(dirname(keyPath), { recursive: true })
    writeFileSync(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    process.stdout.write(`Generated development signing key: ${keyPath}\n`)
  }
  return createPrivateKey(readFileSync(keyPath))
}

function rawPublicKey(privateKey) {
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  if (spki.length < 32) throw new Error('Invalid Ed25519 SPKI public key')
  return spki.subarray(spki.length - 32)
}

function packagePath(localPath, prefix) {
  const value = relative(prefix, localPath).split(sep).join('/')
  if (!value || value.startsWith('../') || value.includes('/../')) throw new Error(`Unsafe package path: ${localPath}`)
  return value
}

function walk(directory) {
  const result = []
  for (const name of readdirSync(directory).sort()) {
    const full = join(directory, name)
    const info = statSync(full)
    if (info.isDirectory()) result.push(...walk(full))
    else if (info.isFile()) result.push(full)
  }
  return result
}

// WASM 头的魔数 + 版本, 外加 reactor ABI 导出名 —— 防止把别的东西(或旧的非插件产物)打进包里。
function assertWasmModule(buffer) {
  if (buffer.length < 8 || buffer.subarray(0, 4).toString('hex') !== '0061736d') {
    throw new Error('target/wasm32-unknown-unknown/release/plugin.wasm 不是 WASM 模块')
  }
  if (buffer.readUInt32LE(4) !== 1) throw new Error('plugin.wasm 版本不是 1')
  if (!buffer.includes(Buffer.from('dian115_handle', 'utf8'))) {
    throw new Error('plugin.wasm 未导出 dian115_handle(dian115:wasm@1 ABI); 请先构建正确的运行时')
  }
}

// ---------------------------------------------------------------------------
// 最小 ZIP 写入器(store/deflate 二选一, 这里用 deflate) —— 与 yazl 产物同构:
// 固定 DOS 时间戳, 因此同样的输入产出同样的字节。
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
  writeFileSync(outputPath, Buffer.concat([...localParts, centralDirectory, end]), { mode: 0o644 })
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
const publicKey = rawPublicKey(privateKey)
const keyID = `ed25519:${base64url(sha256(publicKey))}`
const manifest = parseJSON(manifestTemplatePath)
manifest.publisher.key_id = keyID
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const runtimeBytes = readFileSync(wasmPath)
assertWasmModule(runtimeBytes)
const files = [
  { path: 'manifest.json', data: manifestBytes, executable: false },
  { path: 'frontend/icon.svg', data: readFileSync(iconPath), executable: false },
  { path: 'runtime/plugin.wasm', data: runtimeBytes, executable: true },
]

for (const localPath of walk(uiAssetsRoot)) {
  const path = `frontend/dist/assets/${packagePath(localPath, uiAssetsRoot)}`
  files.push({ path, data: readFileSync(localPath), executable: false })
}

files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
const integrity = {
  schema_version: 1,
  algorithm: 'sha256',
  files: files.map((file) => ({
    path: file.path,
    size: file.data.length,
    sha256: sha256(file.data).toString('hex'),
  })),
}
const integrityBytes = Buffer.from(`${JSON.stringify(integrity, null, 2)}\n`, 'utf8')
const signedMessage = Buffer.concat([
  Buffer.from('DIAN115-PLUGIN-PACKAGE-V1\0', 'utf8'),
  Buffer.from(canonicalize(manifest), 'utf8'),
  Buffer.from([0]),
  Buffer.from(canonicalize(integrity), 'utf8'),
])
const signature = {
  schema_version: 1,
  algorithm: 'Ed25519',
  canonicalization: 'RFC8785-JCS',
  domain: 'DIAN115-PLUGIN-PACKAGE-V1',
  key_id: keyID,
  public_key: base64url(publicKey),
  signature: base64url(sign(null, signedMessage, privateKey)),
}
const signatureBytes = Buffer.from(`${JSON.stringify(signature, null, 2)}\n`, 'utf8')

files.push({ path: 'integrity.json', data: integrityBytes, executable: false })
files.push({ path: 'signature.json', data: signatureBytes, executable: false })
files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))

mkdirSync(releasesRoot, { recursive: true })
const packageName = `${manifest.id}-${manifest.version}.d115p`
const outputPath = join(releasesRoot, packageName)
zipPackage(outputPath, files)
const packageDigest = sha256(readFileSync(outputPath)).toString('hex')

const marketEntry = parseJSON(marketTemplatePath)
marketEntry.id = manifest.id
marketEntry.name = manifest.name
marketEntry.version = manifest.version
marketEntry.description = manifest.description
marketEntry.author = manifest.publisher.name
marketEntry.homepage = manifest.homepage
marketEntry.sha256 = packageDigest
// 市场披露必须与签名 Manifest 完全一致: 运行时类型/信任级别按 manifest 推导,
// 不能写死(wasm 插件写成 process 会与清单不符, 市场校验会拒绝)。
const runtimeKind = manifest.runtime.kind === 'wasm' ? 'wasm' : 'process'
marketEntry.runtime = {
  kind: runtimeKind,
  protocol: manifest.runtime.protocol,
  autostart: true,
  trust_level: runtimeKind === 'wasm' ? 'wasm-sandbox' : 'isolated-process',
}
marketEntry.permissions = manifest.permissions
marketEntry.tags = manifest.tags || []
writeFileSync(join(releasesRoot, 'market-entry.generated.json'), `${JSON.stringify(marketEntry, null, 2)}\n`)

// 同步身份字段回市场模板: 官方 conformance/project-check.mjs 默认读取
// market-entry.template.json 并与 manifest 比对(id/version/runtime/permissions
// 必须完全一致), 模板陈旧会让发布前检查直接失败。
const marketTemplate = parseJSON(marketTemplatePath)
for (const key of ['id', 'name', 'version', 'description', 'author', 'homepage', 'sha256', 'runtime', 'permissions', 'tags']) {
  marketTemplate[key] = marketEntry[key]
}
writeFileSync(marketTemplatePath, `${JSON.stringify(marketTemplate, null, 2)}\n`)

process.stdout.write(`Package: ${outputPath}\n`)
process.stdout.write(`SHA-256: ${packageDigest}\n`)
process.stdout.write(`Publisher key ID: ${keyID}\n`)
process.stdout.write(`Market entry: ${join(releasesRoot, 'market-entry.generated.json')}\n`)
