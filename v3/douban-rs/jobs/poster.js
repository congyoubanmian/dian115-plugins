// 海报 —— plugins/douban-rs/src/poster.rs 的 v3 形态。
//
// - moviePoster：先按标题搜（j/subject_suggest，校验 id 一致），再按 id 兜底
//   （m.douban.com rexxar）；
// - getPoster：action get-poster 的落地（内存缓存 + 镜像域名回退 + s_ratio→m_ratio 降级）。
//
// 海报字节只落两处：插件自有 data/files（posters/<sha256(poster_url)>.<ext>，相对路径，
// 卸载即清空）与浏览器内存（页面 downloadURL 取图）。成功返回体只带路径引用
// {status:'succeeded', path, sha256, size, source_url}，不再返回 dataURL ——
// 宿主运行记录（Run.result）与页面 IPC 不再被 128KiB 级 base64 撑大。
// ctx.files / ctx.crypto 不可用或写入失败时才降级回 dataURL（页面仍认得 data: 开头），
// 同名同路径重写幂等，recover=resume 重复执行安全。
// dataURL 用补 padding 的标准 base64（与出站请求体的 RawStd 不是一回事）。

import { POSTER_CACHE_LIMIT, POSTER_DIR, MAX_POSTER_BYTES, IMAGE_ACCEPT, sniffImage, mirrorCandidates, withMirrorHost, downscaleUrl, dataUrlOf, posterPathOf } from '../lib/poster-core.js'
import { queryEscape, pathEscape } from '../lib/text.js'
import { doubanGet } from './httpx.js'
import { base64Encode } from '../lib/base64.js'

/** poster.rs suggest_poster：只有 id == want_id 且 img 以 http 开头才采用。 */
export async function suggestPoster(session, ctx, title, wantId) {
  const url = `https://movie.douban.com/j/subject_suggest?q=${queryEscape(title)}`
  const got = await doubanGet(ctx, url, 'application/json, text/plain;q=0.9')
  if (got.error) return ''
  let entries
  try {
    entries = JSON.parse(got.text)
  } catch {
    return ''
  }
  if (!Array.isArray(entries)) return ''
  for (const entry of entries) {
    if (String(entry?.id ?? '') === wantId && String(entry?.img ?? '').startsWith('http')) {
      return String(entry.img)
    }
  }
  return ''
}

/** poster.rs rexxar_poster：m.douban.com rexxar api v2 movie/<id>，取 pic.normal。 */
export async function rexxarPoster(session, ctx, subjectId) {
  const url = `https://m.douban.com/rexxar/api/v2/movie/${pathEscape(subjectId)}`
  const got = await doubanGet(ctx, url, 'application/json, text/plain;q=0.9')
  if (got.error) return ''
  let movie
  try {
    movie = JSON.parse(got.text)
  } catch {
    return ''
  }
  const normal = String(movie?.pic?.normal ?? '')
  if (!normal.startsWith('http')) return ''
  return normal
}

/** poster.rs movie_poster：suggest（校验 id）→ rexxar 兜底；都失败返回空串。 */
export async function moviePoster(session, ctx, title, wantId) {
  const poster = await suggestPoster(session, ctx, title, wantId)
  if (poster !== '') return poster
  return rexxarPoster(session, ctx, wantId)
}

/**
 * poster.rs get_poster：action `get-poster`。
 * 成功返回 {status:'succeeded', path, sha256, size, source_url}（文件缓存命中/新写）；
 * files 写不进去时降级 {status:'succeeded', url:<dataURL>, source_url, degraded:true}；
 * 失败返回 {status:'failed', message}。镜像候选每个最多 2 次（第二次前 sleep 800ms：
 * CDN 风控是时间窗问题，200ms 几乎等同立刻重打）。
 */
export async function getPoster(session, ctx, input) {
  const posterUrl = String(input?.poster_url ?? '').trim()
  if (posterUrl === '') return { status: 'failed', message: '缺少 poster_url' }
  if (!posterUrl.startsWith('https://') && !posterUrl.startsWith('http://')) {
    return { status: 'failed', message: '非法的海报地址' }
  }
  const cached = session.posterCache?.get(posterUrl)
  if (cached) return { status: 'succeeded', ...cached }

  if (!(session.posterCache instanceof Map)) session.posterCache = new Map()
  const candidates = mirrorCandidates(posterUrl)
  let lastErr = ''
  for (const alt of candidates) {
    const url = withMirrorHost(posterUrl, alt)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await sleep(ctx, 800)
      const got = await doubanGet(ctx, url, IMAGE_ACCEPT)
      if (got.error) {
        lastErr = `HTTP ${got.status}`
        continue
      }
      let body = got.body
      let mime = sniffImage(body)
      if (!mime.startsWith('image/')) {
        lastErr = `非图片内容(mime=${mime}, ${body.length}B)`
        continue
      }
      if (body.length > MAX_POSTER_BYTES && url.includes('s_ratio_poster')) {
        const fallback = await doubanGet(ctx, downscaleUrl(url), IMAGE_ACCEPT)
        if (!fallback.error) {
          const smallMime = sniffImage(fallback.body)
          if (smallMime.startsWith('image/') && fallback.body.length <= MAX_POSTER_BYTES) {
            body = fallback.body
            mime = smallMime
          }
        }
      }
      if (body.length > MAX_POSTER_BYTES) {
        lastErr = `海报过大 ${body.length}B (上限 ${MAX_POSTER_BYTES}B)`
        continue
      }
      const stored = await storePosterFile(session, ctx, posterUrl, mime, body)
      if (session.posterCache.size > POSTER_CACHE_LIMIT) session.posterCache.clear()
      if (stored !== null) {
        const entry = { path: stored.path, sha256: stored.sha256, size: stored.size, source_url: posterUrl }
        session.posterCache.set(posterUrl, entry)
        return { status: 'succeeded', ...entry }
      }
      // files/crypto 不可用或写入失败：降级 dataURL（运行记录会变大，只在该场景发生）
      const dataUrl = dataUrlOf(mime, body, base64Encode)
      session.posterCache.set(posterUrl, { url: dataUrl, source_url: posterUrl, degraded: true })
      return { status: 'succeeded', url: dataUrl, source_url: posterUrl, degraded: true }
    }
  }
  return { status: 'failed', message: `海报抓取失败: ${lastErr}` }
}

/**
 * 海报落盘到插件自有目录（相对路径 posters/<sha256(poster_url) hex>.<ext>）。
 * 成功返回 {path, sha256, size}；ctx.files / ctx.crypto 不可用或写入失败返回 null
 * （调用方降级 dataURL）。同名同路径重写幂等。
 */
async function storePosterFile(session, ctx, posterUrl, mime, body) {
  const files = ctx?.files
  const crypto = ctx?.crypto
  if (!files || typeof files.call !== 'function' || !crypto || typeof crypto.sha256 !== 'function') return null
  let hash = ''
  try {
    hash = await crypto.sha256(posterUrl, 'hex')
  } catch {
    return null
  }
  const path = posterPathOf(posterUrl, mime, hash)
  if (path === '') return null
  const content = base64Encode(body)
  let written = null
  try {
    written = await files.call({ operation: 'write', path, content, encoding: 'base64' })
  } catch {
    // 目录可能不存在：mkdir 后重试一次，仍失败才放弃
    try {
      await files.call({ operation: 'mkdir', path: POSTER_DIR })
      written = await files.call({ operation: 'write', path, content, encoding: 'base64' })
    } catch (error) {
      session.log('warning', `海报缓存写入失败: ${error?.message ?? error}`)
      return null
    }
  }
  const size = typeof written?.size === 'number' ? written.size : body.length
  const sha256 = typeof written?.sha256 === 'string' && written.sha256 !== '' ? written.sha256 : hash
  await evictPosterFiles(session, ctx)
  await backfillPosterFile(session, posterUrl, path)
  return { path, sha256, size }
}

/**
 * 文件缓存淘汰（与内存缓存同量级：POSTER_CACHE_LIMIT）：按 modified 升序删最旧，
 * 超出上限才删。list 失败只是跳过淘汰，不影响本次返回。被删路径对应的
 * state.poster_file 由页面侧 404 回退链兜底。
 */
export async function evictPosterFiles(session, ctx) {
  const files = ctx?.files
  if (!files || typeof files.call !== 'function') return
  let entries = null
  try {
    entries = await files.call({ operation: 'list', path: POSTER_DIR })
  } catch {
    return
  }
  if (!Array.isArray(entries) || entries.length <= POSTER_CACHE_LIMIT) return
  const sorted = entries
    .filter((item) => item && item.is_dir !== true)
    .map((item) => ({ name: item.name ?? '', path: item.path ?? '', at: Date.parse(item.modified ?? '') || 0 }))
    .sort((a, b) => a.at - b.at)
  const excess = sorted.length - POSTER_CACHE_LIMIT
  // 删除路径由本文件自己拼成 posters/<文件名>：不采信宿主 list 返回的 path 原样，
  // 只取文件名（不含分隔符、不含 ..），拼回插件相对路径。宿主即使返回绝对路径，
  // 淘汰也只会落在插件自有目录内，不会越界到宿主目录。
  const victims = sorted
    .slice(0, excess)
    .map((item) => {
      const raw = String(item.name ?? '').trim() || String(item.path ?? '').trim()
      const base = raw.slice(raw.lastIndexOf('/') + 1).trim()
      if (!base || base === '.' || base === '..' || base.includes('/') || base.includes('\\')) return null
      return `${POSTER_DIR}/${base}`
    })
    .filter((path) => path !== null)
  if (victims.length === 0) return
  try {
    await files.call({ operation: 'remove', paths: victims })
  } catch (error) {
    session.log('warning', `海报缓存淘汰失败: ${error?.message ?? error}`)
  }
}

/**
 * 把新落盘的路径回填进 state（poster_file：相对路径字符串，绝不存 base64）。
 * 快照/观察队列/想看里所有 poster_url 相同的条目都回填；有变化才落盘。
 */
export async function backfillPosterFile(session, posterUrl, path) {
  const doc = session.doc
  let changed = 0
  const lists = doc.snapshot?.lists ?? {}
  for (const key of Object.keys(lists)) {
    for (const item of lists[key] ?? []) {
      if (item?.poster_url === posterUrl && item.poster_file !== path) {
        item.poster_file = path
        changed += 1
      }
    }
  }
  for (const item of doc.queue.items ?? []) {
    if (item?.poster_url === posterUrl && item.poster_file !== path) {
      item.poster_file = path
      changed += 1
    }
  }
  for (const item of doc.wish ?? []) {
    if (item?.poster_url === posterUrl && item.poster_file !== path) {
      item.poster_file = path
      changed += 1
    }
  }
  if (changed > 0 && session.persistAllowed) await session.persistQuietly()
  return changed
}

function sleep(ctx, ms) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms)
  return new Promise((resolve) => setTimeout(resolve, ms))
}
