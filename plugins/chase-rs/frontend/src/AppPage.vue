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
// 只呈现真实状态: 缺数据就说缺什么、下一步点哪里, 不造任何假数据。
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NCollapse,
  NCollapseItem,
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
  NTag,
  NText,
  useMessage,
} from 'naive-ui'
// lucide 图标统一加 `Icon` 后缀导入: 模板里 `<calendar-days />` 这种 kebab 标签会先按
// setup 绑定解析(camelize 后正好撞上 `calendarDays` 这类计算属性), 加后缀杜绝影子解析。
import {
  Activity as ActivityIcon,
  Bug as BugIcon,
  CalendarDays as CalendarDaysIcon,
  CircleAlert as CircleAlertIcon,
  CircleCheckBig as CircleCheckBigIcon,
  CircleMinus as CircleMinusIcon,
  CircleHelp as CircleHelpIcon,
  Copy as CopyIcon,
  ListChecks as ListChecksIcon,
  Play as PlayIcon,
  RefreshCw as RefreshCwIcon,
  Scissors as ScissorsIcon,
  Settings as SettingsIcon,
  Target as TargetIcon,
  UserX as UserXIcon,
} from '@lucide/vue'
import ProbePanel from './ProbePanel.vue'
import StatTile from './StatTile.vue'
import {
  alignActionResult,
  episodeLabel,
  formatAt,
  gapRange,
  hasGap,
  list,
  localDate,
  num,
  probeFailed,
  reasonBadge,
  seasonLabel,
  coverageLabel,
  coverageText,
  targetKnown,
  targetLabel,
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

// ─────────────────────────── ① 顶部概览 ───────────────────────────

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

const alignItems = computed<AlignItem[]>(() => list(align.value.items))
const gapItems = computed(() => alignItems.value.filter(hasGap))

/** 逐行预组装徽章: 分类/配色只算一次, 模板里不再重复调用。 */
const alignRows = computed(() =>
  alignItems.value.map((item) => ({
    item,
    badge: reasonBadge(item),
    detail: alignActionResult(item),
    targetUnknown: !targetKnown(item),
  })),
)

/** reason 分类 → 图标(文案一律用后端给的分类词, 这里只挑图形)。 */
function reasonIcon(kind: ReasonBadge['kind']) {
  switch (kind) {
    case 'patched':
      return CircleCheckBigIcon
    case 'no-gap':
      return CircleMinusIcon
    case 'unknown-coverage':
      return CircleHelpIcon
    case 'empty-season':
    case 'absent':
      return UserXIcon
    case 'target-unknown':
      // 覆盖已核实但目标未知: 用和目标列/子徽章同一个 Target 图标(主徽章已经是"目标未知"时不再挂重复的子徽章)。
      return TargetIcon
    default:
      return CircleAlertIcon
  }
}

/** Emby 实例名与 id: -1 跟随宿主默认, 0 旧版单实例, ≥1 指定实例(找不到就如实说)。 */
const instanceLabel = computed(() => {
  const proxy = num(settings.value.emby_proxy_id, -1)
  if (proxy === -1) {
    const fallback = instances.value.find((item) => item.is_default === true)
    if (fallback) return `${text(fallback.name, '未命名实例')} #${num(fallback.id, 0)}`
    return '跟随宿主默认实例'
  }
  if (proxy === 0) return '旧版单实例(调用时不带 id)'
  const found = instances.value.find((item) => num(item.id, -1) === proxy)
  return found ? `${text(found.name, '未命名实例')} #${proxy}` : `#${proxy}`
})

const instanceNote = computed(() => {
  const proxy = num(settings.value.emby_proxy_id, -1)
  if (instances.value.length === 0) return '还没读到实例列表'
  if (proxy === -1) {
    const fallback = instances.value.find((item) => item.is_default === true)
    return fallback ? `id ${num(fallback.id, 0)} · 宿主默认` : '列表里没有标默认的实例'
  }
  if (proxy === 0) return 'id 0 · 旧版单实例'
  const found = instances.value.find((item) => num(item.id, -1) === proxy)
  if (!found) return `id ${proxy} · 已不在最近一次解析到的列表里`
  return `id ${num(found.id, 0)}${found.is_default ? ' · 宿主默认' : ''}${found.key_ready === false ? ' · 未配置密钥' : ''}`
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

const scheduleLine = computed(() => {
  const report = settings.value.report || {}
  const parts: string[] = ['后台对齐: 每小时一次(manifest job `0 * * * *`)']
  if (report.enabled === true) parts.push(`日报 ${num(report.hour, 9)}:00 后当天首次运行发送`)
  else parts.push('日报已关闭')
  if (settings.value.dry_run === true) parts.push('dry-run: 只判定不写入')
  if (settings.value.enabled === false) parts.push('插件已停用')
  return parts.join(' · ')
})

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

// ─────────────────────────── ② 对齐结果表 ───────────────────────────

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

// ─────────────────────────── ③ 追剧日历 ───────────────────────────

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

// ─────────────────────────── ④ 补订建议(只读, 减方向) ───────────────────────────

const trims = computed<TrimSuggestion[]>(() => list(state.value.trim_suggestions))

// ─────────────────────────── ⑤ 动作 ───────────────────────────

const busyLabel = computed(() => {
  switch (busy.value) {
    case 'refresh':
      return '正在刷新(重读订阅池 1 页 + 追剧日历)…'
    case 'align-now':
      return '正在立即对齐(≤1 页订阅池 + ≤5 次 PATCH + ≤3 次 Emby 探测, 6 秒预算)…'
    case 'probe-dump':
      return '正在探测诊断(emby/instances + 两个未知端点的参数矩阵)…'
    case 'settings-update':
      return '正在保存设置…'
    default:
      return ''
  }
})

/** 每次动作后都 await props.api.refresh() —— 状态重取失败也不能吞掉动作结果。 */
async function runAction(action: string, input: Record<string, unknown> = {}): Promise<NonNullable<RuntimeCallback['result']>> {
  busy.value = action
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
      message.error(String(result.message || '操作失败'))
    } else if (action === 'align-now') {
      const note = result.budget_hit ? '(达时间预算提前结束)' : ''
      const absent = num(result.absent, 0)
      const absentNote = absent > 0 ? ` · 未收录 ${absent} 条` : ''
      message.success(
        `立即对齐完成: 补订 ${num(result.patched, 0)} 条 · 跳过 ${num(result.skipped, 0)} 条 · 失败 ${num(result.failed, 0)} 条${absentNote}${note}`,
      )
    } else if (action === 'probe-dump') {
      message.success(String(result.message || '操作完成'))
    } else {
      message.success(String(result.message || '操作完成'))
    }
  } catch (error: unknown) {
    result = { status: 'failed', message: String((error as { message?: string })?.message || '操作失败') }
    message.error(String(result.message))
  } finally {
    busy.value = ''
  }
  if (!stateReady.value) await loadState()
  return result
}

// ─────────────────────────── ⑥ 设置抽屉 ───────────────────────────

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

// ─────────────────────────── ⑦ 诊断 ───────────────────────────

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
    <!-- 标题 + ⑤ 操作区 -->
    <header class="chase-header">
      <div class="chase-header-title">
        <h2>追剧管家</h2>
        <p>订阅池的 total_episodes × Emby 已有集数, 每小时对齐一次; 只增不减, 减方向只给建议。</p>
      </div>
      <div class="chase-header-actions">
        <n-tag :type="overviewStatus.enabled ? 'success' : 'default'" :bordered="false" size="small">
          {{ overviewStatus.enabled ? '已启用' : '已停用' }}
        </n-tag>
        <n-tag v-if="overviewStatus.dryRun" type="warning" :bordered="false" size="small">dry-run</n-tag>
        <n-button size="small" secondary :loading="busy === 'refresh'" :disabled="!!busy" @click="runAction('refresh')">
          <template #icon><refresh-cw-icon /></template>
          刷新
        </n-button>
        <n-button size="small" type="primary" :loading="busy === 'align-now'" :disabled="!!busy" @click="runAction('align-now')">
          <template #icon><play-icon /></template>
          立即对齐
        </n-button>
        <n-button size="small" secondary :loading="busy === 'probe-dump'" :disabled="!!busy" @click="runAction('probe-dump')">
          <template #icon><bug-icon /></template>
          探测诊断
        </n-button>
        <n-button size="small" quaternary @click="settingsOpen = true">
          <!-- 别名 SettingsIcon: 模板里 `<settings />` 会被解析成同名的 `settings` 计算属性 -->
          <template #icon><settings-icon /></template>
          设置
        </n-button>
      </div>
    </header>

    <p v-if="busyLabel" class="chase-busy">{{ busyLabel }}</p>
    <p class="chase-budget">
      立即对齐的预算: 1 页订阅池 + ≤5 次 PATCH + ≤3 次 Emby 探测, 6 秒时间预算; 命中预算会提前结束并在结果里标 budget_hit。
    </p>

    <!-- ⑧ 状态加载不可用: 一句话原因 + 下一步, 不显示任何假数据 -->
    <section v-if="!stateReady" class="chase-card">
      <n-alert type="error" :show-icon="true" title="状态不可用">
        宿主还没有返回本插件的状态文档{{ stateLoadError ? `(${stateLoadError})` : '' }}。
        常见原因: 插件 runtime 刚重启或更新中, `runtime/state` 暂时失败; 或是存储后端不可读(运行时按「只读不落盘」处理)。
      </n-alert>
      <p class="chase-next">
        下一步: 点「重新读取状态」; 仍然失败就点「探测诊断」拉一次诊断(它会重新读状态), 或把宿主机上插件的运行日志贴给作者。
      </p>
      <div class="chase-inline-actions">
        <n-button size="small" type="primary" :loading="loadingState" @click="loadState">
          <template #icon><refresh-cw-icon /></template>
          重新读取状态
        </n-button>
        <n-button size="small" secondary :loading="busy === 'probe-dump'" :disabled="!!busy" @click="runAction('probe-dump')">
          <template #icon><bug-icon /></template>
          探测诊断
        </n-button>
      </div>
    </section>

    <template v-else>
      <!-- ① 顶部概览条 -->
      <section class="chase-overview">
        <stat-tile label="运行状态" :value="overviewStatus.status" :note="overviewStatus.lastMessage" />
        <stat-tile label="订阅池剧集数" :value="String(num(stats.tv_intents, 0))" :note="`参与判定 ${num(stats.matched, 0)} 条`" />
        <stat-tile label="已对齐" :value="String(num(stats.aligned, 0))" note="本轮补订(含 dry-run 判定要补)" tone="success" />
        <stat-tile
          label="有缺口"
          :value="String(gapItems.length)"
          :note="`合计缺口 ${num(stats.gap_total, 0)} 集`"
          :tone="gapItems.length > 0 ? 'warning' : 'default'"
        />
        <stat-tile
          label="待探测"
          :value="`${alignSummary.pendingProbe} 条`"
          :note="alignSummary.pendingProbe > 0 ? '预算/时间用尽, 下轮优先补探' : '本轮没有条目被预算挡下'"
          :tone="alignSummary.pendingProbe > 0 ? 'warning' : 'default'"
        />
        <stat-tile
          label="未收录"
          :value="`${alignSummary.absent} 条`"
          :note="alignSummary.absent > 0 ? 'Emby 里没有这部剧/该季 0 集' : '没有未收录条目'"
          :tone="alignSummary.absent > 0 ? 'warning' : 'default'"
        />
        <stat-tile label="Emby 实例" :value="instanceLabel" :note="instanceNote" />
        <stat-tile label="最近对齐" :value="alignSummary.lastRunAt" :note="`上次运行 ${overviewStatus.lastRun} · revision ${overviewStatus.revision}`" />
        <stat-tile label="日报" :value="reportStatus.value" :note="reportStatus.note" :tone="reportStatus.tone" />
      </section>
      <p class="chase-schedule">{{ scheduleLine }}</p>

      <!-- ⑧ 未配置/未读到 Emby 实例 -->
      <n-alert v-if="instanceProblem" type="warning" :show-icon="true" class="chase-alert">
        <template #header>Emby 实例不可用</template>
        {{ instanceProblem }}
      </n-alert>
      <n-alert v-if="storageWarning" type="error" :show-icon="true" class="chase-alert">{{ storageWarning }}</n-alert>
      <n-alert v-if="probeProblem" type="warning" :show-icon="true" class="chase-alert">{{ probeProblem }}</n-alert>

      <!-- ② 对齐结果表 -->
      <section class="chase-card">
        <div class="chase-card-head">
          <h3><list-checks-icon class="chase-icon" />对齐结果</h3>
          <n-text depth="3">
            最近对齐 {{ alignSummary.lastRunAt }} · 补订 {{ alignSummary.patched }} / 跳过 {{ alignSummary.skipped }} / 失败
            {{ alignSummary.failed }} · 未收录 {{ alignSummary.absent }} · 待探测 {{ alignSummary.pendingProbe }} 条 · 读
            {{ alignSummary.pages }} 页 / 见到 {{ alignSummary.intentsSeen }} 条 / 参与判定 {{ alignSummary.matched }} 条
          </n-text>
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

        <div v-else class="chase-table-wrap">
          <table class="chase-table">
            <thead>
              <tr>
                <th>剧集</th>
                <th>季</th>
                <th>订阅总集数</th>
                <th>Emby 已有</th>
                <th>TMDB 目标</th>
                <th>缺口集号</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in alignRows" :key="`${num(row.item.intent_id, 0)}-${num(row.item.season, 0)}`">
                <td data-label="剧集">
                  <div class="chase-title">{{ text(row.item.title, `intent #${num(row.item.intent_id, 0)}`) }}</div>
                  <div class="chase-sub">intent {{ num(row.item.intent_id, 0) }} · tmdb {{ num(row.item.tmdb_id, 0) }} · {{ formatAt(row.item.at) }}</div>
                </td>
                <td data-label="季">{{ seasonLabel(row.item.season) }}</td>
                <td data-label="订阅总集数">{{ num(row.item.total_known, 0) }}</td>
                <td data-label="Emby 已有">
                  <span :class="{ 'chase-sub': num(row.item.emby_have_max, -1) < 0 }">{{ coverageLabel(row.item) }}</span>
                </td>
                <td data-label="TMDB 目标">
                  <span :class="{ 'chase-sub': !targetKnown(row.item) }">{{ targetLabel(row.item) }}</span>
                </td>
                <td data-label="缺口集号">
                  <span :class="{ 'chase-gap': hasGap(row.item) }">{{ gapRange(row.item) }}</span>
                </td>
                <td data-label="结果">
                  <div class="chase-result-cell">
                    <div class="chase-result">
                      <n-tag :type="row.badge.tag" :bordered="false" size="small">
                        <template #icon>
                          <component :is="reasonIcon(row.badge.kind)" class="chase-result-icon" />
                        </template>
                        {{ row.badge.label }}
                      </n-tag>
                      <n-tag
                        v-if="row.targetUnknown && row.badge.kind !== 'target-unknown'"
                        type="info"
                        :bordered="false"
                        size="small"
                        class="chase-tag-target"
                      >
                        <template #icon><target-icon class="chase-result-icon" /></template>
                        目标未知
                      </n-tag>
                    </div>
                    <div class="chase-sub">{{ row.detail }}</div>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ③ 追剧日历 -->
      <section class="chase-card">
        <div class="chase-card-head">
          <h3><calendar-days-icon class="chase-icon" />追剧日历</h3>
          <n-text depth="3">抓取于 {{ calendarFetchedAt }} · 窗口 {{ calendarDays.length }} 天</n-text>
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

        <div v-else class="chase-days">
          <div
            v-for="day in calendarDays"
            :key="text(day.date, '')"
            class="chase-day"
            :class="{ 'chase-day-today': text(day.date, '') === today }"
          >
            <div class="chase-day-head">
              <strong>{{ text(day.date) }}</strong>
              <n-tag v-if="text(day.date, '') === today" type="primary" size="small" :bordered="false">今天</n-tag>
              <span class="chase-sub">{{ list(day.items).length }} 条</span>
            </div>
            <ul v-if="list(day.items).length > 0" class="chase-list">
              <li v-for="(entry, index) in list(day.items)" :key="`${text(day.date, '')}-${index}`">
                <span class="chase-time">{{ text(entry.time, '时间待定') }}</span>
                <span class="chase-title">{{ text(entry.title, `tmdb ${num(entry.tmdb_id, 0)}`) }}</span>
                <span class="chase-sub">{{ episodeLabel(entry.season, entry.episode) }}</span>
              </li>
            </ul>
            <p v-else class="chase-sub">这天没有播出</p>
          </div>
        </div>
      </section>

      <!-- ④ 补订建议(只读, 减方向) -->
      <section class="chase-card">
        <div class="chase-card-head">
          <h3><scissors-icon class="chase-icon" />补订建议(只读)</h3>
          <n-text depth="3">{{ trims.length }} 条</n-text>
        </div>
        <n-alert type="info" :show-icon="true" class="chase-alert">
          <template #header>本插件只补订不裁剪, 以下仅为建议</template>
          需要缩小 total_episodes 时, 请拿下面的 intent_id / tmdb_id / season 到宿主的订阅池页面手工处理。
        </n-alert>
        <n-empty v-if="trims.length === 0" description="没有需要提醒的条目: 订阅集数都不超过该季 TMDB 的集数。" />
        <ul v-else class="chase-list chase-list-block">
          <li v-for="trim in trims" :key="`${num(trim.intent_id, 0)}-${num(trim.season, 0)}`">
            <div class="chase-title">{{ text(trim.title, `intent #${num(trim.intent_id, 0)}`) }}</div>
            <div class="chase-sub chase-mono">
              intent_id {{ num(trim.intent_id, 0) }} · tmdb_id {{ num(trim.tmdb_id, 0) }} · season {{ seasonLabel(trim.season) }}
            </div>
            <div class="chase-sub">
              订阅 {{ num(trim.total_known, 0) }} 集 · Emby 已有 {{ coverageText(trim.emby_have_max, undefined) }} · 建议上限
              {{ targetLabel(trim) }} · {{ formatAt(trim.at) }}
            </div>
            <div>{{ text(trim.reason) }}</div>
          </li>
        </ul>
      </section>

      <!-- ⑦ 诊断面板 -->
      <section class="chase-card">
        <div class="chase-card-head">
          <h3><activity-icon class="chase-icon" />诊断</h3>
          <n-text depth="3">更新于 {{ formatAt(debug.updated_at) }}</n-text>
        </div>
        <n-collapse :default-expanded-names="probeProblem ? ['diag'] : []">
          <n-collapse-item title="端点探针与原文样本" name="diag">
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

            <div class="chase-diag-block">
              <div class="chase-probe-label">last_errors (最近 {{ lastErrors.length }} 条)</div>
              <ul v-if="lastErrors.length > 0" class="chase-list">
                <li v-for="(error, index) in lastErrors" :key="index">
                  <span class="chase-sub">{{ formatAt(error.at) }}</span>
                  <span class="chase-mono">[{{ text(error.step) }}]</span>
                  {{ text(error.message) }}
                </li>
              </ul>
              <p v-else class="chase-sub">没有错误记录。</p>
            </div>

            <div class="chase-diag-block">
              <div class="chase-probe-label">host.call 尝试 (最近 {{ attempts.length }} 次)</div>
              <ul v-if="attempts.length > 0" class="chase-list">
                <li v-for="(attempt, index) in attempts" :key="index">
                  <span class="chase-sub">{{ formatAt(attempt.at) }}</span>
                  <span class="chase-mono">{{ text(attempt.endpoint) }}</span>
                  {{ text(attempt.params) }} →
                  <span class="chase-sub">http {{ num(attempt.http_status, 0) }} · {{ text(attempt.shape) }}</span>
                </li>
              </ul>
              <p v-else class="chase-sub">还没有 host.call 记录。</p>
            </div>
          </n-collapse-item>

          <n-collapse-item title="完整诊断文本(整段复制给作者)" name="raw">
            <div class="chase-diag-head">
              <n-text depth="3">只读文本域, 内容与上面一致并附带最近日志。</n-text>
              <n-button size="tiny" secondary @click="copyDiagnostics">
                <template #icon><copy-icon /></template>
                {{ copied ? '已复制' : '复制' }}
              </n-button>
            </div>
            <n-input :value="diagnosticsText" type="textarea" readonly :autosize="{ minRows: 12, maxRows: 28 }" />
          </n-collapse-item>
        </n-collapse>
      </section>
    </template>

    <!-- ⑥ 设置抽屉 -->
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
          <span class="chase-mono">{{ changedKeys.join(', ') }}</span>
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
  display: grid;
  gap: var(--dian-space-4);
  padding: var(--dian-space-1);
  width: 100%;
  max-width: 100%;
  min-width: 0;
  color: var(--dian-text-primary);
}

.chase-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--dian-space-3);
  border-bottom: 1px solid var(--dian-divider);
  padding-bottom: var(--dian-space-4);
  flex-wrap: wrap;
}

.chase-header-title {
  min-width: 0;
}

.chase-header-title h2 {
  margin: 0;
  font-size: 22px;
}

.chase-header-title p {
  margin: var(--dian-space-1) 0 0;
  color: var(--dian-text-secondary);
  font-size: 13px;
}

.chase-header-actions {
  display: flex;
  align-items: center;
  gap: var(--dian-space-2);
  flex-wrap: wrap;
}

.chase-busy {
  margin: 0;
  color: var(--dian-primary);
  font-size: 13px;
}

.chase-budget,
.chase-schedule,
.chase-next {
  margin: 0;
  color: var(--dian-text-muted);
  font-size: 12px;
}

.chase-next {
  color: var(--dian-text-secondary);
  font-size: 13px;
}

.chase-overview {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
  gap: var(--dian-space-3);
}

.chase-inline-actions {
  display: flex;
  gap: var(--dian-space-2);
  flex-wrap: wrap;
}

.chase-alert {
  border-radius: var(--dian-radius-sm);
}

.chase-card {
  border: 1px solid var(--dian-border);
  border-radius: var(--dian-radius-panel);
  background: var(--dian-surface);
  padding: var(--dian-space-4);
  display: grid;
  gap: var(--dian-space-3);
  min-width: 0;
}

.chase-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--dian-space-3);
  flex-wrap: wrap;
}

.chase-card-head h3 {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--dian-space-2);
  font-size: 16px;
}

.chase-icon {
  width: 16px;
  height: 16px;
}

.chase-empty {
  padding: var(--dian-space-4) 0;
}

/* ---- ② 对齐结果表 ---- */

.chase-table-wrap {
  overflow-x: auto;
  min-width: 0;
}

.chase-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.chase-table th,
.chase-table td {
  text-align: left;
  padding: var(--dian-space-2) var(--dian-space-3);
  border-bottom: 1px solid var(--dian-divider);
  vertical-align: top;
}

.chase-table th {
  color: var(--dian-text-muted);
  font-weight: 500;
  white-space: nowrap;
}

.chase-title {
  font-weight: 600;
}

.chase-sub {
  color: var(--dian-text-muted);
  font-size: 12px;
}

.chase-mono {
  font-family: var(--dian-font-mono, monospace);
}

.chase-gap {
  color: var(--dian-warning);
  font-variant-numeric: tabular-nums;
}

/* 结果列: 分类徽章(+ 目标未知小徽章)一行, 详细原因另起一行 —— 窄屏下 td 是 flex,
   这里用 grid 保证两行始终竖排 */
.chase-result-cell {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.chase-result {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--dian-space-1);
}

/* lucide 图标默认 24px, 塞进 small 徽章要收小 */
.chase-result-icon {
  width: 14px;
  height: 14px;
}

.chase-tag-target {
  color: var(--dian-text-secondary);
}

/* ---- ③ 追剧日历 ---- */

.chase-days {
  display: grid;
  gap: var(--dian-space-3);
}

.chase-day {
  border: 1px solid var(--dian-border);
  border-radius: var(--dian-radius-md);
  padding: var(--dian-space-3);
  background: var(--dian-surface-soft, var(--dian-surface));
}

.chase-day-today {
  border-color: var(--dian-primary);
  box-shadow: inset 3px 0 0 var(--dian-primary);
}

.chase-day-head {
  display: flex;
  align-items: center;
  gap: var(--dian-space-2);
  margin-bottom: var(--dian-space-2);
}

/* ---- ④ 补订建议 / ⑦ 诊断列表 ---- */

.chase-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--dian-space-1);
  font-size: 13px;
}

.chase-list-block li {
  border-bottom: 1px dashed var(--dian-divider);
  padding-bottom: var(--dian-space-2);
}

.chase-time {
  display: inline-block;
  min-width: 64px;
  color: var(--dian-text-secondary);
  font-variant-numeric: tabular-nums;
}

.chase-probes {
  display: grid;
  gap: var(--dian-space-3);
  padding-bottom: var(--dian-space-3);
}

.chase-diag-block {
  display: grid;
  gap: var(--dian-space-1);
  padding-top: var(--dian-space-3);
  border-top: 1px solid var(--dian-divider);
}

.chase-diag-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--dian-space-2);
  flex-wrap: wrap;
  margin-bottom: var(--dian-space-2);
}

.chase-probe-label {
  color: var(--dian-text-muted);
  font-size: 12px;
}

/* ---- ⑥ 设置抽屉 ---- */

.chase-form-note {
  margin-left: var(--dian-space-2);
  font-size: 12px;
}

.chase-drawer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--dian-space-3);
  flex-wrap: wrap;
}

.chase-drawer-buttons {
  display: flex;
  gap: var(--dian-space-2);
}

/* ---- 视口折叠: 宿主侧边栏打开时 iframe 变窄(900-1000px), 表格折成单栏卡片 ---- */

@media (max-width: 1000px) {
  .chase-header {
    flex-direction: column;
    align-items: stretch;
  }

  .chase-overview {
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  }

  .chase-table thead {
    display: none;
  }

  .chase-table,
  .chase-table tbody,
  .chase-table tr,
  .chase-table td {
    display: block;
    width: 100%;
  }

  .chase-table tr {
    border: 1px solid var(--dian-border);
    border-radius: var(--dian-radius-md);
    padding: var(--dian-space-2);
    margin-bottom: var(--dian-space-2);
    background: var(--dian-surface-soft, var(--dian-surface));
  }

  .chase-table td {
    border-bottom: none;
    padding: 2px 0;
    display: flex;
    gap: var(--dian-space-2);
  }

  .chase-table td::before {
    content: attr(data-label);
    color: var(--dian-text-muted);
    font-size: 12px;
    min-width: 76px;
    flex: none;
  }
}

@media (max-width: 600px) {
  .chase-card {
    padding: var(--dian-space-3);
  }

  .chase-time {
    min-width: 0;
  }
}
</style>
