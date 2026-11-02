// 海报 —— plugins/douban-rs/src/poster.rs 的 v3 形态。
//
// - moviePoster：先按标题搜（j/subject_suggest，校验 id 一致），再按 id 兜底
//   （m.douban.com rexxar）；
// - getPoster：action get-poster 的落地（内存缓存 + 镜像域名回退 + s_ratio→m_ratio 降级）。
// dataURL 用补 padding 的标准 base64（与出站请求体的 RawStd 不是一回事）。

import { POSTER_CACHE_LIMIT, MAX_POSTER_BYTES, IMAGE_ACCEPT, sniffImage, mirrorCandidates, withMirrorHost, downscaleUrl, dataUrlOf } from '../lib/poster-core.js'
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
 * 返回 {status, url|message}；镜像候选每个最多 2 次（第二次前 sleep 200ms）。
 */
export async function getPoster(session, ctx, input) {
  const posterUrl = String(input?.poster_url ?? '').trim()
  if (posterUrl === '') return { status: 'failed', message: '缺少 poster_url' }
  if (!posterUrl.startsWith('https://') && !posterUrl.startsWith('http://')) {
    return { status: 'failed', message: '非法的海报地址' }
  }
  const cached = session.posterCache?.get(posterUrl)
  if (cached) return { status: 'succeeded', url: cached }

  if (!(session.posterCache instanceof Map)) session.posterCache = new Map()
  const candidates = mirrorCandidates(posterUrl)
  let lastErr = ''
  for (const alt of candidates) {
    const url = withMirrorHost(posterUrl, alt)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await sleep(ctx, 200)
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
      const dataUrl = dataUrlOf(mime, body, base64Encode)
      if (session.posterCache.size > POSTER_CACHE_LIMIT) session.posterCache.clear()
      session.posterCache.set(posterUrl, dataUrl)
      return { status: 'succeeded', url: dataUrl }
    }
  }
  return { status: 'failed', message: `海报抓取失败: ${lastErr}` }
}

function sleep(ctx, ms) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms)
  return new Promise((resolve) => setTimeout(resolve, ms))
}
