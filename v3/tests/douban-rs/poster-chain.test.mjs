// 页面取图链路测试（v3-ui/src/douban-rs/poster-chain.js，纯 JS、node 可直接 import）：
// ① 文件缓存快路径（state.poster_file → ctx.files.downloadURL，Range 探测）
// ② 页面直连（ctx.http 带豆瓣 Referer → dataURL）
// ③ get-poster job 回退（真实 getPoster：写插件文件 → state 回填 → 返回 path → downloadURL）
// ④ 快路径 404 回退原有直连链；⑤ 全链失败返回空串。
// 海报字节只落插件 data/files 与浏览器内存；state 与页面缓存里只有 URL/路径字符串。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { createPosterFetcher, posterDownloadURL, probeDownloadURL } from '../../../v3-ui/src/douban-rs/poster-chain.js'
import { getPoster } from '../../douban-rs/jobs/poster.js'
import { Session } from '../../douban-rs/jobs/runtime.js'
import { setFixedNow } from '../../douban-rs/lib/clock.js'
import { posterPathOf } from '../../douban-rs/lib/poster-core.js'
import { parseStateDoc } from '../../douban-rs/lib/model.js'

const FIXED_NOW = 1_790_676_009_000_000_000

const jpeg = Buffer.alloc(64)
jpeg[0] = 0xff
jpeg[1] = 0xd8
jpeg[2] = 0xff
const JPEG_B64 = jpeg.toString('base64')

/**
 * 页面侧假宿主：ctx.http（直连路由）+ ctx.files（call 写内存文件区 + downloadURL 记录）
 * + fetchImpl（探测：known 里的路径返回 206，否则 404）。
 */
function makePageCtx({ filesEnabled = true, directStatus = 200 } = {}) {
  const httpCalls = []
  const fileCalls = []
  const downloads = []
  const fileStore = new Map() // path → Uint8Array
  const known = new Set() // fetchImpl 认为存在的文件路径

  const files = {
    call: async (options) => {
      fileCalls.push(options)
      if (options.operation === 'write') {
        const bytes = new Uint8Array(Buffer.from(options.content, 'base64'))
        fileStore.set(options.path, bytes)
        return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), path: options.path }
      }
      if (options.operation === 'list') {
        return [...fileStore.keys()].map((path) => ({ name: path, path, is_dir: false, size: 64, modified: new Date().toISOString(), backend: 'plugin' }))
      }
      if (options.operation === 'mkdir') return { path: options.path }
      if (options.operation === 'remove') {
        for (const path of options.paths ?? []) fileStore.delete(path)
        return null
      }
      throw new Error(`files 不支持 ${options.operation}`)
    },
    downloadURL: (path, opts = {}) => {
      const url = `https://host.test/api/extensions/v3/douban.rs/files/download?path=${encodeURIComponent(path)}${opts.inline ? '&inline=1' : ''}`
      downloads.push({ path, url, inline: Boolean(opts.inline) })
      return url
    },
  }

  const ctx = {
    httpCalls,
    fileCalls,
    downloads,
    fileStore,
    known,
    files,
    http: {
      request: async (options) => {
        httpCalls.push(options)
        if (directStatus >= 400) return { status: directStatus, headers: {}, body_base64: '' }
        return { status: 200, headers: { 'content-type': 'image/jpeg' }, body_base64: JPEG_B64 }
      },
    },
    fetchImpl: async (url) => {
      const match = /[?&]path=([^&]+)/.exec(url)
      const path = match ? decodeURIComponent(match[1]) : ''
      if (known.has(path)) return { ok: true, status: 206 }
      return { ok: false, status: 404 }
    },
  }
  if (!filesEnabled) delete ctx.files
  return ctx
}

test('posterDownloadURL / probeDownloadURL：URL 拼接与 Range 探测', async () => {
  const downloads = []
  const files = {
    downloadURL: (path, opts = {}) => {
      const url = `https://h.test/api/extensions/v3/x/files/download?path=${encodeURIComponent(path)}${opts.inline ? '&inline=1' : ''}`
      downloads.push({ path, url })
      return url
    },
  }
  assert.equal(posterDownloadURL(files, 'posters/a b.jpg'), 'https://h.test/api/extensions/v3/x/files/download?path=posters%2Fa%20b.jpg&inline=1')
  assert.equal(downloads[0].path, 'posters/a b.jpg', '原路径透传，转义只发生在 URL 里')
  assert.equal(posterDownloadURL(files, ''), '')
  assert.equal(posterDownloadURL(undefined, 'p'), '')
  assert.equal(posterDownloadURL({ downloadURL: () => 42 }, 'p'), '', '非字符串返回值当失败')

  assert.equal(await probeDownloadURL(undefined, 'https://h/x'), true, '没有 fetchImpl（测试桩/老 WebView）乐观采用')
  assert.equal(await probeDownloadURL(async () => ({ ok: true, status: 206 }), 'https://h/x'), true)
  assert.equal(await probeDownloadURL(async () => ({ ok: false, status: 404 }), 'https://h/x'), false, '404 不可用')
  assert.equal(await probeDownloadURL(async () => { throw new Error('net') }, 'https://h/x'), false, '网络错误不可用')
})

test('快路径：state 有 poster_file → downloadURL 直接可用，直连/job 都不发生', async () => {
  const ctx = makePageCtx()
  ctx.known.add('posters/abc.jpg')
  const fetcher = createPosterFetcher({
    http: ctx.http,
    files: ctx.files,
    invokeJob: async () => {
      throw new Error('不该提交 job')
    },
    findPosterFile: () => 'posters/abc.jpg',
    fetchImpl: ctx.fetchImpl,
  })
  const { src } = await fetcher.load('https://img1.doubanio.com/p1.jpg')
  assert.equal(src, 'https://host.test/api/extensions/v3/douban.rs/files/download?path=posters%2Fabc.jpg&inline=1')
  assert.equal(ctx.httpCalls.length, 0, '快路径命中不发直连请求')
  assert.deepEqual(ctx.downloads, [{ path: 'posters/abc.jpg', url: src, inline: true }])
})

test('快路径 404（文件被淘汰/卸载）→ 回退原有直连链', async () => {
  const ctx = makePageCtx()
  // known 里没有 posters/gone.jpg → 探测 404
  const fetcher = createPosterFetcher({
    http: ctx.http,
    files: ctx.files,
    invokeJob: async () => {
      throw new Error('不该提交 job')
    },
    findPosterFile: () => 'posters/gone.jpg',
    fetchImpl: ctx.fetchImpl,
  })
  const { src } = await fetcher.load('https://img1.doubanio.com/p2.jpg')
  assert.ok(src.startsWith('data:image/jpeg;base64,'), '回退直连拿到 dataURL')
  assert.equal(ctx.httpCalls.length, 1)
  assert.equal(ctx.httpCalls[0].headers.Referer, 'https://movie.douban.com/', '直连带防盗链 Referer')
})

test('直连成功 → dataURL；直连失败 → job 的 path 拼 downloadURL；降级 dataURL 兜底', async () => {
  // ① 直连成功
  let ctx = makePageCtx()
  let fetcher = createPosterFetcher({ http: ctx.http, files: ctx.files, invokeJob: async () => { throw new Error('x') }, findPosterFile: () => '', fetchImpl: ctx.fetchImpl })
  let { src } = await fetcher.load('https://img1.doubanio.com/p3.jpg')
  assert.ok(src.startsWith('data:image/jpeg;base64,'))
  assert.equal(ctx.downloads.length, 0)

  // ② 直连 418 → job 返回 path（get-poster 新契约）→ downloadURL
  ctx = makePageCtx({ directStatus: 418 })
  fetcher = createPosterFetcher({
    http: ctx.http,
    files: ctx.files,
    invokeJob: async (name, input) => {
      assert.equal(name, 'get-poster')
      assert.equal(input.poster_url, 'https://img1.doubanio.com/p4.jpg')
      return { status: 'succeeded', result: { status: 'succeeded', path: 'posters/k1.jpg', sha256: 'a'.repeat(64), size: 64, source_url: input.poster_url } }
    },
    findPosterFile: () => '',
    fetchImpl: ctx.fetchImpl,
  })
  src = (await fetcher.load('https://img1.doubanio.com/p4.jpg')).src
  assert.equal(src, 'https://host.test/api/extensions/v3/douban.rs/files/download?path=posters%2Fk1.jpg&inline=1')
  assert.ok(!src.startsWith('data:'), 'job 路径不再变成 dataURL')

  // ③ job 降级（files 不可用的旧宿主）→ dataURL 仍被接受
  ctx = makePageCtx({ directStatus: 418, filesEnabled: false })
  fetcher = createPosterFetcher({
    http: ctx.http,
    files: undefined,
    invokeJob: async () => ({ status: 'succeeded', result: { status: 'succeeded', url: 'data:image/jpeg;base64,AAAA', source_url: 'x', degraded: true } }),
    findPosterFile: () => '',
    fetchImpl: ctx.fetchImpl,
  })
  src = (await fetcher.load('https://img1.doubanio.com/p5.jpg')).src
  assert.equal(src, 'data:image/jpeg;base64,AAAA')

  // ④ 全链失败 → 空串（页面按 error 占位）
  ctx = makePageCtx({ directStatus: 418 })
  fetcher = createPosterFetcher({
    http: ctx.http,
    files: ctx.files,
    invokeJob: async () => ({ status: 'failed', result: { status: 'failed', message: '海报抓取失败: HTTP 418' } }),
    findPosterFile: () => '',
    fetchImpl: ctx.fetchImpl,
  })
  src = (await fetcher.load('https://img1.doubanio.com/p6.jpg')).src
  assert.equal(src, '')

  // ⑤ 非 http(s) 的 poster_url → 空串
  src = (await fetcher.load('ftp://x/y.jpg')).src
  assert.equal(src, '')
})

test('端到端：真实 getPoster 写文件 + state 回填 → 页面回退拿 downloadURL → 重读 state 走快路径', async () => {
  setFixedNow(FIXED_NOW)
  const page = makePageCtx({ directStatus: 418 })

  // 后端假宿主：业务 API（存储 KV + revision）+ 同一套 files 语义 + ctx.crypto
  const kv = new Map()
  const sha256Hex = (text) => createHash('sha256').update(new TextEncoder().encode(text)).digest('hex')
  // 预置可识别的最小状态：队列里有一条目标 poster_url（回填的落点）
  const posterUrl = 'https://img9.doubanio.com/view/photo/s_ratio_poster/public/p42.jpg'
  kv.set('state', {
    revision: 1,
    value: {
      // 注意：list config 不能给 []（数组的 'sort' 内建方法会被严格解析当成字符串字段拒绝）
      settings: { lists: { hot: {} } },
      queue: { items: [{ douban_ref: '42', title: '目标条目', poster_url: posterUrl, state: 'observing' }] },
    },
  })
  const backend = {
    id: 'douban.rs',
    api: {
      get: async (path) => {
        const m = /^\/api\/extensions\/v3\/[^/]+\/storage\/(.+)$/.exec(path)
        if (m) {
          const key = decodeURIComponent(m[1])
          if (!kv.has(key)) {
            const error = new Error('not found')
            error.status = 404
            throw error
          }
          return { revision: kv.get(key).revision, value: kv.get(key).value }
        }
        const error = new Error(`no route: ${path}`)
        error.status = 404
        throw error
      },
      post: async () => {
        const error = new Error('no route')
        error.status = 404
        throw error
      },
      put: async (path, body) => {
        const m = /^\/api\/extensions\/v3\/[^/]+\/storage\/(.+)$/.exec(path)
        if (!m) {
          const error = new Error(`no route: ${path}`)
          error.status = 404
          throw error
        }
        const key = decodeURIComponent(m[1])
        const revision = (kv.get(key)?.revision ?? 0) + 1
        kv.set(key, { value: body.value, revision })
        return { revision }
      },
    },
    // 后端不出网：豆瓣直连在这套假宿主里就是 418，逼出 job 的镜像回退也全部失败？
    // 不——镜像回退失败会让 getPoster 返回 failed。给一个 img3 成功路由模拟镜像命中。
    http: { request: async (options) => {
      if (String(options.url).includes('img3.doubanio.com')) {
        return { status: 200, headers: { 'content-type': 'image/jpeg' }, body_base64: JPEG_B64 }
      }
      return { status: 418, headers: {}, body_base64: Buffer.from('<html>418</html>').toString('base64') }
    } },
    files: { call: page.files.call },
    crypto: {
      sha256: async (data, output = 'hex') => {
        const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data))
        const digest = createHash('sha256').update(bytes).digest()
        return output === 'bytes' ? new Uint8Array(digest) : digest.toString(output)
      },
    },
    settings: { get: async () => ({}) },
    notify: async () => ({ accepted: false }),
    sleep: async () => {},
    task: { id: 'run-poster-1', update: async () => {}, checkpoint: async () => {}, log: async () => {} },
  }

  const expectedPath = posterPathOf(posterUrl, 'image/jpeg', sha256Hex(posterUrl))

  // 页面第一轮：state 还没重读（findPosterFile 返回空）→ 直连 418 → 提交真实 get-poster
  const session = await Session.open(backend)
  const fetcher = createPosterFetcher({
    http: page.http,
    files: page.files,
    invokeJob: async (_name, input) => {
      const result = await getPoster(session, backend, input ?? {})
      return { status: 'succeeded', result }
    },
    findPosterFile: () => '',
    fetchImpl: page.fetchImpl,
  })
  const { src } = await fetcher.load(posterUrl)
  assert.ok(page.fileStore.has(expectedPath), `后端把海报写进了 ${expectedPath}`)
  assert.equal(page.fileStore.get(expectedPath)[0], 0xff, '文件内容是真实字节（base64 编码写入）')
  assert.equal(
    src,
    `https://host.test/api/extensions/v3/douban.rs/files/download?path=${encodeURIComponent(expectedPath)}&inline=1`,
    '页面拿到的是 downloadURL，不是 base64',
  )

  // get-poster 已把相对路径回填进 state（队列条目），且 state 里没有 base64 字节
  const doc = parseStateDoc(kv.get('state').value)
  assert.ok(doc !== null)
  assert.equal(doc.queue.items[0].poster_file, expectedPath)
  assert.ok(!JSON.stringify(kv.get('state').value).includes('base64,'), 'state 里不存 base64')

  // 页面重读 state：第二轮走快路径，直连与 job 都不发生
  const fastCtx = makePageCtx({ directStatus: 418 })
  fastCtx.known.add(expectedPath)
  const fastFetcher = createPosterFetcher({
    http: fastCtx.http,
    files: fastCtx.files,
    invokeJob: async () => {
      throw new Error('快路径不该提交 job')
    },
    findPosterFile: () => doc.queue.items[0].poster_file,
    fetchImpl: fastCtx.fetchImpl,
  })
  const { src: fastSrc } = await fastFetcher.load(posterUrl)
  assert.equal(fastSrc, `https://host.test/api/extensions/v3/douban.rs/files/download?path=${encodeURIComponent(expectedPath)}&inline=1`)
  assert.equal(fastCtx.httpCalls.length, 0, '快路径不发直连请求')
})

test('页面已关闭（signal.aborted）→ 不再发起探测 / 直连 / 回退任务', async () => {
  const ctx = makePageCtx()
  const controller = new AbortController()
  controller.abort()
  let jobs = 0
  let probes = 0
  const fetcher = createPosterFetcher({
    http: ctx.http,
    files: ctx.files,
    invokeJob: async () => {
      jobs += 1
      throw new Error('x')
    },
    findPosterFile: () => 'posters/abc.jpg',
    fetchImpl: async () => {
      probes += 1
      return { ok: true }
    },
    signal: controller.signal,
  })
  assert.equal((await fetcher.load('https://img1.doubanio.com/closed.jpg')).src, '')
  assert.deepEqual([probes, ctx.httpCalls.length, jobs], [0, 0, 0])

  let seen = null
  await probeDownloadURL(async (_url, init) => {
    seen = init.signal
    return { ok: true }
  }, 'https://h/x', controller.signal)
  assert.equal(seen, controller.signal, '探测请求带上页面 signal')
})
