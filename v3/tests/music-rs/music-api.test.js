// 网络层测试 —— 假 http 复刻宿主 ctx.http.request，验证请求形态与响应解析。
// （对照 plugins/music-rs/src/{netease,qq}.rs 的宿主替身集成测试移植。）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import {
  neteaseSearch, neteaseQrCreate, neteaseQrPoll, neteasePlaylists, neteasePlaylistSongs,
  neteaseSongUrl, qqSearch, qqSongUrl, resolveSongUrl, loadCookies, saveCookies,
  qqQrCreate, qqQrPoll, NETEASE_LOGIN_SESSION, QQ_LOGIN_SESSION, QQ_MUSICU_SESSION,
  qqPlaylists, qqPlaylistSongs, qqPlaylistSongsPage, qqDailyRecommendations, qqLikedSongs, qqRpc,
  qqLibraryInfo,
} from '../../music-rs/lib/music-api.js'
import { SEARCH_URL, SONG_URL_API, QR_UNIKEY_URL, QR_LOGIN_URL, PLAYLIST_DETAIL_URL, SONG_DETAIL_URL, CHROME_UA } from '../../music-rs/lib/eapi.js'
import {
  QQ_SEARCH_API, QQ_MUSICU, CHROME_UA as QQ_UA, QQ_API_UA, QQ_STREAM_FALLBACK_DOMAIN,
  hash33Seed, QQ_QR_TTL_SECS,
} from '../../music-rs/lib/qq.js'
import { cryptoAdapter } from '../../music-rs/jobs/runtime.js'
import { createKv } from '../../music-rs/lib/kv.js'
import { neteaseCookieHeader, qqCookieHeader } from '../../music-rs/lib/cookies.js'

function fakeHttp(routes) {
  const calls = []
  return {
    calls,
    async request(options) {
      calls.push(options)
      for (const route of routes) {
        const hit = route(options)
        if (hit) {
          return {
            status: hit.status ?? 200,
            url: hit.url ?? options.url,
            headers: hit.headers ?? {},
            body: hit.body ?? '',
            body_base64: hit.body_base64 ?? '',
            cached: false,
          }
        }
      }
      throw new Error(`unexpected request: ${options.method} ${options.url}`)
    },
  }
}

/** 假宿主的 session Cookie jar：session → (name → cookie)；cookies() 按域名过滤，
 *  importCookies({replace:true}) 整段清空（与宿主 network.md:24 的语义一致）。 */
function fakeSessions() {
  const jars = new Map()
  const jarOf = (session) => {
    const key = String(session ?? '')
    if (!jars.has(key)) jars.set(key, new Map())
    return jars.get(key)
  }
  return {
    jars,
    set(session, name, value, domain) {
      jarOf(session).set(name, { name, value, domain, path: '/' })
    },
    async cookies({ url, session }) {
      const host = new URL(url).hostname
      const out = []
      for (const cookie of jarOf(session).values()) {
        const domain = String(cookie.domain ?? '').replace(/^\./, '')
        if (host === domain || host.endsWith(`.${domain}`)) out.push({ ...cookie })
      }
      return out
    },
    async importCookies({ session, cookies, replace }) {
      if (replace) jars.set(String(session ?? ''), new Map())
      const jar = jarOf(session)
      for (const cookie of cookies ?? []) jar.set(cookie.name, { ...cookie })
      return { ok: true }
    },
  }
}

/**
 * 假宿主（会跟随重定向的形态）：follow_redirects 不是 false 时自动跟 Location，
 * 并把**真正请求过**的每个 URL 记进 requested。
 *
 * 宿主默认跟随（network.md:13「follow_redirects:false 返回原始 3xx，max_redirects 默认 10」），
 * 所以「白名单外的目标一个请求都不该发出」只能在这种假宿主上验证。
 */
function followHttp(routes) {
  const requested = []
  const calls = []
  async function once(options) {
    requested.push(options.url)
    calls.push(options)
    for (const route of routes) {
      const hit = route(options)
      if (!hit) continue
      const response = {
        status: hit.status ?? 200,
        url: hit.url ?? options.url,
        headers: hit.headers ?? {},
        body: hit.body ?? '',
        body_base64: hit.body_base64 ?? '',
        cached: false,
      }
      const location = headerValue(response.headers, 'location')
      if (options.follow_redirects !== false && response.status >= 300 && response.status < 400 && location) {
        return once({ ...options, url: location, method: 'GET' })
      }
      return response
    }
    throw new Error(`unexpected request: ${options.method} ${options.url}`)
  }
  return { requested, calls, async request(options) { return once(options) } }
}

/** 响应头取值（宿主给的是字符串数组，测试里也用字符串）。 */
function headerValue(headers, name) {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== name) continue
    return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')
  }
  return ''
}

function host(http, kvStore = new Map(), sessions = fakeSessions()) {
  const ctx = {
    id: 'music.rs',
    http: {
      request: http.request ? http.request.bind(http) : http,
      cookies: sessions.cookies,
      importCookies: sessions.importCookies,
    },
    // 假宿主的 crypto 与宿主同形（md5/aesEncrypt），经 cryptoAdapter 适配成 lib 期待形态。
    crypto: {
      md5: (data, output) => createHash('md5').update(data).digest(output),
      aesEncrypt: ({ key, data, padding, output }) => {
        const cipher = createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null)
        return Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]).toString('hex')
      },
    },
    api: {
      async get(path) {
        const key = decodeURIComponent(path.replace(/^\/api\/extensions\/v3\/music\.rs\/storage\//, ''))
        const hit = kvStore.get(key)
        if (!hit) throw Object.assign(new Error('not found'), { status: 404 })
        return { value: JSON.parse(JSON.stringify(hit.value)), revision: hit.revision }
      },
    },
    storage: {
      async get(key) {
        const hit = kvStore.get(key)
        if (!hit) throw Object.assign(new Error('not found'), { status: 404 })
        return JSON.parse(JSON.stringify(hit.value))
      },
      async set(key, value, expectedRevision) {
        const hit = kvStore.get(key)
        if (expectedRevision !== undefined) {
          const current = hit ? hit.revision : 0
          if (current !== expectedRevision) throw Object.assign(new Error('conflict'), { status: 412 })
        }
        kvStore.set(key, { value: JSON.parse(JSON.stringify(value)), revision: (hit?.revision ?? 0) + 1 })
        return { revision: (hit?.revision ?? 0) + 1 }
      },
      async remove(key) { kvStore.delete(key) },
    },
  }
  return { http: ctx.http, kv: createKv(ctx), crypto: cryptoAdapter(ctx.crypto), sessions }
}

test('neteaseSearch posts the Go form with IP headers', async () => {
  const http = fakeHttp([
    (options) => (options.url === SEARCH_URL ? { body: JSON.stringify({ result: { songs: [{ id: 1, name: '晴天', ar: [{ name: '周杰伦' }], al: { name: '叶惠美', picUrl: 'https://x/y.jpg' }, dt: 269413 }], songCount: 42 } }) } : null),
  ])
  const deps = host(http)
  const result = await neteaseSearch(deps, '晴天', 2)
  assert.equal(result.total, 42)
  assert.equal(result.songs[0].id, 1)
  assert.equal(result.songs[0].singers, '周杰伦')
  const request = http.calls[0]
  assert.equal(request.method, 'POST')
  assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded')
  assert.equal(request.headers.referer, 'https://music.163.com/')
  assert.ok(request.headers['x-real-ip'], '网易云风控需要国内 IP 头')
  // offset = (2-1)*30，键序按 Go url.Values.Encode。
  assert.equal(request.body, 'limit=30&offset=30&s=%E6%99%B4%E5%A4%A9&type=1')
})

test('neteaseSongUrl walks the level ladder until a http link appears', async () => {
  const bodies = [
    '{"data":[]}', // jymaster：无 data
    '{"data":[{"url":""}]}', // jyeffect：空 url
    'not json', // sky：解析失败 → 下一档
    '{"data":[{"url":"https://cdn.example.com/h.flac","type":"flac","level":"hires","size":99}]}', // hires：命中
  ]
  const http = fakeHttp([
    (options) => (options.url === SONG_URL_API ? { body: bodies[Math.min(http.calls.filter((c) => c.url === SONG_URL_API).length - 1, bodies.length - 1)] } : null),
  ])
  const deps = host(http)
  const song = await neteaseSongUrl(deps, '186016', 'hires')
  assert.equal(song.url, 'https://cdn.example.com/h.flac')
  assert.equal(song.ext, 'flac')
  assert.equal(song.level, 'hires')
  assert.equal(song.size, 99)
  // 只发 4 档（hires 命中即停）；cookie 头带固定前缀。
  assert.equal(http.calls.filter((c) => c.url === SONG_URL_API).length, 4)
  assert.match(http.calls[0].headers.cookie, /^os=pc; appver=; osver=; deviceId=pyncm!/)
})

test('neteaseSongUrl reports the last response tail when every level fails', async () => {
  const http = fakeHttp([
    (options) => (options.url === SONG_URL_API ? { body: '{"data":[]}' } : null),
  ])
  const deps = host(http)
  await assert.rejects(neteaseSongUrl(deps, '1', ''), /所有音质均未获取到链接（需要 SVIP 且歌曲有对应音源）; 最后响应: \{"data":\[\]\}/)
  assert.equal(http.calls.filter((c) => c.url === SONG_URL_API).length, 8, '未命中档位 → 全阶梯 8 档')
})

test('netease QR create/poll flow saves cookies on 803', async () => {
  const http = fakeHttp([
    (options) => {
      if (options.url === QR_UNIKEY_URL) return { body: JSON.stringify({ code: 200, unikey: 'UNI-KEY' }) }
      if (options.url === QR_LOGIN_URL) {
        return {
          body: JSON.stringify({ code: 803, message: '登录成功', cookie: 'MUSIC_U=TOKEN; __csrf_token=CSRF' }),
          headers: { 'set-cookie': ['NMTID=n1; Path=/'] },
        }
      }
      return null
    },
  ])
  const deps = host(http)
  const created = await neteaseQrCreate(deps)
  assert.equal(created.key, 'UNI-KEY')
  assert.equal(created.qr_content, 'https://music.163.com/login?codekey=UNI-KEY')
  const polled = await neteaseQrPoll(deps, created.key)
  assert.equal(polled.status, 'success')
  assert.equal(polled.logged_in, true)
  const jar = await loadCookies(deps.kv, 'netease')
  assert.equal(jar.MUSIC_U, 'TOKEN')
  assert.equal(jar.NMTID, 'n1', 'set-cookie 兜底也收集')
  // 失败形态：code 非 200。
  const badHttp = fakeHttp([(options) => (options.url === QR_UNIKEY_URL ? { body: '{"code":400}' } : null)])
  await assert.rejects(neteaseQrCreate(host(badHttp)), /获取二维码失败/)
})

test('neteaseQrPoll without cookies guides to manual paste (never saves empty jar)', async () => {
  const http = fakeHttp([
    (options) => (options.url === QR_LOGIN_URL ? { body: '{"code":803,"message":"ok"}' } : null),
  ])
  const deps = host(http)
  const polled = await neteaseQrPoll(deps, 'K')
  assert.equal(polled.logged_in, false)
  assert.match(polled.message, /手动粘贴 Cookie/)
  const jar = await loadCookies(deps.kv, 'netease')
  assert.deepEqual(jar, {})
})

test('neteasePlaylists pages user/playlist with uid from account', async () => {
  const http = fakeHttp([
    (options) => {
      if (options.url === 'https://music.163.com/api/nuser/account/get') {
        return { body: JSON.stringify({ profile: { userId: 42, nickname: 'nick' } }) }
      }
      if (options.url?.startsWith('https://music.163.com/api/user/playlist')) {
        const offset = Number(new URL(options.url).searchParams.get('offset'))
        return { body: JSON.stringify({ playlist: offset === 0
          ? [{ id: 1, name: '我喜欢的音乐', coverImgUrl: 'c1', trackCount: 10, creator: { nickname: '' } }, { id: 2, name: '歌单二', coverImgUrl: 'c2', trackCount: 3 }]
          : [] }) }
      }
      return null
    },
  ])
  const deps = host(http)
  const result = await neteasePlaylists(deps)
  assert.equal(result.count, 2)
  assert.equal(result.playlists[0].id, '1', 'id 是字符串（sidecar 语义）')
  assert.equal(result.playlists[0].creator, 'nick', '创建者缺失回退登录昵称')
  assert.equal(http.calls.filter((c) => c.url?.includes('/api/user/playlist')).length, 1, '不足 100 条提前停')
})

test('neteasePlaylistSongs fetches v6 once and slices locally (1×v6 + page v3)', async () => {
  const http = fakeHttp([
    (options) => {
      if (options.url?.startsWith(PLAYLIST_DETAIL_URL)) {
        return { body: JSON.stringify({ playlist: { name: '大歌单', trackCount: 250, trackIds: Array.from({ length: 250 }, (_, id) => ({ id: id + 1 })) } }) }
      }
      if (options.url === SONG_DETAIL_URL) {
        const ids = /\[([\d,]+)\]/.exec(options.body)[1].split(',').map(Number)
        return { body: JSON.stringify({ songs: ids.map((id) => ({ id, name: `歌${id}` })) }) }
      }
      return null
    },
  ])
  const deps = host(http)
  const page = await neteasePlaylistSongs(deps, '42', 3, 100)
  assert.equal(page.name, '大歌单')
  assert.equal(page.total, 250)
  assert.equal(page.page, 3)
  assert.equal(page.page_size, 100)
  assert.equal(page.songs.length, 50, '第 3 页只覆盖到 250 首（201..250）')
  assert.equal(page.songs[0].id, '201')
  assert.equal(http.calls.filter((c) => c.url?.startsWith(PLAYLIST_DETAIL_URL)).length, 1, 'v6 全量索引只请求一次')
  assert.equal(http.calls.filter((c) => c.url === SONG_DETAIL_URL).length, 1, '每页一次 v3')
})

test('qqSearch sends the exact query and parses songs', async () => {
  const http = fakeHttp([
    (options) => (options.url?.startsWith(QQ_SEARCH_API) ? { body: '{"code":0,"data":{"song":{"list":[{"songmid":"M1","songname":"歌","albumname":"专辑","interval":200,"sizeflac":1,"size320":2,"size128":3,"singer":[{"name":"A"}]}]}}}' } : null),
  ])
  const deps = host(http)
  const result = await qqSearch(deps, '晴天', 1)
  assert.equal(result.songs[0].id, 'M1')
  const request = http.calls[0]
  assert.equal(request.url, `${QQ_SEARCH_API}?format=json&n=20&p=1&w=%E6%99%B4%E5%A4%A9`)
  assert.equal(request.headers['user-agent'], QQ_UA)
  assert.equal(request.headers.referer, 'https://y.qq.com/')
  assert.equal(request.headers.cookie, '', '空 jar → 空 cookie 头')
})

test('qqSongUrl reads media_mid then requests the vkey ladder quality by quality', async () => {
  const http = fakeHttp([
    (options) => (options.url === QQ_MUSICU && String(options.body).includes('music.pf_song_detail_svr')
      ? { body: '{"req_0":{"data":{"track_info":{"mid":"MID","file":{"media_mid":"MEDIA","size_flac":11,"size_320mp3":22,"size_128mp3":33}}}}}' }
      : null),
    (options) => (options.url === QQ_MUSICU
      ? { body: '{"req_0":{"data":{"sip":["http://isure.stream.qqmusic.qq.com/"],"midurlinfo":[{"songmid":"MID","purl":"M800MIDMEDIA.mp3?vkey=9"}]}}}' }
      : null),
  ])
  const deps = host(http)
  await saveCookies(deps.kv, 'qq', { uin: 'o0012345678', qqmusic_key: '@K' })
  const song = await qqSongUrl(deps, 'MID', '320')
  assert.equal(song.url, 'http://isure.stream.qqmusic.qq.com/M800MIDMEDIA.mp3?vkey=9', '相对 purl 拼 sip 域名')
  assert.equal(song.level, 'M800')
  assert.equal(song.ext, 'mp3')
  assert.equal(song.size, 22, 'size 取详情中对应档位')

  assert.equal(http.calls.length, 2, '一次详情 + 一次 vkey（M800 命中即停）')
  const [detailRequest, vkeyRequest] = http.calls
  assert.match(detailRequest.body, /"module":"music\.pf_song_detail_svr"/)
  assert.equal(detailRequest.headers['user-agent'], QQ_API_UA)
  const body = JSON.parse(vkeyRequest.body)
  assert.deepEqual(body.req_0.param.filename, ['M800MIDMEDIA.mp3'], '文件名用 media_mid，一次只请求一档')
  assert.equal(body.comm.authst, '@K')
  assert.equal(body.comm.qq, '012345678', 'uin 去 o/0 前缀（o0012345678 → 012345678）')
  assert.equal(vkeyRequest.headers.cookie, qqCookieHeader({ uin: 'o0012345678', qqmusic_key: '@K' }))
})

test('qqSongUrl requests only 128k anonymously and sends no cookie', async () => {
  const http = fakeHttp([
    (options) => (options.url === QQ_MUSICU && String(options.body).includes('music.pf_song_detail_svr')
      ? { body: '{"req_0":{"data":{}}}' }
      : null),
    (options) => (options.url === QQ_MUSICU
      ? { body: '{"req_0":{"data":{"midurlinfo":[{"songmid":"MID","purl":"M500MIDMID.mp3"}]}}}' }
      : null),
  ])
  const deps = host(http)
  const song = await qqSongUrl(deps, 'MID', 'master')
  assert.equal(song.url, `${QQ_STREAM_FALLBACK_DOMAIN}M500MIDMID.mp3`)
  assert.equal(song.level, 'M500')
  const body = JSON.parse(http.calls[1].body)
  assert.equal(body.req_0.module, 'vkey.GetVkeyServer')
  assert.equal(body.req_0.method, 'CgiGetVkey')
  assert.equal(body.req_0.param.uin, '0')
  assert.equal(http.calls[1].headers.cookie, undefined, '匿名请求不带 cookie')
})

test('resolveSongUrl dispatches by source', async () => {
  const http = fakeHttp([
    (options) => (options.url === SONG_URL_API ? { body: '{"data":[{"url":"https://n.flac","type":"flac","level":"lossless"}]}' } : null),
    (options) => (options.url === QQ_MUSICU ? { body: '{"req_0":{"data":{"midurlinfo":[{"purl":"https://q.mp3"}]}}}' } : null),
  ])
  const deps = host(http)
  const netease = await resolveSongUrl(deps, 'netease', '1', 'lossless')
  assert.equal(netease.url, 'https://n.flac')
  const qq = await resolveSongUrl(deps, 'qq', '1', '')
  assert.equal(qq.url, 'https://q.mp3')
  await assert.rejects(resolveSongUrl(deps, 'xiami', '1', ''), /未知音乐源: xiami/)
})

test('cookie jars persist through the kv adapter', async () => {
  const http = fakeHttp([])
  const deps = host(http)
  await saveCookies(deps.kv, 'netease', { MUSIC_U: 'u' })
  const jar = await loadCookies(deps.kv, 'netease')
  assert.equal(jar.MUSIC_U, 'u')
  assert.equal(neteaseCookieHeader(jar), 'os=pc; appver=; osver=; deviceId=pyncm!; MUSIC_U=u')
})
void CHROME_UA

// ─────────────────── QQ 扫码登录（宿主 session + 假 ctx 集成）───────────────────

/** 假 PNG（只需要 magic 对）。 */
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]).toString('base64')
const QRSIG = 'fake-qrsig-value_01'
const PSKEY = 'fake-pskey'
const OAUTH_CODE = 'ABCDEF0123456789ABCDEF0123456789'

/** QQ 扫码全链路路由（可覆盖轮询 / 授权 / 换凭据的行为）。 */
function qqRoutes(sessions, overrides = {}) {
  return [
    (options) => {
      if (!options.url.startsWith('https://xui.ptlogin2.qq.com/ssl/ptqrshow')) return null
      sessions.set(QQ_LOGIN_SESSION, 'qrsig', QRSIG, 'ptlogin2.qq.com')
      return { body_base64: FAKE_PNG }
    },
    (options) => {
      if (!options.url.startsWith('https://xui.ptlogin2.qq.com/ssl/ptqrlogin')) return null
      if (overrides.poll) return overrides.poll(options)
      return { body: "ptuiCB('66','0','','0','二维码未失效。','')" }
    },
    (options) => {
      if (!options.url.startsWith('https://ssl.ptlogin2.graph.qq.com/check_sig')) return null
      if (overrides.checkSig) return overrides.checkSig(options)
      sessions.set(QQ_LOGIN_SESSION, 'p_uin', 'o0010001', 'graph.qq.com')
      sessions.set(QQ_LOGIN_SESSION, 'p_skey', PSKEY, 'graph.qq.com')
      sessions.set(QQ_LOGIN_SESSION, 'pt_oauth_token', 'fake-oauth', 'graph.qq.com')
      return {
        status: 302,
        url: 'https://graph.qq.com/oauth2.0/login_jump',
        headers: { location: 'https://graph.qq.com/oauth2.0/login_jump' },
      }
    },
    (options) => {
      if (!options.url.startsWith('https://graph.qq.com/oauth2.0/login_jump')) return null
      if (overrides.loginJump) return overrides.loginJump(options)
      return { status: 200, body: 'login_jump ok' }
    },
    (options) => {
      if (options.url !== 'https://graph.qq.com/oauth2.0/authorize') return null
      if (overrides.authorize) return overrides.authorize(options)
      const state = new URLSearchParams(options.body).get('state')
      return {
        status: 302,
        headers: { location: `https://y.qq.com/portal/wx_redirect.html?code=${OAUTH_CODE}&state=${state}` },
      }
    },
    (options) => {
      if (options.url !== QQ_MUSICU) return null
      if (overrides.musicu) return overrides.musicu(options)
      return {
        body: '{"code":0,"req":{"code":0,"data":{"musicid":10001,"musickey":"fake-musickey","loginType":2,"nick":"Listener"}}}',
      }
    },
  ]
}

test('qqQrCreate returns the PNG data URL and an opaque key (no cookie value in the return)', async () => {
  const sessions = fakeSessions()
  const http = fakeHttp(qqRoutes(sessions))
  const deps = host(http, new Map(), sessions)
  const created = await qqQrCreate(deps)
  assert.equal(created.expires_in, QQ_QR_TTL_SECS)
  assert.equal(created.image, `data:image/png;base64,${FAKE_PNG}`)
  assert.match(created.key, /^[0-9a-f]{32}$/)
  assert.ok(!JSON.stringify(created).includes(QRSIG), '返回值里没有 qrsig')
  const request = http.calls[0]
  assert.ok(request.url.startsWith('https://xui.ptlogin2.qq.com/ssl/ptqrshow?'))
  assert.ok(request.url.includes('u1=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump'))
  assert.equal(request.session, QQ_LOGIN_SESSION)
  assert.equal(request.response_type, 'base64')
})

test('qqQrCreate fails clearly when QQ issues no signature or a broken image', async () => {
  const noSig = fakeSessions()
  const noSigHttp = fakeHttp([
    (options) => (options.url.startsWith('https://xui.ptlogin2.qq.com/ssl/ptqrshow') ? { body_base64: FAKE_PNG } : null),
  ])
  await assert.rejects(qqQrCreate(host(noSigHttp, new Map(), noSig)), /QQ 未返回二维码签名/)

  const broken = fakeSessions()
  const brokenHttp = fakeHttp([
    (options) => {
      if (!options.url.startsWith('https://xui.ptlogin2.qq.com/ssl/ptqrshow')) return null
      broken.set(QQ_LOGIN_SESSION, 'qrsig', QRSIG, 'ptlogin2.qq.com')
      return { body_base64: Buffer.from('not a png').toString('base64') }
    },
  ])
  await assert.rejects(qqQrCreate(host(brokenHttp, new Map(), broken)), /Q202/)
})

test('qqQrPoll maps the ptuiCB states and carries the qr signature', async () => {
  const cases = [
    ["ptuiCB('66','0','','0','x','')", 'waiting'],
    ["ptuiCB('67','0','','0','x','')", 'scanned'],
    ["ptuiCB('65','0','','0','x','')", 'expired'],
  ]
  for (const [body, status] of cases) {
    const sessions = fakeSessions()
    const http = fakeHttp(qqRoutes(sessions, { poll: () => ({ body }) }))
    const deps = host(http, new Map(), sessions)
    const created = await qqQrCreate(deps)
    const polled = await qqQrPoll(deps, created.key)
    assert.equal(polled.status, status)
    assert.equal(polled.logged_in, false)
    const pollCall = http.calls[1]
    assert.equal(pollCall.headers.cookie, `qrsig=${QRSIG}`)
    assert.ok(pollCall.url.includes(`ptqrtoken=${hash33Seed(QRSIG, 0)}`), 'ptqrtoken = hash33(qrsig)')
    assert.equal(pollCall.session, QQ_LOGIN_SESSION)
  }
})

test('qqQrPoll rejects an unrecognizable status instead of waiting forever', async () => {
  const sessions = fakeSessions()
  const http = fakeHttp(qqRoutes(sessions, { poll: () => ({ body: '' }) }))
  const deps = host(http, new Map(), sessions)
  const created = await qqQrCreate(deps)
  await assert.rejects(qqQrPoll(deps, created.key), /无法识别的扫码状态/)
  const injected = fakeSessions()
  const injectedHttp = fakeHttp(qqRoutes(injected, { poll: () => ({ body: "ptuiCB('66','0','','0','x','');alert(1)" }) }))
  const injectedDeps = host(injectedHttp, new Map(), injected)
  const injectedQr = await qqQrCreate(injectedDeps)
  await assert.rejects(qqQrPoll(injectedDeps, injectedQr.key), /无法识别的扫码状态/)
})

test('qqQrPoll completes the OAuth exchange and stores only the QQ Music credential', async () => {
  const sessions = fakeSessions()
  const http = fakeHttp(qqRoutes(sessions, {
    poll: () => ({ body: "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?ptsigx=fake','0','ok','nick')" }),
  }))
  const deps = host(http, new Map(), sessions)
  const created = await qqQrCreate(deps)
  const polled = await qqQrPoll(deps, created.key)
  assert.equal(polled.status, 'success')
  assert.equal(polled.logged_in, true)

  const jar = await loadCookies(deps.kv, 'qq')
  assert.equal(jar.uin, '10001')
  assert.equal(jar.qqmusic_uin, '10001')
  assert.equal(jar.qqmusic_key, 'fake-musickey')
  assert.equal(jar.qm_keyst, 'fake-musickey')
  assert.equal(jar.tmeLoginType, '2')
  assert.ok(!('p_skey' in jar), 'graph.qq.com 的全局授权 Cookie 不进 KV')
  assert.ok(!('pt_oauth_token' in jar))
  assert.ok(!('qrsig' in jar))

  const checkSigCall = http.calls.find((call) => call.url.startsWith('https://ssl.ptlogin2.graph.qq.com/check_sig'))
  assert.ok(checkSigCall, '先过 check_sig')
  const authorizeCall = http.calls.find((call) => call.url === 'https://graph.qq.com/oauth2.0/authorize')
  assert.equal(authorizeCall.method, 'POST')
  assert.equal(authorizeCall.follow_redirects, false, 'authorize 拿原始 302')
  assert.match(authorizeCall.headers.cookie, /p_skey=fake-pskey/)
  const form = new URLSearchParams(authorizeCall.body)
  assert.equal(form.get('g_tk'), String(hash33Seed(PSKEY, 5381)))
  assert.match(form.get('state'), /^[0-9a-f]{32}$/)
  assert.equal(form.get('client_id'), '100497308')

  const musicuCall = http.calls.find((call) => call.url === QQ_MUSICU)
  assert.equal(musicuCall.headers.cookie, undefined, 'musicu 请求不带任何 Cookie')
  assert.equal(musicuCall.session, QQ_MUSICU_SESSION)
  assert.notEqual(musicuCall.session, QQ_LOGIN_SESSION, '换凭据用独立 session')
  const musicuBody = JSON.parse(musicuCall.body)
  assert.equal(musicuBody.req.module, 'QQConnectLogin.LoginServer')
  assert.equal(musicuBody.req.method, 'QQLogin')
  assert.equal(musicuBody.req.param.code, OAUTH_CODE)

  const left = await sessions.cookies({ url: 'https://graph.qq.com', session: QQ_LOGIN_SESSION })
  assert.deepEqual(left, [], '成功后清掉宿主 session 里的授权 Cookie')
})

test('qqQrPoll refuses a mismatched OAuth state and leaks no credential in the error', async () => {
  const sessions = fakeSessions()
  const http = fakeHttp(qqRoutes(sessions, {
    poll: () => ({ body: "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?ptsigx=fake','0','ok','nick')" }),
    authorize: () => ({
      status: 302,
      headers: { location: `https://y.qq.com/portal/wx_redirect.html?code=${OAUTH_CODE}&state=wrong` },
    }),
  }))
  const deps = host(http, new Map(), sessions)
  const created = await qqQrCreate(deps)
  const failure = await qqQrPoll(deps, created.key).then(() => null, (error) => error)
  assert.ok(failure, 'state 不匹配必须报错')
  assert.match(failure.message, /state\/code 校验失败/)
  for (const secret of [PSKEY, 'fake-oauth', OAUTH_CODE, QRSIG]) {
    assert.ok(!failure.message.includes(secret), `错误消息里不能出现凭据：${secret}`)
  }
  assert.deepEqual(await loadCookies(deps.kv, 'qq'), {}, '失败不写半个 jar')
  assert.ok(!http.calls.some((call) => call.url === QQ_MUSICU), '校验不过就不换凭据')
})

test('qqQrPoll refuses an incomplete QQ authorization cookie set', async () => {
  const sessions = fakeSessions()
  const http = fakeHttp(qqRoutes(sessions, {
    poll: () => ({ body: "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?ptsigx=fake','0','ok','nick')" }),
    checkSig: () => ({
      status: 302,
      url: 'https://graph.qq.com/oauth2.0/login_jump',
      headers: { location: 'https://graph.qq.com/oauth2.0/login_jump' },
    }),
  }))
  const deps = host(http, new Map(), sessions)
  const created = await qqQrCreate(deps)
  await assert.rejects(qqQrPoll(deps, created.key), /QQ 授权 Cookie 不完整/)
  assert.deepEqual(await loadCookies(deps.kv, 'qq'), {})
})

test('qqQrPoll refuses a check_sig target outside the whitelist', async () => {
  const sessions = fakeSessions()
  const http = fakeHttp(qqRoutes(sessions, {
    poll: () => ({ body: "ptuiCB('0','0','https://evil.test/check_sig','0','ok','nick')" }),
  }))
  const deps = host(http, new Map(), sessions)
  const created = await qqQrCreate(deps)
  await assert.rejects(qqQrPoll(deps, created.key), /QQ 授权跳转目标异常/)
  assert.ok(!http.calls.some((call) => call.url.startsWith('https://evil.test')), '白名单外的目标根本不发请求')
})

test('netease QR runs in a host session and takes MUSIC_U from the session jar', async () => {
  const sessions = fakeSessions()
  const http = fakeHttp([
    (options) => {
      if (options.url === QR_UNIKEY_URL) {
        sessions.set(NETEASE_LOGIN_SESSION, 'MUSIC_U', 'host-session-music-u', '.music.163.com')
        return { body: JSON.stringify({ code: 200, unikey: 'UNI-KEY' }) }
      }
      if (options.url === QR_LOGIN_URL) return { body: JSON.stringify({ code: 803, message: 'ok' }) }
      return null
    },
  ])
  const deps = host(http, new Map(), sessions)
  const created = await neteaseQrCreate(deps)
  assert.equal(created.key, 'UNI-KEY')
  assert.equal(http.calls[0].session, NETEASE_LOGIN_SESSION)
  const polled = await neteaseQrPoll(deps, created.key)
  assert.equal(polled.status, 'success')
  assert.equal(polled.logged_in, true)
  assert.equal(http.calls[1].session, NETEASE_LOGIN_SESSION)
  const jar = await loadCookies(deps.kv, 'netease')
  assert.equal(jar.MUSIC_U, 'host-session-music-u')
})

test('qqQrPoll never lets the host follow a check_sig redirect outside the whitelist', async () => {
  const sessions = fakeSessions()
  const http = followHttp([
    (options) => {
      if (!options.url.startsWith('https://xui.ptlogin2.qq.com/ssl/ptqrshow')) return null
      sessions.set(QQ_LOGIN_SESSION, 'qrsig', QRSIG, 'ptlogin2.qq.com')
      return { body_base64: FAKE_PNG }
    },
    (options) => (options.url.startsWith('https://xui.ptlogin2.qq.com/ssl/ptqrlogin')
      ? { body: "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?ptsigx=fake','0','ok','nick')" }
      : null),
    (options) => (options.url.startsWith('https://ssl.ptlogin2.graph.qq.com/check_sig')
      ? { status: 302, headers: { location: 'https://evil.test/steal' } }
      : null),
  ])
  const deps = host(http, new Map(), sessions)
  const created = await qqQrCreate(deps)
  await assert.rejects(qqQrPoll(deps, created.key), /QQ 授权跳转目标异常/)
  assert.ok(
    !http.requested.some((url) => url.startsWith('https://evil.test')),
    '白名单外的目标一个请求都不该发出（宿主自动跟随也不能替我们跳过去）',
  )
  const checkSig = http.calls.find((call) => call.url.startsWith('https://ssl.ptlogin2.graph.qq.com/check_sig'))
  assert.equal(checkSig.follow_redirects, false, 'check_sig 必须关掉自动重定向')
})

test('qqQrPoll only talks to whitelisted hosts on a redirect-following host', async () => {
  const sessions = fakeSessions()
  const http = followHttp(qqRoutes(sessions, {
    poll: () => ({ body: "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?ptsigx=fake','0','ok','nick')" }),
  }))
  const deps = host(http, new Map(), sessions)
  const created = await qqQrCreate(deps)
  const polled = await qqQrPoll(deps, created.key)
  assert.equal(polled.logged_in, true)
  const allowed = ['xui.ptlogin2.qq.com', 'ssl.ptlogin2.graph.qq.com', 'graph.qq.com', 'u.y.qq.com']
  for (const url of http.requested) {
    const host = new URL(url).hostname
    assert.ok(allowed.includes(host), `请求落在白名单外的站点：${url}`)
  }
  const loginJump = http.calls.filter((call) => call.url.startsWith('https://graph.qq.com/oauth2.0/login_jump'))
  assert.equal(loginJump.length, 1, 'login_jump 显式请求一次')
  assert.equal(loginJump[0].follow_redirects, false, 'login_jump 也不自动跟随')
})

test('qqQrPoll takes the authorization cookies from the check_sig response itself', async () => {
  const sessions = fakeSessions()
  const http = fakeHttp(qqRoutes(sessions, {
    poll: () => ({ body: "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?ptsigx=fake','0','ok','nick')" }),
    checkSig: () => ({
      status: 302,
      headers: {
        location: 'https://graph.qq.com/oauth2.0/login_jump',
        'set-cookie': [
          'p_uin=o0010001; Domain=graph.qq.com; Path=/',
          `p_skey=${PSKEY}; Domain=graph.qq.com; Path=/`,
          'pt_oauth_token=fake-oauth; Domain=graph.qq.com; Path=/',
        ],
      },
    }),
  }))
  const deps = host(http, new Map(), sessions)
  const created = await qqQrCreate(deps)
  const polled = await qqQrPoll(deps, created.key)
  assert.equal(polled.logged_in, true)
  const authorizeCall = http.calls.find((call) => call.url === 'https://graph.qq.com/oauth2.0/authorize')
  assert.match(authorizeCall.headers.cookie, new RegExp(`p_skey=${PSKEY}`))
})

test('qqQrPoll refuses an authorization cookie that only exists on a wider domain', async () => {
  const sessions = fakeSessions()
  const http = fakeHttp(qqRoutes(sessions, {
    poll: () => ({ body: "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?ptsigx=fake','0','ok','nick')" }),
    checkSig: () => ({
      status: 302,
      headers: { location: 'https://graph.qq.com/oauth2.0/login_jump' },
    }),
  }))
  // 只有更宽的域（.qq.com）里的同名 Cookie —— 不是这次的授权凭据，不作数。
  sessions.set(QQ_LOGIN_SESSION, 'p_uin', 'o0010001', '.qq.com')
  sessions.set(QQ_LOGIN_SESSION, 'p_skey', PSKEY, '.qq.com')
  sessions.set(QQ_LOGIN_SESSION, 'pt_oauth_token', 'fake-oauth', '.qq.com')
  const deps = host(http, new Map(), sessions)
  const created = await qqQrCreate(deps)
  await assert.rejects(qqQrPoll(deps, created.key), /QQ 授权 Cookie 不完整/)
  assert.ok(!http.calls.some((call) => call.url === 'https://graph.qq.com/oauth2.0/authorize'), '校验不过就不换 code')
  assert.deepEqual(await loadCookies(deps.kv, 'qq'), {}, '失败不写半个 jar')
})

test('qqQrPoll does not resend the authorize POST when the host hides the location header', async () => {
  const sessions = fakeSessions()
  const http = fakeHttp(qqRoutes(sessions, {
    poll: () => ({ body: "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?ptsigx=fake','0','ok','nick')" }),
    authorize: () => ({ status: 200, body: 'no location header' }),
  }))
  const deps = host(http, new Map(), sessions)
  const created = await qqQrCreate(deps)
  await assert.rejects(qqQrPoll(deps, created.key), /QQ 授权未返回跳转地址/)
  const authorizeCalls = http.calls.filter((call) => call.url === 'https://graph.qq.com/oauth2.0/authorize')
  assert.equal(authorizeCalls.length, 1, 'authorize 只发一次（不自动重发变更类请求）')
})

test('qqQrPoll warns when the host session cannot be cleared', async () => {
  const sessions = fakeSessions()
  const http = fakeHttp(qqRoutes(sessions, {
    poll: () => ({ body: "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?ptsigx=fake','0','ok','nick')" }),
  }))
  const deps = host(http, new Map(), sessions)
  deps.http.importCookies = async () => { throw new Error('宿主拒绝清空 session') }
  const created = await qqQrCreate(deps)
  const polled = await qqQrPoll(deps, created.key)
  assert.equal(polled.logged_in, true, '凭据落盘了就是登录成功')
  assert.match(polled.warning ?? '', /没能清掉宿主会话/, '清不掉要如实告警')
})

test('neteaseQrPoll refuses to claim success when the KV write fails', async () => {
  const sessions = fakeSessions()
  const http = fakeHttp([
    (options) => (options.url === QR_UNIKEY_URL ? { body: JSON.stringify({ code: 200, unikey: 'UNI-KEY' }) } : null),
    (options) => (options.url === QR_LOGIN_URL
      ? { body: JSON.stringify({ code: 803, message: 'ok', cookie: 'MUSIC_U=secret-value' }) }
      : null),
  ])
  const deps = host(http, new Map(), sessions)
  deps.kv.set = async () => { throw new Error('KV 写入失败：配额超限') }
  const created = await neteaseQrCreate(deps)
  await assert.rejects(neteaseQrPoll(deps, created.key), /保存登录态失败/)
})

// ─────────────────── QQ 歌单 / 每日推荐 / 我喜欢（假 ctx 集成）───────────────────
// 全部用假 http 驱动，不发真实网络请求。

/** musicu 路由：按 req_0 的 module/method 分发（返回 null 表示不接管）。 */
function musicuRoute(handler) {
  return (options) => {
    if (options.url !== QQ_MUSICU) return null
    let body
    try {
      body = JSON.parse(String(options.body ?? ''))
    } catch {
      return null
    }
    const hit = handler(`${body.req_0?.module}/${body.req_0?.method}`, body, options)
    if (!hit) return null
    return { body: typeof hit === 'string' ? hit : JSON.stringify(hit) }
  }
}

/** 成功信封（参考实现 client.go 的 musicu 响应形态）。 */
function musicuOk(data) {
  return { code: 0, req_0: { code: 0, data } }
}

/** 一首歌（songlist 条目）。 */
function qqSongEntry(mid, title, interval = 200) {
  return {
    id: 1,
    mid,
    title,
    interval,
    singer: [{ name: '歌手' }],
    album: { mid: 'ALBUM', name: '专辑' },
    file: { media_mid: 'MEDIA', size_128mp3: 100, size_320mp3: 200, size_flac: 0 },
  }
}

/** 带 QQ 登录态的假宿主。
 *  uin 可指定：插件按账号缓存「每日推荐」与「我喜欢」的跨页去重表，
 *  不同用例用不同账号才不会互相污染。 */
async function qqHost(http, jar = {}, uin = 'o0012345678') {
  const deps = host(http)
  await saveCookies(deps.kv, 'qq', {
    uin, qqmusic_key: '@K', tmeLoginType: '2', ...jar,
  })
  return deps
}

test('qqPlaylists lists the created and the favorite playlists', async () => {
  const http = fakeHttp([
    musicuRoute((key, body) => {
      if (key === 'music.musicasset.PlaylistBaseRead/GetPlaylistByUin') {
        // 账号 id 是规范 musicid（cookie 里的 o0012345678 → 12345678），
        // 不是补零形态 —— 参考实现 library.go:29 用的就是 s.MusicID。
        assert.deepEqual(body.req_0.param, { uin: '12345678' })
        return musicuOk({
          v_playlist: [
            { tid: 1001, dirName: '我的歌单', songNum: 110, bigpicUrl: 'https://cover/1.jpg', nick: '我', dirId: 5 },
            { tid: 0, dirName: '没有 tid', dirId: 6 },
            { dirName: '我喜欢', dirId: 201, songNum: 300, nick: '我' },
          ],
        })
      }
      if (key === 'music.musicasset.PlaylistFavRead/CgiGetPlaylistFavInfo') {
        assert.deepEqual(body.req_0.param, { uin: 'ENC', offset: 0, size: 100 })
        return musicuOk({
          hasmore: 0,
          v_list: [{ tid: 900, dirName: '别人的歌单', songNum: 12, picurl: 'https://cover/2.jpg', nick: '别人' }],
        })
      }
      return null
    }),
  ])
  const deps = await qqHost(http, { encryptUin: 'ENC' })
  const result = await qqPlaylists(deps)
  assert.equal(result.count, 3)
  assert.equal(result.notice, '')
  assert.deepEqual(result.playlists.map((item) => item.id), ['201', '1001', '900'])
  assert.deepEqual(result.playlists.map((item) => item.kind), ['liked', 'created', 'fav'])
  assert.equal(result.playlists[1].name, '我的歌单')
  assert.equal(result.playlists[1].count, 110)
  assert.equal(result.playlists[1].cover, 'https://cover/1.jpg')
  assert.equal(result.playlists[2].cover, 'https://cover/2.jpg')
  assert.equal(result.created.length, 1)
  assert.equal(result.favorites.length, 1)
  // 登录态在信封里，Cookie 头带上凭据（都来自插件 KV 的 cookies.qq）。
  const call = http.calls[0]
  const body = JSON.parse(call.body)
  assert.equal(body.comm.authst, '@K')
  assert.equal(body.comm.qq, '12345678')
  assert.equal(body.comm.tmeLoginType, 2)
  assert.equal(body.comm.ct, 11)
  assert.equal(call.headers['user-agent'], QQ_API_UA)
  assert.equal(call.headers.referer, 'https://y.qq.com/')
  assert.ok(call.headers.cookie.includes('qqmusic_key=@K'))
})

test('qqPlaylists reports a missing account id instead of failing silently', async () => {
  const http = fakeHttp([
    musicuRoute((key) => (key === 'music.musicasset.PlaylistBaseRead/GetPlaylistByUin'
      ? musicuOk({ v_playlist: [{ tid: 5, dirName: 'A', dirId: 3 }] })
      : null)),
  ])
  const deps = await qqHost(http)
  const result = await qqPlaylists(deps)
  assert.equal(result.count, 1)
  assert.equal(result.favorites.length, 0)
  assert.match(result.notice, /encryptUin/)
  assert.equal(http.calls.length, 1, '没有 encryptUin 就不发收藏请求')
})

test('qqPlaylists refuses to work without a login and sends no request', async () => {
  const http = fakeHttp([])
  const deps = host(http)
  await assert.rejects(qqPlaylists(deps), /未登录/)
  assert.equal(http.calls.length, 0, '没登录就不该发请求')
})

test('qqPlaylists pages the favorites by the real row count and drops duplicates', async () => {
  const pages = [
    { hasmore: 1, v_list: [{ tid: 1, dirName: 'A' }, { tid: 2, dirName: 'B' }] },
    { hasmore: 1, v_list: [{ tid: 2, dirName: 'B' }, { tid: 3, dirName: 'C' }] },
    { hasmore: 1, v_list: [{ tid: 3, dirName: 'C' }] },
  ]
  const offsets = []
  const http = fakeHttp([
    musicuRoute((key, body) => {
      if (key === 'music.musicasset.PlaylistBaseRead/GetPlaylistByUin') return musicuOk({ v_playlist: [] })
      if (key === 'music.musicasset.PlaylistFavRead/CgiGetPlaylistFavInfo') {
        offsets.push(body.req_0.param.offset)
        return musicuOk(pages[offsets.length - 1])
      }
      return null
    }),
  ])
  const deps = await qqHost(http, { encryptUin: 'ENC' })
  const result = await qqPlaylists(deps)
  assert.deepEqual(offsets, [0, 2, 4], '游标步进是本页实际条数，不是 size')
  assert.deepEqual(result.favorites.map((item) => item.id), ['1', '2', '3'], '跨页按 tid 去重')
  assert.equal(http.calls.length, 4, '本页没有新 tid 就停')
})

test('qqPlaylistSongs routes the playlist, the liked list and the daily list', async () => {
  const http = fakeHttp([
    musicuRoute((key, body) => {
      if (key === 'music.srfDissInfo.aiDissInfo/uniform_get_Dissinfo') {
        if (body.req_0.param.disstid) {
          return musicuOk({
            total_song_num: 110,
            hasmore: 1,
            songlist: [qqSongEntry('MID1', '一')],
            dirinfo: { title: '公开歌单' },
          })
        }
        return musicuOk({
          total_song_num: 30,
          songlist: [qqSongEntry('DAILY', '每日')],
          dirinfo: { title: '每日推荐' },
        })
      }
      if (key === 'music.srfDissInfo.DissInfo/CgiGetDiss') {
        return musicuOk({
          total_song_num: 300,
          hasmore: 1,
          songlist: [qqSongEntry('LIKED', '喜欢')],
          dirinfo: { title: '我喜欢' },
        })
      }
      return null
    }),
  ])
  const deps = await qqHost(http, { encryptUin: 'ENC' }, 'o0011111111')

  const playlist = await qqPlaylistSongs(deps, '2002', 0, 100)
  assert.equal(playlist.songs.length, 1)
  assert.equal(playlist.songs[0].id, 'MID1', '歌曲 id 是 mid')
  assert.equal(playlist.total, 110)
  assert.equal(playlist.name, '公开歌单')
  let body = JSON.parse(http.calls.at(-1).body)
  assert.equal(body.req_0.module, 'music.srfDissInfo.aiDissInfo')
  assert.equal(body.req_0.method, 'uniform_get_Dissinfo')
  assert.deepEqual(body.req_0.param, {
    disstid: 2002, userinfo: 1, tag: 1, orderlist: 1,
    song_begin: 0, song_num: 100, onlysonglist: 0, enc_host_uin: '',
  })

  const liked = await qqPlaylistSongs(deps, '201', 100, 100)
  assert.equal(liked.songs[0].id, 'LIKED')
  assert.equal(liked.name, '我喜欢')
  body = JSON.parse(http.calls.at(-1).body)
  assert.equal(body.req_0.module, 'music.srfDissInfo.DissInfo')
  assert.equal(body.req_0.method, 'CgiGetDiss')
  assert.deepEqual(body.req_0.param, {
    disstid: 0, dirid: 201, tag: true, song_begin: 100, song_num: 100,
    userinfo: true, orderlist: true, enc_host_uin: 'ENC',
  })

  const daily = await qqPlaylistSongs(deps, '202', 0, 100)
  assert.equal(daily.songs[0].id, 'DAILY')
  assert.equal(daily.total, 30)
  body = JSON.parse(http.calls.at(-1).body)
  assert.deepEqual(body.req_0.param, { dirid: 202, optype: 3, tag: 1, userinfo: 0, pic_dpi: 300 })
})

test('an owned playlist is read through the owner API with enc_host_uin', async () => {
  const http = fakeHttp([
    musicuRoute((key) => {
      if (key === 'music.musicasset.PlaylistBaseRead/GetPlaylistByUin') {
        return musicuOk({ v_playlist: [{ tid: 3003, dirName: '我的歌单', dirId: 5 }] })
      }
      if (key === 'music.musicasset.PlaylistFavRead/CgiGetPlaylistFavInfo') {
        return musicuOk({ hasmore: 0, v_list: [] })
      }
      if (key === 'music.srfDissInfo.DissInfo/CgiGetDiss') {
        return musicuOk({ total_song_num: 1, songlist: [qqSongEntry('OWNED', '我的')] })
      }
      return null
    }),
  ])
  const deps = await qqHost(http, { encryptUin: 'ENC' })
  await qqPlaylists(deps)
  const result = await qqPlaylistSongs(deps, '3003', 0, 100)
  assert.equal(result.songs[0].id, 'OWNED')
  const body = JSON.parse(http.calls.at(-1).body)
  assert.equal(body.req_0.method, 'CgiGetDiss', '自建歌单走带 enc_host_uin 的接口')
  assert.equal(body.req_0.param.enc_host_uin, 'ENC')
})

test('a private playlist falls back to the owner API when the public API returns a shell', async () => {
  const http = fakeHttp([
    musicuRoute((key) => {
      if (key === 'music.srfDissInfo.aiDissInfo/uniform_get_Dissinfo') return musicuOk({ total_song_num: 0 })
      if (key === 'music.srfDissInfo.DissInfo/CgiGetDiss') {
        return musicuOk({ total_song_num: 2, songlist: [qqSongEntry('P1', '私密'), qqSongEntry('P2', '私密2')] })
      }
      return null
    }),
  ])
  const deps = await qqHost(http, { encryptUin: 'ENC' })
  const result = await qqPlaylistSongs(deps, '4004', 0, 100)
  assert.equal(result.songs.length, 2, '空壳不算空歌单，要改走自建接口')
  assert.equal(http.calls.length, 2)
})

test('a missing song list is an error, not an empty playlist', async () => {
  const http = fakeHttp([
    musicuRoute(() => musicuOk({ total_song_num: 5 })),
  ])
  const deps = await qqHost(http, { encryptUin: 'ENC' })
  await assert.rejects(qqPlaylistSongs(deps, '5005', 0, 100), /歌单曲目/)
})

test('qqPlaylistSongsPage returns the netease-shaped envelope', async () => {
  const http = fakeHttp([
    musicuRoute(() => musicuOk({
      total_song_num: 250,
      songlist: [qqSongEntry('M1', '一'), qqSongEntry('M2', '二')],
      dirinfo: { title: '歌单' },
    })),
  ])
  const deps = await qqHost(http, { encryptUin: 'ENC' })
  const page = await qqPlaylistSongsPage(deps, '6006', 2, 100)
  assert.deepEqual(Object.keys(page).sort(), ['name', 'page', 'page_size', 'songs', 'total'])
  assert.equal(page.name, '歌单')
  assert.equal(page.total, 250)
  assert.equal(page.page, 2)
  assert.equal(page.page_size, 100)
  assert.equal(page.songs.length, 2)
  const body = JSON.parse(http.calls.at(-1).body)
  assert.equal(body.req_0.param.song_begin, 100, '第二页从第 100 首开始')
})

test('qqDailyRecommendations and qqLikedSongs are thin wrappers', async () => {
  const http = fakeHttp([
    musicuRoute((key) => {
      if (key === 'music.srfDissInfo.aiDissInfo/uniform_get_Dissinfo') {
        return musicuOk({ total_song_num: 1, songlist: [qqSongEntry('DAILY', '每日')], dirinfo: { title: '每日推荐' } })
      }
      if (key === 'music.srfDissInfo.DissInfo/CgiGetDiss') {
        return musicuOk({ total_song_num: 1, songlist: [qqSongEntry('LIKED', '喜欢')] })
      }
      return null
    }),
  ])
  const deps = await qqHost(http, { encryptUin: 'ENC' }, 'o0022222222')
  const daily = await qqDailyRecommendations(deps)
  assert.equal(daily.songs[0].id, 'DAILY')
  assert.equal(daily.name, '每日推荐')
  const liked = await qqLikedSongs(deps, 0, 100)
  assert.equal(liked.songs[0].id, 'LIKED')
  const body = JSON.parse(http.calls.at(-1).body)
  assert.equal(body.req_0.param.dirid, 201)
  assert.equal(body.req_0.param.enc_host_uin, 'ENC')
})

test('the liked list refuses to work without the account id', async () => {
  const http = fakeHttp([])
  const deps = await qqHost(http)
  await assert.rejects(qqLikedSongs(deps, 0, 100), /账号标识/)
  assert.equal(http.calls.length, 0)
})

test('qqRpc surfaces the business code and never leaks the credential', async () => {
  const http = fakeHttp([
    musicuRoute(() => ({ code: 0, req_0: { code: 80030, data: { msg: 'musickey=@SECRET' } } })),
  ])
  const deps = await qqHost(http, { encryptUin: 'ENC-SECRET' })
  await assert.rejects(
    qqRpc(deps, 'music.musicasset.PlaylistBaseRead', 'GetPlaylistByUin', { uin: '1' }),
    (error) => {
      assert.match(error.message, /80030/)
      assert.ok(!error.message.includes('@SECRET'))
      assert.ok(!error.message.includes('ENC-SECRET'))
      assert.ok(!error.message.includes('musickey'))
      return true
    },
  )
})

test('qqPlaylists reports an expired login instead of an empty list', async () => {
  const http = fakeHttp([
    musicuRoute(() => ({ code: 0, req_0: { code: 80030, data: {} } })),
  ])
  const deps = await qqHost(http)
  await assert.rejects(qqPlaylists(deps), /80030/)
})

test('qqQrPoll stores the account id (encryptUin) next to the credential', async () => {
  const sessions = fakeSessions()
  const http = fakeHttp(qqRoutes(sessions, {
    poll: () => ({ body: "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?ptsigx=fake','0','ok','nick')" }),
    musicu: () => ({
      body: '{"code":0,"req":{"code":0,"data":{"musicid":10001,"musickey":"fake-musickey","loginType":2,' +
        '"nick":"Listener","encryptUin":"ENC-UIN"}}}',
    }),
  }))
  const deps = host(http, new Map(), sessions)
  const created = await qqQrCreate(deps)
  const polled = await qqQrPoll(deps, created.key)
  assert.equal(polled.logged_in, true)
  const jar = await loadCookies(deps.kv, 'qq')
  assert.equal(jar.encryptUin, 'ENC-UIN', '账号标识要落盘（收藏歌单 / 我喜欢接口要用）')
  assert.equal(jar.encryptUinFor, '10001', '账号标识要记下属于哪个 uin')
  assert.equal(jar.qqmusic_key, 'fake-musickey')
  assert.ok(!('p_skey' in jar), 'graph.qq.com 的全局授权 Cookie 仍然不进 KV')
  assert.ok(!('pt_oauth_token' in jar))
})

test('qqSongUrl does not fall back to the anonymous comm when the signed request has no link', async () => {
  const http = fakeHttp([
    (options) => (options.url === QQ_MUSICU && String(options.body).includes('music.pf_song_detail_svr')
      ? { body: '{"req_0":{"data":{"track_info":{"mid":"MID","file":{"media_mid":"MEDIA","size_128mp3":33}}}}}' }
      : null),
    (options) => {
      if (options.url !== QQ_MUSICU) return null
      const body = JSON.parse(options.body)
      if (body.comm.authst) return { body: '{"req_0":{"data":{"midurlinfo":[{"songmid":"MID","purl":""}]}}}' }
      return { body: '{"req_0":{"data":{"midurlinfo":[{"songmid":"MID","purl":"M500MIDMEDIA.mp3"}]}}}' }
    },
  ])
  const deps = await qqHost(http)
  // 登录态取不到链接就报错：不再多发一次匿名请求（匿名请求带不上会话，
  // 一旦服务端按 cookie 放行，用户选「无损 FLAC」会静默拿到 128K 的文件）。
  await assert.rejects(qqSongUrl(deps, 'MID', '128'), /所有音质均未获取到链接/)
  const bodies = http.calls.filter((call) => call.url === QQ_MUSICU).map((call) => JSON.parse(call.body))
  assert.equal(bodies.length, 2, '一次详情 + 一次登录态取链（不再有匿名回落）')
  assert.equal(bodies[1].comm.authst, '@K', '只试带 authst 的 comm')
  assert.equal(bodies[1].req_0.module, 'music.vkey.GetVkey')
})

test('qqLibraryInfo reports the login state without any credential value', async () => {
  const http = fakeHttp([])
  const deps = host(http)
  await saveCookies(deps.kv, 'qq', { uin: '10001', qqmusic_key: '@K', encryptUin: 'ENC', encryptUinFor: '10001' })
  const info = qqLibraryInfo(await loadCookies(deps.kv, 'qq'))
  assert.deepEqual(info, { source: 'qq', logged_in: true, has_account_id: true })
  assert.ok(!JSON.stringify(info).includes('@K'))
  assert.ok(!JSON.stringify(info).includes('ENC'))
  // 手动粘贴 Cookie 登录拿不到账号标识。
  const manual = qqLibraryInfo({ uin: '10001', qqmusic_key: '@K' })
  assert.equal(manual.has_account_id, false)
  // 账号标识属于别的账号时也不能用（换账号后不该读到别人的收藏歌单）。
  const other = qqLibraryInfo({ uin: 'o0022222222', qqmusic_key: '@K', encryptUin: 'ENC', encryptUinFor: '10001' })
  assert.equal(other.has_account_id, false)
})

test('a re-login without the account id clears the stale one', async () => {
  const sessions = fakeSessions()
  const http = fakeHttp(qqRoutes(sessions, {
    poll: () => ({ body: "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?ptsigx=fake','0','ok','nick')" }),
    musicu: () => ({
      body: '{"code":0,"req":{"code":0,"data":{"musicid":10001,"musickey":"fake-musickey","loginType":2}}}',
    }),
  }))
  const deps = host(http, new Map(), sessions)
  await saveCookies(deps.kv, 'qq', { uin: '10001', qqmusic_key: 'old', encryptUin: 'OLD-ENC' })
  const created = await qqQrCreate(deps)
  await qqQrPoll(deps, created.key)
  const jar = await loadCookies(deps.kv, 'qq')
  assert.equal(jar.encryptUin, '', '旧账号的账号标识不能留着')
  assert.equal(jar.qqmusic_key, 'fake-musickey')
})

test('the favorites paging stops at the hard limit and says so', async () => {
  let page = 0
  const http = fakeHttp([
    musicuRoute((key) => {
      if (key === 'music.musicasset.PlaylistBaseRead/GetPlaylistByUin') return musicuOk({ v_playlist: [] })
      if (key === 'music.musicasset.PlaylistFavRead/CgiGetPlaylistFavInfo') {
        const base = page * 100
        page += 1
        return musicuOk({
          hasmore: 1,
          v_list: Array.from({ length: 100 }, (_, index) => ({ tid: base + index + 1, dirName: `歌单${base + index + 1}` })),
        })
      }
      return null
    }),
  ])
  const deps = await qqHost(http, { encryptUin: 'ENC' })
  const result = await qqPlaylists(deps)
  assert.match(result.notice, /收藏歌单过多，未能完整读取/, '撞上限要说清楚')
  assert.equal(result.favorites.length, 10000, '已读到的部分结果照样给用户，不整份丢掉')
  assert.equal(result.count, 10000)
  assert.equal(page, 100, 'offset 上限 10000 = 100 页 × 100 条')
})

test('an account id from another account is not used for the favorites', async () => {
  const http = fakeHttp([
    musicuRoute((key) => (key === 'music.musicasset.PlaylistBaseRead/GetPlaylistByUin'
      ? musicuOk({ v_playlist: [{ tid: 7, dirName: 'A', dirId: 3 }] })
      : null)),
  ])
  const deps = host(http)
  // 手动粘贴了另一个账号的 Cookie，但 jar 里还留着上一个账号的账号标识。
  await saveCookies(deps.kv, 'qq', {
    uin: 'o0022222222', qqmusic_key: '@K', tmeLoginType: '2', encryptUin: 'OLD-ENC', encryptUinFor: '10001',
  })
  const result = await qqPlaylists(deps)
  assert.equal(result.count, 1)
  assert.equal(result.favorites.length, 0)
  assert.match(result.notice, /encryptUin/)
  assert.equal(http.calls.length, 1, '别账号的账号标识不发出去')
})

test('the owned playlists are addressed with the canonical musicid', async () => {
  const http = fakeHttp([
    musicuRoute((key, body) => {
      if (key === 'music.musicasset.PlaylistBaseRead/GetPlaylistByUin') {
        // 手动粘贴的 Cookie 是补零形态（o0000010001）；账号级接口要的是规范
        // musicid（参考实现 library.go:29 的 s.MusicID），不是补零后的 id。
        assert.equal(body.req_0.param.uin, '10001')
        assert.equal(body.comm.qq, '10001')
        return musicuOk({ v_playlist: [] })
      }
      return null
    }),
  ])
  const deps = host(http)
  await saveCookies(deps.kv, 'qq', { uin: 'o0000010001', qqmusic_key: '@K', tmeLoginType: '2' })
  await qqPlaylists(deps)
  assert.equal(http.calls.length, 1)
})

test('a private playlist that answers with an empty shell falls back to the owner API', async () => {
  const http = fakeHttp([
    musicuRoute((key) => {
      if (key === 'music.srfDissInfo.aiDissInfo/uniform_get_Dissinfo') {
        // 「成功但空壳」：code=0、songlist=[]，可整单写着 110 首。
        return musicuOk({ total_song_num: 110, songlist: [], dirinfo: { title: '私密歌单' } })
      }
      if (key === 'music.srfDissInfo.DissInfo/CgiGetDiss') {
        return musicuOk({ total_song_num: 2, songlist: [qqSongEntry('P1', '私密'), qqSongEntry('P2', '私密2')] })
      }
      return null
    }),
  ])
  const deps = await qqHost(http, { encryptUin: 'ENC' }, 'o0033333333')
  const result = await qqPlaylistSongs(deps, '4004', 0, 100)
  assert.equal(result.songs.length, 2, '空壳不算空歌单，要改走自建接口')
  assert.equal(result.total, 2)
  assert.equal(http.calls.length, 2, '公开接口 + 自建接口各一次')
})

test('an unreadable playlist without the account id reports the error instead of 0 songs', async () => {
  const http = fakeHttp([
    musicuRoute((key) => (key === 'music.srfDissInfo.aiDissInfo/uniform_get_Dissinfo'
      ? musicuOk({ total_song_num: 110, songlist: [] })
      : null)),
  ])
  const deps = await qqHost(http, {}, 'o0044444444')
  await assert.rejects(qqPlaylistSongs(deps, '4004', 0, 100), /歌单曲目/)
  assert.equal(http.calls.length, 1, '没有账号标识就没法回落，如实报错')
})

test('the liked list drops the songs it already showed', async () => {
  const http = fakeHttp([
    musicuRoute((key, body) => {
      if (key === 'music.srfDissInfo.DissInfo/CgiGetDiss') {
        const begin = body.req_0.param.song_begin
        return musicuOk(begin === 0
          ? { total_song_num: 4, songlist: [qqSongEntry('L1', '一'), qqSongEntry('L2', '二')] }
          : { total_song_num: 4, songlist: [qqSongEntry('L2', '二'), qqSongEntry('L3', '三')] })
      }
      return null
    }),
  ])
  const deps = await qqHost(http, { encryptUin: 'ENC' }, 'o0055555555')
  const first = await qqLikedSongs(deps, 0, 100)
  assert.deepEqual(first.songs.map((song) => song.id), ['L1', 'L2'])
  const second = await qqLikedSongs(deps, 100, 100)
  assert.deepEqual(second.songs.map((song) => song.id), ['L3'], '跨页重复的歌不再出现')
  assert.equal(second.total, 4)
})

test('the liked list reports a repeated page instead of showing duplicates', async () => {
  const http = fakeHttp([
    musicuRoute((key) => (key === 'music.srfDissInfo.DissInfo/CgiGetDiss'
      ? musicuOk({ total_song_num: 2, songlist: [qqSongEntry('L1', '一'), qqSongEntry('L2', '二')] })
      : null)),
  ])
  const deps = await qqHost(http, { encryptUin: 'ENC' }, 'o0066666666')
  await qqLikedSongs(deps, 0, 100)
  await assert.rejects(qqLikedSongs(deps, 100, 100), /未能完整读取/)
})

test('the playlist songs stop asking for more pages once the total is reached', async () => {
  const http = fakeHttp([
    musicuRoute((key) => (key === 'music.srfDissInfo.aiDissInfo/uniform_get_Dissinfo'
      ? musicuOk({
        total_song_num: 2,
        hasmore: 1,
        songlist: [qqSongEntry('M1', '一'), qqSongEntry('M2', '二')],
        dirinfo: { title: '歌单' },
      })
      : null)),
  ])
  const deps = await qqHost(http, { encryptUin: 'ENC' }, 'o0077777777')
  const result = await qqPlaylistSongs(deps, '7007', 0, 100)
  assert.equal(result.has_more, false, '读满了 total_song_num 就停（hasmore=1 也不多报）')
})

test('the daily list is fetched once and sliced page by page', async () => {
  let calls = 0
  const http = fakeHttp([
    musicuRoute((key) => {
      if (key === 'music.srfDissInfo.aiDissInfo/uniform_get_Dissinfo') {
        calls += 1
        return musicuOk({
          total_song_num: 3,
          songlist: [qqSongEntry('D1', '一'), qqSongEntry('D2', '二'), qqSongEntry('D3', '三')],
          dirinfo: { title: '每日推荐' },
        })
      }
      return null
    }),
  ])
  const deps = await qqHost(http, { encryptUin: 'ENC' }, 'o0088888888')
  const first = await qqPlaylistSongs(deps, 'daily', 0, 2)
  assert.deepEqual(first.songs.map((song) => song.id), ['D1', 'D2'])
  const second = await qqPlaylistSongs(deps, 'daily', 2, 2)
  assert.deepEqual(second.songs.map((song) => song.id), ['D3'])
  assert.equal(calls, 1, '整份列表只拉一次，翻页走本地切片')
})
