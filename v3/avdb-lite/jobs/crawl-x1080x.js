// X1080X 采集（AVDB 路线）：
//   1. FlareSolverr 过 Cloudflare，Cookie/UA 复用
//   2. 拉板块列表（很便宜）→ 和本地磁力库比对
//   3. 只对「没抓过 / 值得再试」的条目取详情（贵，而且会撞站点的游客阅读上限）
//
// 本地磁力库（插件 KV，avdb-articles）保存所有见过的条目：
//   - 抓到过磁力的条目长期保留，过期的帖子也能从库里翻出链接单独送 115
//   - 没抓到磁力的条目也留个记录，下一轮不重复去取详情（省配额）

import {
  normalizeSettings as siteSettings,
  log, solveChallenge, fetchJSON, fetchDetail, parseState, httpJSON, syncOfflineState
} from '../lib/site.js'

const BOARDS = {
  '3zfPdYrZvRsB5MYMHwE70K': '1080X-無碼BT',
  '5PDZcHM9127Cbn21wUhl1q': '1080X-有碼BT'
}

// 站点每个板块每页固定 20 条（另加 3 条置顶），所以要抓多少条就翻多少页。
const PAGE_SIZE = 20
const MAX_PAGES = 6
// 详情之间的间隔：随机化（固定节奏容易被当成机器人），基准 1.2–5 秒。
// 撞到站点的游客阅读上限会自动放慢（最多 15 秒一条），顺利了慢慢收回来。
const DETAIL_DELAY_MIN = 1200
const DETAIL_DELAY_MAX = 5000
const DETAIL_DELAY_SLOW = 15000
// 库里最多留多少条（含有磁力的）
const RETAIN_LIMIT = 800
// 没有磁力的条目最多留多少条（近的优先）
const KEEP_WITHOUT_MAGNET = 300
// 6 小时限时窗口内的条目，隔一会儿再试一次（万一那时能拿到链接）
const RECHECK_WINDOW_HOURS = 12
const MAX_RECHECK_PER_ROUND = 10

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function normalize(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const selected = Array.isArray(value.boards) ? value.boards.filter(id => BOARDS[id]) : []
  const maxItems = clamp(Number(value.max_items) || 40, 1, 100)
  return {
    ...siteSettings(value),
    boards: selected.length ? selected : Object.keys(BOARDS),
    max_items: maxItems,
    // 页数由条数推出来（每页 20 条）
    pages: Math.min(MAX_PAGES, Math.max(1, Math.ceil(maxItems / PAGE_SIZE)))
  }
}

const statePath = id => '/api/resources/' + encodeURIComponent(id) + '/state'
const articleKey = item => item.website + ':' + item.id

function applyState(article, state) {
  const parsed = parseState(state)
  article.preview_images = parsed.images
  article.magnets = parsed.magnets
  article.edk = parsed.edk
  article.size = parsed.size
  article.access_denied = !parsed.allowed
  // 游客拿到 magnet 就是真的拿到了；gated 说明这条帖子本身不公开下载地址。
  article.authenticated = Boolean(state && state.authenticated === true)
  article.member_required = Boolean(parsed.gated)
  article.login_required = false
  if (parsed.gated) article.magnets = []
  const names = parsed.text.match(/[^\s<>"']+\.(?:zip|rar|7z|tar\.gz)/gi) || []
  article.archive_names = [...new Set(names)].slice(0, 20)
  const passwords = parsed.text.match(/(?:解压密码|压缩密码|密碼|密码|提取码|pass(?:word)?)\s*[:：=]?\s*([A-Za-z0-9._-]{2,64})/gi) || []
  article.archive_passwords = [...new Set(passwords.map(item => item.replace(/^.*?[:：=]\s*/, '').trim()))].slice(0, 10)
  return parsed
}

/** 是不是「6 小时窗口内」的帖子——这种隔一会儿值得再试一次。 */
function isFresh(publishedAt) {
  const time = Date.parse(String(publishedAt || ''))
  if (!Number.isFinite(time)) return false
  return Date.now() - time < RECHECK_WINDOW_HOURS * 3600 * 1000
}

export async function run(ctx, input) {
  const settings = normalize(await ctx.storage.get('avdb-settings'))
  if (!settings.boards.length) throw new Error('请至少选择一个 X1080X 板块')

  const diag = { at: new Date().toISOString(), steps: [] }
  const note = async text => {
    diag.steps.push(String(text))
    await log(ctx, text)
  }

  // max_items 是「每个板块」的上限：板块多了也不会互相抢配额。
  const perBoard = settings.max_items
  const boardCount = settings.boards.length
  const total = Math.min(perBoard * boardCount, RETAIN_LIMIT)
  const boardDone = new Map()

  await ctx.task.update({ stage: 'cf', message: 'FlareSolverr 过 Cloudflare…', total, done: 0, failed: 0 })
  const net = await solveChallenge(ctx, settings)
  await note('过盾完成：' + net.base)

  // 本地磁力库：抓过的条目都在这儿
  const storedRaw = await ctx.storage.get('avdb-articles')
  const known = new Map()
  for (const item of Array.isArray(storedRaw) ? storedRaw : []) {
    if (item && item.id) known.set(articleKey(item), item)
  }
  const now = new Date().toISOString()

  const articles = []
  const seen = new Set()
  let done = 0
  let failed = 0
  let skipped = 0
  let fetched = 0
  let rechecked = 0
  let delayFloor = DETAIL_DELAY_MIN

  for (let page = 1; page <= settings.pages; page++) {
    for (const boardId of settings.boards) {
      const got = boardDone.get(boardId) || 0
      if (got >= perBoard) continue
      let items = []
      try {
        const data = await fetchJSON(ctx, settings, net,
          '/api/catalog/resources?board_id=' + encodeURIComponent(boardId) + '&page=' + page)
        if (!Array.isArray(data.items)) throw new Error('items 结构异常')
        items = data.items.filter(item => item && item.id && !(Number(item.sticky_scope) > 0))
        // 站点会告诉总页数，翻到最后一页就停
        const totalPages = Number(data.total_pages) || 0
        if (totalPages && page >= totalPages) settings.pages = Math.min(settings.pages, page)
      } catch (error) {
        failed++
        await note(`列表失败 ${BOARDS[boardId] || boardId} 第 ${page} 页：${error.message}`)
        continue
      }
      for (const item of items) {
        if ((boardDone.get(boardId) || 0) >= perBoard) break
        const key = 'x1080x:' + String(item.id)
        const old = known.get(key)
        const hasMag = Boolean(old && Array.isArray(old.magnets) && old.magnets.length)
        const resolved = Boolean(old && old.resolved)
        // 已经抓过：有磁力的直接复用；没磁力的只在 6 小时窗口内才值得再试
        let needDetail = !resolved
        if (resolved && !hasMag && isFresh(old.published_at) && rechecked < MAX_RECHECK_PER_ROUND) {
          needDetail = true
          rechecked++
        }

        const article = {
          id: String(item.id),
          website: 'x1080x',
          board_id: boardId,
          board_name: BOARDS[boardId] || boardId,
          title: String(item.title || (old && old.title) || '').trim(),
          published_at: String(item.published_at || (old && old.published_at) || ''),
          category: String(item.category_name || (old && old.category) || ''),
          detail_url: net.base + '/resources/' + encodeURIComponent(String(item.id)),
          cover: '',
          cover_remote: String(item.cover_url || (old && old.cover_remote) || ''),
          preview_images: (old && old.preview_images) || [],
          magnets: (old && old.magnets) || [],
          edk: (old && old.edk) || [],
          size: (old && old.size) || '',
          archive_names: (old && old.archive_names) || [],
          archive_passwords: (old && old.archive_passwords) || [],
          access_denied: Boolean(item.read_locked),
          login_required: false,
          member_required: Boolean(old && old.member_required),
          detail_error: '',
          resolved: false,
          first_seen_at: (old && old.first_seen_at) || now,
          last_seen_at: now,
          magnets_seen_at: (old && old.magnets_seen_at) || ''
        }

        if (needDetail) {
          try {
            applyState(article, await fetchDetail(ctx, settings, net, statePath(article.id)))
            article.resolved = true
            fetched++
            delayFloor = Math.max(DETAIL_DELAY_MIN, Math.round(delayFloor * 0.9))
          } catch (error) {
            article.detail_error = error.message
            article.rate_limited = /turnstile_required/.test(String(error.message))
            article.resolved = resolved
            if (article.rate_limited) {
              delayFloor = Math.min(DETAIL_DELAY_SLOW, delayFloor * 2)
              await log(ctx, `撞到站点游客阅读上限，之后放慢到每条 ${delayFloor / 1000} 秒左右`)
            }
            await log(ctx, `详情失败 ${article.id}：${error.message}`)
          }
          // 间隔随机化，别让固定节奏被当成机器人
          await ctx.sleep(delayFloor + Math.floor(Math.random() * 1200))
        } else {
          article.resolved = resolved
          skipped++
        }

        if (article.magnets.length) article.magnets_seen_at = (old && old.magnets_seen_at) || now
        seen.add(key)
        articles.push(article)
        boardDone.set(boardId, (boardDone.get(boardId) || 0) + 1)
        done++
        await ctx.task.update({
          stage: 'detail', message: `${BOARDS[boardId] || boardId} 第 ${page} 页`,
          total, done, failed
        })
      }
    }
  }
  await note('各板块采集量：' + settings.boards
    .map(id => `${BOARDS[id] || id} ${boardDone.get(id) || 0}`).join('，'))
  await note(`本轮新取详情 ${fetched} 条、跳过已知的 ${skipped} 条、窗口内重试 ${rechecked} 条`)

  // 合并进本地磁力库：库里出现过、这轮没翻到的旧条目也留着（磁力不能丢）
  for (const item of known.values()) {
    const key = articleKey(item)
    if (seen.has(key)) continue
    articles.push({ ...item, last_seen_at: item.last_seen_at || now, stale: true })
    seen.add(key)
  }

  const withMagnets = articles.filter(article => article.magnets.length)
  const withoutMagnets = articles.filter(article => !article.magnets.length)
  withoutMagnets.sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')))
  if (withoutMagnets.length > KEEP_WITHOUT_MAGNET) withoutMagnets.length = KEEP_WITHOUT_MAGNET
  const merged = withMagnets.concat(withoutMagnets)
  merged.sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')))
  if (merged.length > RETAIN_LIMIT) merged.length = RETAIN_LIMIT

  await ctx.storage.set('avdb-articles', merged)
  const hidden = merged.filter(article => article.member_required).length
  await ctx.storage.set('avdb-last-run', {
    at: now, count: merged.length, done, failed,
    fetched, skipped, gated: hidden, with_magnets: withMagnets.length,
    boards: settings.boards.map(id => ({ id, name: BOARDS[id] || id, count: boardDone.get(id) || 0 }))
  })
  diag.count = merged.length
  diag.with_magnets = withMagnets.length
  diag.fetched = fetched
  diag.skipped = skipped
  diag.failed = failed
  await ctx.storage.set('avdb-diag', diag)
  // 顺带把送出去的磁力在 115 上的状态刷新一次（写进 KV，页面直接读，不用现拉）
  try { await syncOfflineState(ctx) } catch (error) {
    await log(ctx, '115 状态同步失败：' + (error && error.message ? error.message : error))
  }
  await ctx.task.update({
    stage: 'done',
    message: `抓取完成：库内 ${merged.length} 条（${withMagnets.length} 条有磁力），`
      + `本轮新取 ${fetched} 条、跳过已知 ${skipped} 条`
      + (hidden ? `，${hidden} 条帖子本身不公开下载地址（需会员权益）` : ''),
    total: merged.length, done: merged.length, failed
  })
  return { count: merged.length, failed, fetched, skipped, withMagnets: withMagnets.length }
}

// 这个任务只写插件 KV；重启后重跑是幂等的。
export async function recover(ctx, checkpoint) {
  return { action: 'resume' }
}
