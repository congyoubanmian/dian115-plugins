#!/usr/bin/env node
// 编译 MCP 客户端 —— 通过宿主「编译 MCP」出正式包（protected-v4）。
//
// 契约（docs/plugin-platform/examples/dian-plugin/references/compilation.md 与
// public-kit/encrypted-delivery.md「编译 MCP 与正式发布」）：
//   - 端点：POST {DIAN115_URL}/api/openapi/v1/plugin-build/mcp
//   - 鉴权：请求头 X-OpenAPI-Key（或 Authorization: Bearer）= 系统设置里的 OpenAPI Key
//   - 协议：JSON-RPC 2.0，Streamable HTTP（application/json 或 text/event-stream）；
//     initialize → notifications/initialized → ping / tools/list / tools/call；
//     协议版本 2025-06-18（也接受 2025-03-26）；请求带 MCP-Protocol-Version 头；
//     不带 Origin（入口拒绝浏览器来源）；无 GET SSE 流、无 DELETE 会话、无批量。
//   - 工具：dian115_build_environment / dian115_verify_build_account /
//           dian115_check_plugin / dian115_compile_plugin
//   - 参数：files（工程内相对路径 → UTF-8 文本）或 files_base64（标准 Base64），二者只能选一项；
//           另有可选 account_id（癫影账号，多账号时必须显式选择）
//   - 成功判据：isError 非 true、structuredContent.release_ready === true、
//     有 package_base64、且解码后 SHA256 与返回值一致
//
// 凭据只从环境变量或 .env.local 读，不进仓库、不进日志。
//
// 用法：
//   node scripts/v3-compile.mjs env                        # 查编译环境（ABI/预算/账号/阻塞项）
//   node scripts/v3-compile.mjs account [--account <id>]    # 实时会员身份与昵称
//   node scripts/v3-compile.mjs check  <插件目录>            # 结构/敏感调用检查（不出包、不安装）
//   node scripts/v3-compile.mjs compile <插件目录> [--account <id>] [--out dist]
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, relative, sep, join } from 'node:path'
import { createHash } from 'node:crypto'

const root = resolve(new URL('..', import.meta.url).pathname)

// ── 凭据 ───────────────────────────────────────────────────────────────────
function loadEnvFile() {
  const file = resolve(root, '.env.local')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    const eq = text.indexOf('=')
    if (eq <= 0) continue
    const key = text.slice(0, eq).trim()
    const value = text.slice(eq + 1).trim()
    if (process.env[key] === undefined) process.env[key] = value
  }
}
loadEnvFile()

const base = (process.env.DIAN115_URL ?? '').replace(/\/+$/, '')
const apiKey = process.env.DIAN115_API_KEY ?? ''
const MCP_PATH = '/api/openapi/v1/plugin-build/mcp'
const PROTOCOL = '2025-06-18'

if (!base || !apiKey) {
  console.error('缺少 DIAN115_URL 或 DIAN115_API_KEY（见 .env.example；key 取宿主「系统设置」里的 OpenAPI Key）')
  process.exit(1)
}

// ── MCP 最小客户端 ─────────────────────────────────────────────────────────
let nextId = 1

function parseBody(text, contentType) {
  if (!text) return null
  if (contentType.includes('text/event-stream')) {
    // Streamable HTTP：SSE 帧里的 data: 行是 JSON 负载
    const payloads = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line !== '')
    if (payloads.length === 0) return null
    return JSON.parse(payloads[payloads.length - 1])
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function rpc(method, params, { notify = false } = {}) {
  const id = nextId++
  const payload = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }
  const response = await fetch(`${base}${MCP_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'X-OpenAPI-Key': apiKey,
      'MCP-Protocol-Version': PROTOCOL,
    },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok) {
    let message = text.slice(0, 300)
    try {
      const parsed = JSON.parse(text)
      message = parsed?.message ?? parsed?.error ?? message
    } catch { /* 原样 */ }
    throw new Error(`MCP HTTP ${response.status} ${method} —— ${message}`)
  }
  const data = parseBody(text, contentType)
  if (data?.error) {
    throw new Error(`MCP 错误 ${method}：${data.error.message ?? JSON.stringify(data.error).slice(0, 300)}`)
  }
  return data?.result ?? data
}

async function handshake() {
  const result = await rpc('initialize', {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'dian115-plugin-toolchain', version: '1.0.0' },
  })
  await rpc('notifications/initialized', {}, { notify: true })
  return result
}

async function callTool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args })
  const isError = result?.isError === true
  const structured = result?.structuredContent ?? {}
  const text = (result?.content ?? []).map((item) => item?.text ?? '').join('\n')
  return { isError, structured, text }
}

// ── 收集插件目录文件 ───────────────────────────────────────────────────────
const SKIP_DIRS = new Set(['.git', 'node_modules', '.vite', 'dist', '.cache'])

function collectFiles(directory) {
  const files = {}
  let binary = false
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      const bytes = readFileSync(absolute)
      const name = relative(directory, absolute).split(sep).join('/')
      if (bytes.includes(0)) binary = true
      files[name] = bytes
    }
  }
  walk(resolve(directory))
  return { files, binary }
}

function pluginIdOf(directory) {
  try {
    return JSON.parse(readFileSync(resolve(directory, 'plugin.json'), 'utf8')).id
  } catch {
    return 'unknown'
  }
}

function toTextArgs(collected) {
  if (collected.binary) {
    const payload = {}
    for (const [name, bytes] of Object.entries(collected.files)) payload[name] = bytes.toString('base64')
    return { files_base64: payload }
  }
  const payload = {}
  for (const [name, bytes] of Object.entries(collected.files)) payload[name] = bytes.toString('utf8')
  return { files: payload }
}

// ── 命令 ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const command = args[0] ?? 'env'
const accountIndex = args.indexOf('--account')
const accountId = accountIndex >= 0 ? args[accountIndex + 1] : (process.env.DIAN115_ACCOUNT_ID ?? '')
const outIndex = args.indexOf('--out')
const outDir = outIndex >= 0 ? args[outIndex + 1] : 'dist'

const handshakeResult = await handshake()
const serverInfo = handshakeResult?.serverInfo?.name ? `（服务端 ${handshakeResult.serverInfo.name}）` : ''
console.log(`MCP 已连接 ${base}${MCP_PATH}${serverInfo}`)

if (command === 'tools') {
  const result = await rpc('tools/list', {})
  for (const tool of result?.tools ?? []) {
    console.log(`\n── ${tool.name}`)
    if (tool.description) console.log(tool.description.split('\n')[0].slice(0, 160))
    console.log('   入参 schema：' + JSON.stringify(tool.inputSchema ?? {}).slice(0, 1200))
  }
} else if (command === 'env') {
  const result = await callTool('dian115_build_environment', {})
  console.log(JSON.stringify(result.structured ?? result.text, null, 2))
  if (result.isError) {
    console.error('环境查询失败：如实报告上面的阻塞项，不要伪造可用状态。')
    process.exit(1)
  }
} else if (command === 'account') {
  const result = await callTool('dian115_verify_build_account', accountId ? { account_id: accountId } : {})
  console.log(JSON.stringify(result.structured ?? result.text, null, 2))
  if (result.isError) process.exit(1)
} else if (command === 'check' || command === 'compile') {
  const directory = args[1]
  if (!directory) {
    console.error('用法：node scripts/v3-compile.mjs check|compile <插件目录> [--account <id>] [--out dist]')
    process.exit(1)
  }
  const collected = collectFiles(directory)
  const fileCount = Object.keys(collected.files).length
  const sourceBytes = Object.values(collected.files).reduce((sum, bytes) => sum + bytes.length, 0)
  console.log(`待提交文件 ${fileCount} 个，源码 ${(sourceBytes / 1024).toFixed(1)} KiB${collected.binary ? '（含二进制，改用 files_base64）' : ''}`)
  if (fileCount > 4096 || sourceBytes > 16 * 1024 * 1024) {
    console.error('超出 MCP 预算：最多 4096 个文件、源码合计 16 MiB。')
    process.exit(1)
  }
  // check 的入参只认 files/files_base64（additionalProperties:false）；account_id 只给 compile。
  const payload = command === 'compile' && accountId
    ? { ...toTextArgs(collected), account_id: accountId }
    : toTextArgs(collected)
  const result = await callTool(command === 'compile' ? 'dian115_compile_plugin' : 'dian115_check_plugin', payload)
  if (command === 'check') {
    console.log(JSON.stringify(result.structured ?? result.text, null, 2))
    if (result.isError) process.exit(1)
  } else {
    const structured = result.structured ?? {}
    const base64 = structured.package_base64
    if (result.isError || structured.release_ready !== true || typeof base64 !== 'string' || base64 === '') {
      console.error('编译未产出正式包。如实报告下面的阻塞项：')
      console.error(JSON.stringify(structured ?? result.text, null, 2))
      process.exit(1)
    }
    // 署名昵称：编译响应里不一定带，取会员校验结果补上（市场索引的 author 要用同一个昵称）
    let nickname = structured.nickname ?? ''
    if (!nickname) {
      const verify = await callTool('dian115_verify_build_account', accountId ? { account_id: accountId } : {})
      nickname = verify?.structured?.identity?.nickname ?? ''
    }
    const bytes = Buffer.from(base64, 'base64')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const expected = structured.sha256 ?? structured.sha256_hex
    if (expected && expected !== sha256) {
      console.error(`SHA256 不一致：返回值 ${expected}，实算 ${sha256} —— 产物不可信，丢弃。`)
      process.exit(1)
    }
    const filename = structured.filename ?? structured.file_name ?? structured.name ?? 'plugin.dian115p'
    mkdirSync(resolve(root, outDir), { recursive: true })
    const target = resolve(root, outDir, filename)
    writeFileSync(target, bytes)
    // 记进 dist/official-packages.json：市场索引要用正式包的文件名与 sha256（作者取会员昵称）
    const ledgerPath = resolve(root, outDir, 'official-packages.json')
    let ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : {}
    ledger[pluginIdOf(directory)] = {
      id: pluginIdOf(directory),
      filename,
      sha256,
      bytes: bytes.length,
      release_id: structured.release_id ?? structured.releaseId ?? '',
      nickname,
      member_id: structured.member_id ?? '',
      version: structured.version ?? '',
    }
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n')
    console.log(`正式包已保存：${target}`)
    console.log(`  字节 ${bytes.length}｜sha256 ${sha256}`)
    console.log(`  开发者署名取签名里的会员昵称（宿主会覆盖源码自填 author）；市场 author 也要用同一昵称。`)
  }
} else {
  console.error('用法：node scripts/v3-compile.mjs tools | env | account | check <目录> | compile <目录>')
  process.exit(64)
}
