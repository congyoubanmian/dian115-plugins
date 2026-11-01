// 追剧管家 —— 插件页面（v3 ui/page.js，导出 mount(el, ctx)）。
//
// 对照 plugins/chase-rs/frontend/src/AppPage.vue + chase-state.ts，用原生 JS + DOM 重写：
// 页头（状态/日报胶囊 + 动作组）→ 8 块指标瓦片 → 对齐结果卡（筛选 pill 纯前端过滤）
// → 双栏（补订建议 + 追剧日历）→ 探测诊断折叠条 → 最近动作 → 页脚 + 设置抽屉。
//
// 数据通道（v3）：
// - 状态文档：GET /api/extensions/v3/{id}/storage/state（ctx.api）；
// - 用户设置：ctx.settings.get()/set()（清单默认值叠加已保存值）；
// - 四个前台动作：ctx.tasks.run(job, business_key, input) 提交到统一任务队列，
//   轮询 ctx.tasks.get(id) 直到终态，结果与旧 invokeAction 的返回同形。
// 只呈现真实状态：缺数据就说缺什么、下一步点哪里，不造任何假数据。

import { mergeFlat, normalizeFlat, FLAT_DEFAULTS } from '../lib/settings.js'

const POLL_INTERVAL_MS = 800
const POLL_TIMEOUT_MS = 150_000

export async function mount(root, ctx) {
  const doc = root.ownerDocument
  const disposed = { value: false }

  // ─────────────────────────── 骨架 ───────────────────────────

  const style = doc.createElement('style')
  style.textContent = CSS_TEXT
  root.append(style)

  const page = doc.createElement('main')
  page.className = 'chase3'
  root.append(page)

  const el = (tag, className, text) => {
    const node = doc.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = text
    return node
  }

  // 页头
  const header = el('header', 'c-header')
  const brand = el('div', 'c-brand')
  const brandIcon = el('span', 'c-brand-icon')
  brandIcon.innerHTML = TV_SVG
  const brandText = el('div', 'c-brand-text')
  brandText.append(el('h2', null, '追剧管家'), el('p', null, '每小时对齐订阅池 · Emby 覆盖 / TMDB 目标 · 只增不减'))
  brand.append(brandIcon, brandText)
  const actions = el('div', 'c-actions')
  const healthCapsule = el('span', 'capsule capsule-neutral', '状态未拉取')
  const dailyCapsule = el('span', 'capsule capsule-neutral', '日报 · —')
  const dryCapsule = el('span', 'capsule capsule-warning', 'dry-run · 只判定不写入')
  dryCapsule.hidden = true
  const btnRefresh = actionButton('刷新', 'secondary')
  const btnProbe = actionButton('探测诊断', 'secondary')
  const btnAlign = actionButton('立即对齐', 'primary')
  const btnSettings = el('button', 'c-icon-btn')
  btnSettings.type = 'button'
  btnSettings.setAttribute('aria-label', '设置')
  btnSettings.innerHTML = GEAR_SVG
  actions.append(healthCapsule, dailyCapsule, dryCapsule, btnRefresh, btnProbe, btnAlign, btnSettings)
  header.append(brand, actions)
  page.append(header)

  // 动作生命周期
  const progressLine = el('p', 'c-progress')
  progressLine.hidden = true
  const resultLine = el('div', 'c-result')
  resultLine.hidden = true
  page.append(progressLine, resultLine)

  // 状态不可用卡（其余区块的容器）
  const unavailable = el('section', 'card')
  unavailable.hidden = true
  const content = el('div', 'c-content')
  content.hidden = true
  page.append(unavailable, content)

  // 瓦片 ×8
  const tiles = el('section', 'c-tiles')
  const tileDefs = [
    ['订阅池', 'tv_intents'], ['已判定', 'matched'], ['补订', 'patched'], ['跳过', 'skipped'],
    ['失败', 'failed'], ['未收录', 'absent'], ['待探测', 'pending_probe'], ['本轮复用', 'reused'],
  ]
  const tileValues = {}
  for (const [label, key] of tileDefs) {
    const tile = el('div', 'tile')
    const value = el('div', 'tile-value', '0')
    const name = el('div', 'tile-label', label)
    tile.append(value, name)
    tiles.append(tile)
    tileValues[key] = { tile, value }
  }
  content.append(tiles)

  // 告警条
  const instanceAlert = el('div', 'alert alert-warning')
  const storageAlert = el('div', 'alert alert-error')
  const probeAlert = el('div', 'alert alert-warning')
  for (const node of [instanceAlert, storageAlert, probeAlert]) {
    node.hidden = true
    content.append(node)
  }

  // 对齐结果卡
  const alignCard = el('section', 'card')
  const alignHead = el('div', 'card-head')
  const alignHeadText = el('div')
  alignHeadText.append(el('h3', null, '对齐结果'))
  const alignSub = el('p', 'card-sub', '')
  alignHeadText.append(alignSub)
  const filterBox = el('div', 'c-pills')
  alignHead.append(alignHeadText, filterBox)
  const pendingAlert = el('div', 'alert alert-warning')
  pendingAlert.hidden = true
  const alignBody = el('div')
  alignCard.append(alignHead, pendingAlert, alignBody)
  content.append(alignCard)

  // 双栏：补订建议 + 追剧日历
  const duo = el('div', 'c-duo')
  const trimCard = el('section', 'card')
  const calCard = el('section', 'card')
  duo.append(trimCard, calCard)
  content.append(duo)

  // 探测诊断折叠条
  const probeCard = el('section', 'card')
  const probeToggle = el('button', 'c-probe-head')
  probeToggle.type = 'button'
  probeToggle.setAttribute('aria-expanded', 'false')
  const chevron = el('span', 'c-chevron', '▾')
  probeToggle.append(
    el('span', 'c-probe-title', '探测诊断'),
    el('span', 'c-probe-sub', '端点参数矩阵 · 形状指纹 · HTTP 状态 · 2KB 原文样本 —— 默认折叠，排障时展开'),
    chevron,
  )
  const probeBody = el('div', 'c-probe-body')
  probeBody.hidden = true
  probeCard.append(probeToggle, probeBody)
  content.append(probeCard)

  // 最近动作
  const logCard = el('section', 'card')
  content.append(logCard)

  // 页脚
  content.append(el('footer', 'c-foot', '状态文档来自插件存储（ctx.storage）· 页面宽度跟随宿主可用宽度，双栏在 900–1000px 回落单栏 · 表格在 ≤640px 退化为卡片'))

  // 设置抽屉
  const overlay = el('div', 'c-overlay')
  overlay.hidden = true
  const drawer = el('div', 'c-drawer')
  const drawerHead = el('div', 'c-drawer-head')
  drawerHead.append(el('h3', null, '追剧管家设置'))
  const drawerClose = el('button', 'c-icon-btn')
  drawerClose.type = 'button'
  drawerClose.setAttribute('aria-label', '关闭')
  drawerClose.textContent = '✕'
  drawerHead.append(drawerClose)
  const drawerBody = el('div', 'c-drawer-body')
  const drawerFoot = el('div', 'c-drawer-foot')
  const changedNote = el('div', 'alert alert-info c-changed')
  const drawerButtons = el('div', 'c-drawer-buttons')
  const btnCancel = el('button', 'btn')
  btnCancel.type = 'button'
  btnCancel.textContent = '取消'
  const btnSave = actionButton('保存', 'primary')
  drawerButtons.append(btnCancel, btnSave)
  drawerFoot.append(changedNote, drawerButtons)
  drawer.append(drawerHead, drawerBody, drawerFoot)
  overlay.append(drawer)
  page.append(overlay)

  // Toast
  const toastBox = el('div', 'c-toasts')
  toastBox.setAttribute('aria-live', 'polite')
  page.append(toastBox)

  // ─────────────────────────── 状态 ───────────────────────────

  let stateDoc = null
  let stateError = ''
  let settingsFlat = { ...FLAT_DEFAULTS }
  let busy = ''
  let filter = 'all'
  let probeOpen = false
  const formValues = {}

  function text(value, fallback = '—') {
    if (value === null || value === undefined || value === '') return fallback
    return String(value)
  }
  function num(value, fallback = 0) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }
  function list(value) {
    return Array.isArray(value) ? value : []
  }
  function formatAt(value) {
    const raw = text(value, '')
    if (!raw) return '—'
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(raw)
    return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}` : raw
  }
  function timeAt(value) {
    const formatted = formatAt(value)
    if (formatted === '—') return ''
    const parts = formatted.split(' ')
    return parts.length === 2 ? parts[1] : formatted
  }
  function timeLongAt(value) {
    const raw = text(value, '')
    const match = /T(\d{2}:\d{2}:\d{2})/.exec(raw)
    return match ? match[1] : formatAt(raw)
  }
  function localDateOf(offsetMinutes) {
    const shifted = new Date(Date.now() + offsetMinutes * 60_000)
    return shifted.toISOString().slice(0, 10)
  }

  function toast(kind, message) {
    const node = el('div', `toast toast-${kind}`, message)
    toastBox.append(node)
    setTimeout(() => node.remove(), 4200)
  }

  // ─────────────────────────── 数据加载 ───────────────────────────

  async function readState() {
    try {
      const value = await ctx.storage.get('state')
      stateError = ''
      return value && typeof value === 'object' ? value : null
    } catch (error) {
      // storage.get 的 404 = 全新安装（还没有状态文档），不是错误。
      const status = error?.status
      if (status === 404) {
        stateError = ''
        return null
      }
      stateError = String(error?.message || error)
      throw error
    }
  }

  async function loadData() {
    let next = null
    try {
      next = await readState()
    } catch {
      next = null
    }
    stateDoc = next
    try {
      settingsFlat = normalizeFlat((await ctx.settings.get()) ?? {})
    } catch {
      settingsFlat = { ...FLAT_DEFAULTS }
    }
    if (!disposed.value) render()
  }

  // ─────────────────────────── 动作 ───────────────────────────

  const BUSY_LABELS = {
    refresh: '正在刷新（重读订阅池 1 页 + 追剧日历）…',
    'align-now': '对齐中 · ≤1 页订阅池 · ≤5 次 PATCH · ≤3 次 Emby 探测 · 6 秒预算…',
    'probe-dump': '正在探测诊断（emby/instances + 未知端点的参数矩阵）…',
  }

  function setBusy(name) {
    busy = name
    resultLine.hidden = true
    if (busy) {
      progressLine.textContent = ''
      progressLine.append(el('span', 'c-spinner'), doc.createTextNode(BUSY_LABELS[busy] ?? '正在执行…'))
      progressLine.hidden = false
    } else {
      progressLine.hidden = true
    }
    for (const button of [btnRefresh, btnProbe, btnAlign, btnSettings]) button.disabled = Boolean(busy)
    render()
  }

  async function runAction(name) {
    if (busy) return
    setBusy(name)
    try {
      const run = await ctx.tasks.run(name, `${name}-${Date.now()}`, {})
      const finished = await pollRun(run)
      if (!disposed.value) {
        showActionResult(name, finished)
      }
    } catch (error) {
      const message = String(error?.message || error)
      if (!disposed.value) {
        if (name === 'align-now') showResultLine(false, message)
        toast('error', message)
      }
    } finally {
      if (!disposed.value) setBusy('')
      await loadData()
    }
  }

  async function pollRun(run) {
    const started = Date.now()
    let current = run
    while (current && (current.status === 'queued' || current.status === 'running')) {
      if (disposed.value || ctx.signal?.aborted) throw new Error('页面已关闭，任务转入后台继续')
      if (Date.now() - started > POLL_TIMEOUT_MS) {
        return { ...current, status: 'running', message: `任务仍在运行（${current.id}），可在宿主任务记录里查看` }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      current = await ctx.tasks.get(current.id)
    }
    return current
  }

  function showActionResult(name, run) {
    const result = run?.result && typeof run.result === 'object' ? run.result : {}
    if (run?.status === 'failed' || result.status === 'failed') {
      const message = String(result.message || run?.error || '操作失败')
      if (name === 'align-now') showResultLine(false, message)
      toast('error', message)
      return
    }
    if (run?.status === 'cancelled') {
      toast('warning', '任务已取消')
      return
    }
    if (name === 'align-now') {
      const absent = num(result.absent, 0)
      const note = result.budget_hit ? ' · 达时间预算提前结束' : ''
      const absentNote = absent > 0 ? ` · 未收录 ${absent} 条` : ''
      const doneText = `完成: 补订 ${num(result.patched, 0)} 条 · 跳过 ${num(result.skipped, 0)} 条 · 失败 ${num(result.failed, 0)} 条${absentNote}${note}`
      showResultLine(true, doneText)
      toast('success', `立即对齐${doneText}`)
    } else {
      toast('success', String(result.message || '操作完成'))
    }
  }

  function showResultLine(ok, message) {
    resultLine.textContent = ''
    resultLine.className = `c-result ${ok ? 'c-result-ok' : 'c-result-err'}`
    resultLine.append(el('span', null, ok ? '✓' : '⚠'), doc.createTextNode(message))
    resultLine.hidden = false
  }

  btnRefresh.addEventListener('click', () => runAction('refresh'))
  btnAlign.addEventListener('click', () => runAction('align-now'))
  btnProbe.addEventListener('click', () => {
    probeOpen = true
    runAction('probe-dump')
  })
  probeToggle.addEventListener('click', () => {
    probeOpen = !probeOpen
    renderProbe()
  })
  btnSettings.addEventListener('click', () => {
    syncForm()
    overlay.hidden = false
  })
  drawerClose.addEventListener('click', () => { overlay.hidden = true })
  btnCancel.addEventListener('click', () => { overlay.hidden = true })
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.hidden = true
  })

  // ─────────────────────────── 渲染 ───────────────────────────

  function reasonBadge(item) {
    const reason = text(item.reason, '')
    const action = text(item.action, '')
    if (action === 'patched') return { kind: 'patched', label: '已补订' }
    if (action === 'dry-run') return { kind: 'patched', label: '待补订(dry-run)' }
    // 「Emby 未收录」不看动作词：整点 job 记 failed、立即对齐记 skipped，同事实同徽章。
    if (reason.includes('Emby 未收录')) return { kind: 'absent', label: 'Emby 无此剧' }
    if (action === 'failed') return { kind: 'failed', label: '失败' }
    if (reason.includes('Emby 该季 0 集')) return { kind: 'empty-season', label: '未收录/未入库' }
    if (reason.includes('覆盖未知')) return { kind: 'unknown-coverage', label: '覆盖未知' }
    // 覆盖已核实但目标未知不是无缺口：必须排在「无缺口」之前。
    if (reason.includes('目标未知')) return { kind: 'target-unknown', label: '目标未知' }
    if (reason.includes('无缺口')) return { kind: 'no-gap', label: '无缺口' }
    return { kind: 'other', label: alignActionLabel(action) || '跳过' }
  }

  function alignActionLabel(action) {
    switch (action) {
      case 'patched': return '已补订'
      case 'dry-run': return '待补订(dry-run)'
      case 'skipped': return '跳过'
      case 'failed': return '失败'
      default: return action === '' ? '' : text(action)
    }
  }

  function hasGap(item) {
    return num(item.emby_have_max, -1) >= 0 && num(item.gap_max, 0) > 0
  }

  function targetKnown(item) {
    return item.target_known ?? num(item.target_upper, 0) > 0
  }

  function seasonPad(season) {
    const value = num(season, 0)
    return value > 0 ? `S${String(value).padStart(2, '0')}` : '整剧'
  }

  function coverageSub(item) {
    const have = num(item.emby_have_max, -1)
    return have >= 0 ? `Emby 至 E${String(have).padStart(2, '0')}` : 'Emby 未探测'
  }

  function gapCell(item) {
    if (hasGap(item)) return { label: `+${num(item.gap_max, 0)}`, cls: 'gap-num' }
    const reason = text(item.reason, '')
    if (reason.includes('下轮优先') || reason.includes('预算用尽')) return { label: '待探测', cls: 'gap-probe' }
    if (num(item.emby_have_max, -1) >= 0) return { label: '0', cls: 'muted' }
    return { label: '—', cls: 'muted' }
  }

  function actionCell(item, kind) {
    switch (item.action) {
      case 'patched': return { label: `补订至 ${num(item.to_total, 0)}`, cls: 'action-link' }
      case 'dry-run': return { label: `待补订至 ${num(item.to_total, 0)}`, cls: 'action-dry' }
      case 'failed':
        return kind === 'failed' ? { label: '重试', cls: 'action-link' } : { label: '—', cls: 'muted' }
      default: return { label: '—', cls: 'muted' }
    }
  }

  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

  function weekdayOf(date) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    if (!match) return ''
    const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
    return WEEKDAYS[day] ?? ''
  }

  function episodeCompact(season, episode) {
    const ep = num(episode, 0)
    if (ep <= 0) return ''
    const s = num(season, 0)
    return s > 1 ? `S${s} E${ep}` : `E${ep}`
  }

  function probeFailed(status) {
    return status === 'unparsed' || status === 'http_error'
  }

  function render() {
    if (!stateDoc) {
      unavailable.hidden = false
      content.hidden = true
      renderUnavailable()
      renderHeader()
      return
    }
    unavailable.hidden = true
    content.hidden = false
    renderHeader()
    renderTiles()
    renderAlerts()
    renderAlignCard()
    renderTrimCard()
    renderCalendarCard()
    renderProbe()
    renderLogCard()
  }

  function renderUnavailable() {
    unavailable.textContent = ''
    const box = el('div', 'alert alert-error')
    box.append(el('strong', null, '状态不可用'))
    box.append(el('p', null, `宿主还没有返回本插件的状态文档${stateError ? `（${stateError}）` : ''}。常见原因：插件刚安装还没有跑过整点任务（存储键尚不存在时这里是空的），或插件存储暂不可读。`))
    unavailable.append(box)
    const next = el('p', 'next-line', '下一步：点「立即对齐」或「刷新」先跑一轮；仍然失败就把宿主机上插件的运行日志贴给作者。')
    unavailable.append(next)
    const row = el('div', 'c-inline-actions')
    const reload = el('button', 'btn btn-primary')
    reload.type = 'button'
    reload.textContent = '重新读取状态'
    reload.addEventListener('click', () => loadData())
    row.append(reload)
    unavailable.append(row)
  }

  function renderHeader() {
    const settings = stateDoc?.settings ?? {}
    const enabled = settings.enabled !== false
    const dryRun = settings.dry_run === true
    dryCapsule.hidden = !dryRun
    if (!stateDoc) {
      healthCapsule.className = 'capsule capsule-neutral'
      healthCapsule.textContent = '状态未拉取'
      dailyCapsule.className = 'capsule capsule-neutral'
      dailyCapsule.textContent = '日报 · —'
      return
    }
    const suffix = timeAt(stateDoc.align?.last_run_at) || timeAt(stateDoc.last_run)
    const withTime = suffix ? ` · ${suffix}` : ''
    if (text(stateDoc.status, '') === 'failed') {
      healthCapsule.className = 'capsule capsule-error'
      healthCapsule.textContent = `运行异常${withTime}`
    } else {
      healthCapsule.className = enabled ? 'capsule capsule-success' : 'capsule capsule-neutral'
      healthCapsule.textContent = enabled ? `运行正常${withTime}` : `已停用`
    }

    const report = settings.report ?? {}
    const daily = stateDoc.daily ?? {}
    const today = localDateOf(num(report.tz_offset_minutes, 480))
    if (report.enabled !== true) {
      dailyCapsule.className = 'capsule capsule-neutral'
      dailyCapsule.textContent = '日报 · 已关闭'
      dailyCapsule.title = '设置里未开启 TG 日报'
    } else if (text(daily.last_sent_date, '') === today) {
      dailyCapsule.className = 'capsule capsule-success'
      dailyCapsule.textContent = `日报 · 今日已发`
      dailyCapsule.title = `${today} · 累计 ${num(daily.sent_total, 0)} 次`
    } else {
      dailyCapsule.className = 'capsule capsule-warning'
      dailyCapsule.textContent = '日报 · 今日待发'
      dailyCapsule.title = `本地 ${num(report.hour, 9)}:00 之后的首次运行发送`
    }
  }

  function renderTiles() {
    const align = stateDoc.align ?? {}
    const stats = stateDoc.stats ?? {}
    const items = list(align.items)
    // 「本轮复用」：状态汇总没有 reused 字段，数 reason 含「复用」的行（规范 §4.2 的回退口径）。
    const reused = items.filter((item) => text(item.reason, '').includes('复用')).length
    const values = {
      tv_intents: num(stats.tv_intents, 0),
      matched: num(stats.matched, 0),
      patched: num(align.patched, 0),
      skipped: num(align.skipped, 0),
      failed: num(align.failed, 0),
      absent: num(align.absent, 0),
      pending_probe: num(align.pending_probe, 0),
      reused,
    }
    const tones = {
      patched: 'primary', failed: values.failed > 0 ? 'error' : 'default',
      absent: values.absent > 0 ? 'warning' : 'default',
      pending_probe: values.pending_probe > 0 ? 'primary' : 'default', reused: 'success',
    }
    for (const [, key] of tileDefs) {
      const entry = tileValues[key]
      entry.value.textContent = String(values[key] ?? 0)
      entry.tile.className = `tile tile-${tones[key] ?? 'default'}`
    }
  }

  function renderAlerts() {
    const debug = stateDoc.debug ?? {}
    const settings = stateDoc.settings ?? {}
    const instances = list(stateDoc.emby_instances)
    // 实例
    if (instances.length === 0) {
      const proxy = num(settings.emby_proxy_id, -1)
      const target = proxy >= 1 ? `设置指向实例 #${proxy}，但` : ''
      instanceAlert.textContent = `${target}还没有读到 Emby 实例列表（最近一次解析未成功）。下一步：点「探测诊断」——它会调 emby/instances 并把结果存进状态文档，下拉框随即有值。`
      instanceAlert.hidden = false
    } else {
      instanceAlert.hidden = true
    }
    // 存储
    const haystack = [text(stateDoc.last_message, ''), ...list(stateDoc.logs).slice(-5).map((entry) => text(entry.message, ''))].join('\n')
    if (haystack.includes('存储不可用')) {
      storageAlert.textContent = '运行时报告「宿主存储不可用」：本轮只读、不落盘，设置改动不会保存。先确认宿主存储可用再操作。'
      storageAlert.hidden = false
    } else {
      storageAlert.hidden = true
    }
    // 探测
    const embyStatus = debug.emby_episodes?.status
    let problem = ''
    if (probeFailed(embyStatus)) {
      problem = `Emby 覆盖结构未识别（status=${text(embyStatus)}, http=${num(debug.emby_episodes?.http_status, 0)}）：该轮涉及 Emby 覆盖判定的条目零写入。点「探测诊断」重跑参数矩阵，展开诊断区看原文样本。`
    } else {
      const calendarStatus = debug.air_calendar?.status
      if (probeFailed(calendarStatus)) {
        problem = `追剧日历结构未识别（status=${text(calendarStatus)}）：日历与日报的「今日播出」段会缺内容，对齐不受影响。点「探测诊断」看原文样本。`
      } else {
        const tmdbStatus = debug.tmdb_target?.status
        if (tmdbStatus === 'http_error' || tmdbStatus === 'transport_error' || tmdbStatus === 'unparsed') {
          problem = `TMDB 该季集数取不到（status=${text(tmdbStatus)}, http=${num(debug.tmdb_target?.http_status, 0)}）：结果表里目标显示「未知」，补订按 Emby 缺口判定（不会拿订阅集数顶替）。点「探测诊断」看原文样本。`
        }
      }
    }
    probeAlert.textContent = problem
    probeAlert.hidden = problem === ''
  }

  const ABNORMAL_KINDS = new Set(['failed', 'absent', 'empty-season', 'unknown-coverage'])

  function renderAlignCard() {
    const align = stateDoc.align ?? {}
    const settings = stateDoc.settings ?? {}
    const items = list(align.items)
    filterBox.textContent = ''
    const rows = items.map((item) => {
      const badge = reasonBadge(item)
      return { item, badge }
    })
    const gapCount = rows.filter((row) => hasGap(row.item)).length
    const abnormalCount = rows.filter((row) => ABNORMAL_KINDS.has(row.badge.kind)).length
    const options = [
      ['all', '全部', rows.length],
      ['gap', '有缺口', gapCount],
      ['abnormal', '异常', abnormalCount],
    ]
    for (const [key, label, count] of options) {
      const pill = el('button', `pill${filter === key ? ' active' : ''}`, `${label} ${count}`)
      pill.type = 'button'
      pill.addEventListener('click', () => {
        filter = key
        renderAlignCard()
      })
      filterBox.append(pill)
    }
    filterBox.hidden = items.length === 0

    const time = timeAt(align.last_run_at)
    const runPart = time ? `${time} 运行` : '还没有运行记录'
    alignSub.textContent = `本轮 ${items.length} 个剧·季 · ${runPart} · 立即对齐 6 秒预算 · 单轮最多补订 ${num(settings.max_patch_per_run, 5)} 条`

    alignBody.textContent = ''
    if (num(align.pending_probe, 0) > 0) {
      pendingAlert.textContent = `有 ${num(align.pending_probe, 0)} 条这轮没探到（探测预算/时间用尽），下一轮会优先补探；不是"没有缺口"。`
      pendingAlert.hidden = false
    } else {
      pendingAlert.hidden = true
    }

    if (items.length === 0) {
      const empty = el('div', 'c-empty')
      empty.textContent = emptyReason(align, stateDoc.debug ?? {})
      const run = el('button', 'btn btn-primary')
      run.type = 'button'
      run.textContent = '立即对齐一次'
      run.disabled = Boolean(busy)
      run.addEventListener('click', () => runAction('align-now'))
      empty.append(run)
      alignBody.append(empty)
      return
    }

    const filtered = rows.filter((row) => {
      if (filter === 'gap') return hasGap(row.item)
      if (filter === 'abnormal') return ABNORMAL_KINDS.has(row.badge.kind)
      return true
    })
    if (filtered.length === 0) {
      alignBody.append(el('p', 'muted-line', '该筛选下没有条目。'))
      return
    }
    const wrap = el('div', 'c-table-wrap')
    const table = el('table', 'c-table')
    const thead = el('thead')
    const headRow = el('tr')
    for (const [label, cls] of [['剧集'], ['订阅', 'num'], ['Emby 已有', 'num'], ['TMDB 目标', 'num'], ['缺口', 'num'], ['动作', 'num'], ['原因']]) {
      const th = el('th', cls, label)
      headRow.append(th)
    }
    thead.append(headRow)
    const tbody = el('tbody')
    for (const row of filtered) {
      const item = row.item
      const tr = el('tr')
      const showTd = el('td')
      showTd.append(el('div', 'show-title', text(item.title, `intent #${num(item.intent_id, 0)}`)))
      showTd.append(el('div', 'show-sub', `${seasonPad(item.season)} · ${coverageSub(item)}`))
      tr.append(showTd)
      tr.append(el('td', 'num', String(num(item.total_known, 0))))
      const haveTd = el('td', 'num')
      if (num(item.emby_have_max, -1) >= 0) haveTd.textContent = String(num(item.emby_have_max, 0))
      else haveTd.append(el('span', 'muted', '—'))
      tr.append(haveTd)
      const targetTd = el('td', 'num')
      if (targetKnown(item)) targetTd.textContent = String(num(item.target_upper, 0))
      else targetTd.append(el('span', 'muted', '—'))
      tr.append(targetTd)
      const gap = gapCell(item)
      tr.append(el('td', `num ${gap.cls}`, gap.label))
      const action = actionCell(item, row.badge.kind)
      tr.append(el('td', `num ${action.cls}`, action.label))
      const reasonTd = el('td')
      const badges = el('div', 'c-badges')
      badges.append(el('span', `badge badge-${row.badge.kind}`, row.badge.label))
      const reasonText = text(item.reason, '')
      if (reasonText.includes('复用缓存')) badges.append(el('span', 'badge badge-third', '复用缓存'))
      if (!targetKnown(item) && row.badge.kind !== 'target-unknown') badges.append(el('span', 'badge badge-info', '目标未知'))
      reasonTd.append(badges)
      reasonTd.append(el('div', 'reason-text', reasonText || alignActionResultText(item)))
      tr.append(reasonTd)
      tbody.append(tr)
    }
    table.append(thead, tbody)
    wrap.append(table)
    alignBody.append(wrap)
  }

  function alignActionResultText(item) {
    const from = num(item.from_total, 0)
    const to = num(item.to_total, 0)
    switch (item.action) {
      case 'patched': return `已补订 ${from} → ${to}`
      case 'dry-run': return `待补订 ${from} → ${to}（dry-run, 未写入）`
      case 'skipped': return `跳过: ${text(item.reason, '未给原因')}`
      case 'failed': return `失败: ${text(item.reason, '未给原因')}`
      default: return text(item.reason, '—')
    }
  }

  function emptyReason(align, debug) {
    if (align.last_run_at) {
      if (probeFailed(debug.emby_episodes?.status)) {
        return `Emby 覆盖结构未识别（${text(debug.emby_episodes?.status)}），该轮零写入。点「探测诊断」看参数矩阵与原文样本。`
      }
      if (align.last_error) return align.last_error
      return '这一轮没有需要判定或补订的条目（订阅池可能为空，或没有可用的 Emby 实例）。'
    }
    return '还没有跑过对齐。点「立即对齐」先看一轮结果，或等下一个整点的后台任务。'
  }

  function renderTrimCard() {
    trimCard.textContent = ''
    const head = el('div', 'card-head')
    head.append(el('h3', null, '补订建议'))
    head.append(el('span', 'capsule capsule-warning', '只读 · 从不自动执行'))
    trimCard.append(head)
    const trims = list(stateDoc.trim_suggestions)
    if (trims.length === 0) {
      trimCard.append(el('div', 'c-empty', '没有需要提醒的条目: 订阅集数都不超过该季 TMDB 的集数。'))
      return
    }
    const ul = el('ul', 'c-trim-list')
    for (const trim of trims) {
      const li = el('li')
      const main = el('div', 'trim-main')
      main.append(el('div', 'show-title', `${text(trim.title, `intent #${num(trim.intent_id, 0)}`)} ${seasonPad(trim.season)}`))
      const sub = el('div', 'show-sub', `订阅 ${num(trim.total_known, 0)} 集${num(trim.target_upper, 0) > 0 ? ', 高于 TMDB 官方目标' : ''}`)
      main.append(sub)
      main.append(el('div', 'reason-text', text(trim.reason, '')))
      main.append(el('div', 'trim-ids', `intent_id ${num(trim.intent_id, 0)} · tmdb_id ${num(trim.tmdb_id, 0)} · ${seasonPad(trim.season)}`))
      li.append(main)
      li.append(el('div', 'trim-delta', `${num(trim.total_known, 0)} → ${num(trim.target_upper, 0)}`))
      ul.append(li)
    }
    trimCard.append(ul)
    trimCard.append(el('p', 'card-foot', `共 ${trims.length} 条建议 · 仅提示, 需拿 intent_id 到订阅池手动调整`))
  }

  function renderCalendarCard() {
    calCard.textContent = ''
    const debug = stateDoc.debug ?? {}
    const head = el('div', 'card-head')
    head.append(el('h3', null, '追剧日历'))
    const days = list(stateDoc.calendar?.days)
    head.append(el('span', 'card-head-meta', `抓取于 ${formatAt(stateDoc.calendar?.fetched_at)} · 窗口 ${days.length} 天`))
    calCard.append(head)

    let mode
    if (days.length > 0) mode = 'days'
    else if (probeFailed(debug.air_calendar?.status)) mode = 'unrecognized'
    else if (!debug.air_calendar?.status || debug.air_calendar?.status === 'never') mode = 'never'
    else mode = 'empty'

    if (mode === 'unrecognized') {
      calCard.append(el('div', 'alert alert-warning', '日历结构未识别, 见诊断 —— air-calendar 的字段指纹不在已知形状里, 日报会缺「今日播出」段; 对齐不受影响。点「探测诊断」看参数矩阵与原文样本。'))
      return
    }
    if (mode === 'never') {
      const empty = el('div', 'c-empty', '还没有抓过追剧日历: 点「刷新」拉一次, 或等下一个整点的对齐任务。')
      const run = el('button', 'btn')
      run.type = 'button'
      run.textContent = '刷新一次'
      run.disabled = Boolean(busy)
      run.addEventListener('click', () => runAction('refresh'))
      empty.append(run)
      calCard.append(empty)
      return
    }
    if (mode === 'empty') {
      calCard.append(el('div', 'c-empty', '窗口里没有播出安排(订阅池里可能没有在播剧集)。'))
      return
    }

    const today = localDateOf(num(stateDoc.settings?.report?.tz_offset_minutes, 480))
    const chips = el('div', 'c-day-chips')
    for (const day of days.slice(0, 7)) {
      const date = text(day.date, '')
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
      const chip = el('div', `day-chip${date === today ? ' today' : ''}`)
      chip.append(el('span', 'day-chip-label', date === today ? '今天' : weekdayOf(date)))
      chip.append(el('span', 'day-chip-date', match ? `${Number(match[2])}/${Number(match[3])}` : date))
      chips.append(chip)
    }
    calCard.append(chips)

    const entries = []
    for (const day of days) {
      const date = text(day.date, '')
      const isToday = date === today
      const dayLabel = isToday ? '今天' : weekdayOf(date) || date
      list(day.items).forEach((entry, index) => {
        entries.push({
          key: `${date}-${index}`,
          dayLabel,
          isToday,
          title: text(entry.title, `tmdb ${num(entry.tmdb_id, 0)}`),
          episode: episodeCompact(entry.season, entry.episode),
          time: text(entry.time, '时间待定'),
        })
      })
    }
    if (entries.length === 0) {
      calCard.append(el('p', 'muted-line', '窗口里的这些天都没有播出安排。'))
    } else {
      const ul = el('ul', 'c-air-list')
      for (const entry of entries.slice(0, 8)) {
        const li = el('li')
        li.append(el('span', `air-dot${entry.isToday ? ' today' : ''}`))
        li.append(el('span', 'air-title', `${entry.dayLabel} · ${entry.title}${entry.episode ? ` ${entry.episode}` : ''}`))
        li.append(el('span', 'air-time', entry.time))
        ul.append(li)
      }
      calCard.append(ul)
    }
    if (entries.length > 8) {
      calCard.append(el('p', 'card-foot', `另有 ${entries.length - 8} 条播出安排未列出 · 窗口 ${days.length} 天`))
    }
  }

  function renderProbe() {
    probeToggle.setAttribute('aria-expanded', String(probeOpen))
    chevron.className = probeOpen ? 'c-chevron open' : 'c-chevron'
    probeBody.hidden = !probeOpen
    if (!probeOpen) return
    probeBody.textContent = ''
    const debug = stateDoc.debug ?? {}
    const probes = [
      ['emby/instances', debug.emby_instances, 'Emby 实例列表现场；「200 但解析为空」时看原文分辨是字段没认出还是宿主没配实例。'],
      ['emby/episodes', debug.emby_episodes, 'Emby 已有集数的解析现场；结构未识别时该轮零写入(不猜集号)。'],
      ['subscribe/air-calendar', debug.air_calendar, '追剧日历的解析现场；失败只影响日历与日报的「今日播出」段。'],
      ['subscribe/pool/intents', debug.pool_intents, '订阅池列表的解析现场(对规格的显式扩展槽: 订阅池解析失败时原文无处安放, 所以与上面两个同形)。'],
      ['tmdb/tv (该季集数)', debug.tmdb_target, '该季 TMDB 集数的取数现场(带 raw_episode_counts=true); 取不到时对齐判定只靠 Emby 缺口, 结果表会显示「未知」。'],
    ]
    const grid = el('div', 'c-probe-grid')
    for (const [name, snapshot, hint] of probes) {
      grid.append(probePanel(name, snapshot ?? {}, hint))
    }
    probeBody.append(grid)
    probeBody.append(el('h4', null, 'last_errors'))
    const errors = list(debug.last_errors).slice(-10).reverse()
    if (errors.length === 0) probeBody.append(el('p', 'muted-line', '没有错误记录。'))
    else {
      const ul = el('ul', 'c-diag-list')
      for (const error of errors) {
        const li = el('li')
        li.append(el('span', 'muted', formatAt(error.at)))
        li.append(el('span', 'mono', ` [${text(error.step)}] `))
        li.append(doc.createTextNode(text(error.message)))
        ul.append(li)
      }
      probeBody.append(ul)
    }
    probeBody.append(el('h4', null, 'host.call 尝试'))
    const attempts = list(debug.attempts).slice(-20).reverse()
    if (attempts.length === 0) probeBody.append(el('p', 'muted-line', '还没有调用记录。'))
    else {
      const ul = el('ul', 'c-diag-list')
      for (const attempt of attempts) {
        const li = el('li')
        li.append(el('span', 'muted', formatAt(attempt.at)))
        li.append(el('span', 'mono', ` ${text(attempt.endpoint)} ${text(attempt.params)} `))
        li.append(el('span', 'muted', `→ http ${num(attempt.http_status, 0)} · ${text(attempt.shape)}`))
        ul.append(li)
      }
      probeBody.append(ul)
    }
    const diagBlock = el('div')
    const diagHead = el('div', 'c-diag-head')
    diagHead.append(el('span', 'muted', '完整诊断文本（整段复制给作者），内容与上面一致并附带最近日志。'))
    const copyBtn = el('button', 'btn')
    copyBtn.type = 'button'
    copyBtn.textContent = '复制'
    copyBtn.addEventListener('click', () => copyDiagnostics(copyBtn))
    diagHead.append(copyBtn)
    diagBlock.append(diagHead)
    const textarea = doc.createElement('textarea')
    textarea.className = 'c-diag-text'
    textarea.readOnly = true
    textarea.rows = 10
    textarea.value = diagnosticsText()
    diagBlock.append(textarea)
    probeBody.append(diagBlock)
  }

  function probePanel(name, probe, hint) {
    const box = el('div', 'c-probe-panel')
    const head = el('div', 'c-probe-panel-head')
    const statusMap = {
      ok: ['已识别', 'badge-success'],
      unparsed: ['结构未识别', 'badge-warning'],
      http_error: ['HTTP 错误', 'badge-error'],
      skipped: ['本轮跳过', 'badge-neutral'],
      never: ['从未探测', 'badge-neutral'],
    }
    const status = text(probe.status, 'never')
    const [label, cls] = statusMap[status] ?? [status, 'badge-neutral']
    head.append(el('h5', null, name))
    head.append(el('span', `badge ${cls}`, label))
    box.append(head)
    box.append(el('div', 'muted-line', `http_status: ${num(probe.http_status, 0)} · at: ${formatAt(probe.at)}`))
    box.append(el('div', 'mono c-probe-shape', `shape: ${text(probe.shape, '(未识别)')}`))
    box.append(el('div', 'muted-line', `params_tried: ${list(probe.params_tried).join(' | ') || '(无)'}`))
    box.append(el('div', 'c-probe-hint', hint))
    const pre = doc.createElement('pre')
    pre.className = 'c-probe-sample'
    pre.textContent = text(probe.sample, '(空)')
    box.append(pre)
    return box
  }

  function diagnosticsText() {
    const debug = stateDoc.debug ?? {}
    const lines = []
    lines.push(`# 追剧管家诊断 生成于 ${new Date().toISOString()}`)
    lines.push(`# 状态: ${text(stateDoc.status, '—')} · revision ${num(stateDoc.revision, 0)} · schema ${num(stateDoc.schema_version, 0)}`)
    lines.push(`# 最近消息: ${text(stateDoc.last_message, '—')}`)
    lines.push(`# 探测更新于: ${formatAt(debug.updated_at)}`)
    for (const [name, snapshot] of [
      ['emby/episodes', debug.emby_episodes],
      ['subscribe/air-calendar', debug.air_calendar],
      ['subscribe/pool/intents', debug.pool_intents],
      ['tmdb/tv (该季集数)', debug.tmdb_target],
    ]) {
      const probe = snapshot ?? {}
      lines.push('')
      lines.push(`## ${name}`)
      lines.push(`status: ${text(probe.status, 'never')} · http_status: ${num(probe.http_status, 0)} · at: ${formatAt(probe.at)}`)
      lines.push(`shape: ${text(probe.shape, '(未识别)')}`)
      lines.push(`params_tried: ${list(probe.params_tried).join(' | ') || '(无)'}`)
      lines.push('sample(≤2KB):')
      lines.push(text(probe.sample, '(空)'))
    }
    lines.push('')
    lines.push('## 探测尝试')
    for (const attempt of list(debug.attempts).slice(-20).reverse()) {
      lines.push(`- ${formatAt(attempt.at)} ${text(attempt.endpoint)} ${text(attempt.params)} → ${num(attempt.http_status, 0)} ${text(attempt.shape)}`)
    }
    lines.push('')
    lines.push('## last_errors')
    for (const error of list(debug.last_errors).slice(-10).reverse()) {
      lines.push(`- ${formatAt(error.at)} [${text(error.step)}] ${text(error.message)}`)
    }
    lines.push('')
    lines.push('## 日志 (最近 50 条)')
    for (const entry of list(stateDoc.logs).slice(-50)) {
      lines.push(`- ${formatAt(entry.at)} [${text(entry.level)}] ${text(entry.message)}`)
    }
    return lines.join('\n')
  }

  async function copyDiagnostics(button) {
    const content = diagnosticsText()
    try {
      await navigator.clipboard.writeText(content)
      button.textContent = '已复制'
      toast('success', '诊断信息已复制')
      setTimeout(() => { button.textContent = '复制' }, 2000)
    } catch {
      toast('warning', '浏览器不允许复制, 请在文本域里手动选中')
    }
  }

  function renderLogCard() {
    logCard.textContent = ''
    const head = el('div', 'card-head')
    head.append(el('h3', null, '最近动作'))
    head.append(el('span', 'card-head-meta', `${ctx.id} · 状态文档 revision ${num(stateDoc.revision, 0)}`))
    logCard.append(head)
    const entries = list(stateDoc.logs).slice(-8).reverse()
    if (entries.length === 0) {
      logCard.append(el('p', 'muted-line', '还没有运行日志。'))
      return
    }
    const ul = el('ul', 'c-log-list')
    for (const entry of entries) {
      const li = el('li')
      li.append(el('span', 'log-time', timeLongAt(entry.at)))
      li.append(el('span', 'log-msg', text(entry.message, '')))
      ul.append(li)
    }
    logCard.append(ul)
  }

  // ─────────────────────────── 设置抽屉 ───────────────────────────

  const FORM_FIELDS = [
    ['enabled', '启用插件', 'boolean', '关掉后整点任务与「立即对齐」都不写入。'],
    ['auto_bump', '自动补订', 'boolean', '关掉后整点任务只判定不补订（立即对齐不受限）；缺字段的旧值按开着处理。'],
    ['emby_proxy_id', 'Emby 实例', 'instance', '-1 = 跟随宿主默认实例；0 = 旧版单实例（调用不带 proxy_id）。'],
    ['max_patch_per_run', '单轮最多补订（条）', 'number', '后端硬上限 20。'],
    ['max_raise_per_run', '单条最大抬升（集）', 'number', '超出视为元数据异常，跳过。'],
    ['dry_run', '只判定不写入', 'boolean', 'dry-run: 结果表会标「待补订」。'],
    ['write_episode_strings', '写回集数字符串', 'boolean', '仅在原串能严格解析且逐字节往返一致时才追加。'],
    ['report_enabled', '发送每日报告', 'boolean', ''],
    ['report_hour', '发送小时（本地）', 'number', '到点后当天首次运行发送, 每天最多一条。'],
    ['report_tz_offset_minutes', '时区偏移（分钟）', 'number', '+08:00 = 480。'],
    ['catch_up_days', '日历窗口（天）', 'number', ''],
    ['emby_probe_budget', 'Emby 探测预算（次/轮）', 'number', 'Emby 覆盖与 TMDB 目标共用这份预算（整点任务）。'],
  ]
  const formInputs = {}
  let baseline = {}

  const instanceSelect = doc.createElement('select')
  for (const [key, label, kind, help] of FORM_FIELDS) {
    const row = el('label', 'c-form-row')
    row.append(el('span', 'c-form-label', label))
    let input
    if (kind === 'boolean') {
      input = doc.createElement('input')
      input.type = 'checkbox'
    } else if (kind === 'number') {
      input = doc.createElement('input')
      input.type = 'number'
    } else if (kind === 'instance') {
      input = instanceSelect
    }
    input.id = `chase3-setting-${key}`
    formInputs[key] = input
    row.append(input)
    if (help) row.append(el('span', 'c-form-help', help))
    drawerBody.append(row)
  }

  function instanceOptions() {
    const options = [
      { label: '跟随宿主默认实例 (-1)', value: -1 },
      { label: '旧版单实例: 调用时不带 proxy_id (0)', value: 0 },
    ]
    for (const instance of list(stateDoc?.emby_instances)) {
      const id = num(instance.id, 0)
      const parts = [`${text(instance.name, `实例 #${id}`)} #${id}`]
      if (instance.is_default === true) parts.push('宿主默认')
      if (instance.key_ready === false) parts.push('未配置密钥')
      options.push({ label: parts.join(' · '), value: id, disabled: instance.key_ready === false })
    }
    return options
  }

  function syncForm() {
    instanceSelect.textContent = ''
    for (const option of instanceOptions()) {
      const node = doc.createElement('option')
      node.value = String(option.value)
      node.textContent = option.label
      node.disabled = option.disabled === true
      instanceSelect.append(node)
    }
    const merged = { ...FLAT_DEFAULTS, ...normalizeFlat(settingsFlat) }
    for (const [key] of FORM_FIELDS) {
      const input = formInputs[key]
      if (input.type === 'checkbox') input.checked = merged[key] === true
      else input.value = String(merged[key] ?? '')
    }
    baseline = readForm()
    renderChangedNote()
  }

  function readForm() {
    const values = {}
    for (const [key] of FORM_FIELDS) {
      const input = formInputs[key]
      values[key] = input.type === 'checkbox' ? input.checked : Number(input.value)
    }
    return values
  }

  function buildPayload() {
    const current = readForm()
    const payload = {}
    for (const key of Object.keys(current)) {
      if (current[key] !== baseline[key]) payload[key] = current[key]
    }
    return payload
  }

  function renderChangedNote() {
    const keys = Object.keys(buildPayload())
    changedNote.textContent = keys.length > 0
      ? `将提交改动: ${keys.join(', ')}`
      : '没有改动: 保存只提交被改动的键, 其余保持原值。'
    btnSave.disabled = keys.length === 0
  }
  drawerBody.addEventListener('input', renderChangedNote)
  drawerBody.addEventListener('change', renderChangedNote)

  btnSave.addEventListener('click', async () => {
    const payload = buildPayload()
    if (Object.keys(payload).length === 0) {
      toast('info', '没有改动')
      return
    }
    btnSave.disabled = true
    try {
      // 白名单逐键合并（绝不整块替换：表单之外有未知键时也要保留）。
      const { flat } = mergeFlat(settingsFlat, payload)
      await ctx.settings.set(flat)
      settingsFlat = flat
      overlay.hidden = true
      toast('success', `已更新设置: ${Object.keys(payload).join(', ')}`)
      await loadData()
    } catch (error) {
      toast('error', String(error?.message || error))
    } finally {
      btnSave.disabled = false
      renderChangedNote()
    }
  })

  // ─────────────────────────── 启动与清理 ───────────────────────────

  const onAbort = () => { disposed.value = true }
  ctx.signal?.addEventListener?.('abort', onAbort)

  await loadData()

  return () => {
    disposed.value = true
    ctx.signal?.removeEventListener?.('abort', onAbort)
    page.remove()
    style.remove()
  }
}

function actionButton(label, kind) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `btn btn-${kind}`
  button.textContent = label
  return button
}

const TV_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>'
const GEAR_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'

const CSS_TEXT = `
.chase3 { display:grid; gap:16px; padding:4px; width:100%; max-width:100%; min-width:0; color:var(--app-text, inherit); font-size:14px; }
.chase3 h2 { margin:0; font-size:20px; font-weight:600; }
.chase3 h3 { margin:0; font-size:16px; font-weight:600; }
.chase3 h4 { margin:14px 0 6px; font-size:13px; color:var(--app-text-secondary, inherit); }
.chase3 h5 { margin:0; font-size:13px; font-weight:600; }
.c-header { display:flex; align-items:center; justify-content:space-between; gap:12px 16px; flex-wrap:wrap; }
.c-brand { display:flex; align-items:center; gap:12px; min-width:0; }
.c-brand-icon { width:44px; height:44px; border-radius:12px; display:grid; place-items:center; flex:none; color:var(--app-accent, #2080f0); background:color-mix(in srgb, var(--app-accent, #2080f0) 12%, transparent); }
.c-brand-text p { margin:2px 0 0; color:var(--app-text-secondary, inherit); font-size:13px; }
.c-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.capsule { display:inline-flex; align-items:center; gap:6px; border-radius:999px; padding:4px 12px; font-size:12px; font-weight:500; line-height:1.45; white-space:nowrap; font-variant-numeric:tabular-nums; }
.capsule-success { color:var(--c-success, #18a058); background:color-mix(in srgb, var(--c-success, #18a058) 14%, transparent); }
.capsule-warning { color:var(--c-warning, #f0a020); background:color-mix(in srgb, var(--c-warning, #f0a020) 16%, transparent); }
.capsule-error { color:var(--c-error, #d03050); background:color-mix(in srgb, var(--c-error, #d03050) 14%, transparent); }
.capsule-neutral { color:var(--app-text-secondary, inherit); background:color-mix(in srgb, var(--app-text-secondary, #8a919c) 14%, transparent); }
.btn { font:inherit; color:inherit; background:var(--app-surface, transparent); border:1px solid var(--app-border, currentColor); border-radius:8px; padding:7px 14px; min-height:36px; cursor:pointer; }
.btn:hover:not(:disabled) { border-color:var(--app-accent, currentColor); color:var(--app-accent, inherit); }
.btn:disabled { opacity:.55; cursor:not-allowed; }
.btn-primary { color:var(--app-bg, #fff); background:var(--app-accent, #2080f0); border-color:var(--app-accent, #2080f0); }
.btn-primary:hover:not(:disabled) { color:var(--app-bg, #fff); filter:brightness(1.08); }
.c-icon-btn { font:inherit; color:inherit; background:transparent; border:1px solid var(--app-border, currentColor); border-radius:50%; width:36px; height:36px; display:grid; place-items:center; cursor:pointer; }
.c-progress { margin:0; display:flex; align-items:center; gap:8px; color:var(--app-accent, #2080f0); font-size:13px; }
.c-spinner { width:14px; height:14px; flex:none; border-radius:50%; border:2px solid color-mix(in srgb, var(--app-accent, #2080f0) 25%, transparent); border-top-color:var(--app-accent, #2080f0); animation:chase3-spin .8s linear infinite; }
@keyframes chase3-spin { to { transform:rotate(360deg); } }
.c-result { display:flex; align-items:center; gap:8px; border-radius:12px; padding:10px 14px; font-size:13px; }
.c-result-ok { color:var(--c-success, #18a058); background:color-mix(in srgb, var(--c-success, #18a058) 12%, transparent); }
.c-result-err { color:var(--c-error, #d03050); background:color-mix(in srgb, var(--c-error, #d03050) 12%, transparent); }
.card { background:var(--app-surface, transparent); border:1px solid var(--app-border, currentColor); border-radius:12px; padding:16px; display:grid; gap:10px; }
.card-head { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
.card-sub { margin:2px 0 0; color:var(--app-text-secondary, inherit); font-size:12px; }
.card-foot { margin:0; color:var(--app-text-secondary, inherit); font-size:12px; }
.card-head-meta { color:var(--app-text-secondary, inherit); font-size:12px; }
.c-tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(110px, 1fr)); gap:10px; }
.tile { background:var(--app-surface, transparent); border:1px solid var(--app-border, currentColor); border-radius:12px; padding:12px; }
.tile-value { font-size:22px; font-weight:600; font-variant-numeric:tabular-nums; }
.tile-label { margin-top:2px; color:var(--app-text-secondary, inherit); font-size:12px; }
.tile-primary .tile-value { color:var(--app-accent, #2080f0); }
.tile-success .tile-value { color:var(--c-success, #18a058); }
.tile-warning .tile-value { color:var(--c-warning, #f0a020); }
.tile-error .tile-value { color:var(--c-error, #d03050); }
.alert { border-radius:10px; padding:10px 14px; font-size:13px; line-height:1.6; }
.alert-warning { color:var(--c-warning, #f0a020); background:color-mix(in srgb, var(--c-warning, #f0a020) 12%, transparent); }
.alert-error { color:var(--c-error, #d03050); background:color-mix(in srgb, var(--c-error, #d03050) 12%, transparent); }
.alert-info { color:var(--app-accent, #2080f0); background:color-mix(in srgb, var(--app-accent, #2080f0) 10%, transparent); }
.c-pills { display:flex; gap:6px; flex-wrap:wrap; }
.pill { font:inherit; font-size:12px; color:inherit; background:transparent; border:1px solid var(--app-border, currentColor); border-radius:999px; padding:4px 12px; cursor:pointer; }
.pill.active { color:var(--app-bg, #fff); background:var(--app-accent, #2080f0); border-color:var(--app-accent, #2080f0); }
.c-table-wrap { overflow-x:auto; }
.c-table { width:100%; border-collapse:collapse; font-size:13px; }
.c-table th, .c-table td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--app-border, currentColor); vertical-align:top; }
.c-table th.num, .c-table td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
.show-title { font-weight:500; }
.show-sub { margin-top:2px; color:var(--app-text-secondary, inherit); font-size:12px; }
.gap-num { color:var(--app-accent, #2080f0); font-weight:600; }
.gap-probe { color:var(--app-accent, #2080f0); }
.muted { color:var(--app-text-secondary, inherit); }
.muted-line { margin:0; color:var(--app-text-secondary, inherit); font-size:13px; }
.action-link { color:var(--app-accent, #2080f0); }
.action-dry { color:var(--c-warning, #f0a020); }
.c-badges { display:flex; gap:6px; flex-wrap:wrap; }
.badge { display:inline-flex; border-radius:999px; padding:2px 8px; font-size:11px; font-weight:500; white-space:nowrap; }
.badge-patched { color:var(--c-success, #18a058); background:color-mix(in srgb, var(--c-success, #18a058) 14%, transparent); }
.badge-failed { color:var(--c-error, #d03050); background:color-mix(in srgb, var(--c-error, #d03050) 14%, transparent); }
.badge-absent, .badge-empty-season, .badge-unknown-coverage { color:var(--c-warning, #f0a020); background:color-mix(in srgb, var(--c-warning, #f0a020) 14%, transparent); }
.badge-target-unknown { color:var(--app-accent, #2080f0); background:color-mix(in srgb, var(--app-accent, #2080f0) 12%, transparent); }
.badge-no-gap, .badge-neutral, .badge-other { color:var(--app-text-secondary, inherit); background:color-mix(in srgb, var(--app-text-secondary, #8a919c) 14%, transparent); }
.badge-info { color:var(--app-accent, #2080f0); background:color-mix(in srgb, var(--app-accent, #2080f0) 12%, transparent); }
.badge-third { color:#7c5cfc; background:color-mix(in srgb, #7c5cfc 14%, transparent); }
.reason-text { margin-top:4px; color:var(--app-text-secondary, inherit); font-size:12px; overflow-wrap:anywhere; }
.c-empty { display:grid; justify-items:start; gap:10px; color:var(--app-text-secondary, inherit); font-size:13px; }
.c-duo { display:grid; grid-template-columns:1fr 1fr; gap:16px; align-items:start; }
@media (max-width:1000px) { .c-duo { grid-template-columns:1fr; } }
.c-trim-list { list-style:none; margin:0; padding:0; display:grid; gap:12px; }
.c-trim-list li { display:flex; justify-content:space-between; gap:12px; border-bottom:1px dashed var(--app-border, currentColor); padding-bottom:12px; }
.trim-delta { font-variant-numeric:tabular-nums; white-space:nowrap; color:var(--c-warning, #f0a020); font-weight:500; }
.trim-ids { margin-top:2px; color:var(--app-text-secondary, inherit); font-size:11px; }
.c-day-chips { display:flex; gap:8px; flex-wrap:wrap; }
.day-chip { display:grid; justify-items:center; gap:2px; border:1px solid var(--app-border, currentColor); border-radius:10px; padding:6px 10px; font-size:12px; }
.day-chip.today { color:var(--app-accent, #2080f0); border-color:var(--app-accent, #2080f0); }
.day-chip-label { color:var(--app-text-secondary, inherit); font-size:11px; }
.day-chip.today .day-chip-label { color:inherit; }
.c-air-list { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
.c-air-list li { display:flex; align-items:center; gap:8px; }
.air-dot { width:8px; height:8px; border-radius:50%; background:var(--app-text-secondary, currentColor); flex:none; }
.air-dot.today { background:var(--app-accent, #2080f0); }
.air-title { flex:1; min-width:0; overflow-wrap:anywhere; }
.air-time { color:var(--app-text-secondary, inherit); font-variant-numeric:tabular-nums; }
.c-probe-head { display:flex; align-items:center; gap:10px; width:100%; background:transparent; border:none; color:inherit; font:inherit; cursor:pointer; padding:0; text-align:left; }
.c-probe-title { font-weight:600; }
.c-probe-sub { flex:1; color:var(--app-text-secondary, inherit); font-size:12px; }
.c-chevron { transition:transform .15s ease; }
.c-chevron.open { transform:rotate(180deg); }
.c-probe-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:12px; }
.c-probe-panel { border:1px solid var(--app-border, currentColor); border-radius:10px; padding:10px; display:grid; gap:6px; }
.c-probe-panel-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.c-probe-shape { font-size:12px; overflow-wrap:anywhere; }
.c-probe-hint { color:var(--app-text-secondary, inherit); font-size:11px; }
.c-probe-sample { margin:0; max-height:140px; overflow:auto; font-size:11px; white-space:pre-wrap; overflow-wrap:anywhere; background:var(--app-bg, transparent); border:1px solid var(--app-border, currentColor); border-radius:8px; padding:8px; }
.c-diag-list { list-style:none; margin:0; padding:0; display:grid; gap:4px; font-size:12px; }
.c-diag-list li { overflow-wrap:anywhere; }
.mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
.c-diag-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px; }
.c-diag-text { width:100%; box-sizing:border-box; font:12px ui-monospace, SFMono-Regular, Menlo, monospace; background:var(--app-bg, transparent); color:inherit; border:1px solid var(--app-border, currentColor); border-radius:8px; padding:8px; resize:vertical; }
.c-log-list { list-style:none; margin:0; padding:0; display:grid; gap:6px; font-size:13px; }
.log-time { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--app-text-secondary, inherit); margin-right:8px; }
.c-foot { color:var(--app-text-secondary, inherit); font-size:12px; }
.next-line { color:var(--app-text-secondary, inherit); font-size:13px; }
.c-inline-actions { display:flex; gap:8px; }
.c-overlay { position:fixed; inset:0; background:rgba(0,0,0,.4); display:grid; justify-items:end; z-index:60; }
.c-drawer { width:min(420px, 92vw); height:100%; background:var(--app-surface, #fff); color:var(--app-text, inherit); display:grid; grid-template-rows:auto 1fr auto; box-shadow:-8px 0 24px rgba(0,0,0,.15); }
.c-drawer-head { display:flex; align-items:center; justify-content:space-between; padding:16px; border-bottom:1px solid var(--app-border, currentColor); }
.c-drawer-body { padding:16px; overflow-y:auto; display:grid; gap:14px; align-content:start; }
.c-form-row { display:grid; gap:4px; }
.c-form-label { font-size:13px; font-weight:500; }
.c-form-row input[type="number"], .c-form-row select { font:inherit; color:inherit; background:var(--app-bg, transparent); border:1px solid var(--app-border, currentColor); border-radius:8px; padding:8px; min-height:38px; }
.c-form-row input[type="checkbox"] { width:18px; height:18px; }
.c-form-help { color:var(--app-text-secondary, inherit); font-size:11px; }
.c-drawer-foot { padding:16px; border-top:1px solid var(--app-border, currentColor); display:grid; gap:10px; }
.c-changed { font-size:12px; }
.c-drawer-buttons { display:flex; justify-content:flex-end; gap:8px; }
.c-toasts { position:fixed; top:16px; right:16px; display:grid; gap:8px; z-index:70; max-width:min(420px, 80vw); }
.toast { border-radius:10px; padding:10px 14px; font-size:13px; color:var(--app-bg, #fff); background:var(--app-text, #333); box-shadow:0 4px 16px rgba(0,0,0,.2); }
.toast-success { background:var(--c-success, #18a058); }
.toast-error { background:var(--c-error, #d03050); }
.toast-warning { background:var(--c-warning, #f0a020); }
.toast-info { background:var(--app-accent, #2080f0); }
`
