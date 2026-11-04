// 音乐下载页面的状态与动作层。
//
// 行为基准是改写前的原生 JS 版页面（v3-ui/legacy/music-rs/page.js）：搜索/我的歌单/任务/设置
// 四个分页、网易云与 QQ 音乐扫码登录（二维码 + 2 秒轮询）、手动粘贴 Cookie、
// 单曲入队、歌单整单入队、任务重试/清理/索引对账/推进队列、设置保存、通知自检、最近动作日志，
// 逐项对应（功能零变动，只是从原生 DOM 换成 Vue 3 组件）。
//
// 数据通道（v3 契约）：所有数据与能力只走 ctx ——
// - 状态：ctx.storage（插件 KV，队列/日志/Cookie 都存在这里）；
// - 设置：ctx.settings.get() / set()（与宿主「管理」页同一份设置）；
// - 动作：ctx.tasks.run('queue-pump', …) 推进队列，ctx.tasks.get(id) 轮询到终态；
// - 网络：ctx.http（搜索/扫码/歌单走插件 lib/ 的网络层，lib 用 deps.http = ctx.http）；
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
  PlaylistView,
  PumpState,
  QrPollResult,
  QrSession,
  QrStatus,
  Song,
  TaskEntry,
  Toast,
  VipInfo,
} from './types'

/** 组件树里取 store 的注入键。 */
export const MUSIC_STORE_KEY = 'musicStore'

/** 扫码轮询间隔（毫秒）——与原生版一致。 */
const POLL_INTERVAL_MS = 2000
/** 任务页跟随刷新的间隔（毫秒）——与原生版一致。 */
const TASK_REFRESH_MS = 5000
/** 字节进度的轻量轮询间隔：只查当前这一个宿主任务，不读 KV。 */
const PROGRESS_REFRESH_MS = 500
/** 会员信息缓存：6 小时。会员档位不常变，避免每次 5 秒刷新都打外部接口。 */
const VIP_CACHE_MS = 6 * 3600 * 1000
/** 未登录时的引导文案关键字。 */
const MUSIC_NOT_LOGIN_HINT = '未登录'
/** 二维码有效期（毫秒）：QQ 官方二维码 120 秒（与 lib/qq.js QQ_QR_TTL_SECS 一致），
 *  网易云 unikey 约 3 分钟。两个来源不共用一个有效期。 */
const QR_TTL_BY_SOURCE: Record<string, number> = {
  qq: 120 * 1000,
  netease: 180 * 1000,
}

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

/** QQ 可用的音质档位（取链阶梯只认这几档；见 lib/qq.js qualityStart）。 */
export const QQ_QUALITIES = ['master', 'flac', '320', '128']

/** 两个音乐来源及其可选音质（原生版同表）。 */
export const SOURCES = [
  { id: 'netease', name: '网易云', qualities: api.LEVELS as string[] },
  { id: 'qq', name: 'QQ音乐', qualities: QQ_QUALITIES },
]

/** 设置与音质 chips 用的全部档位（去重，顺序同原生版）。 */
export const ALL_QUALITIES: string[] = [...(api.LEVELS as string[]), ...QQ_QUALITIES].filter(
  (value, index, all) => all.indexOf(value) === index,
)

/** 来源 id → 显示名。 */
export function sourceName(id: string): string {
  return SOURCES.find((item) => item.id === id)?.name ?? id ?? '—'
}

/** 扫码提示文案（按来源）：网易云用 App 扫，QQ 用手机 QQ 扫。 */
export function scanHint(id: string): string {
  return id === 'qq' ? '用手机 QQ 扫一扫' : '用网易云音乐 App 扫一扫'
}

/** 音质 id → 显示名。 */
export function qualityLabel(value: string | undefined): string {
  return QUALITY_LABELS[value ?? ''] ?? value ?? '—'
}

/** 某个来源的合法音质档位（网易云 = eapi LEVELS；QQ = master/flac/320/128）。 */
export function qualitiesOfSource(id: string): string[] {
  return SOURCES.find((item) => item.id === id)?.qualities ?? (api.LEVELS as string[])
}

/** 统一音质是否适用于目标来源；不适用就换成该来源的默认档（不伪造别的档位）。 */
export function qualityForSource(id: string, current: string): string {
  if (qualitiesOfSource(id).includes(current)) return current
  return id === 'qq' ? 'flac' : api.DEFAULT_QUALITY
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
  /** 列表展示的任务（最近 STATE_TASKS_LIMIT 条）。 */
  const tasks = ref<TaskEntry[]>([])
  /** 完整索引（按队列序）：计数与排队位置用它，不受展示上限影响。 */
  const allTasks = ref<TaskEntry[]>([])
  /** 需要核对（attention_required）的 queue-pump 运行：核对前宿主不再接受新的推进（含定时）。 */
  const attentionRun = ref<{ id: string; message: string } | null>(null)
  /** 正在运行的 queue-pump 宿主任务：message 里有宿主每秒写入的入库字节进度，total/done/failed 是本轮计数。 */
  const pumpRun = ref<{ message: string; total: number; done: number; failed: number } | null>(null)
  /** VIP/付费歌曲入队确认弹窗：单首或批量共用一个，确认后继续入队。 */
  const vipGate = ref<{ open: boolean; items: Song[]; mode: 'single' | 'batch' }>({
    open: false,
    items: [],
    mode: 'single',
  })
  let vipGateResolver: ((ok: boolean) => void) | null = null
  const login = reactive<{ netease: LoginInfo; qq: LoginInfo }>({
    netease: { logged_in: false },
    qq: { logged_in: false },
  })
  /** 会员档位（网易 vip/info 实测字段；QQ 识别不到时为 unknown，只显示已登录）。 */
  const vip = reactive<{ netease: VipInfo | null; qq: VipInfo | null }>({ netease: null, qq: null })
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
  const playlistView = ref<PlaylistView | null>(null)
  const playlistSongs = ref<Song[]>([])
  const playlistTotal = ref(0)
  const playlistPage = ref(1)
  const playlistProgress = ref('')
  const playlistQuality = ref<string>(api.DEFAULT_QUALITY)
  /** 歌单列表区的后端提示（如 QQ 缺 encryptUin 读不到收藏）——原样展示，不静默。 */
  const playlistNotice = ref('')
  /** 当前来源的歌单是否已经成功拉取过一次：没拉过 ≠ 一个都没有（空态文案要分开）。 */
  const playlistsLoaded = ref(false)
  /** 歌单列表区的真实错误（未登录 / 网络失败等）——原样展示，不伪造空列表。 */
  const playlistError = ref('')
  /** 歌单详情区的真实错误（取曲目失败，如私密歌单缺凭据）。 */
  const playlistSongsError = ref('')
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

  /** QQ 歌单分段：我创建的（kind = created；「我喜欢」是伪歌单，单独走特殊入口）。 */
  const playlistCreated = computed<PlaylistItem[]>(() =>
    source.value === 'qq'
      ? playlists.value.filter((item) => (item.kind ?? 'created') === 'created')
      : playlists.value,
  )

  /** QQ 歌单分段：收藏的（kind = fav）。 */
  const playlistFavorites = computed<PlaylistItem[]>(() =>
    source.value === 'qq'
      ? playlists.value.filter((item) => item.kind === 'fav' || item.kind === 'saved')
      : [],
  )

  /**
   * QQ 特殊入口（每日推荐 / 我喜欢）——它们不是普通歌单，取曲目走各自的后端接口
   * （qqDailyRecommendations / qqLikedSongs）。网易云后端没有对应接口，故只对 QQ 出现。
   */
  const specialPlaylists = computed<PlaylistItem[]>(() => {
    if (source.value !== 'qq') return []
    const liked = playlists.value.find((item) => item.kind === 'liked')
    return [
      { id: 'daily', name: '每日推荐', cover: '', count: 0, creator: '', kind: 'special', special: 'daily' },
      {
        id: 'liked',
        name: '我喜欢',
        cover: '',
        count: Number(liked?.count) || 0,
        creator: '',
        kind: 'special',
        special: 'liked',
      },
    ]
  })

  // ── 扫码登录 ──────────────────────────────────────────
  const loginSource = ref<'netease' | 'qq'>('netease')
  /** 当前二维码：网易云是 content（本地编码），QQ 是 image（官方 PNG）。 */
  const qr = ref<QrSession | null>(null)
  const qrStatus = ref<QrStatus>('')
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
  /** 进行中的 pump 任务 id 与它的轻量进度轮询定时器。 */
  let pumpRunId = ''
  let progressTimer: ReturnType<typeof setInterval> | null = null
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
      const sorted = [...index]
      api.sortIndex(sorted)
      allTasks.value = sorted
      tasks.value = api.stateView(index)
      login.netease = api.neteaseLoginInfo(neteaseJar)
      // QQ：登录态摘要 + 有没有账号标识（encryptUin）。收藏歌单 / 我喜欢接口的
      // uin 参数要用它，没有就如实告诉页面「读不到」，别装作没有收藏。
      login.qq = { ...api.qqLoginInfo(qqJar), ...api.qqLibraryInfo(qqJar) }
      logs.value = logList.slice(-50).reverse()
      lastPump.value = pumpState?.last_pump ?? null
    } catch (error) {
      toast('error', `状态读取失败: ${errorText(error)}`)
    } finally {
      loading.value = false
    }
    await refreshAttention()
    void refreshVip()
  }

  /** 查最近的 queue-pump 运行里有没有「需要核对」的（宿主重启打断时产生）。读不到就当没有。 */
  async function refreshAttention(): Promise<void> {
    if (disposed.value || typeof ctx.tasks?.list !== 'function') return
    try {
      const runs = await ctx.tasks.list(20)
      const list = Array.isArray(runs) ? runs : []
      const hit = list.find((run) => run.job_id === 'queue-pump' && run.status === 'attention_required')
      attentionRun.value = hit ? { id: String(hit.id), message: String(hit.message || hit.error || '') } : null
      // 进行中的 pump：读取宿主任务上的实时进度（入库时宿主每秒写“移动 x 1.2 GiB/4.0 GiB”）。
      const running = list.find(
        (run) => run.job_id === 'queue-pump' && ['running', 'pending', 'queued'].includes(String(run.status)),
      )
      pumpRun.value = running ? pumpRunOf(running) : null
      pumpRunId = running ? String(running.id ?? '') : ''
      setProgressRefresh(Boolean(pumpRunId))
    } catch {
      // 任务列表只用于提示，读失败不打扰。
    }
  }

  /** 宿主任务 → 进度快照。 */
  function pumpRunOf(run: Record<string, unknown>): { message: string; total: number; done: number; failed: number } {
    return {
      message: String(run.message ?? ''),
      total: Number(run.total ?? 0) || 0,
      done: Number(run.done ?? 0) || 0,
      failed: Number(run.failed ?? 0) || 0,
    }
  }

  /** 字节进度单独走 0.5 秒轮询：只查这一个任务，不读插件 KV。 */
  function setProgressRefresh(enabled: boolean): void {
    if (enabled && progressTimer === null) {
      progressTimer = setInterval(() => {
        void tickProgress()
      }, PROGRESS_REFRESH_MS)
    } else if (!enabled && progressTimer !== null) {
      clearInterval(progressTimer)
      progressTimer = null
    }
  }

  async function tickProgress(): Promise<void> {
    if (disposed.value || !pumpRunId) return
    try {
      const run = await ctx.tasks.get(pumpRunId)
      const status = String(run?.status ?? '')
      if (!['running', 'pending', 'queued'].includes(status)) {
        // 任务结束：停掉快进轮询，并拉一次完整状态（任务列表要刷新）。
        pumpRun.value = null
        pumpRunId = ''
        setProgressRefresh(false)
        void refresh()
        return
      }
      pumpRun.value = pumpRunOf(run)
    } catch {
      // 单次读失败不影响页面，下一拍重试。
    }
  }

  /** 会员档位：登录后才取，6 小时缓存进插件 KV；失败只影响会员区显示，不影响登录卡。 */
  async function refreshVip(): Promise<void> {
    if (disposed.value) return
    for (const source of ['netease', 'qq'] as const) {
      const logged = source === 'netease' ? login.netease.logged_in : login.qq.logged_in
      if (!logged) {
        vip[source] = null
        continue
      }
      const cacheKey = `vip.${source}`
      try {
        const cached = await deps.kv.get(cacheKey)
        // 未识别的档位（QQ 字段待适配）只缓存 5 分钟，避免升级后仍卡在旧结果。
        const ttl = cached?.info?.tier === 'unknown' ? 5 * 60 * 1000 : VIP_CACHE_MS
        if (cached && Date.now() - Number(cached.fetched_ms ?? 0) < ttl) {
          vip[source] = (cached.info ?? null) as VipInfo | null
          continue
        }
        const info = source === 'netease' ? await api.fetchNeteaseVip(deps) : await api.fetchQqVip(deps)
        vip[source] = info
        await deps.kv.set(cacheKey, { fetched_ms: Date.now(), info })
      } catch {
        // 会员接口失败/未识别：保留旧值（没有就是 null），不打扰页面。
      }
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

  /** 切换歌单来源（原生版歌单段控件：清空歌单并回列表，再按新来源重新拉取）。 */
  function switchPlaylistSource(next: string): void {
    if (source.value === next) return
    source.value = next
    playlists.value = []
    playlistNotice.value = ''
    playlistError.value = ''
    // 还没拉过新来源的歌单：空态不能说「没有歌单」（那是在断言一件没验证的事）。
    playlistsLoaded.value = false
    closePlaylist()
    // 统一音质按来源换档（网易云的档位对 QQ 无效，反之亦然）。
    playlistQuality.value = qualityForSource(next, playlistQuality.value)
    void loadPlaylists()
  }

  // ── 单曲入队 ──────────────────────────────────────────
  /** 会员/付费歌曲确认：返回用户是否仍然入队。批量模式下确认一次，后续同类不再弹。 */
  function askVipGate(items: Song[], mode: 'single' | 'batch'): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      vipGateResolver = resolve
      vipGate.value = { open: true, items, mode }
    })
  }

  /** 弹窗回调：确定 = 强行入队，取消 = 跳过。 */
  function resolveVipGate(ok: boolean): void {
    vipGate.value = { open: false, items: [], mode: vipGate.value.mode }
    const resolve = vipGateResolver
    vipGateResolver = null
    if (resolve) resolve(ok)
  }

  async function downloadSong(song: Song): Promise<void> {
    try {
      if (song.vip) {
        const ok = await askVipGate([song], 'single')
        if (!ok) {
          toast('info', `已取消入队: ${song.name ?? ''}`)
          return
        }
      }
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
  /** 二维码代次：每次新建/重置二维码 +1。在途的轮询回来后如果代次变了，
   *  说明这次结果属于一张已经被替换掉的二维码 —— 直接丢弃，不改状态也不再挂轮询。 */
  let qrGeneration = 0

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
    qrGeneration += 1
    qrBusy.value = false
    qr.value = null
    qrStatus.value = ''
    qrMessage.value = ''
    qrTitle.value = '尚未生成二维码'
    qrSub.value = '点右侧「获取二维码」开始扫码登录'
  }

  /**
   * 取二维码：按来源分派到各自的接口。
   * - qq：qqQrCreate 返回官方 PNG（data URL），页面直接 <img> 渲染；
   * - netease：neteaseQrCreate 只给登录页 URL，页面本地编码成 SVG。
   * 两个来源的二维码有效期不同（QQ 120 秒 / 网易云 180 秒），各自算。
   */
  async function createQr(src: string): Promise<void> {
    stopQrPolling()
    qrGeneration += 1
    const generation = qrGeneration
    qr.value = null
    qrBusy.value = true
    qrMessage.value = ''
    qrStatus.value = ''
    qrTitle.value = '正在生成二维码…'
    qrSub.value = ''
    try {
      const ttl = QR_TTL_BY_SOURCE[src] ?? QR_TTL_BY_SOURCE.netease
      if (src === 'qq') {
        const data = await api.qqQrCreate(deps)
        const key = String(data?.key ?? '')
        const image = String(data?.image ?? '')
        if (!key) throw new Error('获取二维码失败：后端没给二维码句柄')
        if (!image.startsWith('data:image/')) throw new Error('获取二维码失败：后端没给二维码图片')
        if (generation !== qrGeneration) return
        qr.value = { source: src, key, image, expiresAt: Date.now() + ttl }
      } else {
        const data = await api.neteaseQrCreate(deps)
        const key = String(data?.key ?? '')
        const content = String(data?.qr_content ?? '')
        if (!key || !content) throw new Error('获取二维码失败：后端没给二维码内容')
        if (generation !== qrGeneration) return
        qr.value = { source: src, key, content, expiresAt: Date.now() + ttl }
      }
      qrTitle.value = '等待扫码'
      qrSub.value = scanHint(src)
      qrStatus.value = 'waiting'
      qrBusy.value = false
      scheduleQrPoll()
    } catch (error) {
      // 期间又换了一张二维码：这次失败不算数，别把新二维码的状态覆盖掉。
      if (generation !== qrGeneration) return
      resetQr()
      qrBusy.value = false
      toast('error', errorText(error))
    }
  }

  /** 轮询扫码状态：按来源分派；成功与否只看后端回的 logged_in。 */
  async function pollQr(): Promise<void> {
    const session = qr.value
    if (!session || disposed.value) return
    // 本次轮询属于哪一代二维码：请求期间二维码被换掉/关掉，结果就作废。
    const generation = qrGeneration
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
      stopQrPolling()
      toast('warning', '二维码已过期，请重新获取')
      return
    }
    try {
      const result = (session.source === 'qq'
        ? await api.qqQrPoll(deps, session.key)
        : await api.neteaseQrPoll(deps, session.key)) as QrPollResult
      // 回来的结果属于一张已经被换掉的二维码 —— 丢掉，别改新二维码的状态，也别再挂轮询。
      if (generation !== qrGeneration) return
      qrMessage.value = result?.message ?? ''
      const status = (result?.status || 'waiting') as QrStatus
      if (status === 'success') {
        // 到这一步只是「扫到了」，登录成不成功看后端有没有真的拿到登录凭据。
        stopQrPolling()
        if (result?.logged_in === true) {
          qrStatus.value = 'success'
          qrTitle.value = '登录成功'
          qrSub.value = '登录态已保存'
          toast('success', '登录成功')
          // 登录成了但收尾没做完（如宿主会话里的 QQ 授权 Cookie 没清掉）——单独告警。
          if (result?.warning) toast('warning', result.warning)
        } else {
          // 没拿到凭据就如实说没拿到，绝不冒充登录成功。
          qrStatus.value = 'no-login'
          qrTitle.value = '扫码完成，未取得登录态'
          qrSub.value = '请用「手动粘贴 Cookie」完成登录'
          toast('warning', result?.message || '扫码成功，但没能取到登录 Cookie；请改用「手动粘贴 Cookie」')
        }
        await refresh()
        return
      }
      if (status === 'expired') {
        qrTitle.value = '二维码已过期'
        qrSub.value = '请重新获取'
        qrStatus.value = 'expired'
        stopQrPolling()
        toast('warning', '二维码已过期，请重新获取')
        return
      }
      if (status === 'waiting') {
        // 上一轮轮询报错后恢复：文案回到「等待扫码」，别停在错误态。
        qrTitle.value = '等待扫码'
        qrSub.value = scanHint(session.source)
      }
      if (status === 'scanned') {
        qrTitle.value = '已扫码'
        qrSub.value = '请在手机上确认'
      }
      if (status === 'failed') {
        qrTitle.value = '扫码状态异常'
        qrSub.value = result?.message || '请重新获取二维码'
      }
      qrStatus.value = status
      scheduleQrPoll()
    } catch (error) {
      // 期间二维码被换掉：这次失败属于旧会话，别把新二维码的状态改成失败。
      if (generation !== qrGeneration) return
      // 网络/会话类错误：如实显示，并按 2 秒继续重试，直到本地有效期到。
      qrMessage.value = errorText(error)
      qrStatus.value = 'failed'
      qrTitle.value = '轮询失败'
      qrSub.value = '正在重试；若持续失败请重新获取二维码'
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

  // ── 歌单 ──────────────────────────────────────────────
  /**
   * 我的歌单：按当前来源分派（网易云走原逻辑，QQ 走 qqPlaylists）。
   *
   * 错误与提示都如实落在歌单区（playlistError / playlistNotice），
   * 不把「读不到」说成「没有歌单」。
   */
  async function loadPlaylists(): Promise<void> {
    // 上一次操作还在跑时，withBusy 会直接跳过 —— 别让它悄悄变成「这个来源没有歌单」。
    if (busy.value) {
      toast('warning', '有操作正在进行，稍后点「刷新」重试')
      return
    }
    playlistNotice.value = ''
    playlistError.value = ''
    await withBusy('playlists', '歌单获取失败', async () => {
      try {
        if (source.value === 'qq') {
          const result = await api.qqPlaylists(deps)
          playlists.value = Array.isArray(result?.playlists) ? result.playlists : []
          // 后端提示（如缺 encryptUin 读不到收藏）原样展示。
          playlistNotice.value = String(result?.notice ?? '')
          playlistsLoaded.value = true
          void loadPlaylistCovers(playlists.value)
          if (!playlists.value.length) toast('info', '没有取到歌单')
          return
        }
        const result = await api.neteasePlaylists(deps)
        playlists.value = Array.isArray(result?.playlists) ? result.playlists : []
        playlistsLoaded.value = true
        void loadPlaylistCovers(playlists.value)
        if (!playlists.value.length) toast('info', '没有取到歌单（可能还没登录）')
      } catch (error) {
        playlistError.value = loginHint(errorText(error))
        throw error
      }
    })
  }

  /** 打开一个歌单（普通歌单或 QQ 的特殊入口）。 */
  async function openPlaylist(playlist: PlaylistItem): Promise<void> {
    const id = String(playlist.id ?? '')
    if (!id) return
    const special = String(playlist.special ?? '')
    playlistView.value = {
      id,
      name: String(playlist.name || ''),
      source: source.value,
      // 特殊入口用 'daily' / 'liked' 当目标（后端按目标分派）；普通歌单用歌单 id。
      target: special || id,
      special,
    }
    playlistSongs.value = []
    playlistSongsError.value = ''
    playlistTotal.value = Number(playlist.count) || 0
    playlistPage.value = 1
    // 统一音质按来源换档（当前档位对这个来源无效时才换）。
    playlistQuality.value = qualityForSource(source.value, playlistQuality.value)
    await fetchPlaylistSongs(1)
  }

  function closePlaylist(): void {
    playlistView.value = null
    playlistSongs.value = []
    playlistSongsError.value = ''
    playlistTotal.value = 0
    playlistPage.value = 1
    playlistProgress.value = ''
  }

  /**
   * QQ 曲目取回：按入口分派到各自的后端接口。
   * - 每日推荐：qqDailyRecommendations（一次取回全部，页面按 begin/num 本地切片）；
   * - 我喜欢：qqLikedSongs（游标 = begin）；
   * - 普通歌单：qqPlaylistSongs（游标 = begin）。
   */
  async function fetchQqSongs(
    view: PlaylistView,
    begin: number,
    size: number,
  ): Promise<{ songs: Song[]; total: number; name: string }> {
    if (view.special === 'daily') {
      // 每日推荐接口没有游标：后端整份取回后按 begin/num 切片（后端按账号缓存了
      // 整份列表，翻页不会把全量重新拉一遍）。
      const result = await api.qqPlaylistSongs(deps, 'daily', begin, size)
      const songs = Array.isArray(result?.songs) ? result.songs : []
      return {
        songs,
        total: typeof result?.total === 'number' ? result.total : songs.length,
        name: String(result?.name || '每日推荐'),
      }
    }
    if (view.special === 'liked') {
      const result = await api.qqLikedSongs(deps, begin, size)
      return {
        songs: Array.isArray(result?.songs) ? result.songs : [],
        total: typeof result?.total === 'number' ? result.total : 0,
        name: String(result?.name || '我喜欢'),
      }
    }
    const result = await api.qqPlaylistSongs(deps, view.target, begin, size)
    return {
      songs: Array.isArray(result?.songs) ? result.songs : [],
      total: typeof result?.total === 'number' ? result.total : 0,
      name: String(result?.name || view.name || ''),
    }
  }

  /** 歌单曲目：按页拉取（网易云走原接口，QQ 走 begin/num 游标）。 */
  async function fetchPlaylistSongs(nextPage: number): Promise<void> {
    const view = playlistView.value
    if (!view) return
    playlistSongsError.value = ''
    await withBusy('pl-songs', '歌单内容获取失败', async () => {
      try {
        if (view.source === 'qq') {
          const size = api.PLAYLIST_PAGE_SIZE
          const begin = (nextPage - 1) * size
          const result = await fetchQqSongs(view, begin, size)
          playlistSongs.value = nextPage > 1 ? [...playlistSongs.value, ...result.songs] : result.songs
          playlistPage.value = nextPage
          if (result.name) playlistView.value = { ...view, name: result.name }
          if (typeof result.total === 'number') playlistTotal.value = result.total
          return
        }
        const result = await api.neteasePlaylistSongs(deps, view.id, nextPage, api.PLAYLIST_PAGE_SIZE)
        playlistSongs.value = nextPage > 1 ? [...playlistSongs.value, ...result.songs] : result.songs
        playlistPage.value = nextPage
        if (result.name) playlistView.value = { ...view, name: result.name }
        if (typeof result.total === 'number') playlistTotal.value = result.total
      } catch (error) {
        playlistSongsError.value = loginHint(errorText(error))
        throw error
      }
    })
  }

  /** 整单下载：分批翻页入队（后端按 next_page 续跑，不依赖已加载条数）。 */
  async function downloadPlaylistAll(): Promise<void> {
    const view = playlistView.value
    if (!view) {
      toast('warning', '请先打开一个歌单')
      return
    }
    const isQq = view.source === 'qq'
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
      /** 整单入队时 VIP/付费歌只确认一次：确认后同类一律照常入队，取消则跳过。 */
      let vipApproved = false
      playlistProgress.value = '正在整单入队…'
      for (;;) {
        if (cancelled()) {
          stopped = '页面已关闭，整单入队已停止'
          break
        }
        const result = await api.queuePlaylistPages(
          async (song: Song) => {
            if (cancelled()) throw new Error('页面已关闭')
            if (song.vip && !vipApproved) {
              vipApproved = await askVipGate([song], 'batch')
              if (!vipApproved) throw new Error('用户未确认会员歌曲')
            }
            const outcome = await api.enqueue(deps.kv, {
              source: view.source,
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
            // QQ：与网易云同形的分页接口（游标 = begin = (page-1)*pageSize）。
            if (isQq) return api.qqPlaylistSongsPage(deps, view.target, page, pageSize)
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

  async function retryAllFailed(): Promise<void> {
    await withBusy('retry-all', '批量重试失败', async () => {
      const { retried, errors } = await api.retryAllFailed(deps.kv)
      if (retried > 0) await api.addLog(deps.kv, 'info', `批量重试: ${retried} 个失败任务已重新排队`)
      if (errors.length > 0) {
        toast('warning', `已重新排队 ${retried} 个，${errors.length} 个失败: ${errors.slice(0, 2).join('；')}`)
      } else {
        toast(retried > 0 ? 'success' : 'info', retried > 0 ? `已重新排队 ${retried} 个失败任务` : '没有失败的任务')
      }
    })
  }

  /** 核对被打断的 queue-pump：交给宿主 retry，由插件 recover 决定收尾或重跑。 */
  async function retryAttentionRun(): Promise<void> {
    const run = attentionRun.value
    if (!run) return
    await withBusy('attention', '核对失败', async () => {
      const next = await ctx.tasks.retry(run.id)
      attentionRun.value = null
      const finished = await pollRun(next, 30000)
      toast(finished.status === 'succeeded' ? 'success' : 'info', runStatusText(finished, '已核对，队列恢复推进'))
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
      if (finished.status === 'attention_required') throw new Error('任务需要核对：点任务页顶部的「核对并继续」')
      if (finished.status !== 'succeeded') {
        toast('info', runStatusText(finished, '已提交推进'))
        return
      }
      const summary = finished.result ?? {}
      const lines = (summary.messages ?? []).map((m: unknown) => String(m).trim()).filter(Boolean)
      toast('success', lines.length > 0 ? lines.slice(0, 3).join('；') : `已推进（排队 ${summary.queued ?? 0} · 进行中 ${summary.active ?? 0}）`)
    })
  }

  /** 非成功终态 / 超时仍在跑 → 一句人话。 */
  function runStatusText(run: Record<string, any>, fallback: string): string {
    if (run.status === 'cancelled') return '推进已取消'
    if (run.status === 'queued' || run.status === 'running') {
      return String(run.message || '任务仍在后台运行，可在宿主任务队列查看进度')
    }
    if (run.status === 'failed') return `推进失败: ${run.error || run.message || '未知原因'}`
    if (run.status === 'attention_required') return '任务仍需核对（见宿主任务队列）'
    return fallback
  }

  /** 轮询宿主任务直到终态；页面关闭（signal 中止）就放手，让它转后台继续。 */
  async function pollRun(run: Record<string, any>, timeoutMs: number): Promise<Record<string, any>> {
    const started = Date.now()
    let current = run
    while (current && (current.status === 'queued' || current.status === 'running')) {
      if (cancelled()) throw new Error('页面已关闭，任务转入后台继续')
      if (Date.now() - started > timeoutMs) {
        return { ...current, message: `任务仍在后台运行（${current.id}），可在宿主任务队列查看进度` }
      }
      await sleep(800)
      if (cancelled()) throw new Error('页面已关闭，任务转入后台继续')
      current = await ctx.tasks.get(current.id)
    }
    return current
  }

  // ── 设置 ──────────────────────────────────────────────
  /** 保存设置；返回是否成功（失败已 toast）。 */
  async function saveSettings(patch: Partial<MusicSettings>): Promise<boolean> {
    const ok = await withBusy('settings', '设置保存失败', async () => {
      if (patch.target_dir !== undefined && !String(patch.target_dir).trim().startsWith('/')) {
        throw new Error('下载目录必须是以 / 开头的绝对路径')
      }
      if (patch.max_active !== undefined) {
        const value = Number(patch.max_active)
        if (!Number.isInteger(value) || value < 1 || value > api.MAX_ACTIVE_CAP) {
          throw new Error(`每轮新开下载数必须是 1–${api.MAX_ACTIVE_CAP} 的整数`)
        }
      }
      const current = api.normalizeSettings(settings.value)
      const next = api.applySettingsPatch(current, patch)
      await ctx.settings.set(next)
      toast('success', '设置已保存')
      await api.addLog(deps.kv, 'info', '设置已保存')
      return true
    })
    return ok === true
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
      })) as { accepted?: boolean; deduplicated?: boolean; suppressed?: boolean } | undefined
      const accepted = outcome?.accepted !== false && !outcome?.suppressed
      const parts = [accepted ? '已提交' : '未发送', outcome?.deduplicated ? '（被去重）' : '']
      const channels = api.channelSummary(outcome)
      if (channels) parts.push(`通道: ${channels}`)
      notifyResult.value = parts.filter(Boolean).join(' · ')
      toast(accepted ? 'success' : 'warning', notifyResult.value)
    })
  }

  // ── 派生量 ────────────────────────────────────────────
  const pendingTasks = computed(() =>
    allTasks.value.filter((task) => ['queued', 'downloading', 'copying'].includes(task.status)),
  )
  const failedTasks = computed(() => allTasks.value.filter((task) => task.status === 'failed'))

  /** 有进行中任务时每 5 秒跟随队列刷新（原生版 ensureTaskTimer）。
      pump 推进期间也允许读刷新——它是只读的，正是实时进度的来源。 */
  function setTaskRefresh(enabled: boolean): void {
    if (enabled && taskTimer === null) {
      taskTimer = setInterval(() => {
        if (!busy.value || busy.value === 'pump') void refresh()
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
    if (progressTimer !== null) {
      clearInterval(progressTimer)
      progressTimer = null
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
    allTasks,
    attentionRun,
    pumpRun,
    vipGate,
    resolveVipGate,
    login,
    vip,
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
    playlistNotice,
    playlistError,
    playlistSongsError,
    playlistsLoaded,
    playlistCreated,
    playlistFavorites,
    specialPlaylists,
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
      loadPlaylists,
    openPlaylist,
    closePlaylist,
    fetchPlaylistSongs,
    downloadPlaylistAll,
    retryTask,
    retryAllFailed,
    retryAttentionRun,
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
