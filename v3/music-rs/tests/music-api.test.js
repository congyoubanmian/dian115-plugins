// 网络层测试 —— 假 http 复刻宿主 ctx.http.request，验证请求形态与响应解析。
// （对照 plugins/music-rs/src/{netease,qq}.rs 的宿主替身集成测试移植。）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import {
  neteaseSearch, neteaseQrCreate, neteaseQrPoll, neteasePlaylists, neteasePlaylistSongs,
  neteaseSongUrl, qqSearch, qqSongUrl, resolveSongUrl, loadCookies, saveCookies,
} from '../lib/music-api.js'
import { SEARCH_URL, SONG_URL_API, QR_UNIKEY_URL, QR_LOGIN_URL, PLAYLIST_DETAIL_URL, SONG_DETAIL_URL, CHROME_UA } from '../lib/eapi.js'
import { QQ_SEARCH_API, QQ_MUSICU, CHROME_UA as QQ_UA, QQ_API_UA, QQ_STREAM_FALLBACK_DOMAIN } from '../lib/qq.js'
import { cryptoAdapter } from '../jobs/runtime.js'
import { createKv } from '../lib/kv.js'
import { neteaseCookieHeader, qqCookieHeader } from '../lib/cookies.js'

function fakeHttp(routes) {
  const calls = []
  return {
    calls,
    async request(options) {
      calls.push(options)
      for (const route of routes) {
        const hit = route(options)
        if (hit) return { status: hit.status ?? 200, url: options.url, headers: hit.headers ?? {}, body: hit.body ?? '', cached: false }
      }
      throw new Error(`unexpected request: ${options.method} ${options.url}`)
    },
  }
}

function host(http, kvStore = new Map()) {
  const ctx = {
    id: 'music.rs',
    http: http.request ? http : { request: http },
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
          const current = hit ? hit.revision : undefined
          if (current !== expectedRevision) throw Object.assign(new Error('conflict'), { status: 412 })
        }
        kvStore.set(key, { value: JSON.parse(JSON.stringify(value)), revision: (hit?.revision ?? 0) + 1 })
        return { revision: (hit?.revision ?? 0) + 1 }
      },
      async remove(key) { kvStore.delete(key) },
    },
  }
  return { http: ctx.http, kv: createKv(ctx), crypto: cryptoAdapter(ctx.crypto) }
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
