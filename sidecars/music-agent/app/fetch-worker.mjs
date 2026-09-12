// 音乐下载 worker: 每任务一个全新子进程
// 用法: node fetch-worker.mjs <task_json_file>
// task: {source, id, quality, name, singers, album, out_path, cookie, quality_ladder}
// 输出: 单行 JSON 结果到 stdout（进度行写 stderr）

import fs from 'node:fs'
import { ProxyAgent, setGlobalDispatcher } from 'undici'

const task = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
const PROXY = process.env.DOWNLOAD_PROXY || '' // 下载出站代理（可选）

if (PROXY) setGlobalDispatcher(new ProxyAgent(PROXY))

const progress = (pct, msg) => console.error(`PROGRESS ${pct} ${msg}`)
const emit = (obj) => { console.log(JSON.stringify(obj)); process.exit(0) }
const die = (msg) => emit({ ok: false, error: msg })

function cookieHeader(jar) {
  return Object.entries(jar || {}).map(([k, v]) => `${k}=${v}`).join('; ')
}

// ── 网易云 eapi 加密 ─────────────────────────────────────────
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

function md5hex(s) { return crypto.createHash('md5').update(s).digest('hex') }

function aesECB(data, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(true)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

function neteaseEapi(apiURL, payload, cookie) {
  const u = new URL(apiURL)
  const path = u.pathname.replace('/eapi/', '/api/')
  const pj = JSON.stringify(payload)
  const digest = md5hex(`nobody${path}use${pj}md5forencrypt`)
  const text = `${path}-36cd479b6b5-${pj}-36cd479b6b5-${digest}`
  const enc = aesECB(Buffer.from(text), Buffer.from('e82ckenh8dichen8'))
  return { params: hexEncode(enc), cookie }
}
function hexEncode(buf) { return buf.toString('hex') }

// ── 简易 HTTP 下载（跟随重定向, 流式写盘, 进度上报）──────────
function download(url, headers, outPath) {
  return new Promise((resolve, reject) => {
    const doReq = (u, redirects) => {
      const mod = u.startsWith('https') ? https : http
      const req = mod.get(u, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          res.resume()
          return doReq(res.headers.location, redirects + 1)
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`下载 HTTP ${res.statusCode}`))
        }
        const total = Number(res.headers['content-length']) || 0
        let done = 0
        const out = fs.createWriteStream(outPath)
        res.on('data', (c) => {
          done += c.length
          if (total) {
            const pct = Math.floor((done / total) * 100)
            if (pct !== progress.last || done === total) { progress.last = pct; progress(pct, `${fmtMB(done)}/${fmtMB(total)}`) }
          }
        })
        out.on('error', reject)
        res.pipe(out)
        out.on('finish', () => out.close(() => resolve({ size: done, total })))
      })
      req.on('error', reject)
    }
    progress.last = -1
    doReq(url, 0)
  })
}
function fmtMB(b) { return (b / 1048576).toFixed(1) + 'MB' }

async function neteaseURL(songID, level, cookie) {
  const api = 'https://interface3.music.163.com/eapi/song/enhance/player/url/v1'
  const { params } = neteaseEapi(api, {
    ids: [songID], level, encodeType: 'flac',
    header: JSON.stringify({ os: 'pc', appver: '', osver: '', deviceId: 'pyncm!' }),
  })
  const form = `params=${params}`
  const r = await fetch(api, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': UA, cookie,
    },
    body: form,
  })
  const j = await r.json()
  const d = (j.data || [])[0] || {}
  if (!d.url) throw new Error(`netease 未取到链接 (level=${level}, code=${j.code})`)
  return d
}

const neteaseLevels = ['jymaster', 'jyeffect', 'sky', 'hires', 'lossless', 'dolby', 'exhigh', 'standard']

const QQ_LADDER = [['AI00', 'flac'], ['Q001', 'flac'], ['Q000', 'flac'], ['F000', 'flac'], ['O801', 'ogg'], ['M800', 'mp3'], ['M500', 'mp3']]
async function qqURL(songmid, cookie, isVip, quality) {
  let ladder = QQ_LADDER
  if (!isVip) ladder = [['M800', 'mp3'], ['M500', 'mp3']]
  else if (quality) {
    const start = { master: 0, flac: 3, 320: 5, 128: 6 }[quality]
    if (start !== undefined) ladder = QQ_LADDER.slice(start)
  }
  const guid = String(Math.floor(Math.random() * 1e10))
  const filenames = ladder.map(([p, e]) => `${p}${songmid}${songmid}.${e}`)
  const uin = (cookie.match(/uin=([^;]+)/) || [])[1]?.replace(/^o0*/, '0') || '0'
  const body = {
    comm: { uin, format: 'json', ct: 20, cv: 0 },
    req_1: {
      module: 'music.vkey.GetVkey', method: 'UrlGetVkey',
      param: { guid, songmid: [songmid], songtype: [0], uin, loginflag: 1, platform: '20', filename: filenames },
    },
  }
  const r = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, referer: 'https://y.qq.com/', cookie },
    body: JSON.stringify(body),
  })
  const j = await r.json()
  const infos = j?.req_1?.data?.midurlinfo || []
  for (let i = 0; i < infos.length; i++) {
    if ((infos[i].purl || '').startsWith('http')) {
      return { url: infos[i].purl, ext: ladder[i][1] }
    }
  }
  throw new Error('QQ 所有音质均未取到链接（需要绿钻）')
}

async function kugouURL(hash, quality, cookie) {
  const st = task.kugou_state || {}
  const mid = st.mid, userid = st.userid, token = st.token
  if (!mid || !userid || !token) throw new Error('酷狗未登录（缺少 token/userid）')
  const clienttime = String(Math.floor(Date.now() / 1000))
  const dfid = st.dfid || '-'
  const params = {
    dfid, mid, uuid: '-', appid: '3116', clientver: '11440', clienttime,
    token, userid, album_id: '0', area_code: '1', hash,
    ssa_flag: 'is_fromtrack', version: '11436', page_id: '967177915',
    quality, album_audio_id: '0', behavior: 'play', pid: '411', cmd: '26',
    pidversion: '3001', cdnBackup: '1', kcard: '0', module: '',
  }
  params.key = md5hex(hash + '185672dd44712f60bb1736df5a377e82' + '3116' + mid + userid)
  const pairs = Object.entries(params).map(([k, v]) => `${k}=${v}`).sort()
  const sign = md5hex('LnT6xpN3khm36zse0QzvmgTZ3waWdRSA' + pairs.join('') + 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA')
  const qs = new URLSearchParams({ ...params, signature: sign }).toString()
  const r = await fetch(`https://gateway.kugou.com/v5/url?${qs}`, {
    headers: {
      'user-agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
      'x-router': 'trackercdn.kugou.com', dfid, clienttime, mid,
      'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': '1', cookie,
    },
  })
  const j = await r.json()
  const url = j?.data?.[0]?.url || j?.url
  if (!url) throw new Error(`酷狗未取到链接 (status=${j.status})`)
  return { url }
}

// ── 主流程 ───────────────────────────────────────────────────
async function main() {
  const { source, id, hash, quality, cookie, out_path } = task
  const sourceID = source === 'kugou' ? (hash || id) : id
  if (!sourceID) throw new Error(`缺少 ${source} 歌曲标识`)
  progress(1, '取链接')
  let dl = { url: '', ext: 'flac', actual: quality }
  if (source === 'netease') {
    // 从所 quality 向下逐级尝试
    const start = neteaseLevels.indexOf(quality) >= 0 ? neteaseLevels.indexOf(quality) : 0
    let lastErr = null
    for (const lv of neteaseLevels.slice(start)) {
      try { dl = { ...(await neteaseURL(sourceID, lv, cookie)), actual: lv }; break } catch (e) { lastErr = e }
    }
    if (!dl.url) throw lastErr || new Error('netease 未取到链接')
  } else if (source === 'qq') {
    const vip = Boolean(task.is_vip !== false)
    dl = { ...(await qqURL(sourceID, cookie, vip, task.quality)), actual: task.quality || '' }
  } else if (source === 'kugou') {
    dl = { ...(await kugouURL(sourceID, quality === 'flac' ? 'flac' : quality, cookie)), actual: quality }
  } else {
    die(`未知来源 ${source}`)
  }
  progress(3, `取到链接 (${dl.actual || '未知音质'})`)

  const headers = { 'user-agent': UA }
  if (source === 'netease') headers.cookie = cookie
  if (source === 'qq') { headers.referer = 'https://y.qq.com/'; headers.cookie = cookie }
  if (source === 'kugou') headers.cookie = cookie

  const dir = path.dirname(out_path)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = out_path + '.part'
  progress(5, '开始下载')
  const { size } = await download(dl.url, headers, tmp)
  fs.renameSync(tmp, out_path)
  progress(100, `完成 ${fmtMB(size)}`)
  emit({ ok: true, size, path: out_path, quality: dl.actual, url_host: new URL(dl.url).host })
}

import path from 'node:path'
main().catch((e) => die(e.message))
