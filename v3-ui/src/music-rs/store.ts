// 音乐下载页面的状态与动作层。
//
// 行为基准是改写前的原生 JS 版页面（v3-ui/legacy/music-rs/page.js）：搜索/我的歌单/任务/设置
// 四个分页、网易云扫码登录（unikey + 二维码 + 2 秒轮询）、手动粘贴 Cookie、CookieCloud 同步、
// 单曲入队、歌单整单入队、任务重试/清理/索引对账/推进队列、设置保存、通知自检、最近动作日志，
// 逐项对应（功能零变动，只是从原生 DOM 换成 Vue 3 组件）。
//
// 数据通道（v3 契约）：所有数据与能力只走 ctx ——
// - 状态：ctx.storage（插件 KV，队列/日志/Cookie 都存在这里）；
// - 设置：ctx.settings.get() / set()（与宿主「管理」页同一份设置）；
// - 动作：ctx.tasks.run('queue-pump', …) 推进队列，ctx.tasks.get(id) 轮询到终态；
// - 网络：ctx.http（搜索/扫码/歌单走插件 lib/ 的网络层，lib 用 deps.http = ctx.http）；
// - CookieCloud：ctx.cookiecloud('read')；
// - 通知：ctx.notify。
// 不直接 fetch 宿主业务接口，不自建 WebSocket。

import { computed, inject, reactive, ref } from 'vue'
import type { HostContext } from '../shared/types'
import * as api from './plugin-api'
import type {
  LogEntry,
  LoginInfo,
  MusicSettings,
  PlaylistItem,
  PumpState,
  Song,
  TaskEntry,
  Toast,
} from './types'

/** 组件树里取 store 的注入键。 */
export const MUSIC_STORE_KEY = 'musicStore'

/** 扫码轮询间隔（毫秒）——与原生版一致。 */
const POLL_INTERVAL_MS = 2000
/** 任务页跟随刷新的间隔（毫秒）——与原生版一致。 */
const TASK_REFRESH_MS = 5000
/** 未登录时的引导文案关键字。 */
const MUSIC_NOT_LOGIN_HINT = '未登录'
/** 二维码有效期（毫秒）——网易云 unikey 约 3 分钟。 */
const QR_TTL_MS = 180 * 1000

/** 音质档位的中文名（原生版同表）。 */
export const QUALITY_LABELS: Record<string, string> = {
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

/** 两个音乐来源及其可选音质（原生版同表）。 */
export const SOURCES = [
  { id: 'netease', name: '网易云', qualities: api.LEVELS as string[] },
  { id: 'qq', name: 'QQ音乐', qualities: ['master', 'flac', '320', '128'] },
]

/** 设置与音质 chips 用的全部档位（去重，顺序同原生版）。 */
export const ALL_QUALITIES: string[] = [...(api.LEVELS as string[]), 'master', 'flac', '320', '128'].filter(
  (value, index, all) => all.indexOf(value) === index,
)

/** CookieCloud 白名单（原生版同表）。 */
const NETEASE_WHITELIST = [
  'MUSIC_U', 'MUSIC_A', 'MUSIC_A_T', 'MUSIC_R_T', 'MUSIC_SNS', 'NMTID',
  '__csrf', '__csrf_token', '_ntes_nuid', '_ntes_nnid',
]
const QQ_WHITELIST = [
  'qrsig', 'uin', 'skey', 'p_skey', 'ptui_loginuin', 'luin', 'qqmusic_key',
  'musickey', 'wxuin', 'wxunionid', 'euin', 'tmeLoginType', 'qqmusic_u',
]

/** 来源 id → 显示名。 */
export function sourceName(id: string): string {
  return SOURCES.find((item) => item.id === id)?.name ?? id ?? '—'
}

/** 音质 id → 显示名。 */
export function qualityLabel(value: string | undefined): string {
  return QUALITY_LABELS[value ?? ''] ?? value ?? '—'
}

/** 错误 → 文本。 */
function errorText(error: unknown): string {
  return String((error as { message?: string })?.message ?? error ?? '未知错误')
}

/** 未登录时补一句引导（原生版同文案）。 */
function loginHint(text: string): string {
  return text.includes(MUSIC_NOT_LOGIN_HINT)
    ? `${text} —— 先在上方「扫码登录」卡片扫码或粘贴 Cookie`
    : text
}

/** ISO 时间 → HH:MM:SS（原生版同格式）。 */
export function formatTime(value: unknown): string {
  const raw = typeof value === 'string' ? value : ''
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw)
  return match ? `${match[4]}:${match[5]}:${match[6] || '00'}` : raw || '—'
}

/**
 * 创建页面 store：一个插件页面一个实例，挂载期间一直活着。
 *
 * @param ctx 宿主上下文（页面所有数据与能力都从这里走）
 */
export function createMusicStore(ctx: HostContext) {
  const deps = api.buildDeps(ctx)
  const disposed = { value: false }

  // ── 状态 ──────────────────────────────────────────────
  const settings = ref<MusicSettings>(api.settingsView(api.normalizeSettings({})))
  const tasks = ref<TaskEntry[]>([])
  const login = reactive<{ netease: LoginInfo; qq: LoginInfo }>({
    netease: { logged_in: false },
    qq: { logged_in: false },
  })
  const logs = ref<LogEntry[]>([])
  const lastPump = ref<PumpState | null>(null)
  /** 当前正在执行的动作名（空串 = 空闲）；非空时相关按钮禁用（同原生版 setBusy）。 */
  const busy = ref('')
  const loading = ref(false)
  const toasts = ref<Toast[]>([])
  /** 队列互斥提示（整单入队被挡下时展示）。 */
  const queueBusyNotice = ref('')

  /** 关掉队列互斥提示。 */
  function clearQueueBusyNotice(): void {
    queueBusyNotice.value = ''
  }
  /** 通知自检结果（设置页展示）。 */
  const notifyResult = ref('')

  // ── 搜索 ──────────────────────────────────────────────
  const source = ref('netease')
  const query = ref('')
  const searchResults = ref<Song[]>([])
  const searchPage = ref(1)
  const searchTotal = ref<number | null>(null)

  // ── 歌单 ──────────────────────────────────────────────
  const playlists = ref<PlaylistItem[]>([])
  const playlistView = ref<{ id: string; name: string } | null>(null)
  const playlistSongs = ref<Song[]>([])
  const playlistTotal = ref(0)
  const playlistPage = ref(1)
  const playlistProgress = ref('')
  const playlistQuality = ref<string>(api.DEFAULT_QUALITY)
  /** 歌单封面（经 ctx.http 取回的 data URL；键是歌单 id）。 */
  const playlistCovers = reactive(new Map<string, string>())
  const coverInflight = new Set<string>()

  /** 歌单封面的 data URL；还没取到（或失败）时返回空串，模板据此不渲染 <img>。 */
  function coverFor(id: string): string {
    return playlistCovers.get(String(id)) ?? ''
  }

  /** 歌单封面并发取回：每个 URL 只请求一次，失败静默留空。 */
  async function loadPlaylistCovers(list: PlaylistItem[]): Promise<void> {
    const queue = list.filter((item) => {
      const url = typeof item.cover === 'string' ? item.cover.trim() : ''
      return /^https?:\/\//i.test(url) && !playlistCovers.has(item.id) && !coverInflight.has(item.id)
    })
    if (!queue.length) return
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < queue.length) {
        if (cancelled()) return
        const item = queue[cursor++]
        coverInflight.add(item.id)
        try {
          const dataUrl = await api.imageDataUrl(deps, item.cover)
          if (!cancelled()) playlistCovers.set(item.id, dataUrl)
        } catch {
          // 与原版「封面加载失败就把 <img> 摘掉」一致：留空，不影响歌单其余功能。
        } finally {
          coverInflight.delete(item.id)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker()))
  }

  /** 整单入队用的统一音质。 */
  function setPlaylistQuality(value: string): void {
    playlistQuality.value = value
  }

  // ── 扫码登录 ──────────────────────────────────────────
  const loginSource = ref<'netease' | 'qq'>('netease')
  const qr = ref<{ source: string; key: string; content: string; expiresAt: number } | null>(null)
  const qrStatus = ref('')
  const qrBusy = ref(false)
  const qrMessage = ref('')
  const qrTitle = ref('尚未生成二维码')
  const qrSub = ref('点右侧「获取二维码」开始扫码登录')

  // ── 手动粘贴 Cookie ───────────────────────────────────
  const cookieText = ref('')
  const cookiePanelOpen = ref(false)

  // ── 每首歌选择的音质（原生版 songQuality map 的等价物）────────────────
  const songQuality = reactive(new Map<string, string>())

  // 定时器登记：卸载时统一清掉。
  const timers = new Set<ReturnType<typeof setTimeout>>()
  /** 轮询 sleep 的唤醒函数：dispose 时立即唤醒，让循环走到取消判断。 */
  const sleepers = new Set<() => void>()
  let qrTimer: ReturnType<typeof setTimeout> | null = null
  let taskTimer: ReturnType<typeof setInterval> | null = null
  let toastSeq = 0

  /** 页面已释放或宿主中止 signal —— 长流程在每次进出 await 时用它自检。 */
  function cancelled(): boolean {
    return disposed.value || ctx.signal?.aborted === true
  }

  function later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!disposed.value) fn()
    }, ms)
    timers.add(timer)
  }

  /** 可被 dispose() 立即唤醒的 sleep（任务轮询用，不留下游离定时器）。 */
  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        timers.delete(timer)
        sleepers.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      timers.add(timer)
      sleepers.add(done)
    })
  }

  // ── 提示 ──────────────────────────────────────────────
  function toast(kind: Toast['kind'], message: string): void {
    // 卸载后不再建提示（也避免在 dispose 清空 timers 之后再登记一个游离定时器）。
    if (disposed.value) return
    const id = ++toastSeq
    toasts.value = [...toasts.value, { id, kind, message }]
    later(() => {
      toasts.value = toasts.value.filter((item) => item.id !== id)
    }, 4800)
  }

  // ── 读状态 ────────────────────────────────────────────
  async function refresh(): Promise<void> {
    if (disposed.value) return
    loading.value = true
    try {
      const [settingsRaw, index, logList, neteaseJar, qqJar, pumpState] = await Promise.all([
        api.readSettings(ctx),
        api.loadIndex(deps.kv),
        api.loadLogs(deps.kv),
        api.loadCookies(deps.kv, 'netease'),
        api.loadCookies(deps.kv, 'qq'),
        deps.kv.get('state'),
      ])
      settings.value = api.settingsView(settingsRaw)
      tasks.value = api.stateView(index)
      login.netease = api.neteaseLoginInfo(neteaseJar)
      login.qq = api.qqLoginInfo(qqJar)
      logs.value = logList.slice(-50).reverse()
      lastPump.value = pumpState?.last_pump ?? null
    } catch (error) {
      toast('error', `状态读取失败: ${errorText(error)}`)
    } finally {
      loading.value = false
    }
  }

  /** 统一的「忙碌 + 失败提示 + 收尾刷新」包装（原生版 withBusy）。 */
  async function withBusy<T>(name: string, label: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (busy.value) return undefined
    busy.value = name
    try {
      return await fn()
    } catch (error) {
      toast('error', `${label}: ${errorText(error)}`)
      return undefined
    } finally {
      busy.value = ''
      await refresh()
    }
  }

  // ── 音质选择 ──────────────────────────────────────────
  function qualitiesFor(song: Song): string[] {
    const own = Array.isArray(song?.qualities) && song.qualities.length ? song.qualities : null
    if (own) return own
    return SOURCES.find((item) => item.id === (song.source || source.value))?.qualities ?? ['flac', '320', '128']
  }

  function qualityOf(song: Song): string {
    const key = String(song?.id ?? '')
    const chosen = songQuality.get(key)
    if (chosen) return chosen
    const list = qualitiesFor(song)
    const own = typeof song.quality === 'string' ? song.quality : ''
    return (own && list.includes(own) ? own : list[0]) || 'flac'
  }

  function setSongQuality(song: Song, value: string): void {
    songQuality.set(String(song?.id ?? ''), value)
  }

  // ── 搜索 ──────────────────────────────────────────────
  async function runSearch(nextPage: number): Promise<void> {
    const text = query.value.trim()
    if (!text) return
    await withBusy('search', '搜索失败', async () => {
      const result =
        source.value === 'netease'
          ? await api.neteaseSearch(deps, text, nextPage)
          : await api.qqSearch(deps, text, nextPage)
      searchResults.value = nextPage > 1 ? [...searchResults.value, ...result.songs] : result.songs
      searchTotal.value = typeof result.total === 'number' ? result.total : null
      searchPage.value = nextPage
      if (!searchResults.value.length) toast('info', '没有搜索到内容')
    })
  }

  /** 切换搜索来源（原生版搜索段控件：清空已搜索结果，歌单页共用同一个 source）。 */
  function switchSource(next: string): void {
    if (source.value === next) return
    source.value = next
    searchResults.value = []
    searchTotal.value = null
    searchPage.value = 1
  }

  /** 切换歌单来源（原生版歌单段控件：清空歌单并回列表，切回网易云时重新拉取）。 */
  function switchPlaylistSource(next: string): void {
    if (source.value === next) return
    source.value = next
    playlists.value = []
    closePlaylist()
    if (next !== 'netease') toast('warning', '该来源暂不支持歌单，先支持网易云')
    else void loadPlaylists()
  }

  // ── 单曲入队 ──────────────────────────────────────────
  async function downloadSong(song: Song): Promise<void> {
    try {
      const outcome = await api.enqueue(deps.kv, {
        source: song.source || source.value,
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
      await api.addLog(
        deps.kv,
        'info',
        `入队: ${song.name ?? outcome.task.id} · ${qualityLabel(outcome.task.quality)}${outcome.deduped ? '（命中去重复用）' : ''}`,
      )
    } catch (error) {
      toast('error', loginHint(errorText(error)))
    } finally {
      await refresh()
    }
  }

  // ── 扫码登录 ──────────────────────────────────────────
  function stopQrPolling(): void {
    if (qrTimer !== null) {
      clearTimeout(qrTimer)
      qrTimer = null
    }
  }

  function scheduleQrPoll(): void {
    stopQrPolling()
    qrTimer = setTimeout(() => {
      qrTimer = null
      void pollQr()
    }, POLL_INTERVAL_MS)
    timers.add(qrTimer)
  }

  function resetQr(): void {
    stopQrPolling()
    qr.value = null
    qrStatus.value = ''
    qrMessage.value = ''
    qrTitle.value = '尚未生成二维码'
    qrSub.value = '点右侧「获取二维码」开始扫码登录'
  }

  async function createQr(src: string): Promise<void> {
    stopQrPolling()
    qr.value = null
    qrBusy.value = true
    qrMessage.value = ''
    qrStatus.value = ''
    qrTitle.value = '正在生成二维码…'
    qrSub.value = ''
    try {
      if (src === 'qq') throw new Error(api.QR_UNAVAILABLE)
      const data = await api.neteaseQrCreate(deps)
      qr.value = { source: src, key: data.key, content: data.qr_content, expiresAt: Date.now() + QR_TTL_MS }
      qrTitle.value = '等待扫码'
      qrSub.value = `用${sourceName(src)}音乐 App 扫一扫`
      qrStatus.value = 'waiting'
      qrBusy.value = false
      scheduleQrPoll()
    } catch (error) {
      resetQr()
      qrBusy.value = false
      toast('error', errorText(error))
    }
  }

  async function pollQr(): Promise<void> {
    const session = qr.value
    if (!session || disposed.value) return
    // 页面被关闭（宿主中止 signal）就停掉轮询，别再发请求。
    if (ctx.signal?.aborted) {
      stopQrPolling()
      qr.value = null
      return
    }
    if (Date.now() > session.expiresAt) {
      qrTitle.value = '二维码已过期'
      qrSub.value = '请重新获取'
      qrStatus.value = 'expired'
      toast('warning', '二维码已过期，请重新获取')
      return
    }
    try {
      const result = await api.neteaseQrPoll(deps, session.key)
      qrMessage.value = result.message ?? ''
      if (result.status === 'success' || result.logged_in === true) {
        qrStatus.value = 'success'
        qrTitle.value = '登录成功'
        qrSub.value = '登录态已保存'
        stopQrPolling()
        qr.value = null
        if (result.logged_in === true) toast('success', '登录成功')
        else toast('warning', result.message || '扫码成功，但未能取得登录 Cookie；请改用「手动粘贴 Cookie」')
        await refresh()
        return
      }
      if (result.status === 'expired') {
        qrTitle.value = '二维码已过期'
        qrSub.value = '请重新获取'
        qrStatus.value = 'expired'
        stopQrPolling()
        toast('warning', '二维码已过期，请重新获取')
        return
      }
      if (result.status === 'scanned') {
        qrTitle.value = '已扫码'
        qrSub.value = '请在手机上确认'
      }
      qrStatus.value = result.status || 'waiting'
      scheduleQrPoll()
    } catch (error) {
      qrMessage.value = errorText(error)
      qrStatus.value = 'failed'
      scheduleQrPoll()
    }
  }

  /** 切换登录来源（换来源时重置二维码）。 */
  function switchLoginSource(next: 'netease' | 'qq'): void {
    if (loginSource.value === next) return
    loginSource.value = next
    resetQr()
  }

  // ── 手动粘贴 Cookie ───────────────────────────────────
  function toggleCookiePanel(): void {
    cookiePanelOpen.value = !cookiePanelOpen.value
  }

  async function pasteCookie(): Promise<void> {
    const raw = cookieText.value.trim()
    if (!raw) {
      toast('warning', '请先粘贴 Cookie 头（浏览器 F12 → Network → 任意请求 → 请求头里的 Cookie 整行）')
      return
    }
    await withBusy('paste', 'Cookie 保存失败', async () => {
      const src = loginSource.value
      if (src === 'qq') {
        const cleaned = api.cleanQqCookieString(raw)
        if (cleaned.error) throw new Error(cleaned.error)
        const merged = await api.saveCookies(deps.kv, 'qq', cleaned.jar)
        toast('success', `QQ Cookie 已保存（${Object.keys(cleaned.jar).length} 条，合并后 ${Object.keys(merged).length} 条）`)
      } else {
        const cleaned = api.cleanNeteaseCookieString(raw)
        if (cleaned.error) throw new Error(cleaned.error)
        const merged = await api.saveCookies(deps.kv, 'netease', cleaned.jar)
        toast('success', `网易云 Cookie 已保存（${Object.keys(cleaned.jar).length} 条，合并后 ${Object.keys(merged).length} 条）`)
      }
      cookieText.value = ''
      await api.addLog(deps.kv, 'info', `${sourceName(src)} 手动粘贴 Cookie 已保存`)
    })
  }

  // ── CookieCloud 同步（宿主内置服务）────────────────────
  async function syncFromCookieCloud(): Promise<void> {
    await withBusy('cc', 'CookieCloud 同步失败', async () => {
      const snapshot = await ctx.cookiecloud('read', { domains: ['music.163.com', 'qq.com'] })
      const neteaseJar = api.extractCookiesFromSnapshot(snapshot, api.isNeteaseCloudDomain, NETEASE_WHITELIST)
      const qqRaw = api.extractCookiesFromSnapshot(snapshot, api.isQqCloudDomain, QQ_WHITELIST)
      const qqJar = api.normalizeCookies({ ...qqRaw }, 'qq')
      const neteaseMerged = await api.saveCookies(deps.kv, 'netease', neteaseJar)
      const qqMerged = await api.saveCookies(deps.kv, 'qq', qqJar)
      const neteaseInfo = api.neteaseLoginInfo(neteaseMerged)
      const qqInfo = api.qqLoginInfo(qqMerged)
      toast(
        'success',
        `CookieCloud 同步完成 —— 网易云: 保存 ${Object.keys(neteaseJar).length} 条, ${neteaseInfo.logged_in ? '已登录' : '未登录'}; ` +
          `QQ: 保存 ${Object.keys(qqJar).length} 条, ${qqInfo.logged_in ? '已登录' : '未登录'}`,
      )
      await api.addLog(
        deps.kv,
        'info',
        `CookieCloud 同步: 网易云 ${Object.keys(neteaseJar).length} 条(${neteaseInfo.logged_in ? '已登录' : '未登录'}), ` +
          `QQ ${Object.keys(qqJar).length} 条(${qqInfo.logged_in ? '已登录' : '未登录'})`,
      )
    })
  }

  // ── 歌单 ──────────────────────────────────────────────
  async function loadPlaylists(): Promise<void> {
    await withBusy('playlists', '歌单获取失败', async () => {
      if (source.value !== 'netease') {
        toast('warning', '该来源暂不支持歌单，先支持网易云')
        return
      }
      const result = await api.neteasePlaylists(deps)
      playlists.value = result.playlists
      void loadPlaylistCovers(result.playlists)
      if (!playlists.value.length) toast('info', '没有取到歌单（可能还没登录）')
    })
  }

  async function openPlaylist(playlist: PlaylistItem): Promise<void> {
    const id = String(playlist.id ?? '')
    if (!id) return
    playlistView.value = { id, name: String(playlist.name || '') }
    playlistSongs.value = []
    playlistTotal.value = Number(playlist.count) || 0
    playlistPage.value = 1
    await fetchPlaylistSongs(1)
  }

  function closePlaylist(): void {
    playlistView.value = null
    playlistSongs.value = []
    playlistTotal.value = 0
    playlistPage.value = 1
    playlistProgress.value = ''
  }

  async function fetchPlaylistSongs(nextPage: number): Promise<void> {
    const view = playlistView.value
    if (!view) return
    await withBusy('pl-songs', '歌单内容获取失败', async () => {
      const result = await api.neteasePlaylistSongs(deps, view.id, nextPage, 100)
      playlistSongs.value = nextPage > 1 ? [...playlistSongs.value, ...result.songs] : result.songs
      playlistPage.value = nextPage
      if (result.name) playlistView.value = { ...view, name: result.name }
      if (typeof result.total === 'number') playlistTotal.value = result.total
    })
  }

  /** 整单下载：分批翻页入队（后端按 next_page 续跑，不依赖已加载条数）。 */
  async function downloadPlaylistAll(): Promise<void> {
    const view = playlistView.value
    if (!view) {
      toast('warning', '请先打开一个歌单')
      return
    }
    await withBusy('pl-all', '整单入队失败', async () => {
      const total = playlistTotal.value > 0 ? playlistTotal.value : 0
      let queued = 0
      let deduped = 0
      let seen = 0
      let nextPage = 1
      let stopped = ''
      let skipped = ''
      // 整批只拉一次 v6 全量索引（0.3.15 形态），各页纯本地切片。
      let index: unknown = null
      playlistProgress.value = '正在整单入队…'
      for (;;) {
        if (cancelled()) {
          stopped = '页面已关闭，整单入队已停止'
          break
        }
        const result = await api.queuePlaylistPages(
          async (song: Song) => {
            if (cancelled()) throw new Error('页面已关闭')
            const outcome = await api.enqueue(deps.kv, {
              source: 'netease',
              song_id: String(song.id ?? '').trim(),
              name: song.name ?? '',
              singers: song.singers ?? '',
              album: song.album ?? '',
              quality: playlistQuality.value || api.DEFAULT_QUALITY,
            })
            return { deduped: outcome.deduped }
          },
          async (page: number, pageSize: number) => {
            if (cancelled()) throw new Error('页面已关闭')
            if (!index) index = await api.neteasePlaylistIndex({ ...deps, playlistId: view.id })
            return api.neteasePlaylistSongsFromIndex(deps, index, page, pageSize)
          },
          { startPage: nextPage, batchPages: api.PLAYLIST_QUEUE_DEFAULT_PAGES },
        )
        queued += result.data.queued
        deduped += result.data.deduped
        seen += result.data.total_seen
        if (cancelled()) {
          stopped = '页面已关闭，整单入队已停止'
          break
        }
        playlistProgress.value = `已入队 ${queued} 首(去重 ${deduped}), 进度 ${seen}${total > 0 ? `/${total}` : ''}`
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
      playlistProgress.value = ''
      // 页面已关闭：不再补提示/写日志（宿主已经卸载页面）。
      if (cancelled()) return
      if (skipped) {
        queueBusyNotice.value = String(skipped ?? '').trim()
        toast('warning', `${skipped}；已入队 ${queued} 首(去重 ${deduped})，未完成的可稍后再试`)
      } else if (stopped) {
        toast('error', `${loginHint(stopped)}；已入队 ${queued} 首(去重 ${deduped})，未完成的可重试`)
      } else {
        toast(
          'success',
          `整单入队完成：新增 ${queued} 首，去重 ${deduped} 首${seen > 0 ? `（共处理 ${seen}${total > 0 ? `/${total}` : ''} 首）` : ''}，进度去「任务」tab 看`,
        )
        await api.addLog(deps.kv, 'info', `整单入队: ${view.name} 新增 ${queued} 首, 去重 ${deduped} 首`)
      }
    })
  }

  // ── 任务动作 ──────────────────────────────────────────
  async function retryTask(task: TaskEntry): Promise<void> {
    await withBusy(`retry-${task.id}`, '重试失败', async () => {
      const outcome = await api.retry(deps.kv, task.id)
      toast('success', String(outcome.message || '已重新排队'))
      await api.addLog(deps.kv, 'info', `任务 ${task.id} 已重新排队`)
    })
  }

  async function clearAllFinished(): Promise<void> {
    await withBusy('clear', '清理失败', async () => {
      const removed = await api.clearFinished(deps.kv)
      toast('success', removed > 0 ? `已清理 ${removed} 条已结束任务` : '没有已结束的任务')
      if (removed > 0) await api.addLog(deps.kv, 'info', `已清理 ${removed} 条已结束任务`)
    })
  }

  async function adoptTask(taskId: string): Promise<void> {
    const id = taskId.trim()
    if (!id) {
      toast('info', '请输入任务 id（下载任务页可见，如 2gexs25y）')
      return
    }
    await withBusy('adopt', '对账失败', async () => {
      const outcome = await api.adopt(deps.kv, id)
      if (outcome.adopted) {
        toast('success', String(outcome.message || '已挂回索引'))
        await api.addLog(deps.kv, 'info', `索引对账: 任务 ${id} 已挂回索引`)
      } else {
        toast('info', String(outcome.message || '已在索引里，无需对账'))
      }
    })
  }

  /** 推进队列：提交统一任务队列里的 queue-pump，并轮询到终态。 */
  async function pumpQueue(): Promise<void> {
    await withBusy('pump', '推进失败', async () => {
      const run = await ctx.tasks.run('queue-pump', `pump-${Date.now()}`, {})
      const finished = await pollRun(run, 30000)
      if (finished.status === 'failed') throw new Error(finished.error || '推进失败')
      if (finished.status === 'attention_required') throw new Error('任务需要核对（见宿主任务队列）')
      const summary = finished.result ?? {}
      const lines = (summary.messages ?? []).map((m: unknown) => String(m).trim()).filter(Boolean)
      toast('success', lines.length > 0 ? lines.slice(0, 3).join('；') : `已推进（排队 ${summary.queued ?? 0} · 进行中 ${summary.active ?? 0}）`)
    })
  }

  /** 轮询宿主任务直到终态；页面关闭（signal 中止）就放手，让它转后台继续。 */
  async function pollRun(run: Record<string, any>, timeoutMs: number): Promise<Record<string, any>> {
    const started = Date.now()
    let current = run
    while (current && (current.status === 'queued' || current.status === 'running')) {
      if (cancelled()) throw new Error('页面已关闭，任务转入后台继续')
      if (Date.now() - started > timeoutMs) {
        return { ...current, status: 'running', message: `任务仍在运行（${current.id}），可在宿主任务队列查看` }
      }
      await sleep(800)
      if (cancelled()) throw new Error('页面已关闭，任务转入后台继续')
      current = await ctx.tasks.get(current.id)
    }
    return current
  }

  // ── 设置 ──────────────────────────────────────────────
  async function saveSettings(patch: Partial<MusicSettings>): Promise<void> {
    await withBusy('settings', '设置保存失败', async () => {
      const current = api.normalizeSettings(settings.value)
      const next = api.applySettingsPatch(current, patch)
      await ctx.settings.set(next)
      toast('success', '设置已保存')
      await api.addLog(deps.kv, 'info', '设置已保存')
    })
  }

  /** 通知自检：发一条 info 通知，把结果回显在设置页。 */
  async function testNotify(): Promise<void> {
    await withBusy('notify', '通知自检失败', async () => {
      if (typeof ctx.notify !== 'function') throw new Error('当前宿主没有 ctx.notify')
      const outcome = (await ctx.notify({
        level: 'info',
        title: '音乐下载 · 通知链路自检',
        body: '这是一条测试通知: 收到说明插件通知可用。',
        dedupe_key: `mr-dl-notifytest-${Date.now()}`,
      })) as { accepted?: boolean; deduplicated?: boolean; channels?: Array<{ channel: string }> } | undefined
      const parts = [`accepted: ${outcome?.accepted}`, outcome?.deduplicated ? '（被去重）' : '']
      if (outcome?.channels?.length) {
        parts.push(`通道: ${outcome.channels.map((c: { channel: string }) => c.channel).join(' · ')}`)
      }
      notifyResult.value = parts.filter(Boolean).join(' · ')
      toast(outcome?.accepted ? 'success' : 'warning', notifyResult.value)
    })
  }

  // ── 派生量 ────────────────────────────────────────────
  const pendingTasks = computed(() =>
    tasks.value.filter((task) => ['queued', 'downloading', 'copying'].includes(task.status)),
  )
  const failedTasks = computed(() => tasks.value.filter((task) => task.status === 'failed'))

  /** 任务页有进行中任务时每 5 秒跟随队列刷新（原生版 ensureTaskTimer）。 */
  function setTaskRefresh(enabled: boolean): void {
    if (enabled && taskTimer === null) {
      taskTimer = setInterval(() => {
        if (!busy.value) void refresh()
      }, TASK_REFRESH_MS)
    } else if (!enabled && taskTimer !== null) {
      clearInterval(taskTimer)
      taskTimer = null
    }
  }

  /** 卸载：停定时器、退订、标记已释放。 */
  function dispose(): void {
    disposed.value = true
    stopQrPolling()
    if (taskTimer !== null) {
      clearInterval(taskTimer)
      taskTimer = null
    }
    for (const done of Array.from(sleepers)) done()
    sleepers.clear()
    for (const timer of timers) {
      clearTimeout(timer)
    }
    timers.clear()
  }

  return {
    // 状态
    settings,
    tasks,
    login,
    logs,
    lastPump,
    busy,
    loading,
    toasts,
    queueBusyNotice,
    clearQueueBusyNotice,
    notifyResult,
    source,
    query,
    searchResults,
    searchPage,
    searchTotal,
    playlists,
    playlistView,
    playlistSongs,
    playlistTotal,
    playlistPage,
    playlistProgress,
    playlistQuality,
    setPlaylistQuality,
    coverFor,
    loginSource,
    qr,
    qrStatus,
    qrBusy,
    qrMessage,
    qrTitle,
    qrSub,
    cookieText,
    cookiePanelOpen,
    songQuality,
    pendingTasks,
    failedTasks,
    // 动作
    refresh,
    withBusy,
    sourceName,
    qualityLabel,
    qualitiesFor,
    qualityOf,
    setSongQuality,
    runSearch,
    switchSource,
    switchPlaylistSource,
    downloadSong,
    createQr,
    resetQr,
    switchLoginSource,
    toggleCookiePanel,
    pasteCookie,
    syncFromCookieCloud,
    loadPlaylists,
    openPlaylist,
    closePlaylist,
    fetchPlaylistSongs,
    downloadPlaylistAll,
    retryTask,
    clearAllFinished,
    adoptTask,
    pumpQueue,
    saveSettings,
    testNotify,
    setTaskRefresh,
    dispose,
  }
}

/** store 类型（组件里 inject 用）。 */
export type MusicStore = ReturnType<typeof createMusicStore>

/** 组件里取 store。 */
export function useMusicStore(): MusicStore {
  const store = inject<MusicStore | undefined>(MUSIC_STORE_KEY, undefined)
  if (!store) throw new Error('[music-rs] 组件树里没有 musicStore：页面必须通过 mount(el, ctx) 装配。')
  return store
}
