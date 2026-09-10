// 独立抓取 worker: 每次全新进程 => 全新 TLS 会话, 实测稳定 200。
import fs from 'node:fs'
import { ProxyAgent, setGlobalDispatcher } from 'undici'

const CONFIG = process.env.CONFIG_DIR || '/config'
const UA = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
const PROXY = process.env.HTTP_PROXY || ''
const BASE = 'https://re0.me'
const ACTIONS = { searchTmdb: '40adaeedd497fcbefd09afe949ad909b227b507bb1' }

const [query, type = 'multi', page = '1'] = process.argv.slice(2)
if (!query) { console.log(JSON.stringify({ error: 'query required' })); process.exit(0) }
if (PROXY) setGlobalDispatcher(new ProxyAgent(PROXY))

const st = JSON.parse(fs.readFileSync(path0(), 'utf8'))
function path0() { return process.env.SESSION_FILE || (CONFIG + '/session.json') }

const emit = (obj) => { console.log(JSON.stringify(obj)); process.exit(0) }

const cookiesOf = (st) => Object.entries(st.cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ')
const ua = { 'user-agent': UA }
const U = `${BASE}/search?tab=media&query=${encodeURIComponent(query)}&page=${page}&type=${type}`

try {
  // 1) GET 页面拿轮换的 hdh_sa_token
  let r = await fetch(U, { headers: { ...ua, cookie: cookiesOf(st) } })
  let tok = null
  ;(r.headers.getSetCookie ? r.headers.getSetCookie() : []).forEach((l) => {
    const m = l.match(/hdh_sa_token=([^;]+)/)
    if (m) tok = m[1]
  })
  // 2) POST server action
  r = await fetch(U, {
    method: 'POST',
    headers: { ...ua, 'content-type': 'text/plain;charset=UTF-8', 'next-action': ACTIONS.searchTmdb, accept: 'text/x-component', cookie: cookiesOf(st) + '; hdh_sa_token=' + tok },
    body: JSON.stringify([{ query, type, page: Number(page), language: 'zh-CN' }]),
  })
  const text = await r.text()
  // 3) 解析 Flight 行, 找 {"response":{"data":{...}}}
  for (const line of text.split('\n')) {
    const i = line.indexOf(':')
    if (i < 1) continue
    try {
      const o = JSON.parse(line.slice(i + 1))
      const d = o?.response?.data
      if (d?.results) {
        st.sa_token = tok
        try { fs.writeFileSync(path0(), JSON.stringify(st, null, 2)) } catch {}
        emit(d)
      }
    } catch {}
  }
  emit({ error: '未解析到结果', http: r.status })
} catch (e) {
  emit({ error: e.message })
}
