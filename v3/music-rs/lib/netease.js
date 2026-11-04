// 网易云纯映射函数 —— 从 plugins/music-rs/src/netease.rs 移植。
// （eapi 常量在 lib/eapi.js；cookie 处理在 lib/cookies.js；网络层在 lib/music-api.js。）

import { qualitiesForLevel } from './eapi.js'
import { queryEscape } from './encoding.js'
import { songVipTag } from './vip-tag.js'

/** 单曲搜索结果的一条歌 → 插件契约形状（Go neteaseSearch 的逐条映射）：
 *  id 是数字（不是 sidecar 的字符串）。 */
export function mapSearchSong(song) {
  const album = song?.al && typeof song.al === 'object' ? song.al : {}
  const singers = (Array.isArray(song?.ar) ? song.ar : [])
    .map((artist) => (typeof artist?.name === 'string' ? artist.name : ''))
    .join('/')
  const privilege = song?.privilege && typeof song.privilege === 'object' ? song.privilege : null
  const maxLevel = String(privilege?.maxBrLevel || privilege?.downloadMaxBrLevel || '')
  // 非会员/付费歌曲不输出 vip 键，保持原有对象形状（契约测试逐键比对）。
  const vip = songVipTag({ fee: song?.fee ?? privilege?.fee, maxLevel })
  return {
    id: song?.id ?? 0,
    name: song?.name ?? '',
    singers,
    album: album.name ?? '',
    cover: album.picUrl ?? '',
    duration_ms: song?.dt ?? 0,
    source: 'netease',
    ...(vip ? { vip } : {}),
  }
}

/** 歌单的歌曲页返回形状（page_size 按本插件契约用下划线）。 */
export function playlistPage(name, total, page, pageSize, songs) {
  return { name, total, page, page_size: pageSize, songs }
}

/**
 * sidecar server.mjs:331-345 的歌曲映射：把 v3 song/detail 的一首歌转成插件契约形状。
 * JS 语义逐条对照（`||` 对空串/0 也回退，`??` 只对 null/undefined）：
 * - id = String(t.id)；
 * - singers = t.ar（假值回退 t.artists）逐个 name 用 / 连接；
 * - album/cover = (t.al || t.album) 的 name/picUrl；
 * - duration_ms = t.dt（0/缺失回退 t.duration）；
 * - max_level = privilege.maxBrLevel || privilege.downloadMaxBrLevel || ''；
 * - qualities = qualitiesForLevel(max_level)。
 */
export function playlistSongFromValue(song) {
  const artists = Array.isArray(song?.ar) && song.ar.length ? song.ar
    : Array.isArray(song?.artists) ? song.artists : null
  const singers = artists
    ? artists.map((a) => (typeof a?.name === 'string' ? a.name : '')).filter((n) => n !== '').join('/')
    : ''
  // (t.al || t.album)：al 是对象（含空对象）就用 al，否则 album。
  const album = song?.al && typeof song.al === 'object' ? song.al
    : song?.album && typeof song.album === 'object' ? song.album : null
  const albumName = album && typeof album.name === 'string' && album.name !== '' ? album.name : ''
  const cover = album && typeof album.picUrl === 'string' && album.picUrl !== '' ? album.picUrl : ''
  // t.dt || t.duration || 0：dt 为 0 时回退 duration。
  const dt = typeof song?.dt === 'number' ? song.dt : 0
  const duration = typeof song?.duration === 'number' ? song.duration : 0
  const durationMs = dt !== 0 ? dt : duration
  const privilege = song?.privilege && typeof song.privilege === 'object' ? song.privilege : null
  const maxBr = privilege && typeof privilege.maxBrLevel === 'string' && privilege.maxBrLevel !== ''
    ? privilege.maxBrLevel
    : ''
  const downloadMax = privilege && typeof privilege.downloadMaxBrLevel === 'string' && privilege.downloadMaxBrLevel !== ''
    ? privilege.downloadMaxBrLevel
    : ''
  const maxLevel = maxBr || downloadMax
  const vipTag = songVipTag({ fee: song?.fee ?? privilege?.fee, maxLevel })
  const id = typeof song?.id === 'number'
    ? JSON.stringify(song.id) // Go number.to_string：整数无小数点
    : typeof song?.id === 'string' ? song.id : ''
  return {
    id,
    name: typeof song?.name === 'string' ? song.name : '',
    singers,
    album: albumName,
    cover,
    duration_ms: durationMs,
    source: 'netease',
    max_level: maxLevel,
    qualities: qualitiesForLevel(maxLevel),
    ...(vipTag ? { vip: vipTag } : {}),
  }
}

/**
 * 歌单索引（带缓存形态，0.3.15）：一次 GET v6 playlist/detail?n=0 拿全量 trackIds +
 * trackCount + name，之后各页纯本地切片（PlaylistIndex.songs），每片只 POST 当页的
 * v3 song/detail 换详情。`httpGet`/`httpPostForm` 由调用方注入（lib/music-api.js）。
 */
export function createPlaylistIndex({ name, total, ids }) {
  return { name, total, ids }
}

/** 从 v6 detail 响应解析索引（netease.rs PlaylistIndex::fetch 的纯部分）。 */
export function parsePlaylistDetail(body) {
  let parsed
  try {
    parsed = JSON.parse(String(body ?? ''))
  } catch (error) {
    return { error: `歌单详情解析失败: ${error.message}` }
  }
  // sidecar 的 j?.playlist || j?.result || {}：v6 响应可能落在任一字段。
  const info = parsed?.playlist && typeof parsed.playlist === 'object' ? parsed.playlist
    : parsed?.result && typeof parsed.result === 'object' ? parsed.result : {}
  const ids = (Array.isArray(info.trackIds) ? info.trackIds : [])
    .map((track) => (typeof track?.id === 'number' ? track.id : null))
    .filter((id) => id !== null)
  // `pl.trackCount ?? ids.length`（?? 只认 null/undefined，0 也是值）。
  const total = typeof info.trackCount === 'number' ? info.trackCount : ids.length
  return { index: { name: info.name ?? '', total, ids } }
}

/** 索引当页切片（netease.rs PlaylistIndex::songs 的纯部分）：本地切片 ids[(page-1)*size..+size]。
 *  Rust 语义：start = (page-1)*size（saturating 运算），start < 0（page=0）或越界 → 空页。 */
export function slicePlaylistPage(index, page, pageSize) {
  const start = (Math.trunc(page) - 1) * Math.trunc(pageSize)
  if (!Number.isFinite(start) || start < 0) return []
  const from = Math.min(start, index.ids.length)
  return index.ids.slice(from, from + Math.max(0, Math.trunc(pageSize)))
}

/** 每 200 个 id 一批的 v3 song/detail 表单（sidecar server.mjs:326-333）：
 *  `c=[{"id":..},..]&ids=[..,..]`。 */
export function songDetailForm(pageIds) {
  const c = JSON.stringify(pageIds.map((id) => ({ id })))
  return `c=${queryEscape(c)}&ids=[${pageIds.join(',')}]`
}

/** v3 song/detail 响应 → 歌曲数组（netease.rs SongDetailResponse 的纯部分）。 */
export function parseSongDetail(body) {
  let parsed
  try {
    parsed = JSON.parse(String(body ?? ''))
  } catch (error) {
    return { error: `歌曲详情解析失败: ${error.message}` }
  }
  const songs = Array.isArray(parsed?.songs) ? parsed.songs : []
  return { songs: songs.map(playlistSongFromValue) }
}

/** v6/详情通用歌单页响应（UI 分页浏览与整单入队共用）。 */
export function playlistPageFromIndex(index, page, pageSize, songs) {
  return playlistPage(index.name, index.total, page, pageSize, songs)
}
