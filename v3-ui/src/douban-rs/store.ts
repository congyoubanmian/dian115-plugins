// 豆瓣中心页面的状态中枢：读数据、跑动作、出提示。
//
// 数据面全部来自宿主 ctx：
// - ctx.storage.get('state') —— 后端 jobs 落盘的状态文档（页面只读，不写）；
// - ctx.settings.get()      —— 宿主设置 KV（清单 settings[] 的那份）；
// - ctx.tasks.run/get       —— 动作一律提交到宿主任务队列，再轮询到终态。
// 页面不直接 fetch 宿主业务接口，也不自己造 WebSocket。

import { computed, inject, provide, ref, type ComputedRef, type Ref } from 'vue'
import type { HostContext } from '../shared/types'
import { ACTION_LABELS, BATCH_SUBSCRIBE_LIMIT, BUSY_TEXT, POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from './constants'
import { text } from './format'
import {
  FLAT_DEFAULTS,
  NO_RESUB_CONFIRM_TEXT,
  defaultSettings,
  isRecognizable,
  normalizeFlat,
  parseStateDoc,
  sanitizeSettingsView,
} from './lib-bridge'
import type {
  BlackState,
  ChartItem,
  DocSettings,
  FlatSettings,
  HistoryEntry,
  LogEntry,
  QueueItem,
  SettingsView,
  StateDoc,
  WishInfo,
  WishItem,
} from './types'

/** 页面标签页。 */
export type TabKey = 'charts' | 'queue' | 'history' | 'settings'
/** 提示条类型。 */
export type ToastKind = 'success' | 'error' | 'warning' | 'info'
/** 一条提示。 */
export interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

/** 动作的可选项。 */
export interface ActionOptions {
  /** 动作按钮/提示上显示的名字。 */
  label?: string
  /** 执行前的确认文案。 */
  confirm?: string
  /** 该条目是否命中「已删除不重订」墓碑（需要额外确认）。 */
  tombstoneRef?: string
}

/** 任务运行的返回（宿主任务队列的任务对象）。 */
export interface TaskRun {
  id?: string
  status?: string
  message?: string
  error?: string
  result?: unknown
  [key: string]: unknown
}

/** 页面状态中枢。 */
export interface DoubanStore {
  ctx: HostContext
  stateDoc: Ref<StateDoc | null>
  rawState: Ref<Record<string, unknown> | null>
  flat: Ref<FlatSettings>
  settingsView: Ref<SettingsView | null>
  stateError: Ref<string>
  stateInvalid: Ref<boolean>
  settingsError: Ref<string>
  busy: Ref<string>
  activeTab: Ref<TabKey>
  toasts: Ref<ToastItem[]>
  busyText: ComputedRef<string>
  docSettings: ComputedRef<DocSettings>
  queueItems: ComputedRef<QueueItem[]>
  wishItems: ComputedRef<WishItem[]>
  historyItems: ComputedRef<HistoryEntry[]>
  logItems: ComputedRef<LogEntry[]>
  blackState: ComputedRef<BlackState>
  wishInfo: ComputedRef<WishInfo>
  snapshotLists: ComputedRef<Record<string, ChartItem[]>>
  snapshotItems: ComputedRef<ChartItem[]>
  snapshotListCount: ComputedRef<number>
  tombstones: ComputedRef<Array<[string, { reason?: string; at?: string }]>>
  queueIndex: ComputedRef<Map<string, QueueItem>>
  dueItems: ComputedRef<QueueItem[]>
  loadData(): Promise<void>
  refreshUi(): Promise<void>
  runAction(name: string, input?: Record<string, unknown>, options?: ActionOptions): Promise<void>
  invokeJob(name: string, input?: Record<string, unknown>, timeoutMs?: number): Promise<TaskRun>
  saveSettings(patch: Record<string, unknown>): Promise<void>
  subscribeDueBatch(): Promise<void>
  showTab(key: TabKey): void
  toast(kind: ToastKind, message: string): void
  confirm(message: string): boolean
  dispose(): void
}

/** 状态中枢的注入键。 */
export const STORE_KEY = 'doubanStore'

/** 把状态中枢注入组件树。 */
export function provideDoubanStore(store: DoubanStore): void {
  provide(STORE_KEY, store)
}

/** 组件里取状态中枢。 */
export function useDoubanStore(): DoubanStore {
  const store = inject<DoubanStore | undefined>(STORE_KEY, undefined)
  if (!store) throw new Error('[douban-rs] 组件树里没有 store：页面必须通过 mount(el, ctx) 装配。')
  return store
}

/** 错误转文案（保留宿主返回的原始业务错误）。 */
export function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? '未知错误')
  }
  return String(error ?? '未知错误')
}

/**
 * 建状态中枢。
 *
 * @param ctx 宿主上下文（页面所有数据与能力都从这里走）。
 */
export function createDoubanStore(ctx: HostContext): DoubanStore {
  const stateDoc = ref<StateDoc | null>(null)
  const rawState = ref<Record<string, unknown> | null>(null)
  const flat = ref<FlatSettings>({ ...FLAT_DEFAULTS, regions: [], subscribe_source_filter: [] })
  const settingsView = ref<SettingsView | null>(null)
  const stateError = ref('')
  const stateInvalid = ref(false)
  const settingsError = ref('')
  const busy = ref('')
  const activeTab = ref<TabKey>('charts')
  const toasts = ref<ToastItem[]>([])

  let disposed = false
  let toastSeq = 0
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const sleepers = new Set<() => void>()

  // ─────────────────────────── 派生数据 ───────────────────────────

  const docSettings = computed<DocSettings>(() => stateDoc.value?.settings ?? defaultSettings())
  const queueItems = computed<QueueItem[]>(() => stateDoc.value?.queue?.items ?? [])
  const wishItems = computed<WishItem[]>(() => stateDoc.value?.wish ?? [])
  const historyItems = computed<HistoryEntry[]>(() => stateDoc.value?.history ?? [])
  const logItems = computed<LogEntry[]>(() => stateDoc.value?.logs ?? [])
  const blackState = computed<BlackState>(() => stateDoc.value?.blackstate ?? {})
  const wishInfo = computed<WishInfo>(() => stateDoc.value?.wish_info ?? {})
  const snapshotLists = computed<Record<string, ChartItem[]>>(() => stateDoc.value?.snapshot?.lists ?? {})
  const snapshotItems = computed<ChartItem[]>(() => {
    const all: ChartItem[] = []
    for (const items of Object.values(snapshotLists.value)) if (Array.isArray(items)) all.push(...items)
    return all
  })
  const snapshotListCount = computed(() => Object.keys(snapshotLists.value).length)
  const tombstones = computed<Array<[string, { reason?: string; at?: string }]>>(
    () => Object.entries(stateDoc.value?.no_resub ?? {}),
  )
  const queueIndex = computed(() => {
    const index = new Map<string, QueueItem>()
    for (const item of queueItems.value) if (item?.douban_ref) index.set(item.douban_ref, item)
    return index
  })
  const dueItems = computed<QueueItem[]>(() => queueItems.value.filter((item) => isDueItem(item)))
  const busyText = computed(() => (busy.value === '' ? '' : BUSY_TEXT[busy.value] || '正在执行…'))

  function isDueItem(item: QueueItem): boolean {
    if (typeof item?.due_at !== 'string' || item.due_at === '') return false
    const parsed = Date.parse(item.due_at)
    return Number.isFinite(parsed) && parsed <= Date.now()
  }

  // ─────────────────────────── 提示条 ───────────────────────────

  function toast(kind: ToastKind, message: string): void {
    if (disposed) return
    const id = ++toastSeq
    toasts.value = [...toasts.value, { id, kind, message }]
    const timer = setTimeout(() => {
      timers.delete(timer)
      toasts.value = toasts.value.filter((item) => item.id !== id)
    }, 5000)
    timers.add(timer)
  }

  function confirm(message: string): boolean {
    const host = globalThis as { confirm?: (text: string) => boolean }
    return typeof host.confirm === 'function' ? host.confirm(message) : false
  }

  // ─────────────────────────── 任务执行 ───────────────────────────

  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        timers.delete(timer)
        sleepers.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      timers.add(timer)
      sleepers.add(done)
    })
  }

  function businessKey(name: string): string {
    return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  /** 提交任务并轮询到终态。 */
  async function invokeJob(
    name: string,
    input: Record<string, unknown> = {},
    timeoutMs: number = POLL_TIMEOUT_MS,
  ): Promise<TaskRun> {
    const run = (await ctx.tasks.run(name, businessKey(name), input ?? {})) as TaskRun
    return pollRun(run, timeoutMs)
  }

  async function pollRun(run: TaskRun, timeoutMs: number = POLL_TIMEOUT_MS): Promise<TaskRun> {
    let current: TaskRun | undefined = run
    const started = Date.now()
    while (current && (current.status === 'queued' || current.status === 'running')) {
      if (disposed || ctx.signal?.aborted) {
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
      current = (await ctx.tasks.get(current.id as string)) as TaskRun
    }
    return current ?? run
  }

  /** 任务结果 → 提示条。 */
  function reportRun(label: string, run: TaskRun): void {
    const rawResult = run?.result
    const result = rawResult && typeof rawResult === 'object' ? (rawResult as Record<string, unknown>) : {}
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

  /** 执行一个动作（提交任务 → 轮询 → 提示 → 重读数据）。 */
  async function runAction(
    name: string,
    input: Record<string, unknown> = {},
    options: ActionOptions = {},
  ): Promise<void> {
    if (busy.value !== '' || disposed) return
    if (options.confirm && !confirm(options.confirm)) return
    if (options.tombstoneRef && !confirmTombstone(options.tombstoneRef)) return
    const label = options.label || ACTION_LABELS[name] || name
    busy.value = name
    try {
      const finished = await invokeJob(name, input)
      if (!disposed) reportRun(label, finished)
    } catch (error) {
      if (!disposed) toast('error', errorText(error))
    } finally {
      if (!disposed) {
        busy.value = ''
        await refreshUi()
      }
    }
  }

  /** 命中「已删除不重订」墓碑时要额外确认。 */
  function confirmTombstone(doubanRef: string): boolean {
    const map = stateDoc.value?.no_resub
    if (map && Object.prototype.hasOwnProperty.call(map, doubanRef)) {
      return confirm(NO_RESUB_CONFIRM_TEXT)
    }
    return true
  }

  // ─────────────────────────── 数据加载 ───────────────────────────

  async function loadData(): Promise<void> {
    // 先保留当前快照：读取期间继续展示旧数据，避免每次刷新都闪成「全新安装」。
    // 新状态读完后一次性替换；读失败时按原语义落到空状态。
    let nextRaw: Record<string, unknown> | null = null
    let nextDoc: StateDoc | null = null
    stateError.value = ''
    stateInvalid.value = false
    settingsError.value = ''
    try {
      const raw = await ctx.storage.get('state')
      if (raw !== null && raw !== undefined && raw !== '') {
        nextRaw = typeof raw === 'object' ? (raw as Record<string, unknown>) : null
        const parsed = parseStateDoc(raw)
        if (parsed === null || !isRecognizable(parsed)) {
          stateInvalid.value = true
          stateError.value =
            '存储里的 state 文档无法识别（不是本插件的状态文档，或字段类型不符）；为避免覆盖异常数据，页面只展示空状态。'
        } else {
          nextDoc = parsed
        }
      }
    } catch (error) {
      // 404 = 全新安装，还没有状态文档，不是错误。
      const status = (error as { status?: number } | null)?.status
      if (status !== 404) stateError.value = `读取 state 存储失败：${errorText(error)}`
    }
    rawState.value = nextRaw
    stateDoc.value = nextDoc
    let rawSettings: unknown = {}
    try {
      rawSettings = (await ctx.settings.get()) ?? {}
    } catch (error) {
      rawSettings = {}
      settingsError.value = `读取宿主设置失败：${errorText(error)}`
    }
    flat.value = normalizeFlat(rawSettings)
    // 与 jobs/runtime.js Session.settings 的账号覆盖保持一致：清单设置为空时，
    // 状态文档里的旧账号字段仍生效。
    const legacy = stateDoc.value?.settings
    if (legacy) {
      if (legacy.cookiecloud_url && !flat.value.cookiecloud_url) flat.value.cookiecloud_url = legacy.cookiecloud_url
      if (legacy.cookiecloud_uuid && !flat.value.cookiecloud_uuid) flat.value.cookiecloud_uuid = legacy.cookiecloud_uuid
      if (legacy.cookiecloud_key && !flat.value.cookiecloud_key) flat.value.cookiecloud_key = legacy.cookiecloud_key
      if (legacy.manual_cookie && !flat.value.manual_cookie) flat.value.manual_cookie = legacy.manual_cookie
      if (legacy.wish_sync_enabled && !flat.value.wish_sync_enabled) flat.value.wish_sync_enabled = true
    }
    settingsView.value = stateDoc.value ? sanitizeSettingsView(stateDoc.value.settings) : null
  }

  async function refreshUi(): Promise<void> {
    try {
      await loadData()
    } catch (error) {
      if (!disposed) toast('error', `界面刷新失败：${errorText(error)}`)
    }
  }

  // ─────────────────────────── 设置保存 ───────────────────────────

  async function saveSettings(patch: Record<string, unknown>): Promise<void> {
    if (busy.value !== '' || disposed) return
    busy.value = 'settings-update'
    try {
      const finished = await invokeJob('settings-update', patch)
      const rawResult = finished?.result
      const result = rawResult && typeof rawResult === 'object' ? (rawResult as Record<string, unknown>) : {}
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
      if (!disposed) {
        busy.value = ''
        await refreshUi()
      }
    }
  }

  // ─────────────────────────── 批量到期订阅 ───────────────────────────
  //
  // 后端没有独立的 process-due job（到期订阅由定时 wish-sync 负责），
  // 所以「一键处理全部到期」由页面逐条提交 subscribe-now 任务实现：
  // 每条都走宿主任务队列，单条失败不影响其余条目。

  async function subscribeDueBatch(): Promise<void> {
    if (busy.value !== '' || disposed) return
    const due = dueItems.value.filter((item) => item.state !== 'subscribed')
    if (due.length === 0) {
      toast('info', '没有到期的队列条目')
      return
    }
    const list = due.slice(0, BATCH_SUBSCRIBE_LIMIT)
    const skipped = due.length - list.length
    const tombstoned = list.filter((item) => item.douban_ref && stateDoc.value?.no_resub?.[item.douban_ref]).length
    const question =
      `将逐条为 ${list.length} 个已到期条目提交「立即订阅」任务` +
      (skipped > 0 ? `（单次最多 ${BATCH_SUBSCRIBE_LIMIT} 条，另有 ${skipped} 条本次不处理）` : '') +
      (tombstoned > 0 ? `。其中 ${tombstoned} 条此前订阅过又已被删除，确认要重新订阅吗？` : '') +
      '继续吗？'
    if (!confirm(question)) return
    busy.value = 'subscribe-now'
    let done = 0
    let failed = 0
    let running = 0
    try {
      for (const item of list) {
        if (disposed) break
        try {
          const finished = await invokeJob('subscribe-now', { douban_ref: item.douban_ref })
          const raw = finished?.result
          const result = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
          if (finished?.status === 'failed' || result.status === 'failed') failed += 1
          else if (finished?.status === 'running') running += 1
          else done += 1
        } catch {
          failed += 1
        }
      }
      if (!disposed) {
        const runningText = running > 0 ? `，${running} 条仍在后台运行` : ''
        toast(
          failed === 0 && running === 0 ? 'success' : 'warning',
          `批量订阅完成：成功 ${done} 条，失败 ${failed} 条${runningText}`,
        )
      }
    } finally {
      if (!disposed) {
        busy.value = ''
        await refreshUi()
      }
    }
  }

  // ─────────────────────────── 杂项 ───────────────────────────

  function showTab(key: TabKey): void {
    activeTab.value = key
  }

  function dispose(): void {
    disposed = true
    for (const done of sleepers) done()
    sleepers.clear()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    toasts.value = []
  }

  return {
    ctx,
    stateDoc,
    rawState,
    flat,
    settingsView,
    stateError,
    stateInvalid,
    settingsError,
    busy,
    activeTab,
    toasts,
    busyText,
    docSettings,
    queueItems,
    wishItems,
    historyItems,
    logItems,
    blackState,
    wishInfo,
    snapshotLists,
    snapshotItems,
    snapshotListCount,
    tombstones,
    queueIndex,
    dueItems,
    loadData,
    refreshUi,
    runAction,
    invokeJob,
    saveSettings,
    subscribeDueBatch,
    showTab,
    toast,
    confirm,
    dispose,
  }
}
