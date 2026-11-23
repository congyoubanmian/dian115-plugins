// X1080X 采集（AVDB 路线）：
//   1. FlareSolverr 过 Cloudflare，Cookie/UA 存入插件 HTTP session
//   2. 普通 HTTP 拉列表 + 详情（复用 Cookie，不逐页开浏览器）
//   3. 下载地址需登录才可见：有账号时用共享浏览器登录，再在页面里取这些条目的详情

import {
  normalizeSettings as siteSettings,
  log, solveChallenge, httpJSON, parseState,
  openBrowser, isAuthenticated, browserLogin, browserFetchJSON, sampleResourceId
} from '../lib/site.js'

const BOARDS = {
  '7RHPO2w4jFUYiDhDsxz0wE': '1080X-BT綜合區',
  '3UKFoLtYJ7dVJH11Vhlhr0': '1080X-探花直播',
  '4QObtALYl5lGgpGdZtpzSr': '1080X-直播精品',
  '03j1fgCMP0OwIajgTgnUJP': '1080X-無碼破解',
  '22OcW3dDpsqmxQDGUk9TM1': '1080X-GIGA / ZEN 特攝女英雄',
  '1qkom8EvNlFV5hrXoHYgxF': '1080X-綜合資源',
  '7cJesEOmwz37MUQcpa23tU': '1080X-訂閱精品',
  '1TzKdT64tXQsh55bFLcP4B': '1080X-MGS素人 / DMM素人',
  '4p9onvFrBhb4GoTJjvMEwm': '1080X-4K超清',
  '14H7D8YbmYIK5gt84qR8mh': '1080X-VR視頻',
  '2SeUSjSuXYiPAfTkWMNc9T': '1080X-高清有碼',
  '0YB5HUwgTlLJnll5PR3Sxz': '1080X-外挂字幕',
  '5Vq0rCx89xT1rMiJ6ZAw42': '1080X-亞洲SM',
  '6Rj9of8m6shoqhAaXiXJje': '1080X-FC2視頻',
  '1I2Kx6AghQua8kCRtGk120': '1080X-S-cute / Mywife',
  '19jr2jN2gjuBwlIGlfoO4a': '1080X-歷史資源',
  '3zfPdYrZvRsB5MYMHwE70K': '1080X-無碼BT',
  '5PDZcHM9127Cbn21wUhl1q': '1080X-有碼BT'
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function normalize(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const selected = Array.isArray(value.boards) ? value.boards.filter(id => BOARDS[id]) : []
  return {
    ...siteSettings(value),
    boards: selected.length ? selected : ['7RHPO2w4jFUYiDhDsxz0wE'],
    pages: clamp(Number(value.pages) || 1, 1, 3),
    max_items: clamp(Number(value.max_items) || 40, 1, 100)
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
  article.login_required = parsed.gated
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

  const total = settings.max_items
  await ctx.task.update({ stage: 'cf', message: 'FlareSolverr 过 Cloudflare…', total, done: 0, failed: 0 })
  const { base, userAgent } = await solveChallenge(ctx, settings)

  const articles = []
  const gated = []
  let done = 0
  let failed = 0

  for (const boardId of settings.boards) {
    if (articles.length >= total) break
    for (let page = 1; page <= settings.pages; page++) {
      if (articles.length >= total) break
      let items = []
      try {
        const data = await httpJSON(ctx, base, userAgent,
          '/api/catalog/resources?board_id=' + encodeURIComponent(boardId) + '&page=' + page)
        if (!Array.isArray(data.items)) throw new Error('items 结构异常')
        items = data.items.filter(item => item && item.id && !(Number(item.sticky_scope) > 0))
      } catch (error) {
        failed++
        await log(ctx, `列表失败 ${BOARDS[boardId] || boardId} 第 ${page} 页：${error.message}`)
        continue
      }
      for (const item of items) {
        if (articles.length >= total) break
        const article = {
          id: String(item.id),
          website: 'x1080x',
          board_id: boardId,
          board_name: BOARDS[boardId] || boardId,
          title: String(item.title || '').trim(),
          published_at: String(item.published_at || ''),
          category: String(item.category_name || ''),
          detail_url: base + '/resources/' + encodeURIComponent(String(item.id)),
          cover: '',
          cover_remote: String(item.cover_url || ''),
          preview_images: [], magnets: [], edk: [], size: '',
          archive_names: [], archive_passwords: [],
          access_denied: Boolean(item.read_locked),
          login_required: false, detail_error: ''
        }
        try {
          applyState(article, await httpJSON(ctx, base, userAgent, statePath(article.id)))
        } catch (error) {
          article.detail_error = error.message
          await log(ctx, `详情失败 ${article.id}：${error.message}`)
        }
        if (article.login_required) gated.push(article)
        articles.push(article)
        done++
        await ctx.task.update({
          stage: 'detail', message: `${BOARDS[boardId] || boardId} 第 ${page} 页`,
          total, done, failed
        })
      }
    }
  }

  // 下载地址需要登录：有账号时走共享浏览器登录，再在页面里重取这些条目
  let loggedIn = false
  if (gated.length) {
    if (!settings.username || !settings.password) {
      await log(ctx, `${gated.length} 条需要登录才能看到下载地址（设置里未填账号）`)
    } else {
      await ctx.task.update({ stage: 'login', message: `登录以查看 ${gated.length} 条的下载地址…`, total, done, failed })
      let browser = null
      try {
        browser = await openBrowser(ctx, base, userAgent)
        const sample = await sampleResourceId(ctx, browser.command, base)
        loggedIn = await isAuthenticated(ctx, browser.command, base, sample)
        if (!loggedIn) loggedIn = await browserLogin(ctx, browser.command, base, settings, sample)
        await log(ctx, loggedIn ? '登录成功' : '登录未成功（账号密码错误、需验证或浏览器被拦截）')
        if (loggedIn) {
          for (const article of gated) {
            try {
              applyState(article, await browserFetchJSON(ctx, browser.command, base, statePath(article.id)))
              article.detail_error = ''
            } catch (error) {
              article.detail_error = error.message
              await log(ctx, `登录后详情失败 ${article.id}：${error.message}`)
            }
          }
        }
      } catch (error) {
        await log(ctx, `浏览器登录失败：${error.message}`)
      } finally {
        if (browser) await browser.close()
      }
    }
  }

  const seen = new Set()
  const unique = []
  for (const article of articles) {
    const key = article.website + ':' + article.id
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(article)
  }

  // 新帖的下载地址只在发布后约 6 小时内可见，之后要会员才能看。
  // 所以抓到过的磁力必须留住：本轮没取到（需登录/登录失败）时沿用上次结果，
  // 已经翻出最新列表的旧帖子也保留在库里。
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
      article.login_required = false
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
  const hidden = unique.filter(article => article.login_required).length
  const withMagnets = unique.filter(article => article.magnets.length).length
  await ctx.storage.set('avdb-last-run', {
    at: now, count: unique.length, done, failed, loggedIn, gated: hidden, with_magnets: withMagnets
  })
  await ctx.task.update({
    stage: 'done',
    message: `抓取完成，共 ${unique.length} 条，${withMagnets} 条有磁力` +
      (hidden ? `，${hidden} 条需登录后才能看下载地址` : ''),
    total: unique.length, done: unique.length, failed
  })
  return { count: unique.length, failed, loggedIn, gated: hidden, withMagnets }
}

// 本任务只写插件 KV；重启后重跑是幂等的。
export async function recover(ctx, checkpoint) {
  return { action: 'resume' }
}
