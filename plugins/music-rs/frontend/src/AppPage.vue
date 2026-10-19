<script setup lang="ts">
// 音乐下载(Rust 版)插件界面 —— Federation 模块 `./AppPage`(见 vite.config.ts / manifest)。
//
// 布局与交互习惯沿用旧 Go 版（已从仓库移除）的界面: 顶部扫码登录卡片 + 搜索/我的歌单/任务/设置
// 四个分页 + 底部记录区。**数据通道换成本插件的 wasm 运行时**:
//   - 状态只读 `props.runtimeState`(宿主注入), 宿主没给时用 `props.api.getState()` 兜底;
//   - 动作一律走 `props.api.invokeAction`, 每次动作后 `await props.api.refresh()`;
//   - 不直接 fetch, 也没有 sidecar(旧版 UI 的 agent-get/agent-post 与 sidecar 回环地址已移除)。
//
// 2026-10 视觉重画(DIAN115 共享规范, 设计图 4/5/6): 页头(登录状态胶囊 + 手动 Cookie + ⚙)
// → 登录卡(左 QR 白底卡 | 右 四步 stepper + 其他登录方式 + 音质档位 chips) → 下划线式 Tabs
// → 各分页卡片 → 最近动作卡 → 页脚。**只换皮, 功能零变动**:
//   - action 名与入参对齐 `src/runtime.rs` 的 action 分发表(见下), 调用时机不变;
//   - 状态读取路径不变(tasks 视图字段 = tasks.rs `state_view` 的 9 个键);
//   - 后端下发的 message / error / logs 原样渲染, 不改写。
//
// action 名与入参对齐 `src/runtime.rs` 的 action 分发表:
//   qr-create{source} / qr-poll{source,key} / search{source,query,page}
//   / playlists{source} / playlist-songs{source,id,page,page_size}
//   / playlist-queue-all{source,id,quality,batch_pages,next_page}(整单分批入队)
//   / download{source,song_id,name,singers,album,level} / settings-update{patch}
//   / task-retry{id} / task-clear{} / pump{}
// 返回形状是 `{result:{status,message,data}}`(见 runtime.rs 的 `action_result`)。
//
// 图标用 @lucide/vue(宿主共享依赖, 与 chase-rs 同款声明, 见 vite.config.ts);
// 主题全靠宿主注入的 --dian-* 变量, 不写主题探测。
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import {
  ClipboardPaste as ClipboardPasteIcon,
  CloudDownload as CloudDownloadIcon,
  Cookie as CookieIcon,
  Eye as EyeIcon,
  EyeOff as EyeOffIcon,
  Inbox as InboxIcon,
  Music as MusicIcon,
  QrCode as QrCodeIcon,
  RefreshCw as RefreshCwIcon,
  RotateCcw as RotateCcwIcon,
  Search as SearchIcon,
  Send as SendIcon,
  Settings as SettingsIcon,
  Trash2 as Trash2Icon,
  TriangleAlert as TriangleAlertIcon,
} from '@lucide/vue'
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

/** 一条下载任务(tasks.rs `Task`; state 里实际是 `state_view` 的索引投影:
 *  id/status/source/song_id/name/singers/quality/error/updated_ms 九个键)。 */
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

/** 下载设置(download.rs `Settings`; state 里是 `settings_view` 的脱敏形态)。 */
interface Settings {
  staging_dir?: string
  target_dir?: string
  quality?: string
  max_active?: number
  notify_on_fail?: boolean
  /** CookieCloud 三项的视图键(download.rs `settings_view` 改名输出): 密钥绝不回显, 只给 ready 布尔。 */
  cc_url?: string
  cc_uuid?: string
  cc_key_ready?: boolean
  /** CD2 直送(0.3.19): 令牌不回显(键名含 token 会被宿主整响应过滤), 只给 ready 布尔;
   *  dest/local_folder 给显式值(空=自动推导), `*_effective` 给实际生效值。 */
  cd2_url?: string
  cd2_auth_ready?: boolean
  cd2_dest_dir?: string
  cd2_dest_dir_effective?: string
  cd2_local_folder?: string
  cd2_local_folder_effective?: string
  cd2_register_host?: string
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
  /** 最近一次插件通知的原始应答留档(download.rs `notify_diag_doc`: {at,status,body}|null)。
   *  status -1 = 传输层失败; 400 是宿主校验拒绝。 */
  notify_diag?: NotifyDiag | null
}

interface NotifyDiag {
  at?: string
  status?: number
  body?: string
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
  /** 本次会话用的有效期秒数(后端 expires_in, 缺省 180)——有效期说明文案按它真实渲染。 */
  expiresInSec: number
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

/** QR 白底卡下方的主/副文案(状态机文案; 后端 qrMessage 另起一行原样渲染)。 */
const qrPane = computed(() => {
  switch (qrStatus.value) {
    case 'scanned':
      return { title: '已扫码', sub: '请在手机上确认' }
    case 'waiting':
      return { title: '等待扫码', sub: `用${sourceName(qr.value?.source || loginSource.value)}音乐 App 扫一扫` }
    case 'expired':
      return { title: '二维码已过期', sub: '请重新获取' }
    case 'success':
      return { title: '登录成功', sub: '登录态已保存' }
    case 'failed':
      return { title: '扫码轮询失败', sub: '可重新获取二维码' }
    default:
      return qrBusy.value
        ? { title: '正在生成二维码…', sub: '' }
        : { title: '尚未生成二维码', sub: '点右侧「获取二维码」开始扫码登录' }
  }
})

/** 四步 stepper: 生成二维码/等待扫码/手机确认/登录成功 —— 按现有 qr 状态机点亮, 不增删状态。
 *  qrStatus: '' → 未开始/生成中; waiting → 等待扫码; scanned → 手机确认; success → 登录成功;
 *  expired/failed → 「等待扫码」一步标红(文案由 qrPane/qrMessage 说明)。 */
type StepState = 'done' | 'active' | 'pending' | 'error'
const qrSteps = computed<{ label: string; state: StepState }[]>(() => {
  const status = qrStatus.value
  const step1: StepState = status === '' ? (qrBusy.value ? 'active' : 'pending') : 'done'
  const step2: StepState =
    status === 'waiting'
      ? 'active'
      : status === 'scanned' || status === 'success'
        ? 'done'
        : status === 'expired' || status === 'failed'
          ? 'error'
          : 'pending'
  const step3: StepState = status === 'scanned' ? 'active' : status === 'success' ? 'done' : 'pending'
  const step4: StepState = status === 'success' ? 'done' : 'pending'
  return [
    { label: '生成二维码', state: step1 },
    { label: '等待扫码', state: step2 },
    { label: '手机确认', state: step3 },
    { label: '登录成功', state: step4 },
  ]
})

/** 有效期分钟数(按本次会话真实 expires_in 换算; 没有会话时返回 0 由模板收起该行)。 */
const qrExpiresMinutes = computed(() => {
  const session = qr.value
  if (!session) return 0
  return Math.max(1, Math.round(session.expiresInSec / 60))
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

/** 页头状态胶囊: 跟随登录卡当前选中的来源(loginSource), 绿=已登录 / 琥珀=未登录。 */
const headLogin = computed(() => {
  const info = login.value[loginSource.value] || {}
  return { ok: info.logged_in === true, sourceLabel: sourceName(loginSource.value) }
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
}

// ── 手动粘贴 Cookie(宿主 broker 剥离外部响应的 Set-Cookie, 网易/QQ 扫码都拿不到登录态) ──
const cookieText = ref('')
const pasteBusy = ref(false)
/** 「粘贴整行 Cookie」面板的开合(纯前端态; 页头「手动 Cookie」与登录卡按钮都开它)。 */
const cookiePanelOpen = ref(false)
const loginCardRef = ref<HTMLElement | null>(null)

function openCookiePanel() {
  cookiePanelOpen.value = true
  loginCardRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function pasteCookie() {
  const raw = cookieText.value.trim()
  if (!raw) {
    message.warning('请先粘贴 Cookie 头（浏览器 F12 → Network → 任意请求 → 请求头里的 Cookie 整行）')
    return
  }
  pasteBusy.value = true
  try {
    // 输入键沿用 `qq_cookie`/`netease_cookie`; 响应键是 `qq_login`/`netease_login`
    // (宿主 2026-09-30 递归拒绝 action 响应里键名含 "cookie" 子串的整个响应)。
    const key = loginSource.value === 'qq' ? 'qq_cookie' : 'netease_cookie'
    const resultKey = loginSource.value === 'qq' ? 'qq_login' : 'netease_login'
    const result = await invoke('settings-update', { [key]: raw })
    const info = (result[resultKey] || {}) as Record<string, unknown>
    if (info.status === 'failed') {
      message.error(String(info.message || 'Cookie 保存失败'))
    } else {
      message.success(`${sourceName(loginSource.value)} Cookie 已保存`)
      cookieText.value = ''
    }
  } catch (error: unknown) {
    message.error(String((error as { message?: string })?.message || error))
  } finally {
    pasteBusy.value = false
  }
}

// ── CookieCloud 同步(地址/UUID/口令在「设置」页配置, 这里一键拉取两侧登录态) ──
const ccSyncBusy = ref(false)

async function syncFromCookieCloud() {
  ccSyncBusy.value = true
  try {
    // 无入参: 后端从 KV 设置里取 URL/UUID/口令(runtime.rs 分发表; 成功 data 形状见 cookiecloud.rs)。
    const result = await invoke('cookiecloud-sync')
    if (result.status === 'failed') {
      message.error(String(result.message || 'CookieCloud 同步失败'))
      return
    }
    const data = (result.data || {}) as Record<string, any>
    const side = (value: unknown): Record<string, any> =>
      value && typeof value === 'object' ? (value as Record<string, any>) : {}
    const netease = side(data.netease)
    const qq = side(data.qq)
    message.success(
      `CookieCloud 同步完成 —— 网易云: 保存 ${Number(netease.saved) || 0} 条, ${
        netease.logged_in === true ? '已登录' : '未登录'
      }; QQ: 保存 ${Number(qq.saved) || 0} 条, ${qq.logged_in === true ? '已登录' : '未登录'}`,
    )
    // 与扫码成功同款收尾: invoke 里已 refresh, 这里再兜底一次让「当前登录状态」标签立刻跟上。
    await refreshState()
  } catch (error: unknown) {
    message.error(String((error as { message?: string })?.message || error || 'CookieCloud 同步失败'))
  } finally {
    ccSyncBusy.value = false
  }
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
      expiresInSec: expiresIn,
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
      if (data.logged_in === true) {
        message.success('登录成功')
      } else {
        // 宿主剥离 Set-Cookie: 扫码成功但登录态没拿到, 后端 message 里带了引导文案
        message.warning(String(data.message || '扫码成功，但未能取得登录 Cookie；请改用下方「手动粘贴 Cookie」'))
      }
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

/**
 * 单曲入队(搜索页 / 歌单曲目行)。
 *
 * 失败一律就地处理并返回 false: 业务 failed 与协议层失败(运行时重启窗口等 invoke reject)
 * 都被 try/catch 吞下, **绝不向外抛异常** —— 这样即便被逐首循环调用也不会中断整批,
 * 调用方只需按返回值累计"N 首失败, 可重试"。当前页面除后端分批的整单下载外没有逐首循环,
 * 单曲按钮失败只弹一条错误。
 *
 * 0.3.15: 队列互斥把入队挡下时后端回 skipped(runtime.rs:456-468) —— 什么都没做,
 * 也返回 false(没入队, 可重试), 但弹 warning: 既不能报「已入队」, 也不是业务失败。
 * 同一份后端 message 原文同时进「下载任务」卡的互斥警告条(mutexNotice)。
 */
async function download(song: Song): Promise<boolean> {
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
      message.error(loginHint(String(result.message || '下载失败')))
      return false
    }
    // 0.3.15: 队列互斥(单曲入队/整单入队/推进)撞车时后端回 skipped —— 什么都没做,
    // 不是成功(没入队)也不是失败; 提示稍后再试, 绝不弹「已入队」。
    if (result.status === 'skipped') {
      noteQueueBusy(String(result.message || '队列正在推进或入队, 本次未入队, 请稍后再试'))
      return false
    }
    const data = (result.data || {}) as Record<string, any>
    const deduped = data.deduped === true
    message.success(
      deduped
        ? `队列里已有同一首（${qualityLabel(String(data.quality || qualityOf(song)))}），已复用任务 ${data.task_id || ''}`
        : `已入队: ${song.name || key} · ${qualityLabel(String(data.quality || qualityOf(song)))}`,
    )
    return true
  } catch (error: unknown) {
    message.error(String((error as { message?: string })?.message || '下载失败'))
    return false
  } finally {
    submitting.value = ''
  }
}

// ─────────────────────────── ③ 我的歌单(runtime.rs: playlists / playlist-songs) ───────────────────────────
//
// 交互沿用旧 Go 版的歌单页: 卡片列表(name/count/creator) → 点开分页曲目
// (每页 100, 加载更多; 仅用于浏览) → 每首歌独立音质下拉(浏览用) → 整单入队。
// 调用换成 invoke('playlists', {source}) / invoke('playlist-songs', {source,id,page,page_size});
// 「整单下载」走 `playlist-queue-all` 后端分批翻页入队(见 downloadPlaylistAll), 与已加载的曲目条数解耦。
// 后端只落地网易云(runtime.rs:643-655), 其他来源报「该来源暂不支持歌单，先支持网易云」;
// 未登录报「未登录或登录态失效」(netease.rs:883), 前端补一句"去登录卡扫码"。

/** 歌单卡片(netease.rs `playlists` 的返回项)。 */
interface Playlist {
  id?: string
  name?: string
  cover?: string
  count?: number
  creator?: string
}

const PLAYLIST_PAGE_SIZE = 100
/** 未登录报错的关键字(netease.rs `netease_account` 的文案)。 */
const NOT_LOGIN_KEYWORD = '未登录'

const playlists = ref<Playlist[]>([])
const playlistsLoading = ref(false)
const playlistView = ref<{ id: string; name: string } | null>(null)
const plName = ref('')
const plSongs = ref<Song[]>([])
const plTotal = ref(0)
const plPage = ref(1)
const plLoading = ref(false)
const plBatchBusy = ref(false)
/** 整单下载统一音质(后端 `quality` 入参); 与每行浏览用的下拉互不影响。 */
const plBatchQuality = ref('jymaster')
/** 整单入队的进行中/结束文案("已入队 X 首(去重 Y), 进度 Z/total")。 */
const plBatchProgress = ref('')
/** 每轮 `playlist-queue-all` 翻的页数(5 页 = 500 首; 后端缺省 5、上限 10)。 */
const PLAYLIST_BATCH_PAGES = 5

/** 接口报「未登录或登录态失效」时, 把"去哪扫码"一起说清楚。 */
function loginHint(text: string): string {
  return text.includes(NOT_LOGIN_KEYWORD) ? `${text} —— 先在上方「扫码登录」卡片扫码登录` : text
}

function switchTab(id: string) {
  tab.value = id
  if (id !== 'playlists') return
  if (source.value !== 'netease') {
    message.warning('该来源暂不支持歌单，先支持网易云')
    return
  }
  // 懒加载: 第一次点到这个 tab 才拉歌单, 之后不重复拉(想重拉点「刷新」)。
  if (!playlists.value.length && !playlistView.value && !playlistsLoading.value) void loadPlaylists()
}

function switchPlaylistSource(src: string) {
  if (source.value === src) return
  switchSearchSource(src) // 与搜索页共用同一个 source, 换来源时搜索结果一并清掉
  playlists.value = []
  closePlaylistView()
  if (src !== 'netease') message.warning('该来源暂不支持歌单，先支持网易云')
  else void loadPlaylists()
}

async function loadPlaylists() {
  if (source.value !== 'netease') {
    message.warning('该来源暂不支持歌单，先支持网易云')
    return
  }
  playlistsLoading.value = true
  try {
    const result = await invoke('playlists', { source: source.value })
    if (result.status === 'failed') {
      message.error(loginHint(String(result.message || '歌单获取失败')))
      return
    }
    const data = (result.data || {}) as Record<string, any>
    playlists.value = listOf<Playlist>(data.playlists)
    if (!playlists.value.length) message.info('没有取到歌单（可能还没登录）')
  } catch (error: unknown) {
    message.error(loginHint(String((error as { message?: string })?.message || error || '歌单获取失败')))
  } finally {
    playlistsLoading.value = false
  }
}

function closePlaylistView() {
  playlistView.value = null
  plName.value = ''
  plSongs.value = []
  plTotal.value = 0
  plPage.value = 1
}

async function openPlaylist(playlist: Playlist) {
  const id = String(playlist.id ?? '')
  if (!id) return
  playlistView.value = { id, name: String(playlist.name || '') }
  plName.value = String(playlist.name || '')
  plSongs.value = []
  plTotal.value = Number(playlist.count) || 0
  plPage.value = 1
  await fetchPlaylistSongs(1)
}

async function fetchPlaylistSongs(page: number) {
  const view = playlistView.value
  if (!view) return
  plLoading.value = true
  try {
    const result = await invoke('playlist-songs', {
      source: source.value,
      id: view.id,
      page,
      page_size: PLAYLIST_PAGE_SIZE,
    })
    if (result.status === 'failed') {
      message.error(loginHint(String(result.message || '歌单内容获取失败')))
      return
    }
    const data = (result.data || {}) as Record<string, any>
    const songs = listOf<Song>(data.songs)
    plSongs.value = page > 1 ? [...plSongs.value, ...songs] : songs
    plPage.value = page
    if (data.name) plName.value = String(data.name)
    if (typeof data.total === 'number') plTotal.value = data.total
  } catch (error: unknown) {
    message.error(loginHint(String((error as { message?: string })?.message || error || '歌单内容获取失败')))
  } finally {
    plLoading.value = false
  }
}

/**
 * 整单下载(0.3.14): 循环调 `playlist-queue-all` 让后端分批翻页整单入队。
 *
 * 每轮固定 `batch_pages=5`(500 首)、统一 `quality`; 后端返回 `{queued,deduped,total_seen,next_page,has_more}`,
 * `has_more` 为 true 就带着上一轮的 `next_page` 继续下一轮, 取尽(has_more=false)、某轮业务失败
 * 或某轮被队列互斥跳过(0.3.15 的 `skipped`, runtime.rs:424-430)即停。
 * 每轮之间不人为延时(action 自身串行, 后端逐页取歌也串行)。
 *
 * 与歌单曲目列表的分页浏览**完全解耦**: 这里不再读 `plSongs`, 只认歌单 id,
 * 所以不需要先把 100 首「加载更多」到底 —— 100 首限制由此解除。
 * 全程按钮 loading; 结束(完成/失败/跳过)都弹汇总, 业务失败与跳过时已入队的不丢。
 */
async function downloadPlaylistAll() {
  const view = playlistView.value
  if (!view) {
    message.warning('请先打开一个歌单')
    return
  }
  plBatchBusy.value = true
  plBatchProgress.value = ''
  // total 来自歌单卡片/接口的整单数量(与已加载条数无关); 拿不到就只显示进度分子。
  const total = plTotal.value > 0 ? plTotal.value : 0
  let queued = 0
  let deduped = 0
  let seen = 0
  let nextPage = 1
  /** 真正的失败/防御性中止(报 error)。 */
  let stopped = ''
  /** 0.3.15: 被队列互斥跳过(什么都没做, 报 warning, 不算失败)。 */
  let skipped = ''
  try {
    for (;;) {
      let result: RuntimeCallback['result'] = {}
      try {
        result = await invoke('playlist-queue-all', {
          source: 'netease',
          id: view.id,
          quality: plBatchQuality.value,
          batch_pages: PLAYLIST_BATCH_PAGES,
          next_page: nextPage,
        })
      } catch (error: unknown) {
        // 协议层失败(运行时重启窗口等): 结束循环, 已入队的不丢。
        stopped = String((error as { message?: string })?.message || error || '整单入队请求失败')
        break
      }
      const data = (result.data || {}) as Record<string, any>
      // 业务失败也会回传已入队计数: 先累加再判失败, 保证「已入队不丢」。
      queued += Number(data.queued) || 0
      deduped += Number(data.deduped) || 0
      seen += Number(data.total_seen) || 0
      plBatchProgress.value = batchProgressText(queued, deduped, seen, total)
      // 0.3.15: 队列互斥把本批挡下 —— 后端什么都没做(游标停在请求的起始页),
      // 不是失败, 更不能掉进下面的游标守卫误报「入队游标没有前进」; 收尾提示稍后再试。
      if (result.status === 'skipped') {
        skipped = String(result.message || '队列正在推进或入队, 本批未入队, 请稍后再试')
        break
      }
      if (result.status === 'failed') {
        stopped = String(result.message || '整单入队失败')
        break
      }
      if (data.has_more !== true) break // 取尽: 后端说没有下一页了
      const cursor = Number(data.next_page)
      if (!Number.isFinite(cursor) || cursor <= nextPage) {
        // 防御: 后端没按 next_page 前进时避免同页无限重复请求(正常后端 next_page 恒指向下一页)。
        stopped = '入队游标没有前进(后端未按 next_page 续跑), 已停止以免重复请求'
        break
      }
      nextPage = cursor
    }
    if (skipped) {
      // 互斥原文进「下载任务」卡的警告条(与 toast 并列, 不是替代)。
      noteQueueBusy(skipped)
      message.warning(`${skipped}；已入队 ${queued} 首(去重 ${deduped})，未完成的可稍后再试`)
    } else if (stopped) {
      message.error(`${loginHint(stopped)}；已入队 ${queued} 首(去重 ${deduped})，未完成的可重试`)
    } else {
      message.success(
        `整单入队完成：新增 ${queued} 首，去重 ${deduped} 首${
          seen > 0 ? `（共处理 ${seen}${total > 0 ? `/${total}` : ''} 首）` : ''
        }，进度去「下载任务」tab 看`,
      )
    }
  } finally {
    plBatchBusy.value = false
  }
}

/** "已入队 X 首(去重 Y), 进度 Z/total"(total 未知时只给分子)。 */
function batchProgressText(queued: number, deduped: number, seen: number, total: number): string {
  return `已入队 ${queued} 首(去重 ${deduped}), 进度 ${seen}${total > 0 ? `/${total}` : ''}`
}

// ─────────────────────────── ④ 任务列表(runtime.rs: task-retry / task-clear / pump) ───────────────────────────

const taskBusy = ref('')

/**
 * 队列互斥警告条(设计图第三态): 后端把 pump / 单曲入队 / 整单入队的撞车回成
 * `skipped` + message(download.rs `queue_busy_value`), state 里没有持久字段,
 * 所以这里记下最近一次互斥的 message 原文, 在「下载任务」卡顶部亮黄色警告条;
 * 「知道了」只是前端关掉它, 不调任何动作。toast 维持不变。
 */
const mutexNotice = ref('')

function noteQueueBusy(text: string) {
  const trimmed = text.trim()
  if (trimmed) mutexNotice.value = trimmed
}

const statusMeta: Record<string, { label: string; type: 'default' | 'info' | 'success' | 'warning' | 'error' }> = {
  queued: { label: '排队中', type: 'default' },
  downloading: { label: '下载中', type: 'info' },
  copying: { label: '入库中', type: 'info' },
  done: { label: '下载完成', type: 'success' },
  failed: { label: '下载失败', type: 'error' },
}

function taskStatusLabel(task: Task): string {
  return statusMeta[String(task.status || '')]?.label || String(task.status || '未知')
}

/** 任务行右侧徽标的样式档位: 下载中/入库中 = 主色实心白字; 排队 = 信息浅底;
 *  完成 = 绿; 失败 = 红; 其余(含未来新状态) = 中性灰, 文案原样。 */
function taskBadgeClass(task: Task): string {
  switch (String(task.status || '')) {
    case 'downloading':
    case 'copying':
      return 'badge-solid'
    case 'queued':
      return 'badge-info'
    case 'done':
      return 'badge-success'
    case 'failed':
      return 'badge-error'
    default:
      return 'badge-neutral'
  }
}

/** 任务行左侧图标瓦片的底色档位(随状态: 下载中蓝/完成绿/失败红/排队蓝灰/其他灰)。 */
function taskTileClass(task: Task): string {
  switch (String(task.status || '')) {
    case 'downloading':
    case 'copying':
      return 'tile-primary'
    case 'queued':
      return 'tile-info'
    case 'done':
      return 'tile-success'
    case 'failed':
      return 'tile-error'
    default:
      return 'tile-muted'
  }
}

/** 进度条仅下载中/入库中显示。state 视图没有进度字节字段(tasks.rs `state_view`
 *  只下发 9 个键), 所以是不定态动画条, 不显示百分比 —— 绝不硬编假值。 */
function taskInFlight(task: Task): boolean {
  const status = String(task.status || '')
  return status === 'downloading' || status === 'copying'
}

/**
 * 排队位次("第 N 位"): state 视图按 updated_ms 倒序(tasks.rs `sort_index`),
 * 而入队时 persist_task 把新条目追加后整体按同规则排序、pump 从索引头开始取
 * 第一个 queued(download.rs:1756) —— 所以视图里越靠前的 queued 越先被推进,
 * 位次 = 它在视图内 queued 子序列里的名次。重试过的条目 updated_ms 会刷新,
 * 可能与索引内真实位置略有出入, 这是视图数据能给出的最诚实口径。
 */
const queuedOrder = computed(() => tasks.value.filter((task) => String(task.status || '') === 'queued'))

function queuePosition(task: Task): number {
  const index = queuedOrder.value.findIndex((item) => item.id === task.id)
  return index >= 0 ? index + 1 : 0
}

/** 排队徽标文案: 能定位就给「排队中 · 第 N 位」, 定位不到退回「排队中」。 */
function queuedBadgeText(task: Task): string {
  const position = queuePosition(task)
  return position > 0 ? `排队中 · 第 ${position} 位` : '排队中'
}

/** 最近动作时间(设计图 HH:MM:SS; 不做时区换算, 按后端原文截取)。 */
function formatTime(value: unknown): string {
  const raw = typeof value === 'string' ? value : ''
  if (!raw) return '—'
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw)
  return match ? `${match[4]}:${match[5]}:${match[6] || '00'}` : raw
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

async function pumpQueue() {
  taskBusy.value = 'pump'
  try {
    // 无入参: 与定时 job `queue-pump` 走同一个函数(runtime.rs:508, tasks::queue_pump
    // → download::pump), 单次只新开 1 首, 连点几次是安全的吞吐兜底。
    const result = await invoke('pump')
    if (result.status === 'failed') {
      message.error(String(result.message || '推进失败'))
      return
    }
    // 0.3.15: 与定时 job `queue-pump`/入队撞车时后端回 skipped(runtime.rs:566-577) ——
    // 本轮什么都没推进, 提示稍后再试, 绝不弹「已推进」。
    if (result.status === 'skipped') {
      noteQueueBusy(String(result.message || '上一轮队列推进仍在进行, 本次跳过, 请稍后再试'))
      message.warning(String(result.message || '上一轮队列推进仍在进行, 本次跳过, 请稍后再试'))
      return
    }
    // 摘要是 `{queued,active,started,completed,failed,messages}`(download.rs 末尾的 json!),
    // messages 是这一轮真正推过的事件文案(取链/提交/入库/失败原因)。
    const data = (result.data || {}) as Record<string, any>
    const lines = listOf<unknown>(data.messages)
      .map((item) => String(item || '').trim())
      .filter((text) => text.length > 0)
    const head = lines.slice(0, 3)
    message.success(
      head.length > 0
        ? head.join('；')
        : `已推进（排队 ${Number(data.queued) || 0} · 进行中 ${Number(data.active) || 0}）`,
    )
  } catch (error: unknown) {
    message.error(String((error as { message?: string })?.message || '推进失败'))
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

/**
 * 索引对账(task-adopt, 0.3.19): 分片 `task.<id>` 在、索引里丢了(两阶段写入被打断,
 * 如容器重启)的“僵尸任务”手动挂回队列; 已在索引里则回 adopted:false。
 */
const adoptId = ref('')

async function adoptTask() {
  const id = adoptId.value.trim()
  if (!id) {
    message.info('请输入任务 id（下载任务页可见，如 2gexs25y）')
    return
  }
  taskBusy.value = 'adopt'
  try {
    const result = await invoke('task-adopt', { id })
    if (result.status === 'failed') {
      message.error(String(result.message || '对账失败'))
      return
    }
    const data = (result.data || {}) as Record<string, any>
    if (data.adopted) {
      adoptId.value = ''
      message.success(String(data.message || '已挂回索引'))
    } else {
      message.info(String(data.message || '已在索引里，无需对账'))
    }
  } catch (error: unknown) {
    message.error(String((error as { message?: string })?.message || '对账失败'))
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

// ─────────────────────────── ⑤ 设置(runtime.rs: settings-update) ───────────────────────────

interface SettingsForm {
  staging_dir: string
  target_dir: string
  quality: string
  max_active: number
  notify_on_fail: boolean
  /** CookieCloud: 视图只回显 cc_url/cc_uuid; 密钥只在提交时发送, 输入框不回显。 */
  cc_url: string
  cc_uuid: string
  cc_key: string
  /** CD2 直送(0.3.19): 令牌同 CookieCloud 密钥的处理方式(不回显, 只在提交时发)。 */
  cd2_url: string
  cd2_token: string
  cd2_dest_dir: string
  cd2_local_folder: string
  cd2_register_host: string
}

/** CookieCloud 服务端默认地址(download.rs `DEFAULT_COOKIECLOUD_URL`, URL 清空后后端也回落到它)。 */
const DEFAULT_CC_URL = 'http://127.0.0.1:8088'
/** CD2 本机 gRPC-Web 默认地址(download.rs `DEFAULT_CD2_URL`; 与宿主同 network 时用回环)。 */
const DEFAULT_CD2_URL = 'http://127.0.0.1:19798'

const DEFAULTS: SettingsForm = {
  staging_dir: '',
  target_dir: '',
  quality: 'jymaster',
  max_active: 2,
  notify_on_fail: true,
  cc_url: DEFAULT_CC_URL,
  cc_uuid: '',
  cc_key: '',
  cd2_url: DEFAULT_CD2_URL,
  cd2_token: '',
  cd2_dest_dir: '',
  cd2_local_folder: '',
  cd2_register_host: '',
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
    // 视图键是改名后的 cc_url/cc_uuid(download.rs `settings_view`); 密钥不在视图里, 恒为空串。
    cc_url: String(source.cc_url || DEFAULT_CC_URL),
    cc_uuid: String(source.cc_uuid || ''),
    cc_key: '',
    // CD2: 编辑对象是**显式值**(空=跟随推导, 推导结果在提示里显示为 cd2_*_effective);
    // 令牌同密钥, 恒为空串。
    cd2_url: String(source.cd2_url || DEFAULT_CD2_URL),
    cd2_token: '',
    cd2_dest_dir: String(source.cd2_dest_dir || ''),
    cd2_local_folder: String(source.cd2_local_folder || ''),
    cd2_register_host: String(source.cd2_register_host || ''),
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
  // CookieCloud 三项按后端原字段名提交(入参不受视图改名限制); 密钥只在非空时算改动。
  if (form.cc_url.trim() !== before.cc_url) keys.push('cookiecloud_url')
  if (form.cc_uuid.trim() !== before.cc_uuid) keys.push('cookiecloud_uuid')
  if (form.cc_key.trim() !== before.cc_key) keys.push('cookiecloud_key')
  // CD2 五项同规则(settings-update 的 cd2_url / cd2_token / cd2_dest_dir / cd2_local_folder / cd2_register_host)。
  if (form.cd2_url.trim() !== before.cd2_url) keys.push('cd2_url')
  if (form.cd2_token.trim() !== before.cd2_token) keys.push('cd2_token')
  if (form.cd2_dest_dir.trim() !== before.cd2_dest_dir) keys.push('cd2_dest_dir')
  if (form.cd2_local_folder.trim() !== before.cd2_local_folder) keys.push('cd2_local_folder')
  if (form.cd2_register_host.trim() !== before.cd2_register_host) keys.push('cd2_register_host')
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
/** CookieCloud 密钥的明文/密文切换(纯前端态; 对应旧版 NInput 的 show-password-on)。 */
const showCcKey = ref(false)
/** CD2 令牌的明文/密文切换。 */
const showCd2Token = ref(false)

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
  if (changedKeys.value.includes('cookiecloud_url')) patch.cookiecloud_url = form.cc_url.trim()
  if (changedKeys.value.includes('cookiecloud_uuid')) patch.cookiecloud_uuid = form.cc_uuid.trim()
  if (changedKeys.value.includes('cookiecloud_key')) patch.cookiecloud_key = form.cc_key.trim()
  if (changedKeys.value.includes('cd2_url')) patch.cd2_url = form.cd2_url.trim()
  if (changedKeys.value.includes('cd2_token')) patch.cd2_token = form.cd2_token.trim()
  if (changedKeys.value.includes('cd2_dest_dir')) patch.cd2_dest_dir = form.cd2_dest_dir.trim()
  if (changedKeys.value.includes('cd2_local_folder')) patch.cd2_local_folder = form.cd2_local_folder.trim()
  if (changedKeys.value.includes('cd2_register_host')) patch.cd2_register_host = form.cd2_register_host.trim()

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
      // 响应里拿不到设置视图时按已提交值对齐 baseline; 密钥除外(见下)。
      baseline.value = { ...form, cc_key: '', cd2_token: '' }
    }
    // 密钥不回显(state 与响应都不给): 保存成功后立即清掉输入框, 配置与否看「已配置」标记。
    form.cc_key = ''
    form.cd2_token = ''
    message.success('设置已保存')
  } catch (error: unknown) {
    message.error(String((error as { message?: string })?.message || '设置保存失败'))
  } finally {
    savingSettings.value = false
  }
}

/** 通知自检(0.3.19): 主动发一条测试通知, 把宿主对 /api/notifications/plugin 的
 *  **原始应答**展示出来 —— 2026-10 起自动失败通知在真机上全是 400(宿主本地校验
 *  秒拒), 这是把原因带回给开发者的现场诊断口。 */
const notifyBusy = ref(false)
const notifyResult = ref('')

async function testNotify() {
  notifyBusy.value = true
  try {
    const result = await invoke('notify-test')
    if (result.status === 'failed') {
      notifyResult.value = String(result.message || '通知自检失败')
      message.error(notifyResult.value)
      return
    }
    const data = (result.data || {}) as Record<string, any>
    const status = data.status === undefined || data.status === null ? '—' : String(data.status)
    const parts = [`HTTP ${status}`]
    if (data.message) parts.push(String(data.message))
    if (data.channels) parts.push(`通道: ${String(data.channels)}`)
    if (data.body) parts.push(`原始应答: ${String(data.body)}`)
    notifyResult.value = parts.join(' · ')
    if (data.sent) message.success(notifyResult.value)
    else message.warning(notifyResult.value)
  } catch (error: unknown) {
    notifyResult.value = String((error as { message?: string })?.message || '通知自检失败')
    message.error(notifyResult.value)
  } finally {
    notifyBusy.value = false
  }
}

/** 最近一次通知留档(后端每次发通知都写 KV `notifydiag`, pump 收尾落盘;
 *  status -1 = 传输层失败, 400 = 宿主校验拒绝)。 */
const notifyDiagText = computed(() => {
  const diag = state.value.notify_diag
  if (!diag || typeof diag !== 'object') return ''
  const status = Number(diag.status)
  const head = status === -1 ? '传输层失败' : `HTTP ${Number.isFinite(status) ? status : '—'}`
  const at = String(diag.at || '')
  const body = String(diag.body || '')
  return `留档${at ? `（${at}）` : ''}: ${head}${body ? ` · ${body}` : ''}`
})

const qualityOptionsForDefault = computed(() => qualityOptions('netease').concat(
  // 设置里的 quality 是网易档位名(download.rs `DEFAULT_QUALITY`), 但历史值可能是 QQ 档位:
  // 原样带进下拉框, 避免显示成空白。
  sources[1].qualities.filter((value) => !sources[0].qualities.includes(value)).map((value) => ({
    label: `${qualityLabel(value)}(QQ 档位)`,
    value,
  })),
))

/** 登录卡「音质档位」chips: 可选档位 = 网易档位表(+历史 QQ 档位原样带入),
 *  选中 = state.settings.quality(真实默认)。纯展示 —— 改默认仍走「设置」tab 的
 *  settings-update, 不在登录卡新增动作触发点。 */
const qualityChips = computed(() => qualityOptionsForDefault.value)
const defaultQuality = computed(() => String(settings.value.quality || DEFAULTS.quality))

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
    <!-- 页头: 图标瓦片 + 标题 + 副题 | 状态胶囊 + 手动 Cookie + 刷新 + ⚙ -->
    <header class="head">
      <div class="head-left">
        <div class="head-icon"><MusicIcon :size="22" /></div>
        <div class="head-text">
          <h1>音乐下载</h1>
          <p>扫码登录网易云 / QQ 音乐 · 下载至 115 网盘 · 队列自动推进</p>
        </div>
      </div>
      <div class="head-right">
        <span class="badge" :class="headLogin.ok ? 'badge-success' : 'badge-warning'">
          <span class="badge-dot" />{{ headLogin.ok ? '已登录' : '未登录' }} · {{ headLogin.sourceLabel }}
        </span>
        <button type="button" class="btn btn-ghost" @click="openCookiePanel">
          <CookieIcon :size="14" /> 手动 Cookie
        </button>
        <button
          type="button"
          class="icon-btn"
          title="刷新状态"
          :disabled="loadingState"
          @click="refreshState"
        >
          <RefreshCwIcon :size="15" :class="{ 'rot-spin': loadingState }" />
        </button>
        <button type="button" class="icon-btn" title="设置" @click="switchTab('settings')">
          <SettingsIcon :size="16" />
        </button>
      </div>
    </header>

    <!-- 状态文档不可用(宿主刚重启/更新窗口): 错误可重试态 -->
    <div v-if="!stateReady" class="bar bar-error">
      <span class="bar-icon">!</span>
      <div class="bar-body">
        <strong>状态不可用</strong>
        <p>
          宿主还没有返回本插件的状态文档{{ stateError ? `（${stateError}）` : '' }}。常见原因: runtime 刚重启或更新中,
          `runtime/state` 暂时失败; 或宿主存储不可读(运行时按「只读不落盘」处理)。
        </p>
      </div>
      <button type="button" class="btn btn-danger btn-sm" :disabled="loadingState" @click="loadState">
        <span v-if="loadingState" class="spin" />重新读取
      </button>
    </div>

    <!-- ① 登录卡: 左 QR 白底卡 | 右 stepper + 其他登录方式 + 音质档位 -->
    <section ref="loginCardRef" class="card login-card">
      <div class="login-grid">
        <div class="qr-pane">
          <div class="qr-box">
            <template v-if="qr">
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
              <img
                v-else-if="qr.imageUrl && !qrImageFailed"
                :src="qr.imageUrl"
                alt="扫码登录二维码"
                @error="qrImageFailed = true"
              />
              <div v-else-if="qr.imageUrl && qrImageFailed" class="qr-fallback">
                <TriangleAlertIcon :size="18" />
                <span>QQ 二维码图片没能加载（宿主可能限制了跨域图片）。可复制下面的地址在手机浏览器里打开:</span>
                <code>{{ qr.imageUrl }}</code>
              </div>
              <div v-else-if="qrError" class="qr-fallback qr-fallback-error">{{ qrError }}</div>
              <div v-else class="qr-fallback"><QrCodeIcon :size="28" /><span>二维码内容为空</span></div>
            </template>
            <div v-else class="qr-fallback">
              <QrCodeIcon :size="28" />
              <span>{{ qrBusy ? '生成中…' : '未生成' }}</span>
            </div>
          </div>
          <div class="qr-title">{{ qrPane.title }}</div>
          <div class="qr-sub">{{ qrPane.sub }}</div>
          <p v-if="qrMessage" class="hint">{{ qrMessage }}</p>
          <p v-if="qr" class="hint qr-meta">
            {{ sourceName(qr.source) }} · key {{ qr.key }}
            <template v-if="qrPolling"> · 每 2 秒轮询一次</template>
          </p>
        </div>

        <div class="login-side">
          <div class="row">
            <span class="seg">
              <button
                v-for="item in sources"
                :key="item.id"
                type="button"
                :class="{ on: loginSource === item.id }"
                @click="switchLoginSource(item.id)"
              >
                {{ item.name }}
              </button>
            </span>
            <button type="button" class="btn btn-primary" :disabled="qrBusy" @click="createQr(loginSource)">
              <span v-if="qrBusy" class="spin" />获取二维码
            </button>
            <button v-if="qr" type="button" class="btn btn-ghost btn-sm" @click="resetQr">关闭</button>
            <span class="spacer" />
            <span class="hint-inline">当前登录状态:</span>
            <span
              v-for="item in loginTags"
              :key="item.key"
              class="badge"
              :class="item.ok ? 'badge-success' : 'badge-neutral'"
              :title="item.note || ''"
            >
              {{ item.name }} {{ item.ok ? '已登录' : '未登录' }}{{ item.note ? ` · ${item.note}` : '' }}
            </span>
          </div>

          <!-- 四步 stepper: 按 qr 状态机真实点亮 -->
          <div class="stepper">
            <div v-for="step in qrSteps" :key="step.label" class="step" :class="step.state">
              <span class="step-dot">
                <template v-if="step.state === 'done'">✓</template>
                <template v-else-if="step.state === 'error'">!</template>
              </span>
              <span class="step-label">{{ step.label }}</span>
            </div>
          </div>

          <p v-if="qr" class="hint">
            二维码 {{ qrExpiresMinutes }} 分钟内有效 · 过期自动失效，可重新获取
            <button type="button" class="link" :disabled="qrBusy" @click="createQr(loginSource)">重新获取二维码 →</button>
          </p>

          <div class="mini-title">其他登录方式</div>
          <div class="row">
            <button type="button" class="btn btn-ghost" :disabled="ccSyncBusy" @click="syncFromCookieCloud">
              <span v-if="ccSyncBusy" class="spin" /><CloudDownloadIcon v-else :size="14" /> CookieCloud 同步
            </button>
            <button type="button" class="btn btn-ghost" @click="cookiePanelOpen = !cookiePanelOpen">
              <ClipboardPasteIcon :size="14" /> 粘贴整行 Cookie
            </button>
            <span class="hint-inline">密钥与 Cookie 永不回显 · 编辑时留空 = 保持不变</span>
          </div>
          <div v-if="cookiePanelOpen" class="cookie-panel">
            <textarea
              v-model="cookieText"
              class="input textarea"
              rows="3"
              :placeholder="`浏览器登录 ${loginSource === 'qq' ? 'y.qq.com' : 'music.163.com'} 后，F12 → Network → 任选一个请求 → 复制请求头里的 Cookie 整行粘贴到这里`"
            />
            <div class="row">
              <button type="button" class="btn btn-primary btn-sm" :disabled="pasteBusy" @click="pasteCookie">
                <span v-if="pasteBusy" class="spin" />保存 {{ sourceName(loginSource) }} Cookie
              </button>
              <span class="hint-inline">宿主会剥离扫码返回的登录 Cookie，扫码成功也存不下登录态时用这个</span>
            </div>
          </div>

          <div class="mini-title">音质档位</div>
          <div class="chips">
            <span
              v-for="chip in qualityChips"
              :key="chip.value"
              class="chip"
              :class="{ on: chip.value === defaultQuality }"
            >
              {{ chip.label }}
            </span>
          </div>
          <p class="hint">
            默认: {{ qualityLabel(defaultQuality) }} · 可选档位随来源不同 · 未登录仅可浏览，登录后可入队下载
          </p>
          <p class="hint">
            下载与音质依赖对应平台会员：网易云 SVIP（母带/臻音）、QQ 绿钻（FLAC 及以上）。QQ 的微信扫码链路未接到
            action 分发（qq.rs 的 `qr_create_wx` 只单独导出），所以这里只提供 QQ 二维码。
          </p>
        </div>
      </div>
    </section>

    <!-- 下划线式 Tabs(任务带计数 badge) -->
    <nav class="tabs">
      <button
        v-for="item in [
          { id: 'search', text: '搜索' },
          { id: 'playlists', text: '我的歌单' },
          { id: 'tasks', text: '任务' },
          { id: 'settings', text: '设置' },
        ]"
        :key="item.id"
        type="button"
        class="tabbtn"
        :class="{ on: tab === item.id }"
        @click="switchTab(item.id)"
      >
        {{ item.text }}
        <span v-if="item.id === 'tasks' && pendingTasks.length" class="tab-badge">{{ pendingTasks.length }}</span>
      </button>
    </nav>

    <!-- ② 搜索 -->
    <section v-if="tab === 'search'" class="card">
      <div class="row">
        <h3 class="card-title">搜索</h3>
        <span class="seg">
          <button
            v-for="item in sources"
            :key="item.id"
            type="button"
            :class="{ on: source === item.id }"
            @click="switchSearchSource(item.id)"
          >
            {{ item.name }}
          </button>
        </span>
        <input v-model="query" class="input grow" placeholder="歌名 歌手" @keydown.enter="runSearch(1)" />
        <button type="button" class="btn btn-primary" :disabled="searching" @click="runSearch(1)">
          <span v-if="searching" class="spin" /><SearchIcon v-else :size="14" /> 搜索
        </button>
      </div>

      <div v-if="results.length" class="tbl-wrap">
        <table class="tbl">
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
                <select
                  class="sel"
                  :value="qualityOf(song)"
                  @change="setSongQuality(song, ($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="value in qualitiesFor(song.source || source, song)" :key="value" :value="value">
                    {{ qualityLabel(value) }}
                  </option>
                </select>
              </td>
              <td>
                <button
                  type="button"
                  class="btn btn-primary btn-xs"
                  :disabled="submitting === String(song.id)"
                  @click="download(song)"
                >
                  <span v-if="submitting === String(song.id)" class="spin" />下载
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else-if="searching" class="skeletons">
        <div class="sk" style="width: 42%" />
        <div class="sk" style="width: 88%" />
        <div class="sk" style="width: 67%" />
      </div>
      <div v-else-if="searchTotal !== null" class="empty">
        <InboxIcon :size="30" />
        <p>没有搜索到内容</p>
      </div>
      <p v-else class="hint">输入歌名或「歌名 歌手」后回车/点搜索。共 {{ results.length }} 条搜索结果。</p>

      <div v-if="results.length" class="row">
        <span class="hint-inline">
          已显示 {{ results.length }} 条{{ searchTotal !== null ? ` / 共 ${searchTotal} 条` : '' }} · 第 {{ searchPage }} 页
        </span>
        <button
          v-if="hasMoreResults"
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="searching"
          @click="runSearch(searchPage + 1)"
        >
          <span v-if="searching" class="spin" />加载更多
        </button>
      </div>
      <p class="hint">
        点「下载」只是入队（去重按 来源+歌曲 id+音质）；真正的取链与下载由后台任务推进，进度看「下载任务」。
        <template v-if="source === 'qq'">QQ 的取链阶梯按所选档位裁剪（母带→全档、无损→F000 起、320→M800 起、128→M500 起），命中不到才逐级向下。</template>
      </p>
    </section>

    <!-- ③ 我的歌单 -->
    <section v-else-if="tab === 'playlists'" class="card">
      <!-- 歌单卡片列表 -->
      <template v-if="!playlistView">
        <div class="row">
          <h3 class="card-title">我的歌单</h3>
          <span class="seg">
            <button
              v-for="item in sources"
              :key="item.id"
              type="button"
              :class="{ on: source === item.id }"
              @click="switchPlaylistSource(item.id)"
            >
              {{ item.name }}
            </button>
          </span>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="playlistsLoading || source !== 'netease'"
            @click="loadPlaylists"
          >
            <span v-if="playlistsLoading" class="spin" />刷新
          </button>
          <span
            v-for="item in loginTags"
            :key="`pl-${item.key}`"
            class="badge"
            :class="item.ok ? 'badge-success' : 'badge-neutral'"
          >
            {{ item.name }} {{ item.ok ? '已登录' : '未登录' }}
          </span>
        </div>

        <!-- 与 runtime.rs:646 的后端文案一致 -->
        <div v-if="source !== 'netease'" class="bar bar-warning">
          <TriangleAlertIcon :size="16" class="bar-side-icon" />
          <div class="bar-body">
            <strong>该来源暂不支持歌单，先支持网易云</strong>
            <p>歌单只接了网易云（后端 `playlists` / `playlist-songs` 仅落地 netease）。切回网易云，或去「搜索」页按歌搜。</p>
          </div>
        </div>
        <template v-else>
          <div v-if="playlists.length" class="plgrid">
            <button v-for="playlist in playlists" :key="playlist.id" type="button" class="plcard" @click="openPlaylist(playlist)">
              <img v-if="playlist.cover" :src="playlist.cover" referrerpolicy="no-referrer" alt="" />
              <div class="plname">{{ playlist.name || '—' }}</div>
              <div class="plcount">{{ Number(playlist.count) || 0 }} 首{{ playlist.creator ? ` · ${playlist.creator}` : '' }}</div>
            </button>
          </div>
          <div v-else-if="playlistsLoading" class="skeletons">
            <div class="sk" style="width: 32%" />
            <div class="sk" style="width: 74%" />
          </div>
          <div v-else class="empty">
            <InboxIcon :size="30" />
            <p>还没有歌单：未登录就先在上方「扫码登录」卡片扫码，然后点「刷新」。</p>
          </div>
        </template>
      </template>

      <!-- 歌单曲目分页列表 -->
      <template v-else>
        <div class="row">
          <button type="button" class="btn btn-ghost btn-sm" @click="closePlaylistView">← 返回歌单</button>
          <h3 class="card-title">{{ plName || '歌单' }}（{{ plTotal }} 首）</h3>
          <span class="spacer" />
          <select v-model="plBatchQuality" class="sel" :disabled="plBatchBusy" title="整单下载统一音质">
            <option v-for="value in qualitiesFor('netease')" :key="value" :value="value">
              {{ qualityLabel(value) }}
            </option>
          </select>
          <button
            type="button"
            class="btn btn-primary"
            :disabled="plBatchBusy || !playlistView"
            @click="downloadPlaylistAll"
          >
            <span v-if="plBatchBusy" class="spin" />整单下载{{ plTotal > 0 ? `（共 ${plTotal} 首）` : '' }}
          </button>
        </div>

        <p v-if="plBatchBusy || plBatchProgress" class="hint">{{ plBatchProgress || '整单入队中…' }}</p>

        <div class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>#</th>
                <th>歌曲</th>
                <th>歌手</th>
                <th>专辑</th>
                <th>音质</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(song, index) in plSongs" :key="`${song.id}-${index}`">
                <td class="dim">{{ (plPage - 1) * PLAYLIST_PAGE_SIZE + index + 1 }}</td>
                <td>{{ song.name || '—' }}</td>
                <td>{{ song.singers || '—' }}</td>
                <td class="dim">{{ song.album || '—' }}</td>
                <td>
                  <!-- 原生 select: 与搜索页一致(选项来自歌曲自带的 qualities, 缺省第一档) -->
                  <select
                    class="sel"
                    :value="qualityOf(song)"
                    @change="setSongQuality(song, ($event.target as HTMLSelectElement).value)"
                  >
                    <option v-for="value in qualitiesFor(song.source || source, song)" :key="value" :value="value">
                      {{ qualityLabel(value) }}
                    </option>
                  </select>
                </td>
                <td>
                  <button
                    type="button"
                    class="btn btn-primary btn-xs"
                    :disabled="submitting === String(song.id)"
                    @click="download(song)"
                  >
                    <span v-if="submitting === String(song.id)" class="spin" />下载
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="plSongs.length && plSongs.length < plTotal" class="row center-row">
          <button type="button" class="btn btn-ghost btn-sm" :disabled="plLoading" @click="fetchPlaylistSongs(plPage + 1)">
            <span v-if="plLoading" class="spin" />加载更多（已载 {{ plSongs.length }}/{{ plTotal }}）
          </button>
        </div>
        <p v-else-if="plLoading" class="hint">歌单内容加载中…</p>
        <p v-else-if="!plSongs.length" class="hint">没有取到歌曲。</p>
        <p class="hint">
          「整单下载」按右上角选的统一音质，让后端分批翻页把整张歌单入队（去重规则同搜索页）——不依赖上面已加载的
          条数，所以 100 首以上的歌单也能一次下完；每批 500 首，期间按钮保持 loading。只是提交排队，进度去「下载任务」tab 看。
        </p>
      </template>
    </section>

    <!-- ④ 下载任务 -->
    <section v-else-if="tab === 'tasks'" class="card">
      <div class="row">
        <h3 class="card-title">下载任务</h3>
        <span class="badge" :class="pendingTasks.length ? 'badge-success' : 'badge-neutral'">
          {{ pendingTasks.length ? '队列自动推进中' : '队列空闲' }}
        </span>
        <span class="badge badge-neutral">共 {{ tasks.length }} 条</span>
        <span v-if="failedTasks.length" class="badge badge-error">失败 {{ failedTasks.length }}</span>
        <span class="spacer" />
        <button type="button" class="btn btn-ghost btn-sm" :disabled="taskBusy === 'pump'" @click="pumpQueue">
          <span v-if="taskBusy === 'pump'" class="spin" />推进队列
        </button>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="taskBusy === 'clear'" @click="clearFinished">
          <span v-if="taskBusy === 'clear'" class="spin" /><Trash2Icon v-else :size="13" /> 清空已完成
        </button>
      </div>

      <!-- 队列互斥第三态: 只在真实互斥(动作回 skipped)时出现, message 是后端原文; 「知道了」纯前端 dismiss -->
      <div v-if="mutexNotice" class="bar bar-warning">
        <TriangleAlertIcon :size="16" class="bar-side-icon" />
        <div class="bar-body"><p>{{ mutexNotice }}</p></div>
        <button type="button" class="btn btn-ghost btn-xs" @click="mutexNotice = ''">知道了</button>
      </div>

      <!-- 索引对账(0.3.19): 分片 task.<id> 在、索引里丢了(两阶段写入被打断)的“僵尸任务”挂回(task-adopt) -->
      <div class="row adopt-row">
        <input v-model="adoptId" class="input grow" placeholder="任务 id（如 2gexs25y）" @keyup.enter="adoptTask" />
        <button type="button" class="btn btn-ghost btn-sm" :disabled="taskBusy === 'adopt'" @click="adoptTask">
          <span v-if="taskBusy === 'adopt'" class="spin" /><RefreshCwIcon v-else :size="13" /> 索引对账
        </button>
      </div>

      <div v-if="tasks.length" class="task-list">
        <div v-for="task in tasks" :key="task.id" class="task-row">
          <div class="task-tile" :class="taskTileClass(task)"><MusicIcon :size="17" /></div>
          <div class="task-main">
            <div class="task-title">{{ task.name || '—' }}<span v-if="task.singers"> · {{ task.singers }}</span></div>
            <div class="task-sub">
              {{ qualityLabel(String(task.quality || '')) }} · {{ sourceName(String(task.source || ''))
              }}<template v-if="task.error"> · {{ task.error }}</template>
            </div>
          </div>
          <!-- state 没有进度字节字段: 不定态条, 无百分比 -->
          <div v-if="taskInFlight(task)" class="task-progress"><div class="indet" /></div>
          <button
            v-if="String(task.status) === 'failed'"
            type="button"
            class="icon-btn retry-btn"
            title="重试(task-retry)"
            :disabled="taskBusy === String(task.id)"
            @click="retryTask(task)"
          >
            <span v-if="taskBusy === String(task.id)" class="spin" /><RotateCcwIcon v-else :size="14" />
          </button>
          <span class="badge" :class="taskBadgeClass(task)">
            {{ String(task.status) === 'queued' ? queuedBadgeText(task) : taskStatusLabel(task) }}
          </span>
        </div>
      </div>
      <div v-else class="empty">
        <InboxIcon :size="30" />
        <p>暂无任务。去「搜索」页选一首歌点下载。</p>
      </div>

      <p class="hint">
        任务由后台 job `queue-pump`（每 5 分钟，见 manifest）推进；想立刻推一轮点右上角「推进队列」（与 job 同一个入口，
        单次只新开 1 首）。失败任务最多自动重试 3 次，用尽后可在这一行点重试；
        失败通知的正文会提示到本页重试。「清空已完成」只删 done/failed，进行中的任务不动。
        若重启后任务「消失」（分片还在、索引丢了），把它的 id 填进上面输入框点「索引对账」挂回。
      </p>
      <p class="hint task-foot">
        下载目录: {{ settings.target_dir || '未配置（到「设置」页填写目标目录）' }} · 命名: {歌手} - {歌名}.{格式} ·
        长列表局部滚动，列宽稳定不跳
      </p>
    </section>

    <!-- ⑤ 设置(保持现有交互位置, 只换皮) -->
    <section v-else class="card">
      <div class="row">
        <h3 class="card-title">设置</h3>
        <span class="spacer" />
        <button type="button" class="btn btn-ghost btn-sm" :disabled="changedKeys.length === 0" @click="syncForm">
          撤销改动
        </button>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          :disabled="changedKeys.length === 0 || savingSettings"
          @click="saveSettings"
        >
          <span v-if="savingSettings" class="spin" />保存
        </button>
      </div>

      <div class="grid">
        <label class="field">
          <span class="label">暂存目录（staging_dir）</span>
          <input v-model="form.staging_dir" class="input" placeholder="/CloudNAS/115open/音乐/音乐下载" />
          <span class="hint">必须在宿主本地可写根下：先下载到这里的 <code>&lt;短id&gt;.part</code>，再改名复制。</span>
        </label>
        <label class="field">
          <span class="label">目标目录（target_dir）</span>
          <input v-model="form.target_dir" class="input" placeholder="/CloudNAS/115open/音乐/音乐下载" />
          <span class="hint">最终落点（通常指向 CD2 挂载的音乐目录），由 CD2 负责刮削入库。</span>
        </label>
        <label class="field">
          <span class="label">默认音质（quality）</span>
          <select v-model="form.quality" class="sel grow">
            <option v-for="option in qualityOptionsForDefault" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <span class="hint">网易云的档位名（后端默认 jymaster）；搜索页每首歌还能单独选。QQ 取链与这里无关。</span>
        </label>
        <label class="field">
          <span class="label">并发下载数（max_active）</span>
          <input v-model.number="form.max_active" type="number" class="input" :min="1" :max="MAX_ACTIVE_CAP" />
          <span class="hint">每轮 pump 同时推进的任务数，1-{{ MAX_ACTIVE_CAP }}（超出会被后端回落到默认 2）。</span>
        </label>
        <label class="field">
          <span class="label">失败时发 Telegram 通知</span>
          <span class="switch-row">
            <span class="switch">
              <input v-model="form.notify_on_fail" type="checkbox" />
              <span class="track" />
            </span>
          </span>
          <span class="hint">尝试次数用尽时推送错误通知，正文里给出插件「下载任务」页的一键重试入口。</span>
        </label>
      </div>

      <p class="hint">
        保存只提交改动过的键（当前：{{ changedKeys.length ? changedKeys.join(', ') : '无' }}）；后端按白名单合并，没提交的键保持原值。
      </p>

      <div class="divider" />
      <h4 class="sub">CookieCloud 同步（网易 + QQ 登录态）</h4>
      <div class="grid">
        <label class="field">
          <span class="label">CookieCloud 地址（cookiecloud_url）</span>
          <input v-model="form.cc_url" class="input" :placeholder="DEFAULT_CC_URL" />
          <span class="hint">服务端地址；清空保存后后端回落到默认 {{ DEFAULT_CC_URL }}。</span>
        </label>
        <label class="field">
          <span class="label">UUID（cookiecloud_uuid）</span>
          <input v-model="form.cc_uuid" class="input" placeholder="CookieCloud 的同步 UUID" />
          <span class="hint">CookieCloud 网页「同步页」上显示的 UUID。</span>
        </label>
        <label class="field">
          <span class="label">密钥（cookiecloud_key）</span>
          <span class="pwd">
            <input
              v-model="form.cc_key"
              :type="showCcKey ? 'text' : 'password'"
              class="input grow"
              placeholder="同步口令，不回显"
            />
            <button
              type="button"
              class="icon-btn eye-btn"
              :title="showCcKey ? '隐藏' : '显示'"
              @click="showCcKey = !showCcKey"
            >
              <EyeOffIcon v-if="showCcKey" :size="14" /><EyeIcon v-else :size="14" />
            </button>
          </span>
          <span class="hint">{{ settings.cc_key_ready ? '已配置（不回显，重新输入可覆盖）' : '未配置' }}；留空保存不会清除已配置的密钥。</span>
        </label>
      </div>
      <p class="hint">
        三项与上方共用「保存」按钮（settings-update 的 cookiecloud_url / cookiecloud_uuid / cookiecloud_key）；
        配好后到「扫码登录」卡片点「CookieCloud 同步」。
      </p>

      <div class="divider" />
      <h4 class="sub">CD2 直送（0.3.19）</h4>
      <p class="hint">
        配好 CD2 地址与令牌后，入库改走 CD2 直送：插件直接调 CD2（CloudDrive2）把暂存文件传到网盘目录，
        绕开宿主复制对「本地目录和 CD2/AURA 挂载目录必须严格隔离」的跨边界拦截。令牌留空 = 回到旧路径（宿主复制）。
      </p>
      <div class="grid">
        <label class="field">
          <span class="label">CD2 地址（cd2_url）</span>
          <input v-model="form.cd2_url" class="input" :placeholder="DEFAULT_CD2_URL" />
          <span class="hint">CD2 的 gRPC-Web 地址；清空保存后后端回落到 {{ DEFAULT_CD2_URL }}（宿主同网络时用回环）。</span>
        </label>
        <label class="field">
          <span class="label">API 令牌（cd2_token）</span>
          <span class="pwd">
            <input
              v-model="form.cd2_token"
              :type="showCd2Token ? 'text' : 'password'"
              class="input grow"
              placeholder="CD2 设置页的 API 令牌，不回显"
            />
            <button
              type="button"
              class="icon-btn eye-btn"
              :title="showCd2Token ? '隐藏' : '显示'"
              @click="showCd2Token = !showCd2Token"
            >
              <EyeOffIcon v-if="showCd2Token" :size="14" /><EyeIcon v-else :size="14" />
            </button>
          </span>
          <span class="hint">{{ settings.cd2_auth_ready ? '已配置（不回显，重新输入可覆盖）' : '未配置 = 继续用宿主复制入库' }}；留空保存不会清除已配置的令牌。</span>
        </label>
        <label class="field">
          <span class="label">网盘落点（cd2_dest_dir）</span>
          <input v-model="form.cd2_dest_dir" class="input" :placeholder="settings.cd2_dest_dir_effective || '115open/音乐/音乐下载'" />
          <span class="hint">CD2 视角的网盘目录（不带 /CloudNAS 前缀）；留空 = 从目标目录推导，当前生效：{{ settings.cd2_dest_dir_effective || '—' }}。</span>
        </label>
        <label class="field">
          <span class="label">本地目录名（cd2_local_folder）</span>
          <input v-model="form.cd2_local_folder" class="input" :placeholder="settings.cd2_local_folder_effective || 'dian115AI'" />
          <span class="hint">CD2 里登记的本地目录名（命名空间）；留空 = 用插件工作区，当前生效：{{ settings.cd2_local_folder_effective || '—' }}。</span>
        </label>
        <label class="field">
          <span class="label">登记用宿主路径（cd2_register_host）</span>
          <input v-model="form.cd2_register_host" class="input" placeholder="已登记就留空" />
          <span class="hint">
            仅当 CD2 里还没登记过该本地目录时填：宿主机上该目录的绝对路径（如 /volume1/docker/dian115/dian115AI），
            首次直送时插件用它自动登记；已登记（如 {{ settings.cd2_local_folder_effective || 'dian115AI' }}）就留空。
          </span>
        </label>
      </div>
      <p class="hint">
        五项与上方共用「保存」按钮（settings-update 的 cd2_url / cd2_token / cd2_dest_dir / cd2_local_folder / cd2_register_host）。
      </p>

      <div class="divider" />
      <h4 class="sub">通知自检（notify-test）</h4>
      <div class="row">
        <button type="button" class="btn btn-ghost btn-sm" :disabled="notifyBusy" @click="testNotify">
          <span v-if="notifyBusy" class="spin" /><SendIcon v-else :size="13" /> 发测试通知
        </button>
        <span class="hint">手动发一条 info 通知，把宿主对 /api/notifications/plugin 的原始应答显示在这里（排查失败通知一直 400 用）。</span>
      </div>
      <p v-if="notifyResult" class="hint">{{ notifyResult }}</p>
      <p v-if="notifyDiagText" class="hint">{{ notifyDiagText }}</p>

      <div class="divider" />
      <h4 class="sub">目录探测（state.roots）</h4>
      <p v-if="rootProbeNote" class="hint">{{ rootProbeNote }}</p>
      <p v-else class="hint">
        探测结果：暂存目录{{ roots.ok ? (roots.staging_dir_effective ? '可用' : '不可用') : '未知' }} ·
        生效路径 <code>{{ roots.staging_dir_effective || '—' }}</code> · 目标目录 <code>{{ roots.target_dir || '—' }}</code>
      </p>
      <ul v-if="listOf(roots.warnings).length" class="list">
        <li v-for="(warning, index) in listOf(roots.warnings)" :key="index" class="hint">{{ warning }}</li>
      </ul>
      <div v-if="listOf(roots.roots).length" class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr><th>路径</th><th>名称</th><th>本地</th><th>可写</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="root in listOf(roots.roots)" :key="root.path">
              <td><code>{{ root.path || '—' }}</code></td>
              <td class="dim">{{ root.name || '—' }}</td>
              <td><span class="badge" :class="root.local ? 'badge-success' : 'badge-neutral'">{{ root.local ? '是' : '否' }}</span></td>
              <td><span class="badge" :class="root.writable ? 'badge-success' : 'badge-neutral'">{{ root.writable ? '是' : '否' }}</span></td>
              <td>
                <button v-if="root.local && root.writable" type="button" class="btn btn-ghost btn-xs" @click="useRootAs('staging', root)">
                  设为暂存
                </button>
                <button v-if="root.writable" type="button" class="btn btn-ghost btn-xs" @click="useRootAs('target', root)">
                  设为目标
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="hint">宿主没有返回任何文件根（state.roots.roots 为空）。</p>
    </section>

    <!-- ⑥ 最近动作(state.logs 原样渲染) -->
    <section class="card">
      <div class="row">
        <h3 class="card-title">最近动作</h3>
        <span class="spacer" />
        <!-- 状态里没有版本号字段; 只放 pluginId(读不到就不放) -->
        <span v-if="props.pluginId" class="hint-inline mono">{{ props.pluginId }}</span>
        <span class="hint-inline">最近 {{ logs.length }} 条 · 状态 {{ state.status || '—' }} · revision {{ state.revision ?? '—' }}</span>
      </div>
      <p v-if="state.last_message" class="hint">{{ state.last_message }}</p>
      <div v-if="logs.length" class="log-list">
        <div v-for="(entry, index) in logs" :key="index" class="log-row">
          <span class="log-time">{{ formatTime(entry.at) }}</span>
          <span
            class="log-dot"
            :class="entry.level === 'warning' ? 'dot-warning' : entry.level === 'error' ? 'dot-error' : 'dot-muted'"
            :title="entry.level || 'info'"
          />
          <span class="log-msg">{{ entry.message || '—' }}</span>
        </div>
      </div>
      <p v-else class="hint">暂无日志</p>
      <!-- manifest 声明了 telegram.callback 事件(retry:<短id> 回调处理), 此底注为真才放 -->
      <p class="hint">已声明 Telegram 回调事件（retry:&lt;短id&gt;）</p>
    </section>

    <footer class="foot">
      状态文档由宿主注入 · 任务页有进行中任务时每 5 秒跟随队列刷新 · 扫码登录每 2 秒轮询 · 页面宽度跟随宿主可用宽度
    </footer>
  </main>
</template>

<style scoped>
/* 主题全靠宿主注入的 --dian-* 变量(括号内是本地预览的浅色兜底); 不写主题探测。 */
.page {
  display: grid;
  gap: var(--dian-space-4, 16px);
  width: 100%;
  max-width: 100%;
  min-width: 0;
  padding: 4px 0 12px;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
  font-family: var(--dian-font-family, inherit);
}

/* ── 页头(规范 §2.4) ── */
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--dian-space-3, 12px);
  flex-wrap: wrap;
  padding-top: var(--dian-space-2, 8px);
}
.head-left {
  display: flex;
  align-items: center;
  gap: var(--dian-space-3, 12px);
  min-width: 0;
}
.head-icon {
  width: 44px;
  height: 44px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--dian-radius-md, 12px);
  color: var(--dian-primary, #2080f0);
  background: color-mix(in srgb, var(--dian-primary, #2080f0) 11%, transparent);
}
.head-text h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
}
.head-text p {
  margin: 2px 0 0;
  font-size: 13px;
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
}
.head-right {
  display: flex;
  align-items: center;
  gap: var(--dian-space-2, 8px);
  flex-wrap: wrap;
}

/* ── 徽标(规范 §2.1: 胶囊, 语义色文字 + 14% 同色系底) ── */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border-radius: var(--dian-radius-pill, 999px);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  padding: 4px 10px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
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
  background: color-mix(in srgb, var(--dian-warning, #f0a020) 14%, transparent);
}
.badge-error {
  color: var(--dian-error, #d03050);
  background: color-mix(in srgb, var(--dian-error, #d03050) 14%, transparent);
}
.badge-neutral {
  color: var(--dian-text-secondary, #8a919c);
  background: color-mix(in srgb, var(--dian-text-secondary, #8a919c) 14%, transparent);
}
/* 下载中/入库中: 主色实心白字 */
.badge-solid {
  color: var(--dian-primary-contrast, #ffffff);
  background: var(--dian-primary, #2080f0);
}

/* ── 按钮(规范 §2.5) ── */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 18px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.2;
  cursor: pointer;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
  transition: background-color 0.15s, border-color 0.15s, opacity 0.15s;
  white-space: nowrap;
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.btn-primary {
  background: var(--dian-primary, #2080f0);
  color: var(--dian-primary-contrast, #ffffff);
}
.btn-primary:hover:not(:disabled) {
  background: var(--dian-primary-hover, #1c6ed0);
}
.btn-ghost {
  border-color: var(--dian-border, #e0e4ea);
  background: var(--dian-surface, #ffffff);
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
}
.btn-ghost:hover:not(:disabled) {
  background: var(--dian-surface-hover, #eaf4fd);
}
.btn-danger {
  border-color: var(--dian-error, #d03050);
  color: var(--dian-error, #d03050);
  background: transparent;
}
.btn-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dian-error, #d03050) 10%, transparent);
}
.btn-sm {
  padding: 5px 12px;
  font-size: 12px;
  border-radius: 8px;
}
.btn-xs {
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 7px;
}
.icon-btn {
  width: 34px;
  height: 34px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  border: 1px solid var(--dian-border, #e0e4ea);
  background: var(--dian-surface, #ffffff);
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
  cursor: pointer;
  transition: background-color 0.15s;
}
.icon-btn:hover:not(:disabled) {
  background: var(--dian-surface-hover, #eaf4fd);
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
}
.icon-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.retry-btn {
  color: var(--dian-error, #d03050);
}
.link {
  border: none;
  background: none;
  padding: 0;
  margin-left: 4px;
  color: var(--dian-primary, #2080f0);
  font-size: 12px;
  cursor: pointer;
}
.link:hover:not(:disabled) {
  text-decoration: underline;
}
.link:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* 生命周期「进行中」的小 spinner(换掉图标, 按钮禁用) */
.spin {
  width: 12px;
  height: 12px;
  flex: none;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-top-color: transparent;
  animation: ui-rot 0.8s linear infinite;
}
.rot-spin {
  animation: ui-rot 0.9s linear infinite;
}
@keyframes ui-rot {
  to {
    transform: rotate(360deg);
  }
}

/* ── 卡片区块(规范 §2.3) ── */
.card {
  border: 1px solid var(--dian-border, #e0e4ea);
  border-radius: var(--dian-radius-lg, 12px);
  background: var(--dian-surface-raised, var(--dian-surface, #ffffff));
  box-shadow: var(--dian-shadow-sm, none);
  padding: 20px 24px;
  display: grid;
  gap: 12px;
  min-width: 0;
}
.card-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.center-row {
  justify-content: center;
}
.spacer {
  flex: 1;
}
.grow {
  flex: 1;
  min-width: 160px;
}
.hint {
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  font-size: 12px;
  margin: 0;
  line-height: 1.6;
}
.hint-inline {
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  font-size: 12px;
}
.mono {
  font-family: var(--dian-font-mono, ui-monospace, monospace);
  font-variant-numeric: tabular-nums;
}
.dim {
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
}
.sub {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
}
.divider {
  height: 1px;
  background: var(--dian-divider, #e0e4ea);
}
.mini-title {
  margin-top: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  letter-spacing: 0.02em;
}
code {
  font-family: var(--dian-font-mono, ui-monospace, monospace);
  font-size: 12px;
  word-break: break-all;
}

/* ── 提示条(四态/互斥警告; 语义色 14% 底) ── */
.bar {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 14px;
  border-radius: var(--dian-radius-md, 12px);
  font-size: 13px;
}
.bar-body {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 2px;
}
.bar-body p {
  margin: 0;
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
  font-size: 12px;
  line-height: 1.6;
}
.bar-body strong {
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
  font-size: 13px;
}
.bar-icon {
  width: 20px;
  height: 20px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 700;
  color: #ffffff;
  background: var(--dian-error, #d03050);
}
.bar-side-icon {
  flex: none;
  margin-top: 1px;
}
.bar-warning {
  background: color-mix(in srgb, var(--dian-warning, #f0a020) 14%, transparent);
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
}
.bar-warning .bar-side-icon {
  color: var(--dian-warning, #f0a020);
}
.bar-error {
  background: color-mix(in srgb, var(--dian-error, #d03050) 10%, transparent);
}

/* ── 登录卡 ── */
.login-grid {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 24px;
  align-items: start;
}
.qr-pane {
  display: grid;
  justify-items: center;
  gap: 6px;
  text-align: center;
}
/* QR 白底卡: 二维码永远需要白底, 深浅主题都固定白色 */
.qr-box {
  width: 200px;
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #ffffff;
  border: 1px solid var(--dian-border, #e0e4ea);
  border-radius: var(--dian-radius-md, 12px);
  box-shadow: var(--dian-shadow-sm, none);
  overflow: hidden;
}
.qr-svg,
.qr-box img {
  width: 180px;
  height: 180px;
  object-fit: contain;
  image-rendering: pixelated;
}
.qr-fallback {
  display: grid;
  justify-items: center;
  gap: 6px;
  padding: 12px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  font-size: 12px;
  text-align: center;
}
.qr-fallback-error {
  color: var(--dian-error, #d03050);
}
.qr-title {
  margin-top: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
}
.qr-sub {
  font-size: 12px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
}
.qr-meta {
  font-family: var(--dian-font-mono, ui-monospace, monospace);
}
.login-side {
  display: grid;
  gap: 10px;
  align-content: start;
  border-left: 1px solid var(--dian-divider, #e0e4ea);
  padding-left: 24px;
  min-width: 0;
}
.login-side .hint .link {
  font-size: 12px;
}

/* 来源切换(分段控件) */
.seg {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: 10px;
  background: var(--dian-surface-soft, #f7faff);
}
.seg button {
  padding: 5px 14px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.seg button.on {
  background: var(--dian-surface, #ffffff);
  color: var(--dian-primary, #2080f0);
  font-weight: 600;
  box-shadow: var(--dian-shadow-sm, 0 1px 2px rgba(15, 23, 42, 0.08));
}

/* 四步 stepper */
.stepper {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
}
.step {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  min-width: 0;
}
.step-dot {
  width: 22px;
  height: 22px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 2px solid var(--dian-border-strong, #c8d8ec);
  background: var(--dian-surface, #ffffff);
  font-size: 12px;
  font-weight: 700;
  color: #ffffff;
}
.step-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.step.done {
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
}
.step.done .step-dot {
  background: var(--dian-success, #18a058);
  border-color: var(--dian-success, #18a058);
}
.step.active {
  color: var(--dian-primary, #2080f0);
  font-weight: 600;
}
.step.active .step-dot {
  border-color: var(--dian-primary, #2080f0);
}
.step.active .step-dot::after {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dian-primary, #2080f0);
}
.step.error {
  color: var(--dian-error, #d03050);
}
.step.error .step-dot {
  border-color: var(--dian-error, #d03050);
  color: var(--dian-error, #d03050);
  background: transparent;
}

/* 粘贴 Cookie 面板(原 <details> 的受控形态, 字段与动作不变) */
.cookie-panel {
  display: grid;
  gap: 8px;
  padding: 10px 12px;
  border: 1px dashed var(--dian-border-strong, #c8d8ec);
  border-radius: var(--dian-radius-md, 12px);
  background: var(--dian-surface-soft, #f7faff);
}

/* 音质档位 chips: 选中态 = 主色 outline + 主色 14% 底 */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  padding: 5px 12px;
  border-radius: 8px;
  font-size: 12px;
  border: 1px solid transparent;
  background: var(--dian-surface-soft, #f7faff);
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
  font-variant-numeric: tabular-nums;
}
.chip.on {
  color: var(--dian-primary, #2080f0);
  border-color: var(--dian-primary, #2080f0);
  background: color-mix(in srgb, var(--dian-primary, #2080f0) 14%, transparent);
  font-weight: 500;
}

/* ── 下划线式 Tabs ── */
.tabs {
  display: flex;
  gap: 28px;
  padding: 0 4px;
  border-bottom: 1px solid var(--dian-divider, #e0e4ea);
  overflow-x: auto;
}
.tabbtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 2px;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  background: none;
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
  font-size: 14px;
  cursor: pointer;
  white-space: nowrap;
}
.tabbtn:hover {
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
}
.tabbtn.on {
  color: var(--dian-primary, #2080f0);
  border-bottom-color: var(--dian-primary, #2080f0);
  font-weight: 600;
}
.tab-badge {
  min-width: 18px;
  padding: 2px 6px;
  border-radius: var(--dian-radius-pill, 999px);
  font-size: 11px;
  line-height: 1.2;
  text-align: center;
  color: var(--dian-info, #2080f0);
  background: color-mix(in srgb, var(--dian-info, #2080f0) 14%, transparent);
  font-variant-numeric: tabular-nums;
}

/* ── 输入控件 ── */
.input {
  padding: 8px 12px;
  border: 1px solid var(--dian-border, #e0e4ea);
  border-radius: 9px;
  background: var(--dian-surface, #ffffff);
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
  font-size: 13px;
  font-family: inherit;
}
.input:focus {
  outline: none;
  border-color: var(--dian-primary, #2080f0);
}
.textarea {
  resize: vertical;
  width: 100%;
  box-sizing: border-box;
}
.sel {
  padding: 6px 8px;
  border: 1px solid var(--dian-border, #e0e4ea);
  border-radius: 8px;
  background: var(--dian-surface, #ffffff);
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
  font-size: 13px;
  max-width: 100%;
}
.pwd {
  display: flex;
  gap: 6px;
  align-items: center;
}
.eye-btn {
  width: 30px;
  height: 30px;
}

/* 开关(对应旧版 NSwitch, 值仍是布尔) */
.switch-row {
  display: flex;
  align-items: center;
  min-height: 34px;
}
.switch {
  position: relative;
  display: inline-block;
  width: 38px;
  height: 22px;
  flex: none;
}
.switch input {
  position: absolute;
  inset: 0;
  opacity: 0;
  margin: 0;
  cursor: pointer;
}
.switch .track {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dian-text-muted, rgba(0, 0, 0, 0.45)) 35%, transparent);
  transition: background-color 0.15s;
  pointer-events: none;
}
.switch .track::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.25);
  transition: transform 0.15s;
}
.switch input:checked + .track {
  background: var(--dian-primary, #2080f0);
}
.switch input:checked + .track::after {
  transform: translateX(16px);
}

/* ── 表格(长表保留表头 + 卡内局部滚动) ── */
.tbl-wrap {
  max-height: 380px;
  overflow: auto;
  border: 1px solid var(--dian-border, #e0e4ea);
  border-radius: var(--dian-radius-md, 12px);
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.tbl th,
.tbl td {
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid var(--dian-divider, #e0e4ea);
  vertical-align: middle;
}
.tbl tbody tr:last-child td {
  border-bottom: none;
}
.tbl th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--dian-surface-raised, var(--dian-surface, #ffffff));
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  font-weight: 500;
  font-size: 12px;
}

/* ── 任务行(图 4) ── */
.task-list {
  max-height: 430px;
  overflow-y: auto;
  display: grid;
}
.task-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 13px 2px;
  border-bottom: 1px solid var(--dian-divider, #e0e4ea);
}
.task-row:last-child {
  border-bottom: none;
}
.task-tile {
  width: 36px;
  height: 36px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
}
.tile-primary {
  color: var(--dian-primary, #2080f0);
  background: color-mix(in srgb, var(--dian-primary, #2080f0) 12%, transparent);
}
.tile-info {
  color: var(--dian-info, #2080f0);
  background: color-mix(in srgb, var(--dian-info, #2080f0) 10%, transparent);
}
.tile-success {
  color: var(--dian-success, #18a058);
  background: color-mix(in srgb, var(--dian-success, #18a058) 12%, transparent);
}
.tile-error {
  color: var(--dian-error, #d03050);
  background: color-mix(in srgb, var(--dian-error, #d03050) 10%, transparent);
}
.tile-muted {
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  background: color-mix(in srgb, var(--dian-text-secondary, #8a919c) 10%, transparent);
}
.task-main {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 2px;
}
.task-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-sub {
  font-size: 12px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 不定态进度条(state 无进度字段, 不做假百分比) */
.task-progress {
  width: min(320px, 28%);
  flex: none;
  height: 6px;
  border-radius: 3px;
  background: var(--dian-surface-soft, #f7faff);
  overflow: hidden;
}
.indet {
  height: 100%;
  width: 40%;
  border-radius: 3px;
  background: var(--dian-primary, #2080f0);
  animation: indet-slide 1.2s ease-in-out infinite;
}
@keyframes indet-slide {
  0% {
    transform: translateX(-110%);
  }
  100% {
    transform: translateX(280%);
  }
}
.task-row .badge {
  margin-left: auto;
  flex: none;
}
.retry-btn {
  flex: none;
}
.task-foot {
  border-top: 1px dashed var(--dian-divider, #e0e4ea);
  padding-top: 10px;
}

/* ── 歌单卡片 ── */
.plgrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}
.plcard {
  display: grid;
  gap: 4px;
  padding: 8px;
  text-align: left;
  border: 1px solid var(--dian-border, #e0e4ea);
  border-radius: var(--dian-radius-md, 12px);
  background: var(--dian-surface, #ffffff);
  cursor: pointer;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
  transition: border-color 0.15s;
}
.plcard:hover {
  border-color: var(--dian-border-strong, #c8d8ec);
}
.plcard img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: 8px;
  background: var(--dian-surface-soft, #f7faff);
}
.plname {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plcount {
  font-size: 12px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
}

/* ── 四态: 骨架条 / 空态 ── */
.skeletons {
  display: grid;
  gap: 10px;
  padding: 8px 0;
}
.sk {
  height: 14px;
  border-radius: 7px;
  background: var(--dian-surface-soft, #f7faff);
  animation: sk-breathe 1.4s ease-in-out infinite;
}
@keyframes sk-breathe {
  50% {
    opacity: 0.5;
  }
}
.empty {
  display: grid;
  justify-items: center;
  gap: 8px;
  padding: 28px 0;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  font-size: 13px;
  text-align: center;
}
.empty p {
  margin: 0;
  max-width: 420px;
  line-height: 1.6;
}

/* ── 设置表单 ── */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px;
}
.field {
  display: grid;
  gap: 6px;
  align-content: start;
}
.label {
  font-size: 13px;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
}
.list {
  margin: 0;
  padding-left: 18px;
}

/* ── 最近动作(等宽时间线) ── */
.log-list {
  display: grid;
}
.log-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid var(--dian-divider, #e0e4ea);
  font-size: 13px;
}
.log-row:last-child {
  border-bottom: none;
}
.log-time {
  flex: none;
  font-family: var(--dian-font-mono, ui-monospace, monospace);
  font-size: 12px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  font-variant-numeric: tabular-nums;
}
.log-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  transform: translateY(-1px);
}
.dot-muted {
  background: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
}
.dot-warning {
  background: var(--dian-warning, #f0a020);
}
.dot-error {
  background: var(--dian-error, #d03050);
}
.log-msg {
  min-width: 0;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
  word-break: break-all;
}

/* ── 页脚 ── */
.foot {
  text-align: center;
  font-size: 12px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  padding: 4px 0 10px;
}

/* ── 断点(图 6): 900–1000px 双栏回落单栏; 表格折成卡片 ── */
@media (max-width: 1000px) {
  .login-grid {
    grid-template-columns: 1fr;
  }
  .login-side {
    border-left: none;
    padding-left: 0;
    border-top: 1px solid var(--dian-divider, #e0e4ea);
    padding-top: 16px;
  }
  .tbl-wrap {
    border: none;
    max-height: none;
    overflow: visible;
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
    border: 1px solid var(--dian-border, #e0e4ea);
    border-radius: var(--dian-radius-md, 12px);
    padding: 6px 10px;
    margin-bottom: 8px;
    background: var(--dian-surface-soft, var(--dian-surface, #f7faff));
  }
  .tbl td {
    border-bottom: none;
    padding: 3px 0;
  }
}

/* 移动档 390: 单栏堆叠, 工具栏允许换行, 字号固定不随视口缩放 */
@media (max-width: 640px) {
  .card {
    padding: 16px;
  }
  .head {
    align-items: flex-start;
  }
  .task-progress {
    width: 100%;
  }
  .task-row {
    flex-wrap: wrap;
    row-gap: 8px;
  }
  .task-row .badge {
    margin-left: 0;
  }
  .stepper {
    flex-wrap: wrap;
    justify-content: flex-start;
    gap: 10px 16px;
  }
}
</style>
