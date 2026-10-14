<script setup lang="ts">
// 追剧管家 —— 插件界面(Federation 模块 `./AppPage`, 见 vite.config.ts)。
//
// 与宿主的唯一通道是 `props.api`(契约同 douban-center/src/AppPage.vue:49-53):
//   - 状态一律读 `props.runtimeState`(宿主注入的状态文档); 只有在宿主没给时,
//     才用 `props.api.getState()` 兜底拉一次 —— 绝不自己 fetch。
//   - 四个前台动作 `refresh` / `align-now` / `settings-update` / `probe-dump`
//     走 `props.api.invokeAction`, **每次动作后都 `await props.api.refresh()`**
//     (douban-center/src/AppPage.vue:243-270 的调用惯例, 否则界面还是旧值)。
//
// 视觉按《DIAN115 插件 UI 重画 · 共享实现规范》§4(追剧管家): 页头(状态/日报胶囊 + 动作组)
// → 8 块指标瓦片 → 对齐结果卡(筛选 pill 纯前端过滤) → 双栏(补订建议 + 追剧日历)
// → 探测诊断折叠条 → 最近动作 → 页脚。只呈现真实状态: 缺数据就说缺什么、下一步点哪里,
// 不造任何假数据。
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NDivider,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NSwitch,
  NText,
  useMessage,
} from 'naive-ui'
// lucide 图标统一加 `Icon` 后缀导入: 模板里 `<calendar-days />` 这种 kebab 标签会先按
// setup 绑定解析(camelize 后正好撞上 `calendarDays` 这类计算属性), 加后缀杜绝影子解析。
import {
  ChevronDown as ChevronDownIcon,
  CircleAlert as CircleAlertIcon,
  CircleCheckBig as CircleCheckBigIcon,
  CircleHelp as CircleHelpIcon,
  CircleMinus as CircleMinusIcon,
  CirclePlus as CirclePlusIcon,
  CircleX as CircleXIcon,
  CloudOff as CloudOffIcon,
  Copy as CopyIcon,
  Layers as LayersIcon,
  ListChecks as ListChecksIcon,
  Radar as RadarIcon,
  Recycle as RecycleIcon,
  RefreshCw as RefreshCwIcon,
  Send as SendIcon,
  Settings as SettingsIcon,
  SkipForward as SkipForwardIcon,
  Stethoscope as StethoscopeIcon,
  Tv as TvIcon,
  Zap as ZapIcon,
} from '@lucide/vue'
import ProbePanel from './ProbePanel.vue'
import StatTile from './StatTile.vue'
import {
  alignActionResult,
  formatAt,
  hasGap,
  list,
  localDate,
  num,
  probeFailed,
  reasonBadge,
  seasonLabel,
  targetKnown,
  text,
  type AlignItem,
  type AppState,
  type CalendarDay,
  type HostBridge,
  type ReasonBadge,
  type RuntimeCallback,
  type TrimSuggestion,
} from './chase-state'

const props = defineProps<{
  api: HostBridge
  hostApi?: HostBridge
  installationId?: number
  pluginId?: string
  runtime?: Record<string, unknown> | null
  runtimeState?: Record<string, unknown>
  navKey?: string
  themeContract?: string
}>()

const message = useMessage()
const busy = ref('')
const settingsOpen = ref(false)

// ─────────────────────────── 状态文档 ───────────────────────────

const localState = ref<AppState | null>(null)
const stateLoadError = ref('')
const loadingState = ref(false)

/** 宿主注入优先; 宿主没给(刚重启/更新窗口里 runtimeState 为空)时才用 getState 兜底。 */
const stateDoc = computed<AppState | null>(() => {
  const incoming = props.runtimeState as AppState | undefined
  if (incoming && typeof incoming === 'object' && Object.keys(incoming).length > 0) return incoming
  return localState.value
})

const state = computed<AppState>(() => stateDoc.value || ({} as AppState))
const stateReady = computed(() => stateDoc.value !== null)

async function loadState() {
  loadingState.value = true
  try {
    const response = await props.api.getState()
    const raw = response && typeof response === 'object' ? (response.state as AppState | undefined) : undefined
    if (raw && typeof raw === 'object' && Object.keys(raw).length > 0) {
      localState.value = raw
      stateLoadError.value = ''
    } else {
      stateLoadError.value = '宿主返回的状态文档为空(state 键缺失)'
    }
  } catch (error: unknown) {
    stateLoadError.value = String((error as { message?: string })?.message || error || '未知错误')
  } finally {
    loadingState.value = false
  }
}

onMounted(() => {
  if (!props.runtimeState || Object.keys(props.runtimeState).length === 0) void loadState()
})

// ─────────────────────────── 状态字段 ───────────────────────────

const settings = computed(() => state.value.settings || {})
const align = computed(() => state.value.align || {})
const stats = computed(() => state.value.stats || {})
const daily = computed(() => state.value.daily || {})
const debug = computed(() => state.value.debug || {})
const instances = computed(() => list(state.value.emby_instances))

const tzOffset = computed(() => num(settings.value.report?.tz_offset_minutes, 0))
const today = computed(() => localDate(tzOffset.value))

const overviewStatus = computed(() => ({
  status: text(state.value.status, '未运行'),
  lastMessage: text(state.value.last_message, '还没有运行记录'),
  revision: num(state.value.revision, 0),
  lastRun: formatAt(state.value.last_run),
  enabled: settings.value.enabled !== false,
  dryRun: settings.value.dry_run === true,
}))

// ─────────────────────────── ① 页头胶囊 ───────────────────────────

/** RFC3339 → `HH:MM`(与 formatAt 同一约定: 直接取原文时刻, 不做时区换算)。 */
function timeAt(value: unknown): string {
  const formatted = formatAt(value)
  if (formatted === '—') return ''
  const parts = formatted.split(' ')
  return parts.length === 2 ? (parts[1] ?? '') : formatted
}

/** RFC3339 → `HH:MM:SS`(日志行用; 认不出就回退 formatAt 的口径)。 */
function timeLongAt(value: unknown): string {
  const raw = text(value, '')
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(raw)
  return match ? (match[1] ?? '') : formatAt(raw)
}

/** 运行状态胶囊: 绿=正常(时间=对齐最近运行) / 红=失败 / 灰=停用或未拉取 —— 异常时说实话。 */
const healthCapsule = computed(() => {
  if (!stateReady.value) return { text: '状态未拉取', tone: 'neutral', icon: CircleHelpIcon }
  if (!overviewStatus.value.enabled) return { text: '已停用', tone: 'neutral', icon: CircleMinusIcon }
  const time = timeAt(align.value.last_run_at) || timeAt(state.value.last_run)
  const suffix = time ? ` · ${time}` : ''
  if (text(state.value.status, '') === 'failed') {
    return { text: `运行异常${suffix}`, tone: 'error', icon: CircleAlertIcon }
  }
  return { text: `运行正常${suffix}`, tone: 'success', icon: CircleCheckBigIcon }
})

/** 日报状态: 今日已发 / 今日待发 / 已关闭(按设置里的本地时区判定"今天")。 */
const reportStatus = computed(() => {
  const report = settings.value.report || {}
  if (report.enabled !== true) return { value: '已关闭', note: '设置里未开启 TG 日报', tone: 'default' as const }
  if (text(daily.value.last_sent_date, '') === today.value) {
    return {
      value: '今日已发',
      note: `${today.value} · 累计 ${num(daily.value.sent_total, 0)} 次`,
      tone: 'success' as const,
    }
  }
  return {
    value: '今日待发',
    note: `本地 ${num(report.hour, 9)}:00 之后的首次运行发送`,
    tone: 'warning' as const,
  }
})

/** 日报胶囊: 已发按设计图走灰胶囊; 待发用琥珀色提示; 已关闭灰。 */
const dailyCapsule = computed(() => ({
  text: `日报 · ${reportStatus.value.value}`,
  tone: reportStatus.value.tone === 'warning' ? 'warning' : 'neutral',
}))

// ─────────────────────────── ② 指标瓦片 ×8 ───────────────────────────

const alignSummary = computed(() => ({
  lastRunAt: formatAt(align.value.last_run_at),
  patched: num(align.value.patched, 0),
  skipped: num(align.value.skipped, 0),
  failed: num(align.value.failed, 0),
  absent: num(align.value.absent, 0),
  pendingProbe: num(align.value.pending_probe, 0),
  pages: num(align.value.pages, 0),
  intentsSeen: num(align.value.intents_seen, 0),
  matched: num(align.value.matched, 0),
  lastError: text(align.value.last_error, ''),
}))

const alignItems = computed<AlignItem[]>(() => list(align.value.items))
const gapItems = computed(() => alignItems.value.filter(hasGap))

/**
 * 「本轮复用」计数: 状态文档的 align 汇总没有 reused 字段(reused 只出现在
 * align-now 动作的返回 JSON), 按规范 §4.2 的回退口径, 数 align.items 里
 * reason 含「复用」的行(运行时复用行的 reason 固定带「本轮复用缓存」)。
 */
const reusedCount = computed(() => alignItems.value.filter((item) => text(item.reason, '').includes('复用')).length)

// ─────────────────────────── ③ 对齐结果卡 ───────────────────────────

/** 缺口列: 有缺口 `+N`(蓝) / 已核实 0 / 被预算挡下「待探测」(蓝) / 未知 `—`。 */
function gapCell(item: AlignItem): { label: string; cls: string } {
  if (hasGap(item)) return { label: `+${num(item.gap_max, 0)}`, cls: 'gap-num' }
  const reason = text(item.reason, '')
  if (reason.includes('下轮优先') || reason.includes('预算用尽')) return { label: '待探测', cls: 'gap-probe' }
  if (num(item.emby_have_max, -1) >= 0) return { label: '0', cls: 'muted' }
  return { label: '—', cls: 'muted' }
}

/** 动作列: 补订至 N / 待补订至 N(dry-run 必须如实标出) / 失败的下轮重试 / 无动作 `—`。 */
function actionCell(item: AlignItem, kind: ReasonBadge['kind']): { label: string; cls: string } {
  switch (item.action) {
    case 'patched':
      return { label: `补订至 ${num(item.to_total, 0)}`, cls: 'action-link' }
    case 'dry-run':
      return { label: `待补订至 ${num(item.to_total, 0)}`, cls: 'action-dry' }
    case 'failed':
      // 「Emby 无此剧」的行也记 action=failed, 但它没有"重试就会好"的含义 —— 不显示重试。
      return kind === 'failed' ? { label: '重试', cls: 'action-link' } : { label: '—', cls: 'muted' }
    default:
      return { label: '—', cls: 'muted' }
  }
}

/** reason 分类 → 胶囊配色(分类逻辑在 chase-state.reasonBadge, 一行不改; 这里只换视觉)。 */
function badgeClass(kind: ReasonBadge['kind']): string {
  switch (kind) {
    case 'patched':
      return 'badge-success'
    case 'target-unknown':
      return 'badge-info'
    case 'absent':
    case 'empty-season':
    case 'unknown-coverage':
      return 'badge-warning'
    case 'failed':
      return 'badge-error'
    default:
      return 'badge-neutral'
  }
}

/** 剧集副行: 季(零填充) + Emby 覆盖到的最大集号(真实字段 emby_have_max; -1 = 未探测)。 */
function seasonPad(season: unknown): string {
  const value = num(season, 0)
  return value > 0 ? `S${String(value).padStart(2, '0')}` : '整剧'
}

function coverageSub(item: AlignItem): string {
  const have = num(item.emby_have_max, -1)
  return have >= 0 ? `Emby 至 E${String(have).padStart(2, '0')}` : 'Emby 未探测'
}

/** 逐行预组装: 徽章/缺口/动作/复用标记只算一次, 模板里不再重复调用。 */
const alignRows = computed(() =>
  alignItems.value.map((item) => {
    const badge = reasonBadge(item)
    const reasonText = text(item.reason, '')
    return {
      item,
      badge,
      detail: alignActionResult(item),
      targetUnknown: !targetKnown(item),
      /** 复用上一轮已核实无缺口行(运行时 reason 固定带「本轮复用缓存」)→ 紫色「复用缓存」徽章。 */
      reused: reasonText.includes('复用缓存'),
      reasonText,
      gap: gapCell(item),
      action: actionCell(item, badge.kind),
    }
  }),
)

/** 「异常」筛选 = 失败 + 未收录类(无此剧/0 集/覆盖未知)—— 需要人看一眼的行。 */
const ABNORMAL_KINDS = new Set<ReasonBadge['kind']>(['failed', 'absent', 'empty-season', 'unknown-coverage'])

const filter = ref<'all' | 'gap' | 'abnormal'>('all')

const filterOptions = computed(() => [
  { key: 'all' as const, label: '全部', count: alignRows.value.length },
  { key: 'gap' as const, label: '有缺口', count: gapItems.value.length },
  { key: 'abnormal' as const, label: '异常', count: alignRows.value.filter((row) => ABNORMAL_KINDS.has(row.badge.kind)).length },
])

const filteredRows = computed(() => {
  if (filter.value === 'gap') return alignRows.value.filter((row) => hasGap(row.item))
  if (filter.value === 'abnormal') return alignRows.value.filter((row) => ABNORMAL_KINDS.has(row.badge.kind))
  return alignRows.value
})

/** 副题: 本轮条目数 · 最近运行时刻 · 立即对齐预算(6 秒 = 运行时 ALIGN_NOW_BUDGET_SECS) · 单轮补订上限。 */
const alignSub = computed(() => {
  const time = timeAt(align.value.last_run_at)
  const maxPatch = num(settings.value.max_patch_per_run, 5)
  const runPart = time ? `${time} 运行` : '还没有运行记录'
  return `本轮 ${alignItems.value.length} 个剧·季 · ${runPart} · 立即对齐 6 秒预算 · 单轮最多补订 ${maxPatch} 条`
})

const alignEmptyReason = computed(() => {
  if (alignItems.value.length > 0) return ''
  if (!align.value.last_run_at) {
    return '还没有跑过对齐。点「立即对齐」先看一轮结果, 或等下一个整点的后台任务。'
  }
  if (probeFailed(debug.value.emby_episodes?.status)) {
    return `Emby 覆盖结构未识别(${text(debug.value.emby_episodes?.status)}), 该轮零写入。点「探测诊断」看参数矩阵与原文样本。`
  }
  if (align.value.last_error) return align.value.last_error
  return '这一轮没有需要判定或补订的条目(订阅池可能为空, 或没有可用的 Emby 实例)。'
})

// ─────────────────────────── ④ 追剧日历 ───────────────────────────

const calendarDays = computed<CalendarDay[]>(() => list(state.value.calendar?.days))
const calendarFetchedAt = computed(() => formatAt(state.value.calendar?.fetched_at))

/** `days` | `unrecognized` | `never` | `empty` —— 空列表要能区分"没抓过/没安排/没认出来"。 */
const calendarState = computed(() => {
  if (calendarDays.value.length > 0) return 'days'
  const status = debug.value.air_calendar?.status
  if (probeFailed(status)) return 'unrecognized'
  if (!status || status === 'never') return 'never'
  return 'empty'
})

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** `YYYY-MM-DD` → 周一..周日(日期本身是后端按本地时区给的, 按日历日取星期, 不再换算)。 */
function weekdayOf(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return ''
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
  return WEEKDAYS[day] ?? ''
}

/** 日期 chip(最多 7 天, 窗口真实有几日出几日; 今天高亮主色)。 */
const calendarChips = computed(() =>
  calendarDays.value.slice(0, 7).map((day) => {
    const date = text(day.date, '')
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    return {
      date,
      isToday: date === today.value,
      weekday: weekdayOf(date),
      short: match ? `${Number(match[2])}/${Number(match[3])}` : date,
    }
  }),
)

/** 集数紧凑写法: S1 直接写 E13(设计图口径), 更靠后的季带上季号。 */
function episodeCompact(season: unknown, episode: unknown): string {
  const ep = num(episode, 0)
  if (ep <= 0) return ''
  const s = num(season, 0)
  return s > 1 ? `S${s} E${ep}` : `E${ep}`
}

interface CalendarEntry {
  key: string
  dayLabel: string
  isToday: boolean
  title: string
  episode: string
  time: string
}

const calendarEntriesAll = computed<CalendarEntry[]>(() => {
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

/** 卡内最多平铺 8 条, 超出的用底注如实交代条数。 */
const calendarEntries = computed(() => calendarEntriesAll.value.slice(0, 8))
const calendarOverflow = computed(() => Math.max(0, calendarEntriesAll.value.length - 8))

// ─────────────────────────── ⑤ 补订建议(只读, 减方向) ───────────────────────────

const trims = computed<TrimSuggestion[]>(() => list(state.value.trim_suggestions))

// ─────────────────────────── ⑥ 最近动作 ───────────────────────────

const recentLogs = computed(() => list(state.value.logs).slice(-8).reverse())

// ─────────────────────────── ⑦ 告警条 ───────────────────────────

/** 运行时自己报的"宿主存储不可用"(只读不落盘), 从 last_message/最近日志里如实转述。 */
const storageWarning = computed(() => {
  if (!stateReady.value) return ''
  const haystack = [text(state.value.last_message, ''), ...list(state.value.logs).slice(-5).map((entry) => text(entry.message, ''))].join('\n')
  return haystack.includes('存储不可用')
    ? '运行时报告「宿主存储不可用」: 本轮只读、不落盘, 设置改动不会保存。先确认宿主存储可用再操作。'
    : ''
})

const probeProblem = computed(() => {
  const embyStatus = debug.value.emby_episodes?.status
  if (probeFailed(embyStatus)) {
    return `Emby 覆盖结构未识别(status=${text(embyStatus)}, http=${num(debug.value.emby_episodes?.http_status, 0)}): 该轮涉及 Emby 覆盖判定的条目零写入。点「探测诊断」重跑参数矩阵, 展开诊断区看原文样本。`
  }
  const calendarStatus = debug.value.air_calendar?.status
  if (probeFailed(calendarStatus)) {
    return `追剧日历结构未识别(status=${text(calendarStatus)}): 日历与日报的「今日播出」段会缺内容, 对齐不受影响。点「探测诊断」看原文样本。`
  }
  // TMDB 目标取不到不是"结构未识别"级故障(判定降级为仅 Emby 缺口), 但必须让用户看得见。
  const tmdbStatus = debug.value.tmdb_target?.status
  if (tmdbStatus === 'http_error' || tmdbStatus === 'transport_error' || tmdbStatus === 'unparsed') {
    return `TMDB 该季集数取不到(status=${text(tmdbStatus)}, http=${num(debug.value.tmdb_target?.http_status, 0)}): 结果表里目标显示「未知」, 补订按 Emby 缺口判定(不会拿订阅集数顶替)。点「探测诊断」看原文样本。`
  }
  return ''
})

const instanceProblem = computed(() => {
  if (instances.value.length > 0) return ''
  const proxy = num(settings.value.emby_proxy_id, -1)
  const target = proxy >= 1 ? `设置指向实例 #${proxy}, 但` : ''
  return `${target}还没有读到 Emby 实例列表(最近一次解析未成功)。下一步: 点「探测诊断」——它会调 emby/instances 并把结果存进状态文档, 下拉框随即有值。`
})

// ─────────────────────────── ⑧ 动作(生命周期: 进行中副文案 → 完成结果条) ───────────────────────────

const busyLabel = computed(() => {
  switch (busy.value) {
    case 'refresh':
      return '正在刷新(重读订阅池 1 页 + 追剧日历)…'
    case 'align-now':
      return '对齐中 · ≤1 页订阅池 · ≤5 次 PATCH · ≤3 次 Emby 探测 · 6 秒预算…'
    case 'probe-dump':
      return '正在探测诊断(emby/instances + 未知端点的参数矩阵)…'
    case 'settings-update':
      return '正在保存设置…'
    default:
      return ''
  }
})

/** 「立即对齐」的完成结果条: 内容全部来自真实 invokeAction 返回, 下一次动作清掉。 */
const alignResult = ref<{ ok: boolean; text: string } | null>(null)

/** 每次动作后都 await props.api.refresh() —— 状态重取失败也不能吞掉动作结果。 */
async function runAction(action: string, input: Record<string, unknown> = {}): Promise<NonNullable<RuntimeCallback['result']>> {
  busy.value = action
  if (action === 'align-now') alignResult.value = null
  let result: NonNullable<RuntimeCallback['result']> = {}
  try {
    const response = await props.api.invokeAction(action, input)
    result = response?.result || {}
    try {
      await props.api.refresh()
    } catch (refreshError: unknown) {
      message.warning(`状态重取失败: ${String((refreshError as { message?: string })?.message || refreshError)}; 界面可能还是旧值`)
    }
    if (result.status === 'failed') {
      const failureText = String(result.message || '操作失败')
      if (action === 'align-now') alignResult.value = { ok: false, text: failureText }
      message.error(failureText)
    } else if (action === 'align-now') {
      const note = result.budget_hit ? ' · 达时间预算提前结束' : ''
      const absent = num(result.absent, 0)
      const absentNote = absent > 0 ? ` · 未收录 ${absent} 条` : ''
      const reused = num(result.reused, 0)
      const reusedNote = reused > 0 ? ` · 复用缓存 ${reused} 条` : ''
      const doneText = `完成: 补订 ${num(result.patched, 0)} 条 · 跳过 ${num(result.skipped, 0)} 条 · 失败 ${num(result.failed, 0)} 条${absentNote}${reusedNote}${note}`
      alignResult.value = { ok: true, text: doneText }
      message.success(`立即对齐${doneText}`)
    } else {
      message.success(String(result.message || '操作完成'))
    }
  } catch (error: unknown) {
    result = { status: 'failed', message: String((error as { message?: string })?.message || '操作失败') }
    if (action === 'align-now') alignResult.value = { ok: false, text: String(result.message) }
    message.error(String(result.message))
  } finally {
    busy.value = ''
  }
  if (!stateReady.value) await loadState()
  return result
}

// ─────────────────────────── ⑨ 探测诊断折叠条(默认折叠, 出问题自动展开) ───────────────────────────

const probeOpen = ref(false)

watch(
  probeProblem,
  (problem) => {
    if (problem) probeOpen.value = true
  },
  { immediate: true },
)

/** 页头「探测诊断」按钮: 跑诊断动作并展开折叠条看结果。 */
async function runProbe() {
  probeOpen.value = true
  await runAction('probe-dump')
}

// ─────────────────────────── ⑩ 设置抽屉 ───────────────────────────

interface SettingsForm {
  enabled: boolean
  auto_bump: boolean
  dry_run: boolean
  write_episode_strings: boolean
  emby_proxy_id: number
  max_patch_per_run: number
  max_raise_per_run: number
  catch_up_days: number
  emby_probe_budget: number
  report_enabled: boolean
  report_hour: number
  tz_offset_minutes: number
}

const defaults: SettingsForm = {
  enabled: true,
  auto_bump: true,
  dry_run: false,
  write_episode_strings: false,
  emby_proxy_id: -1,
  max_patch_per_run: 5,
  max_raise_per_run: 20,
  catch_up_days: 7,
  emby_probe_budget: 120,
  report_enabled: false,
  report_hour: 9,
  tz_offset_minutes: 480,
}

const form = reactive<SettingsForm>({ ...defaults })
const baseline = ref<SettingsForm>({ ...defaults })

function readForm(source: AppState): SettingsForm {
  const incoming = source.settings || {}
  const report = incoming.report || {}
  return {
    enabled: incoming.enabled !== false,
    // 缺字段的旧文档 = true(与后端 serde 默认一致): 不能用 === true, 否则老文档会被显示成"已关闭"
    auto_bump: incoming.auto_bump !== false,
    dry_run: incoming.dry_run === true,
    write_episode_strings: incoming.write_episode_strings === true,
    emby_proxy_id: num(incoming.emby_proxy_id, defaults.emby_proxy_id),
    max_patch_per_run: num(incoming.max_patch_per_run, defaults.max_patch_per_run),
    max_raise_per_run: num(incoming.max_raise_per_run, defaults.max_raise_per_run),
    catch_up_days: num(incoming.catch_up_days, defaults.catch_up_days),
    emby_probe_budget: num(incoming.emby_probe_budget, defaults.emby_probe_budget),
    report_enabled: report.enabled === true,
    report_hour: num(report.hour, defaults.report_hour),
    tz_offset_minutes: num(report.tz_offset_minutes, defaults.tz_offset_minutes),
  }
}

function syncForm() {
  const next = readForm(state.value)
  Object.assign(form, next)
  baseline.value = next
}

// 抽屉关着的时候跟随宿主状态(界面显示后端的真实配置); 抽屉打开时不覆盖用户正在做的编辑。
watch(
  () => state.value.settings,
  () => {
    if (!settingsOpen.value) syncForm()
  },
  { immediate: true, deep: true },
)
watch(settingsOpen, (open) => {
  if (open) syncForm()
})

const instanceOptions = computed(() => {
  const options: Array<{ label: string; value: number; disabled?: boolean }> = [
    { label: '跟随宿主默认实例 (-1)', value: -1 },
    { label: '旧版单实例: 调用时不带 proxy_id (0)', value: 0 },
  ]
  for (const instance of instances.value) {
    const id = num(instance.id, 0)
    const parts = [`${text(instance.name, `实例 #${id}`)} #${id}`]
    if (instance.is_default === true) parts.push('宿主默认')
    if (instance.key_ready === false) parts.push('未配置密钥')
    options.push({ label: parts.join(' · '), value: id, disabled: instance.key_ready === false })
  }
  if (instances.value.length === 0) {
    options.push({ label: '还没有读到实例列表: 先点「探测诊断」', value: -2, disabled: true })
  }
  return options
})

function buildPayload(): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  const before = baseline.value
  if (form.enabled !== before.enabled) payload.enabled = form.enabled
  if (form.auto_bump !== before.auto_bump) payload.auto_bump = form.auto_bump
  if (form.dry_run !== before.dry_run) payload.dry_run = form.dry_run
  if (form.write_episode_strings !== before.write_episode_strings) payload.write_episode_strings = form.write_episode_strings
  if (form.emby_proxy_id !== before.emby_proxy_id) payload.emby_proxy_id = form.emby_proxy_id
  if (form.max_patch_per_run !== before.max_patch_per_run) payload.max_patch_per_run = form.max_patch_per_run
  if (form.max_raise_per_run !== before.max_raise_per_run) payload.max_raise_per_run = form.max_raise_per_run
  if (form.catch_up_days !== before.catch_up_days) payload.catch_up_days = form.catch_up_days
  if (form.emby_probe_budget !== before.emby_probe_budget) payload.emby_probe_budget = form.emby_probe_budget
  const report: Record<string, unknown> = {}
  if (form.report_enabled !== before.report_enabled) report.enabled = form.report_enabled
  if (form.report_hour !== before.report_hour) report.hour = form.report_hour
  if (form.tz_offset_minutes !== before.tz_offset_minutes) report.tz_offset_minutes = form.tz_offset_minutes
  if (Object.keys(report).length > 0) payload.report = report
  return payload
}

const changedKeys = computed(() => {
  const payload = buildPayload()
  const report = (payload.report || {}) as Record<string, unknown>
  return [...Object.keys(payload).filter((key) => key !== 'report'), ...Object.keys(report).map((key) => `report.${key}`)]
})

/** 只发被改动的键: 后端按白名单逐键合并, 没提交的键保持原值。 */
async function saveSettings() {
  const payload = buildPayload()
  if (Object.keys(payload).length === 0) {
    message.info('没有改动')
    return
  }
  const result = await runAction('settings-update', payload)
  if (result.status !== 'failed') settingsOpen.value = false
}

// ─────────────────────────── ⑪ 诊断文本(折叠条展开内容) ───────────────────────────

const attempts = computed(() => list(debug.value.attempts).slice(-20).reverse())
const lastErrors = computed(() => list(debug.value.last_errors).slice(-10).reverse())

const diagnosticsText = computed(() => {
  const lines: string[] = []
  lines.push(`# 追剧管家诊断 生成于 ${new Date().toISOString()}`)
  lines.push(`# 状态: ${text(state.value.status, '—')} · revision ${num(state.value.revision, 0)} · schema ${num(state.value.schema_version, 0)}`)
  lines.push(`# 最近消息: ${text(state.value.last_message, '—')}`)
  lines.push(`# 探测更新于: ${formatAt(debug.value.updated_at)}`)
  const probes: Array<[string, typeof debug.value.emby_episodes]> = [
    ['emby/episodes', debug.value.emby_episodes],
    ['subscribe/air-calendar', debug.value.air_calendar],
    ['subscribe/pool/intents', debug.value.pool_intents],
    ['tmdb/tv (该季集数)', debug.value.tmdb_target],
  ]
  for (const [name, snapshot] of probes) {
    const probe = snapshot || {}
    lines.push('')
    lines.push(`## ${name}`)
    lines.push(`status: ${text(probe.status, 'never')} · http_status: ${num(probe.http_status, 0)} · at: ${formatAt(probe.at)}`)
    lines.push(`shape: ${text(probe.shape, '(未识别)')}`)
    lines.push(`params_tried: ${list(probe.params_tried).join(' | ') || '(无)'}`)
    lines.push(`sample(≤2KB):`)
    lines.push(text(probe.sample, '(空)'))
  }
  lines.push('')
  lines.push(`## 探测尝试 (最近 ${attempts.value.length} 次)`)
  for (const attempt of attempts.value) {
    lines.push(`- ${formatAt(attempt.at)} ${text(attempt.endpoint)} ${text(attempt.params)} → ${num(attempt.http_status, 0)} ${text(attempt.shape)}`)
  }
  lines.push('')
  lines.push(`## last_errors (最近 ${lastErrors.value.length} 条)`)
  for (const error of lastErrors.value) {
    lines.push(`- ${formatAt(error.at)} [${text(error.step)}] ${text(error.message)}`)
  }
  lines.push('')
  lines.push('## 日志 (最近 50 条)')
  for (const entry of list(state.value.logs).slice(-50)) {
    lines.push(`- ${formatAt(entry.at)} [${text(entry.level)}] ${text(entry.message)}`)
  }
  return lines.join('\n')
})

const copied = ref(false)

async function copyDiagnostics() {
  try {
    await navigator.clipboard.writeText(diagnosticsText.value)
    copied.value = true
    message.success('诊断信息已复制')
    setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    message.warning('浏览器不允许复制, 请在文本域里手动选中')
  }
}
</script>

<template>
  <main class="dian-plugin-page chase-page">
    <!-- ① 页头: 图标瓦片 + 标题 / 状态胶囊 + 日报胶囊 + 动作组 + 设置 -->
    <header class="page-header">
      <div class="page-brand">
        <span class="page-brand-icon"><tv-icon /></span>
        <div class="page-brand-text">
          <h2>追剧管家</h2>
          <p>每小时对齐订阅池 · Emby 覆盖 / TMDB 目标 · 只增不减</p>
        </div>
      </div>
      <div class="page-actions">
        <span class="capsule" :class="`capsule-${healthCapsule.tone}`">
          <component :is="healthCapsule.icon" class="capsule-icon" />
          {{ healthCapsule.text }}
        </span>
        <span class="capsule" :class="`capsule-${dailyCapsule.tone}`" :title="reportStatus.note">
          <send-icon class="capsule-icon" />
          {{ dailyCapsule.text }}
        </span>
        <span v-if="overviewStatus.dryRun" class="capsule capsule-warning">dry-run · 只判定不写入</span>
        <n-button secondary :loading="busy === 'refresh'" :disabled="!!busy" @click="runAction('refresh')">
          <template #icon><refresh-cw-icon /></template>
          刷新
        </n-button>
        <n-button secondary :loading="busy === 'probe-dump'" :disabled="!!busy" @click="runProbe">
          <template #icon><stethoscope-icon /></template>
          探测诊断
        </n-button>
        <n-button
          class="align-primary"
          type="primary"
          :loading="busy === 'align-now'"
          :disabled="!!busy"
          @click="runAction('align-now')"
        >
          <template #icon><zap-icon /></template>
          立即对齐
        </n-button>
        <n-button quaternary circle aria-label="设置" @click="settingsOpen = true">
          <!-- 别名 SettingsIcon: 模板里 `<settings />` 会被解析成同名的 `settings` 计算属性 -->
          <template #icon><settings-icon /></template>
        </n-button>
      </div>
    </header>

    <!-- 动作生命周期(规范 §2.5): 进行中副文案 / 完成结果条(来自真实 invokeAction 返回) -->
    <p v-if="busyLabel" class="action-progress"><span class="action-spinner" />{{ busyLabel }}</p>
    <div v-else-if="alignResult" class="action-result" :class="alignResult.ok ? 'action-result-ok' : 'action-result-err'">
      <component :is="alignResult.ok ? CircleCheckBigIcon : CircleAlertIcon" class="capsule-icon" />
      {{ alignResult.text }}
    </div>

    <!-- 状态加载不可用: 一句话原因 + 下一步, 不显示任何假数据 -->
    <section v-if="!stateReady" class="card">
      <n-alert type="error" :show-icon="true" title="状态不可用">
        宿主还没有返回本插件的状态文档{{ stateLoadError ? `(${stateLoadError})` : '' }}。
        常见原因: 插件 runtime 刚重启或更新中, `runtime/state` 暂时失败; 或是存储后端不可读(运行时按「只读不落盘」处理)。
      </n-alert>
      <p class="next-line">
        下一步: 点「重新读取状态」; 仍然失败就点「探测诊断」拉一次诊断(它会重新读状态), 或把宿主机上插件的运行日志贴给作者。
      </p>
      <div class="inline-actions">
        <n-button size="small" type="primary" :loading="loadingState" @click="loadState">
          <template #icon><refresh-cw-icon /></template>
          重新读取状态
        </n-button>
        <n-button size="small" secondary :loading="busy === 'probe-dump'" :disabled="!!busy" @click="runProbe">
          <template #icon><stethoscope-icon /></template>
          探测诊断
        </n-button>
      </div>
    </section>

    <template v-else>
      <!-- ② 指标瓦片 ×8(数据: stats / align 汇总; 本轮复用 = items 里 reason 含「复用」的行数) -->
      <section class="tiles">
        <stat-tile label="订阅池" :value="String(num(stats.tv_intents, 0))" :icon="LayersIcon" />
        <stat-tile label="已判定" :value="String(num(stats.matched, 0))" :icon="ListChecksIcon" />
        <stat-tile label="补订" :value="String(alignSummary.patched)" :icon="CirclePlusIcon" tone="primary" />
        <stat-tile label="跳过" :value="String(alignSummary.skipped)" :icon="SkipForwardIcon" />
        <stat-tile label="失败" :value="String(alignSummary.failed)" :icon="CircleXIcon" :tone="alignSummary.failed > 0 ? 'error' : 'default'" />
        <stat-tile label="未收录" :value="String(alignSummary.absent)" :icon="CloudOffIcon" :tone="alignSummary.absent > 0 ? 'warning' : 'default'" />
        <stat-tile label="待探测" :value="String(alignSummary.pendingProbe)" :icon="RadarIcon" :tone="alignSummary.pendingProbe > 0 ? 'primary' : 'default'" />
        <stat-tile label="本轮复用" :value="String(reusedCount)" :icon="RecycleIcon" tone="success" />
      </section>

      <!-- ⑦ 告警条: 实例 / 存储 / 探测结构(全部如实转述运行时) -->
      <n-alert v-if="instanceProblem" type="warning" :show-icon="true" class="chase-alert">
        <template #header>Emby 实例不可用</template>
        {{ instanceProblem }}
      </n-alert>
      <n-alert v-if="storageWarning" type="error" :show-icon="true" class="chase-alert">{{ storageWarning }}</n-alert>
      <n-alert v-if="probeProblem" type="warning" :show-icon="true" class="chase-alert">{{ probeProblem }}</n-alert>

      <!-- ③ 对齐结果卡(筛选 pill 为纯前端过滤, 不改数据) -->
      <section class="card">
        <div class="card-head">
          <div class="card-head-text">
            <h3>对齐结果</h3>
            <p class="card-sub">{{ alignSub }}</p>
          </div>
          <div v-if="alignItems.length > 0" class="filter-pills">
            <button
              v-for="option in filterOptions"
              :key="option.key"
              class="filter-pill"
              :class="{ active: filter === option.key }"
              @click="filter = option.key"
            >
              {{ option.label }} {{ option.count }}
            </button>
          </div>
        </div>

        <n-alert v-if="alignSummary.pendingProbe > 0" type="warning" :show-icon="true" class="chase-alert">
          有 {{ alignSummary.pendingProbe }} 条这轮没探到(探测预算/时间用尽), 下一轮会优先补探; 不是"没有缺口"。
        </n-alert>

        <n-empty v-if="alignItems.length === 0" :description="alignEmptyReason" class="chase-empty">
          <template #extra>
            <n-button size="small" type="primary" :loading="busy === 'align-now'" :disabled="!!busy" @click="runAction('align-now')">
              立即对齐一次
            </n-button>
          </template>
        </n-empty>

        <p v-else-if="filteredRows.length === 0" class="muted-line">该筛选下没有条目。</p>

        <div v-else class="table-wrap">
          <table class="align-table">
            <thead>
              <tr>
                <th>剧集</th>
                <th class="num">订阅</th>
                <th class="num">Emby 已有</th>
                <th class="num">TMDB 目标</th>
                <th class="num">缺口</th>
                <th class="num">动作</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in filteredRows" :key="`${num(row.item.intent_id, 0)}-${num(row.item.season, 0)}`">
                <td data-label="剧集">
                  <div class="show-title">{{ text(row.item.title, `intent #${num(row.item.intent_id, 0)}`) }}</div>
                  <div class="show-sub">{{ seasonPad(row.item.season) }} · {{ coverageSub(row.item) }}</div>
                </td>
                <td data-label="订阅" class="num">{{ num(row.item.total_known, 0) }}</td>
                <td data-label="Emby 已有" class="num">
                  <span v-if="num(row.item.emby_have_max, -1) >= 0">{{ num(row.item.emby_have_max, 0) }}</span>
                  <span v-else class="muted">—</span>
                </td>
                <td data-label="TMDB 目标" class="num">
                  <span v-if="targetKnown(row.item)">{{ num(row.item.target_upper, 0) }}</span>
                  <span v-else class="muted">—</span>
                </td>
                <td data-label="缺口" class="num">
                  <span :class="row.gap.cls">{{ row.gap.label }}</span>
                </td>
                <td data-label="动作" class="num">
                  <span :class="row.action.cls">{{ row.action.label }}</span>
                </td>
                <td data-label="原因">
                  <div class="reason-cell">
                    <div class="reason-badges">
                      <span class="badge" :class="badgeClass(row.badge.kind)">{{ row.badge.label }}</span>
                      <span v-if="row.reused" class="badge badge-third">复用缓存</span>
                      <span v-if="row.targetUnknown && row.badge.kind !== 'target-unknown'" class="badge badge-info">目标未知</span>
                    </div>
                    <div class="reason-text">{{ row.reasonText || row.detail }}</div>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ④ 双栏: 补订建议(只读) + 追剧日历 -->
      <div class="duo">
        <section class="card">
          <div class="card-head">
            <div class="card-head-text">
              <h3>补订建议</h3>
            </div>
            <span class="capsule capsule-warning">只读 · 从不自动执行</span>
          </div>
          <n-empty v-if="trims.length === 0" description="没有需要提醒的条目: 订阅集数都不超过该季 TMDB 的集数。" />
          <template v-else>
            <ul class="trim-list">
              <li v-for="trim in trims" :key="`${num(trim.intent_id, 0)}-${num(trim.season, 0)}`">
                <div class="trim-main">
                  <div class="show-title">{{ text(trim.title, `intent #${num(trim.intent_id, 0)}`) }} {{ seasonPad(trim.season) }}</div>
                  <div class="show-sub">
                    订阅 {{ num(trim.total_known, 0) }} 集<template v-if="num(trim.target_upper, 0) > 0">, 高于 TMDB 官方目标</template>
                  </div>
                  <!-- reason 为后端原文, 原样渲染不改写 -->
                  <div class="reason-text">{{ text(trim.reason, '') }}</div>
                  <div class="trim-ids">
                    intent_id {{ num(trim.intent_id, 0) }} · tmdb_id {{ num(trim.tmdb_id, 0) }} · {{ seasonLabel(trim.season) }}
                  </div>
                </div>
                <div class="trim-delta">{{ num(trim.total_known, 0) }} → {{ num(trim.target_upper, 0) }}</div>
              </li>
            </ul>
            <p class="card-foot">共 {{ trims.length }} 条建议 · 仅提示, 需拿 intent_id 到订阅池手动调整</p>
          </template>
        </section>

        <section class="card">
          <div class="card-head">
            <div class="card-head-text">
              <h3>追剧日历</h3>
            </div>
            <span class="card-head-meta">抓取于 {{ calendarFetchedAt }} · 窗口 {{ calendarDays.length }} 天</span>
          </div>

          <n-alert v-if="calendarState === 'unrecognized'" type="warning" :show-icon="true" class="chase-alert">
            日历结构未识别, 见诊断 —— air-calendar 的字段指纹不在已知形状里, 日报会缺「今日播出」段; 对齐不受影响。点「探测诊断」
            看参数矩阵与原文样本。
          </n-alert>
          <n-empty v-else-if="calendarState === 'never'" description="还没有抓过追剧日历: 点「刷新」拉一次, 或等下一个整点的对齐任务。">
            <template #extra>
              <n-button size="small" secondary :loading="busy === 'refresh'" :disabled="!!busy" @click="runAction('refresh')">刷新一次</n-button>
            </template>
          </n-empty>
          <n-empty v-else-if="calendarState === 'empty'" description="窗口里没有播出安排(订阅池里可能没有在播剧集)。" />

          <template v-else>
            <div class="day-chips">
              <div v-for="chip in calendarChips" :key="chip.date" class="day-chip" :class="{ today: chip.isToday }">
                <span class="day-chip-label">{{ chip.isToday ? '今天' : chip.weekday }}</span>
                <span class="day-chip-date">{{ chip.short }}</span>
              </div>
            </div>
            <ul v-if="calendarEntries.length > 0" class="air-list">
              <li v-for="entry in calendarEntries" :key="entry.key">
                <span class="air-dot" :class="{ today: entry.isToday }" />
                <span class="air-title">{{ entry.dayLabel }} · {{ entry.title }}<template v-if="entry.episode"> {{ entry.episode }}</template></span>
                <span class="air-time">{{ entry.time }}</span>
              </li>
            </ul>
            <p v-else class="muted-line">窗口里的这些天都没有播出安排。</p>
            <p v-if="calendarOverflow > 0" class="card-foot">另有 {{ calendarOverflow }} 条播出安排未列出 · 窗口 {{ calendarDays.length }} 天</p>
          </template>
        </section>
      </div>

      <!-- ⑤ 探测诊断折叠条: 默认折叠, 排障时展开; 展开内容 = 现有 ProbePanel, 功能不动 -->
      <section class="card probe-bar">
        <button class="probe-bar-head" type="button" :aria-expanded="probeOpen" @click="probeOpen = !probeOpen">
          <stethoscope-icon class="probe-bar-icon" />
          <span class="probe-bar-title">探测诊断</span>
          <span class="probe-bar-sub">端点参数矩阵 · 形状指纹 · HTTP 状态 · 2KB 原文样本 —— 默认折叠, 排障时展开</span>
          <chevron-down-icon class="probe-bar-chevron" :class="{ open: probeOpen }" />
        </button>
        <div v-show="probeOpen" class="probe-bar-body">
          <div class="chase-probes">
            <probe-panel
              endpoint="emby/instances"
              :probe="debug.emby_instances"
              hint="Emby 实例列表现场; 「200 但解析为空」时看原文分辨是字段没认出还是宿主没配实例。"
            />
            <probe-panel
              endpoint="emby/episodes"
              :probe="debug.emby_episodes"
              hint="Emby 已有集数的解析现场; 结构未识别时该轮零写入(不猜集号)。"
            />
            <probe-panel
              endpoint="subscribe/air-calendar"
              :probe="debug.air_calendar"
              hint="追剧日历的解析现场; 失败只影响日历与日报的「今日播出」段。"
            />
            <probe-panel
              endpoint="subscribe/pool/intents"
              :probe="debug.pool_intents"
              hint="订阅池列表的解析现场(对规格的显式扩展槽: 订阅池解析失败时原文无处安放, 所以与上面两个同形)。"
            />
            <probe-panel
              endpoint="tmdb/tv (该季集数)"
              :probe="debug.tmdb_target"
              hint="该季 TMDB 集数的取数现场(带 raw_episode_counts=true); 取不到时对齐判定只靠 Emby 缺口, 结果表会显示「未知」。"
            />
          </div>

          <div class="diag-block">
            <div class="diag-label">last_errors (最近 {{ lastErrors.length }} 条)</div>
            <ul v-if="lastErrors.length > 0" class="diag-list">
              <li v-for="(error, index) in lastErrors" :key="index">
                <span class="muted">{{ formatAt(error.at) }}</span>
                <span class="mono">[{{ text(error.step) }}]</span>
                {{ text(error.message) }}
              </li>
            </ul>
            <p v-else class="muted-line">没有错误记录。</p>
          </div>

          <div class="diag-block">
            <div class="diag-label">host.call 尝试 (最近 {{ attempts.length }} 次)</div>
            <ul v-if="attempts.length > 0" class="diag-list">
              <li v-for="(attempt, index) in attempts" :key="index">
                <span class="muted">{{ formatAt(attempt.at) }}</span>
                <span class="mono">{{ text(attempt.endpoint) }}</span>
                {{ text(attempt.params) }} →
                <span class="muted">http {{ num(attempt.http_status, 0) }} · {{ text(attempt.shape) }}</span>
              </li>
            </ul>
            <p v-else class="muted-line">还没有 host.call 记录。</p>
          </div>

          <div class="diag-block">
            <div class="diag-head">
              <n-text depth="3">完整诊断文本(整段复制给作者), 内容与上面一致并附带最近日志。</n-text>
              <n-button size="tiny" secondary @click="copyDiagnostics">
                <template #icon><copy-icon /></template>
                {{ copied ? '已复制' : '复制' }}
              </n-button>
            </div>
            <n-input :value="diagnosticsText" type="textarea" readonly :autosize="{ minRows: 8, maxRows: 24 }" />
          </div>
        </div>
      </section>

      <!-- ⑥ 最近动作: 等宽时间戳 + 后端日志原文 -->
      <section class="card">
        <div class="card-head">
          <div class="card-head-text">
            <h3>最近动作</h3>
          </div>
          <span class="card-head-meta">{{ text(props.pluginId, 'chase.rs') }} · 状态文档 revision {{ overviewStatus.revision }}</span>
        </div>
        <ul v-if="recentLogs.length > 0" class="log-list">
          <li v-for="(entry, index) in recentLogs" :key="index">
            <span class="log-time">{{ timeLongAt(entry.at) }}</span>
            <span class="log-msg">{{ text(entry.message, '') }}</span>
          </li>
        </ul>
        <p v-else class="muted-line">还没有运行日志。</p>
      </section>

      <!-- 页脚: 如实说明数据来源与断点(本前端不轮询, 状态由宿主注入) -->
      <footer class="page-foot">状态文档由宿主注入 · 页面宽度跟随宿主可用宽度, 双栏在 900–1000px 回落单栏 · 表格在 ≤640px 退化为卡片</footer>
    </template>

    <!-- ⑩ 设置抽屉(功能不动, naive-ui 交宿主 NConfigProvider 上主题) -->
    <n-drawer v-model:show="settingsOpen" :width="420" placement="right">
      <n-drawer-content title="追剧管家设置" closable>
        <n-form label-placement="left" :label-width="126" size="small">
          <n-form-item label="启用插件">
            <n-switch v-model:value="form.enabled" />
            <n-text depth="3" class="chase-form-note">关掉后整点任务与「立即对齐」都不写入。</n-text>
          </n-form-item>
          <n-form-item label="自动补订">
            <n-switch v-model:value="form.auto_bump" />
            <n-text depth="3" class="chase-form-note">
              关掉后只判定不补订(结果表标「本可补订」); 老文档缺这个键时按开着处理。
            </n-text>
          </n-form-item>
          <n-form-item label="Emby 实例">
            <n-select v-model:value="form.emby_proxy_id" :options="instanceOptions" />
          </n-form-item>
          <n-form-item label="单轮最多补订">
            <n-input-number v-model:value="form.max_patch_per_run" :min="1" :max="20" />
            <n-text depth="3" class="chase-form-note">条/轮(后端硬上限 20)</n-text>
          </n-form-item>
          <n-form-item label="单条最大抬升">
            <n-input-number v-model:value="form.max_raise_per_run" :min="1" :max="100" />
            <n-text depth="3" class="chase-form-note">集/条(超出视为元数据异常, 跳过)</n-text>
          </n-form-item>
          <n-form-item label="只判定不写入">
            <n-switch v-model:value="form.dry_run" />
            <n-text depth="3" class="chase-form-note">dry-run: 结果表会标「待补订」。</n-text>
          </n-form-item>
          <n-form-item label="写回集数字符串">
            <n-switch v-model:value="form.write_episode_strings" />
            <n-text depth="3" class="chase-form-note">仅在原串能严格解析且逐字节往返一致时才追加。</n-text>
          </n-form-item>
          <n-divider>TG 日报</n-divider>
          <n-form-item label="发送 TG 日报">
            <n-switch v-model:value="form.report_enabled" />
          </n-form-item>
          <n-form-item label="发送小时(本地)">
            <n-input-number v-model:value="form.report_hour" :min="0" :max="23" />
            <n-text depth="3" class="chase-form-note">到点后当天首次运行发送, 每天最多一条。</n-text>
          </n-form-item>
          <n-form-item label="时区偏移(分钟)">
            <n-input-number v-model:value="form.tz_offset_minutes" :min="-840" :max="840" :step="30" />
            <n-text depth="3" class="chase-form-note">+08:00 = 480</n-text>
          </n-form-item>
          <n-divider>其它</n-divider>
          <n-form-item label="日历窗口(天)">
            <n-input-number v-model:value="form.catch_up_days" :min="1" :max="30" />
          </n-form-item>
          <n-form-item label="Emby 探测预算">
            <n-input-number v-model:value="form.emby_probe_budget" :min="1" :max="500" />
            <n-text depth="3" class="chase-form-note">次/轮(整点任务)</n-text>
          </n-form-item>
        </n-form>
        <n-alert v-if="changedKeys.length > 0" type="info" :show-icon="false" class="chase-alert">
          <template #header>将提交改动</template>
          <span class="mono">{{ changedKeys.join(', ') }}</span>
        </n-alert>
        <n-alert v-else type="default" :show-icon="false" class="chase-alert">
          没有改动: 保存只提交被改动的键, 其余保持原值。
        </n-alert>
        <template #footer>
          <div class="chase-drawer-footer">
            <n-text depth="3">保存走 `settings-update` 动作, 只发改动过的键。</n-text>
            <div class="chase-drawer-buttons">
              <n-button size="small" quaternary @click="settingsOpen = false">取消</n-button>
              <n-button
                size="small"
                type="primary"
                :disabled="changedKeys.length === 0"
                :loading="busy === 'settings-update'"
                @click="saveSettings"
              >
                <template #icon><circle-check-big-icon /></template>
                保存
              </n-button>
            </div>
          </div>
        </template>
      </n-drawer-content>
    </n-drawer>
  </main>
</template>

<style scoped>
/* ---- 根容器: width/min-width 由宿主 iframe 决定, 这里只保证不撑破 ---- */
.chase-page {
  /* 第三态 · 非成败(规范 §1): 宿主无此语义, 插件根容器内派生, 深浅主题同值 */
  --ui-third: #7c5cfc;
  display: grid;
  gap: var(--dian-space-4, 16px);
  padding: var(--dian-space-1, 4px);
  width: 100%;
  max-width: 100%;
  min-width: 0;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
}

/* ---- ① 页头(规范 §2.4) ---- */

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--dian-space-3, 12px) var(--dian-space-4, 16px);
  flex-wrap: wrap;
  padding: var(--dian-space-2, 8px) 0 var(--dian-space-1, 4px);
}

.page-brand {
  display: flex;
  align-items: center;
  gap: var(--dian-space-3, 12px);
  min-width: 0;
}

.page-brand-icon {
  width: 44px;
  height: 44px;
  border-radius: var(--dian-radius-md, 12px);
  display: grid;
  place-items: center;
  flex: none;
  color: var(--dian-primary, #2080f0);
  background: color-mix(in srgb, var(--dian-primary, #2080f0) 12%, transparent);
}

.page-brand-icon svg {
  width: 22px;
  height: 22px;
}

.page-brand-text h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.page-brand-text p {
  margin: 2px 0 0;
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
  font-size: 13px;
}

.page-actions {
  display: flex;
  align-items: center;
  gap: var(--dian-space-2, 8px);
  flex-wrap: wrap;
}

/* ---- 胶囊(规范 §2.1: 文字色 = 语义色, 底色 = 语义色 14% 透明; 深浅主题同一透明度) ---- */

.capsule {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--dian-radius-pill, 999px);
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.45;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.capsule-icon {
  width: 12px;
  height: 12px;
  flex: none;
}

.capsule-success {
  color: var(--dian-success, #18a058);
  background: color-mix(in srgb, var(--dian-success, #18a058) 14%, transparent);
}

.capsule-warning {
  color: var(--dian-warning, #f0a020);
  background: color-mix(in srgb, var(--dian-warning, #f0a020) 16%, transparent);
}

.capsule-error {
  color: var(--dian-error, #d03050);
  background: color-mix(in srgb, var(--dian-error, #d03050) 14%, transparent);
}

.capsule-neutral {
  color: var(--dian-text-secondary, #8a919c);
  background: color-mix(in srgb, var(--dian-text-secondary, #8a919c) 14%, transparent);
}

/* ---- 动作生命周期(规范 §2.5) ---- */

.action-progress {
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--dian-space-2, 8px);
  color: var(--dian-primary, #2080f0);
  font-size: 13px;
}

.action-spinner {
  width: 14px;
  height: 14px;
  flex: none;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--dian-primary, #2080f0) 25%, transparent);
  border-top-color: var(--dian-primary, #2080f0);
  animation: chase-spin 0.8s linear infinite;
}

@keyframes chase-spin {
  to {
    transform: rotate(360deg);
  }
}

.action-result {
  display: flex;
  align-items: center;
  gap: var(--dian-space-2, 8px);
  border-radius: var(--dian-radius-md, 12px);
  padding: 8px 12px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.action-result-ok {
  color: var(--dian-success, #18a058);
  background: color-mix(in srgb, var(--dian-success, #18a058) 12%, transparent);
}

.action-result-err {
  color: var(--dian-error, #d03050);
  background: color-mix(in srgb, var(--dian-error, #d03050) 12%, transparent);
}

/* ---- ② 指标瓦片行 ---- */

.tiles {
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  gap: var(--dian-space-3, 12px);
}

/* ---- 卡片区块(规范 §2.3) ---- */

.card {
  background: var(--dian-surface, #ffffff);
  border: 1px solid var(--dian-border, #e0e4ea);
  border-radius: var(--dian-radius-lg, 14px);
  padding: var(--dian-space-5, 20px) var(--dian-space-6, 24px);
  display: grid;
  gap: var(--dian-space-3, 12px);
  min-width: 0;
  align-content: start;
}

.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--dian-space-3, 12px);
  flex-wrap: wrap;
}

.card-head-text {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.card-head-text h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.card-sub {
  margin: 0;
  font-size: 13px;
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
}

.card-head-meta {
  font-size: 12px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  white-space: nowrap;
}

.card-foot {
  margin: 0;
  padding-top: var(--dian-space-2, 8px);
  border-top: 1px solid var(--dian-divider, #e0e4ea);
  font-size: 12px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
}

.chase-alert {
  border-radius: var(--dian-radius-md, 12px);
}

.chase-empty {
  padding: var(--dian-space-4, 16px) 0;
}

.muted-line {
  margin: 0;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  font-size: 13px;
}

.next-line {
  margin: 0;
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
  font-size: 13px;
}

.inline-actions {
  display: flex;
  gap: var(--dian-space-2, 8px);
  flex-wrap: wrap;
}

.mono {
  font-family: var(--dian-font-mono, monospace);
}

.muted {
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
}

/* ---- ③ 对齐结果卡: 筛选 pill(纯前端过滤) ---- */

.filter-pills {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border-radius: var(--dian-radius-pill, 999px);
  background: var(--dian-surface-soft, #f7faff);
  flex: none;
}

.filter-pill {
  border: none;
  background: transparent;
  border-radius: var(--dian-radius-pill, 999px);
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
  cursor: pointer;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.filter-pill:hover {
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
}

.filter-pill.active {
  color: var(--dian-primary, #2080f0);
  background: color-mix(in srgb, var(--dian-primary, #2080f0) 14%, transparent);
}

/* ---- ③ 对齐结果表(数字 tabular-nums; 长表格保留表头、局部纵向滚动) ---- */

.table-wrap {
  overflow: auto;
  max-height: 460px;
  min-width: 0;
}

.align-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 13px;
}

.align-table th {
  text-align: left;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  background: var(--dian-surface-soft, #f7faff);
  white-space: nowrap;
  position: sticky;
  top: 0;
  z-index: 1;
}

.align-table th:first-child {
  border-radius: var(--dian-radius-sm, 8px) 0 0 var(--dian-radius-sm, 8px);
}

.align-table th:last-child {
  border-radius: 0 var(--dian-radius-sm, 8px) var(--dian-radius-sm, 8px) 0;
}

.align-table td {
  padding: 12px;
  border-bottom: 1px solid var(--dian-divider, #e0e4ea);
  vertical-align: top;
}

.align-table tbody tr:last-child td {
  border-bottom: none;
}

.align-table .num {
  text-align: center;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.show-title {
  font-weight: 600;
}

.show-sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
}

.gap-num {
  color: var(--dian-primary, #2080f0);
  font-weight: 600;
}

.gap-probe {
  color: var(--dian-primary, #2080f0);
}

.action-link {
  color: var(--dian-primary, #2080f0);
  font-weight: 500;
}

.action-dry {
  color: var(--dian-warning, #f0a020);
  font-weight: 500;
}

/* 原因列: 徽章一行 + reason 原文灰字一行(原文不改写) */
.reason-cell {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.reason-badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.reason-text {
  font-size: 12px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  overflow-wrap: anywhere;
}

/* ---- 徽标(规范 §2.1): 胶囊, 12px/500, padding 3px 10px, 无边框 ---- */

.badge {
  display: inline-flex;
  align-items: center;
  border-radius: var(--dian-radius-pill, 999px);
  padding: 3px 10px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.badge-success {
  color: var(--dian-success, #18a058);
  background: color-mix(in srgb, var(--dian-success, #18a058) 14%, transparent);
}

.badge-info {
  color: var(--dian-info, #2080f0);
  background: color-mix(in srgb, var(--dian-info, #2080f0) 14%, transparent);
}

.badge-warning {
  color: var(--dian-warning, #f0a020);
  background: color-mix(in srgb, var(--dian-warning, #f0a020) 16%, transparent);
}

.badge-error {
  color: var(--dian-error, #d03050);
  background: color-mix(in srgb, var(--dian-error, #d03050) 14%, transparent);
}

.badge-neutral {
  color: var(--dian-text-secondary, #8a919c);
  background: color-mix(in srgb, var(--dian-text-secondary, #8a919c) 14%, transparent);
}

.badge-third {
  color: var(--ui-third, #7c5cfc);
  background: color-mix(in srgb, var(--ui-third, #7c5cfc) 14%, transparent);
}

/* ---- ④ 双栏(≥1000px 双栏; 900–1000px 回落单栏) ---- */

.duo {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--dian-space-4, 16px);
  align-items: start;
}

/* 补订建议: 琥珀大字「45 → 42」式 */
.trim-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
}

.trim-list li {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--dian-space-3, 12px);
  padding: 10px 0;
  border-bottom: 1px solid var(--dian-divider, #e0e4ea);
}

.trim-list li:first-child {
  padding-top: 0;
}

.trim-list li:last-child {
  border-bottom: none;
}

.trim-main {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.trim-delta {
  color: var(--dian-warning, #f0a020);
  font-size: 18px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.trim-ids {
  font-family: var(--dian-font-mono, monospace);
  font-size: 11px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
}

/* 追剧日历: 7 天 chip + 今天高亮主色 */
.day-chips {
  display: flex;
  gap: var(--dian-space-2, 8px);
  flex-wrap: wrap;
}

.day-chip {
  display: grid;
  justify-items: center;
  gap: 2px;
  min-width: 64px;
  padding: 8px 10px;
  border-radius: var(--dian-radius-md, 12px);
  border: 1px solid transparent;
  background: var(--dian-surface-soft, #f7faff);
}

.day-chip-label {
  font-size: 12px;
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
}

.day-chip-date {
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.day-chip.today {
  border-color: var(--dian-primary, #2080f0);
  background: color-mix(in srgb, var(--dian-primary, #2080f0) 8%, transparent);
}

.day-chip.today .day-chip-label,
.day-chip.today .day-chip-date {
  color: var(--dian-primary, #2080f0);
}

.air-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
}

.air-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--dian-divider, #e0e4ea);
  font-size: 13px;
}

.air-list li:last-child {
  border-bottom: none;
}

.air-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  flex: none;
}

.air-dot.today {
  background: var(--dian-primary, #2080f0);
}

.air-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.air-time {
  margin-left: auto;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  flex: none;
}

/* ---- ⑤ 探测诊断折叠条 ---- */

.probe-bar {
  padding: 0;
  gap: 0;
}

.probe-bar-head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 14px var(--dian-space-6, 24px);
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  color: inherit;
  font: inherit;
}

.probe-bar-icon {
  width: 18px;
  height: 18px;
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
  flex: none;
}

.probe-bar-title {
  font-weight: 600;
  font-size: 15px;
  flex: none;
}

.probe-bar-sub {
  font-size: 12px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  min-width: 0;
  flex: 1;
}

.probe-bar-chevron {
  width: 16px;
  height: 16px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  flex: none;
  transition: transform 0.2s ease;
}

.probe-bar-chevron.open {
  transform: rotate(180deg);
}

.probe-bar-body {
  display: grid;
  gap: var(--dian-space-3, 12px);
  margin: 0 var(--dian-space-6, 24px) var(--dian-space-4, 16px);
  padding-top: var(--dian-space-4, 16px);
  border-top: 1px solid var(--dian-divider, #e0e4ea);
}

.chase-probes {
  display: grid;
  gap: var(--dian-space-3, 12px);
}

.diag-block {
  display: grid;
  gap: var(--dian-space-1, 4px);
  padding-top: var(--dian-space-3, 12px);
  border-top: 1px solid var(--dian-divider, #e0e4ea);
}

.diag-label {
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  font-size: 12px;
}

.diag-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--dian-space-1, 4px);
  font-size: 13px;
}

.diag-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--dian-space-2, 8px);
  flex-wrap: wrap;
}

/* ---- ⑥ 最近动作(规范 §2.7 时间线: 等宽时间 + 事件, 行间 1px divider) ---- */

.log-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
}

.log-list li {
  display: flex;
  align-items: baseline;
  gap: var(--dian-space-3, 12px);
  padding: 8px 0;
  border-bottom: 1px solid var(--dian-divider, #e0e4ea);
  font-size: 13px;
}

.log-list li:last-child {
  border-bottom: none;
}

.log-time {
  font-family: var(--dian-font-mono, monospace);
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  flex: none;
}

.log-msg {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* ---- 页脚 ---- */

.page-foot {
  text-align: center;
  font-size: 12px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  padding: 0 0 var(--dian-space-2, 8px);
}

/* ---- ⑩ 设置抽屉 ---- */

.chase-form-note {
  margin-left: var(--dian-space-2, 8px);
  font-size: 12px;
}

.chase-drawer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--dian-space-3, 12px);
  flex-wrap: wrap;
}

.chase-drawer-buttons {
  display: flex;
  gap: var(--dian-space-2, 8px);
}

/* ---- 断点(规范 §3): 900–1000px 双栏回落单栏 ---- */

@media (max-width: 1000px) {
  .tiles {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .duo {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* ---- 移动档 ≤640px: 单栏堆叠, 瓦片 2 列, 表格退化为卡片, 主按钮第一优先可见 ---- */

@media (max-width: 640px) {
  .tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  /* 工具栏换行时主按钮(立即对齐)排最前 */
  .page-actions .align-primary {
    order: -1;
  }

  .card {
    padding: var(--dian-space-4, 16px);
  }

  .probe-bar-head {
    padding: 12px var(--dian-space-4, 16px);
  }

  .probe-bar-sub {
    display: none;
  }

  .probe-bar-body {
    margin: 0 var(--dian-space-4, 16px) var(--dian-space-3, 12px);
  }

  .table-wrap {
    max-height: none;
    overflow: visible;
  }

  .align-table thead {
    display: none;
  }

  .align-table,
  .align-table tbody,
  .align-table tr,
  .align-table td {
    display: block;
    width: 100%;
  }

  .align-table tr {
    border: 1px solid var(--dian-border, #e0e4ea);
    border-radius: var(--dian-radius-md, 12px);
    padding: 10px 12px;
    margin-bottom: 8px;
    background: var(--dian-surface-soft, var(--dian-surface, #ffffff));
  }

  .align-table td {
    border-bottom: none;
    padding: 3px 0;
    display: flex;
    gap: var(--dian-space-2, 8px);
    align-items: baseline;
  }

  .align-table td::before {
    content: attr(data-label);
    color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
    font-size: 12px;
    min-width: 64px;
    flex: none;
  }

  .align-table .num {
    text-align: left;
    white-space: normal;
  }
}
</style>
