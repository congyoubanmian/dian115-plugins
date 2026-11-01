// 豆瓣中心 —— 插件页面（v3 ui/page.js，导出 mount(el, ctx)）。
//
// 旧 Vue 前端源码已按用户要求删除；本文件按 v3/douban-rs/README.md 的功能表与
// jobs 的实际能力，用原生 JS + DOM 重写。数据面全部来自后端已经落盘的
// storage `state` 键（与 jobs 共用 lib/model.js 的解析契约）和宿主设置 KV
// （ctx.settings.get）；动作一律 ctx.tasks.run(<job>, business_key, input)
// 提交到宿主任务队列，再轮询到终态。海报经页面 ctx.http 带豆瓣 Referer 取回
// （豆瓣 CDN 无 Referer 返回 418），失败时回退后端 get-poster job。
//
// 页面只呈现真实状态：缺数据就说缺什么、下一步点哪里，不造任何假数据。

import { parseStateDoc, sanitizeSettingsView, defaultSettings, isRecognizable } from '../lib/model.js'
import { normalizeFlat, FLAT_DEFAULTS } from '../lib/settings.js'
import { NO_RESUB_CONFIRM_TEXT, FILTERED_QUEUE_STATE, NO_RESUB_QUEUE_STATE } from '../lib/filter-core.js'

/** 任务轮询间隔（宿主任务队列是异步的）。 */
const POLL_INTERVAL_MS = 900
/** 页面等待任务终态的上限；超过则提示去宿主任务记录看，页面不假装失败。 */
const POLL_TIMEOUT_MS = 150_000
/** 海报并发（页面 ctx.http 请求，不占宿主任务队列）。 */
const POSTER_CONCURRENCY = 4
/** 页面内存海报缓存条数（data URL，每张 ≤ 128 KiB）。 */
const POSTER_CACHE_LIMIT = 160
/** 页面直连海报的 base64 上限；超过就交给后端 get-poster 的 128 KiB 规则。 */
const MAX_POSTER_B64 = 400_000

const LIST_ORDER = ['upcoming', 'hot', 'cn_wom', 'global_wom', 'movie_wom']
const LIST_META = {
  upcoming: { name: '即将上映', hint: 'coming_html · movie' },
  hot: { name: '热门电影', hint: 'subjects_json · movie / 热门' },
  cn_wom: { name: '国产剧口碑', hint: 'subjects_json · tv / 国产剧' },
  global_wom: { name: '欧美口碑', hint: 'subjects_json · movie / 欧美' },
  movie_wom: { name: '一周口碑榜', hint: 'chart_html · movie' },
}
const TYPE_LABEL = { movie: '电影', tv: '剧集' }
const SOURCE_LABEL = {
  subjects_json: 'JSON 榜单',
  coming_html: '即将上映 HTML',
  chart_html: '一周口碑榜 HTML',
}
const QUEUE_STATE_META = {
  observing: { label: '观察中', cls: 'warn' },
  subscribed: { label: '已订阅', cls: 'ok' },
  needs_review: { label: '待人工确认', cls: 'error' },
  [FILTERED_QUEUE_STATE]: { label: '已过滤', cls: 'muted' },
  [NO_RESUB_QUEUE_STATE]: { label: '墓碑拦截', cls: 'muted' },
}
const ACTION_LABELS = {
  refresh: '刷新榜单',
  'wish-sync-now': '同步想看',
  subscribe: '订阅条目',
  'subscribe-now': '立即订阅',
  'observe-remove': '移出观察队列',
  'blacklist-add': '添加黑名单',
  'blacklist-remove': '移除黑名单',
  archive: '归档历史与日志',
  'no-resub-clear': '清除重订限制',
  'send-test': '通知自检',
  'cookiecloud-test': 'CookieCloud 测试',
  'settings-update': '保存设置',
}
const BUSY_TEXT = {
  refresh: '正在抓取豆瓣榜单（前台预算约 6.5 秒，订阅交给后台）…',
  'wish-sync-now': '正在拉取「我的想看」并入队…',
  subscribe: '正在 TMDB 匹配并创建聚合订阅…',
  'subscribe-now': '正在为队列条目匹配并订阅…',
  'observe-remove': '正在移出观察队列…',
  'blacklist-add': '正在保存黑名单关键词…',
  'blacklist-remove': '正在移除黑名单关键词…',
  archive: '正在归档历史与日志…',
  'no-resub-clear': '正在清除重订限制…',
  'send-test': '正在发送测试通知…',
  'cookiecloud-test': '正在读取 CookieCloud 并校验豆瓣登录…',
  'settings-update': '正在保存设置（状态文档 + 宿主设置 KV）…',
}

export async function mount(root, ctx) {
  const doc = root.ownerDocument
  const view = doc.defaultView
  const disposed = { value: false }

  // ─────────────────────────── 状态 ───────────────────────────

  let stateDoc = null
  let rawState = null
  let rawSettings = {}
  let flat = { ...FLAT_DEFAULTS }
  let settingsView = null
  let stateError = ''
  let stateInvalid = false
  let settingsError = ''
  let busy = ''
  let activeTab = 'charts'
  let settingsInputs = null
  let queueIndex = new Map()

  // ─────────────────────────── 骨架 ───────────────────────────

  const style = doc.createElement('style')
  style.textContent = CSS_TEXT
  root.append(style)

  const page = doc.createElement('main')
  page.className = 'db3'
  root.append(page)

  const el = (tag, className, text) => {
    const node = doc.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = text
    return node
  }
  const text = (value, fallback = '') => {
    if (typeof value === 'string') return value
    if (value === null || value === undefined) return fallback
    return String(value)
  }
  const num = (value, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
  const icon = (paths, size = 16) => {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', String(size))
    svg.setAttribute('height', String(size))
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    const group = doc.createElementNS('http://www.w3.org/2000/svg', 'g')
    group.innerHTML = paths
    svg.append(group)
    return svg
  }
  const ICONS = {
    film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M17 8h4M3 16h4M17 16h4"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8z"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    reload: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    external: '<path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
    cloud: '<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 0 9H7a5 5 0 0 1-3-2.1z"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
  }

  // ─────────────────────────── Toast ───────────────────────────

  const toastBox = el('div', 'db-toasts')
  page.append(toastBox)
  function toast(kind, message) {
    if (disposed.value) return
    const node = el('div', `db-toast db-toast-${kind}`, message)
    toastBox.append(node)
    setTimeout(() => node.remove(), 5000)
  }
  const errorText = (error) => String(error?.message ?? error ?? '未知错误')

  // ─────────────────────────── 页头 ───────────────────────────

  const header = el('header', 'db3-head')
  const brand = el('div', 'db-brand')
  const brandIcon = el('span', 'db-brand-icon')
  brandIcon.append(icon(ICONS.film, 22))
  const brandText = el('div', 'db-brand-text')
  brandText.append(
    el('h1', null, '豆瓣中心'),
    el('p', null, '榜单抓取 · 黑名单过滤 · 观察队列 · 我的想看 · 聚合订阅'),
  )
  brand.append(brandIcon, brandText)

  const headerActions = el('div', 'db-actions')
  const capsuleSnapshot = el('span', 'db-capsule db-capsule-muted', '榜单 · 未刷新')
  const capsuleQueue = el('span', 'db-capsule db-capsule-muted', '队列 0 · 想看 0')
  const btnRefresh = actionButton('刷新榜单', 'primary', () => runAction('refresh', {}))
  const btnWish = actionButton('同步想看', 'secondary', () => runAction('wish-sync-now', {}))
  const btnReload = actionButton('重读', 'ghost', () => { void refreshUi() }, ICONS.reload)
  const btnSettings = actionButton('设置', 'ghost', () => showTab('settings'), ICONS.gear)
  headerActions.append(capsuleSnapshot, capsuleQueue, btnRefresh, btnWish, btnReload, btnSettings)
  header.append(brand, headerActions)
  page.append(header)

  const progress = el('p', 'db-progress')
  progress.hidden = true
  page.append(progress)

  // ─────────────────────────── 指标与提示 ───────────────────────────

  const tiles = el('section', 'db-tiles')
  page.append(tiles)

  const banners = el('div', 'db-banners')
  page.append(banners)

  // ─────────────────────────── Tabs ───────────────────────────

  const nav = el('nav', 'db-tabs')
  const tabButtons = {}
  const tabDefs = [
    ['charts', '榜单'],
    ['queue', '队列与想看'],
    ['history', '历史与日志'],
    ['settings', '设置'],
  ]
  for (const [key, label] of tabDefs) {
    const button = el('button', 'db-tab')
    button.type = 'button'
    button.append(doc.createTextNode(label), el('span', 'db-tab-count', '0'))
    button.addEventListener('click', () => showTab(key))
    tabButtons[key] = button
    nav.append(button)
  }
  page.append(nav)

  const panels = el('div', 'db-panels')
  page.append(panels)
  const chartsPanel = el('section', 'db-panel')
  const queuePanel = el('section', 'db-panel')
  const historyPanel = el('section', 'db-panel')
  const settingsPanel = el('section', 'db-panel')
  panels.append(chartsPanel, queuePanel, historyPanel, settingsPanel)

  const footer = el('footer', 'db-foot')
  footer.append(el('span', null, '数据来自插件存储 state 键与宿主设置 KV；动作通过宿主任务队列执行。'))
  page.append(footer)

  // ─────────────────────────── 通用 DOM 工具 ───────────────────────────

  function clear(node) {
    node.textContent = ''
  }

  function actionButton(label, kind = 'primary', onClick, iconPaths) {
    const button = el('button', `db-btn db-btn-${kind}`)
    button.type = 'button'
    button.setAttribute('data-busy-lock', '1')
    if (iconPaths) button.append(icon(iconPaths, 14), doc.createTextNode(label))
    else button.textContent = label
    button.addEventListener('click', () => { void onClick() })
    return button
  }

  function linkButton(label, href, kind = 'ghost', small = false) {
    const link = el('a', `db-btn db-btn-${kind}`, label)
    link.href = href
    link.target = '_blank'
    link.rel = 'noreferrer noopener'
    if (small) link.classList.add('db-btn-sm')
    return link
  }

  function smallButton(label, onClick, kind = 'ghost') {
    const button = actionButton(label, kind, onClick)
    button.classList.add('db-btn-sm')
    return button
  }

  function badge(label, cls = 'muted') {
    return el('span', `db-badge db-badge-${cls}`, label)
  }

  function field(labelText, control, help) {
    const row = el('div', 'db-field')
    if (control && typeof control.setAttribute === 'function') control.setAttribute('aria-label', labelText)
    row.append(el('span', 'db-field-label', labelText), control)
    if (help) row.append(el('span', 'db-field-help', help))
    return row
  }

  function textInput(value, placeholder) {
    const input = el('input', 'db-input')
    input.type = 'text'
    input.value = text(value)
    if (placeholder) input.placeholder = placeholder
    return input
  }

  function numberInput(value, attrs = {}) {
    const input = el('input', 'db-input')
    input.type = 'number'
    input.value = String(value ?? 0)
    if (attrs.min !== undefined) input.min = String(attrs.min)
    if (attrs.max !== undefined) input.max = String(attrs.max)
    if (attrs.step !== undefined) input.step = String(attrs.step)
    return input
  }

  function selectInput(value, options) {
    const list = options.slice()
    if (!list.some(([optionValue]) => optionValue === value)) list.unshift([value, `未知：${value}`])
    const select = el('select', 'db-select')
    for (const [optionValue, label] of list) {
      const option = el('option', null, label)
      option.value = optionValue
      option.selected = optionValue === value
      select.append(option)
    }
    return select
  }

  function switchRow(labelText, checked, help) {
    const row = el('label', 'db-switch-row')
    const textWrap = el('span', 'db-switch-text')
    textWrap.append(el('span', 'db-field-label', labelText))
    if (help) textWrap.append(el('span', 'db-field-help', help))
    const control = el('span', 'db-switch')
    const input = el('input')
    input.type = 'checkbox'
    input.checked = Boolean(checked)
    control.append(input, el('span', 'db-track'))
    row.append(textWrap, control)
    return { row, input }
  }

  function secretRow(labelText, placeholder, help) {
    const wrap = el('div', 'db-secret')
    const input = el('input', 'db-input')
    input.type = 'password'
    input.autocomplete = 'new-password'
    input.placeholder = placeholder
    input.setAttribute('aria-label', labelText)
    const clearRow = el('label', 'db-clear')
    const clearInput = el('input')
    clearInput.type = 'checkbox'
    clearRow.append(clearInput, doc.createTextNode('清除已保存的值'))
    wrap.append(input, clearRow)
    return { row: field(labelText, wrap, help), input, clear: clearInput }
  }

  function cardBlock(title, subtitle) {
    const section = el('section', 'db-card-block')
    const head = el('div', 'db-block-head')
    const textWrap = el('div', 'db-block-text')
    textWrap.append(el('h2', null, title))
    if (subtitle) textWrap.append(el('p', 'db-block-sub', subtitle))
    head.append(textWrap)
    section.append(head)
    const body = el('div', 'db-block-body')
    section.append(body)
    return { section, head, body }
  }

  function emptyState(message, note) {
    const box = el('div', 'db-empty')
    box.append(el('p', null, message))
    if (note) box.append(el('p', 'db-empty-note', note))
    return box
  }

  function banner(kind, message) {
    const node = el('div', `db-banner db-banner-${kind}`)
    node.append(el('span', 'db-banner-dot'), doc.createTextNode(message))
    return node
  }

  function addKv(container, label, value) {
    const cell = el('div', 'db-kv')
    cell.append(el('span', 'db-kv-label', label), el('span', 'db-kv-value', value === '' ? '—' : value))
    container.append(cell)
  }

  function formatTime(value) {
    if (typeof value !== 'string' || value.trim() === '') return ''
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) return value
    const date = new Date(parsed)
    const pad = (n) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  function dueAtMs(item) {
    if (typeof item?.due_at !== 'string' || item.due_at === '') return null
    const parsed = Date.parse(item.due_at)
    return Number.isFinite(parsed) ? parsed : null
  }

  function isDue(item) {
    const due = dueAtMs(item)
    return due !== null && due <= Date.now()
  }

  function dueLabel(item) {
    const due = dueAtMs(item)
    if (due === null) return '待后台处理'
    const diff = due - Date.now()
    if (diff <= 0) return '已到期'
    const hours = Math.ceil(diff / 3_600_000)
    if (hours < 48) return `${hours} 小时后`
    return `${Math.ceil(hours / 24)} 天后`
  }

  function listTitle(key) {
    if (key === 'wish') return '我的想看'
    return LIST_META[key]?.name ?? key
  }

  function listHint(key, config) {
    const parts = []
    if (config?.source) parts.push(SOURCE_LABEL[config.source] ?? config.source)
    if (config?.type) parts.push(TYPE_LABEL[config.type] ?? config.type)
    if (config?.tag) parts.push(config.tag)
    return parts.join(' · ') || LIST_META[key]?.hint || ''
  }

  function docSettings() {
    return stateDoc?.settings ?? defaultSettings()
  }

  function snapshotItems() {
    const lists = stateDoc?.snapshot?.lists ?? {}
    const all = []
    for (const items of Object.values(lists)) if (Array.isArray(items)) all.push(...items)
    return all
  }

  function snapshotListCount() {
    return Object.keys(stateDoc?.snapshot?.lists ?? {}).length
  }

  function tombstoneCount() {
    return Object.keys(stateDoc?.no_resub ?? {}).length
  }

  function doubanHref(item) {
    const direct = text(item?.url)
    if (direct) return direct
    const match = /^db:subj:(.+)$/.exec(text(item?.douban_ref))
    return match ? `https://www.douban.com/subject/${encodeURIComponent(match[1])}/` : ''
  }

  function confirmFn(message) {
    if (view && typeof view.confirm === 'function') return view.confirm(message)
    return false
  }

  function confirmTombstone(doubanRef) {
    const map = stateDoc?.no_resub
    if (map && Object.prototype.hasOwnProperty.call(map, doubanRef)) {
      return confirmFn(NO_RESUB_CONFIRM_TEXT)
    }
    return true
  }

  function rebuildQueueIndex() {
    queueIndex = new Map()
    for (const item of stateDoc?.queue?.items ?? []) {
      if (item?.douban_ref) queueIndex.set(item.douban_ref, item)
    }
  }

  // ─────────────────────────── 海报加载 ───────────────────────────
  //
  // <img> 直接指向 img*.doubanio.com 会因防盗链返回 418；页面用 ctx.http 带
  // Referer 取回 base64；失败（代理/限流/尺寸）回退后端 get-poster job。

  const posterCache = new Map() // url -> dataURL（'' 表示失败）
  const posterTargets = new Map() // url -> Set<{img, ph}>
  const posterQueue = []
  const posterQueued = new Set()
  const posterInflight = new Set()
  let posterActive = 0
  const lazyTargets = new Map() // img -> {img, ph, url}
  let observer = null

  if (view && typeof view.IntersectionObserver === 'function') {
    observer = new view.IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const target = lazyTargets.get(entry.target)
        if (!target) continue
        lazyTargets.delete(entry.target)
        observer.unobserve(entry.target)
        enqueuePoster(target)
      }
    }, { rootMargin: '240px' })
  }

  function attachPoster(img, ph, url) {
    const clean = typeof url === 'string' ? url.trim() : ''
    if (!/^https?:\/\//i.test(clean)) {
      img.hidden = true
      ph.hidden = false
      ph.textContent = '无海报'
      return
    }
    if (posterCache.has(clean)) {
      setPoster(img, ph, posterCache.get(clean))
      return
    }
    const target = { img, ph, url: clean }
    if (observer) {
      lazyTargets.set(img, target)
      observer.observe(img)
    } else {
      enqueuePoster(target)
    }
  }

  function enqueuePoster(target) {
    if (disposed.value) return
    let targets = posterTargets.get(target.url)
    if (!targets) {
      targets = new Set()
      posterTargets.set(target.url, targets)
    }
    targets.add({ img: target.img, ph: target.ph })
    if (!posterCache.has(target.url) && !posterInflight.has(target.url) && !posterQueued.has(target.url)) {
      posterQueued.add(target.url)
      posterQueue.push(target.url)
    }
    pumpPosters()
  }

  function setPoster(img, ph, dataUrl) {
    if (!dataUrl) {
      img.hidden = true
      ph.hidden = false
      ph.textContent = '海报不可用'
      return
    }
    img.hidden = false
    ph.hidden = true
    img.onerror = () => {
      img.hidden = true
      ph.hidden = false
      ph.textContent = '海报加载失败'
    }
    img.src = dataUrl
  }

  function pumpPosters() {
    if (disposed.value) return
    while (posterActive < POSTER_CONCURRENCY && posterQueue.length > 0) {
      const url = posterQueue.shift()
      posterQueued.delete(url)
      if (posterCache.has(url) || posterInflight.has(url)) continue
      posterInflight.add(url)
      posterActive += 1
      void loadPosterData(url)
        .then((dataUrl) => {
          posterCache.set(url, dataUrl || '')
          if (posterCache.size > POSTER_CACHE_LIMIT) {
            for (const key of posterCache.keys()) {
              if (key === url) continue
              posterCache.delete(key)
              break
            }
          }
        })
        .finally(() => {
          posterInflight.delete(url)
          posterActive -= 1
          const targets = posterTargets.get(url)
          posterTargets.delete(url)
          if (targets) {
            const resolved = posterCache.get(url) || ''
            for (const target of targets) {
              if (target.img.isConnected) setPoster(target.img, target.ph, resolved)
            }
          }
          pumpPosters()
        })
    }
  }

  async function loadPosterData(url) {
    try {
      return await fetchPosterDirect(url)
    } catch {
      try {
        return await fetchPosterViaJob(url)
      } catch {
        return ''
      }
    }
  }

  function base64Of(value) {
    if (typeof value === 'string') return value
    if (value instanceof Uint8Array) {
      let binary = ''
      for (const byte of value) binary += String.fromCharCode(byte)
      return btoa(binary)
    }
    return ''
  }

  function headerValue(headers, name) {
    if (!headers || typeof headers !== 'object') return ''
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== name) continue
      return Array.isArray(value) ? text(value[0]) : text(value)
    }
    return ''
  }

  async function fetchPosterDirect(url) {
    const result = await ctx.http.request({
      url,
      method: 'GET',
      headers: {
        Referer: 'https://movie.douban.com/',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      response_type: 'base64',
      timeout_seconds: 30,
      cache_seconds: 3600,
    })
    if (!result || result.status < 200 || result.status >= 300) {
      throw new Error(`HTTP ${result?.status ?? '?'}`)
    }
    const body = base64Of(result.body_base64)
    if (body === '') throw new Error('空响应')
    if (body.length > MAX_POSTER_B64) throw new Error('海报过大')
    const contentType = headerValue(result.headers, 'content-type') || 'image/jpeg'
    if (!contentType.toLowerCase().startsWith('image/')) throw new Error(`非图片内容 ${contentType}`)
    return `data:${contentType.split(';')[0]};base64,${body}`
  }

  async function fetchPosterViaJob(url) {
    const run = await invokeJob('get-poster', { poster_url: url }, POLL_TIMEOUT_MS)
    const result = run?.result && typeof run.result === 'object' ? run.result : {}
    if (result.status === 'succeeded' && typeof result.url === 'string' && result.url.startsWith('data:')) {
      return result.url
    }
    throw new Error(result.message || '海报获取失败')
  }

  function posterNode(posterUrl, title, className = '', pageHref = '') {
    const link = el(pageHref ? 'a' : 'div', `db-poster ${className}`.trim())
    if (pageHref) {
      link.href = pageHref
      link.target = '_blank'
      link.rel = 'noreferrer noopener'
    }
    const img = el('img')
    img.alt = title ? `${title} 海报` : '海报'
    img.decoding = 'async'
    img.hidden = true
    const ph = el('span', 'db-poster-ph', '海报')
    link.append(img, ph)
    attachPoster(img, ph, posterUrl)
    return link
  }

  // ─────────────────────────── 任务执行 ───────────────────────────

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function businessKey(name) {
    return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  async function invokeJob(name, input, timeoutMs = POLL_TIMEOUT_MS) {
    const run = await ctx.tasks.run(name, businessKey(name), input ?? {})
    return pollRun(run, timeoutMs)
  }

  async function pollRun(run, timeoutMs = POLL_TIMEOUT_MS) {
    let current = run
    const started = Date.now()
    while (current && (current.status === 'queued' || current.status === 'running')) {
      if (disposed.value || ctx.signal?.aborted) {
        throw new Error('页面已关闭，任务会在后台继续')
      }
      if (Date.now() - started > timeoutMs) {
        return {
          ...current,
          status: 'running',
          message: `任务仍在运行（#${current.id ?? '?'}），可到宿主任务记录查看`,
        }
      }
      await sleep(POLL_INTERVAL_MS)
      current = await ctx.tasks.get(current.id)
    }
    return current
  }

  function reportRun(label, run) {
    const rawResult = run?.result
    const result = rawResult && typeof rawResult === 'object' ? rawResult : {}
    const message = text(
      result.message ||
        (typeof rawResult === 'string' ? rawResult : '') ||
        run?.message ||
        run?.error,
    )
    if (run?.status === 'running') {
      toast('info', message || `${label}仍在后台运行`)
    } else if (run?.status === 'failed' || result.status === 'failed') {
      toast('error', message || `${label}失败`)
    } else if (run?.status === 'cancelled') {
      toast('warning', `${label}已取消`)
    } else {
      toast('success', message || `${label}完成`)
    }
    if (result.no_resub_confirm) toast('warning', text(result.no_resub_confirm))
  }

  async function runAction(name, input, options = {}) {
    if (busy !== '' || disposed.value) return
    if (options.confirm && !confirmFn(options.confirm)) return
    if (options.tombstoneRef && !confirmTombstone(options.tombstoneRef)) return
    const label = options.label || ACTION_LABELS[name] || name
    setBusy(name)
    try {
      const finished = await invokeJob(name, input)
      if (!disposed.value) reportRun(label, finished)
    } catch (error) {
      if (!disposed.value) toast('error', errorText(error))
    } finally {
      if (!disposed.value) {
        setBusy('')
        await refreshUi()
      }
    }
  }

  function setBusy(name) {
    busy = name
    progress.hidden = name === ''
    clear(progress)
    if (name !== '') {
      progress.append(el('span', 'db-spinner'), doc.createTextNode(BUSY_TEXT[name] || '正在执行…'))
    }
    const locked = page.querySelectorAll('[data-busy-lock]')
    for (const node of locked) node.disabled = name !== ''
    if (name === '') {
      // 重新渲染后按钮的 disabled 状态由 render 重算
      for (const button of [btnRefresh, btnWish, btnReload, btnSettings]) button.disabled = false
    }
  }

  // ─────────────────────────── 数据加载 ───────────────────────────

  async function loadData() {
    let nextRaw = null
    stateDoc = null
    rawState = null
    stateError = ''
    stateInvalid = false
    settingsError = ''
    try {
      nextRaw = await ctx.storage.get('state')
      if (nextRaw !== null && nextRaw !== undefined && nextRaw !== '') {
        rawState = typeof nextRaw === 'object' ? nextRaw : null
        const parsed = parseStateDoc(nextRaw)
        if (parsed === null || !isRecognizable(parsed)) {
          stateInvalid = true
          stateError = '存储里的 state 文档无法识别（不是本插件的状态文档，或字段类型不符）；为避免覆盖异常数据，页面只展示空状态。'
        } else {
          stateDoc = parsed
        }
      }
    } catch (error) {
      // 404 = 全新安装，还没有状态文档，不是错误。
      if (error?.status !== 404) stateError = `读取 state 存储失败：${errorText(error)}`
    }
    try {
      rawSettings = (await ctx.settings.get()) ?? {}
    } catch (error) {
      rawSettings = {}
      settingsError = `读取宿主设置失败：${errorText(error)}`
    }
    flat = normalizeFlat(rawSettings)
    // 与 jobs/runtime.js Session.settings 的账号覆盖保持一致：清单设置为空时，
    // 状态文档里的旧账号字段仍生效。
    const legacy = stateDoc?.settings
    if (legacy) {
      if (legacy.cookiecloud_url && !flat.cookiecloud_url) flat.cookiecloud_url = legacy.cookiecloud_url
      if (legacy.cookiecloud_uuid && !flat.cookiecloud_uuid) flat.cookiecloud_uuid = legacy.cookiecloud_uuid
      if (legacy.cookiecloud_key && !flat.cookiecloud_key) flat.cookiecloud_key = legacy.cookiecloud_key
      if (legacy.manual_cookie && !flat.manual_cookie) flat.manual_cookie = legacy.manual_cookie
      if (legacy.wish_sync_enabled && !flat.wish_sync_enabled) flat.wish_sync_enabled = true
    }
    settingsView = stateDoc ? sanitizeSettingsView(stateDoc.settings) : null
    rebuildQueueIndex()
    if (!disposed.value) render()
  }

  async function refreshUi() {
    try {
      await loadData()
    } catch (error) {
      if (!disposed.value) toast('error', `界面刷新失败：${errorText(error)}`)
    }
  }

  // ─────────────────────────── 渲染：页头/指标/提示 ───────────────────────────

  function renderHeader() {
    const snapshotAt = stateDoc?.snapshot?.fetched_at || text(rawState?.last_run)
    capsuleSnapshot.textContent = snapshotAt ? `榜单 · ${formatTime(snapshotAt)}` : '榜单 · 未刷新'
    capsuleSnapshot.className = `db-capsule ${snapshotAt ? 'db-capsule-ok' : 'db-capsule-muted'}`
    const queueCount = (stateDoc?.queue?.items ?? []).length
    const wishCount = (stateDoc?.wish ?? []).length
    capsuleQueue.textContent = `队列 ${queueCount} · 想看 ${wishCount}`
    const due = (stateDoc?.queue?.items ?? []).filter(isDue).length
    capsuleQueue.className = `db-capsule ${due > 0 ? 'db-capsule-warn' : 'db-capsule-muted'}`
    btnRefresh.disabled = busy !== ''
    btnWish.disabled = busy !== ''
    btnReload.disabled = busy !== ''
    btnSettings.disabled = busy !== ''
  }

  function renderTiles() {
    clear(tiles)
    const items = snapshotItems()
    const queue = stateDoc?.queue?.items ?? []
    const wish = stateDoc?.wish ?? []
    const stats = stateDoc?.stats ?? {}
    const blacklist = docSettings().blacklist ?? []
    const due = queue.filter(isDue).length
    const defs = [
      ['榜单条目', String(items.length), `${snapshotListCount()} 个榜单 · ${formatTime(stateDoc?.snapshot?.fetched_at) || '尚未刷新'}`],
      ['观察队列', String(queue.length), due > 0 ? `${due} 条已到期` : '暂无到期条目'],
      ['我的想看', String(wish.length), stateDoc?.wish_info?.last_sync ? `上次同步 ${formatTime(stateDoc.wish_info.last_sync)}` : '尚未同步'],
      ['累计订阅', String(num(stats.total)), `本月 +${num(stats.month_new)}${stats.month ? `（${stats.month}）` : ''}`],
      ['黑名单命中', String(num(stateDoc?.blackstate?.hits)), `${blacklist.length} 个关键词`],
      ['已删除不重订', String(tombstoneCount()), tombstoneCount() > 0 ? '自动订阅会跳过' : '暂无墓碑'],
    ]
    for (const [label, value, hint] of defs) {
      const tile = el('div', 'db-tile')
      tile.append(el('span', 'db-tile-label', label), el('strong', 'db-tile-value', value), el('span', 'db-tile-hint', hint))
      tiles.append(tile)
    }
  }

  function renderBanners() {
    clear(banners)
    if (stateError) banners.append(banner('error', stateError))
    if (settingsError) banners.append(banner('warning', settingsError))
    if (stateInvalid) {
      banners.append(banner('warning', '页面不会覆盖无法识别的旧数据；如需重新开始，请先在宿主存储里处理 state 键。'))
    }
    if (!stateDoc && !stateError) {
      banners.append(banner('info', '全新安装：还没有榜单快照。点击「刷新榜单」抓取第一轮数据；想看同步需要先配置 CookieCloud 或手动 cookie。'))
    }
    if (stateDoc && !stateDoc.snapshot?.fetched_at) {
      banners.append(banner('info', '当前还没有榜单快照。点击右上角「刷新榜单」，后台会按已启用的榜单逐项抓取。'))
    }
  }

  // ─────────────────────────── 渲染：榜单 ───────────────────────────

  function createChartCard(item) {
    const card = el('article', 'db-item')
    card.append(posterNode(item.poster_url, item.title, '', doubanHref(item)))
    const body = el('div', 'db-item-body')

    const title = doubanHref(item)
    const titleNode = title ? el('a', 'db-item-title', item.title || '(无标题)') : el('span', 'db-item-title', item.title || '(无标题)')
    if (title) {
      titleNode.href = title
      titleNode.target = '_blank'
      titleNode.rel = 'noreferrer noopener'
    }
    body.append(titleNode)

    const meta = el('div', 'db-item-meta')
    if (item.rate && item.rate !== '0') meta.append(el('span', 'db-rate', `★ ${item.rate}`))
    if (item.year) meta.append(el('span', null, item.year))
    if (item.rank) meta.append(el('span', null, `第 ${item.rank} 名`))
    if (num(item.hotness) > 0) meta.append(el('span', null, `热度 ${item.hotness}`))
    if (meta.children.length > 0) body.append(meta)

    const queueItem = queueIndex.get(item.douban_ref)
    if (queueItem) {
      const stateMeta = QUEUE_STATE_META[queueItem.state] ?? { label: queueItem.state || '在队列', cls: 'muted' }
      body.append(badge(stateMeta.label, stateMeta.cls))
    }

    const actions = el('div', 'db-item-actions')
    if (queueItem?.state === 'subscribed') {
      const done = smallButton('已订阅', () => {}, 'ghost')
      done.disabled = true
      actions.append(done)
    } else {
      actions.append(smallButton('订阅', () => {
        void runAction('subscribe', { douban_ref: item.douban_ref }, {
          label: `订阅「${item.title || item.douban_ref}」`,
          tombstoneRef: item.douban_ref,
        })
      }, 'primary'))
    }
    if (title) actions.append(linkButton('豆瓣', title, 'ghost', true))
    body.append(actions)
    card.append(body)
    return card
  }

  function renderCharts() {
    clear(chartsPanel)
    const head = el('div', 'db-panel-head')
    const headText = el('div')
    headText.append(
      el('h2', null, '榜单与海报墙'),
      el('p', 'db-panel-sub', `快照时间：${formatTime(stateDoc?.snapshot?.fetched_at) || '尚未刷新'}。海报经宿主 HTTP 带豆瓣 Referer 获取。`),
    )
    head.append(headText)
    chartsPanel.append(head)

    const lists = stateDoc?.snapshot?.lists
    if (!lists || typeof lists !== 'object' || Object.keys(lists).length === 0) {
      chartsPanel.append(emptyState(
        '还没有榜单快照。',
        '点击右上角「刷新榜单」按已启用的榜单抓取；抓取完成后，通过黑名单/过滤器的条目会进入观察队列。',
      ))
      return
    }

    const keys = Object.keys(lists).sort((a, b) => {
      const ai = LIST_ORDER.indexOf(a)
      const bi = LIST_ORDER.indexOf(b)
      if (ai === -1 && bi === -1) return a.localeCompare(b)
      if (ai === -1) return 1
      if (bi === -1) return -1
      return ai - bi
    })
    for (const key of keys) {
      const items = Array.isArray(lists[key]) ? lists[key] : []
      const config = docSettings().lists?.[key]
      const block = el('section', 'db-list-block')
      const listHead = el('div', 'db-list-head')
      const listText = el('div', 'db-list-text')
      listText.append(
        el('h3', null, listTitle(key)),
        el('p', 'db-list-sub', `${listHint(key, config)} · ${items.length} 条`),
      )
      listHead.append(listText)
      if (config?.enabled === false) listHead.append(badge('已在设置里停用', 'muted'))
      block.append(listHead)
      if (items.length === 0) {
        block.append(emptyState('本轮该榜单没有条目。', '抓取失败或榜单为空时后端会在日志里记录原因。'))
      } else {
        const grid = el('div', 'db-poster-grid')
        for (const item of items) grid.append(createChartCard(item))
        block.append(grid)
      }
      chartsPanel.append(block)
    }
  }

  // ─────────────────────────── 渲染：队列与想看 ───────────────────────────

  function createQueueRow(item) {
    const row = el('article', 'db-queue-item')
    row.append(posterNode(item.poster_url, item.title, 'db-thumb', doubanHref(item)))
    const main = el('div', 'db-queue-main')

    const href = doubanHref(item)
    const title = href ? el('a', 'db-item-title', item.title || '(无标题)') : el('span', 'db-item-title', item.title || '(无标题)')
    if (href) {
      title.href = href
      title.target = '_blank'
      title.rel = 'noreferrer noopener'
    }
    main.append(title)

    const stateMeta = QUEUE_STATE_META[item.state] ?? { label: item.state || '状态未知', cls: 'muted' }
    const meta = el('div', 'db-item-meta')
    meta.append(badge(stateMeta.label, stateMeta.cls))
    if (item.list) meta.append(el('span', null, `来源 ${listTitle(item.list)}`))
    if (item.media_type) meta.append(el('span', null, TYPE_LABEL[item.media_type] ?? item.media_type))
    if (item.year) meta.append(el('span', null, item.year))
    if (num(item.rating) > 0) meta.append(el('span', 'db-rate', `★ ${item.rating}`))
    main.append(meta)

    const due = el('div', 'db-queue-due')
    due.append(
      el('span', null, `观察到期：${dueLabel(item)}`),
      el('span', 'db-mono', item.due_at ? formatTime(item.due_at) : '—'),
    )
    main.append(due)

    if (item.tmdb_ref) main.append(el('p', 'db-mono db-queue-extra', `TMDB：${item.tmdb_ref}`))
    if (num(item.attempt) > 0) main.append(el('p', 'db-queue-extra', `尝试 ${item.attempt} 次`))
    if (item.last_error) main.append(el('p', 'db-error-text', item.last_error))

    const actions = el('div', 'db-queue-actions')
    if (item.state === 'subscribed') {
      const done = smallButton('已订阅', () => {}, 'ghost')
      done.disabled = true
      actions.append(done)
    } else {
      actions.append(smallButton('立即订阅', () => {
        void runAction('subscribe-now', { douban_ref: item.douban_ref }, {
          label: `立即订阅「${item.title || item.douban_ref}」`,
          tombstoneRef: item.douban_ref,
        })
      }, 'primary'))
    }
    actions.append(smallButton('移出', () => {
      void runAction('observe-remove', { douban_ref: item.douban_ref }, {
        label: `移出「${item.title || item.douban_ref}」`,
      })
    }, 'danger'))
    if (href) actions.append(linkButton('豆瓣', href, 'ghost', true))
    row.append(main, actions)
    return row
  }

  function createWishRow(item) {
    const row = el('article', 'db-wish-item')
    row.append(posterNode(item.poster_url, item.title, 'db-thumb-sm', doubanHref(item)))
    const main = el('div', 'db-wish-main')
    const href = doubanHref(item)
    const title = href ? el('a', 'db-item-title', item.title || '(无标题)') : el('span', 'db-item-title', item.title || '(无标题)')
    if (href) {
      title.href = href
      title.target = '_blank'
      title.rel = 'noreferrer noopener'
    }
    main.append(title)
    const meta = el('div', 'db-item-meta')
    if (item.type) meta.append(badge(TYPE_LABEL[item.type] ?? item.type, 'info'))
    if (item.year) meta.append(el('span', null, item.year))
    if (num(item.rating) > 0) meta.append(el('span', 'db-rate', `★ ${item.rating}`))
    if (item.added_at) meta.append(el('span', null, `加入 ${formatTime(item.added_at)}`))
    main.append(meta)
    const queued = queueIndex.get(item.douban_ref)
    if (queued) {
      const stateMeta = QUEUE_STATE_META[queued.state] ?? { label: queued.state || '在队列', cls: 'muted' }
      main.append(badge(stateMeta.label, stateMeta.cls))
    } else {
      main.append(badge('未入队', 'muted'))
    }
    row.append(main)
    return row
  }

  function renderQueue() {
    clear(queuePanel)
    const queue = stateDoc?.queue?.items ?? []
    const wish = stateDoc?.wish ?? []
    const info = stateDoc?.wish_info ?? {}
    const due = queue.filter(isDue).length

    const head = el('div', 'db-panel-head')
    const headText = el('div')
    headText.append(
      el('h2', null, '观察队列与我的想看'),
      el('p', 'db-panel-sub', `队列 ${queue.length} 条（${due} 条到期）· 想看 ${wish.length} 条。到期订阅由后台任务处理，也可逐条立即订阅。`),
    )
    head.append(headText)
    queuePanel.append(head)

    const grid = el('div', 'db-duo')

    // 左：观察队列
    const queueBlock = cardBlock('观察队列', '榜单/想看新条目先入队；墓碑与过滤器在自动路径生效。')
    if (queue.length === 0) {
      queueBlock.body.append(emptyState('观察队列为空。', '刷新榜单或同步想看后，通过过滤的新条目会出现在这里。'))
    } else {
      const list = el('div', 'db-queue-list')
      for (const item of queue) list.append(createQueueRow(item))
      queueBlock.body.append(list)
    }
    grid.append(queueBlock.section)

    // 右：我的想看
    const wishBlock = cardBlock('我的想看', '来自豆瓣 rexxar 的 kind=mark 列表（movie + tv）。')
    const wishHeadActions = el('div', 'db-inline-actions')
    const btnSync = smallButton('同步想看', () => { void runAction('wish-sync-now', {}) }, 'secondary')
    wishHeadActions.append(btnSync)
    wishBlock.head.append(wishHeadActions)

    const infoGrid = el('div', 'db-kv-grid db-kv-tight')
    addKv(infoGrid, '同步开关', flat.wish_sync_enabled ? '已开启' : '已关闭')
    addKv(infoGrid, '上次同步', formatTime(info.last_sync) || '未同步')
    addKv(infoGrid, '上次结果', info.last_status ? `${info.last_status}（共 ${num(info.last_count)} 条，新增 ${num(info.last_new)}）` : '—')
    addKv(infoGrid, '豆瓣 UID', text(info.uid) || '—')
    addKv(infoGrid, '登录态来源', text(info.source) || '—')
    wishBlock.body.append(infoGrid)
    if (info.last_error) wishBlock.body.append(banner('warning', `上次同步错误：${info.last_error}`))
    if (!flat.wish_sync_enabled) {
      wishBlock.body.append(banner('info', '「同步我的想看」当前关闭；到「设置」里打开后再点同步。'))
    }
    if (wish.length === 0) {
      wishBlock.body.append(emptyState(
        '还没有想看数据。',
        '先在设置里配置宿主 CookieCloud（或自建 CookieCloud / 手动粘贴 cookie），再点「同步想看」。',
      ))
    } else {
      const list = el('div', 'db-wish-list')
      for (const item of wish) list.append(createWishRow(item))
      wishBlock.body.append(list)
    }
    grid.append(wishBlock.section)

    queuePanel.append(grid)
  }

  // ─────────────────────────── 渲染：历史与日志 ───────────────────────────

  function renderHistory() {
    clear(historyPanel)
    const history = stateDoc?.history ?? []
    const logs = stateDoc?.logs ?? []
    const black = stateDoc?.blackstate ?? {}

    const head = el('div', 'db-panel-head')
    const headText = el('div')
    headText.append(
      el('h2', null, '历史与日志'),
      el('p', 'db-panel-sub', `当前展示 ${history.length} 条历史、${logs.length} 条日志（落盘日志只保留最近 40 条）；归档会清空历史/日志/黑名单命中，不会清除重订墓碑。`),
    )
    head.append(headText)
    const headActions = el('div', 'db-inline-actions')
    headActions.append(smallButton('归档历史与日志', () => {
      void runAction('archive', {}, {
        label: '归档历史与日志',
        confirm: '归档会清空历史、日志、黑名单命中与统计（不会清除「已删除不重订」墓碑集）。继续吗？',
      })
    }, 'danger'))
    headActions.append(smallButton('通知自检', () => { void runAction('send-test', {}) }, 'secondary'))
    head.append(headActions)
    historyPanel.append(head)

    const historyCard = cardBlock('订阅历史', 'result=succeeded 且 action=subscribe 才计入订阅统计。')
    if (history.length === 0) {
      historyCard.body.append(emptyState('还没有订阅历史。', '观察期到期或手动订阅后，这里会记录成功/失败与原因。'))
    } else {
      const scroll = el('div', 'db-scroll')
      const table = el('table', 'db-table')
      const thead = el('thead')
      const headRow = el('tr')
      for (const label of ['时间', '条目', '来源', '动作', '结果', '消息', 'TMDB']) headRow.append(el('th', null, label))
      thead.append(headRow)
      const tbody = el('tbody')
      for (const entry of history) {
        const row = el('tr')
        row.append(el('td', 'db-nowrap', formatTime(entry.created_at) || '—'))
        const titleCell = el('td')
        titleCell.append(el('span', 'db-item-title', entry.title || entry.douban_ref || '—'))
        if (entry.douban_ref) titleCell.append(el('div', 'db-mono db-sub', entry.douban_ref))
        row.append(titleCell)
        row.append(el('td', null, entry.list ? listTitle(entry.list) : '—'))
        row.append(el('td', null, entry.action || '—'))
        const resultCell = el('td')
        resultCell.append(badge(entry.result || '未知', entry.result === 'succeeded' ? 'ok' : 'error'))
        row.append(resultCell)
        row.append(el('td', 'db-wrap', entry.message || '—'))
        row.append(el('td', 'db-mono db-nowrap', entry.tmdb_ref || (entry.intent_id ? `#${entry.intent_id}` : '—')))
        tbody.append(row)
      }
      table.append(thead, tbody)
      scroll.append(table)
      historyCard.body.append(scroll)
    }
    historyPanel.append(historyCard.section)

    const logCard = cardBlock('运行日志', '单条日志按后端规则截断到 400 字节；落盘只保留最近 40 条。')
    if (logs.length === 0) {
      logCard.body.append(emptyState('暂无日志。'))
    } else {
      const list = el('div', 'db-log-list')
      for (const entry of logs) {
        const row = el('div', 'db-log-row')
        row.append(el('span', 'db-log-time', formatTime(entry.at) || entry.at || '—'))
        row.append(el('span', `db-log-dot db-log-${entry.level || 'info'}`))
        row.append(el('span', 'db-log-msg', entry.message || ''))
        list.append(row)
      }
      logCard.body.append(list)
    }
    historyPanel.append(logCard.section)

    const hitCard = cardBlock('黑名单命中', `累计命中 ${num(black.hits)} 次；最近命中保留 20 条。`)
    const recent = Array.isArray(black.recent) ? black.recent : []
    if (recent.length === 0) {
      hitCard.body.append(emptyState('还没有黑名单命中记录。'))
    } else {
      const list = el('div', 'db-hit-list')
      for (const hit of recent) {
        const row = el('div', 'db-hit-row')
        row.append(el('span', 'db-item-title', hit.title || '—'), badge(hit.keyword || '—', 'warn'), el('span', 'db-sub', formatTime(hit.at) || '—'))
        list.append(row)
      }
      hitCard.body.append(list)
    }
    historyPanel.append(hitCard.section)
  }

  // ─────────────────────────── 渲染：设置 ───────────────────────────

  function renderSettings() {
    clear(settingsPanel)
    const ds = docSettings()
    const inputs = { lists: {} }
    settingsInputs = inputs

    // 只读运行状态
    const statusCard = cardBlock('运行状态', '只读：来自存储 state 键与宿主设置 KV；不显示 cookie 明文。')
    const kv = el('div', 'db-kv-grid')
    addKv(kv, '快照时间', formatTime(stateDoc?.snapshot?.fetched_at) || '尚未刷新')
    addKv(kv, '最后刷新', formatTime(rawState?.last_run) || '—')
    addKv(kv, '上次归档', formatTime(stateDoc?.stats?.last_archive_at) || '—')
    addKv(kv, '想看同步', stateDoc?.wish_info?.last_status
      ? `${stateDoc.wish_info.last_status} · ${formatTime(stateDoc.wish_info.last_sync) || '—'}`
      : '未同步')
    addKv(kv, '登录态缓存', stateDoc?.cookie?.source
      ? `${stateDoc.cookie.source} · uid=${text(stateDoc.cookie.uid) || '—'} · ${formatTime(stateDoc.cookie.fetched_at) || '—'}`
      : '无（下次刷新/同步时获取）')
    addKv(kv, '墓碑扫描', formatTime(stateDoc?.no_resub_scan_at) || '未扫描')
    addKv(kv, '状态文档', stateInvalid ? '无法识别' : (stateDoc ? '已加载' : '空（全新安装）'))
    addKv(kv, '存储 revision', '由宿主管理（页面按 value 读取）')
    statusCard.body.append(kv)
    settingsPanel.append(statusCard.section)

    // 基础设置
    const general = cardBlock('基础设置', '保存时经 settings-update job 同时写入宿主 settings KV 与状态文档。')
    const form = el('div', 'db-form-grid')

    const wishSwitch = switchRow('同步我的想看', flat.wish_sync_enabled, '从豆瓣拉取 kind=mark（电影 + 剧集）')
    const autoSwitch = switchRow('到期自动订阅', flat.auto_subscribe, '关闭后新条目只入队，等后台/手动处理')
    const notifySwitch = switchRow('订阅成功发通知', flat.notify_on_subscribe, '经宿主通知渠道推送')
    form.append(wishSwitch.row, autoSwitch.row, notifySwitch.row)

    const observeInput = numberInput(flat.observe_period_hours, { min: 0, step: 1 })
    const ratingInput = numberInput(flat.min_rating, { min: 0, max: 10, step: 0.1 })
    const yearInput = numberInput(flat.min_year, { min: 0, step: 1 })
    const historyInput = numberInput(flat.max_history, { min: 0, step: 1 })
    const logsInput = numberInput(flat.max_logs, { min: 0, step: 1 })
    form.append(
      field('观察期（小时）', observeInput, '0 按榜单默认 24 小时；想看路径 0 表示立即到期'),
      field('最低豆瓣评分', ratingInput, '0 = 不限；无评分条目会被过滤'),
      field('最低年份', yearInput, '0 = 不限；口碑榜/即将上映多数没有年份'),
      field('历史保留条数', historyInput, '后端按此裁剪 history'),
      field('日志保留条数', logsInput, '后端按此裁剪 logs'),
    )

    const regionsInput = textInput((flat.regions ?? []).join(', '), '例如 中国大陆, 美国, 日本')
    const sourcesInput = textInput((flat.subscribe_source_filter ?? []).join(', '), '例如 115, mteam（留空 = 宿主默认）')
    form.append(
      field('地区白名单', regionsInput, '逗号/顿号分隔；只在已取到豆瓣详情（countries）时生效'),
      field('订阅来源过滤', sourcesInput, '写入聚合订阅的 enabled_sources；留空 = 宿主默认来源'),
    )
    general.body.append(form)
    settingsPanel.append(general.section)

    inputs.wish = wishSwitch.input
    inputs.auto = autoSwitch.input
    inputs.notify = notifySwitch.input
    inputs.observe = observeInput
    inputs.rating = ratingInput
    inputs.year = yearInput
    inputs.history = historyInput
    inputs.logs = logsInput
    inputs.regions = regionsInput
    inputs.sources = sourcesInput

    // 账号与 CookieCloud
    const account = cardBlock('账号与 CookieCloud', '优先宿主内置 CookieCloud；显式填写地址/UUID/口令时改用自建服务。')
    const testButton = smallButton('测试 CookieCloud', () => { void runAction('cookiecloud-test', {}) }, 'secondary')
    account.head.append(testButton)
    const accountForm = el('div', 'db-form-grid')
    const ccUrlInput = textInput(flat.cookiecloud_url, 'https://cookiecloud.example.com')
    const ccUuidInput = textInput(flat.cookiecloud_uuid, '自建 CookieCloud 的 UUID')
    const ccKey = secretRow(
      'CookieCloud 口令（自建时填）',
      (flat.cookiecloud_key !== '' || settingsView?.cc_key_set) ? '已配置，留空保持不变' : '未配置',
      '仅在自建 CookieCloud 时使用；插件内 AES 解密依赖宿主 ctx.crypto',
    )
    const manual = secretRow(
      '手动豆瓣 Cookie（可选）',
      (flat.manual_cookie !== '' || settingsView?.cc_manual_set) ? '已配置，留空保持不变' : '未配置',
      '整段 cookie 头或仅 dbcl2=xxx；CookieCloud 拉不到登录态时回退',
    )
    accountForm.append(
      field('自建 CookieCloud 地址', ccUrlInput, '留空 = 用宿主统一配置的内置 CookieCloud'),
      field('CookieCloud UUID', ccUuidInput),
      ccKey.row,
      manual.row,
    )
    account.body.append(accountForm)
    const accountNote = el('p', 'db-note')
    accountNote.textContent = '自建模式要求地址/UUID/口令三项齐全；三项留空且宿主内置可用时走宿主 CookieCloud。口令与手动 cookie 不会回显。'
    account.body.append(accountNote)
    inputs.ccUrl = ccUrlInput
    inputs.ccUuid = ccUuidInput
    inputs.ccKey = ccKey
    inputs.manual = manual
    settingsPanel.append(account.section)

    // 榜单配置
    const listsCard = cardBlock('榜单配置', '嵌套配置留在状态文档；enabled=false 的榜单下一轮刷新会跳过。')
    const tableScroll = el('div', 'db-scroll')
    const table = el('table', 'db-table db-table-form')
    const thead = el('thead')
    const headRow = el('tr')
    for (const label of ['启用', '榜单', '来源', '类型', '标签', '排序', '条数']) headRow.append(el('th', null, label))
    thead.append(headRow)
    const tbody = el('tbody')
    const defaults = defaultSettings().lists
    const docLists = ds.lists ?? {}
    const keys = [...new Set([...Object.keys(defaults), ...Object.keys(docLists)])]
      .sort((a, b) => {
        const ai = LIST_ORDER.indexOf(a)
        const bi = LIST_ORDER.indexOf(b)
        if (ai === -1 && bi === -1) return a.localeCompare(b)
        if (ai === -1) return 1
        if (bi === -1) return -1
        return ai - bi
      })
    for (const key of keys) {
      const config = { ...(defaults[key] ?? {}), ...(docLists[key] ?? {}) }
      const isUpcoming = key === 'upcoming'
      const row = el('tr')

      const enabledCell = el('td')
      const enabledInput = el('input')
      enabledInput.type = 'checkbox'
      enabledInput.setAttribute('aria-label', `启用 ${listTitle(key)}`)
      enabledInput.checked = isUpcoming ? true : Boolean(config.enabled)
      enabledInput.disabled = isUpcoming
      if (isUpcoming) enabledInput.title = '即将上映榜单固定启用（后端 normalize_settings 强制）'
      enabledCell.append(enabledInput)
      row.append(enabledCell)

      const nameCell = el('td')
      nameCell.append(el('strong', null, listTitle(key)), el('div', 'db-mono db-sub', key))
      row.append(nameCell)

      const sourceCell = el('td')
      const sourceInput = selectInput(config.source || 'subjects_json', [
        ['subjects_json', SOURCE_LABEL.subjects_json],
        ['coming_html', SOURCE_LABEL.coming_html],
        ['chart_html', SOURCE_LABEL.chart_html],
      ])
      sourceInput.setAttribute('aria-label', `${listTitle(key)}来源`)
      sourceInput.disabled = isUpcoming
      sourceCell.append(sourceInput)
      row.append(sourceCell)

      const typeCell = el('td')
      const typeInput = selectInput(config.type || 'movie', [['movie', '电影'], ['tv', '剧集']])
      typeInput.setAttribute('aria-label', `${listTitle(key)}类型`)
      typeInput.disabled = isUpcoming
      typeCell.append(typeInput)
      row.append(typeCell)

      const tagCell = el('td')
      const tagInput = textInput(config.tag, '热门 / 国产剧 / 欧美')
      tagInput.setAttribute('aria-label', `${listTitle(key)}标签`)
      tagInput.disabled = isUpcoming
      tagCell.append(tagInput)
      row.append(tagCell)

      const sortCell = el('td')
      const sortInput = textInput(config.sort, 'recommend')
      sortInput.setAttribute('aria-label', `${listTitle(key)}排序`)
      sortInput.disabled = isUpcoming
      sortCell.append(sortInput)
      row.append(sortCell)

      const limitCell = el('td')
      const limitInput = numberInput(num(config.limit, 20), { min: 0, max: 200, step: 1 })
      limitInput.setAttribute('aria-label', `${listTitle(key)}条数`)
      limitCell.append(limitInput)
      row.append(limitCell)

      if (isUpcoming) row.classList.add('db-row-locked')
      inputs.lists[key] = { enabled: enabledInput, source: sourceInput, type: typeInput, tag: tagInput, sort: sortInput, limit: limitInput }
      tbody.append(row)
    }
    table.append(thead, tbody)
    tableScroll.append(table)
    listsCard.body.append(tableScroll)
    listsCard.body.append(el('p', 'db-note', '即将上映固定 coming_html / movie / 启用；后端保存时会再次强制。'))
    settingsPanel.append(listsCard.section)

    // 黑名单
    const blackCard = cardBlock('黑名单关键词', '按标题子串匹配；添加/移除立即落盘（不随下面的保存按钮）。')
    const blacklist = Array.isArray(ds.blacklist) ? ds.blacklist : []
    const chips = el('div', 'db-chips')
    if (blacklist.length === 0) {
      chips.append(el('span', 'db-empty-note', '还没有关键词。'))
    } else {
      for (const keyword of blacklist) {
        const chip = el('span', 'db-chip', keyword)
        const remove = el('button', 'db-chip-x', '×')
        remove.type = 'button'
        remove.title = `移除 ${keyword}`
        remove.setAttribute('data-busy-lock', '1')
        remove.addEventListener('click', () => {
          void runAction('blacklist-remove', { keyword }, { label: `移除黑名单「${keyword}」` })
        })
        chip.append(remove)
        chips.append(chip)
      }
    }
    blackCard.body.append(chips)
    const addRow = el('div', 'db-inline-form')
    const keywordInput = textInput('', '输入关键词')
    keywordInput.setAttribute('aria-label', '黑名单关键词')
    const addButton = smallButton('添加', () => {
      const keyword = keywordInput.value.trim()
      if (keyword === '') {
        toast('warning', '关键词不能为空')
        return
      }
      void runAction('blacklist-add', { keyword }, { label: `添加黑名单「${keyword}」` })
    }, 'primary')
    keywordInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        addButton.click()
      }
    })
    addRow.append(keywordInput, addButton)
    blackCard.body.append(addRow)
    blackCard.body.append(el('p', 'db-note', `累计命中 ${num(stateDoc?.blackstate?.hits)} 次；命中记录在「历史与日志」里查看。`))
    settingsPanel.append(blackCard.section)

    // 维护
    const maintenance = cardBlock('维护', '墓碑集是「已删除不重订」；归档不会清它，只能在这里显式清除。')
    const tombstones = Object.entries(stateDoc?.no_resub ?? {})
    const tombInfo = el('p', 'db-note', `重订墓碑 ${tombstones.length} 条；上次扫描：${formatTime(stateDoc?.no_resub_scan_at) || '未扫描'}。`)
    maintenance.body.append(tombInfo)
    if (tombstones.length > 0) {
      const scroll = el('div', 'db-scroll db-tomb-scroll')
      const list = el('div', 'db-tomb-list')
      for (const [ref, entry] of tombstones.slice(0, 100)) {
        const row = el('div', 'db-tomb-row')
        row.append(
          el('span', 'db-mono', ref),
          el('span', null, text(entry?.reason) || '宿主已无该 tmdb 订阅'),
          el('span', 'db-sub db-nowrap', formatTime(entry?.at) || '—'),
        )
        list.append(row)
      }
      scroll.append(list)
      maintenance.body.append(scroll)
      if (tombstones.length > 100) maintenance.body.append(el('p', 'db-note', `只显示前 100 条（共 ${tombstones.length} 条）。`))
    }
    const maintenanceActions = el('div', 'db-inline-actions')
    maintenanceActions.append(
      smallButton('清除重订限制', () => {
        void runAction('no-resub-clear', {}, {
          label: '清除重订限制',
          confirm: `将清除 ${tombstones.length} 条「已删除不重订」墓碑，之后自动订阅可能重新订阅这些条目。继续吗？`,
        })
      }, 'danger'),
      smallButton('通知自检', () => { void runAction('send-test', {}) }, 'secondary'),
    )
    maintenance.body.append(maintenanceActions)
    settingsPanel.append(maintenance.section)

    // 保存栏
    const saveBar = el('div', 'db-savebar')
    const saveHint = el('span', 'db-save-hint', '改完点保存；账号口令留空 = 保持原值，勾选「清除」才会删除。')
    const reloadButton = smallButton('重新读取', () => { void refreshUi() }, 'ghost')
    const saveButton = actionButton('保存设置', 'primary', () => { void saveSettings() })
    saveBar.append(saveHint, reloadButton, saveButton)
    settingsPanel.append(saveBar)
  }

  // ─────────────────────────── 设置保存 ───────────────────────────

  function splitListValue(value) {
    return String(value ?? '')
      .split(/[,，、\n]/)
      .map((item) => item.trim())
      .filter((item) => item !== '')
  }

  function readNumberField(input, label, options = {}) {
    const raw = String(input.value ?? '').trim()
    if (raw === '') return { ok: true, value: options.fallback ?? 0 }
    const parsed = Number(raw)
    const min = options.min ?? 0
    const max = options.max
    if (!Number.isFinite(parsed) || parsed < min || (max !== undefined && parsed > max)) {
      return { ok: false, message: `${label} 需为 ${min}${max !== undefined ? `~${max}` : ' 以上'} 的数字` }
    }
    return { ok: true, value: options.integer ? Math.trunc(parsed) : parsed }
  }

  async function saveSettings() {
    if (busy !== '' || disposed.value || !settingsInputs) return
    const inputs = settingsInputs
    const errors = []

    const read = (input, label, options) => {
      const result = readNumberField(input, label, options)
      if (!result.ok) errors.push(result.message)
      return result.ok ? result.value : (options.fallback ?? 0)
    }

    const patch = {
      wish_sync_enabled: inputs.wish.checked,
      auto_subscribe: inputs.auto.checked,
      notify_on_subscribe: inputs.notify.checked,
      observe_period_hours: read(inputs.observe, '观察期', { fallback: flat.observe_period_hours, integer: true, min: 0, max: 8760 }),
      min_rating: read(inputs.rating, '最低评分', { fallback: flat.min_rating, min: 0, max: 10 }),
      min_year: read(inputs.year, '最低年份', { fallback: flat.min_year, integer: true, min: 0, max: 3000 }),
      max_history: read(inputs.history, '历史保留条数', { fallback: flat.max_history, integer: true, min: 0 }),
      max_logs: read(inputs.logs, '日志保留条数', { fallback: flat.max_logs, integer: true, min: 0 }),
      regions: splitListValue(inputs.regions.value),
      subscribe_source_filter: splitListValue(inputs.sources.value),
      lists: {},
      cookiecloud_url: inputs.ccUrl.value.trim(),
      cookiecloud_uuid: inputs.ccUuid.value.trim(),
    }

    for (const [key, entry] of Object.entries(inputs.lists)) {
      const fallbackLimit = num(docSettings().lists?.[key]?.limit, 20)
      patch.lists[key] = {
        enabled: entry.enabled.checked,
        source: entry.source.value,
        type: entry.type.value,
        tag: entry.tag.value.trim(),
        sort: entry.sort.value.trim(),
        limit: read(entry.limit, `${listTitle(key)}条数`, { fallback: fallbackLimit, integer: true, min: 0, max: 200 }),
      }
    }

    if (inputs.ccKey.input.value !== '') patch.cookiecloud_key = inputs.ccKey.input.value
    else if (inputs.ccKey.clear.checked) patch.cookiecloud_key = ''
    if (inputs.manual.input.value !== '') patch.manual_cookie = inputs.manual.input.value.trim()
    else if (inputs.manual.clear.checked) patch.manual_cookie = ''

    if (errors.length > 0) {
      toast('error', errors.join('；'))
      return
    }

    setBusy('settings-update')
    try {
      const finished = await invokeJob('settings-update', patch)
      const result = finished?.result && typeof finished.result === 'object' ? finished.result : {}
      if (finished?.status === 'failed' || result.status === 'failed') {
        toast('error', text(result.message) || `保存失败：${text(finished?.error) || '未知错误'}`)
      } else if (result.settings_saved === false) {
        toast('warning', `状态文档已保存，但宿主设置 KV 写入失败：${text(result.settings_error) || '原因未知'}`)
      } else {
        toast('success', text(result.message) || '设置已保存')
      }
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      if (!disposed.value) {
        setBusy('')
        await refreshUi()
      }
    }
  }

  // ─────────────────────────── Tab / 总渲染 ───────────────────────────

  function applyTab() {
    for (const [key, button] of Object.entries(tabButtons)) {
      button.classList.toggle('db-tab-active', key === activeTab)
    }
    chartsPanel.hidden = activeTab !== 'charts'
    queuePanel.hidden = activeTab !== 'queue'
    historyPanel.hidden = activeTab !== 'history'
    settingsPanel.hidden = activeTab !== 'settings'
  }

  function showTab(key) {
    activeTab = key
    applyTab()
    if (key === 'settings') settingsPanel.scrollIntoView?.({ block: 'start' })
  }

  function render() {
    if (disposed.value) return
    observer?.disconnect()
    lazyTargets.clear()
    posterTargets.clear()
    rebuildQueueIndex()
    renderHeader()
    renderTiles()
    renderBanners()
    renderCharts()
    renderQueue()
    renderHistory()
    renderSettings()
    const queueCount = (stateDoc?.queue?.items ?? []).length + (stateDoc?.wish ?? []).length
    tabButtons.charts.querySelector('.db-tab-count').textContent = String(snapshotItems().length)
    tabButtons.queue.querySelector('.db-tab-count').textContent = String(queueCount)
    tabButtons.history.querySelector('.db-tab-count').textContent = String((stateDoc?.history ?? []).length + (stateDoc?.logs ?? []).length)
    tabButtons.settings.querySelector('.db-tab-count').textContent = tombstoneCount() > 0 ? String(tombstoneCount()) : ''
    applyTab()
  }

  // ─────────────────────────── 启动/清理 ───────────────────────────

  await loadData()
  if (disposed.value) return () => {}

  return () => {
    disposed.value = true
    observer?.disconnect()
    lazyTargets.clear()
    posterTargets.clear()
    posterQueue.length = 0
    posterQueued.clear()
    posterCache.clear()
    clear(toastBox)
    style.remove()
    page.remove()
  }
}

const CSS_TEXT = `
.db3, .db3 * { box-sizing: border-box; }
.db3 {
  --db-radius: 14px;
  --db-line: var(--app-border, #e3e6eb);
  --db-muted: var(--app-text-secondary, #6b7280);
  --db-accent: var(--app-accent, #2080f0);
  --db-ok: #18a058;
  --db-warn: #f0a020;
  --db-err: #d03050;
  position: relative;
  min-height: 100%;
  padding: 16px clamp(12px, 2.4vw, 28px) 42px;
  background: var(--app-bg, #f5f6f8);
  color: var(--app-text, #1f2329);
  font-size: 14px;
  line-height: 1.5;
}
.db3 [hidden] { display: none !important; }
.db3 a { color: inherit; }
.db3 h1, .db3 h2, .db3 h3, .db3 p { margin: 0; }
.db3 h1 { font-size: 20px; font-weight: 650; letter-spacing: .01em; }
.db3 h2 { font-size: 16px; font-weight: 650; }
.db3 h3 { font-size: 14px; font-weight: 650; }

.db3-head {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap;
  padding: 10px 0 14px;
  background: color-mix(in srgb, var(--app-bg, #f5f6f8) 88%, transparent);
  backdrop-filter: blur(12px);
}
.db-brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.db-brand-icon {
  width: 42px; height: 42px; flex: none; display: grid; place-items: center;
  border-radius: 12px; color: #fff;
  background: linear-gradient(135deg, var(--db-accent), #7c5cfc);
  box-shadow: 0 6px 18px color-mix(in srgb, var(--db-accent) 30%, transparent);
}
.db-brand-text { min-width: 0; }
.db-brand-text p { color: var(--db-muted); font-size: 12px; margin-top: 2px; }
.db-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.db-capsule {
  display: inline-flex; align-items: center; min-height: 30px; padding: 4px 10px;
  border-radius: 999px; border: 1px solid var(--db-line); font-size: 12px; white-space: nowrap;
}
.db-capsule-muted { color: var(--db-muted); }
.db-capsule-ok { color: var(--db-ok); border-color: color-mix(in srgb, var(--db-ok) 40%, transparent); background: color-mix(in srgb, var(--db-ok) 10%, transparent); }
.db-capsule-warn { color: var(--db-warn); border-color: color-mix(in srgb, var(--db-warn) 45%, transparent); background: color-mix(in srgb, var(--db-warn) 10%, transparent); }

.db-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 34px; padding: 6px 12px; border-radius: 9px; border: 1px solid var(--db-line);
  background: var(--app-surface, #fff); color: inherit; font: inherit; font-size: 13px;
  cursor: pointer; text-decoration: none; white-space: nowrap;
  transition: border-color .15s ease, background-color .15s ease, transform .1s ease;
}
.db-btn:hover { border-color: var(--db-accent); }
.db-btn:active { transform: translateY(1px); }
.db-btn:focus-visible { outline: 2px solid var(--db-accent); outline-offset: 2px; }
.db-btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
.db-btn-primary { background: var(--db-accent); border-color: var(--db-accent); color: #fff; }
.db-btn-secondary { background: color-mix(in srgb, var(--db-accent) 10%, var(--app-surface, #fff)); border-color: color-mix(in srgb, var(--db-accent) 45%, var(--db-line)); color: var(--db-accent); }
.db-btn-ghost { background: transparent; }
.db-btn-danger { color: var(--db-err); border-color: color-mix(in srgb, var(--db-err) 40%, var(--db-line)); background: color-mix(in srgb, var(--db-err) 6%, transparent); }
.db-btn-sm { min-height: 28px; padding: 3px 9px; font-size: 12px; border-radius: 7px; }

.db-progress {
  display: flex; align-items: center; gap: 10px; margin: 0 0 12px;
  padding: 10px 14px; border-radius: 10px; font-size: 13px;
  color: var(--db-accent);
  background: color-mix(in srgb, var(--db-accent) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--db-accent) 25%, transparent);
}
.db-spinner { width: 14px; height: 14px; border-radius: 50%; flex: none; border: 2px solid color-mix(in srgb, var(--db-accent) 30%, transparent); border-top-color: var(--db-accent); animation: db-spin .8s linear infinite; }
@keyframes db-spin { to { transform: rotate(360deg); } }

.db-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 12px; }
.db-tile {
  display: grid; gap: 2px; padding: 12px 14px; border-radius: 12px;
  background: var(--app-surface, #fff); border: 1px solid var(--db-line);
}
.db-tile-label { color: var(--db-muted); font-size: 12px; }
.db-tile-value { font-size: 24px; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.2; }
.db-tile-hint { color: var(--db-muted); font-size: 11px; overflow-wrap: anywhere; }

.db-banners { display: grid; gap: 8px; margin-bottom: 12px; }
.db-banners:empty { display: none; }
.db-banner { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border-radius: 10px; font-size: 13px; border: 1px solid transparent; overflow-wrap: anywhere; }
.db-banner-dot { width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; flex: none; background: currentColor; }
.db-banner-info { color: var(--db-accent); background: color-mix(in srgb, var(--db-accent) 7%, transparent); border-color: color-mix(in srgb, var(--db-accent) 22%, transparent); }
.db-banner-warning { color: var(--db-warn); background: color-mix(in srgb, var(--db-warn) 8%, transparent); border-color: color-mix(in srgb, var(--db-warn) 30%, transparent); }
.db-banner-error { color: var(--db-err); background: color-mix(in srgb, var(--db-err) 8%, transparent); border-color: color-mix(in srgb, var(--db-err) 30%, transparent); }

.db-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--db-line); margin-bottom: 14px; overflow-x: auto; }
.db-tab {
  position: relative; display: inline-flex; align-items: center; gap: 7px;
  padding: 9px 12px; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px;
  background: transparent; color: var(--db-muted); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap;
}
.db-tab:hover { color: inherit; }
.db-tab-active { color: var(--db-accent); border-bottom-color: var(--db-accent); font-weight: 600; }
.db-tab-count { min-width: 18px; padding: 0 5px; border-radius: 999px; font-size: 11px; line-height: 18px; text-align: center; background: color-mix(in srgb, var(--db-accent) 10%, transparent); color: var(--db-accent); }
.db-tab-count:empty { display: none; }

.db-panels { min-width: 0; }
.db-panel { display: grid; gap: 14px; }
.db-panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.db-panel-sub { color: var(--db-muted); font-size: 12px; margin-top: 3px; overflow-wrap: anywhere; }

.db-card-block { background: var(--app-surface, #fff); border: 1px solid var(--db-line); border-radius: var(--db-radius); padding: 14px 16px; min-width: 0; }
.db-block-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.db-block-text { min-width: 0; }
.db-block-sub { color: var(--db-muted); font-size: 12px; margin-top: 3px; overflow-wrap: anywhere; }
.db-block-body { display: grid; gap: 12px; min-width: 0; }

.db-list-block { background: var(--app-surface, #fff); border: 1px solid var(--db-line); border-radius: var(--db-radius); padding: 14px 16px; min-width: 0; }
.db-list-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
.db-list-sub { color: var(--db-muted); font-size: 12px; margin-top: 2px; }
.db-poster-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(142px, 1fr)); gap: 14px; }

.db-item { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.db-poster {
  position: relative; display: block; aspect-ratio: 2 / 3; border-radius: 10px; overflow: hidden;
  background: color-mix(in srgb, var(--db-accent) 9%, var(--app-bg, #f0f2f5));
  border: 1px solid color-mix(in srgb, var(--db-line) 70%, transparent);
}
.db-poster img { display: block; width: 100%; height: 100%; object-fit: cover; }
.db-poster-ph {
  position: absolute; inset: 0; display: grid; place-items: center; padding: 6px;
  color: var(--db-muted); font-size: 12px; text-align: center; background: transparent;
}
.db-item-body { display: grid; gap: 5px; min-width: 0; }
.db-item-title { font-size: 13px; font-weight: 550; line-height: 1.35; text-decoration: none; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
a.db-item-title:hover { color: var(--db-accent); }
.db-item-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; color: var(--db-muted); font-size: 11px; }
.db-rate { color: #e6a23c; font-weight: 600; }
.db-item-actions { display: flex; gap: 6px; flex-wrap: wrap; }

.db-badge { display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 500; white-space: nowrap; }
.db-badge-muted { color: var(--db-muted); background: color-mix(in srgb, var(--db-muted) 12%, transparent); }
.db-badge-info { color: var(--db-accent); background: color-mix(in srgb, var(--db-accent) 12%, transparent); }
.db-badge-ok { color: var(--db-ok); background: color-mix(in srgb, var(--db-ok) 13%, transparent); }
.db-badge-warn { color: var(--db-warn); background: color-mix(in srgb, var(--db-warn) 14%, transparent); }
.db-badge-error { color: var(--db-err); background: color-mix(in srgb, var(--db-err) 13%, transparent); }

.db-duo { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, .95fr); gap: 14px; align-items: start; }
@media (max-width: 1080px) { .db-duo { grid-template-columns: minmax(0, 1fr); } }
.db-queue-list, .db-wish-list { display: grid; gap: 10px; max-height: 760px; overflow: auto; padding-right: 2px; }
.db-queue-item {
  display: grid; grid-template-columns: 62px minmax(0, 1fr) auto; gap: 10px; align-items: start;
  padding: 10px; border: 1px solid var(--db-line); border-radius: 11px; background: color-mix(in srgb, var(--app-bg, #f5f6f8) 35%, transparent);
}
.db-thumb { width: 62px; height: 93px; flex: none; }
.db-thumb-sm { width: 52px; height: 78px; flex: none; border-radius: 8px; }
.db-queue-main, .db-wish-main { display: grid; gap: 4px; min-width: 0; }
.db-queue-due { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--db-muted); font-size: 11px; flex-wrap: wrap; }
.db-queue-extra { color: var(--db-muted); font-size: 11px; overflow-wrap: anywhere; }
.db-error-text { color: var(--db-err); font-size: 11px; overflow-wrap: anywhere; }
.db-queue-actions { display: flex; flex-direction: column; gap: 6px; align-items: stretch; }
.db-wish-item {
  display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 10px; align-items: start;
  padding: 9px; border: 1px solid var(--db-line); border-radius: 11px;
}

.db-kv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px 14px; }
.db-kv { display: grid; gap: 1px; min-width: 0; }
.db-kv-tight { gap: 6px 12px; }
.db-kv-label { color: var(--db-muted); font-size: 11px; }
.db-kv-value { font-size: 12px; overflow-wrap: anywhere; }

.db-scroll { overflow: auto; max-width: 100%; border: 1px solid var(--db-line); border-radius: 10px; }
.db-table { width: 100%; border-collapse: collapse; font-size: 12px; min-width: 720px; }
.db-table th, .db-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--db-line); vertical-align: top; }
.db-table th { position: sticky; top: 0; background: var(--app-surface, #fff); font-weight: 600; white-space: nowrap; z-index: 1; }
.db-table tr:last-child td { border-bottom: none; }
.db-table-form td { padding: 6px 8px; vertical-align: middle; }
.db-table-form .db-input, .db-table-form .db-select { min-height: 30px; padding: 4px 7px; font-size: 12px; width: 100%; min-width: 92px; }
.db-table-form td:first-child { width: 44px; }
.db-row-locked { background: color-mix(in srgb, var(--db-warn) 5%, transparent); }
.db-nowrap { white-space: nowrap; }
.db-wrap { overflow-wrap: anywhere; min-width: 180px; }
.db-sub { color: var(--db-muted); font-size: 11px; margin-top: 2px; overflow-wrap: anywhere; }
.db-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }

.db-log-list { display: grid; gap: 5px; max-height: 420px; overflow: auto; }
.db-log-row { display: grid; grid-template-columns: 108px 8px minmax(0, 1fr); gap: 8px; align-items: baseline; font-size: 12px; }
.db-log-time { color: var(--db-muted); font-variant-numeric: tabular-nums; font-size: 11px; }
.db-log-dot { width: 7px; height: 7px; border-radius: 50%; align-self: center; background: var(--db-muted); }
.db-log-info { background: var(--db-accent); }
.db-log-warning { background: var(--db-warn); }
.db-log-error { background: var(--db-err); }
.db-log-msg { overflow-wrap: anywhere; }
.db-hit-list, .db-tomb-list { display: grid; gap: 6px; }
.db-hit-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 7px 9px; border: 1px solid var(--db-line); border-radius: 9px; font-size: 12px; }
.db-tomb-scroll { max-height: 260px; }
.db-tomb-row { display: grid; grid-template-columns: minmax(120px, .9fr) minmax(0, 1.4fr) auto; gap: 10px; padding: 7px 9px; border-bottom: 1px solid var(--db-line); font-size: 12px; }
.db-tomb-row:last-child { border-bottom: none; }

.db-form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 12px 16px; }
.db-field { display: grid; gap: 5px; min-width: 0; align-content: start; }
.db-field-label { font-size: 12px; font-weight: 600; }
.db-field-help { color: var(--db-muted); font-size: 11px; overflow-wrap: anywhere; }
.db-input, .db-select {
  width: 100%; min-height: 36px; padding: 7px 9px; border-radius: 9px;
  border: 1px solid var(--db-line); background: var(--app-bg, #fff); color: inherit; font: inherit; font-size: 13px;
}
.db-input:focus-visible, .db-select:focus-visible { outline: 2px solid var(--db-accent); outline-offset: 1px; border-color: var(--db-accent); }
.db-input:disabled, .db-select:disabled { opacity: .65; cursor: not-allowed; }
.db-secret { display: grid; gap: 5px; }
.db-clear { display: inline-flex; align-items: center; gap: 5px; color: var(--db-muted); font-size: 11px; }
.db-clear input { width: 14px; height: 14px; }
.db-switch-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 9px 11px; border: 1px solid var(--db-line); border-radius: 10px; cursor: pointer; }
.db-switch-text { display: grid; gap: 2px; min-width: 0; }
.db-switch { position: relative; width: 40px; height: 22px; flex: none; margin-top: 2px; }
.db-switch input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; margin: 0; cursor: pointer; z-index: 1; }
.db-track { position: absolute; inset: 0; border-radius: 999px; background: var(--db-line); transition: background-color .15s ease; }
.db-track::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.2); transition: transform .15s ease; }
.db-switch input:checked + .db-track { background: var(--db-accent); }
.db-switch input:checked + .db-track::after { transform: translateX(18px); }
.db-switch input:focus-visible + .db-track { outline: 2px solid var(--db-accent); outline-offset: 2px; }

.db-inline-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.db-inline-form { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.db-inline-form .db-input { flex: 1 1 220px; width: auto; }
.db-chips { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.db-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 4px 3px 9px; border-radius: 999px; border: 1px solid var(--db-line); font-size: 12px; background: color-mix(in srgb, var(--app-bg, #f5f6f8) 40%, transparent); }
.db-chip-x { width: 20px; height: 20px; display: grid; place-items: center; border: none; border-radius: 50%; background: transparent; color: var(--db-muted); font: inherit; font-size: 14px; line-height: 1; cursor: pointer; }
.db-chip-x:hover { color: var(--db-err); background: color-mix(in srgb, var(--db-err) 10%, transparent); }
.db-note { color: var(--db-muted); font-size: 11px; overflow-wrap: anywhere; }

.db-savebar {
  position: sticky; bottom: 0; z-index: 10;
  display: flex; align-items: center; justify-content: flex-end; gap: 10px; flex-wrap: wrap;
  padding: 10px 14px; border: 1px solid var(--db-line); border-radius: 12px;
  background: color-mix(in srgb, var(--app-surface, #fff) 92%, transparent); backdrop-filter: blur(10px);
}
.db-save-hint { margin-right: auto; color: var(--db-muted); font-size: 11px; }

.db-empty { display: grid; gap: 4px; padding: 18px 6px; color: var(--db-muted); font-size: 13px; }
.db-empty p { margin: 0; }
.db-empty-note { color: var(--db-muted); font-size: 11px; }

.db-toasts { position: fixed; right: 16px; bottom: 16px; z-index: 80; display: grid; gap: 8px; max-width: min(420px, 84vw); }
.db-toast { padding: 10px 14px; border-radius: 10px; color: #fff; font-size: 13px; box-shadow: 0 8px 26px rgba(0,0,0,.2); overflow-wrap: anywhere; animation: db-in .16s ease-out; }
.db-toast-success { background: var(--db-ok); }
.db-toast-error { background: var(--db-err); }
.db-toast-warning { background: var(--db-warn); }
.db-toast-info { background: var(--db-accent); }
@keyframes db-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

.db-foot { display: flex; justify-content: center; padding: 18px 0 4px; color: var(--db-muted); font-size: 11px; text-align: center; }

@media (max-width: 720px) {
  .db3 { padding: 10px 10px 30px; }
  .db3-head { position: static; }
  .db-actions { width: 100%; }
  .db-capsule { display: none; }
  .db-poster-grid { grid-template-columns: repeat(auto-fill, minmax(116px, 1fr)); gap: 10px; }
  .db-queue-item { grid-template-columns: 48px minmax(0, 1fr); }
  .db-queue-actions { grid-column: 1 / -1; flex-direction: row; flex-wrap: wrap; }
  .db-thumb { width: 48px; height: 72px; }
  .db-log-row { grid-template-columns: 82px 8px minmax(0, 1fr); }
}
`
