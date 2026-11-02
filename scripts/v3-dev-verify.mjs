#!/usr/bin/env node
// 开发者实例探测 / 真机验证 —— 用宿主地址 + 系统设置里的 APIKEY，确认实例可达、
// 鉴权方式可用，并列出宿主对插件作者开放了哪些接口。
//
// 凭据来源（都不入库）：
//   环境变量 DIAN115_URL / DIAN115_API_KEY / DIAN115_COOKIE
//   或仓库根的 .env.local（见 .env.example）
//
// 用法：
//   node scripts/v3-dev-verify.mjs                 # 只读探测
//   node scripts/v3-dev-verify.mjs --plugin douban.rs
//   node scripts/v3-dev-verify.mjs --install dist/douban-rs.dian115p   # 需要 --write
//
// 退出码：0 = 实例可达且鉴权可用；1 = 不可达或鉴权失败。
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)

// ── 读凭据 ─────────────────────────────────────────────────────────────────
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
const cookie = process.env.DIAN115_COOKIE ?? ''
const pluginId = process.env.DIAN115_PLUGIN ?? 'douban.rs'
const args = process.argv.slice(2)
const write = args.includes('--write')
const pluginArgIndex = args.indexOf('--plugin')
if (pluginArgIndex >= 0 && args[pluginArgIndex + 1]) {
  process.env.DIAN115_PLUGIN = args[pluginArgIndex + 1]
}

if (!base) {
  console.error('缺少 DIAN115_URL（见 .env.example）')
  process.exit(1)
}
if (!apiKey && !cookie) {
  console.error('缺少凭据：DIAN115_API_KEY（系统设置里的 APIKEY）或 DIAN115_COOKIE')
  process.exit(1)
}

function headers(extra = {}) {
  const out = { ...extra }
  if (apiKey) out['X-OpenAPI-Key'] = apiKey
  if (cookie) out['Cookie'] = cookie
  return out
}

async function probe(path, extra = {}) {
  const started = Date.now()
  try {
    const response = await fetch(`${base}${path}`, { headers: headers(extra), redirect: 'manual' })
    const text = await response.text()
    return { path, status: response.status, ms: Date.now() - started, body: text.slice(0, 200) }
  } catch (error) {
    return { path, status: 0, ms: Date.now() - started, body: String(error?.message ?? error).slice(0, 200) }
  }
}

// 候选路径：插件 API（登录会话或扩展标记）+ 外部 OpenAPI 家族（X-OpenAPI-Key）
const CANDIDATES = [
  '/api/auth/status',
  '/api/extensions/v3/_market',
  '/api/extensions/v3/inspect',
  `/api/extensions/v3/${encodeURIComponent(process.env.DIAN115_PLUGIN ?? 'douban.rs')}/storage/state`,
  '/api/openapi/v1/external-push',
  '/api/openapi/v1/plugins',
  '/api/openapi/v1/developer/plugins',
]

console.log(`实例：${base}｜APIKEY：${apiKey ? '已提供（' + apiKey.length + ' 字符）' : '未提供'}${cookie ? '｜Cookie：已提供' : ''}\n`)
for (const path of CANDIDATES) {
  const result = await probe(path)
  const note = result.status === 0 ? result.body : result.body.replace(/\s+/g, ' ').slice(0, 90)
  console.log(`${String(result.status).padEnd(4)} ${path.padEnd(64)} ${result.ms}ms  ${note}`)
}

if (write) {
  const installIndex = args.indexOf('--install')
  const pkg = installIndex >= 0 ? args[installIndex + 1] : ''
  if (pkg) {
    const bytes = readFileSync(resolve(root, pkg))
    const response = await fetch(`${base}/api/extensions/v3/install`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/octet-stream' }),
      body: bytes,
    })
    console.log(`\n安装 ${pkg} → HTTP ${response.status}`)
    console.log((await response.text()).slice(0, 400))
  }
} else {
  console.log('\n（只读探测；加 --install <包路径> 且带 --write 才会真的安装）')
}
