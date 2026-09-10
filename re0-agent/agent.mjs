// re0-agent: RE0 (re0.me) 会话代理
// 职责:
//   1. 管理 RE0 登录态 (token/refresh_token + 每次响应轮换的 hdh_sa_token)
//   2. 暴露简单 HTTP API: 搜索 / 媒体资源列表 / 健康检查
//   3. access_token 过期时用 refresh_token 无感续期
//
// 关键机制(逆向确认):
//   - Server Action 需要头 next-action: <action_id>，且 cookie 必须携带**最新的**
//     hdh_sa_token（每次页面/action 响应都会轮换，2h 有效），否则 428 action_token_required
//   - 响应是 React Flight (text/x-component)，需按行解析出 JSON 结果

import http from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(__dirname, '..', 'config')
const STATE_PATH = path.join(CONFIG_DIR, 'session.json')
const PORT = Number(process.env.PORT || 8790)
const PROXY = process.env.HTTP_PROXY || '' // 出站代理，如 http://192.168.0.233:1088
const BASE = 'https://re0.me'
const UA = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

// Server Action 注册表（从页面 chunk 提取）
const ACTIONS = {
  searchTmdb: '40adaeedd497fcbefd09afe949ad909b227b507bb1',
  showResource: '402e0ce0f3ef74e302ebe1cb48d28c529477257b11',
  checkIn: '400f21524eb8622e88791bd7a1f1ecee96aeda52c2',
}

// ── 会话状态 ─────────────────────────────────────────────────
let session = { cookies: {}, sa_token: '', updated_at: '' }
function loadSession() {
  try {
    session = { ...session, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) }
    log('已加载会话: user_id=' + (session.user_id || '?') + ' keys=' + Object.keys(session.cookies || {}).join(','))
  } catch { log('无已保存会话，等待配置') }
}
function saveSession() {
  session.updated_at = new Date().toISOString()
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(STATE_PATH, JSON.stringify(session, null, 2))
}
function log(...a) { console.log(new Date().toISOString(), ...a) }

function cookieHeader() {
  const parts = []
  for (const [k, v] of Object.entries(session.cookies || {})) parts.push(`${k}=${v}`)
  if (session.sa_token) parts.push(`hdh_sa_token=${session.sa_token}`)
  return parts.join('; ')
}
function hasLogin() {
  const c = session.cookies || {}
  return !!(c.token && c.refresh_token)
}
function accessTokenExp() {
  try {
    const t = (session.cookies?.token || '').split('.')[1]
    if (!t) return 0
    return JSON.parse(Buffer.from(t, 'base64').toString()).exp * 1000
  } catch { return 0 }
}

// ── 出站 fetch（可走代理）────────────────────────────────────
let outboundFetch = null
async function initOutbound() {
  if (outboundFetch) return outboundFetch
  if (PROXY) {
    const { ProxyAgent, setGlobalDispatcher } = await import('undici')
    setGlobalDispatcher(new ProxyAgent(PROXY))
  }
  outboundFetch = fetch
  return outboundFetch
}

let saRefresh = null // 单飞: 并发请求时只刷一次
async function updateSaToken(actionUrl) {
  if (saRefresh) return saRefresh
  saRefresh = (async (u) => {
    // 关键两点（实测确认）:
    //   1. **不带**旧的 hdh_sa_token 请求，服务端才会 Set-Cookie 下发新 token；
    //   2. sa_token 绑定签发时的完整 URL —— 必须用与 action 完全相同的 URL 获取。
    const base = Object.entries(session.cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ')
    const r = await (await initOutbound())(actionUrl, {
      headers: { 'user-agent': UA, cookie: base },
      redirect: 'manual',
    })
    const set = r.headers.getSetCookie ? r.headers.getSetCookie() : []
    for (const line of set) {
      const m = line.match(/hdh_sa_token=([^;]+)/)
      if (m) { session.sa_token = m[1]; log('已刷新 sa_token:', m[1].slice(0, 10) + '…') }
    }
    saveSession()
    return r.status
  })(actionUrl)
  try { return await saRefresh } finally { saRefresh = null }
}

async function callAction(name, args, { retries = 2 } = {}) {
  if (!hasLogin()) throw Object.assign(new Error('未配置登录态'), { code: 'NO_SESSION' })

  // sa_token 绑定完整 URL: 获取 token 与调用 action 必须用同一个地址
  const actionUrl = `${BASE}/search?tab=media&query=${encodeURIComponent(String(args.query || ''))}&page=${args.page || 1}&type=${args.type || 'multi'}`
  await initOutbound()
  if (!session.sa_token) await updateSaToken(actionUrl)

  const doCall = async () => {
    const headers = {
      'content-type': 'text/plain;charset=UTF-8',
      'next-action': ACTIONS[name],
      'accept': 'text/x-component',
      'user-agent': UA,
      cookie: cookieHeader(),
    }
    log(`[action:${name}] POST URL=${actionUrl}`)
    log(`[action:${name}] POST body=${JSON.stringify(args)}`)
    return (await initOutbound())(actionUrl, { method: 'POST', headers, body: JSON.stringify(args) })
  }

  const t0 = Date.now()
  let r = await doCall()
  log(`[action:${name}] ← ${r.status} (${Date.now()-t0}ms) | 请求时 token=${(session.sa_token||'').slice(0,8)}`)
  // 从任何响应里吸收轮换的 sa_token（站点每次响应都可能换）
  const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : []
  for (const line of setCookies) {
    const m = line.match(/hdh_sa_token=([^;]+)/)
    if (m) session.sa_token = m[1]
  }
  // 408/428/409 = sa_token 失效或被轮换 → 重取再试; 401 = access token 过期 → 刷新会话
  const text = await r.text()
  // sa_token 是一次性的: 409/428/408 = token 失效；500 且返回 RSC = 站点把错误按
  // Flight 吐回（token 已被消耗）。这些都要换新 token 重试。
  const tokenInvalid = r.status === 428 || r.status === 409 || r.status === 408 ||
    (r.status === 500 && text.includes('$Sreact.fragment'))
  if (tokenInvalid && retries > 0) {
    await updateSaToken(actionUrl)
    return callAction(name, args, { retries: retries - 1 })
  }
  if (r.status === 403 && retries > 0) {
    // Cloudflare 偶发拦截: 稍候换连接重试
    await new Promise((ok) => setTimeout(ok, 800))
    return callAction(name, args, { retries: retries - 1 })
  }
  if (r.status === 401 && retries > 0) {
    const ok = await refreshSession()
    if (ok) return callAction(name, args, { retries: retries - 1 })
  }
  if (r.status !== 200) {
    try { fs.writeFileSync('/tmp/last-500.txt', text) } catch {}
    log(`[action:${name}] 失败响应头:`, text.slice(0, 160).replace(/\n/g, ' '))
    let msg = `HTTP ${r.status}`
    try { msg += ': ' + JSON.parse(text).message } catch {}
    throw Object.assign(new Error(msg), { code: 'HTTP_' + r.status })
  }
  return parseFlight(text)
}


// ── Flight (text/x-component) 解析: 提取行内 JSON ────────────
function parseFlight(text) {
  // Flight 行格式: <id>:<payload>；结果 JSON 通常在 "response":{"data":...} 或直接数组
  // 1) 优先找 {"response":...} 形态（server action 返回值）
  const candidates = []
  for (const line of text.split('\n')) {
    const i = line.indexOf(':')
    if (i < 1) continue
    const payload = line.slice(i + 1)
    if (!payload.startsWith('{') && !payload.startsWith('[')) continue
    try { candidates.push(JSON.parse(payload)) } catch {}
  }
  // 深度查找带 results / data 的对象
  let best = null
  const visit = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 6) return
    if (Array.isArray(o.results) || o.data?.results) { best = o; return }
    for (const v of Object.values(o)) visit(v, depth + 1)
  }
  for (const c of candidates) { visit(c); if (best) break }
  if (best) {
    return best.data ?? best
  }
  // 2) 兜底: 原样返回（调用方自行处理）
  return { raw: text.slice(0, 20000) }
}

async function refreshSession() {
  const rt = session.cookies?.refresh_token
  if (!rt) return false
  try {
    const r = await (await initOutbound())(`${BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'user-agent': UA, cookie: cookieHeader(), 'content-type': 'application/json' },
      body: '{}',
    })
    const set = r.headers.getSetCookie ? r.headers.getSetCookie() : []
    let got = false
    for (const line of set) {
      const m = line.match(/^(token|refresh_token)=([^;]+)/)
      if (m) { session.cookies[m[1]] = m[2]; got = true }
    }
    if (got) { saveSession(); log('access token 已续期'); return true }
    log('refresh 失败: HTTP', r.status)
    return false
  } catch (e) { log('refresh 异常:', e.message); return false }
}

// ── 业务 API ─────────────────────────────────────────────────
async function apiSearch(query, type = 'multi', page = 1) {
  const data = await callAction('searchTmdb', { query, type, page, language: 'zh-CN' })
  return { page: data.page || page, total_pages: data.total_pages || 0, total_results: data.total_results || 0, results: data.results || [] }
}

async function apiCheckIn() {
  return callAction('checkIn', {})
}

// ── HTTP 服务 ────────────────────────────────────────────────
function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost')
  try {
    if (u.pathname === '/health') {
      const exp = accessTokenExp()
      return json(res, 200, {
        ok: true,
        logged_in: hasLogin(),
        token_expires_at: exp ? new Date(exp).toISOString() : null,
        token_expired: hasLogin() && exp < Date.now(),
        sa_token: !!session.sa_token,
        updated_at: session.updated_at,
      })
    }
    if (u.pathname === '/session' && req.method === 'POST') {
      // 配置/更新登录态: body = {"cookies": {"token":"…","refresh_token":"…", ...}}
      let body = ''
      for await (const ch of req) body += ch
      const input = JSON.parse(body || '{}')
      session.cookies = { ...(session.cookies || {}), ...(input.cookies || {}) }
      if (input.user_id) session.user_id = input.user_id
      saveSession()
      await updateSaToken(`${BASE}/search?tab=media`)
      return json(res, 200, { ok: true, logged_in: hasLogin(), token_expires_at: new Date(accessTokenExp()).toISOString() })
    }
    if (u.pathname === '/session/logout' && req.method === 'POST') {
      session.cookies = {}; session.sa_token = ''; saveSession()
      return json(res, 200, { ok: true })
    }
    if (u.pathname === '/search') {
      const q = u.searchParams.get('query') || ''
      const type = u.searchParams.get('type') || 'multi'
      const page = Number(u.searchParams.get('page')) || 1
      if (!q) return json(res, 400, { error: 'query required' })
      // 在独立子进程中执行抓取: 实测同一进程内长驻后 Cloudflare/站点会持续 500,
      // 而每次全新进程(全新 TLS 会话)稳定成功。子进程开销约 100ms, 可接受。
      const result = await new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'fetch-worker.mjs'), q, type, String(page)], { cwd: __dirname })
        let out = ''
        child.stdout.on('data', (c) => (out += c))
        child.stderr.on('data', (c) => log('[worker]', String(c).trim().slice(0, 150)))
        child.on('close', () => {
          try { resolve(JSON.parse(out)) } catch { resolve({ error: 'worker 无效输出', raw: out.slice(0, 300) }) }
        })
      })
      const code = result.error ? 502 : 200
      return json(res, code, result)
    }
    if (u.pathname === '/debug-call') {
      try {
        const r = await callAction('searchTmdb', { query: u.searchParams.get('q') || 'test', type: 'multi', page: 1, language: 'zh-CN' })
        return json(res, 200, { ok: true, sample: String(JSON.stringify(r)).slice(0, 200) })
      } catch (e) {
        return json(res, 500, { error: e.message, code: e.code, stack: String(e.stack).slice(0, 400) })
      }
    }
    if (u.pathname === '/checkin' && req.method === 'POST') {
      return json(res, 200, await apiCheckIn())
    }
    json(res, 404, { error: 'not found', endpoints: ['/health', '/search?query=', '/checkin', 'POST /session'] })
  } catch (e) {
    json(res, e.code === 'NO_SESSION' ? 503 : 502, { error: e.message, code: e.code })
  }
})

loadSession()
// 出站代理支持
if (PROXY) log('出站代理:', PROXY)
setInterval(() => {
  const exp = accessTokenExp()
  // 过期前 6 小时自动续期
  if (hasLogin() && exp && exp - Date.now() < 6 * 3600e3) refreshSession()
}, 30 * 60e3).unref()

server.listen(PORT, () => log(`re0-agent listening on :${PORT} | config: ${CONFIG_DIR} | proxy: ${PROXY || 'none'}`))
