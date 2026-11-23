// X1080X 采集（浏览器模式）：真实站点在 1080xin.com / 1080xin.vip（x1080x.com 只是占位跳转页）。
// 用宿主共享 Chromium 过 Cloudflare 安全验证，再从页面内 fetch JSON API 取数据。

import {
  PROFILE,
  log, waitChallengePassed, resolveHost, browserFetchJSON
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

const MAGNET_RE = /magnet:\?xt=urn:btih:[A-Za-z0-9]+[^\s"'<>]*/gi
const ED2K_RE = /ed2k:\/\/\|file\|[^"'\s<>]+/gi

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const selected = Array.isArray(value.boards) ? value.boards.filter(id => BOARDS[id]) : []
  return {
    boards: selected.length ? selected : ['7RHPO2w4jFUYiDhDsxz0wE'],
    pages: clamp(Number(value.pages) || 1, 1, 3),
    max_items: clamp(Number(value.max_items) || 40, 1, 100),
    proxy_mode: ['system', 'direct', 'custom'].includes(value.proxy_mode) ? value.proxy_mode : 'system',
    proxy_url: String(value.proxy_url || '').trim(),
    account_mode: value.account_mode === 'backup' ? 'backup' : 'main',
    account_id: value.account_id ? Number(value.account_id) : null,
    save_cid: String(value.save_cid || '').trim()
  }
}

/** 从详情页 HTML 提取磁力、ED2K、图片 */
async function extractFromPage(ctx, command, article) {
  const r = await command('Runtime.evaluate', {
    expression: `(() => {
      const body = document.querySelector('.post-content .post-text .protected-text.discuz-body') ||
                   document.querySelector('[id^="postmessage_"]') || document.body
      const html = body ? body.innerHTML : ''
      const text = body ? body.textContent : ''
      const titleEl = document.querySelector('.thread-header h1') || document.querySelector('#thread_subject')
      const imgs = Array.from(document.querySelectorAll('img')).map(i => i.src)
        .filter(s => s && !s.includes('/static/image/') && !s.includes('/images/smilies/'))
      const sm = text.match(/(\\d+(?:\\.\\d+)?)\\s*(TB|GB|MB|G|M)/i)
      return { html, text, title: titleEl ? titleEl.textContent.trim() : '', imgs: imgs.slice(0, 8), size: sm ? sm[1] + sm[2].toUpperCase() : '' }
    })()`,
    returnByValue: true
  })
  if (r.exceptionDetails) throw new Error('页面解析失败')
  const data = r.result?.value || {}
  if (data.title) article.title = data.title
  article.preview_images = data.imgs || []
  article.size = data.size || ''

  const raw = String(data.html || '')
  article.magnets = [...new Set((raw.match(MAGNET_RE) || []))].slice(0, 20)
  article.edk = [...new Set((raw.match(ED2K_RE) || []))].slice(0, 20)
  const names = (data.text || '').match(/[^\s<>"']+\.(?:zip|rar|7z|tar\.gz)/gi) || []
  article.archive_names = [...new Set(names)].slice(0, 20)
  const pwds = (data.text || '').match(/(?:解压密码|压缩密码|密码|提取码|pass(?:word)?)\s*[:：=]?\s*([A-Za-z0-9._-]{2,64})/gi) || []
  article.archive_passwords = [...new Set(pwds.map(p => p.replace(/^.*?[:：=]\s*/, '').trim()))].slice(0, 10)
  return article
}

export async function run(ctx, input) {
  const settings = normalizeSettings(await ctx.storage.get('avdb-settings'))
  if (!settings.boards.length) throw new Error('请至少选择一个 X1080X 板块')

  await ctx.task.update({ stage: 'browser', message: '打开共享浏览器…', total: settings.max_items, done: 0, failed: 0 })

  const status = await ctx.browser.status()
  if (!status.available) throw new Error(status.error || `浏览器运行包未就绪（state=${status.state}）`)

  const openOptions = { profile: PROFILE, timeout_seconds: 30 }
  if (settings.proxy_mode === 'direct') openOptions.proxy_mode = 'direct'
  else if (settings.proxy_mode === 'custom' && settings.proxy_url) {
    openOptions.proxy_mode = 'custom'
    openOptions.proxy_url = settings.proxy_url
  } else openOptions.proxy_mode = 'system'

  const page = await ctx.browser.open(openOptions)
  const command = (method, params = {}) =>
    ctx.browser.command({ session: page.id, method, params, timeout_seconds: 30 })

  const articles = []
  let done = 0
  let failed = 0

  try {
    await ctx.task.update({ stage: 'cf', message: '等待 Cloudflare 安全验证…' })
    const base = await resolveHost(ctx, command)

    for (const boardId of settings.boards) {
      if (articles.length >= settings.max_items) break
      for (let pageNo = 1; pageNo <= settings.pages; pageNo++) {
        if (articles.length >= settings.max_items) break
        let items = []
        try {
          const data = await browserFetchJSON(ctx, command, base,
            '/api/catalog/resources?board_id=' + encodeURIComponent(boardId) + '&page=' + pageNo)
          if (!data || !Array.isArray(data.items)) throw new Error('items 结构异常')
          items = data.items.filter(item => item && item.id && !(Number(item.sticky_scope) > 0))
        } catch (error) {
          failed++
          await log(ctx, `列表失败 ${BOARDS[boardId] || boardId} 第 ${pageNo} 页: ${error.message}`)
          continue
        }
        for (const item of items) {
          if (articles.length >= settings.max_items) break
          const article = {
            id: String(item.id || '').trim(),
            website: 'x1080x',
            board_id: boardId,
            board_name: BOARDS[boardId] || boardId,
            title: String(item.title || '').trim(),
            published_at: String(item.published_at || ''),
            category: String(item.category_name || ''),
            detail_url: base + '/resources/' + encodeURIComponent(String(item.id)),
            preview_images: [], magnets: [], edk: [],
            size: '', archive_names: [], archive_passwords: [],
            cover: '', cover_remote: '', access_denied: false, detail_error: ''
          }
          if (!article.id) continue
          try {
            await command('Page.navigate', { url: article.detail_url })
            const ok = await waitChallengePassed(ctx, command, 30000)
            if (!ok.ok) throw new Error('详情页未就绪：' + ok.reason)
            await ctx.sleep(500)
            await extractFromPage(ctx, command, article)
          } catch (error) {
            article.detail_error = error.message
            await log(ctx, `详情失败 ${article.id}: ${error.message}`)
          }
          articles.push(article)
          done++
          await ctx.task.update({
            stage: 'detail', message: `${BOARDS[boardId] || boardId} 第 ${pageNo} 页`,
            total: settings.max_items, done, failed
          })
          await ctx.sleep(300)
        }
      }
    }
  } finally {
    await ctx.browser.close(page.id).catch(() => {})
  }

  const seen = new Set()
  const unique = []
  for (const a of articles) {
    const key = a.website + ':' + a.id
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(a)
  }
  unique.sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')))

  await ctx.storage.set('avdb-articles', unique)
  await ctx.storage.set('avdb-last-run', {
    at: new Date().toISOString(), count: unique.length, done, failed,
    boards: settings.boards, pages: settings.pages
  })
  await ctx.task.update({
    stage: 'done', message: `抓取完成，共 ${unique.length} 条`,
    total: unique.length, done: unique.length, failed
  })
  return { count: unique.length, failed }
}

export async function recover(ctx, checkpoint) {
  return { action: 'resume' }
}
