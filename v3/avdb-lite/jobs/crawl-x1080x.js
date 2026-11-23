// X1080X 采集（AVDB 路线）：
//   1. FlareSolverr 过 Cloudflare，Cookie/UA 复用
//   2. 普通 HTTP 拉列表 + 详情
//   3. 游客身份就能拿到「無碼BT」「有碼BT」的下载地址，不需要账号
//
// 站点的「BT綜合區」类帖子有 6 小时限时免费窗口，过期后要会员权益——
// 插件不绕过站点的会员限制，只如实标出来。

import {
  normalizeSettings as siteSettings,
  log, solveChallenge, fetchJSON, parseState, httpJSON, syncOfflineState
} from '../lib/site.js'

const BOARDS = {
  '3zfPdYrZvRsB5MYMHwE70K': '1080X-無碼BT',
  '5PDZcHM9127Cbn21wUhl1q': '1080X-有碼BT'
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

// 站点每个板块每页固定 20 条（另加 3 条置顶），所以要抓多少条就翻多少页。
const PAGE_SIZE = 20
const MAX_PAGES = 6

function normalize(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const selected = Array.isArray(value.boards) ? value.boards.filter(id => BOARDS[id]) : []
  const maxItems = clamp(Number(value.max_items) || 40, 1, 100)
  return {
    ...siteSettings(value),
    boards: selected.length ? selected : Object.keys(BOARDS),
    max_items: maxItems,
    // 页数由条数推出来（每页 20 条）；用户单独设的页数只当上限用。
    pages: Math.min(MAX_PAGES, Math.max(1, Math.ceil(maxItems / PAGE_SIZE)))
  }
}

const statePath = id => '/api/resources/' + encodeURIComponent(id) + '/state'
/** 库里最多保留的条目数（含已抓到磁力的旧帖）。 */
const RETAIN_LIMIT = 500

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

export async function run(ctx, input) {
  const settings = normalize(await ctx.storage.get('avdb-settings'))
  if (!settings.boards.length) throw new Error('请至少选择一个 X1080X 板块')

  const diag = { at: new Date().toISOString(), steps: [] }
  const note = async text => {
    diag.steps.push(String(text))
    await log(ctx, text)
  }

  // 按页轮转各板块：先把每个板块的第 1 页都抓一遍，再抓第 2 页……
  // 否则第一个板块就把总数用光，后面的板块一条都采不到。
  // max_items 是「每个板块」的上限：板块多了也不会互相抢配额。
  const perBoard = settings.max_items
  const boardCount = settings.boards.length
  const total = Math.min(perBoard * boardCount, RETAIN_LIMIT)
  const boardDone = new Map()

  await ctx.task.update({ stage: 'cf', message: 'FlareSolverr 过 Cloudflare…', total, done: 0, failed: 0 })
  const net = await solveChallenge(ctx, settings)
  await note('过盾完成：' + net.base)

  const articles = []
  let done = 0
  let failed = 0

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
        const article = {
          id: String(item.id),
          website: 'x1080x',
          board_id: boardId,
          board_name: BOARDS[boardId] || boardId,
          title: String(item.title || '').trim(),
          published_at: String(item.published_at || ''),
          category: String(item.category_name || ''),
          detail_url: net.base + '/resources/' + encodeURIComponent(String(item.id)),
          cover: '',
          cover_remote: String(item.cover_url || ''),
          preview_images: [], magnets: [], edk: [], size: '',
          archive_names: [], archive_passwords: [],
          access_denied: Boolean(item.read_locked),
          login_required: false, member_required: false, detail_error: ''
        }
        try {
          applyState(article, await fetchJSON(ctx, settings, net, statePath(article.id)))
        } catch (error) {
          article.detail_error = error.message
          await log(ctx, `详情失败 ${article.id}：${error.message}`)
        }
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

  const seen = new Set()
  const unique = []
  for (const article of articles) {
    const key = article.website + ':' + article.id
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(article)
  }

  // 新帖的下载地址只在发布后约 6 小时内可见，之后要会员才能看。
  // 所以抓到过的磁力必须留住：本轮没取到时沿用上次结果，已经翻出最新列表的旧帖子也保留在库里。
  const storedRaw = await ctx.storage.get('avdb-articles')
  const stored = new Map()
  for (const item of Array.isArray(storedRaw) ? storedRaw : []) {
    if (item && item.id) stored.set(item.website + ':' + item.id, item)
  }
  const now = new Date().toISOString()
  for (const article of unique) {
    const old = stored.get(article.website + ':' + article.id)
    article.first_seen_at = old && old.first_seen_at ? old.first_seen_at : now
    if (!article.magnets.length && old && Array.isArray(old.magnets) && old.magnets.length) {
      article.magnets = old.magnets
      if (!article.edk.length && Array.isArray(old.edk)) article.edk = old.edk
    }
    article.magnets_seen_at = article.magnets.length
      ? (old && old.magnets_seen_at ? old.magnets_seen_at : now)
      : ''
  }
  // 本轮窗口之外的旧帖子：只留已经抓到磁力的，避免库无限增长
  for (const item of stored.values()) {
    const key = item.website + ':' + item.id
    if (seen.has(key) || !Array.isArray(item.magnets) || !item.magnets.length) continue
    seen.add(key)
    unique.push(item)
  }
  unique.sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')))
  if (unique.length > RETAIN_LIMIT) unique.length = RETAIN_LIMIT

  await ctx.storage.set('avdb-articles', unique)
  const hidden = unique.filter(article => article.member_required).length
  const withMagnets = unique.filter(article => article.magnets.length).length
  await ctx.storage.set('avdb-last-run', {
    at: now, count: unique.length, done, failed, gated: hidden, with_magnets: withMagnets,
    boards: settings.boards.map(id => ({ id, name: BOARDS[id] || id, count: boardDone.get(id) || 0 }))
  })
  diag.count = unique.length
  diag.with_magnets = withMagnets
  diag.gated = hidden
  diag.failed = failed
  await ctx.storage.set('avdb-diag', diag)
  // 顺带把送出去的磁力在 115 上的状态刷新一次（写进 KV，页面直接读，不用现拉）
  try { await syncOfflineState(ctx) } catch (error) {
    await log(ctx, '115 状态同步失败：' + (error && error.message ? error.message : error))
  }
  await ctx.task.update({
    stage: 'done',
    message: `抓取完成，共 ${unique.length} 条，${withMagnets} 条有磁力` +
      (hidden ? `，${hidden} 条帖子本身不公开下载地址（需会员权益）` : ''),
    total: unique.length, done: unique.length, failed
  })
  return { count: unique.length, failed, gated: hidden, withMagnets }
}

// 这个任务只写插件 KV；重启后重跑是幂等的。
export async function recover(ctx, checkpoint) {
  return { action: 'resume' }
}
