// 海报 —— plugins/douban-rs/src/poster.rs 纯函数部分的移植。

/** 海报缓存条目上限（main.go:28 posterCacheLimit）。 */
export const POSTER_CACHE_LIMIT = 64
/** 单张海报字节上限（main.go:30 maxPosterBytes）：base64 后要留在宿主 256KiB 限额内。 */
export const MAX_POSTER_BYTES = 128 << 10
/** 取图请求的 accept（main.go:1860）。 */
export const IMAGE_ACCEPT = 'image/avif,image/webp,image/jpeg,image/*;q=0.8'
/** deep_refresh 时最多为多少条口碑榜条目补海报（charts.rs POSTER_LOOKUP_LIMIT）。 */
export const POSTER_LOOKUP_LIMIT = 8
/** 海报文件缓存的插件相对目录（插件自有 data/files，卸载即清空）。 */
export const POSTER_DIR = 'posters'

/**
 * main.go:2181 sniffImage：只认海报场景的四种格式。
 * PNG 分支只看 data[1..4]（不校验首字节 0x89 的原样行为）；
 * WebP 要求 RIFF + 第 9~12 字节 WEBP 且总长 >= 12。
 */
export function sniffImage(data) {
  const d = data instanceof Uint8Array ? data : new Uint8Array(data ?? 0)
  if (d.length >= 3 && d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return 'image/jpeg'
  if (d.length >= 4 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47) return 'image/png'
  if (d.length >= 3 && d[0] === 0x47 && d[1] === 0x49 && d[2] === 0x46) return 'image/gif'
  if (d.length >= 12 && d[0] === 0x52 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x46 &&
      d[8] === 0x57 && d[9] === 0x45 && d[10] === 0x42 && d[11] === 0x50) return 'image/webp'
  return ''
}

/** `(https?://)(img\d+)\.(doubanio\.com/)`（main.go:1838 posterHostRe；\d 用 ASCII 等价）。 */
const POSTER_HOST_RE = /(https?:\/\/)(img[0-9]+)\.(doubanio\.com\/)/

/**
 * 镜像域名候选顺序（main.go:1837）：原域名 → img3 → img1 → img2 → img4 → img5 →
 * img6 → img7 → img8 → img9（已出现的域名不重复）。URL 不含 doubanio 镜像域 → 只有原地址。
 */
export function mirrorCandidates(posterUrl) {
  const candidates = ['']
  const captures = POSTER_HOST_RE.exec(String(posterUrl ?? ''))
  if (captures) {
    const seen = new Set([captures[2]])
    for (const alt of ['img3', 'img1', 'img2', 'img4', 'img5', 'img6', 'img7', 'img8', 'img9']) {
      if (!seen.has(alt)) {
        candidates.push(alt)
        seen.add(alt)
      }
    }
  }
  return candidates
}

/** 镜像域名替换（`ReplaceAllString(url, "${1}"+alt+".${3}")`）。 */
export function withMirrorHost(posterUrl, alt) {
  if (alt === '') return posterUrl
  return String(posterUrl ?? '').replace(POSTER_HOST_RE, `$1${alt}.$3`)
}

/** 超限时的小图降级 URL（s_ratio_poster → m_ratio_poster，仅首个出现替换）。 */
export function downscaleUrl(posterUrl) {
  return String(posterUrl ?? '').replace('s_ratio_poster', 'm_ratio_poster')
}

/** data URL 组装（get-poster 的降级返回仍用它：files 写不进去时把 dataURL 直接给页面）。 */
export function dataUrlOf(mime, bytes, toBase64) {
  return `data:${mime};base64,${toBase64(bytes)}`
}

/** sniffImage 的 mime → 海报文件扩展名（未知 mime 返回空串）。 */
export function posterExtOf(mime) {
  switch (mime) {
    case 'image/jpeg': return 'jpg'
    case 'image/png': return 'png'
    case 'image/gif': return 'gif'
    case 'image/webp': return 'webp'
    default: return ''
  }
}

/**
 * 海报文件的插件相对路径：posters/<sha256(poster_url) hex>.<ext>。
 * 同一 URL 永远落到同一路径 → 重写幂等（job recover=resume 时重复执行安全）。
 */
export function posterPathOf(url, mime, sha256Hex) {
  const ext = posterExtOf(mime)
  const key = String(sha256Hex ?? '').trim()
  if (key === '' || ext === '') return ''
  return `${POSTER_DIR}/${key}.${ext}`
}
