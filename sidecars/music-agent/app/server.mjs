// music-agent: 音乐搜索/下载 sidecar
// 插件(wasm) 通过宿主 Broker 调用本服务(localhost:8790)
// 登录: 三家扫码(网易/QQ·微信/酷狗) | 下载: sidecar 本地下 → 写 CD2 挂载目录 → CD2 上传 115

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { ProxyAgent, setGlobalDispatcher } from 'undici'
import QRCode from 'qrcode'

const CONFIG = process.env.CONFIG_DIR || '/config'
const MUSIC_MOUNT = process.env.MUSIC_MOUNT || '/CloudNAS/115open/音乐'
const DL_SUBDIR = process.env.DOWNLOAD_SUBDIR || '音乐下载'
const PORT = Number(process.env.PORT || 8791)
const HOST = process.env.HOST || '127.0.0.1'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
// 网易扫码用桌面客户端 UA + HTTP Referer（与 go-music-dl 一致）
const NETEASE_QR_UA = 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.0.18.203152'
const NETBASE = 'https://interface.music.163.com/api/login/qrcode'
// 每个 unikey 对应的设备 cookie（NMTID），轮询必须带上才不会被风控拦
const qrDevice = new Map()
const qrDone = new Map() // 已成功的 key: 避免轮询竞态把成功显示成过期
const SESSIONS = path.join(CONFIG, 'sessions.json')
const TASKS = path.join(CONFIG, 'tasks.json')

const log = (...a) => console.log(new Date().toISOString(), ...a)

// ── 存储 ─────────────────────────────────────────────────────
let sessions = {} // {netease: {MUSIC_U,...}, qq: {...}, kugou: {token,userid,...}}
let tasks = {}    // {task_id: {…, status, progress, message, file}}
try { sessions = JSON.parse(fs.readFileSync(SESSIONS, 'utf8')) } catch {}
try { tasks = JSON.parse(fs.readFileSync(TASKS, 'utf8')) } catch {}
const saveSessions = () => fs.writeFileSync(SESSIONS, JSON.stringify(sessions, null, 2))
const saveTasks = () => fs.writeFileSync(TASKS, JSON.stringify(tasks, null, 2))
function saveTask(t) { tasks[t.id] = t; saveTasks() }

// ── 出站（搜索直连；下载/登录按需）────────────────────────────
let searchAgent = null
function searchFetch(url, opts = {}) {
  if (!searchAgent) searchAgent = new ProxyAgent({ uri: 'http://127.0.0.1:1', keepAliveTimeout: 1 }) // placeholder 不走代理时未用
  return fetch(url, opts)
}
// 搜索直连(国内); 下载按源(网易直连/QQ直连/酷狗直连), 登录接口直连
const F = (url, opts) => fetch(url, opts)

// ── 工具 ─────────────────────────────────────────────────────
// md5 字节流按大整数转十进制字符串（与 music-lib calculateKugouMID 一致）
function md5Buf(s) { return crypto.createHash('md5').update(s).digest() }
function BigNumber(bytes) {
  let v = 0n
  for (const b of bytes) v = (v << 8n) | BigInt(b)
  return v
}

const md5hex = (s) => crypto.createHash('md5').update(s).digest('hex')
const jsonRes = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }
const readBody = async (req) => { let b = ''; for await (const c of req) b += c; return b ? JSON.parse(b) : {} }
const cookieOf = (source) => Object.entries(sessions[source] || {}).map(([k, v]) => `${k}=${v}`).join('; ')
const fmtMB = (b) => (b / 1048576).toFixed(1) + 'MB'

// 随机国内 IP 头: 网易风控按 X-Real-IP/X-Forwarded-For 判定客户端位置,
// 缺失时报 8821「请切换其他登录方式」(扫码授权阶段被拦)。对齐 go-music-dl 的做法。
const CN_PREFIXES = [[116,255],[116,228],[218,192],[124,0],[14,132],[183,14],[58,14],[113,116],[120,230]]
function randomChinaIP() {
  const p = CN_PREFIXES[Math.floor(Math.random() * CN_PREFIXES.length)]
  return `${p[0]}.${p[1]}.${Math.floor(Math.random()*254)+1}.${Math.floor(Math.random()*254)+1}`
}
function ipHeaders() {
  const ip = randomChinaIP()
  return { 'x-real-ip': ip, 'x-forwarded-for': ip }
}

// ── 网易云 ───────────────────────────────────────────────────
async function neteaseSearch(query, page) {
  const form = new URLSearchParams({ s: query, type: '1', limit: '30', offset: String((page - 1) * 30) })
  const cookie = cookieOf('netease')
  const r = await F('https://music.163.com/api/cloudsearch/pc', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'https://music.163.com/', 'user-agent': UA, cookie, ...ipHeaders() },
    body: form.toString(),
  })
  const j = await r.json()
  const songs = (j?.result?.songs || []).map((s) => ({
    id: String(s.id), name: s.name,
    singers: (s.ar || []).map((a) => a.name).join('/'),
    album: s.al?.name || '', cover: s.al?.picUrl || '',
    duration_ms: s.dt || 0, source: 'netease',
  }))
  return { songs, total: j?.result?.songCount || 0, page }
}

async function neteaseQRCreate() {
  // 对齐 go-music-dl: interface 主机 + type=3 + 桌面客户端 UA + HTTP Referer + 随机国内 IP 头
  const r = await F(`${NETBASE}/unikey`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': NETEASE_QR_UA, referer: 'http://music.163.com/', ...ipHeaders() },
    body: 'type=3',
  })
  const cookies = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map((c) => c.split(';')[0])
  const nmtid = cookies.find((c) => c.startsWith('NMTID=')) || ''
  const j = await r.json()
  if (j.code !== 200 || !j.unikey) throw new Error('获取 unikey 失败: ' + JSON.stringify(j).slice(0, 80))
  if (nmtid) qrDevice.set(j.unikey, nmtid)
  log(`[netease-qr] unikey=${j.unikey.slice(0, 8)}… nmtid=${nmtid ? 'ok' : 'none'}`)
  log(`[netease-qr] 新 unikey=${j.unikey.slice(0, 8)}…`)
  const content = 'https://music.163.com/login?codekey=' + encodeURIComponent(j.unikey)
  const dataURL = await QRCode.toDataURL(content, { width: 280, margin: 1 })
  return { key: j.unikey, qr_dataurl: dataURL, expires_in: 300 }
}

async function neteaseQRPoll(key) {
  const nmtid = qrDevice.get(key)
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    referer: 'http://music.163.com/',
    'user-agent': NETEASE_QR_UA,
    ...ipHeaders(),
  }
  if (nmtid) headers.cookie = nmtid
  const r = await F(`${NETBASE}/client/login`, { method: 'POST', headers, body: `key=${encodeURIComponent(key)}&type=3` })
  const setc = r.headers.getSetCookie ? r.headers.getSetCookie() : []
  const j = await r.json()
  const statusMap = { 800: 'expired', 801: 'waiting', 802: 'scanned', 803: 'success' }
  let status = statusMap[j.code] || 'failed'
  // 成功后 key 立即失效(800), 前端可能轮询到 800 而误显示"已过期" → 记住成功状态
  if (status === 'success') { qrDone.set(key, 'success'); qrDevice.delete(key) }
  else if (qrDone.get(key) === 'success') status = 'success'
  log(`[netease-poll] code=${j.code} status=${status} msg=${j.message || ''}`)
  if (status === 'success') {
    const jar = {}
    // cookie 在 body 和 Set-Cookie 都可能有
    for (const pair of String(j.cookie || '').split(';')) {
      const kv = pair.trim().split('=')
      if (kv.length === 2 && kv[0]) jar[kv[0]] = kv[1]
    }
    for (const line of setc) {
      const kv = line.split(';')[0].split('=')
      if (kv.length >= 2 && kv[0]) jar[kv[0].trim()] = kv.slice(1).join('=')
    }
    sessions.netease = { ...sessions.netease, ...jar }
    saveSessions()
    log('网易云登录成功 user=' + (jar.MUSIC_U ? 'ok' : '?'))
  }
  return { status, code: j.code, message: j.message || '' }
}

// ── QQ 音乐 ──────────────────────────────────────────────────
const qqHash33 = (s) => { let h = 0; for (const c of s) h += (h << 5) + c.charCodeAt(0); return h & 0x7fffffff }

async function qqQRCreate(type = 'qq') {
  if (type === 'wx') {
    const params = new URLSearchParams({
      appid: 'wx48db31d50e334801',
      redirect_uri: 'https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/',
      response_type: 'code', scope: 'snsapi_login',
      state: 'musicagent', href: 'https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect',
    })
    const r = await F('https://open.weixin.qq.com/connect/qrconnect?' + params.toString(), { headers: { 'user-agent': UA, referer: 'https://y.qq.com/' } })
    const html = await r.text()
    const m = html.match(/connect\/l\/qrconnect\?uuid=([A-Za-z0-9_-]+)/) || html.match(/QRLogin\.uuid\s*=\s*"([^"]+)"/) || html.match(/connect\/qrcode\/([A-Za-z0-9_-]+)/)
    if (!m) throw new Error('微信 uuid 缺失')
    const uuid = m[1]
    return { key: JSON.stringify({ type: 'wx', uuid }), qr_dataurl: 'https://open.weixin.qq.com/connect/qrcode/' + uuid, image_is_url: true, expires_in: 300 }
  }
  const params = new URLSearchParams({
    appid: '716027609', e: '2', l: 'M', s: '3', d: '72', v: '4',
    t: (Date.now() / 1e18).toFixed(17), daid: '383', pt_3rd_aid: '100497308',
  })
  const r = await F('https://ssl.ptlogin2.qq.com/ptqrshow?' + params.toString(), { headers: { 'user-agent': UA, referer: 'https://y.qq.com/' } })
  const setc = r.headers.getSetCookie ? r.headers.getSetCookie() : []
  let qrsig = ''
  for (const line of setc) { const m = line.match(/qrsig=([^;]+)/); if (m) qrsig = m[1] }
  if (!qrsig) throw new Error('缺少 qrsig')
  const img = Buffer.from(await r.arrayBuffer())
  const dataURL = 'data:image/png;base64,' + img.toString('base64')
  return { key: JSON.stringify({ qrsig }), qr_dataurl: dataURL, expires_in: 120 }
}

async function qqQRPoll(key) {
  const v = JSON.parse(key)
  if (v.type === 'wx') {
    const params = new URLSearchParams({ uuid: v.uuid, _: Date.now() })
    const r = await F('https://lp.open.weixin.qq.com/connect/l/qrconnect?' + params.toString(), { headers: { 'user-agent': UA, referer: 'https://open.weixin.qq.com/connect/qrconnect' } })
    const body = await r.text()
    const code = (body.match(/wx_errcode\s*=\s*'?(\d+)'?/) || [])[1] || ''
    const wxCode = (body.match(/wx_code\s*=\s*["']([^"']*)["']/) || [])[1] || ''
    const statusMap = { 405: 'success', 408: 'waiting', 404: 'expired', 402: 'expired' }
    const status = statusMap[code] || 'failed'
    if (status !== 'success') return { status, code }
    if (!wxCode) return { status: 'failed', message: '微信授权码缺失' }
    const payload = {
      comm: { tmeAppID: 'qqmusic', tmeLoginType: '2', g_tk: 5381, platform: 'yqq', ct: 24, cv: 0 },
      req: { module: 'music.login.LoginServer', method: 'Login', param: { strAppid: 'wx48db31d50e334801', code: wxCode } },
    }
    const lr = await F('https://u.y.qq.com/cgi-bin/musicu.fcg', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA, referer: 'https://y.qq.com/' }, body: JSON.stringify(payload) })
    const jar = {}
    for (const line of (lr.headers.getSetCookie ? lr.headers.getSetCookie() : [])) {
      const kv = line.split(';')[0].split('=')
      if (kv.length >= 2 && kv[0]) jar[kv[0].trim()] = kv.slice(1).join('=')
    }
    sessions.qq = { ...sessions.qq, ...jar }
    saveSessions()
    log('QQ 微信扫码登录成功 cookies=' + Object.keys(jar).length)
    return { status: 'success', logged_in: true }
  }
  const params = new URLSearchParams({
    u1: 'https://graph.qq.com/oauth2.0/login_jump',
    ptqrtoken: String(qqHash33(v.qrsig)),
    ptredirect: '100', h: '1', t: '1', g: '1', from_ui: '1', ptlang: '2052',
    action: `0-0-${Date.now()}`, js_ver: '21072115', js_type: '1', login_sig: '',
    pt_uistyle: '40', aid: '716027609', daid: '383', pt_3rd_aid: '100497308',
    has_onekey: '1', pttype: '1', service: 'ptqrlogin', nodirect: '0',
  })
  const r = await F('https://ssl.ptlogin2.qq.com/ptqrlogin?' + params.toString(), { headers: { 'user-agent': UA, referer: 'https://xui.ptlogin2.qq.com/', cookie: 'qrsig=' + v.qrsig }, redirect: 'manual' })
  // ptqrlogin 302 链会下发 skey/p_skey/uin（QQ 音乐 API 凭据），逐步收集
  const pollJar = {}
  let hop = r
  for (let h = 0; h < 6 && hop.status >= 300 && hop.status < 400; h++) {
    for (const line of (hop.headers.getSetCookie ? hop.headers.getSetCookie() : [])) {
      const kv = line.split(';')[0].split('=')
      if (kv.length >= 2 && kv[0]) pollJar[kv[0].trim()] = kv.slice(1).join('=')
    }
    const loc = hop.headers.get('location')
    if (!loc) break
    hop = await F(loc, { headers: { 'user-agent': UA, cookie: Object.entries(pollJar).map(([k, v]) => `${k}=${v}`).join('; ') || ('qrsig=' + v.qrsig), redirect: 'manual' } })
    for (const line of (hop.headers.getSetCookie ? hop.headers.getSetCookie() : [])) {
      const kv = line.split(';')[0].split('=')
      if (kv.length >= 2 && kv[0]) pollJar[kv[0].trim()] = kv.slice(1).join('=')
    }
  }
  log(`[qq-poll] 链上 cookie: ${Object.keys(pollJar).join(',') || '无'}`)
  const body = hop.status < 400 ? await hop.text() : ''
  const matches = [...body.matchAll(/'([^']*)'/g)].map((m) => m[1])
  const code = matches[0] || ''
  const redirect = matches[2] || ''
  const statusMap = { 0: 'success', 65: 'expired', 66: 'waiting', 67: 'scanned' }
  const status = statusMap[code] || 'failed'
  log(`[qq-poll] code=${code} status=${status}`)
  if (status !== 'success') return { status, code }
  // 跟随重定向链收集 cookie：必须 redirect:manual（否则 fetch 自动跟随会丢中间 Set-Cookie）
  const jar = { ...pollJar }
  let cur = redirect
  for (let i = 0; i < 8 && cur; i++) {
    const rr = await F(cur, { headers: { 'user-agent': UA, referer: 'https://y.qq.com/', cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') || ('qrsig=' + v.qrsig) }, redirect: 'manual' })
    log(`[qq-redirect] ${rr.status} ${String(cur).slice(0, 60)}`)
    for (const line of (rr.headers.getSetCookie ? rr.headers.getSetCookie() : [])) {
      const kv = line.split(';')[0].split('=')
      if (kv.length >= 2 && kv[0]) jar[kv[0].trim()] = kv.slice(1).join('=')
    }
    const loc = rr.headers.get('location')
    if (!loc || rr.status < 300 || rr.status >= 400) break
    cur = loc
  }
  if (!jar.uin) for (const k of ['ptui_loginuin', 'luin', 'p_uin', 'pt2gguin', 'wxuin']) if (jar[k]) { jar.uin = jar[k]; break }
  if (!jar.qqmusic_key) for (const k of ['p_skey', 'skey', 'musickey']) if (jar[k]) { jar.qqmusic_key = jar[k]; break }
  sessions.qq = { ...sessions.qq, ...jar }
  saveSessions()
  log('QQ 扫码登录成功 cookies=' + Object.keys(jar).length)
  return { status: 'success', logged_in: true }
}

// ── 网易云歌单（明文 API + Cookie）──────────────────────────
async function neteaseAccount() {
  const r = await F('https://music.163.com/api/nuser/account/get', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'https://music.163.com/', 'user-agent': UA, cookie: cookieOf('netease'), ...ipHeaders() },
    body: '',
  })
  const j = await r.json()
  const uid = j?.profile?.userId
  if (!uid) throw new Error('未登录或登录态失效')
  return { uid: String(uid), nickname: j?.profile?.nickname || '' }
}

async function neteasePlaylists() {
  const { uid, nickname } = await neteaseAccount()
  const out = []
  for (let offset = 0; offset < 2000; offset += 100) {
    const r = await F(`https://music.163.com/api/user/playlist?uid=${uid}&limit=100&offset=${offset}&includeVideo=true`, {
      headers: { referer: 'https://music.163.com/', 'user-agent': UA, cookie: cookieOf('netease'), ...ipHeaders() },
    })
    const j = await r.json()
    const list = j?.playlist || []
    for (const p of list) out.push({ id: String(p.id), name: p.name, cover: p.coverImgUrl, count: p.trackCount || 0, creator: p.creator?.nickname || nickname })
    if (list.length < 100) break
  }
  return { playlists: out, count: out.length }
}

const NETEASE_LEVEL_ORDER = ['standard', 'exhigh', 'lossless', 'hires', 'sky', 'jyeffect', 'dolby', 'jymaster']

async function neteasePlaylistSongs(id, page, pageSize) {
  // v6 明文接口 n=0 拿全量 trackIds（不受 1000 截断），再分批 v3 detail 换详情
  const r = await F(`https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(id)}&n=0`, {
    headers: { referer: 'https://music.163.com/', 'user-agent': UA, cookie: cookieOf('netease'), ...ipHeaders() },
  })
  const j = await r.json()
  const pl = j?.playlist || j?.result || {}
  const ids = (pl.trackIds || []).map((t) => t.id)
  const total = pl.trackCount ?? ids.length
  const name = pl.name || ''
  const start = (page - 1) * pageSize
  const pageIds = ids.slice(start, start + pageSize)
  if (!pageIds.length) return { name, total, page, pageSize, songs: [] }

  const tracks = []
  for (let i = 0; i < pageIds.length; i += 200) {
    const chunk = pageIds.slice(i, i + 200)
    const c = JSON.stringify(chunk.map((v) => ({ id: v })))
    const rr = await F('https://music.163.com/api/v3/song/detail', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'https://music.163.com/', 'user-agent': UA, cookie: cookieOf('netease'), ...ipHeaders() },
      body: `c=${encodeURIComponent(c)}&ids=[${chunk.join(',')}]`,
    })
    const jj = await rr.json()
    for (const t of jj?.songs || []) tracks.push(t)
  }

  const songs = tracks.map((t) => {
    const priv = t.privilege || {}
    const maxBr = priv.maxBrLevel || priv.downloadMaxBrLevel || ''
    const maxIdx = NETEASE_LEVEL_ORDER.indexOf(maxBr)
    const qualities = maxIdx >= 0 ? NETEASE_LEVEL_ORDER.slice(0, maxIdx + 1).reverse() : []
    return {
      id: String(t.id), name: t.name,
      singers: (t.ar || t.artists || []).map((a) => a.name).join('/'),
      album: (t.al || t.album)?.name || '', cover: (t.al || t.album)?.picUrl || '',
      duration_ms: t.dt || t.duration || 0, source: 'netease',
      max_level: maxBr, qualities,
    }
  })
  return { name, total, page, pageSize, songs }
}

// ── 酷狗 ─────────────────────────────────────────────────────
const kgSign = (params) => {
  const pairs = Object.entries(params).map(([k, v]) => `${k}=${v}`).sort()
  return md5hex('NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt' + pairs.join('') + 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt')
}
function kgDevice() {
  if (sessions.kugou?._device) return sessions.kugou._device
  const buf = crypto.randomBytes(16)
  buf[6] = (buf[6] & 0x0f) | 0x40; buf[8] = (buf[8] & 0x3f) | 0x80
  const hx = buf.toString('hex')
  const guid = `${hx.slice(0, 8)}-${hx.slice(8, 12)}-${hx.slice(12, 16)}-${hx.slice(16, 20)}-${hx.slice(20)}`
  const mid = new BigNumber(md5Buf(guid)).toString()
  const dev = { guid, mid }
  sessions.kugou = { ...(sessions.kugou || {}), _device: dev }
  return dev
}
async function kgGet(api, params) {
  const dev = kgDevice()
  const clienttime = String(Math.floor(Date.now() / 1000))
  const all = {
    dfid: sessions.kugou?.dfid || '-', mid: dev.mid, uuid: '-',
    appid: '3116', clientver: '11440', clienttime, ...params,
  }
  all.signature = kgSign(all)
  const qs = new URLSearchParams(all).toString()
  const r = await F(api + '?' + qs, {
    headers: {
      'user-agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
      dfid: all.dfid, clienttime, mid: all.mid, 'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': '1',
      cookie: cookieOf('kugou'),
    },
  })
  return r.json()
}
async function kugouQRCreate() {
  const j = await kgGet('https://login-user.kugou.com/v2/qrcode', {
    appid: '1001', type: '1', plat: '4', srcappid: '2919',
    qrcode_txt: 'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=3116&',
  })
  const qrcode = j?.data?.qrcode
  if (!qrcode) throw new Error('酷狗二维码获取失败: ' + JSON.stringify(j).slice(0, 100))
  const content = 'https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=' + encodeURIComponent(qrcode)
  const dataURL = await QRCode.toDataURL(content, { width: 280, margin: 1 })
  return { key: qrcode, qr_dataurl: dataURL, expires_in: 300 }
}
async function kugouQRPoll(key) {
  const j = await kgGet('https://login-user.kugou.com/v2/get_userinfo_qrcode', {
    plat: '4', appid: '3116', srcappid: '2919', qrcode: key,
  })
  const st = j?.data?.status
  const token = j?.data?.token || ''
  const userid = String(j?.data?.userid ?? '')
  if (token && userid && userid !== '0') {
    sessions.kugou = { ...(sessions.kugou || {}), token, userid, dfid: sessions.kugou?._device?.guid || '-' }
    saveSessions()
    log('酷狗登录成功 userid=' + userid)
    return { status: 'success', logged_in: true }
  }
  const statusMap = { 1: 'waiting', 2: 'waiting', 0: 'scanned' }
  return { status: statusMap[st] || 'waiting', code: st, message: j?.error || '' }
}

// ── 搜索路由 ─────────────────────────────────────────────────
const searchers = { netease: neteaseSearch }
async function qqSearch(query, page) {
  const params = new URLSearchParams({ w: query, format: 'json', p: String(page), n: '20' })
  const r = await F('https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?' + params.toString(), { headers: { 'user-agent': UA, referer: 'https://y.qq.com/', cookie: cookieOf('qq') } })
  const j = await r.json()
  const songs = (j?.data?.song?.list || []).map((s) => ({
    id: s.songmid, name: s.songname,
    singers: (s.singer || []).map((a) => a.name).join('/'),
    album: s.albumname || '', duration_s: s.interval || 0, source: 'qq',
    quality: s.sizeflac > 0 ? 'flac' : (s.size320 > 0 ? '320' : '128'),
  }))
  return { songs, page }
}
async function kugouSearch(query, page) {
  const j = await kgGet('https://songsearch.kugou.com/song_search_v2', {
    keyword: query, platform: 'WebFilter', format: 'json', page: String(page),
    pagesize: '20', userid: '-1', clientver: '', tag: 'em', filter: '2',
    iscorrection: '1', privilege_filter: '0', _: String(Date.now()),
  })
  const songs = (j?.data?.lists || []).map((s) => ({
    id: s.Audioid || s.FileHash, hash: s.FileHash, sq_hash: s.SQFileHash || '', hq_hash: s.HQFileHash || '',
    name: (s.SongName || '').replace(/<[^>]+>/g, ''), singers: (s.SingerName || '').replace(/<[^>]+>/g, ''),
    album: s.AlbumName || '', size: s.SQFileSize || s.HQFileSize || s.FileSize || 0, source: 'kugou',
    quality: s.SQFileHash ? 'flac' : (s.HQFileHash ? '320' : '128'),
  }))
  return { songs, total: j?.data?.total || 0, page }
}
const searchAll = { netease: neteaseSearch, qq: qqSearch, kugou: kugouSearch }

// ── 下载任务 ─────────────────────────────────────────────────
function outPathFor(t) {
  const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim()
  const ext = t.ext || (t.source === 'netease' ? 'flac' : (t.quality === '128' ? 'mp3' : 'flac'))
  const fname = `${safe(t.singers) || '未知'} - ${safe(t.name)}${t.quality && t.source !== 'netease' ? ` [${t.quality}]` : ''}.${ext}`
  return path.join(MUSIC_MOUNT, DL_SUBDIR, fname)
}

const MAX_CONCURRENT_DOWNLOADS = Number(process.env.MAX_CONCURRENT_DOWNLOADS || 2)
function pumpQueue() {
  let active = Object.values(tasks).filter((t) => t.status === 'downloading').length
  const queued = Object.values(tasks).filter((t) => t.status === 'queued').sort((a, b) => a.created - b.created)
  for (const t of queued) {
    if (active >= MAX_CONCURRENT_DOWNLOADS) break
    active++
    startDownload(t)
  }
}
function startDownload(t) {
  t.status = 'downloading'; t.progress = 0; t.message = '启动'
  saveTask(t)
  const taskFile = path.join(CONFIG, `task-${t.id}.json`)
  fs.writeFileSync(taskFile, JSON.stringify({
    source: t.source,
    // task.id 是本服务自己的任务号；平台歌曲标识必须使用 song_id/hash，不能混用。
    id: t.song_id,
    hash: t.hash,
    quality: t.quality,
    cookie: cookieOf(t.source), out_path: t.out_path,
    kugou_state: { mid: sessions.kugou?._device?.mid, token: sessions.kugou?.token, userid: sessions.kugou?.userid, dfid: sessions.kugou?.dfid },
  }))
  const child = spawn(process.execPath, [path.join(process.cwd(), 'fetch-worker.mjs'), taskFile], { cwd: process.cwd(), env: process.env })
  t.pid = child.pid
  let stderr = ''
  child.stderr.on('data', (c) => {
    const line = String(c)
    if (line.startsWith('PROGRESS ')) {
      const [, pct, ...msg] = line.trim().split(' ')
      t.progress = Number(pct) || 0; t.message = msg.join(' ')
      saveTask(t)
    } else stderr += line
  })
  child.stdout.on('data', (c) => {
    try {
      const r = JSON.parse(String(c).trim())
      if (r.ok) { t.status = 'done'; t.progress = 100; t.message = `完成 ${fmtMB(r.size)} (${r.quality || ''})` }
      else { t.status = 'failed'; t.message = r.error || '失败' }
      saveTask(t)
      pumpQueue()
    } catch {}
  })
  child.on('close', (code) => {
    if (t.status === 'downloading') { t.status = 'failed'; t.message = 'worker 异常退出 code=' + code }
    saveTask(t)
    fs.unlink(taskFile, () => {})
    pumpQueue()
  })
}

// ── HTTP 服务 ────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost')
  try {
    if (u.pathname === '/health') {
      const logged = Object.fromEntries(Object.keys(sessions).map((s) => [s, Object.keys(sessions[s] || {}).length > 0]))
      return jsonRes(res, 200, { ok: true, logged_in: logged, tasks_active: Object.values(tasks).filter((t) => t.status === 'downloading').length, mount_ok: fs.existsSync(MUSIC_MOUNT) })
    }
    if (u.pathname === '/search') {
      const q = u.searchParams.get('query') || ''
      const source = u.searchParams.get('source') || 'netease'
      const page = Number(u.searchParams.get('page')) || 1
      if (!q) return jsonRes(res, 400, { error: 'query required' })
      const fn = searchAll[source]
      if (!fn) return jsonRes(res, 400, { error: '未知来源' })
      return jsonRes(res, 200, await fn(q, page))
    }
    if (u.pathname === '/qr/create') {
      const source = u.searchParams.get('source') || 'netease'
      const type = u.searchParams.get('type') || 'qq'
      const r = source === 'netease' ? await neteaseQRCreate() : source === 'qq' ? await qqQRCreate(type) : await kugouQRCreate()
      return jsonRes(res, 200, r)
    }
    if (u.pathname === '/qr/poll') {
      const source = u.searchParams.get('source') || 'netease'
      const type = u.searchParams.get('type') || 'qq'
      const key = u.searchParams.get('key') || ''
      const r = source === 'netease' ? await neteaseQRPoll(key) : source === 'qq' ? await qqQRPoll(key) : await kugouQRPoll(key)
      return jsonRes(res, 200, r)
    }
    if (u.pathname === '/playlists') {
      const source = u.searchParams.get('source') || 'netease'
      if (source !== 'netease') return jsonRes(res, 400, { error: '该来源暂不支持歌单，先支持网易云' })
      return jsonRes(res, 200, await neteasePlaylists())
    }
    if (u.pathname === '/playlist/songs') {
      const source = u.searchParams.get('source') || 'netease'
      const id = u.searchParams.get('id') || ''
      const page = Number(u.searchParams.get('page')) || 1
      const pageSize = Math.min(Number(u.searchParams.get('page_size')) || 100, 500)
      if (!id) return jsonRes(res, 400, { error: 'id required' })
      if (source !== 'netease') return jsonRes(res, 400, { error: '该来源暂不支持歌单，先支持网易云' })
      return jsonRes(res, 200, await neteasePlaylistSongs(id, page, pageSize))
    }
    if (u.pathname === '/download/batch' && req.method === 'POST') {
      const b = await readBody(req)
      const songs = Array.isArray(b.songs) ? b.songs : []
      if (!songs.length) return jsonRes(res, 400, { error: 'songs required' })
      const quality = b.quality || 'flac'
      const ids = []
      for (const s of songs.slice(0, 1000)) {
        const id = 't' + Date.now() + Math.random().toString(36).slice(2, 6)
        const t = {
          id, song_id: String(s.id || ''), hash: String(s.hash || ''), source: b.source,
          name: s.name, singers: s.singers, album: s.album || '',
          quality, ext: b.ext, created: Date.now(), status: 'queued', progress: 0, message: '排队中',
        }
        t.out_path = outPathFor(t)
        tasks[id] = t
        ids.push(id)
      }
      saveTasks()
      pumpQueue()
      return jsonRes(res, 200, { ok: true, count: ids.length, task_ids: ids })
    }
    if (u.pathname === '/download' && req.method === 'POST') {
      const b = await readBody(req)
      const id = 't' + Date.now() + Math.random().toString(36).slice(2, 6)
      const t = {
        id,
        song_id: String(b.id || ''),
        hash: String(b.hash || ''),
        source: b.source,
        name: b.name,
        singers: b.singers,
        album: b.album,
        quality: b.quality,
        ext: b.ext,
        created: Date.now(),
      }
      t.out_path = outPathFor(t)
      t.status = 'queued'; t.progress = 0; t.message = '排队中'
      tasks[id] = t
      saveTasks()
      pumpQueue()
      return jsonRes(res, 200, { ok: true, task_id: id })
    }
    if (u.pathname === '/task' || u.pathname === '/tasks') {
      const id = u.searchParams.get('id')
      if (id) return jsonRes(res, 200, tasks[id] || {})
      const list = Object.values(tasks).sort((a, b) => b.created - a.created).slice(0, 50)
      return jsonRes(res, 200, { tasks: list })
    }
    if (u.pathname === '/session/status') {
      // 只返回登录摘要，绝不把 Cookie 值经过插件 bridge 送到浏览器。
      const status = Object.fromEntries(Object.entries(sessions).map(([source, jar]) => [source, {
        logged_in: jar && typeof jar === 'object' && Object.keys(jar).length > 0,
        cookie_names: jar && typeof jar === 'object' ? Object.keys(jar).filter((k) => !k.startsWith('_')) : [],
      }]))
      return jsonRes(res, 200, status)
    }
    if (u.pathname === '/relay' && req.method === 'POST') {
      // notify.bot 通知中转: 用配置里的代理出口发 webhook（如企业微信固定 IP 需求）。
      // 只放行通知类域名，避免变成开放代理；本服务只绑 127.0.0.1。
      const b = await readBody(req)
      if (!b.url || !/^https?:\/\//i.test(b.url)) return jsonRes(res, 400, { error: 'url required' })
      const host = new URL(b.url).hostname
      const allowed = ['qyapi.weixin.qq.com', 'open.feishu.cn', 'sctapi.ftqq.com', 'qmsg.zber.com']
      if (!allowed.includes(host)) return jsonRes(res, 403, { error: 'host not allowed: ' + host })
      const init = {
        method: 'POST',
        headers: { 'content-type': b.content_type || 'application/json', 'user-agent': 'dian115-notify-bot/0.1' },
        body: Buffer.from(b.body_base64 || '', 'base64'),
        signal: AbortSignal.timeout(15000),
      }
      if (b.proxy) init.dispatcher = new ProxyAgent(b.proxy)
      const resp = await fetch(b.url, init)
      const buf = Buffer.from(await resp.arrayBuffer())
      log(`relay → ${host} via ${b.proxy || 'direct'}: ${resp.status}`)
      return jsonRes(res, 200, { status: resp.status, body_base64: buf.toString('base64') })
    }
    if (u.pathname === '/session/save' && req.method === 'POST') {
      const b = await readBody(req)
      if (!b.source || !b.cookies) return jsonRes(res, 400, { error: 'source + cookies required' })
      sessions[b.source] = { ...(sessions[b.source] || {}), ...b.cookies }
      saveSessions()
      return jsonRes(res, 200, { ok: true })
    }
    jsonRes(res, 404, { error: 'not found', endpoints: ['/health', '/search', '/qr/create', '/qr/poll', '/download', '/tasks'] })
  } catch (e) {
    jsonRes(res, 502, { error: e.message })
  }
})

// 启动: 搜索直连(国内), 下载 worker 继承进程环境
if (process.env.DOWNLOAD_PROXY) setGlobalDispatcher(new ProxyAgent(process.env.DOWNLOAD_PROXY))
fs.mkdirSync(CONFIG, { recursive: true })
server.listen(PORT, HOST, () => log(`music-agent ${HOST}:${PORT} | mount=${MUSIC_MOUNT} 存在=${fs.existsSync(MUSIC_MOUNT)} | 配置=${CONFIG}`))
