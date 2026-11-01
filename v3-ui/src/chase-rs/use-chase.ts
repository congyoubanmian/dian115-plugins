// 追剧管家 —— 页面状态层（Vue 3 组合式）。
//
// 数据通道只有 ctx（v3-kit/docs/ui-theme.md）：
// - 状态文档：ctx.storage.get('state')（插件 KV 的 `state` 键）；
// - 用户设置：ctx.settings.get() / ctx.settings.set()（与宿主「管理」页同一份数据）；
// - 前台动作：ctx.tasks.run(job, business_key, input) + ctx.tasks.get(id) 轮询。
//
// 逻辑逐条对应原生 JS 版页面（v3-ui/legacy/chase-rs/page.native.js），
// 只是把命令式重绘换成了 Vue 的响应式派生：一个字段都不猜，缺数据就说缺什么。
//
// 对外暴露的是 reactive 门面（字段都是普通值，模板里直接用 store.xxx）；
// 内部用 ref / computed 维护，卸载时统一清理定时器与监听。

import { computed, inject, markRaw, provide, reactive, ref } from 'vue'
import type { HostContext } from '../shared/types'
import type {
  ActionName,
  AlignItem,
  AlignRow,
  CalendarEntry,
  FlatSettings,
  StateDoc,
  Tile,
  ToastItem,
} from './types'
import {
  episodeCompact,
  formatAt,
  list,
  localDateOf,
  num,
  probeFailed,
  reasonBadge,
  text,
  timeAt,
  weekdayOf,
} from './format'

// 设置的默认值 / 归一 / 白名单合并都放在插件自己的 lib 里（页面与后台共用同一份语义），
// 这里直接引入，打包时会被内联进 ui/page.js（产物自包含，不依赖运行时的相对 import）。
// @ts-ignore —— lib/settings.js 是纯 JS 模块，没有类型声明。
import { FLAT_DEFAULTS, mergeFlat, normalizeFlat } from '../../../v3/chase-rs/lib/settings.js'

/** 任务轮询节奏（与原生版一致）。 */
const POLL_INTERVAL_MS = 800
const POLL_TIMEOUT_MS = 150_000

/** 动作进行中的提示文案。 */
export const BUSY_LABELS: Record<ActionName, string> = {
  refresh: '正在刷新（重读订阅池 1 页 + 追剧日历）…',
  'align-now': '对齐中 · ≤1 页订阅池 · ≤5 次 PATCH · ≤3 次 Emby 探测 · 6 秒预算…',
  'probe-dump': '正在探测诊断（emby/instances + 未知端点的参数矩阵）…',
}

/** 对齐结果卡的筛选。 */
export type AlignFilter = 'all' | 'gap' | 'abnormal'

/** 胶囊的配色语义（对应 naive-ui 的 n-tag type）。 */
export type CapsuleType = 'default' | 'success' | 'warning' | 'error' | 'info'

export interface Capsule {
  label: string
  type: CapsuleType
  title: string
}

/** 组件树里取 store 的注入键。 */
export const CHASE_KEY = 'chaseStore'

/** 探测诊断的一个面板。 */
export interface ProbePanel {
  name: string
  hint: string
  snapshot: NonNullable<NonNullable<StateDoc['debug']>['emby_episodes']>
}

/** 对外暴露的 store（字段都是普通值）。 */
export interface ChaseStore {
  ctx: HostContext
  /** 状态文档；null = 宿主还没给（全新安装或读不到）。 */
  state: StateDoc | null
  /** 首次读取状态文档尚未完成（加载中，不应当显示成错误）。 */
  loading: boolean
  /** 读状态文档的原始错误（404 不算错误）。 */
  stateError: string
  /** 扁平设置（ctx.settings）。 */
  settings: FlatSettings
  /** 当前进行中的动作名；空串 = 空闲。 */
  busy: ActionName | ''
  /** 最近一次动作结果行。 */
  result: { ok: boolean; text: string } | null
  /** 对齐结果卡的筛选。 */
  filter: AlignFilter
  /** 探测诊断折叠条是否展开。 */
  probeOpen: boolean
  /** 设置抽屉是否打开。 */
  drawerOpen: boolean
  /** 顶部浮出的提示。 */
  toasts: ToastItem[]

  /** 指标瓦片（8 块）。 */
  tiles: Tile[]
  /** 对齐结果行（原始条目 + 徽章）。 */
  alignRows: AlignRow[]
  /** 对齐结果卡的副标题。 */
  alignSub: string
  /** 本轮没探到的条数。 */
  pendingProbe: number
  /** 对齐结果为空时的原因文案。 */
  alignEmptyReason: string
  /** Emby 实例缺失告警。 */
  instanceAlert: string
  /** 存储不可用告警。 */
  storageAlert: string
  /** 探测异常告警。 */
  probeAlert: string
  /** 日报胶囊。 */
  dailyCapsule: Capsule
  /** 运行状态胶囊。 */
  healthCapsule: Capsule
  /** dry-run 提示是否要显示。 */
  dryRun: boolean
  /** 补订建议。 */
  trims: NonNullable<StateDoc['trim_suggestions']>
  /** 追剧日历：抓取时间。 */
  calendarFetchedAt: string
  /** 追剧日历：窗口内的天。 */
  calendarDays: NonNullable<NonNullable<StateDoc['calendar']>['days']>
  /** 追剧日历：展示模式。 */
  calendarMode: 'days' | 'unrecognized' | 'never' | 'empty'
  /** 追剧日历：顶部日期胶囊。 */
  calendarChips: { date: string; label: string; sub: string; today: boolean }[]
  /** 追剧日历：摊平后的播出安排。 */
  calendarEntries: CalendarEntry[]
  /** 追剧日历：未列出的条数。 */
  calendarOverflow: number
  /** 最近动作（日志）。 */
  logs: NonNullable<StateDoc['logs']>
  /** Emby 实例下拉项。 */
  instanceOptions: { label: string; value: number; disabled: boolean }[]
  /** 探测诊断面板（5 个端点）。 */
  probePanels: ProbePanel[]
  /** 探测错误列表（倒序）。 */
  lastErrors: NonNullable<NonNullable<StateDoc['debug']>['last_errors']>
  /** host.call 尝试列表（倒序）。 */
  attempts: NonNullable<NonNullable<StateDoc['debug']>['attempts']>
  /** 完整诊断文本。 */
  diagnosticsText: string

  /** 重新读状态文档与设置。 */
  loadData(): Promise<void>
  /** 触发一个前台动作（refresh / align-now / probe-dump）。 */
  runAction(name: ActionName): Promise<void>
  /** 设置筛选。 */
  setFilter(filter: AlignFilter): void
  /** 展开探测诊断并跑一次探测。 */
  openProbe(): Promise<void>
  /** 折叠/展开探测诊断。 */
  toggleProbe(): void
  /** 打开设置抽屉。 */
  openSettings(): void
  /** 关闭设置抽屉。 */
  closeSettings(): void
  /** 保存设置（只提交被改动的键）。 */
  saveSettings(payload: Partial<FlatSettings>): Promise<void>
  /** 弹一条提示。 */
  toast(kind: ToastItem['kind'], message: string): void
  /** 页面卸载：停定时器、解绑监听。 */
  dispose(): void
}

/** 造 store（AppPage 在 setup 里调用一次）。 */
export function createChaseStore(ctx: HostContext): ChaseStore {
  const state = ref<StateDoc | null>(null)
  const loading = ref(true)
  const stateError = ref('')
  const settings = ref<FlatSettings>({ ...(FLAT_DEFAULTS as FlatSettings) })
  const busy = ref<ActionName | ''>('')
  const result = ref<{ ok: boolean; text: string } | null>(null)
  const filter = ref<AlignFilter>('all')
  const probeOpen = ref(false)
  const drawerOpen = ref(false)
  const toasts = ref<ToastItem[]>([])

  let disposed = false
  let toastSeq = 0
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const sleepCancels = new Set<() => void>()

  /** 可被卸载打断的 sleep。 */
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const cancel = () => {
        clearTimeout(timer)
        sleepCancels.delete(cancel)
        resolve()
      }
      const timer = setTimeout(() => {
        sleepCancels.delete(cancel)
        resolve()
      }, ms)
      sleepCancels.add(cancel)
    })
  }

  function toast(kind: ToastItem['kind'], message: string): void {
    const id = ++toastSeq
    toasts.value = [...toasts.value, { id, kind, message }]
    const timer = setTimeout(() => {
      timers.delete(timer)
      toasts.value = toasts.value.filter((item) => item.id !== id)
    }, 4200)
    timers.add(timer)
  }

  // ─────────────────────────── 数据加载 ───────────────────────────

  async function readState(): Promise<StateDoc | null> {
    try {
      const value = await ctx.storage.get<StateDoc>('state')
      stateError.value = ''
      return value && typeof value === 'object' ? value : null
    } catch (error) {
      // storage.get 的 404 = 全新安装（还没有状态文档），不是错误。
      const status = (error as { status?: number } | null)?.status
      if (status === 404) {
        stateError.value = ''
        return null
      }
      stateError.value = String((error as { message?: string } | null)?.message ?? error)
      throw error
    }
  }

  async function loadData(): Promise<void> {
    let next: StateDoc | null = null
    try {
      next = await readState()
    } catch {
      next = null
    }
    if (disposed) return
    state.value = next
    loading.value = false
    try {
      const raw = (await ctx.settings.get()) ?? {}
      settings.value = normalizeFlat(raw) as FlatSettings
    } catch {
      settings.value = { ...(FLAT_DEFAULTS as FlatSettings) }
    }
  }

  // ─────────────────────────── 动作 ───────────────────────────

  async function pollRun(run: { id: string; [k: string]: unknown }): Promise<Record<string, unknown>> {
    const started = Date.now()
    let current = run as Record<string, unknown>
    while (current && (current.status === 'queued' || current.status === 'running')) {
      if (disposed || ctx.signal?.aborted) throw new Error('页面已关闭，任务转入后台继续')
      if (Date.now() - started > POLL_TIMEOUT_MS) {
        return {
          ...current,
          status: 'running',
          message: `任务仍在运行（${current.id}），可在宿主任务记录里查看`,
        }
      }
      await sleep(POLL_INTERVAL_MS)
      if (disposed) throw new Error('页面已关闭，任务转入后台继续')
      current = (await ctx.tasks.get(current.id as string)) as Record<string, unknown>
    }
    return current ?? {}
  }

  function showActionResult(name: ActionName, run: Record<string, unknown>): void {
    const raw = run?.result
    const taskResult = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    if (run?.status === 'failed' || taskResult.status === 'failed') {
      const message = String(taskResult.message ?? run?.error ?? '操作失败')
      if (name === 'align-now') result.value = { ok: false, text: message }
      toast('error', message)
      return
    }
    if (run?.status === 'cancelled') {
      toast('warning', '任务已取消')
      return
    }
    if (name === 'align-now') {
      const absent = num(taskResult.absent, 0)
      const note = taskResult.budget_hit ? ' · 达时间预算提前结束' : ''
      const absentNote = absent > 0 ? ` · 未收录 ${absent} 条` : ''
      const doneText = `完成: 补订 ${num(taskResult.patched, 0)} 条 · 跳过 ${num(taskResult.skipped, 0)} 条 · 失败 ${num(taskResult.failed, 0)} 条${absentNote}${note}`
      result.value = { ok: true, text: doneText }
      toast('success', `立即对齐${doneText}`)
    } else {
      toast('success', String(taskResult.message ?? '操作完成'))
    }
  }

  async function runAction(name: ActionName): Promise<void> {
    if (busy.value) return
    busy.value = name
    result.value = null
    try {
      const run = await ctx.tasks.run(name, `${name}-${Date.now()}`, {})
      const finished = await pollRun(run as { id: string; [k: string]: unknown })
      if (!disposed) showActionResult(name, finished)
    } catch (error) {
      const message = String((error as { message?: string } | null)?.message ?? error)
      if (!disposed) {
        if (name === 'align-now') result.value = { ok: false, text: message }
        toast('error', message)
      }
    } finally {
      if (!disposed) busy.value = ''
      if (!disposed) await loadData()
    }
  }

  async function openProbe(): Promise<void> {
    probeOpen.value = true
    await runAction('probe-dump')
  }

  // ─────────────────────────── 设置 ───────────────────────────

  async function saveSettings(payload: Partial<FlatSettings>): Promise<void> {
    const keys = Object.keys(payload)
    if (keys.length === 0) {
      toast('info', '没有改动')
      return
    }
    try {
      // 白名单逐键合并（绝不整块替换：表单之外有未知键时也要保留）。
      const merged = mergeFlat(settings.value, payload) as { flat: FlatSettings }
      await ctx.settings.set(merged.flat as unknown as Record<string, unknown>)
      settings.value = merged.flat
      drawerOpen.value = false
      toast('success', `已更新设置: ${keys.join(', ')}`)
      await loadData()
    } catch (error) {
      toast('error', String((error as { message?: string } | null)?.message ?? error))
    }
  }

  // ─────────────────────────── 派生状态 ───────────────────────────

  const align = computed(() => state.value?.align ?? {})
  const stats = computed(() => state.value?.stats ?? {})
  const debug = computed(() => state.value?.debug ?? {})
  const daily = computed(() => state.value?.daily ?? {})
  const alignItems = computed(() => list<AlignItem>(align.value.items))

  const tiles = computed<Tile[]>(() => {
    // 「本轮复用」：状态汇总没有 reused 字段，数 reason 含「复用」的行（规范 §4.2 的回退口径）。
    const reused = alignItems.value.filter((item) => text(item.reason, '').includes('复用')).length
    const values: Record<string, number> = {
      tv_intents: num(stats.value.tv_intents, 0),
      matched: num(stats.value.matched, 0),
      patched: num(align.value.patched, 0),
      skipped: num(align.value.skipped, 0),
      failed: num(align.value.failed, 0),
      absent: num(align.value.absent, 0),
      pending_probe: num(align.value.pending_probe, 0),
      reused,
    }
    const defs: { key: string; label: string }[] = [
      { key: 'tv_intents', label: '订阅池' },
      { key: 'matched', label: '已判定' },
      { key: 'patched', label: '补订' },
      { key: 'skipped', label: '跳过' },
      { key: 'failed', label: '失败' },
      { key: 'absent', label: '未收录' },
      { key: 'pending_probe', label: '待探测' },
      { key: 'reused', label: '本轮复用' },
    ]
    const tones: Record<string, Tile['tone']> = {
      patched: 'primary',
      failed: values.failed > 0 ? 'error' : 'default',
      absent: values.absent > 0 ? 'warning' : 'default',
      pending_probe: values.pending_probe > 0 ? 'primary' : 'default',
      reused: 'success',
    }
    return defs.map((def) => ({
      key: def.key,
      label: def.label,
      value: values[def.key] ?? 0,
      tone: tones[def.key] ?? 'default',
    }))
  })

  const alignRows = computed<AlignRow[]>(() =>
    alignItems.value.map((item) => ({ item, badge: reasonBadge(item) })),
  )

  const alignSub = computed(() => {
    const time = timeAt(align.value.last_run_at)
    const runPart = time ? `${time} 运行` : '还没有运行记录'
    return `本轮 ${alignItems.value.length} 个剧·季 · ${runPart} · 立即对齐 6 秒预算 · 单轮最多补订 ${num(settings.value.max_patch_per_run, 5)} 条`
  })

  const pendingProbe = computed(() => num(align.value.pending_probe, 0))

  const alignEmptyReason = computed(() => {
    if (align.value.last_run_at) {
      if (probeFailed(debug.value.emby_episodes?.status)) {
        return `Emby 覆盖结构未识别（${text(debug.value.emby_episodes?.status)}），该轮零写入。点「探测诊断」看参数矩阵与原文样本。`
      }
      if (align.value.last_error) return String(align.value.last_error)
      return '这一轮没有需要判定或补订的条目（订阅池可能为空，或没有可用的 Emby 实例）。'
    }
    return '还没有跑过对齐。点「立即对齐」先看一轮结果，或等下一个整点的后台任务。'
  })

  const instanceAlert = computed(() => {
    if (!state.value) return ''
    const instances = list(state.value.emby_instances)
    if (instances.length > 0) return ''
    const proxy = num(settings.value.emby_proxy_id, -1)
    const target = proxy >= 1 ? `设置指向实例 #${proxy}，但` : ''
    return `${target}还没有读到 Emby 实例列表（最近一次解析未成功）。下一步：点「探测诊断」——它会调 emby/instances 并把结果存进状态文档，下拉框随即有值。`
  })

  const storageAlert = computed(() => {
    if (!state.value) return ''
    const haystack = [
      text(state.value.last_message, ''),
      ...list(state.value.logs)
        .slice(-5)
        .map((entry) => text(entry.message, '')),
    ].join('\n')
    if (haystack.includes('存储不可用')) {
      return '运行时报告「宿主存储不可用」：本轮只读、不落盘，设置改动不会保存。先确认宿主存储可用再操作。'
    }
    return ''
  })

  const probeAlert = computed(() => {
    if (!state.value) return ''
    const embyStatus = debug.value.emby_episodes?.status
    if (probeFailed(embyStatus)) {
      return `Emby 覆盖结构未识别（status=${text(embyStatus)}, http=${num(debug.value.emby_episodes?.http_status, 0)}）：该轮涉及 Emby 覆盖判定的条目零写入。点「探测诊断」重跑参数矩阵，展开诊断区看原文样本。`
    }
    const calendarStatus = debug.value.air_calendar?.status
    if (probeFailed(calendarStatus)) {
      return `追剧日历结构未识别（status=${text(calendarStatus)}）：日历与日报的「今日播出」段会缺内容，对齐不受影响。点「探测诊断」看原文样本。`
    }
    const tmdbStatus = debug.value.tmdb_target?.status
    if (tmdbStatus === 'http_error' || tmdbStatus === 'transport_error' || tmdbStatus === 'unparsed') {
      return `TMDB 该季集数取不到（status=${text(tmdbStatus)}, http=${num(debug.value.tmdb_target?.http_status, 0)}）：结果表里目标显示「未知」，补订按 Emby 缺口判定（不会拿订阅集数顶替）。点「探测诊断」看原文样本。`
    }
    return ''
  })

  const dryRun = computed(() => settings.value.dry_run === true)

  const healthCapsule = computed<Capsule>(() => {
    if (!state.value) {
      return { label: '状态未拉取', type: 'default', title: '' }
    }
    const suffix = timeAt(align.value.last_run_at) || timeAt(state.value.last_run)
    const withTime = suffix ? ` · ${suffix}` : ''
    if (text(state.value.status, '') === 'failed') {
      return { label: `运行异常${withTime}`, type: 'error', title: '上一次运行失败' }
    }
    if (settings.value.enabled === false) {
      return { label: '已停用', type: 'default', title: '设置里关掉了「启用插件」' }
    }
    return { label: `运行正常${withTime}`, type: 'success', title: '' }
  })

  const dailyCapsule = computed<Capsule>(() => {
    const today = localDateOf(num(settings.value.report_tz_offset_minutes, 480))
    if (settings.value.report_enabled !== true) {
      return { label: '日报 · 已关闭', type: 'default', title: '设置里未开启 TG 日报' }
    }
    if (text(daily.value.last_sent_date, '') === today) {
      return {
        label: '日报 · 今日已发',
        type: 'success',
        title: `${today} · 累计 ${num(daily.value.sent_total, 0)} 次`,
      }
    }
    return {
      label: '日报 · 今日待发',
      type: 'warning',
      title: `本地 ${num(settings.value.report_hour, 9)}:00 之后的首次运行发送`,
    }
  })

  const trims = computed(() => list(state.value?.trim_suggestions))

  const calendarFetchedAt = computed(() => formatAt(state.value?.calendar?.fetched_at))
  const calendarDays = computed(() => list(state.value?.calendar?.days))

  const calendarMode = computed<'days' | 'unrecognized' | 'never' | 'empty'>(() => {
    const days = calendarDays.value
    if (days.length > 0) return 'days'
    const status = debug.value.air_calendar?.status
    if (probeFailed(status)) return 'unrecognized'
    if (!status || status === 'never') return 'never'
    return 'empty'
  })

  const today = computed(() => localDateOf(num(settings.value.report_tz_offset_minutes, 480)))

  const calendarChips = computed(() =>
    calendarDays.value.slice(0, 7).map((day) => {
      const date = text(day.date, '')
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
      const isToday = date === today.value
      return {
        date,
        label: isToday ? '今天' : weekdayOf(date),
        sub: match ? `${Number(match[2])}/${Number(match[3])}` : date,
        today: isToday,
      }
    }),
  )

  const calendarEntries = computed<CalendarEntry[]>(() => {
    const entries: CalendarEntry[] = []
    for (const day of calendarDays.value) {
      const date = text(day.date, '')
      const isToday = date === today.value
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
    return entries
  })

  const calendarOverflow = computed(() => Math.max(0, calendarEntries.value.length - 8))

  const logs = computed(() => list(state.value?.logs))

  const instanceOptions = computed(() => {
    const options = [
      { label: '跟随宿主默认实例 (-1)', value: -1, disabled: false },
      { label: '旧版单实例: 调用时不带 proxy_id (0)', value: 0, disabled: false },
    ]
    for (const instance of list(state.value?.emby_instances)) {
      const id = num(instance.id, 0)
      const parts = [`${text(instance.name, `实例 #${id}`)} #${id}`]
      if (instance.is_default === true) parts.push('宿主默认')
      if (instance.key_ready === false) parts.push('未配置密钥')
      options.push({ label: parts.join(' · '), value: id, disabled: instance.key_ready === false })
    }
    return options
  })

  const probePanels = computed<ProbePanel[]>(() => {
    const defs: { name: string; key: keyof NonNullable<StateDoc['debug']>; hint: string }[] = [
      {
        name: 'emby/instances',
        key: 'emby_instances',
        hint: 'Emby 实例列表现场；「200 但解析为空」时看原文分辨是字段没认出还是宿主没配实例。',
      },
      {
        name: 'emby/episodes',
        key: 'emby_episodes',
        hint: 'Emby 已有集数的解析现场；结构未识别时该轮零写入(不猜集号)。',
      },
      {
        name: 'subscribe/air-calendar',
        key: 'air_calendar',
        hint: '追剧日历的解析现场；失败只影响日历与日报的「今日播出」段。',
      },
      {
        name: 'subscribe/pool/intents',
        key: 'pool_intents',
        hint: '订阅池列表的解析现场(对规格的显式扩展槽: 订阅池解析失败时原文无处安放, 所以与上面两个同形)。',
      },
      {
        name: 'tmdb/tv (该季集数)',
        key: 'tmdb_target',
        hint: '该季 TMDB 集数的取数现场(带 raw_episode_counts=true); 取不到时对齐判定只靠 Emby 缺口, 结果表会显示「未知」。',
      },
    ]
    return defs.map((def) => ({
      name: def.name,
      hint: def.hint,
      snapshot: (debug.value[def.key] ?? {}) as ProbePanel['snapshot'],
    }))
  })

  const lastErrors = computed(() => list(debug.value.last_errors).slice(-10).reverse())

  const attempts = computed(() => list(debug.value.attempts).slice(-20).reverse())

  const diagnosticsText = computed(() => {
    const doc = state.value
    const lines: string[] = []
    lines.push(`# 追剧管家诊断 生成于 ${new Date().toISOString()}`)
    lines.push(
      `# 状态: ${text(doc?.status, '—')} · revision ${num(doc?.revision, 0)} · schema ${num(doc?.schema_version, 0)}`,
    )
    lines.push(`# 最近消息: ${text(doc?.last_message, '—')}`)
    lines.push(`# 探测更新于: ${formatAt(debug.value.updated_at)}`)
    const snapshots: [string, ProbePanel['snapshot']][] = [
      ['emby/episodes', debug.value.emby_episodes ?? {}],
      ['subscribe/air-calendar', debug.value.air_calendar ?? {}],
      ['subscribe/pool/intents', debug.value.pool_intents ?? {}],
      ['tmdb/tv (该季集数)', debug.value.tmdb_target ?? {}],
    ]
    for (const [name, probe] of snapshots) {
      lines.push('')
      lines.push(`## ${name}`)
      lines.push(
        `status: ${text(probe.status, 'never')} · http_status: ${num(probe.http_status, 0)} · at: ${formatAt(probe.at)}`,
      )
      lines.push(`shape: ${text(probe.shape, '(未识别)')}`)
      lines.push(`params_tried: ${list(probe.params_tried).join(' | ') || '(无)'}`)
      lines.push('sample(≤2KB):')
      lines.push(text(probe.sample, '(空)'))
    }
    lines.push('')
    lines.push('## 探测尝试')
    for (const attempt of list(debug.value.attempts).slice(-20).reverse()) {
      lines.push(
        `- ${formatAt(attempt.at)} ${text(attempt.endpoint)} ${text(attempt.params)} → ${num(attempt.http_status, 0)} ${text(attempt.shape)}`,
      )
    }
    lines.push('')
    lines.push('## last_errors')
    for (const error of list(debug.value.last_errors).slice(-10).reverse()) {
      lines.push(`- ${formatAt(error.at)} [${text(error.step)}] ${text(error.message)}`)
    }
    lines.push('')
    lines.push('## 日志 (最近 50 条)')
    for (const entry of list(doc?.logs).slice(-50)) {
      lines.push(`- ${formatAt(entry.at)} [${text(entry.level)}] ${text(entry.message)}`)
    }
    return lines.join('\n')
  })

  // ─────────────────────────── 生命周期 ───────────────────────────

  const onAbort = () => {
    disposed = true
  }
  ctx.signal?.addEventListener?.('abort', onAbort)

  const store = reactive({
    ctx: markRaw(ctx),
    state,
    loading,
    stateError,
    settings,
    busy,
    result,
    filter,
    probeOpen,
    drawerOpen,
    toasts,
    tiles,
    alignRows,
    alignSub,
    pendingProbe,
    alignEmptyReason,
    instanceAlert,
    storageAlert,
    probeAlert,
    dailyCapsule,
    healthCapsule,
    dryRun,
    trims,
    calendarFetchedAt,
    calendarDays,
    calendarMode,
    calendarChips,
    calendarEntries,
    calendarOverflow,
    logs,
    instanceOptions,
    probePanels,
    lastErrors,
    attempts,
    diagnosticsText,
    loadData,
    runAction,
    setFilter(next: AlignFilter) {
      filter.value = next
    },
    openProbe,
    toggleProbe() {
      probeOpen.value = !probeOpen.value
    },
    openSettings() {
      drawerOpen.value = true
    },
    closeSettings() {
      drawerOpen.value = false
    },
    saveSettings,
    toast,
    dispose() {
      disposed = true
      ctx.signal?.removeEventListener?.('abort', onAbort)
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      for (const cancel of Array.from(sleepCancels)) cancel()
      sleepCancels.clear()
    },
  })

  return store as unknown as ChaseStore
}

/** 把 store 放进组件树。 */
export function provideChaseStore(store: ChaseStore): void {
  provide(CHASE_KEY, store)
}

/** 组件里取 store。 */
export function useChaseStore(): ChaseStore {
  const store = inject<ChaseStore | undefined>(CHASE_KEY, undefined)
  if (!store) {
    throw new Error('[chase-rs] 组件树里没有 store：页面必须通过 mount(el, ctx) 装配。')
  }
  return store
}
