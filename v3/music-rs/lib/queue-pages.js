// 歌单整单入队的分批状态机 —— 从 plugins/music-rs/src/download.rs `queue_playlist_pages`
// 移植（0.3.14/0.3.15 形态）。纯函数：`enqueueOne` 与 `fetchPage` 由调用方注入。

import { PLAYLIST_PAGE_SIZE } from './constants.js'

/** action playlist-queue-all 每批最多翻的页数上限。 */
export const PLAYLIST_QUEUE_MAX_PAGES = 10
/** batch_pages 缺省值（5 页 = 500 首）。 */
export const PLAYLIST_QUEUE_DEFAULT_PAGES = 5

/** 整单入队的计数（响应 data 的来源）。 */
function newCounts() {
  return { queued: 0, deduped: 0, total_seen: 0, skipped: 0 }
}

/** 组装 result（status 在顶层，计数在 data 下）。 */
function queueAllResult(counts, nextPage, hasMore, error) {
  const data = { ...counts, next_page: nextPage, has_more: hasMore }
  return error
    ? { status: 'failed', message: error, data }
    : { status: 'succeeded', data }
}

/** 队列互斥把本批挡下时的回答：status=skipped，游标停在请求的起始页。 */
export function queueAllSkipped(startPage) {
  return {
    status: 'skipped',
    skipped: 'queue_busy',
    message: '队列正在推进或入队, 本批未入队, 请稍后再试',
    data: { ...newCounts(), next_page: Math.max(1, startPage), has_more: true },
  }
}

/**
 * 歌单整单入队核心（download.rs queue_playlist_pages）。
 *
 * 从 `startPage` 起逐页调用 `fetchPage(page, pageSize)`；对每首歌走 `enqueueOne(song)`
 * （与 download 同一条入队路径，索引去重，统一 quality）。处理满 batch_pages 页，或翻到
 * 页接口 total 所指的末尾（page * page_size >= total）即停；仅在 total 缺失时退回
 * 「当页不满 PAGE_SIZE」的保守判定。页面级失败是业务失败：返回已完成的 next_page
 * 与错误文案，已入队的不回滚。
 *
 * @param {(song: object) => Promise<{deduped: boolean}>} enqueueOne 单首入队
 * @param {(page: number, pageSize: number) => Promise<object>} fetchPage 取一页
 *   （resolve `{songs, total}`；reject 为页面失败）
 */
export async function queuePlaylistPages(enqueueOne, fetchPage, { startPage = 1, batchPages = PLAYLIST_QUEUE_DEFAULT_PAGES } = {}) {
  const first = Math.max(1, Math.trunc(startPage) || 1)
  const pages = Math.max(1, Math.min(Math.trunc(batchPages) || PLAYLIST_QUEUE_DEFAULT_PAGES, PLAYLIST_QUEUE_MAX_PAGES))
  const counts = newCounts()
  const endPage = first + pages
  let page = first
  while (page < endPage) {
    let pageValue
    try {
      pageValue = await fetchPage(page, PLAYLIST_PAGE_SIZE)
    } catch (error) {
      return queueAllResult(counts, page, true, `第 ${page} 页取歌失败: ${error?.message ?? error}`)
    }
    const songs = Array.isArray(pageValue?.songs) ? pageValue.songs : []
    counts.total_seen += songs.length
    for (const song of songs) {
      const songId = String(song?.id ?? '').trim()
      if (!songId) {
        counts.skipped += 1
        continue
      }
      // 单首入队失败不拖垮整批：记账跳过，继续后面的歌。
      try {
        const outcome = await enqueueOne(song)
        if (outcome?.deduped) counts.deduped += 1
        else counts.queued += 1
      } catch {
        counts.skipped += 1
      }
    }
    // 取尽判定以页接口恒带的 total（整单曲目数）为准，而非当页条数：
    // song/detail 会因下架/无版权/无效 id 少返曲目，满页也可能不足 100 首。
    const total = Number(pageValue?.total) || 0
    const pageEnd = page * PLAYLIST_PAGE_SIZE
    const exhausted = total > 0 ? pageEnd >= total : songs.length < PLAYLIST_PAGE_SIZE
    if (exhausted) return queueAllResult(counts, page + 1, false, null)
    page += 1
  }
  return queueAllResult(counts, endPage, true, null)
}
