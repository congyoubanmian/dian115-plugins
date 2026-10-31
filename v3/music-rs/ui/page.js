// 音乐下载 —— 插件页面（v3 ui/page.js，导出 mount(el, ctx)）。
//
// 对照 plugins/music-rs/frontend/src/AppPage.vue 用原生 JS + DOM 重写，功能零变动：
// 页头（登录状态胶囊 + 手动 Cookie + 刷新 + ⚙）→ 登录卡（左 QR 白底卡 | 右 stepper +
// 其他登录方式 + 音质档位 chips）→ 下划线式 Tabs（搜索/我的歌单/任务/设置）→ 最近动作 → 页脚。
//
// 数据通道（v3，取代旧 Federation 桥）：
// - 状态：页面实时读 KV 组装（jobs/runtime.js buildStateDoc）；
// - 搜索/扫码/歌单：ctx.http 直连（netease/qq 接口不带签名，页面可发）；
// - 入队/重试/清理：ctx.storage（lib/queue-store.js 的 CAS 队列）；
// - 推进队列：ctx.tasks.run('queue-pump', …) 提交统一任务队列并轮询到终态；
// - CookieCloud：ctx.cookiecloud('read')（宿主内置服务，取代旧自配地址/UUID/口令）；
// - 测试通知：ctx.notify（v3 支持 callback_data 按钮）。
//
// 只呈现真实状态：缺数据就说缺什么，不造任何假数据。

import { buildDeps, readSettings } from '../jobs/runtime.js'
import { normalizeSettings, applySettingsPatch, settingsView, MAX_ACTIVE_CAP, DEFAULT_QUALITY } from '../lib/settings.js'
import { neteaseSearch, neteaseQrCreate, neteaseQrPoll, neteasePlaylists, neteasePlaylistSongs, loadCookies, saveCookies } from '../lib/music-api.js'
import { cleanNeteaseCookieString, cleanQqCookieString, neteaseLoginInfo, qqLoginInfo, extractCookiesFromSnapshot, isNeteaseCloudDomain, isQqCloudDomain, normalizeCookies } from '../lib/cookies.js'
import { QR_UNAVAILABLE } from '../lib/qq.js'
import { LEVELS, LEVELS_ASCENDING, qualitiesForLevel } from '../lib/eapi.js'
import { enqueue, retry, adopt, clearFinished } from '../lib/queue-store.js'
import { queuePlaylistPages, PLAYLIST_QUEUE_DEFAULT_PAGES } from '../lib/queue-pages.js'
import { neteasePlaylistIndex, neteasePlaylistSongsFromIndex } from '../lib/music-api.js'
import { addLog, loadLogs } from '../lib/logs.js'
import { stateView, STATUS_QUEUED, MAX_ATTEMPTS } from '../lib/tasks-core.js'
import { loadIndex } from '../lib/queue-store.js'
import { encodeQr, qrSvgPath } from './qr.js'

const POLL_INTERVAL_MS = 2000
const TASK_REFRESH_MS = 5000
const MUSIC_NOT_LOGIN_HINT = '未登录'

const QUALITY_LABELS = {
  jymaster: '超清母带', jyeffect: '高清臻音', sky: '沉浸环绕', hires: 'Hi-Res',
  lossless: '无损', dolby: '杜比全景声', exhigh: '极高', standard: '标准',
  master: '母带', flac: '无损 FLAC', 320: '320K', 128: '128K',
}

const SOURCES = [
  { id: 'netease', name: '网易云', qualities: LEVELS },
  { id: 'qq', name: 'QQ音乐', qualities: ['master', 'flac', '320', '128'] },
]

const STATUS_META = {
  queued: { label: '排队中', cls: 'badge-info' },
  downloading: { label: '下载中', cls: 'badge-solid' },
  copying: { label: '入库中', cls: 'badge-solid' },
  done: { label: '下载完成', cls: 'badge-success' },
  failed: { label: '下载失败', cls: 'badge-error' },
}

export async function mount(root, ctx) {
  const doc = root.ownerDocument
  const disposed = { value: false }
  const deps = buildDeps(ctx)

  // ─────────────────────────── 骨架 ───────────────────────────
  const style = doc.createElement('style')
  style.textContent = CSS_TEXT
  root.append(style)

  const page = doc.createElement('main')
  page.className = 'm3'
  root.append(page)

  const el = (tag, className, text) => {
    const node = doc.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = text
    return node
  }
  const icon = (paths, size = 16) => {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', size)
    svg.setAttribute('height', size)
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.innerHTML = paths
    svg.append(g)
    return svg
  }
  const ICONS = {
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
    cookie: '<path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5v.01M16 15.5v.01M12 12v.01M11 17v.01M7 14v.01"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
    retry: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    cloud: '<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 0 9H7a5 5 0 0 1-3-2.1z"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/>',
    clipboard: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    qr: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3M21 21v.01M12 7v3a2 2 0 0 1-2 2H7M3 12h.01M12 3h.01M12 12h.01M12 16v.01M12 21v.01"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  }

  // Toast（替代旧 naive-ui message）。
  const toastBox = el('div', 'm-toasts')
  page.append(toastBox)
  function toast(kind, message) {
    const node = el('div', `toast toast-${kind}`, message)
    toastBox.append(node)
    setTimeout(() => node.remove(), 4800)
  }
  const errorText = (error) => String(error?.message ?? error ?? '未知错误')

  // ─────────────────────────── 页头 ───────────────────────────
  const header = el('header', 'm-head')
  const brand = el('div', 'm-brand')
  const brandIcon = el('span', 'm-brand-icon')
  brandIcon.append(icon(ICONS.music, 22))
  brand.append(brandIcon, el('div', 'm-brand-text', (() => {
    const wrap = el('div')
    wrap.append(el('h1', null, '音乐下载'), el('p', null, '扫码登录网易云 / QQ 音乐 · 下载至 115 网盘 · 队列自动推进'))
    return wrap
  })()))
  const headRight = el('div', 'm-actions')
  const headCapsule = el('span', 'badge badge-warning', '未登录 · 网易云')
  const btnCookie = el('button', 'btn btn-ghost btn-sm')
  btnCookie.type = 'button'
  btnCookie.append(icon(ICONS.cookie, 14), doc.createTextNode('手动 Cookie'))
  const btnRefresh = el('button', 'icon-btn')
  btnRefresh.type = 'button'
  btnRefresh.title = '刷新状态'
  btnRefresh.append(icon(ICONS.refresh, 15))
  const btnSettings = el('button', 'icon-btn')
  btnSettings.type = 'button'
  btnSettings.title = '设置'
  btnSettings.append(icon(ICONS.gear, 16))
  headRight.append(headCapsule, btnCookie, btnRefresh, btnSettings)
  header.append(brand, headRight)
  page.append(header)

  // ─────────────────────────── 登录卡 ───────────────────────────
  const loginCard = el('section', 'card login-card')
  const loginGrid = el('div', 'login-grid')
  const qrPane = el('div', 'qr-pane')
  const qrBox = el('div', 'qr-box')
  const qrTitle = el('div', 'qr-title', '尚未生成二维码')
  const qrSub = el('div', 'qr-sub', '点右侧「获取二维码」开始扫码登录')
  const qrMsg = el('p', 'hint')
  qrMsg.hidden = true
  qrPane.append(qrBox, qrTitle, qrSub, qrMsg)

  const loginSide = el('div', 'login-side')
  const segRow = el('div', 'row')
  const loginSeg = segButtons(loginSide)
  function segButtons(container) {
    const seg = el('span', 'seg')
    for (const item of SOURCES) {
      const button = el('button', null, item.name)
      button.type = 'button'
      button.dataset.value = item.id
      seg.append(button)
    }
    container.append(seg)
    return seg
  }
  const btnQr = el('button', 'btn btn-primary', '获取二维码')
  btnQr.type = 'button'
  const btnQrClose = el('button', 'btn btn-ghost btn-sm', '关闭')
  btnQrClose.type = 'button'
  btnQrClose.hidden = true
  const loginStatusHint = el('span', 'hint-inline', '当前登录状态:')
  const loginTags = el('span', 'row')
  segRow.append(loginSeg, btnQr, btnQrClose, loginStatusHint, loginTags)

  const stepper = el('div', 'stepper')
  const STEPS = ['生成二维码', '等待扫码', '手机确认', '登录成功']
  const stepNodes = STEPS.map((label) => {
    const node = el('div', 'step pending')
    node.append(el('span', 'step-dot'), el('span', 'step-label', label))
    stepper.append(node)
    return node
  })
  const qrMeta = el('p', 'hint')
  qrMeta.hidden = true

  const miniTitle1 = el('div', 'mini-title', '其他登录方式')
  const altRow = el('div', 'row')
  const btnCcSync = el('button', 'btn btn-ghost')
  btnCcSync.type = 'button'
  btnCcSync.append(icon(ICONS.cloud, 14), doc.createTextNode('CookieCloud 同步'))
  const btnPasteOpen = el('button', 'btn btn-ghost')
  btnPasteOpen.type = 'button'
  btnPasteOpen.append(icon(ICONS.clipboard, 14), doc.createTextNode('粘贴整行 Cookie'))
  altRow.append(btnCcSync, btnPasteOpen, el('span', 'hint-inline', '密钥与 Cookie 永不回显'))

  const cookiePanel = el('div', 'cookie-panel')
  cookiePanel.hidden = true
  const cookieText = el('textarea', 'input textarea')
  cookieText.rows = 3
  const cookieSaveRow = el('div', 'row')
  const btnCookieSave = el('button', 'btn btn-primary btn-sm')
  btnCookieSave.type = 'button'
  cookieSaveRow.append(btnCookieSave, el('span', 'hint-inline', '宿主代理会剥离扫码返回的登录 Cookie，扫码成功也存不下登录态时用这个'))
  cookiePanel.append(cookieText, cookieSaveRow)

  const miniTitle2 = el('div', 'mini-title', '音质档位')
  const chips = el('div', 'chips')
  const qualityHint = el('p', 'hint')
  qualityHint.append(el('span', null, '默认: — · 可选档位随来源不同 · 未登录仅可浏览，登录后可入队下载'))
  const vipHint = el('p', 'hint', '下载与音质依赖对应平台会员：网易云 SVIP（母带/臻音）、QQ 绿钻（FLAC 及以上）。')
  loginSide.append(segRow, stepper, qrMeta, miniTitle1, altRow, cookiePanel, miniTitle2, chips, qualityHint, vipHint)
  loginGrid.append(qrPane, loginSide)
  loginCard.append(loginGrid)
  page.append(loginCard)

  // ─────────────────────────── Tabs ───────────────────────────
  const tabs = el('nav', 'tabs')
  const TAB_DEFS = [
    { id: 'search', text: '搜索' },
    { id: 'playlists', text: '我的歌单' },
    { id: 'tasks', text: '任务' },
    { id: 'settings', text: '设置' },
  ]
  const tabBadge = el('span', 'tab-badge')
  const tabButtons = {}
  for (const def of TAB_DEFS) {
    const button = el('button', 'tabbtn', def.text)
    button.type = 'button'
    if (def.id === 'tasks') {
      tabBadge.hidden = true
      button.append(tabBadge)
    }
    button.addEventListener('click', () => switchTab(def.id))
    tabs.append(button)
    tabButtons[def.id] = button
  }
  page.append(tabs)

  // ─────────────────────────── 搜索 tab ───────────────────────────
  const searchCard = el('section', 'card')
  const searchRow = el('div', 'row')
  const searchSeg = el('span', 'seg')
  for (const item of SOURCES) {
    const button = el('button', null, item.name)
    button.type = 'button'
    button.dataset.value = item.id
    searchSeg.append(button)
  }
  const queryInput = el('input', 'input grow')
  queryInput.placeholder = '歌名 歌手'
  const btnSearch = el('button', 'btn btn-primary')
  btnSearch.type = 'button'
  btnSearch.append(icon(ICONS.search, 14), doc.createTextNode('搜索'))
  searchRow.append(el('h3', 'card-title', '搜索'), searchSeg, queryInput, btnSearch)
  const searchTableWrap = el('div', 'tbl-wrap')
  searchTableWrap.hidden = true
  const searchTable = buildSongTable()
  searchTableWrap.append(searchTable.table)
  const searchEmpty = el('p', 'hint', '输入歌名或「歌名 歌手」后回车/点搜索。')
  const searchMoreRow = el('div', 'row')
  const btnSearchMore = el('button', 'btn btn-ghost btn-sm', '加载更多')
  btnSearchMore.type = 'button'
  searchMoreRow.append(el('span', 'hint-inline', ''), btnSearchMore)
  searchMoreRow.hidden = true
  const searchHint = el('p', 'hint', '点「下载」只是入队（去重按 来源+歌曲 id+音质）；真正的取链与下载由后台任务推进，进度看「任务」。')
  searchCard.append(searchRow, searchTableWrap, searchEmpty, searchMoreRow, searchHint)
  page.append(searchCard)

  // ─────────────────────────── 歌单 tab ───────────────────────────
  const plCard = el('section', 'card')
  const plListPane = el('div')
  const plViewPane = el('div')
  plViewPane.hidden = true
  const plHeader = el('div', 'row')
  const plSeg = el('span', 'seg')
  for (const item of SOURCES) {
    const button = el('button', null, item.name)
    button.type = 'button'
    button.dataset.value = item.id
    plSeg.append(button)
  }
  const btnPlReload = el('button', 'btn btn-ghost btn-sm', '刷新')
  btnPlReload.type = 'button'
  plHeader.append(el('h3', 'card-title', '我的歌单'), plSeg, btnPlReload)
  const plList = el('div', 'pl-grid')
  const plHint = el('p', 'hint', '第一次进这个页签会拉取网易云「我的歌单」（需登录）。')
  plListPane.append(plHeader, plList, plHint)

  const plViewHeader = el('div', 'row')
  const btnPlBack = el('button', 'btn btn-ghost btn-sm', '← 返回歌单列表')
  btnPlBack.type = 'button'
  const plBatchQuality = el('select', 'sel')
  const btnPlAll = el('button', 'btn btn-primary btn-sm', '整单下载')
  btnPlAll.type = 'button'
  plViewHeader.append(btnPlBack, el('h3', 'card-title', '歌单'), el('span', 'hint-inline', '统一音质:'), plBatchQuality, btnPlAll)
  const plSongsWrap = el('div', 'tbl-wrap')
  const plSongsTable = buildSongTable()
  plSongsWrap.append(plSongsTable.table)
  const plMoreRow = el('div', 'row')
  const btnPlMore = el('button', 'btn btn-ghost btn-sm')
  btnPlMore.type = 'button'
  plMoreRow.append(btnPlMore)
  plMoreRow.hidden = true
  const plProgress = el('p', 'hint')
  plProgress.hidden = true
  const plViewHint = el('p', 'hint', '「整单下载」按右上角选的统一音质，让后台分批翻页把整张歌单入队（每批 500 首）——不依赖已加载的条数。')
  plViewPane.append(plViewHeader, plSongsWrap, plMoreRow, plProgress, plViewHint)
  plCard.append(plListPane, plViewPane)
  page.append(plCard)

  // ─────────────────────────── 任务 tab ───────────────────────────
  const taskCard = el('section', 'card')
  const taskHeader = el('div', 'row')
  const queueCapsule = el('span', 'badge badge-neutral', '队列空闲')
  const countCapsule = el('span', 'badge badge-neutral', '共 0 条')
  const failedCapsule = el('span', 'badge badge-error')
  failedCapsule.hidden = true
  const btnPump = el('button', 'btn btn-ghost btn-sm')
  btnPump.type = 'button'
  btnPump.append(icon(ICONS.refresh, 13), doc.createTextNode('推进队列'))
  const btnClear = el('button', 'btn btn-ghost btn-sm')
  btnClear.type = 'button'
  btnClear.append(icon(ICONS.trash, 13), doc.createTextNode('清空已完成'))
  taskHeader.append(el('h3', 'card-title', '下载任务'), queueCapsule, countCapsule, failedCapsule, el('span', 'spacer'), btnPump, btnClear)
  const mutexNotice = el('div', 'bar bar-warning')
  mutexNotice.hidden = true
  const mutexText = el('p')
  const btnMutexOk = el('button', 'btn btn-ghost btn-xs', '知道了')
  btnMutexOk.type = 'button'
  mutexNotice.append(mutexText, btnMutexOk)
  const adoptRow = el('div', 'row adopt-row')
  const adoptInput = el('input', 'input grow')
  adoptInput.placeholder = '任务 id（如 2gexs25y）'
  const btnAdopt = el('button', 'btn btn-ghost btn-sm')
  btnAdopt.type = 'button'
  btnAdopt.append(icon(ICONS.retry, 13), doc.createTextNode('索引对账'))
  adoptRow.append(adoptInput, btnAdopt)
  const taskList = el('div', 'task-list')
  const taskEmpty = el('div', 'empty')
  taskEmpty.append(icon(ICONS.inbox, 30), el('p', null, '暂无任务。去「搜索」页选一首歌点下载。'))
  const taskFoot = el('p', 'hint')
  taskCard.append(taskHeader, mutexNotice, adoptRow, taskList, taskEmpty, el('p', 'hint', '任务由后台定时任务（每 5 分钟）推进；想立刻推一轮点「推进队列」（同一入口）。失败任务最多自动重试 3 次，用尽后可在这行点重试，或从 Telegram 失败通知的「重试」按钮重试。若重启后任务「消失」（分片还在、索引丢了），把它的 id 填进输入框点「索引对账」挂回。'), taskFoot)
  page.append(taskCard)

  // ─────────────────────────── 设置 tab ───────────────────────────
  const settingsCard = el('section', 'card')
  const settingsHeader = el('div', 'row')
  const btnSettingsRevert = el('button', 'btn btn-ghost btn-sm', '撤销改动')
  btnSettingsRevert.type = 'button'
  const btnSettingsSave = el('button', 'btn btn-primary btn-sm', '保存')
  btnSettingsSave.type = 'button'
  settingsHeader.append(el('h3', 'card-title', '设置'), el('span', 'spacer'), btnSettingsRevert, btnSettingsSave)
  const settingsGrid = el('div', 'grid')
  const fieldTarget = inputField('目标目录（target_dir）', '/CloudNAS/115open/音乐/音乐下载', '最终落点（宿主绝对路径或 cd2:/网盘路径）；宿主按 CD2 挂载前缀自动分流并报告字节进度。')
  const fieldQuality = selectField('默认音质（quality）', '网易云的档位名（默认 jymaster）；搜索页每首歌还能单独选。QQ 取链与这里无关。')
  const fieldMaxActive = numberField('单轮新开下载数（max_active）', 1, MAX_ACTIVE_CAP, `每轮任务最多推进几个下载，1-${MAX_ACTIVE_CAP}（超出回默认 2）。`)
  const fieldNotify = switchField('失败时发通知', '尝试次数用尽时推送错误通知，通知里带「重试」按钮（callback_data retry:<短id>，仅 Telegram）。')
  settingsGrid.append(fieldTarget.wrap, fieldQuality.wrap, fieldMaxActive.wrap, fieldNotify.wrap)
  const settingsSaveHint = el('p', 'hint')
  const notifyDivider = el('div', 'divider')
  const notifySub = el('h4', 'sub', '通知自检（notify-test）')
  const notifyRow = el('div', 'row')
  const btnNotifyTest = el('button', 'btn btn-ghost btn-sm')
  btnNotifyTest.type = 'button'
  btnNotifyTest.append(icon(ICONS.send, 13), doc.createTextNode('发测试通知'))
  notifyRow.append(btnNotifyTest, el('span', 'hint', '主动发一条 info 通知；v3 宿主支持 callback_data 按钮，失败通知的「重试」按钮直达 Telegram 回调。'))
  const notifyResult = el('p', 'hint')
  notifyResult.hidden = true
  const ccDivider = el('div', 'divider')
  const ccSub = el('h4', 'sub', 'CookieCloud（宿主内置）')
  const ccHint = el('p', 'hint', 'v3 用宿主统一配置的 CookieCloud 服务（不再在插件里填地址/UUID/口令）；点登录卡「CookieCloud 同步」拉取网易云与 QQ 域的登录 Cookie。115 相关域名按宿主策略不可读写。')
  settingsCard.append(settingsHeader, settingsGrid, settingsSaveHint, notifyDivider, notifySub, notifyRow, notifyResult, ccDivider, ccSub, el('div', 'divider'), el('h4', 'sub', '目录与入库（v3）'), el('p', 'hint', '下载先落插件自有暂存目录 downloads/<短id>.part（宿主流式写盘），定名后由宿主 move 进目标目录——「本地暂存目录 staging_dir」与「CD2 直送」设置项随 v3 文件模型移除。'))
  page.append(settingsCard)

  // ─────────────────────────── 最近动作 ───────────────────────────
  const logsCard = el('section', 'card')
  const logsMeta = el('span', 'hint-inline', '最近 0 条')
  const logsHeader = el('div', 'row')
  logsHeader.append(el('h3', 'card-title', '最近动作'), el('span', 'spacer'), logsMeta)
  const lastMessage = el('p', 'hint')
  lastMessage.hidden = true
  const logList = el('div', 'log-list')
  logsCard.append(logsHeader, lastMessage, logList)
  page.append(logsCard)

  page.append(el('footer', 'm-foot', '状态由页面实时读插件 KV 组装 · 任务页有进行中任务时每 5 秒刷新 · 扫码登录每 2 秒轮询 · 页面宽度跟随宿主可用宽度'))

  // ─────────────────────────── 组件构造器 ───────────────────────────
  function buildSongTable() {
    const table = el('table', 'tbl')
    const thead = el('thead')
    const headRow = el('tr')
    for (const label of ['歌曲', '歌手', '专辑', '音质', '']) headRow.append(el('th', null, label))
    thead.append(headRow)
    const tbody = el('tbody')
    table.append(thead, tbody)
    return {
      table,
      tbody,
      render(songs, sourceOf, onDownload) {
        tbody.replaceChildren()
        for (const song of songs) {
          const row = el('tr')
          row.append(el('td', null, song.name || '—'))
          row.append(el('td', null, song.singers || '—'))
          row.append(el('td', 'dim', song.album || '—'))
          const qualityCell = el('td')
          const select = el('select', 'sel')
          for (const value of qualitiesFor(song)) {
            select.append(new Option(QUALITY_LABELS[value] ?? value, value))
          }
          const chosen = qualityOf(song)
          select.value = chosen
          select.addEventListener('change', () => {
            songQuality.set(String(song.id), select.value)
          })
          qualityCell.append(select)
          row.append(qualityCell)
          const actionCell = el('td')
          const button = el('button', 'btn btn-primary btn-xs', '下载')
          button.type = 'button'
          button.addEventListener('click', () => onDownload(song, button))
          actionCell.append(button)
          row.append(actionCell)
          tbody.append(row)
        }
      },
    }
  }

  function inputField(label, placeholder, help) {
    const wrap = el('label', 'field')
    const input = el('input', 'input')
    input.placeholder = placeholder
    wrap.append(el('span', 'label', label), input, el('span', 'hint', help))
    return { wrap, input }
  }
  function selectField(label, help) {
    const wrap = el('label', 'field')
    const select = el('select', 'sel')
    wrap.append(el('span', 'label', label), select, el('span', 'hint', help))
    return { wrap, select }
  }
  function numberField(label, min, max, help) {
    const wrap = el('label', 'field')
    const input = el('input', 'input')
    input.type = 'number'
    input.min = String(min)
    input.max = String(max)
    wrap.append(el('span', 'label', label), input, el('span', 'hint', help))
    return { wrap, input }
  }
  function switchField(label, help) {
    const wrap = el('label', 'field')
    const row = el('span', 'switch-row')
    const input = el('input')
    input.type = 'checkbox'
    const track = el('span', 'track')
    const sw = el('span', 'switch')
    sw.append(input, track)
    row.append(sw)
    wrap.append(el('span', 'label', label), row, el('span', 'hint', help))
    return { wrap, input }
  }

  // ─────────────────────────── 状态与数据 ───────────────────────────
  let state = null
  let tab = 'search'
  const songQuality = new Map()
  let searchResults = []
  let searchPage = 1
  let searchTotal = null
  let playlists = []
  let playlistView = null
  let plSongs = []
  let plTotal = 0
  let plPage = 1
  let qrSession = null
  let qrTimer = null
  let taskTimer = null
  let busy = ''
  let settingsBaseline = normalizeSettings({})
  let notifyOnFailBaseline = true

  const sourceName = (id) => SOURCES.find((item) => item.id === id)?.name ?? id ?? '—'
  const qualityLabel = (value) => QUALITY_LABELS[value] ?? value ?? '—'

  function qualitiesFor(song) {
    const own = Array.isArray(song?.qualities) && song.qualities.length ? song.qualities : null
    if (own) return own
    return SOURCES.find((item) => item.id === (song.source || source))?.qualities ?? ['flac', '320', '128']
  }
  function qualityOf(song) {
    const key = String(song.id ?? '')
    const chosen = songQuality.get(key)
    if (chosen) return chosen
    const list = qualitiesFor(song)
    const own = typeof song.quality === 'string' ? song.quality : ''
    return (own && list.includes(own) ? own : list[0]) || 'flac'
  }

  function setBusy(name) {
    busy = name
    btnQr.disabled = btnSearch.disabled = btnPump.disabled = btnClear.disabled =
      btnAdopt.disabled = btnCcSync.disabled = btnSettingsSave.disabled = btnPlAll.disabled = Boolean(busy)
  }

  function sourceButtons(seg, current, onPick) {
    for (const button of seg.querySelectorAll('button')) {
      const value = button.dataset.value
      button.classList.toggle('on', value === current)
      button.onclick = () => onPick(value)
    }
  }

  async function loadData() {
    try {
      const [settingsRaw, index, logs, neteaseJar, qqJar, pumpState] = await Promise.all([
        readSettings(ctx),
        loadIndex(deps.kv),
        loadLogs(deps.kv),
        loadCookies(deps.kv, 'netease'),
        loadCookies(deps.kv, 'qq'),
        deps.kv.get('state'),
      ])
      const tasks = stateView(index)
      state = {
        settings: settingsRaw,
        tasks,
        login: { netease: neteaseLoginInfo(neteaseJar), qq: qqLoginInfo(qqJar) },
        logs: logs.slice(-50).reverse(),
        last_pump: pumpState?.last_pump ?? null,
      }
      render()
    } catch (error) {
      toast('error', `状态读取失败: ${errorText(error)}`)
    }
  }

  function render() {
    if (disposed.value) return
    const settings = settingsView(state?.settings)
    const login = state?.login ?? {}
    const tasks = state?.tasks ?? []

    // 页头胶囊跟随登录卡当前来源。
    const info = login[loginSource] ?? {}
    headCapsule.className = `badge ${info.logged_in ? 'badge-success' : 'badge-warning'}`
    headCapsule.textContent = `${info.logged_in ? '已登录' : '未登录'} · ${sourceName(loginSource)}`

    // 登录状态标签。
    loginTags.replaceChildren()
    for (const [key, label] of [['netease', '网易云'], ['qq', 'QQ音乐']]) {
      const item = login[key] ?? {}
      const badge = el('span', `badge ${item.logged_in ? 'badge-success' : 'badge-neutral'}`)
      const note = item.logged_in && item.uin ? ` · uin ${item.uin}` : ''
      badge.textContent = `${label} ${item.logged_in ? '已登录' : '未登录'}${note}`
      loginTags.append(badge)
    }

    // 音质 chips（默认音质高亮）。
    chips.replaceChildren()
    for (const value of [...LEVELS, 'master', 'flac', '320', '128'].filter((v, i, a) => a.indexOf(v) === i)) {
      const chip = el('span', `chip${value === settings.quality ? ' on' : ''}`, qualityLabel(value))
      chips.append(chip)
    }
    qualityHint.textContent = `默认: ${qualityLabel(settings.quality)} · 可选档位随来源不同 · 未登录仅可浏览，登录后可入队下载`

    // 搜索来源段。
    sourceButtons(searchSeg, source, () => {})
    sourceButtons(plSeg, source, () => {})
    sourceButtons(loginSeg, loginSource, () => {})

    // 任务徽标。
    const pending = tasks.filter((t) => ['queued', 'downloading', 'copying'].includes(t.status))
    const failed = tasks.filter((t) => t.status === 'failed')
    tabBadge.hidden = pending.length === 0
    tabBadge.textContent = String(pending.length)
    queueCapsule.className = `badge ${pending.length ? 'badge-success' : 'badge-neutral'}`
    queueCapsule.textContent = pending.length ? '队列自动推进中' : '队列空闲'
    countCapsule.textContent = `共 ${tasks.length} 条`
    failedCapsule.hidden = failed.length === 0
    failedCapsule.textContent = `失败 ${failed.length}`
    taskFoot.textContent = `下载目录: ${settings.target_dir} · 命名: {歌手} - {歌名}.{格式} · 失败任务保留完整 error`
    renderTasks(tasks)

    // 设置表单基线（用户没在编辑时跟随）。
    if (!dirtySettings()) {
      fieldTarget.input.value = settings.target_dir
      fieldQuality.select.replaceChildren()
      for (const value of [...LEVELS, 'master', 'flac', '320', '128'].filter((v, i, a) => a.indexOf(v) === i)) {
        fieldQuality.select.append(new Option(qualityLabel(value), value))
      }
      fieldQuality.select.value = settings.quality
      fieldMaxActive.input.value = String(settings.max_active)
      fieldNotify.input.checked = settings.notify_on_fail
      settingsBaseline = settings
      notifyOnFailBaseline = settings.notify_on_fail
    }

    // 最近动作。
    const logs = state?.logs ?? []
    logsMeta.textContent = `最近 ${logs.length} 条${state?.last_pump ? ` · 上轮推进 ${formatTime(state.last_pump.at)}` : ''}`
    const lastPumpMessage = (state?.last_pump?.messages ?? []).map((m) => String(m).trim()).filter(Boolean).pop()
    if (lastPumpMessage) {
      lastMessage.hidden = false
      lastMessage.textContent = lastPumpMessage
    }
    logList.replaceChildren()
    for (const entry of logs) {
      const row = el('div', 'log-row')
      row.append(
        el('span', 'log-time', formatTime(entry.at)),
        el('span', `log-dot ${entry.level === 'warning' ? 'dot-warning' : entry.level === 'error' ? 'dot-error' : 'dot-muted'}`),
        el('span', 'log-msg', entry.message || '—'),
      )
      logList.append(row)
    }

    // 歌单整单下载的音质选项。
    plBatchQuality.replaceChildren()
    for (const value of LEVELS) plBatchQuality.append(new Option(qualityLabel(value), value))

    // tab 显隐。
    searchCard.hidden = tab !== 'search'
    plCard.hidden = tab !== 'playlists'
    taskCard.hidden = tab !== 'tasks'
    settingsCard.hidden = tab !== 'settings'
    for (const [id, button] of Object.entries(tabButtons)) button.classList.toggle('on', id === tab)
  }

  function renderTasks(tasks) {
    taskList.replaceChildren()
    taskEmpty.hidden = tasks.length > 0
    for (const task of tasks) {
      const row = el('div', 'task-row')
      const tile = el('div', 'task-tile')
      tile.append(icon(ICONS.music, 17))
      tile.className = `task-tile ${task.status === 'downloading' || task.status === 'copying' ? 'tile-primary' : task.status === 'queued' ? 'tile-info' : task.status === 'done' ? 'tile-success' : task.status === 'failed' ? 'tile-error' : 'tile-muted'}`
      const main = el('div', 'task-main')
      main.append(
        el('div', 'task-title', `${task.name || '—'}${task.singers ? ` · ${task.singers}` : ''}`),
        el('div', 'task-sub', `${qualityLabel(task.quality)} · ${sourceName(task.source)}${task.error ? ` · ${task.error}` : ''}`),
      )
      row.append(tile, main)
      if (task.status === 'downloading' || task.status === 'copying') {
        row.append(el('div', 'task-progress', (() => { const bar = el('div', 'indet'); return bar })()))
      }
      if (task.status === 'failed') {
        const button = el('button', 'icon-btn retry-btn')
        button.type = 'button'
        button.title = '重试(task-retry)'
        button.append(icon(ICONS.retry, 14))
        button.addEventListener('click', () => retryTask(task))
        row.append(button)
      }
      const meta = STATUS_META[task.status] ?? { label: task.status || '未知', cls: 'badge-neutral' }
      const badge = el('span', `badge ${meta.cls}`, meta.label)
      if (task.status === STATUS_QUEUED) {
        const queue = tasks.filter((t) => t.status === STATUS_QUEUED)
        const position = queue.findIndex((t) => t.id === task.id)
        badge.textContent = position >= 0 ? `排队中 · 第 ${position + 1} 位` : '排队中'
      }
      row.append(badge)
      taskList.append(row)
    }
  }

  function formatTime(value) {
    const raw = typeof value === 'string' ? value : ''
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw)
    return match ? `${match[4]}:${match[5]}:${match[6] || '00'}` : raw || '—'
  }

  function dirtySettings() {
    if (!fieldTarget.input.value && !fieldQuality.select.value) return false
    return fieldTarget.input.value !== settingsBaseline.target_dir ||
      fieldQuality.select.value !== settingsBaseline.quality ||
      Number(fieldMaxActive.input.value) !== settingsBaseline.max_active ||
      fieldNotify.input.checked !== settingsBaseline.notify_on_fail
  }

  // ─────────────────────────── 动作 ───────────────────────────

  let loginSource = 'netease'
  let source = 'netease'

  function switchTab(id) {
    tab = id
    if (id === 'playlists' && !playlists.length && !playlistView && !busy) void loadPlaylists()
    render()
  }

  async function withBusy(name, label, fn) {
    if (busy) return
    setBusy(name)
    try {
      return await fn()
    } catch (error) {
      toast('error', `${label}: ${errorText(error)}`)
      return undefined
    } finally {
      setBusy('')
      await loadData()
    }
  }

  // 搜索。
  async function runSearch(nextPage) {
    const text = queryInput.value.trim()
    if (!text) return
    await withBusy('search', '搜索失败', async () => {
      if (source === 'netease') {
        const result = await neteaseSearch(deps, text, nextPage)
        searchResults = nextPage > 1 ? [...searchResults, ...result.songs] : result.songs
        searchTotal = typeof result.total === 'number' ? result.total : null
      } else {
        const { qqSearch } = await import('../lib/music-api.js')
        const result = await qqSearch(deps, text, nextPage)
        searchResults = nextPage > 1 ? [...searchResults, ...result.songs] : result.songs
        searchTotal = null
      }
      searchPage = nextPage
      renderSearch()
      if (!searchResults.length) toast('info', '没有搜索到内容')
    })
  }

  function renderSearch() {
    searchTableWrap.hidden = searchResults.length === 0
    searchEmpty.hidden = searchResults.length > 0
    searchTable.render(searchResults, () => source, (song, button) => downloadSong(song, button))
    const pageSize = source === 'qq' ? 20 : 30
    const hasMore = searchResults.length > 0 &&
      (searchTotal !== null ? searchResults.length < searchTotal : searchResults.length % pageSize === 0)
    searchMoreRow.hidden = searchResults.length === 0
    searchMoreRow.querySelector('span').textContent =
      `已显示 ${searchResults.length} 条${searchTotal !== null ? ` / 共 ${searchTotal} 条` : ''} · 第 ${searchPage} 页`
    btnSearchMore.hidden = !hasMore
  }

  // 单曲入队（搜索页 / 歌单页共用；失败一律就地处理，绝不外抛）。
  async function downloadSong(song, button) {
    button.disabled = true
    try {
      const outcome = await enqueue(deps.kv, {
        source: song.source || source,
        song_id: String(song.id ?? '').trim(),
        name: song.name ?? '',
        singers: song.singers ?? '',
        album: song.album ?? '',
        quality: qualityOf(song),
      })
      if (outcome.deduped) {
        toast('info', `队列里已有同一首（${qualityLabel(outcome.task.quality)}），已复用任务 ${outcome.task.id}`)
      } else {
        toast('success', `已入队: ${song.name ?? outcome.task.id} · ${qualityLabel(outcome.task.quality)}`)
      }
      await addLog(deps.kv, 'info', `入队: ${song.name ?? outcome.task.id} · ${qualityLabel(outcome.task.quality)}${outcome.deduped ? '（命中去重复用）' : ''}`)
    } catch (error) {
      toast('error', loginHint(errorText(error)))
    } finally {
      button.disabled = false
      await loadData()
    }
  }

  function loginHint(text) {
    return text.includes(MUSIC_NOT_LOGIN_HINT) ? `${text} —— 先在上方「扫码登录」卡片扫码或粘贴 Cookie` : text
  }

  // 扫码登录。
  function setQrPane(title, sub) {
    qrTitle.textContent = title
    qrSub.textContent = sub
  }

  function renderQrSteps(status, qrBusy) {
    const states = [
      status === '' ? (qrBusy ? 'active' : 'pending') : 'done',
      status === 'waiting' ? 'active' : ['scanned', 'success'].includes(status) ? 'done' : ['expired', 'failed'].includes(status) ? 'error' : 'pending',
      status === 'scanned' ? 'active' : status === 'success' ? 'done' : 'pending',
      status === 'success' ? 'done' : 'pending',
    ]
    stepNodes.forEach((node, i) => {
      node.className = `step ${states[i]}`
      node.querySelector('.step-dot').textContent = states[i] === 'done' ? '✓' : states[i] === 'error' ? '!' : ''
    })
  }

  async function createQr(src) {
    stopQrPolling()
    qrBox.replaceChildren(el('div', 'qr-fallback', qrBusyLabel(true)))
    setQrPane('正在生成二维码…', '')
    renderQrSteps('', true)
    try {
      if (src === 'qq') throw new Error(QR_UNAVAILABLE)
      const data = await neteaseQrCreate(deps)
      qrSession = { source: src, key: data.key, content: data.qr_content, expiresAt: Date.now() + 180 * 1000 }
      drawQr(qrSession.content)
      setQrPane('等待扫码', `用${sourceName(src)}音乐 App 扫一扫`)
      renderQrSteps('waiting', false)
      qrMeta.hidden = false
      qrMeta.textContent = `${sourceName(src)} · key ${qrSession.key} · 每 2 秒轮询一次`
      btnQrClose.hidden = false
      scheduleQrPoll()
    } catch (error) {
      resetQr()
      toast('error', errorText(error))
    }
  }
  const qrBusyLabel = (busyNow) => busyNow ? '生成中…' : '未生成'

  function drawQr(content) {
    try {
      const code = encodeQr(content, 'M')
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('class', 'qr-svg')
      svg.setAttribute('viewBox', `0 0 ${code.size + 8} ${code.size + 8}`)
      svg.setAttribute('shape-rendering', 'crispEdges')
      svg.setAttribute('role', 'img')
      svg.setAttribute('aria-label', '扫码登录二维码')
      const bg = doc.createElementNS('http://www.w3.org/2000/svg', 'rect')
      bg.setAttribute('width', '100%')
      bg.setAttribute('height', '100%')
      bg.setAttribute('fill', '#ffffff')
      const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g')
      g.setAttribute('transform', 'translate(4 4)')
      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', qrSvgPath(code))
      path.setAttribute('fill', '#000000')
      g.append(path)
      svg.append(bg, g)
      qrBox.replaceChildren(svg)
    } catch (error) {
      qrBox.replaceChildren(el('div', 'qr-fallback qr-fallback-error', errorText(error)))
    }
  }

  function scheduleQrPoll() {
    stopQrPolling()
    qrTimer = setTimeout(() => void pollQr(), POLL_INTERVAL_MS)
  }

  async function pollQr() {
    const session = qrSession
    if (!session) return
    if (Date.now() > session.expiresAt) {
      setQrPane('二维码已过期', '请重新获取')
      renderQrSteps('expired', false)
      toast('warning', '二维码已过期，请重新获取')
      return
    }
    try {
      const result = await neteaseQrPoll(deps, session.key)
      qrMsg.hidden = !result.message
      qrMsg.textContent = result.message ?? ''
      if (result.status === 'success' || result.logged_in === true) {
        renderQrSteps('success', false)
        setQrPane('登录成功', '登录态已保存')
        stopQrPolling()
        qrSession = null
        if (result.logged_in === true) toast('success', '登录成功')
        else toast('warning', result.message || '扫码成功，但未能取得登录 Cookie；请改用「手动粘贴 Cookie」')
        await loadData()
        return
      }
      if (result.status === 'expired') {
        setQrPane('二维码已过期', '请重新获取')
        renderQrSteps('expired', false)
        stopQrPolling()
        toast('warning', '二维码已过期，请重新获取')
        return
      }
      if (result.status === 'scanned') setQrPane('已扫码', '请在手机上确认')
      renderQrSteps(result.status || 'waiting', false)
      scheduleQrPoll()
    } catch (error) {
      qrMsg.hidden = false
      qrMsg.textContent = errorText(error)
      renderQrSteps('failed', false)
      scheduleQrPoll()
    }
  }

  function stopQrPolling() {
    if (qrTimer !== null) {
      clearTimeout(qrTimer)
      qrTimer = null
    }
  }

  function resetQr() {
    stopQrPolling()
    qrSession = null
    qrBox.replaceChildren(el('div', 'qr-fallback', (() => {
      const wrap = el('span')
      wrap.append(icon(ICONS.qr, 28), doc.createTextNode('未生成'))
      return wrap
    })()))
    setQrPane('尚未生成二维码', '点右侧「获取二维码」开始扫码登录')
    renderQrSteps('', false)
    qrMsg.hidden = true
    qrMeta.hidden = true
    btnQrClose.hidden = true
  }

  // 手动粘贴 Cookie。
  async function pasteCookie() {
    const raw = cookieText.value.trim()
    if (!raw) {
      toast('warning', '请先粘贴 Cookie 头（浏览器 F12 → Network → 任意请求 → 请求头里的 Cookie 整行）')
      return
    }
    await withBusy('paste', 'Cookie 保存失败', async () => {
      if (loginSource === 'qq') {
        const cleaned = cleanQqCookieString(raw)
        if (cleaned.error) throw new Error(cleaned.error)
        const merged = await saveCookies(deps.kv, 'qq', cleaned.jar)
        toast('success', `QQ Cookie 已保存（${Object.keys(cleaned.jar).length} 条，合并后 ${Object.keys(merged).length} 条）`)
      } else {
        const cleaned = cleanNeteaseCookieString(raw)
        if (cleaned.error) throw new Error(cleaned.error)
        const merged = await saveCookies(deps.kv, 'netease', cleaned.jar)
        toast('success', `网易云 Cookie 已保存（${Object.keys(cleaned.jar).length} 条，合并后 ${Object.keys(merged).length} 条）`)
      }
      cookieText.value = ''
      await addLog(deps.kv, 'info', `${sourceName(loginSource)} 手动粘贴 Cookie 已保存`)
    })
  }

  // CookieCloud 同步（v3 宿主内置服务）。
  async function syncFromCookieCloud() {
    await withBusy('cc', 'CookieCloud 同步失败', async () => {
      const snapshot = await ctx.cookiecloud('read', { domains: ['music.163.com', 'qq.com'] })
      const neteaseJar = extractCookiesFromSnapshot(snapshot, isNeteaseCloudDomain, NETEASE_WHITELIST)
      const qqRaw = extractCookiesFromSnapshot(snapshot, isQqCloudDomain, QQ_WHITELIST)
      const qqJar = normalizeCookies({ ...qqRaw }, 'qq')
      const neteaseMerged = await saveCookies(deps.kv, 'netease', neteaseJar)
      const qqMerged = await saveCookies(deps.kv, 'qq', qqJar)
      const neteaseInfo = neteaseLoginInfo(neteaseMerged)
      const qqInfo = qqLoginInfo(qqMerged)
      toast('success', `CookieCloud 同步完成 —— 网易云: 保存 ${Object.keys(neteaseJar).length} 条, ${neteaseInfo.logged_in ? '已登录' : '未登录'}; QQ: 保存 ${Object.keys(qqJar).length} 条, ${qqInfo.logged_in ? '已登录' : '未登录'}`)
      await addLog(deps.kv, 'info', `CookieCloud 同步: 网易云 ${Object.keys(neteaseJar).length} 条(${neteaseInfo.logged_in ? '已登录' : '未登录'}), QQ ${Object.keys(qqJar).length} 条(${qqInfo.logged_in ? '已登录' : '未登录'})`)
    })
  }
  const NETEASE_WHITELIST = ['MUSIC_U', 'MUSIC_A', 'MUSIC_A_T', 'MUSIC_R_T', 'MUSIC_SNS', 'NMTID', '__csrf', '__csrf_token', '_ntes_nuid', '_ntes_nnid']
  const QQ_WHITELIST = ['qrsig', 'uin', 'skey', 'p_skey', 'ptui_loginuin', 'luin', 'qqmusic_key', 'musickey', 'wxuin', 'wxunionid', 'euin', 'tmeLoginType', 'qqmusic_u']

  // 歌单。
  async function loadPlaylists() {
    await withBusy('playlists', '歌单获取失败', async () => {
      if (source !== 'netease') {
        toast('warning', '该来源暂不支持歌单，先支持网易云')
        return
      }
      const result = await neteasePlaylists(deps)
      playlists = result.playlists
      renderPlaylists()
      if (!playlists.length) toast('info', '没有取到歌单（可能还没登录）')
    })
  }

  function renderPlaylists() {
    plList.replaceChildren()
    plHint.hidden = playlists.length > 0
    for (const playlist of playlists) {
      const card = el('button', 'pl-card')
      card.type = 'button'
      const cover = el('div', 'pl-cover')
      if (playlist.cover) {
        const img = doc.createElement('img')
        img.src = playlist.cover
        img.alt = ''
        img.loading = 'lazy'
        img.addEventListener('error', () => img.remove())
        cover.append(img)
      }
      card.append(cover, el('div', 'pl-name', playlist.name || '—'), el('div', 'pl-meta', `${playlist.count ?? 0} 首 · ${playlist.creator || ''}`))
      card.addEventListener('click', () => void openPlaylist(playlist))
      plList.append(card)
    }
  }

  async function openPlaylist(playlist) {
    const id = String(playlist.id ?? '')
    if (!id) return
    playlistView = { id, name: String(playlist.name || '') }
    plSongs = []
    plTotal = Number(playlist.count) || 0
    plPage = 1
    plListPane.hidden = true
    plViewPane.hidden = false
    plViewHeader.querySelector('h3').textContent = playlist.name || '歌单'
    await fetchPlaylistSongs(1)
  }

  function closePlaylistView() {
    playlistView = null
    plSongs = []
    plTotal = 0
    plPage = 1
    plViewPane.hidden = true
    plListPane.hidden = false
  }

  async function fetchPlaylistSongs(nextPage) {
    if (!playlistView) return
    await withBusy('pl-songs', '歌单内容获取失败', async () => {
      const result = await neteasePlaylistSongs(deps, playlistView.id, nextPage, 100)
      plSongs = nextPage > 1 ? [...plSongs, ...result.songs] : result.songs
      plPage = nextPage
      if (result.name) plViewHeader.querySelector('h3').textContent = result.name
      if (typeof result.total === 'number') plTotal = result.total
      plSongsTable.render(plSongs, () => 'netease', (song, button) => downloadSong(song, button))
      plSongsWrap.hidden = plSongs.length === 0
      const hasMore = plSongs.length > 0 && plSongs.length < plTotal
      plMoreRow.hidden = !hasMore && plSongs.length === 0
      btnPlMore.textContent = `加载更多（已载 ${plSongs.length}/${plTotal}）`
      btnPlMore.hidden = !hasMore
    })
  }

  // 整单下载（分批循环，后端分批翻页入队）。
  async function downloadPlaylistAll() {
    if (!playlistView) {
      toast('warning', '请先打开一个歌单')
      return
    }
    await withBusy('pl-all', '整单入队失败', async () => {
      const total = plTotal > 0 ? plTotal : 0
      let queued = 0
      let deduped = 0
      let seen = 0
      let nextPage = 1
      let stopped = ''
      let skipped = ''
      // 整批只拉一次 v6 全量索引（0.3.15 形态），各页纯本地切片。
      let index = null
      plProgress.hidden = false
      for (;;) {
        const result = await queuePlaylistPages(
          async (song) => {
            const outcome = await enqueue(deps.kv, {
              source: 'netease',
              song_id: String(song.id ?? '').trim(),
              name: song.name ?? '',
              singers: song.singers ?? '',
              album: song.album ?? '',
              quality: plBatchQuality.value || DEFAULT_QUALITY,
            })
            return { deduped: outcome.deduped }
          },
          async (page, pageSize) => {
            if (!index) index = await neteasePlaylistIndex({ ...deps, playlistId: playlistView.id })
            return neteasePlaylistSongsFromIndex(deps, index, page, pageSize)
          },
          { startPage: nextPage, batchPages: PLAYLIST_QUEUE_DEFAULT_PAGES },
        )
        queued += result.data.queued
        deduped += result.data.deduped
        seen += result.data.total_seen
        plProgress.textContent = `已入队 ${queued} 首(去重 ${deduped}), 进度 ${seen}${total > 0 ? `/${total}` : ''}`
        if (result.status === 'skipped') {
          skipped = result.message
          break
        }
        if (result.status === 'failed') {
          stopped = result.message
          break
        }
        if (result.data.has_more !== true) break
        const cursor = Number(result.data.next_page)
        if (!Number.isFinite(cursor) || cursor <= nextPage) {
          stopped = '入队游标没有前进(后端未按 next_page 续跑), 已停止以免重复请求'
          break
        }
        nextPage = cursor
      }
      plProgress.hidden = true
      if (skipped) {
        noteQueueBusy(skipped)
        toast('warning', `${skipped}；已入队 ${queued} 首(去重 ${deduped})，未完成的可稍后再试`)
      } else if (stopped) {
        toast('error', `${loginHint(stopped)}；已入队 ${queued} 首(去重 ${deduped})，未完成的可重试`)
      } else {
        toast('success', `整单入队完成：新增 ${queued} 首，去重 ${deduped} 首${seen > 0 ? `（共处理 ${seen}${total > 0 ? `/${total}` : ''} 首）` : ''}，进度去「任务」tab 看`)
        await addLog(deps.kv, 'info', `整单入队: ${playlistView.name} 新增 ${queued} 首, 去重 ${deduped} 首`)
      }
    })
  }

  function noteQueueBusy(text) {
    const trimmed = String(text ?? '').trim()
    if (!trimmed) return
    mutexText.textContent = trimmed
    mutexNotice.hidden = false
  }

  // 任务动作。
  async function retryTask(task) {
    await withBusy(`retry-${task.id}`, '重试失败', async () => {
      const outcome = await retry(deps.kv, task.id)
      toast('success', String(outcome.message || '已重新排队'))
      await addLog(deps.kv, 'info', `任务 ${task.id} 已重新排队`)
    })
  }

  async function pumpQueue() {
    await withBusy('pump', '推进失败', async () => {
      const run = await ctx.tasks.run('queue-pump', `pump-${Date.now()}`, {})
      const finished = await pollRun(run, 30000)
      if (finished.status === 'failed') throw new Error(finished.error || '推进失败')
      if (finished.status === 'attention_required') throw new Error('任务需要核对（见宿主任务队列）')
      const summary = finished.result ?? {}
      const lines = (summary.messages ?? []).map((m) => String(m).trim()).filter(Boolean)
      toast('success', lines.length > 0 ? lines.slice(0, 3).join('；') : `已推进（排队 ${summary.queued ?? 0} · 进行中 ${summary.active ?? 0}）`)
    })
  }

  async function pollRun(run, timeoutMs) {
    const started = Date.now()
    let current = run
    while (current && (current.status === 'queued' || current.status === 'running')) {
      if (disposed.value || ctx.signal?.aborted) throw new Error('页面已关闭，任务转入后台继续')
      if (Date.now() - started > timeoutMs) {
        return { ...current, status: 'running', message: `任务仍在运行（${current.id}），可在宿主任务队列查看` }
      }
      await new Promise((resolve) => setTimeout(resolve, 800))
      current = await ctx.tasks.get(current.id)
    }
    return current
  }

  async function clearAllFinished() {
    await withBusy('clear', '清理失败', async () => {
      const removed = await clearFinished(deps.kv)
      toast('success', removed > 0 ? `已清理 ${removed} 条已结束任务` : '没有已结束的任务')
      if (removed > 0) await addLog(deps.kv, 'info', `已清理 ${removed} 条已结束任务`)
    })
  }

  async function adoptTask() {
    const id = adoptInput.value.trim()
    if (!id) {
      toast('info', '请输入任务 id（下载任务页可见，如 2gexs25y）')
      return
    }
    await withBusy('adopt', '对账失败', async () => {
      const outcome = await adopt(deps.kv, id)
      if (outcome.adopted) {
        adoptInput.value = ''
        toast('success', String(outcome.message || '已挂回索引'))
        await addLog(deps.kv, 'info', `索引对账: 任务 ${id} 已挂回索引`)
      } else {
        toast('info', String(outcome.message || '已在索引里，无需对账'))
      }
    })
  }

  // 设置保存。
  async function saveSettings() {
    if (!dirtySettings()) {
      toast('info', '没有改动')
      return
    }
    await withBusy('settings', '设置保存失败', async () => {
      const current = normalizeSettings(state?.settings)
      const next = applySettingsPatch(current, {
        target_dir: fieldTarget.input.value.trim(),
        quality: fieldQuality.select.value,
        max_active: Number(fieldMaxActive.input.value),
        notify_on_fail: fieldNotify.input.checked,
      })
      await ctx.settings.set(next)
      settingsBaseline = settingsView(next)
      toast('success', '设置已保存')
      await addLog(deps.kv, 'info', '设置已保存')
    })
  }

  // 通知自检。
  async function testNotify() {
    await withBusy('notify', '通知自检失败', async () => {
      const outcome = await ctx.notify({
        level: 'info',
        title: '音乐下载 · 通知链路自检',
        body: '这是一条测试通知: 收到说明插件通知可用。',
        dedupe_key: `mr-dl-notifytest-${Date.now()}`,
      })
      const parts = [`accepted: ${outcome?.accepted}`, outcome?.deduplicated ? '（被去重）' : '']
      if (outcome?.channels?.length) {
        parts.push(`通道: ${outcome.channels.map((c) => c.channel).join(' · ')}`)
      }
      notifyResult.hidden = false
      notifyResult.textContent = parts.filter(Boolean).join(' · ')
      toast(outcome?.accepted ? 'success' : 'warning', notifyResult.textContent)
    })
  }

  // ─────────────────────────── 事件接线 ───────────────────────────
  for (const button of loginSeg.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      if (loginSource === button.dataset.value) return
      loginSource = button.dataset.value
      resetQr()
      render()
    })
  }
  btnQr.addEventListener('click', () => void createQr(loginSource))
  btnQrClose.addEventListener('click', resetQr)
  btnCookie.addEventListener('click', () => {
    cookiePanel.hidden = !cookiePanel.hidden
    if (!cookiePanel.hidden) {
      loginCard.scrollIntoView({ behavior: 'smooth', block: 'start' })
      cookieText.placeholder = `浏览器登录 ${loginSource === 'qq' ? 'y.qq.com' : 'music.163.com'} 后，F12 → Network → 任选一个请求 → 复制请求头里的 Cookie 整行粘贴到这里`
      btnCookieSave.textContent = `保存 ${sourceName(loginSource)} Cookie`
    }
  })
  btnPasteOpen.addEventListener('click', () => {
    cookiePanel.hidden = !cookiePanel.hidden
    btnCookieSave.textContent = `保存 ${sourceName(loginSource)} Cookie`
  })
  btnCookieSave.addEventListener('click', () => void pasteCookie())
  btnCcSync.addEventListener('click', () => void syncFromCookieCloud())
  queryInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void runSearch(1)
  })
  btnSearch.addEventListener('click', () => void runSearch(1))
  btnSearchMore.addEventListener('click', () => void runSearch(searchPage + 1))
  for (const button of searchSeg.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      if (source === button.dataset.value) return
      source = button.dataset.value
      searchResults = []
      searchTotal = null
      searchPage = 1
      renderSearch()
      render()
    })
  }
  for (const button of plSeg.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      if (source === button.dataset.value) return
      source = button.dataset.value
      playlists = []
      closePlaylistView()
      if (source !== 'netease') toast('warning', '该来源暂不支持歌单，先支持网易云')
      else void loadPlaylists()
      render()
    })
  }
  btnPlReload.addEventListener('click', () => void loadPlaylists())
  btnPlBack.addEventListener('click', closePlaylistView)
  btnPlMore.addEventListener('click', () => void fetchPlaylistSongs(plPage + 1))
  btnPlAll.addEventListener('click', () => void downloadPlaylistAll())
  btnPump.addEventListener('click', () => void pumpQueue())
  btnClear.addEventListener('click', () => void clearAllFinished())
  btnAdopt.addEventListener('click', () => void adoptTask())
  btnSettings.addEventListener('click', () => switchTab('settings'))
  btnSettingsSave.addEventListener('click', () => void saveSettings())
  btnSettingsRevert.addEventListener('click', () => {
    fieldTarget.input.value = settingsBaseline.target_dir
    fieldQuality.select.value = settingsBaseline.quality
    fieldMaxActive.input.value = String(settingsBaseline.max_active)
    fieldNotify.input.checked = settingsBaseline.notify_on_fail
  })
  btnNotifyTest.addEventListener('click', () => void testNotify())
  btnMutexOk.addEventListener('click', () => {
    mutexNotice.hidden = true
  })

  // 任务页有进行中任务时每 5 秒跟随队列刷新。
  function ensureTaskTimer() {
    const pending = (state?.tasks ?? []).some((t) => ['queued', 'downloading', 'copying'].includes(t.status))
    if (tab === 'tasks' && pending && taskTimer === null) {
      taskTimer = setInterval(() => { if (!busy) void loadData() }, TASK_REFRESH_MS)
    } else if ((!pending || tab !== 'tasks') && taskTimer !== null) {
      clearInterval(taskTimer)
      taskTimer = null
    }
  }
  const originalRender = render
  render = function () {
    originalRender()
    ensureTaskTimer()
  }

  // 主题订阅（明暗切换时无需重绘 —— 样式全部走宿主 CSS 变量）。
  const unsubscribeTheme = ctx.theme?.subscribe?.(() => {})

  // ─────────────────────────── 启动 ───────────────────────────
  resetQr()
  render()
  await loadData()

  return function cleanup() {
    disposed.value = true
    stopQrPolling()
    if (taskTimer !== null) clearInterval(taskTimer)
    unsubscribeTheme?.()
  }
}

// CSS（宿主 CSS 变量 --app-*，暗色主题自动跟随）。
const CSS_TEXT = `
.m3 { display: grid; gap: 16px; width: 100%; max-width: 100%; min-width: 0; padding: 4px 0 12px;
  color: var(--app-text, rgba(0,0,0,.88)); font-family: inherit; }
.m3 h1 { margin: 0; font-size: 20px; font-weight: 600; }
.m3 h3 { margin: 0; font-size: 16px; font-weight: 600; }
.m3 h4 { margin: 0; font-size: 13px; font-weight: 600; }
.m-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.m-brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.m-brand-icon { width: 44px; height: 44px; flex: none; display: flex; align-items: center; justify-content: center;
  border-radius: 12px; color: var(--app-accent, #2080f0); background: color-mix(in srgb, var(--app-accent, #2080f0) 11%, transparent); }
.m-brand-text p { margin: 2px 0 0; font-size: 13px; color: var(--app-text-secondary, rgba(0,0,0,.72)); }
.m-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.badge { display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; font-size: 12px; font-weight: 500;
  line-height: 1; padding: 4px 10px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.badge-success { color: #18a058; background: color-mix(in srgb, #18a058 14%, transparent); }
.badge-warning { color: #f0a020; background: color-mix(in srgb, #f0a020 14%, transparent); }
.badge-error { color: #d03050; background: color-mix(in srgb, #d03050 14%, transparent); }
.badge-info { color: var(--app-accent, #2080f0); background: color-mix(in srgb, var(--app-accent, #2080f0) 14%, transparent); }
.badge-neutral { color: var(--app-text-secondary, #8a919c); background: color-mix(in srgb, var(--app-text-secondary, #8a919c) 14%, transparent); }
.badge-solid { color: #fff; background: var(--app-accent, #2080f0); }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 18px; border-radius: 10px;
  font-size: 13px; font-weight: 500; line-height: 1.2; cursor: pointer; border: 1px solid transparent; background: transparent;
  color: inherit; transition: background-color .15s, border-color .15s, opacity .15s; white-space: nowrap; }
.btn:disabled { opacity: .55; cursor: not-allowed; }
.btn-primary { background: var(--app-accent, #2080f0); color: #fff; }
.btn-ghost { border-color: var(--app-border, #e0e4ea); background: var(--app-surface, #fff); color: inherit; }
.btn-ghost:hover:not(:disabled) { background: color-mix(in srgb, var(--app-accent, #2080f0) 8%, transparent); }
.btn-sm { padding: 5px 12px; font-size: 12px; border-radius: 8px; }
.btn-xs { padding: 3px 10px; font-size: 12px; border-radius: 7px; }
.icon-btn { width: 34px; height: 34px; flex: none; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 9px; border: 1px solid var(--app-border, #e0e4ea); background: var(--app-surface, #fff);
  color: var(--app-text-secondary, rgba(0,0,0,.72)); cursor: pointer; }
.icon-btn:disabled { opacity: .55; cursor: not-allowed; }
.retry-btn { color: #d03050; }
.card { border: 1px solid var(--app-border, #e0e4ea); border-radius: 12px; background: var(--app-surface, #fff);
  padding: 20px 24px; display: grid; gap: 12px; min-width: 0; }
.card-title { margin: 0; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.spacer { flex: 1; }
.grow { flex: 1; min-width: 160px; }
.hint { color: var(--app-text-secondary, rgba(0,0,0,.45)); font-size: 12px; margin: 0; line-height: 1.6; }
.hint-inline { color: var(--app-text-secondary, rgba(0,0,0,.45)); font-size: 12px; }
.mono { font-family: ui-monospace, monospace; }
.input { padding: 7px 12px; border-radius: 9px; border: 1px solid var(--app-border, #e0e4ea);
  background: var(--app-bg, transparent); color: inherit; font-size: 13px; min-width: 0; }
.input:focus { outline: 2px solid color-mix(in srgb, var(--app-accent, #2080f0) 35%, transparent); outline-offset: -1px; }
.textarea { width: 100%; resize: vertical; font-family: ui-monospace, monospace; font-size: 12px; }
.sel { padding: 5px 8px; border-radius: 8px; border: 1px solid var(--app-border, #e0e4ea);
  background: var(--app-bg, transparent); color: inherit; font-size: 12px; }
.seg { display: inline-flex; border: 1px solid var(--app-border, #e0e4ea); border-radius: 9px; overflow: hidden; }
.seg button { border: none; background: transparent; color: inherit; padding: 6px 14px; font-size: 13px; cursor: pointer; }
.seg button.on { background: var(--app-accent, #2080f0); color: #fff; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--app-border, #e0e4ea); }
.tabbtn { position: relative; border: none; background: none; color: var(--app-text-secondary, rgba(0,0,0,.6));
  padding: 10px 16px; font-size: 14px; cursor: pointer; }
.tabbtn.on { color: var(--app-accent, #2080f0); font-weight: 600; }
.tabbtn.on::after { content: ''; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2px;
  background: var(--app-accent, #2080f0); border-radius: 2px; }
.tab-badge { display: inline-flex; margin-left: 6px; padding: 1px 7px; border-radius: 999px; font-size: 11px;
  background: #d03050; color: #fff; }
.tbl-wrap { overflow: auto; border: 1px solid var(--app-border, #e0e4ea); border-radius: 10px; max-height: 420px; }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th, .tbl td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--app-border, #e0e4ea); white-space: nowrap; }
.tbl th { position: sticky; top: 0; background: var(--app-surface, #fff); font-weight: 600; z-index: 1; }
.tbl td.dim { color: var(--app-text-secondary, rgba(0,0,0,.45)); }
.login-grid { display: grid; grid-template-columns: 260px 1fr; gap: 24px; }
@media (max-width: 760px) { .login-grid { grid-template-columns: 1fr; } }
.qr-pane { display: grid; gap: 8px; justify-items: center; align-content: start; }
.qr-box { width: 220px; height: 220px; border-radius: 12px; background: #fff; border: 1px solid var(--app-border, #e0e4ea);
  display: flex; align-items: center; justify-content: center; overflow: hidden; }
.qr-svg { width: 100%; height: 100%; }
.qr-fallback { display: grid; justify-items: center; gap: 6px; color: var(--app-text-secondary, rgba(0,0,0,.45)); font-size: 12px; padding: 12px; text-align: center; }
.qr-fallback-error { color: #d03050; }
.qr-title { font-size: 15px; font-weight: 600; }
.qr-sub { font-size: 12px; color: var(--app-text-secondary, rgba(0,0,0,.45)); }
.login-side { display: grid; gap: 12px; align-content: start; min-width: 0; }
.stepper { display: flex; gap: 4px; flex-wrap: wrap; }
.step { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--app-text-secondary, rgba(0,0,0,.45)); padding: 4px 8px; border-radius: 8px; }
.step-dot { width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid currentColor; display: inline-flex;
  align-items: center; justify-content: center; font-size: 11px; }
.step.active { color: var(--app-accent, #2080f0); border: 1px dashed color-mix(in srgb, var(--app-accent, #2080f0) 45%, transparent); }
.step.done { color: #18a058; }
.step.done .step-dot { background: #18a058; border-color: #18a058; color: #fff; }
.step.error { color: #d03050; }
.step.error .step-dot { background: #d03050; border-color: #d03050; color: #fff; }
.mini-title { font-size: 12px; font-weight: 600; color: var(--app-text-secondary, rgba(0,0,0,.6)); }
.cookie-panel { display: grid; gap: 8px; padding: 12px; border: 1px dashed var(--app-border, #e0e4ea); border-radius: 10px; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { padding: 4px 12px; border-radius: 999px; font-size: 12px; border: 1px solid var(--app-border, #e0e4ea); }
.chip.on { background: var(--app-accent, #2080f0); border-color: var(--app-accent, #2080f0); color: #fff; }
.pl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
.pl-card { display: grid; gap: 6px; text-align: left; padding: 10px; border: 1px solid var(--app-border, #e0e4ea);
  border-radius: 10px; background: var(--app-bg, transparent); color: inherit; cursor: pointer; }
.pl-card:hover { border-color: var(--app-accent, #2080f0); }
.pl-cover { aspect-ratio: 1; border-radius: 8px; overflow: hidden; background: color-mix(in srgb, var(--app-accent, #2080f0) 10%, transparent); }
.pl-cover img { width: 100%; height: 100%; object-fit: cover; }
.pl-name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-meta { font-size: 11px; color: var(--app-text-secondary, rgba(0,0,0,.45)); }
.task-list { display: grid; gap: 8px; max-height: 480px; overflow: auto; }
.task-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--app-border, #e0e4ea); border-radius: 10px; }
.task-tile { width: 36px; height: 36px; flex: none; display: flex; align-items: center; justify-content: center; border-radius: 9px; }
.tile-primary { background: var(--app-accent, #2080f0); color: #fff; }
.tile-info { background: color-mix(in srgb, var(--app-accent, #2080f0) 14%, transparent); color: var(--app-accent, #2080f0); }
.tile-success { background: color-mix(in srgb, #18a058 14%, transparent); color: #18a058; }
.tile-error { background: color-mix(in srgb, #d03050 14%, transparent); color: #d03050; }
.tile-muted { background: color-mix(in srgb, var(--app-text-secondary, #8a919c) 14%, transparent); color: var(--app-text-secondary, #8a919c); }
.task-main { flex: 1; min-width: 0; }
.task-title { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-sub { font-size: 11px; color: var(--app-text-secondary, rgba(0,0,0,.45)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-progress { width: 90px; flex: none; }
.indet { height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--app-accent, #2080f0) 25%, transparent); position: relative; overflow: hidden; }
.indet::after { content: ''; position: absolute; inset: 0; width: 40%; background: var(--app-accent, #2080f0);
  animation: m3-slide 1.2s ease-in-out infinite; }
@keyframes m3-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }
.bar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 10px; font-size: 13px; }
.bar-warning { background: color-mix(in srgb, #f0a020 12%, transparent); border: 1px solid color-mix(in srgb, #f0a020 45%, transparent); }
.bar p { margin: 0; }
.empty { display: grid; justify-items: center; gap: 8px; padding: 24px; color: var(--app-text-secondary, rgba(0,0,0,.45)); font-size: 13px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
.field { display: grid; gap: 5px; align-content: start; }
.field .label { font-size: 12px; font-weight: 600; }
.switch-row { display: flex; }
.switch { position: relative; width: 38px; height: 21px; display: inline-block; }
.switch input { opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; position: absolute; z-index: 1; }
.switch .track { position: absolute; inset: 0; border-radius: 999px; background: var(--app-border, #c8cdd6); transition: background-color .15s; }
.switch .track::after { content: ''; position: absolute; top: 2px; left: 2px; width: 17px; height: 17px; border-radius: 50%;
  background: #fff; transition: transform .15s; }
.switch input:checked + .track { background: var(--app-accent, #2080f0); }
.switch input:checked + .track::after { transform: translateX(17px); }
.divider { border-top: 1px solid var(--app-border, #e0e4ea); }
.log-list { display: grid; gap: 4px; max-height: 260px; overflow: auto; }
.log-row { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
.log-time { font-variant-numeric: tabular-nums; color: var(--app-text-secondary, rgba(0,0,0,.45)); flex: none; }
.log-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; align-self: center; }
.dot-muted { color: var(--app-border, #c8cdd6); }
.dot-warning { color: #f0a020; }
.dot-error { color: #d03050; }
.log-msg { min-width: 0; overflow-wrap: anywhere; }
.adopt-row { padding: 8px 10px; border: 1px dashed var(--app-border, #e0e4ea); border-radius: 10px; }
.m-toasts { position: fixed; right: 18px; bottom: 18px; display: grid; gap: 8px; z-index: 50; max-width: min(420px, 80vw); }
.toast { padding: 10px 14px; border-radius: 10px; font-size: 13px; color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,.18);
  animation: m3-in .18s ease-out; }
.toast-success { background: #18a058; }
.toast-error { background: #d03050; }
.toast-warning { background: #f0a020; }
.toast-info { background: var(--app-accent, #2080f0); }
@keyframes m3-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.m-foot { font-size: 11px; color: var(--app-text-secondary, rgba(0,0,0,.4)); text-align: center; padding: 4px 0 8px; }
`
