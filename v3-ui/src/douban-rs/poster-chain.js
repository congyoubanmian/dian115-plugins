// 海报取图链路（框架无关的纯 JS）—— 页面 posters.ts 与 node 测试跑同一份实现。
//
// 为什么单独成文件：v3-ui 没有单测框架（只有 vue-tsc + smoke），把「能被 node --test
// 覆盖的决策逻辑」抽成不依赖 vue 的模块，测试用假 ctx（写文件 / downloadURL /
// 命中缓存不发请求）直接驱动它，页面与测试不留两套口径。
//
// 取图优先级（海报字节只落插件 data/files 与浏览器内存，state/任务记录只存路径引用）：
// ① 文件缓存快路径：state 条目里已有 poster_file（后端 get-poster 回填的相对路径）→
//    ctx.files.downloadURL 拼出同源下载地址，Range 探测可用就直接进 <img src>；
// ② 页面直连：豆瓣 CDN 有防盗链，浏览器直连 img*.doubanio.com 会 418，所以用
//    ctx.http 带豆瓣 Referer 取回 base64（response_type:'base64'）拼 data URL；
// ③ 回退后端 get-poster job：job 内部按镜像逐个回退并写插件文件缓存，成功返回
//    {status:'succeeded', path, sha256, size, source_url} → 页面拼 downloadURL；
//    files 不可用的降级返回才带 data:。
//
// 环境约束：jobs 环境没有 DOM/Node 内置模块，页面是浏览器环境；这里只用注入进来的
// 能力（http / files / fetchImpl），不直接 import 任何宿主或 Node API。

/** 页面直连海报的 base64 上限；超过就交给后端 get-poster 的 128 KiB 规则。 */
export const MAX_POSTER_B64 = 400_000

/** 从响应头里取某个头（大小写不敏感）。 */
function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return ''
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue
    return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')
  }
  return ''
}

/** base64 化（宿主可能给字符串，也可能给字节数组）。 */
function base64Of(value) {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) {
    let binary = ''
    for (const byte of value) binary += String.fromCharCode(byte)
    return btoa(binary)
  }
  return ''
}

/** ctx.files.downloadURL 拼同源下载地址（页面拿 URL 进 <img src>，不把文件搬进内存）。 */
export function posterDownloadURL(files, path) {
  if (typeof path !== 'string' || path === '') return ''
  try {
    const built = files?.downloadURL?.(path, { inline: true })
    return typeof built === 'string' ? built : ''
  } catch {
    return ''
  }
}

/**
 * Range 探测 downloadURL 是否可用（文件被淘汰/卸载后会 404）。
 * 用同源 fetch 带 Cookie；环境没有 fetch（测试桩/老 WebView）时乐观采用。
 */
export async function probeDownloadURL(fetchImpl, url, signal) {
  if (typeof fetchImpl !== 'function') return true
  try {
    const init = { method: 'GET', headers: { Range: 'bytes=0-0' }, credentials: 'include' }
    if (signal) init.signal = signal
    const response = await fetchImpl(url, init)
    return response.ok === true
  } catch {
    return false
  }
}

/**
 * 建海报取图器（posters.ts 的数据面）。
 *
 * @param options.http 页面 ctx.http（宿主代理出站，带豆瓣 Referer 直取）。
 * @param options.files 页面 ctx.files（只用 downloadURL）。
 * @param options.invokeJob 提交 get-poster 任务并等终态。
 * @param options.findPosterFile 从 state 里查 poster_url → poster_file 相对路径（可缺省）。
 * @param options.fetchImpl 全局 fetch（探测用；测试注入假实现）。
 * @param options.signal 页面 ctx.signal：页面关闭后不再发起新的探测 / 直连 / 回退任务。
 */
export function createPosterFetcher({ http, files, invokeJob, findPosterFile, fetchImpl, signal } = {}) {
  const aborted = () => signal?.aborted === true

  /** ① 文件缓存快路径：poster_file 可用则返回 downloadURL，否则空串。 */
  async function loadFromFiles(url) {
    const file = typeof findPosterFile === 'function' ? findPosterFile(url) : ''
    if (file === '') return ''
    const remote = posterDownloadURL(files, file)
    if (remote === '') return ''
    return (await probeDownloadURL(fetchImpl, remote, signal)) ? remote : ''
  }

  /** ② 页面直连：带豆瓣 Referer 取 base64。 */
  async function fetchPosterDirect(url) {
    const result = await http.request({
      url,
      method: 'GET',
      headers: {
        Referer: 'https://movie.douban.com/',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      response_type: 'base64',
      timeout_seconds: 30,
      cache_seconds: 3600,
    })
    if (!result || (result.status ?? 0) < 200 || (result.status ?? 0) >= 300) {
      throw new Error(`HTTP ${result?.status ?? '?'}`)
    }
    const body = base64Of(result.body_base64)
    if (body === '') throw new Error('空响应')
    if (body.length > MAX_POSTER_B64) throw new Error('海报过大')
    const contentType = headerValue(result.headers, 'content-type') || 'image/jpeg'
    if (!contentType.toLowerCase().startsWith('image/')) throw new Error(`非图片内容 ${contentType}`)
    return `data:${contentType.split(';')[0]};base64,${body}`
  }

  /** ③ 回退后端 job（内部按镜像逐个回退，限 128 KiB，并写插件文件缓存）。 */
  async function fetchPosterViaJob(url) {
    const run = await invokeJob('get-poster', { poster_url: url })
    const raw = run?.result
    const result = raw && typeof raw === 'object' ? raw : {}
    if (result.status === 'succeeded') {
      const remote = posterDownloadURL(files, result.path)
      if (remote !== '') return remote
      if (typeof result.url === 'string' && result.url.startsWith('data:')) return result.url
    }
    throw new Error(String(result.message || '海报获取失败'))
  }

  /** 完整取图链路；返回 {src, reason}——全部失败时 src='' 且 reason 带最后那条错误
   *  （job 的 message 最具体：海报抓取失败: HTTP 418 之类），页面拿它做占位提示与日志。 */
  return {
    async load(url) {
      const clean = typeof url === 'string' ? url.trim() : ''
      if (!/^https?:\/\//i.test(clean) || aborted()) return { src: '', reason: '' }
      const fromFiles = await loadFromFiles(clean)
      if (fromFiles !== '') return { src: fromFiles, reason: '' }
      if (aborted()) return { src: '', reason: '' }
      try {
        return { src: await fetchPosterDirect(clean), reason: '' }
      } catch (directError) {
        if (aborted()) return { src: '', reason: '' }
        try {
          return { src: await fetchPosterViaJob(clean), reason: '' }
        } catch (jobError) {
          const reason = String(jobError?.message || directError?.message || '海报获取失败')
          return { src: '', reason }
        }
      }
    },
  }
}
