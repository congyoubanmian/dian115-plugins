<script setup lang="ts">
// 音乐下载(Rust 版)插件界面 —— Federation 模块 `./AppPage`(见 vite.config.ts / manifest)。
//
// 布局与交互习惯沿用 plugins/music-dl/src/AppPage.vue: 顶部扫码登录卡片 + 搜索/任务/设置
// 三个分页 + 底部记录区。**数据通道换成本插件的 wasm 运行时**:
//   - 状态只读 `props.runtimeState`(宿主注入), 宿主没给时用 `props.api.getState()` 兜底;
//   - 动作一律走 `props.api.invokeAction`, 每次动作后 `await props.api.refresh()`;
//   - 不直接 fetch, 也没有 sidecar(旧版 UI 的 agent-get/agent-post 与 sidecar 回环地址已移除)。
//
// action 名与入参对齐 `src/runtime.rs` 的 action 分发表:
//   qr-create{source} / qr-poll{source,key} / search{source,query,page}
//   / download{source,song_id,name,singers,album,level} / settings-update{patch}
//   / task-retry{id} / task-clear{}
// 返回形状是 `{result:{status,message,data}}`(见 runtime.rs 的 `action_result`)。
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NDivider,
  NEmpty,
  NInput,
  NInputNumber,
  NSwitch,
  NTag,
  NText,
  useMessage,
} from 'naive-ui'
import { encodeQr, qrSvgPath } from './qr'

// ─────────────────────────── 宿主桥(douban-center/src/AppPage.vue 的同名契约) ───────────────────────────

interface RuntimeCallback {
  invocation_id?: string
  replayed?: boolean
  result?: {
    status?: 'succeeded' | 'failed' | 'accepted' | 'skipped'
    message?: string
    /** action 的业务负载(action_result 的 `data`; 失败时没有)。 */
    data?: Record<string, any>
    [key: string]: unknown
  }
}

interface HostBridge {
  getState(view?: string): Promise<{ state?: Record<string, unknown>; state_version?: string; etag?: string }>
  invokeAction(action: string, input?: unknown): Promise<RuntimeCallback>
  refresh(): Promise<Record<string, unknown>>
}

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

// ─────────────────────────── 状态文档(runtime.rs `state_doc`) ───────────────────────────

/** 一条下载任务(tasks.rs `Task`)。 */
interface Task {
  id?: string
  source?: string
  song_id?: string
  name?: string
  singers?: string
  album?: string
  quality?: string
  out_name?: string
  /** queued / downloading / copying / done / failed */
  status?: string
  job_ref?: string
  attempts?: number
  error?: string
  created_ms?: number
  updated_ms?: number
}

/** 下载设置(download.rs `Settings`)。 */
interface Settings {
  staging_dir?: string
  target_dir?: string
  quality?: string
  max_active?: number
  notify_on_fail?: boolean
}

interface LoginInfo {
  logged_in?: boolean
  has_music_u?: boolean
  uin?: string
  source?: string
  error?: string
}

interface RootEntry {
  path?: string
  name?: string
  local?: boolean
  writable?: boolean
}

interface RootsProbe {
  ok?: boolean
  error?: string
  staging_dir?: string
  staging_dir_effective?: string | null
  target_dir?: string
  warnings?: string[]
  roots?: RootEntry[]
}

interface LogEntry {
  at?: string
  level?: string
  message?: string
}

interface AppState {
  status?: string
  last_message?: string
  revision?: number
  schema?: number
  settings?: Settings
  tasks?: Task[]
  login?: Record<string, LoginInfo>
  roots?: RootsProbe
  logs?: LogEntry[]
}

const localState = ref<AppState | null>(null)
const loadingState = ref(false)
const stateError = ref('')

/** 宿主注入优先; 宿主没给(刚重启/更新窗口)才用 getState 兜底。 */
const stateDoc = computed<AppState | null>(() => {
  const incoming = props.runtimeState as AppState | undefined
  if (incoming && typeof incoming === 'object' && Object.keys(incoming).length > 0) return incoming
  return localState.value
})
const state = computed<AppState>(() => stateDoc.value || {})
const stateReady = computed(() => stateDoc.value !== null)

const tasks = computed<Task[]>(() => listOf<Task>(state.value.tasks))
const settings = computed<Settings>(() => state.value.settings || {})
const login = computed<Record<string, LoginInfo>>(() => state.value.login || {})
const roots = computed<RootsProbe>(() => state.value.roots || {})
const logs = computed<LogEntry[]>(() => listOf<LogEntry>(state.value.logs).slice(-12).reverse())

function listOf<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : []
}

async function loadState() {
  loadingState.value = true
  try {
    const response = await props.api.getState()
    const raw = response && typeof response === 'object' ? (response.state as AppState | undefined) : undefined
    if (raw && typeof raw === 'object' && Object.keys(raw).length > 0) {
      localState.value = raw
      stateError.value = ''
    } else {
      stateError.value = '宿主返回的状态文档为空(state 键缺失)'
    }
  } catch (error: unknown) {
    stateError.value = String((error as { message?: string })?.message || error || '未知错误')
  } finally {
    loadingState.value = false
  }
}

onMounted(() => {
  if (!props.runtimeState || Object.keys(props.runtimeState).length === 0) void loadState()
})

/** 动作 → 桥, 每次动作后重取状态(失败也不吞掉动作结果)。 */
async function invoke(action: string, input: Record<string, unknown> = {}) {
  const response = await props.api.invokeAction(action, input)
  const result = response?.result || {}
  try {
    await props.api.refresh()
  } catch (error: unknown) {
    message.warning(`状态重取失败: ${String((error as { message?: string })?.message || error)}; 界面可能还是旧值`)
  }
  return result
}

async function refreshState() {
  try {
    await props.api.refresh()
  } catch (error: unknown) {
    message.warning(`刷新失败: ${String((error as { message?: string })?.message || error)}`)
  }
  if (!stateReady.value) await loadState()
}

// ─────────────────────────── 音质表(netease.rs `LEVELS` / QQ 阶梯) ───────────────────────────

const sources = [
  {
    id: 'netease',
    name: '网易云',
    qualities: ['jymaster', 'jyeffect', 'sky', 'hires', 'lossless', 'dolby', 'exhigh', 'standard'],
  },
  // QQ 的取链阶梯按这里的档位裁剪(download.rs `resolve_song_url` 把 level 传给
  // qq::song_url, 对应 sidecar 的 master/flac/320/128 切片)。
  { id: 'qq', name: 'QQ音乐', qualities: ['master', 'flac', '320', '128'] },
]

const qualityLabels: Record<string, string> = {
  jymaster: '超清母带',
  jyeffect: '高清臻音',
  sky: '沉浸环绕',
  hires: 'Hi-Res',
  lossless: '无损',
  dolby: '杜比全景声',
  exhigh: '极高',
  standard: '标准',
  master: '母带',
  flac: '无损 FLAC',
  320: '320K',
  128: '128K',
}

function qualityLabel(value: string): string {
  return qualityLabels[value] || value || '—'
}

function sourceName(id: string): string {
  return sources.find((item) => item.id === id)?.name || id || '—'
}

/** 歌曲可选档位: 后端给了 `qualities` 就用它, 否则用来源的档位表。 */
function qualitiesFor(src: string, song?: Song): string[] {
  const own = (song as any)?.qualities
  if (Array.isArray(own) && own.length > 0) return own as string[]
  return sources.find((item) => item.id === src)?.qualities || ['flac', '320', '128']
}

function qualityOptions(src: string, song?: Song) {
  return qualitiesFor(src, song).map((value) => ({ label: qualityLabel(value), value }))
}

// ─────────────────────────── ① 扫码登录(runtime.rs: qr-create / qr-poll) ───────────────────────────

interface QrSession {
  source: string
  key: string
  /** 网易云的登录页 URL —— 后端只回 `qr_content`, 前端自己画二维码(netease.rs 注释)。 */
  content: string
  /** QQ 的二维码 PNG 直链(`image_mode: fetch_png`)。 */
  imageUrl: string
  imageMode: string
  expiresAt: number
}

const loginSource = ref('netease')
const qr = ref<QrSession | null>(null)
const qrStatus = ref('')
const qrMessage = ref('')
const qrBusy = ref(false)
const qrImageFailed = ref(false)
const qrError = ref('')
const qrTimer = ref<ReturnType<typeof setTimeout> | null>(null)

const qrPolling = computed(() => qrTimer.value !== null)

const qrCode = computed(() => {
  const session = qr.value
  if (!session || !session.content) return null
  try {
    qrError.value = ''
    return encodeQr(session.content, 'M')
  } catch (error: unknown) {
    qrError.value = String((error as { message?: string })?.message || error)
    return null
  }
})
const qrPath = computed(() => (qrCode.value ? qrSvgPath(qrCode.value) : ''))
/** 4 模块静区的 viewBox(渲染方自己加边距)。 */
const qrViewBox = computed(() => {
  const size = (qrCode.value?.size || 0) + 8
  return `0 0 ${size} ${size}`
})

const qrStatusText = computed(() => {
  switch (qrStatus.value) {
    case 'scanned':
      return '✓ 已扫码，请在手机上确认'
    case 'waiting':
      return '等待扫码…（用对应音乐 App 的扫一扫）'
    case 'expired':
      return '二维码已过期，请重新获取'
    case 'success':
      return '✓ 登录成功'
    case 'failed':
      return '扫码轮询失败，可重新获取二维码'
    default:
      return '正在生成二维码…'
  }
})

const loginTags = computed(() => {
  const netease = login.value.netease || {}
  const qq = login.value.qq || {}
  return [
    { key: 'netease', name: '网易云', ok: netease.logged_in === true, note: netease.error || '' },
    {
      key: 'qq',
      name: 'QQ音乐',
      ok: qq.logged_in === true,
      note: qq.logged_in === true && qq.uin ? `uin ${qq.uin}` : qq.error || '',
    },
  ]
})

function stopQrPolling() {
  if (qrTimer.value !== null) {
    clearTimeout(qrTimer.value)
    qrTimer.value = null
  }
}

function resetQr() {
  stopQrPolling()
  qr.value = null
  qrStatus.value = ''
  qrMessage.value = ''
  qrImageFailed.value = false
  qrError.value = ''
}

async function createQr(src: string) {
  stopQrPolling()
  qrImageFailed.value = false
  qrBusy.value = true
  try {
    const result = await invoke('qr-create', { source: src })
    if (result.status === 'failed') {
      resetQr()
      message.error(String(result.message || '二维码获取失败'))
      return
    }
    const data = (result.data || {}) as Record<string, any>
    const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : 180
    qr.value = {
      source: src,
      key: String(data.key || ''),
      content: String(data.qr_content || ''),
      imageUrl: String(data.image_url || ''),
      imageMode: String(data.image_mode || ''),
      expiresAt: Date.now() + expiresIn * 1000,
    }
    qrStatus.value = 'waiting'
    qrMessage.value = ''
    if (!qr.value.key) {
      message.warning('后端没有返回 key, 无法轮询登录状态')
      return
    }
    scheduleQrPoll()
  } catch (error: unknown) {
    resetQr()
    message.error(String((error as { message?: string })?.message || '二维码获取失败'))
  } finally {
    qrBusy.value = false
  }
}

function scheduleQrPoll() {
  stopQrPolling()
  qrTimer.value = setTimeout(() => {
    qrTimer.value = null
    void pollQr()
  }, 2000)
}

async function pollQr() {
  const session = qr.value
  if (!session) return
  if (Date.now() > session.expiresAt) {
    qrStatus.value = 'expired'
    message.warning('二维码已过期，请重新获取')
    return
  }
  try {
    const result = await invoke('qr-poll', { source: session.source, key: session.key })
    const data = (result.data || {}) as Record<string, any>
    if (result.status === 'failed') {
      // 网络抖动也会以 failed 回来: 记下原因, 继续轮询到过期为止。
      qrMessage.value = String(result.message || '')
      scheduleQrPoll()
      return
    }
    const status = String(data.status || '')
    qrMessage.value = String(data.message || '')
    if (status === 'success' || data.logged_in === true) {
      qrStatus.value = 'success'
      stopQrPolling()
      qr.value = null
      message.success('登录成功')
      await refreshState()
      return
    }
    if (status === 'expired') {
      qrStatus.value = 'expired'
      stopQrPolling()
      message.warning('二维码已过期，请重新获取')
      return
    }
    qrStatus.value = status || 'waiting'
    scheduleQrPoll()
  } catch (error: unknown) {
    qrMessage.value = String((error as { message?: string })?.message || error)
    scheduleQrPoll()
  }
}

function switchLoginSource(src: string) {
  if (loginSource.value === src) return
  loginSource.value = src
  resetQr()
}

onBeforeUnmount(stopQrPolling)

// ─────────────────────────── ② 搜索(runtime.rs: search) ───────────────────────────

interface Song {
  id?: string | number
  name?: string
  singers?: string
  album?: string
  cover?: string
  duration_ms?: number
  duration_s?: number
  source?: string
  quality?: string
}

const tab = ref('search')
const source = ref('netease')
const query = ref('')
const searching = ref(false)
const results = ref<Song[]>([])
const searchPage = ref(1)
const searchTotal = ref<number | null>(null)
const songQuality = reactive<Record<string, string>>({})

async function runSearch(page: number) {
  const text = query.value.trim()
  if (!text) return
  searching.value = true
  try {
    const result = await invoke('search', { source: source.value, query: text, page })
    if (result.status === 'failed') {
      message.error(String(result.message || '搜索失败'))
      return
    }
    const data = (result.data || {}) as Record<string, any>
    const songs = listOf<Song>(data.songs)
    results.value = page > 1 ? [...results.value, ...songs] : songs
    searchPage.value = page
    searchTotal.value = typeof data.total === 'number' ? data.total : null
    if (results.value.length === 0) message.info('没有搜索到内容')
  } catch (error: unknown) {
    message.error(String((error as { message?: string })?.message || '搜索失败'))
  } finally {
    searching.value = false
  }
}

/** 上一页返回的是满页才认为还有下一页(netease 每页 30 / QQ 每页 20)。 */
const hasMoreResults = computed(() => {
  const pageSize = source.value === 'qq' ? 20 : 30
  if (results.value.length === 0) return false
  if (searchTotal.value !== null) return results.value.length < searchTotal.value
  return results.value.length % pageSize === 0
})

function switchSearchSource(src: string) {
  if (source.value === src) return
  source.value = src
  results.value = []
  searchTotal.value = null
  searchPage.value = 1
}

function qualityOf(song: Song): string {
  const key = String(song.id ?? '')
  const chosen = songQuality[key]
  if (chosen) return chosen
  const list = qualitiesFor(song.source || source.value, song)
  const own = typeof song.quality === 'string' ? song.quality : ''
  return (own && list.includes(own) ? own : list[0]) || 'flac'
}

function setSongQuality(song: Song, value: string) {
  songQuality[String(song.id ?? '')] = value
}

const submitting = ref('')

async function download(song: Song) {
  const key = String(song.id ?? '')
  submitting.value = key
  try {
    const result = await invoke('download', {
      source: song.source || source.value,
      song_id: key,
      name: song.name || '',
      singers: song.singers || '',
      album: song.album || '',
      level: qualityOf(song),
    })
    if (result.status === 'failed') {
      message.error(String(result.message || '下载失败'))
      return
    }
    const data = (result.data || {}) as Record<string, any>
    const deduped = data.deduped === true
    message.success(
      deduped
        ? `队列里已有同一首（${qualityLabel(String(data.quality || qualityOf(song)))}），已复用任务 ${data.task_id || ''}`
        : `已入队: ${song.name || key} · ${qualityLabel(String(data.quality || qualityOf(song)))}`,
    )
  } catch (error: unknown) {
    message.error(String((error as { message?: string })?.message || '下载失败'))
  } finally {
    submitting.value = ''
  }
}

// ─────────────────────────── ③ 任务列表(runtime.rs: task-retry / task-clear) ───────────────────────────

const taskBusy = ref('')

const statusMeta: Record<string, { label: string; type: 'default' | 'info' | 'success' | 'warning' | 'error' }> = {
  queued: { label: '排队中', type: 'default' },
  downloading: { label: '下载中', type: 'info' },
  copying: { label: '入库中', type: 'info' },
  done: { label: '已完成', type: 'success' },
  failed: { label: '失败', type: 'error' },
}

function taskStatusLabel(task: Task): string {
  return statusMeta[String(task.status || '')]?.label || String(task.status || '未知')
}

function taskStatusType(task: Task) {
  return statusMeta[String(task.status || '')]?.type || ('default' as const)
}

function formatMs(value: unknown): string {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatAt(value: unknown): string {
  const raw = typeof value === 'string' ? value : ''
  if (!raw) return '—'
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(raw)
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}` : raw
}

const pendingTasks = computed(() =>
  tasks.value.filter((task) => {
    const status = String(task.status || '')
    return status === 'queued' || status === 'downloading' || status === 'copying'
  }),
)
const failedTasks = computed(() => tasks.value.filter((task) => String(task.status || '') === 'failed'))

async function retryTask(task: Task) {
  const id = String(task.id || '')
  if (!id) return
  taskBusy.value = id
  try {
    const result = await invoke('task-retry', { id })
    if (result.status === 'failed') {
      message.error(String(result.message || '重试失败'))
      return
    }
    const data = (result.data || {}) as Record<string, any>
    message.success(String(data.message || '已重新排队'))
  } catch (error: unknown) {
    message.error(String((error as { message?: string })?.message || '重试失败'))
  } finally {
    taskBusy.value = ''
  }
}

async function clearFinished() {
  taskBusy.value = 'clear'
  try {
    const result = await invoke('task-clear')
    if (result.status === 'failed') {
      message.error(String(result.message || '清理失败'))
      return
    }
    const removed = Number((result.data || {}).removed ?? 0)
    message.success(removed > 0 ? `已清理 ${removed} 条已结束任务` : '没有已结束的任务')
  } catch (error: unknown) {
    message.error(String((error as { message?: string })?.message || '清理失败'))
  } finally {
    taskBusy.value = ''
  }
}

// 任务分页可见且有未完成任务时, 每 5 秒跟着后端队列刷一次状态(后端 job `queue-pump` 每 5 分钟跑一轮)。
let taskTimer: ReturnType<typeof setInterval> | null = null

function stopTaskPolling() {
  if (taskTimer !== null) {
    clearInterval(taskTimer)
    taskTimer = null
  }
}

watch(
  [tab, pendingTasks],
  () => {
    stopTaskPolling()
    if (tab.value === 'tasks' && pendingTasks.value.length > 0) {
      taskTimer = setInterval(() => {
        void props.api.refresh().catch(() => undefined)
      }, 5000)
    }
  },
  { immediate: true },
)

onBeforeUnmount(stopTaskPolling)

// ─────────────────────────── ④ 设置(runtime.rs: settings-update) ───────────────────────────

interface SettingsForm {
  staging_dir: string
  target_dir: string
  quality: string
  max_active: number
  notify_on_fail: boolean
}

const DEFAULTS: SettingsForm = {
  staging_dir: '',
  target_dir: '',
  quality: 'jymaster',
  max_active: 2,
  notify_on_fail: true,
}
/** download.rs `MAX_ACTIVE_CAP`。 */
const MAX_ACTIVE_CAP = 16

const form = reactive<SettingsForm>({ ...DEFAULTS })
const baseline = ref<SettingsForm>({ ...DEFAULTS })

function readSettings(source: Settings): SettingsForm {
  return {
    staging_dir: String(source.staging_dir || ''),
    target_dir: String(source.target_dir || ''),
    quality: String(source.quality || DEFAULTS.quality),
    max_active: Number(source.max_active) > 0 ? Number(source.max_active) : DEFAULTS.max_active,
    notify_on_fail: source.notify_on_fail !== false,
  }
}

function syncForm() {
  const next = readSettings(settings.value)
  Object.assign(form, next)
  baseline.value = next
}

const changedKeys = computed(() => {
  const before = baseline.value
  const keys: string[] = []
  if (form.staging_dir.trim() !== before.staging_dir) keys.push('staging_dir')
  if (form.target_dir.trim() !== before.target_dir) keys.push('target_dir')
  if (form.quality !== before.quality) keys.push('quality')
  if (Number(form.max_active) !== before.max_active) keys.push('max_active')
  if (form.notify_on_fail !== before.notify_on_fail) keys.push('notify_on_fail')
  return keys
})

// 两个 watch 放在 changedKeys 之后: immediate 回调会同步读 changedKeys, 提前注册会踩 TDZ。
// 用户没在编辑(changedKeys 为空)时跟随宿主状态; 切到设置页时也同步一次。
watch(
  () => settings.value,
  () => {
    if (changedKeys.value.length === 0) syncForm()
  },
  { immediate: true, deep: true },
)
watch(tab, (value) => {
  if (value === 'settings') syncForm()
})

const savingSettings = ref(false)

async function saveSettings() {
  if (changedKeys.value.length === 0) {
    message.info('没有改动')
    return
  }
  // 只发改动过的键: 后端按白名单逐键合并, 没提交的键保持原值。
  const patch: Record<string, unknown> = {}
  if (changedKeys.value.includes('staging_dir')) patch.staging_dir = form.staging_dir.trim()
  if (changedKeys.value.includes('target_dir')) patch.target_dir = form.target_dir.trim()
  if (changedKeys.value.includes('quality')) patch.quality = form.quality
  if (changedKeys.value.includes('max_active')) patch.max_active = Number(form.max_active)
  if (changedKeys.value.includes('notify_on_fail')) patch.notify_on_fail = form.notify_on_fail

  savingSettings.value = true
  try {
    const result = await invoke('settings-update', patch)
    if (result.status === 'failed') {
      message.error(String(result.message || '设置保存失败'))
      return
    }
    const saved = (result.data || {}) as Record<string, any>
    if (saved.settings && typeof saved.settings === 'object') {
      const next = readSettings(saved.settings as Settings)
      Object.assign(form, next)
      baseline.value = next
    } else {
      baseline.value = { ...form }
    }
    message.success('设置已保存')
  } catch (error: unknown) {
    message.error(String((error as { message?: string })?.message || '设置保存失败'))
  } finally {
    savingSettings.value = false
  }
}

const qualityOptionsForDefault = computed(() => qualityOptions('netease').concat(
  // 设置里的 quality 是网易档位名(download.rs `DEFAULT_QUALITY`), 但历史值可能是 QQ 档位:
  // 原样带进下拉框, 避免显示成空白。
  sources[1].qualities.filter((value) => !sources[0].qualities.includes(value)).map((value) => ({
    label: `${qualityLabel(value)}(QQ 档位)`,
    value,
  })),
))

const localRoots = computed(() =>
  listOf<RootEntry>(roots.value.roots).filter((root) => root.local === true && root.writable === true),
)

function useRootAs(target: 'staging' | 'target', root: RootEntry) {
  const path = String(root.path || '')
  if (!path) return
  if (target === 'staging') form.staging_dir = path
  else form.target_dir = path
}

const rootProbeNote = computed(() => {
  const probe = roots.value
  if (!probe.ok) {
    return probe.error ? `目录探测失败: ${probe.error}` : '还没有目录探测结果（后端会随状态一起返回）'
  }
  return ''
})
</script>

<template>
  <main class="dian-plugin-page page">
    <header class="head">
      <div>
        <h2>音乐下载</h2>
        <p>网易云 / QQ 音乐 · 宿主代下载（本地暂存 → 复制进目标目录），队列每 5 分钟推进一轮</p>
      </div>
      <div class="row">
        <n-button size="small" secondary :loading="loadingState" @click="refreshState">刷新</n-button>
      </div>
    </header>

    <n-alert v-if="!stateReady" type="error" :show-icon="true" class="alert" title="状态不可用">
      宿主还没有返回本插件的状态文档{{ stateError ? `（${stateError}）` : '' }}。常见原因: runtime 刚重启或更新中,
      `runtime/state` 暂时失败; 或宿主存储不可读(运行时按「只读不落盘」处理)。
      <div class="row" style="margin-top: 6px">
        <n-button size="tiny" secondary :loading="loadingState" @click="loadState">重新读取</n-button>
      </div>
    </n-alert>

    <!-- ① 扫码登录 -->
    <section class="card">
      <h3>扫码登录</h3>
      <div class="row">
        <n-button
          v-for="item in sources"
          :key="item.id"
          size="small"
          :type="loginSource === item.id ? 'primary' : 'default'"
          @click="switchLoginSource(item.id)"
        >
          {{ item.name }}
        </n-button>
        <n-button size="small" type="primary" :loading="qrBusy" :disabled="qrBusy" @click="createQr(loginSource)">
          获取二维码
        </n-button>
        <n-button v-if="qr" size="small" secondary @click="resetQr">关闭</n-button>
      </div>

      <div v-if="qr" class="qr">
        <!-- 网易云: 后端只回登录页 URL, 二维码在前端编码(qr.ts) -->
        <svg
          v-if="qrPath"
          class="qr-svg"
          :viewBox="qrViewBox"
          shape-rendering="crispEdges"
          role="img"
          aria-label="扫码登录二维码"
        >
          <rect width="100%" height="100%" fill="#ffffff" />
          <g transform="translate(4 4)"><path :d="qrPath" fill="#000000" /></g>
        </svg>
        <!-- QQ: 后端回 PNG 直链(`image_mode: fetch_png`), 能不能加载取决于宿主是否放行跨域图片 -->
        <template v-else-if="qr.imageUrl">
          <img v-if="!qrImageFailed" :src="qr.imageUrl" alt="扫码登录二维码" width="220" @error="qrImageFailed = true" />
          <n-alert v-else type="warning" :show-icon="true" class="alert">
            QQ 二维码图片没能加载（宿主可能限制了跨域图片）。可复制下面的地址在手机浏览器里打开:
            <n-text code>{{ qr.imageUrl }}</n-text>
          </n-alert>
        </template>
        <n-alert v-else-if="qrError" type="error" :show-icon="true" class="alert">{{ qrError }}</n-alert>

        <p>{{ qrStatusText }}</p>
        <p v-if="qrMessage" class="hint">{{ qrMessage }}</p>
        <p class="hint">
          {{ sourceName(qr.source) }} · key {{ qr.key }}
          <template v-if="qrPolling"> · 每 2 秒轮询一次</template>
        </p>
      </div>

      <p class="hint">
        登录态由扫码结果写入宿主 KV（本版没有手填 Cookie 的入口）。当前登录状态：
        <n-tag
          v-for="item in loginTags"
          :key="item.key"
          size="small"
          :type="item.ok ? 'success' : 'default'"
          style="margin-right: 6px"
        >
          {{ item.name }} {{ item.ok ? '已登录' : '未登录' }}{{ item.note ? ` · ${item.note}` : '' }}
        </n-tag>
      </p>
      <p class="hint">
        下载与音质依赖对应平台会员：网易云 SVIP（母带/臻音）、QQ 绿钻（FLAC 及以上）。QQ 的微信扫码链路未接到
        action 分发（qq.rs 的 `qr_create_wx` 只单独导出），所以这里只提供 QQ 二维码。
      </p>
    </section>

    <nav class="tabs">
      <button
        v-for="item in [
          { id: 'search', text: '搜索' },
          { id: 'tasks', text: `下载任务${pendingTasks.length ? ` (${pendingTasks.length})` : ''}` },
          { id: 'settings', text: '设置' },
        ]"
        :key="item.id"
        class="tabbtn"
        :class="{ on: tab === item.id }"
        @click="tab = item.id"
      >
        {{ item.text }}
      </button>
    </nav>

    <!-- ② 搜索 -->
    <section v-if="tab === 'search'" class="card">
      <h3>搜索</h3>
      <div class="row">
        <n-button
          v-for="item in sources"
          :key="item.id"
          size="small"
          :type="source === item.id ? 'primary' : 'default'"
          @click="switchSearchSource(item.id)"
        >
          {{ item.name }}
        </n-button>
        <input v-model="query" class="input" placeholder="歌名 歌手" @keydown.enter="runSearch(1)" />
        <n-button type="primary" size="small" :loading="searching" :disabled="searching" @click="runSearch(1)">搜索</n-button>
      </div>

      <table v-if="results.length" class="tbl">
        <thead>
          <tr>
            <th>歌曲</th>
            <th>歌手</th>
            <th>专辑</th>
            <th>音质</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(song, index) in results" :key="`${song.id}-${index}`">
            <td>{{ song.name || '—' }}</td>
            <td>{{ song.singers || '—' }}</td>
            <td class="dim">{{ song.album || '—' }}</td>
            <td>
              <!-- 原生 select: 与原版音乐下载页一致(每首歌单独选一次档位) -->
              <select class="sel" :value="qualityOf(song)" @change="setSongQuality(song, ($event.target as HTMLSelectElement).value)">
                <option v-for="value in qualitiesFor(song.source || source, song)" :key="value" :value="value">
                  {{ qualityLabel(value) }}
                </option>
              </select>
            </td>
            <td>
              <n-button
                size="tiny"
                type="primary"
                :loading="submitting === String(song.id)"
                @click="download(song)"
              >
                下载
              </n-button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="searching" class="hint">搜索中…</p>
      <p v-else class="hint">输入歌名或「歌名 歌手」后回车/点搜索。共 {{ results.length }} 条搜索结果。</p>

      <div v-if="results.length" class="row">
        <n-text depth="3">
          已显示 {{ results.length }} 条{{ searchTotal !== null ? ` / 共 ${searchTotal} 条` : '' }} · 第 {{ searchPage }} 页
        </n-text>
        <n-button v-if="hasMoreResults" size="small" :loading="searching" @click="runSearch(searchPage + 1)">加载更多</n-button>
      </div>
      <p class="hint">
        点「下载」只是入队（去重按 来源+歌曲 id+音质）；真正的取链与下载由后台任务推进，进度看「下载任务」。
        <template v-if="source === 'qq'">QQ 的取链阶梯按所选档位裁剪（母带→全档、无损→F000 起、320→M800 起、128→M500 起），命中不到才逐级向下。</template>
      </p>
    </section>

    <!-- ③ 下载任务 -->
    <section v-else-if="tab === 'tasks'" class="card">
      <div class="row">
        <h3 style="margin: 0">下载任务</h3>
        <n-tag size="small" :bordered="false">共 {{ tasks.length }} 条</n-tag>
        <n-tag v-if="pendingTasks.length" size="small" type="info" :bordered="false">进行中 {{ pendingTasks.length }}</n-tag>
        <n-tag v-if="failedTasks.length" size="small" type="error" :bordered="false">失败 {{ failedTasks.length }}</n-tag>
        <span class="spacer" />
        <n-button size="small" secondary :loading="taskBusy === 'clear'" @click="clearFinished">清理已完成</n-button>
      </div>

      <table v-if="tasks.length" class="tbl">
        <thead>
          <tr>
            <th>歌曲</th>
            <th>状态</th>
            <th>失败原因</th>
            <th>时间</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="task in tasks" :key="task.id">
            <td>
              <div>{{ task.singers ? `${task.singers} - ` : '' }}{{ task.name || '—' }}</div>
              <div class="hint">
                {{ sourceName(String(task.source || '')) }} · {{ qualityLabel(String(task.quality || '')) }} ·
                {{ task.out_name || task.song_id || '' }}
              </div>
            </td>
            <td>
              <n-tag size="small" :type="taskStatusType(task)" :bordered="false">{{ taskStatusLabel(task) }}</n-tag>
              <div v-if="Number(task.attempts) > 0" class="hint">第 {{ task.attempts }} 次尝试</div>
            </td>
            <td class="dim">{{ task.error || (String(task.status) === 'done' ? '—' : '') }}</td>
            <td class="dim">{{ formatMs(task.updated_ms || task.created_ms) }}</td>
            <td>
              <n-button
                v-if="String(task.status) === 'failed'"
                size="tiny"
                secondary
                :loading="taskBusy === String(task.id)"
                @click="retryTask(task)"
              >
                重试
              </n-button>
            </td>
          </tr>
        </tbody>
      </table>
      <n-empty v-else description="暂无任务。去「搜索」页选一首歌点下载。" />

      <p class="hint">
        任务由后台 job `queue-pump`（每 5 分钟，见 manifest）推进；失败任务最多自动重试 3 次，用尽后可在这一行点「重试」，
        或从 Telegram 失败通知的按钮重试。「清理已完成」只删 done/failed，进行中的任务不动。
      </p>
    </section>

    <!-- ④ 设置 -->
    <section v-else class="card">
      <div class="row">
        <h3 style="margin: 0">设置</h3>
        <span class="spacer" />
        <n-button size="small" secondary :disabled="changedKeys.length === 0" @click="syncForm">撤销改动</n-button>
        <n-button
          size="small"
          type="primary"
          :loading="savingSettings"
          :disabled="changedKeys.length === 0"
          @click="saveSettings"
        >
          保存
        </n-button>
      </div>

      <div class="grid">
        <label class="field">
          <span class="label">暂存目录（staging_dir）</span>
          <n-input v-model:value="form.staging_dir" size="small" placeholder="/CloudNAS/115open/音乐/音乐下载" />
          <span class="hint">必须在宿主本地可写根下：先下载到这里的 <code>&lt;短id&gt;.part</code>，再改名复制。</span>
        </label>
        <label class="field">
          <span class="label">目标目录（target_dir）</span>
          <n-input v-model:value="form.target_dir" size="small" placeholder="/CloudNAS/115open/音乐/音乐下载" />
          <span class="hint">最终落点（通常指向 CD2 挂载的音乐目录），由 CD2 负责刮削入库。</span>
        </label>
        <label class="field">
          <span class="label">默认音质（quality）</span>
          <select v-model="form.quality" class="sel">
            <option v-for="option in qualityOptionsForDefault" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <span class="hint">网易云的档位名（后端默认 jymaster）；搜索页每首歌还能单独选。QQ 取链与这里无关。</span>
        </label>
        <label class="field">
          <span class="label">并发下载数（max_active）</span>
          <n-input-number v-model:value="form.max_active" size="small" :min="1" :max="MAX_ACTIVE_CAP" />
          <span class="hint">每轮 pump 同时推进的任务数，1-{{ MAX_ACTIVE_CAP }}（超出会被后端回落到默认 2）。</span>
        </label>
        <label class="field">
          <span class="label">失败时发 Telegram 通知</span>
          <n-switch v-model:value="form.notify_on_fail" size="small" />
          <span class="hint">尝试次数用尽时推送错误通知，通知里带「重试」按钮（callback_data `retry:&lt;短id&gt;`）。</span>
        </label>
      </div>

      <p class="hint">
        保存只提交改动过的键（当前：{{ changedKeys.length ? changedKeys.join(', ') : '无' }}）；后端按白名单合并，没提交的键保持原值。
      </p>

      <n-divider style="margin: 6px 0" />
      <h4 class="sub">目录探测（state.roots）</h4>
      <p v-if="rootProbeNote" class="hint">{{ rootProbeNote }}</p>
      <p v-else class="hint">
        探测结果：暂存目录{{ roots.ok ? (roots.staging_dir_effective ? '可用' : '不可用') : '未知' }} ·
        生效路径 <code>{{ roots.staging_dir_effective || '—' }}</code> · 目标目录 <code>{{ roots.target_dir || '—' }}</code>
      </p>
      <ul v-if="listOf(roots.warnings).length" class="list">
        <li v-for="(warning, index) in listOf(roots.warnings)" :key="index" class="hint">{{ warning }}</li>
      </ul>
      <table v-if="listOf(roots.roots).length" class="tbl">
        <thead>
          <tr><th>路径</th><th>名称</th><th>本地</th><th>可写</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="root in listOf(roots.roots)" :key="root.path">
            <td><code>{{ root.path || '—' }}</code></td>
            <td class="dim">{{ root.name || '—' }}</td>
            <td><n-tag size="tiny" :type="root.local ? 'success' : 'default'" :bordered="false">{{ root.local ? '是' : '否' }}</n-tag></td>
            <td><n-tag size="tiny" :type="root.writable ? 'success' : 'default'" :bordered="false">{{ root.writable ? '是' : '否' }}</n-tag></td>
            <td>
              <n-button v-if="root.local && root.writable" size="tiny" quaternary @click="useRootAs('staging', root)">设为暂存</n-button>
              <n-button v-if="root.writable" size="tiny" quaternary @click="useRootAs('target', root)">设为目标</n-button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="hint">宿主没有返回任何文件根（state.roots.roots 为空）。</p>
    </section>

    <!-- ⑤ 运行日志 -->
    <section class="card">
      <div class="row">
        <h3 style="margin: 0">运行日志</h3>
        <n-text depth="3">最近 {{ logs.length }} 条 · 状态 {{ state.status || '—' }} · revision {{ state.revision ?? '—' }}</n-text>
      </div>
      <p v-if="state.last_message" class="hint">{{ state.last_message }}</p>
      <table v-if="logs.length" class="tbl">
        <tbody>
          <tr v-for="(entry, index) in logs" :key="index">
            <td class="dim">{{ formatAt(entry.at) }}</td>
            <td>
              <n-tag
                size="tiny"
                :bordered="false"
                :type="entry.level === 'warning' ? 'warning' : entry.level === 'error' ? 'error' : 'default'"
              >
                {{ entry.level || 'info' }}
              </n-tag>
            </td>
            <td>{{ entry.message || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="hint">暂无日志</p>
    </section>
  </main>
</template>

<style scoped>
.page {
  display: grid;
  gap: var(--dian-space-4, 16px);
  width: 100%;
  max-width: 100%;
  min-width: 0;
  color: var(--dian-text-primary);
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--dian-space-3, 12px);
  flex-wrap: wrap;
}
h2 {
  margin: 0;
  font-size: 22px;
  color: var(--dian-text-primary);
}
h3 {
  margin: 0 0 8px;
  font-size: 15px;
  color: var(--dian-text-primary);
}
p {
  margin: 4px 0;
  color: var(--dian-text-secondary);
}
.card {
  border: 1px solid var(--dian-border);
  border-radius: var(--dian-radius-lg, 12px);
  background: var(--dian-surface-raised, var(--dian-surface));
  padding: 14px;
  display: grid;
  gap: 8px;
  min-width: 0;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.spacer {
  flex: 1;
}
.input {
  flex: 1;
  min-width: 200px;
  padding: 6px 10px;
  border: 1px solid var(--dian-border);
  border-radius: 8px;
  background: var(--dian-surface);
  color: var(--dian-text-primary);
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.tbl th,
.tbl td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--dian-divider);
  vertical-align: top;
}
.tbl th {
  color: var(--dian-text-muted);
  font-weight: 500;
}
.dim {
  color: var(--dian-text-muted);
}
.hint {
  color: var(--dian-text-muted);
  font-size: 12px;
  margin: 4px 0;
}
.sub {
  margin: 4px 0;
  font-size: 14px;
  color: var(--dian-text-primary);
}
.alert {
  border-radius: var(--dian-radius-sm, 8px);
}
.sel {
  padding: 6px 8px;
  border: 1px solid var(--dian-border);
  border-radius: 8px;
  background: var(--dian-surface);
  color: var(--dian-text-primary);
  max-width: 100%;
}
.qr {
  display: grid;
  justify-items: center;
  gap: 4px;
}
.qr-svg {
  width: 220px;
  height: 220px;
  background: #ffffff;
  border-radius: 8px;
}
.qr img {
  width: 220px;
  height: 220px;
  background: #ffffff;
  border-radius: 8px;
  object-fit: contain;
  image-rendering: pixelated;
}
.tabs {
  display: flex;
  gap: 8px;
}
.tabbtn {
  padding: 6px 14px;
  border: 1px solid var(--dian-border);
  border-radius: 999px;
  background: var(--dian-surface);
  color: var(--dian-text-secondary);
  cursor: pointer;
}
.tabbtn.on {
  background: var(--dian-primary);
  border-color: var(--dian-primary);
  color: var(--dian-primary-contrast, #ffffff);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}
.field {
  display: grid;
  gap: 4px;
  align-content: start;
}
.label {
  font-size: 13px;
  color: var(--dian-text-primary);
}
.list {
  margin: 0;
  padding-left: 18px;
}
code {
  font-family: var(--dian-font-mono, monospace);
  font-size: 12px;
  word-break: break-all;
}

/* 宿主侧边栏打开时 iframe 会变窄: 表格折成单栏卡片 */
@media (max-width: 1000px) {
  .head {
    flex-direction: column;
    align-items: stretch;
  }
  .tbl thead {
    display: none;
  }
  .tbl,
  .tbl tbody,
  .tbl tr,
  .tbl td {
    display: block;
    width: 100%;
  }
  .tbl tr {
    border: 1px solid var(--dian-border);
    border-radius: var(--dian-radius-md, 12px);
    padding: 6px 8px;
    margin-bottom: 8px;
    background: var(--dian-surface-soft, var(--dian-surface));
  }
  .tbl td {
    border-bottom: none;
    padding: 2px 0;
  }
}
</style>
