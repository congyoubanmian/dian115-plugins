<script setup lang="ts">
// 音乐下载(Rust 版)插件界面 —— Federation 模块 `./AppPage`(见 vite.config.ts / manifest)。
//
// 布局与交互习惯沿用 plugins/music-dl/src/AppPage.vue: 顶部扫码登录卡片 + 搜索/我的歌单/任务/设置
// 四个分页 + 底部记录区。**数据通道换成本插件的 wasm 运行时**:
//   - 状态只读 `props.runtimeState`(宿主注入), 宿主没给时用 `props.api.getState()` 兜底;
//   - 动作一律走 `props.api.invokeAction`, 每次动作后 `await props.api.refresh()`;
//   - 不直接 fetch, 也没有 sidecar(旧版 UI 的 agent-get/agent-post 与 sidecar 回环地址已移除)。
//
// action 名与入参对齐 `src/runtime.rs` 的 action 分发表:
//   qr-create{source} / qr-poll{source,key} / search{source,query,page}
//   / playlists{source} / playlist-songs{source,id,page,page_size}
//   / playlist-queue-all{source,id,quality,batch_pages,next_page}(整单分批入队)
//   / download{source,song_id,name,singers,album,level} / settings-update{patch}
//   / task-retry{id} / task-clear{} / pump{}
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
}

// ── 手动粘贴 Cookie(宿主 broker 剥离外部响应的 Set-Cookie, 网易/QQ 扫码都拿不到登录态) ──
const cookieText = ref('')
const pasteBusy = ref(false)

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
// 交互照搬 plugins/music-dl/src/AppPage.vue 的歌单页: 卡片列表(name/count/creator) → 点开分页曲目
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
 * `has_more` 为 true 就带着上一轮的 `next_page` 继续下一轮, 取尽(has_more=false)或某轮业务失败即停。
 * 每轮之间不人为延时(action 自身串行, 后端逐页取歌也串行)。
 *
 * 与歌单曲目列表的分页浏览**完全解耦**: 这里不再读 `plSongs`, 只认歌单 id,
 * 所以不需要先把 100 首「加载更多」到底 —— 100 首限制由此解除。
 * 全程按钮 loading; 结束(完成或失败)都弹汇总, 业务失败时已入队的不丢。
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
  let stopped = ''
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
    if (stopped) {
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
}

/** CookieCloud 服务端默认地址(download.rs `DEFAULT_COOKIECLOUD_URL`, URL 清空后后端也回落到它)。 */
const DEFAULT_CC_URL = 'http://127.0.0.1:8088'

const DEFAULTS: SettingsForm = {
  staging_dir: '',
  target_dir: '',
  quality: 'jymaster',
  max_active: 2,
  notify_on_fail: true,
  cc_url: DEFAULT_CC_URL,
  cc_uuid: '',
  cc_key: '',
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
  if (changedKeys.value.includes('cookiecloud_url')) patch.cookiecloud_url = form.cc_url.trim()
  if (changedKeys.value.includes('cookiecloud_uuid')) patch.cookiecloud_uuid = form.cc_uuid.trim()
  if (changedKeys.value.includes('cookiecloud_key')) patch.cookiecloud_key = form.cc_key.trim()

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
      baseline.value = { ...form, cc_key: '' }
    }
    // 密钥不回显(state 与响应都不给): 保存成功后立即清掉输入框, 配置与否看「已配置」标记。
    form.cc_key = ''
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

      <details class="paste-cookie">
        <summary>手动粘贴 Cookie（宿主会剥离扫码返回的登录 Cookie，扫码成功也存不下登录态时用这个）</summary>
        <n-input
          v-model:value="cookieText"
          type="textarea"
          :rows="3"
          :placeholder="`浏览器登录 ${loginSource === 'qq' ? 'y.qq.com' : 'music.163.com'} 后，F12 → Network → 任选一个请求 → 复制请求头里的 Cookie 整行粘贴到这里`"
        />
        <div class="row" style="margin-top: 6px">
          <n-button size="small" type="primary" :loading="pasteBusy" @click="pasteCookie">
            保存 {{ sourceName(loginSource) }} Cookie
          </n-button>
        </div>
      </details>

      <div class="row" style="margin-top: 6px">
        <n-button
          size="small"
          type="primary"
          secondary
          :loading="ccSyncBusy"
          :disabled="ccSyncBusy"
          @click="syncFromCookieCloud"
        >
          从 CookieCloud 同步（网易+QQ）
        </n-button>
        <span class="hint">地址 / UUID / 密钥在「设置」页配置；同步成功后下方登录状态标签会自动刷新。</span>
      </div>

      <p class="hint">
        当前登录状态：
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
          { id: 'playlists', text: '我的歌单' },
          { id: 'tasks', text: `下载任务${pendingTasks.length ? ` (${pendingTasks.length})` : ''}` },
          { id: 'settings', text: '设置' },
        ]"
        :key="item.id"
        class="tabbtn"
        :class="{ on: tab === item.id }"
        @click="switchTab(item.id)"
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

    <!-- ③ 我的歌单 -->
    <section v-else-if="tab === 'playlists'" class="card">
      <!-- 歌单卡片列表 -->
      <template v-if="!playlistView">
        <div class="row">
          <h3 style="margin: 0">我的歌单</h3>
          <n-button
            v-for="item in sources"
            :key="item.id"
            size="small"
            :type="source === item.id ? 'primary' : 'default'"
            @click="switchPlaylistSource(item.id)"
          >
            {{ item.name }}
          </n-button>
          <n-button size="small" secondary :loading="playlistsLoading" :disabled="source !== 'netease'" @click="loadPlaylists">
            刷新
          </n-button>
          <n-tag
            v-for="item in loginTags"
            :key="`pl-${item.key}`"
            size="small"
            :type="item.ok ? 'success' : 'default'"
            :bordered="false"
          >
            {{ item.name }} {{ item.ok ? '已登录' : '未登录' }}
          </n-tag>
        </div>

        <!-- 与 runtime.rs:646 的后端文案一致 -->
        <n-alert v-if="source !== 'netease'" type="warning" :show-icon="true" class="alert" title="该来源暂不支持歌单，先支持网易云">
          歌单只接了网易云（后端 `playlists` / `playlist-songs` 仅落地 netease）。切回网易云，或去「搜索」页按歌搜。
        </n-alert>
        <template v-else>
          <div v-if="playlists.length" class="plgrid">
            <button v-for="playlist in playlists" :key="playlist.id" class="plcard" @click="openPlaylist(playlist)">
              <img v-if="playlist.cover" :src="playlist.cover" referrerpolicy="no-referrer" alt="" />
              <div class="plname">{{ playlist.name || '—' }}</div>
              <div class="plcount">{{ Number(playlist.count) || 0 }} 首{{ playlist.creator ? ` · ${playlist.creator}` : '' }}</div>
            </button>
          </div>
          <p v-else-if="playlistsLoading" class="hint">歌单加载中…</p>
          <p v-else class="hint">还没有歌单：未登录就先在上方「扫码登录」卡片扫码，然后点「刷新」。</p>
        </template>
      </template>

      <!-- 歌单曲目分页列表 -->
      <template v-else>
        <div class="row">
          <n-button size="small" secondary @click="closePlaylistView">← 返回歌单</n-button>
          <h3 style="margin: 0">{{ plName || '歌单' }}（{{ plTotal }} 首）</h3>
          <span class="spacer" />
          <select v-model="plBatchQuality" class="sel" :disabled="plBatchBusy" title="整单下载统一音质">
            <option v-for="value in qualitiesFor('netease')" :key="value" :value="value">
              {{ qualityLabel(value) }}
            </option>
          </select>
          <n-button
            size="small"
            type="primary"
            :loading="plBatchBusy"
            :disabled="plBatchBusy || !playlistView"
            @click="downloadPlaylistAll"
          >
            整单下载{{ plTotal > 0 ? `（共 ${plTotal} 首）` : '' }}
          </n-button>
        </div>

        <p v-if="plBatchBusy || plBatchProgress" class="hint">{{ plBatchProgress || '整单入队中…' }}</p>

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
                <n-button size="tiny" type="primary" :loading="submitting === String(song.id)" @click="download(song)">
                  下载
                </n-button>
              </td>
            </tr>
          </tbody>
        </table>

        <div v-if="plSongs.length && plSongs.length < plTotal" class="row" style="justify-content: center">
          <n-button size="small" :loading="plLoading" @click="fetchPlaylistSongs(plPage + 1)">
            加载更多（已载 {{ plSongs.length }}/{{ plTotal }}）
          </n-button>
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
        <h3 style="margin: 0">下载任务</h3>
        <n-tag size="small" :bordered="false">共 {{ tasks.length }} 条</n-tag>
        <n-tag v-if="pendingTasks.length" size="small" type="info" :bordered="false">进行中 {{ pendingTasks.length }}</n-tag>
        <n-tag v-if="failedTasks.length" size="small" type="error" :bordered="false">失败 {{ failedTasks.length }}</n-tag>
        <span class="spacer" />
        <n-button size="small" secondary :loading="taskBusy === 'pump'" :disabled="taskBusy === 'pump'" @click="pumpQueue">
          推进队列
        </n-button>
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
        任务由后台 job `queue-pump`（每 5 分钟，见 manifest）推进；想立刻推一轮点右上角「推进队列」（与 job 同一个入口，
        单次只新开 1 首）。失败任务最多自动重试 3 次，用尽后可在这一行点「重试」，
        或从 Telegram 失败通知的按钮重试。「清理已完成」只删 done/failed，进行中的任务不动。
      </p>
    </section>

    <!-- ⑤ 设置 -->
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
      <h4 class="sub">CookieCloud 同步（网易 + QQ 登录态）</h4>
      <div class="grid">
        <label class="field">
          <span class="label">CookieCloud 地址（cookiecloud_url）</span>
          <n-input v-model:value="form.cc_url" size="small" :placeholder="DEFAULT_CC_URL" />
          <span class="hint">服务端地址；清空保存后后端回落到默认 {{ DEFAULT_CC_URL }}。</span>
        </label>
        <label class="field">
          <span class="label">UUID（cookiecloud_uuid）</span>
          <n-input v-model:value="form.cc_uuid" size="small" placeholder="CookieCloud 的同步 UUID" />
          <span class="hint">CookieCloud 网页「同步页」上显示的 UUID。</span>
        </label>
        <label class="field">
          <span class="label">密钥（cookiecloud_key）</span>
          <n-input
            v-model:value="form.cc_key"
            type="password"
            show-password-on="click"
            size="small"
            placeholder="同步口令，不回显"
          />
          <span class="hint">{{ settings.cc_key_ready ? '已配置（不回显，重新输入可覆盖）' : '未配置' }}；留空保存不会清除已配置的密钥。</span>
        </label>
      </div>
      <p class="hint">
        三项与上方共用「保存」按钮（settings-update 的 cookiecloud_url / cookiecloud_uuid / cookiecloud_key）；
        配好后到「扫码登录」卡片点「从 CookieCloud 同步」。
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

    <!-- ⑥ 运行日志 -->
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
  border: 1px solid var(--dian-border);
  border-radius: 10px;
  background: var(--dian-surface);
  cursor: pointer;
  color: var(--dian-text-primary);
}
.plcard img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: 8px;
}
.plname {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plcount {
  font-size: 12px;
  color: var(--dian-text-muted);
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

.paste-cookie { margin: 10px 0 4px; }
.paste-cookie summary { cursor: pointer; font-size: 12px; opacity: .75; user-select: none; }
.paste-cookie .row { margin-top: 6px; }

</style>
