// X1080X 采集：列表 -> 详情 -> 磁力/ED2K/预览图，结果写入插件 KV。
// 只做读取和插件自有缓存；不写宿主文件。

const BASE = 'https://x1080x.com'
const SESSION = 'x1080x'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// 板块 ID 来自 article 的 catalog 常量；名称用于页面展示。
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
    cookie: String(value.cookie || '').trim(),
    csrf: String(value.csrf || '').trim(),
    boards: selected.length ? selected : ['7RHPO2w4jFUYiDhDsxz0wE'],
    pages: clamp(Number(value.pages) || 1, 1, 3),
    max_items: clamp(Number(value.max_items) || 40, 1, 100),
    cache_images: value.cache_images !== false,
    account_mode: value.account_mode === 'backup' ? 'backup' : 'main',
    account_id: value.account_id ? Number(value.account_id) : null,
    save_cid: String(value.save_cid || '').trim()
  }
}

function headersFor(settings) {
  const headers = {
    Accept: 'application/json',
    Referer: BASE + '/',
    Origin: BASE,
    'User-Agent': UA,
    Cookie: settings.cookie
  }
  const csrf = settings.csrf || (settings.cookie.match(/(?:^|;\s*)(?:csrf_token|csrftoken)=([^;]+)/i) || [])[1]
  if (csrf) headers['X-CSRFToken'] = decodeURIComponent(csrf)
  return headers
}

async function log(ctx, text) {
  try {
    await ctx.task.log(String(text).slice(0, 4000))
  } catch (_) {
    // 日志失败不影响任务
  }
}

async function fetchJson(ctx, headers, path, timeoutSeconds = 60) {
  const res = await ctx.http.request({
    url: BASE + path,
    method: 'GET',
    headers,
    session: SESSION,
    timeout_seconds: timeoutSeconds,
    response_type: 'json'
  })
  if (res.status === 401 || res.status === 403) {
    throw new Error('X1080X 未登录或 Cookie/CSRF 失效（HTTP ' + res.status + '）')
  }
  if (res.status !== 200) {
    throw new Error('X1080X 请求失败（HTTP ' + res.status + '）')
  }
  let data = res.data
  if (!data && res.body) {
    const body = String(res.body).trim()
    if (!body || /^<!doctype|^<html/i.test(body)) {
      throw new Error('X1080X 返回了登录页，Cookie 可能失效或未登录')
    }
    try {
      data = JSON.parse(body)
    } catch (_) {
      throw new Error('X1080X 返回的不是 JSON')
    }
  }
  if (!data || typeof data !== 'object') throw new Error('X1080X 响应结构异常')
  return data
}

function isPinned(item) {
  const scope = Number(item && item.sticky_scope)
  return Number.isFinite(scope) && scope > 0
}

function uniq(values) {
  return Array.from(new Set(values.filter(Boolean)))
}

function pickBody(payload) {
  const candidates = [
    payload && payload.body,
    payload && payload.state && payload.state.body,
    payload && payload.data && payload.data.body,
    payload && payload.data && payload.data.state && payload.data.state.body,
    payload && payload.text,
    payload && payload.state && payload.state.text,
    payload && payload.data && payload.data.text
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value
    if (value && typeof value === 'object' && typeof value.html === 'string' && value.html.trim()) return value.html
    if (value && typeof value === 'object' && typeof value.text === 'string' && value.text.trim()) return value.text
  }
  const nodes = (payload && payload.nodes) || (payload && payload.state && payload.state.nodes)
  if (Array.isArray(nodes)) {
    const html = nodes.map(node => {
      if (!node || typeof node !== 'object') return ''
      return typeof node.html === 'string' ? node.html : (typeof node.text === 'string' ? node.text : '')
    }).join('')
    if (html.trim()) return html
  }
  return ''
}

function parseDetail(payload, detailUrl, fallbackTitle, htmlLoad) {
  const result = {
    title: fallbackTitle || '',
    published_at: '',
    category: '',
    preview_images: [],
    magnets: [],
    edk: [],
    size: '',
    archive_names: [],
    archive_passwords: [],
    access_denied: false
  }
  if (!payload || typeof payload !== 'object') return result

  if (payload.access_denied || payload.read === false || payload.allowed === false) {
    result.access_denied = true
  }

  const body = pickBody(payload)
  if (!body) return result

  const doc = htmlLoad ? htmlLoad(body, detailUrl) : null
  const text = doc ? doc.text() : body

  const title = doc && doc.find('.thread-header h1').first().text()
  if (title) result.title = title

  const category = doc && doc.find('.thread-header .topic-category').first().text()
  if (category) result.category = category

  const images = doc ? doc.find('img').map(item => item.url('src')) : []
  result.preview_images = uniq(images.map(url => String(url || '').trim()))
    .filter(url => /^https?:\/\//i.test(url))
    .filter(url => !/\/static\/image\/|\/images\/smilies\//i.test(url))
    .slice(0, 8)

  const raw = String(body).replace(/&amp;/g, '&')
  result.magnets = uniq(raw.match(MAGNET_RE) || []).slice(0, 20)
  result.edk = uniq(raw.match(ED2K_RE) || []).slice(0, 20)

  const size = text.match(/(\d+(?:\.\d+)?)\s*(TB|GB|MB|G|M)/i)
  if (size) result.size = size[1] + size[2].toUpperCase()

  const names = text.match(/[^\s<>"']+\.(?:zip|rar|7z|tar\.gz)/gi) || []
  result.archive_names = uniq(names).slice(0, 20)

  const passwords = text.match(/(?:解压密码|压缩密码|密码|提取码|pass(?:word)?)\s*[:：=]?\s*([A-Za-z0-9._-]{2,64})/gi) || []
  result.archive_passwords = uniq(passwords.map(item => item.replace(/^.*?[:：=]\s*/, '').trim())).slice(0, 10)

  return result
}

// ctx.html 只在后台 ctx 上可用；由 run 传入 htmlLoad。

async function cacheCover(ctx, settings, headers, article) {
  if (!settings.cache_images || !article.preview_images.length) return
  const source = article.preview_images[0]
  if (!/^https?:\/\//i.test(source)) return
  article.cover_remote = source
  try {
    await ctx.files.call({ operation: 'mkdir', path: 'images' })
  } catch (_) {
    // 目录可能已存在
  }
  const path = 'images/' + article.id + '.jpg'
  try {
    const saved = await ctx.http.request({
      url: source,
      method: 'GET',
      headers: { ...headers, Accept: 'image/*' },
      session: SESSION,
      timeout_seconds: 30,
      save_to: path
    })
    if (saved && saved.path) article.cover = saved.path
  } catch (error) {
    await log(ctx, '封面缓存失败 ' + article.id + '：' + error.message)
  }
}

async function buildArticle(ctx, settings, headers, boardId, item, htmlLoad) {
  const id = String(item.id || '').trim()
  if (!id) return null
  const article = {
    id,
    website: 'x1080x',
    board_id: boardId,
    board_name: BOARDS[boardId] || boardId,
    title: String(item.title || '').trim(),
    published_at: String(item.published_at || ''),
    category: String(item.category_name || ''),
    detail_url: BASE + '/resources/' + encodeURIComponent(id),
    preview_images: [],
    magnets: [],
    edk: [],
    size: '',
    archive_names: [],
    archive_passwords: [],
    cover: '',
    cover_remote: '',
    access_denied: false,
    detail_error: ''
  }

  try {
    const payload = await fetchJson(
      ctx,
      headers,
      '/api/resources/' + encodeURIComponent(id) + '/state',
      45
    )
    const parsed = parseDetail(payload, article.detail_url, article.title, htmlLoad)
    article.title = parsed.title || article.title
    article.published_at = article.published_at || parsed.published_at
    article.category = parsed.category || article.category
    article.preview_images = parsed.preview_images
    article.magnets = parsed.magnets
    article.edk = parsed.edk
    article.size = parsed.size
    article.archive_names = parsed.archive_names
    article.archive_passwords = parsed.archive_passwords
    article.access_denied = parsed.access_denied
  } catch (error) {
    article.detail_error = error.message
    await log(ctx, '详情失败 ' + id + '：' + error.message)
  }

  await cacheCover(ctx, settings, headers, article)
  return article
}

export async function run(ctx, input) {
  const htmlLoad = (body, baseURL) => ctx.html.load(body, { baseURL })

  const settings = normalizeSettings(await ctx.storage.get('avdb-settings'))
  if (!settings.cookie) {
    throw new Error('请先在 AVDB Lite 设置里填写 X1080X Cookie')
  }
  if (!settings.boards.length) {
    throw new Error('请至少选择一个 X1080X 板块')
  }

  const headers = headersFor(settings)
  const articles = []
  let done = 0
  let failed = 0
  const total = settings.max_items

  await ctx.task.update({
    stage: 'listing',
    message: '开始抓取 X1080X',
    total,
    done,
    failed
  })

  for (const boardId of settings.boards) {
    if (articles.length >= settings.max_items) break
    for (let page = 1; page <= settings.pages; page++) {
      if (articles.length >= settings.max_items) break
      let items = []
      try {
        const data = await fetchJson(
          ctx,
          headers,
          '/api/catalog/resources?board_id=' + encodeURIComponent(boardId) + '&page=' + page
        )
        if (data.read_locked) throw new Error('该板块需要登录/权限')
        if (!Array.isArray(data.items)) throw new Error('列表 items 结构异常')
        items = data.items.filter(item => item && item.id && !isPinned(item))
      } catch (error) {
        failed++
        await log(ctx, '列表失败 ' + (BOARDS[boardId] || boardId) + ' 第 ' + page + ' 页：' + error.message)
        continue
      }

      for (const item of items) {
        if (articles.length >= settings.max_items) break
        const article = await buildArticle(ctx, settings, headers, boardId, item, htmlLoad)
        if (article) articles.push(article)
        done++
        await ctx.task.update({
          stage: 'detail',
          message: (BOARDS[boardId] || boardId) + ' 第 ' + page + ' 页',
          total,
          done,
          failed
        })
        await ctx.sleep(350)
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
  unique.sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')))

  await ctx.storage.set('avdb-articles', unique)
  await ctx.storage.set('avdb-last-run', {
    at: new Date().toISOString(),
    count: unique.length,
    done,
    failed,
    boards: settings.boards,
    pages: settings.pages
  })

  await ctx.task.update({
    stage: 'done',
    message: '抓取完成，共 ' + unique.length + ' 条',
    total: unique.length,
    done: unique.length,
    failed
  })
  return { count: unique.length, failed }
}

// 本任务只写插件 KV 和插件自有图片缓存；重启后重跑是幂等的。
export async function recover(ctx, checkpoint) {
  return { action: 'resume' }
}
