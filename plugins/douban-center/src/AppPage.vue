<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import PosterImg from './PosterImg.vue'
import StatTile from './StatTile.vue'
import {
  NAlert,
  NButton,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NForm,
  NFormItem,
  NIcon,
  NInput,
  NInputNumber,
  NPopover,
  NSelect,
  NSwitch,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui'
import {
  Archive,
  Ban,
  Bookmark,
  BookOpen,
  Clock,
  ExternalLink,
  Eye,
  Filter,
  Heart,
  RefreshCw,
  Settings,
  Trash2,
  TrendingUp,
  Zap,
} from '@lucide/vue'

interface RuntimeCallback {
  invocation_id?: string
  replayed?: boolean
  result?: {
    status?: 'succeeded' | 'failed' | 'accepted' | 'skipped'
    message?: string
    url?: string
    intent_id?: number
    [key: string]: unknown
  }
}

interface HostBridge {
  getState(view?: string): Promise<{ state?: Record<string, unknown>; state_version?: string; etag?: string }>
  invokeAction(action: string, input?: unknown): Promise<RuntimeCallback>
  refresh(): Promise<Record<string, unknown>>
}

interface ListConfig {
  source: string
  type: string
  tag: string
  sort: string
  limit: number
  enabled: boolean
}

interface ChartItem {
  douban_ref: string
  title: string
  rate: string
  hotness: number
  poster_url: string
  url: string
  year?: string
}

interface QueueItem {
  douban_ref: string
  title: string
  list: string
  poster_url?: string
  url?: string
  entered_at?: string
  due_at?: string
  state?: string
  last_error?: string
}

interface HistoryEntry {
  douban_ref?: string
  tmdb_ref?: string
  title: string
  list: string
  action: string
  result: string
  message: string
  intent_id?: number
  created_at?: string
}

interface LogEntry {
  at: string
  level: string
  message: string
}

interface AppState {
  status?: string
  last_message?: string
  last_run?: string
  revision?: number
  snapshot?: { fetched_at?: string; lists?: Record<string, ChartItem[]> }
  blacklist?: { keywords?: string[]; hits?: number; recent?: Array<{ title: string; keyword: string; at: string }> }
  observe_queue?: { items?: QueueItem[] }
  history?: HistoryEntry[]
  logs?: LogEntry[]
  stats?: { total?: number; month_new?: number; by_list?: Record<string, number>; last_archive_at?: string }
  settings?: {
    lists?: Record<string, ListConfig>
    blacklist?: string[]
    observe_period_hours?: number
    auto_subscribe?: boolean
    notify_on_subscribe?: boolean
    subscribe_source_filter?: string[]
    cc_url?: string
    cc_uuid?: string
    cc_key?: string
    cc_manual?: string
    cc_key_set?: boolean
    cc_manual_set?: boolean
    wish_sync_enabled?: boolean
    // 订阅过滤器(功能 2): 0/空数组在状态响应里带 omitempty 会被省略
    min_rating?: number
    min_year?: number
    regions?: string[]
  }
  wish?: Array<{ douban_ref: string; title: string; year?: string; type?: string; poster_url?: string }>
  wish_info?: { enabled?: boolean; last_sync?: string; last_count?: number; last_new?: number; last_status?: string; last_error?: string; uid?: string; source?: string }
  // 已删除不重订墓碑集(功能 3): 键 = douban_ref, 值仅供展示
  no_resub?: Record<string, { tmdb_ref?: string; intent_id?: number; at?: string; reason?: string }>
  [key: string]: unknown
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
// 功能 3: 手动订阅"已删除不重订"墓碑条目前的二次确认弹窗(NDialogProvider 已在入口挂载)
const dialog = useDialog()
const busy = ref('')
const state = computed<AppState>(() => (props.runtimeState as AppState) || {})
const settingsOpen = ref(false)
const targetItem = ref<ChartItem | null>(null)
const itemMenuOpen = ref(false)
const newKeyword = ref('')

const listDefs = [
  { key: 'upcoming', label: '即将上映' },
  { key: 'hot', label: '实时热门' },
  { key: 'cn_wom', label: '华语口碑' },
  { key: 'global_wom', label: '全球口碑' },
  { key: 'movie_wom', label: '电影口碑' },
] as const

const listLabel = (key: string): string => listDefs.find((d) => d.key === key)?.label || key

const sourceOptions = [
  { label: 'search_subjects JSON', value: 'subjects_json' },
  { label: '即将上映 HTML', value: 'coming_html' },
  { label: '新片/口碑榜 HTML', value: 'chart_html' },
]
const typeOptions = [
  { label: '电影 movie', value: 'movie' },
  { label: '剧集 tv', value: 'tv' },
]

const settingsForm = reactive<NonNullable<AppState['settings']>>({
  lists: {},
  blacklist: [],
  observe_period_hours: 24,
  auto_subscribe: true,
  notify_on_subscribe: true,
  subscribe_source_filter: [],
  cc_url: 'http://127.0.0.1:8088',
  cc_uuid: '',
  cc_key: '',
  cc_manual: '',
  wish_sync_enabled: false,
  min_rating: 0,
  min_year: 0,
  regions: [],
})

// 地区在设置抽屉里按"逗号分隔文本"编辑, 保存时才拆成数组
const regionsText = ref('')

// 状态可能迟到或失败(宿主重启/更新窗口里 runtime/state 会 502),
// 表单必须始终可渲染: lists 深合并, 并为每个榜单定义补默认行,
// 否则设置抽屉读 settingsForm.lists[key].enabled 会直接崩掉整页(Vue 卸载组件树)。
const defaultListRow = (): ListConfig => ({
  source: 'subjects_json', type: 'movie', tag: '', sort: '', limit: 20, enabled: false,
})

watch(
  () => state.value.settings,
  (s) => {
    if (!s) return
    const incoming = JSON.parse(JSON.stringify(s)) as NonNullable<AppState['settings']>
    const lists: Record<string, ListConfig> = { ...(settingsForm.lists || {}) }
    if (incoming.lists && typeof incoming.lists === 'object') {
      for (const [key, value] of Object.entries(incoming.lists)) {
        if (value) lists[key] = value
      }
    }
    for (const def of listDefs) {
      if (!lists[def.key]) lists[def.key] = defaultListRow()
    }
    const { lists: _drop, ...rest } = incoming
    Object.assign(settingsForm, rest, { lists })
    // 过滤器三项(0/空数组)在状态响应里被 omitempty 省略, 必须显式回填默认值,
    // 否则"把 min_rating 改回 0(不限)"之后表单会一直残留旧值
    settingsForm.min_rating = typeof incoming.min_rating === 'number' ? incoming.min_rating : 0
    settingsForm.min_year = typeof incoming.min_year === 'number' ? incoming.min_year : 0
    settingsForm.regions = Array.isArray(incoming.regions) ? [...incoming.regions] : []
    regionsText.value = settingsForm.regions.join(', ')
  },
  { immediate: true, deep: true },
)

function displayHot(item: ChartItem): string {
  if (item.hotness && item.hotness > 0) return String(item.hotness)
  if (item.rate) return '评分 ' + item.rate
  return '—'
}

async function runAction(action: string, input: Record<string, unknown> = {}, opts: { silent?: boolean } = {}) {
  busy.value = action
  try {
    const response = await props.api.invokeAction(action, input)
    const result = response.result || {}
    await props.api.refresh()
    if (result.status === 'failed') {
      message.error(String(result.message || '操作失败'))
      return result
    }
    if (!opts.silent) {
      // 功能 3: 手动订阅命中"已删除不重订"墓碑时, 后端在 subscribe/subscribe-now 的
      // 成功响应里带回 no_resub_confirm 确认文案, 必须提示给用户, 不能只弹"订阅成功"
      const confirmText = result.no_resub_confirm
      if (typeof confirmText === 'string' && confirmText) {
        message.warning(confirmText, { duration: 8000, closable: true })
      } else {
        message.success(String(result.message || '操作完成'))
      }
    }
    return result
  } catch (error: any) {
    message.error(String(error?.message || '操作失败'))
    return { status: 'failed' }
  } finally {
    busy.value = ''
  }
}

async function refreshNow() {
  await runAction('refresh')
}

async function openSource(item: ChartItem | QueueItem) {
  const popup = window.open('about:blank', '_blank', 'popup,width=1080,height=760')
  if (!popup) {
    message.warning('浏览器阻止了弹窗，请允许当前页面打开新窗口')
    return
  }
  try {
    const response = await props.api.invokeAction('open-source', { douban_ref: item.douban_ref })
    const result = response.result || {}
    const url = String(result.url || '')
    if (result.status === 'failed' || !/^https?:\/\//i.test(url)) throw new Error(String(result.message || '未找到来源地址'))
    popup.location.replace(url)
  } catch (error: any) {
    popup.close()
    message.error(String(error?.message || '打开豆瓣来源失败'))
  }
}

// 功能 3: 手动订阅前先查墓碑集(state.no_resub), 命中则弹二次确认 —— 确认后才放行
// (后端手动入口不拦墓碑; 订阅成功响应里还会带 no_resub_confirm 文案兜底提示)。
function confirmNoResubThen(doubanRef: string, run: () => Promise<unknown>) {
  if (!state.value.no_resub?.[doubanRef]) {
    void run()
    return
  }
  dialog.warning({
    title: '条目已被你删除过',
    content: '该条目此前订阅过、现在已被你删除：自动订阅不会重订它，确认要手动订阅吗？',
    positiveText: '手动订阅',
    negativeText: '取消',
    onPositiveClick: () => {
      void run()
    },
  })
}

async function subscribeItem(item: ChartItem) {
  itemMenuOpen.value = false
  targetItem.value = null
  confirmNoResubThen(item.douban_ref, () => runAction('subscribe', { douban_ref: item.douban_ref }))
}

async function subscribeQueueNow(item: QueueItem) {
  confirmNoResubThen(item.douban_ref, () => runAction('subscribe-now', { douban_ref: item.douban_ref }))
}

async function removeQueue(item: QueueItem) {
  await runAction('observe-remove', { douban_ref: item.douban_ref })
}

const wishItems = computed(() => state.value.wish || [])
const wishInfo = computed(() => state.value.wish_info || null)

async function testCookieCloud() {
  await runAction('cookiecloud-test')
}

async function syncWish() {
  await runAction('wish-sync')
}

async function addBlacklist() {
  const kw = newKeyword.value.trim()
  if (!kw) {
    message.warning('请输入关键词')
    return
  }
  await runAction('blacklist-add', { keyword: kw })
  newKeyword.value = ''
}

async function removeBlacklist(kw: string) {
  await runAction('blacklist-remove', { keyword: kw })
}

function openSettings() {
  settingsOpen.value = true
}

async function saveSettings() {
  if (!settingsListRows.value.length) {
    message.warning('插件状态尚未加载（可能正在重启），请稍后再保存，以免配置被清空')
    return
  }
  // 过滤器三项: 空输入按 0(不限); 地区按逗号(全角/半角)拆分、去空 → 空数组 = 不限。
  // 后端只收 number/数组, 类型不符会整项忽略。
  const payload = {
    ...settingsForm,
    min_rating: settingsForm.min_rating ?? 0,
    min_year: settingsForm.min_year ?? 0,
    regions: regionsText.value
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean),
  }
  await runAction('settings-update', payload)
  settingsOpen.value = false
}

async function archive() {
  await runAction('archive')
}

// 功能 2/3: filtered/no_resub 是终态(过滤器拦下 / 命中已删除不重订墓碑) —— 仍展示(带标签),
// 但不再算"待自动订阅"
const queueBlocked = computed(() =>
  (state.value.observe_queue?.items || []).filter((i) => i.state === 'filtered' || i.state === 'no_resub'),
)
const queuePending = computed(() =>
  (state.value.observe_queue?.items || []).filter(
    (i) => i.state !== 'subscribed' && i.state !== 'filtered' && i.state !== 'no_resub',
  ),
)

// 功能 3: 墓碑集(已删除不重订)的条数与清除动作
const noResubCount = computed(() => Object.keys(state.value.no_resub || {}).length)
async function clearNoResub() {
  await runAction('no-resub-clear')
}

// 底部「不再订阅名单」条: 清除是危险操作, 按共享规范 §2.7 先弹确认对话框, 确认后才走真实清除动作
function confirmClearNoResub() {
  dialog.warning({
    title: '清除不再订阅名单？',
    content: `${noResubCount.value} 条记录将被移除，不可撤销`,
    positiveText: '确认清除',
    negativeText: '取消',
    // 规范 §2.7: 危险操作的确认钮为红实心
    positiveButtonProps: { type: 'error' },
    onPositiveClick: () => {
      void clearNoResub()
    },
  })
}

const historyRecent = computed(() => state.value.history || [])
const logsRecent = computed(() => state.value.logs || [])
const snapshotLists = computed(() => state.value.snapshot?.lists || {})

// 纯展示层辅助: 榜单区是否完全无数据(骨架切换用, 不改任何数据流)
const snapshotEmpty = computed(() =>
  !listDefs.some((def) => (snapshotLists.value[def.key] || []).length > 0),
)

// 榜单快照当前选中的 tab(纯前端展示状态): 切换只改海报横排显示哪一榜,
// 完整榜单抽屉仍由右上"完整榜单 · N 条 →"打开, 数据路径不变
const activeListKey = ref<string>('hot')
const heroTabTouched = ref(false)
const activeListItems = computed<ChartItem[]>(() => snapshotLists.value[activeListKey.value] || [])
// 宽屏一排 5–6 张(规范 §3), 完整条目进榜单抽屉
const heroItems = computed(() => activeListItems.value.slice(0, 6))
function selectListTab(key: string) {
  activeListKey.value = key
  heroTabTouched.value = true
}
// 数据首次到达时若默认 tab 无条目, 落到第一个有数据的榜单(用户点过 tab 后不再自动跳)
watch(snapshotEmpty, (empty) => {
  if (empty || heroTabTouched.value) return
  if ((snapshotLists.value[activeListKey.value] || []).length) return
  const first = listDefs.find((d) => (snapshotLists.value[d.key] || []).length > 0)
  if (first) activeListKey.value = first.key
})

// 页头抓取胶囊: 只读真实抓取时间 snapshot.fetched_at(状态里没有抓取周期字段, 不展示"每 Nh")
const fetchedAtText = computed(() => {
  const s = state.value.snapshot?.fetched_at || ''
  return s.length >= 16 ? s.slice(11, 16) : ''
})

// CookieCloud 配置态(与 douban-rs wish.rs 的判定口径一致): uuid+key 走 CookieCloud, 或手动 Cookie 兜底
const ccConfigured = computed(() => {
  const s = state.value.settings
  return Boolean((s?.cc_uuid && s?.cc_key_set) || s?.cc_manual_set)
})
const ccConfiguredLabel = computed(() => {
  const s = state.value.settings
  if (s?.cc_uuid && s?.cc_key_set) return 'CookieCloud 已配置'
  return '手动 Cookie 已配置'
})

// 指标瓦片 ×6(规范 §5.2): 全部读真实状态字段; 观察队列 >0 时数字琥珀, 总订阅蓝色
const tiles = computed(() => [
  { key: 'total', label: '总订阅', value: state.value.stats?.total || 0, icon: Bookmark, tone: 'primary' as const },
  { key: 'month', label: '本月新增', value: state.value.stats?.month_new || 0, icon: TrendingUp, tone: 'default' as const },
  {
    key: 'queue',
    label: '观察队列',
    value: queuePending.value.length,
    icon: Eye,
    tone: queuePending.value.length > 0 ? ('warning' as const) : ('default' as const),
  },
  { key: 'filtered', label: '已过滤', value: queueBlocked.value.length, icon: Filter, tone: 'default' as const },
  { key: 'wish', label: '我的想看', value: wishItems.value.length, icon: Heart, tone: 'default' as const },
  { key: 'blacklist', label: '黑名单关键词', value: state.value.blacklist?.keywords?.length || 0, icon: Ban, tone: 'default' as const },
])

// 相对时间展示(仅格式化, 不改数据): 输入形如 2026-09-30T15:04:05(+08:00) 的 ISO 串
function relativeTime(iso?: string | null): string {
  if (!iso || iso.length < 16) return ''
  const s = String(iso)
  // 统一成 Date 可解析的形式; 没有时区后缀按本地时间处理
  let t = s.replace(' ', 'T')
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t)) t += 'Z'
  const ts = Date.parse(t)
  if (Number.isNaN(ts)) return s.slice(5, 16)
  const diff = ts - Date.now()
  const abs = Math.abs(diff)
  const fmt = (v: number, unit: string) => (diff >= 0 ? `${v}${unit}后` : `${v}${unit}前`)
  if (abs < 60 * 1000) return '刚刚'
  if (abs < 3600 * 1000) return fmt(Math.round(abs / 60000), '分钟')
  if (abs < 86400 * 1000) return fmt(Math.round(abs / 3600000), '小时')
  return fmt(Math.round(abs / 86400000), '天')
}

// 热度展示(仅格式化真实 hotness 字段): 过万按 "x.x万" 缩写
function formatHot(n: number): string {
  if (n >= 10000) return (n / 10000).toFixed(1) + '万'
  return String(n)
}

// 榜单卡片 meta: 评分与热度分开成徽章数据(无则回退原 displayHot 文案)
const hasRate = (item: ChartItem): boolean => Boolean(item.rate && parseFloat(item.rate) > 0)
const hasHot = (item: ChartItem): boolean => Boolean(item.hotness && item.hotness > 0)

// 订阅历史副行: "榜单 · 相对时间", 缺哪段省哪段
function historyMeta(h: HistoryEntry): string {
  return [listLabel(h.list), relativeTime(h.created_at) || h.created_at?.slice(5, 16) || ''].filter(Boolean).join(' · ')
}

// 观察日志时间戳: 等宽 HH:MM:SS(后端给 ISO 串, 仅截取展示)
function logTime(at: string): string {
  return at.length >= 19 ? at.slice(11, 19) : at
}

// 设置抽屉的榜单行: 只渲染真实存在的行对象, 状态未加载时显示提示而不是崩溃。
const settingsListRows = computed(() =>
  listDefs
    .map((def) => ({ def, row: settingsForm.lists?.[def.key] }))
    .filter((r): r is { def: (typeof listDefs)[number]; row: ListConfig } => Boolean(r.row)),
)

// 完整榜单抽屉
const fullListKey = ref<string | null>(null)
const fullListLabel = computed(() => (fullListKey.value ? listLabel(fullListKey.value) : ''))
const fullListItems = computed<ChartItem[]>(() => {
  const key = fullListKey.value
  if (!key) return []
  return snapshotLists.value[key] || []
})
function openFullList(key: string) {
  fullListKey.value = key
}
function closeFullList() {
  fullListKey.value = null
}
const fullListOpen = computed({
  get: () => fullListKey.value !== null,
  set: (v: boolean) => {
    if (!v) fullListKey.value = null
  },
})

</script>

<template>
  <main class="dian-plugin-page dc-page">
    <!-- 页头(规范 §2.4): 图标瓦片 + 标题/副题 | 抓取胶囊 + 刷新榜单 + 设置 -->
    <header class="dc-header">
      <div class="dc-header-left">
        <div class="dc-header-icon" aria-hidden="true"><NIcon :component="BookOpen" :size="22" /></div>
        <div class="dc-header-title">
          <h2>豆瓣中心</h2>
          <p>抓榜单 → 规则过滤 → 自动/手动订阅 · 同步我的想看</p>
        </div>
      </div>
      <div class="dc-header-actions">
        <span class="dc-badge dc-badge-soft dc-header-capsule">
          <NIcon :component="Clock" :size="12" />
          <template v-if="fetchedAtText">抓取于 {{ fetchedAtText }}</template>
          <template v-else>尚未抓取</template>
        </span>
        <NButton size="small" secondary :loading="busy === 'refresh'" @click="refreshNow">
          <template #icon><NIcon :component="RefreshCw" /></template>
          刷新榜单
        </NButton>
        <NButton size="small" quaternary circle aria-label="设置" @click="openSettings">
          <template #icon><NIcon :component="Settings" /></template>
        </NButton>
      </div>
    </header>

    <!-- 后端状态文案原样渲染(铁律: 不改写不润色) -->
    <NAlert v-if="state.last_message" :type="state.status === 'failed' ? 'error' : 'info'" :bordered="false" closable>
      {{ state.last_message }}
    </NAlert>

    <!-- 指标瓦片 ×6(规范 §5.2) -->
    <section class="dc-tiles" aria-label="概览">
      <StatTile v-for="t in tiles" :key="t.key" :label="t.label" :value="t.value" :icon="t.icon" :tone="t.tone" />
    </section>

    <!-- 榜单快照: tab pill 切榜 + 海报横排 -->
    <section class="dc-card dc-hero" aria-label="榜单快照">
      <div class="dc-card-head">
        <div class="dc-card-titles">
          <h3>榜单快照</h3>
          <p class="dc-card-sub">榜单类型 / 每榜条数 / 地区在设置中配置</p>
        </div>
        <button v-if="!snapshotEmpty" type="button" class="dc-link" @click="openFullList(activeListKey)">
          完整榜单 · {{ activeListItems.length }} 条 →
        </button>
      </div>

      <div class="dc-hero-tabs" role="tablist" aria-label="榜单类型">
        <button
          v-for="def in listDefs"
          :key="def.key"
          type="button"
          role="tab"
          class="dc-hero-tab"
          :class="{ 'is-active': activeListKey === def.key }"
          :aria-selected="activeListKey === def.key"
          @click="selectListTab(def.key)"
        >
          {{ def.label }}
        </button>
      </div>

      <!-- 加载/空态骨架: 榜单完全无数据时以节奏一致的骨架填充 -->
      <div v-if="snapshotEmpty" class="dc-hero-skeleton" aria-hidden="true">
        <div v-for="n in 6" :key="n" class="dc-sk-card">
          <div class="dc-sk dc-sk-poster" />
          <div class="dc-sk dc-sk-line" />
          <div class="dc-sk dc-sk-line dc-sk-line-sm" />
        </div>
      </div>

      <div v-else-if="!heroItems.length" class="dc-empty">
        <NEmpty description="该榜单暂无数据" size="small" />
      </div>

      <div v-else class="dc-hero-strip">
        <NPopover
          v-for="item in heroItems"
          :key="item.douban_ref"
          trigger="click"
          placement="bottom"
          :show="itemMenuOpen && targetItem?.douban_ref === item.douban_ref"
          @update:show="(v: boolean) => { itemMenuOpen = v; if (v) targetItem = item }"
        >
          <template #trigger>
            <article class="dc-poster-card" :title="item.title">
              <div class="dc-poster-media">
                <PosterImg :poster-url="item.poster_url" :api="props.api" :alt="item.title" class="dc-poster-fill" />
                <div class="dc-hero-overlay">
                  <NButton size="tiny" type="primary" :loading="busy === 'subscribe'" @click.stop="subscribeItem(item)">
                    <template #icon><NIcon :component="Zap" /></template>
                    订阅
                  </NButton>
                  <NButton size="tiny" quaternary class="dc-hero-overlay-btn" @click.stop="openSource(item)">
                    <template #icon><NIcon :component="ExternalLink" /></template>
                  </NButton>
                </div>
              </div>
              <div class="dc-poster-title">{{ item.title }}</div>
              <div class="dc-poster-meta">
                <span v-if="hasRate(item)" class="dc-badge dc-badge-success">{{ item.rate }}</span>
                <span v-if="hasHot(item)" class="dc-poster-hot">热度 {{ formatHot(item.hotness) }}</span>
                <span v-if="!hasRate(item) && !hasHot(item)" class="dc-poster-hot">{{ displayHot(item) }}</span>
                <button type="button" class="dc-icon-btn dc-poster-ext" aria-label="打开豆瓣来源" @click.stop="openSource(item)">
                  <NIcon :component="ExternalLink" :size="13" />
                </button>
              </div>
            </article>
          </template>
          <div class="dc-item-menu">
            <NButton size="tiny" type="primary" :loading="busy === 'subscribe'" @click="subscribeItem(item)">
              <template #icon><NIcon :component="Zap" /></template>
              订阅
            </NButton>
            <NButton size="tiny" @click="openSource(item)">
              <template #icon><NIcon :component="ExternalLink" /></template>
              打开来源
            </NButton>
          </div>
        </NPopover>
      </div>
    </section>

    <!-- 完整榜单抽屉 -->
    <NDrawer v-model:show="fullListOpen" :width="520" placement="right">
      <NDrawerContent :title="`${fullListLabel} · 完整榜单`" closable>
        <div class="dc-full-head">
          <span class="dc-muted">
            <template v-if="state.snapshot?.fetched_at">更新于 {{ relativeTime(state.snapshot.fetched_at) }}</template>
            <template v-else>最近抓取 —</template>
          </span>
          <NTag size="small" type="info" :bordered="false">共 {{ fullListItems.length }} 条</NTag>
        </div>
        <div v-if="!fullListItems.length" class="dc-empty">
          <NEmpty description="该榜单暂无数据" size="small" />
        </div>
        <div v-else class="dc-full-list">
          <div v-for="(item, i) in fullListItems" :key="item.douban_ref" class="dc-full-row">
            <span class="dc-full-rank">{{ i + 1 }}</span>
            <PosterImg :poster-url="item.poster_url" :api="props.api" :alt="item.title" class="dc-full-poster" />
            <div class="dc-full-main">
              <div class="dc-full-title" :title="item.title">{{ item.title }}</div>
              <div class="dc-full-meta">
                <span v-if="hasRate(item)" class="dc-badge dc-badge-success">{{ item.rate }}</span>
                <span v-else-if="hasHot(item)" class="dc-chip dc-chip-hot">{{ displayHot(item) }}</span>
                <span v-else class="dc-chip">—</span>
                <span v-if="item.year" class="dc-chip dc-chip-muted">{{ item.year }}</span>
              </div>
            </div>
            <div class="dc-full-actions">
              <NButton size="tiny" type="primary" :loading="busy === 'subscribe'" @click="subscribeItem(item)">
                <template #icon><NIcon :component="Zap" /></template>
                订阅
              </NButton>
              <NButton size="tiny" @click="openSource(item)">
                <template #icon><NIcon :component="ExternalLink" /></template>
              </NButton>
            </div>
          </div>
        </div>
      </NDrawerContent>
    </NDrawer>

    <!-- 双栏: 观察队列 | 我的想看 -->
    <section class="dc-grid-2 dc-grid-queue">
      <div class="dc-card" aria-label="观察队列">
        <div class="dc-card-head">
          <h3>
            观察队列
            <span v-if="queuePending.length" class="dc-badge dc-badge-warning">{{ queuePending.length }} 条待确认</span>
          </h3>
          <!-- 黑名单管理收进卡片右上弹层: 添加/删除/最近命中功能不变 -->
          <NPopover trigger="click" placement="bottom-end">
            <template #trigger>
              <button type="button" class="dc-badge dc-badge-soft dc-badge-btn">
                <NIcon :component="Ban" :size="12" />
                黑名单 · {{ state.blacklist?.keywords?.length || 0 }}
              </button>
            </template>
            <div class="dc-bl-panel">
              <div class="dc-bl-counts">
                关键词 {{ state.blacklist?.keywords?.length || 0 }} 个 · 最近命中 {{ state.blacklist?.hits || 0 }} 条
              </div>
              <div class="dc-inline-form">
                <NInput v-model:value="newKeyword" size="small" placeholder="添加黑名单关键词" clearable @keyup.enter="addBlacklist" />
                <NButton size="small" type="primary" :loading="busy === 'blacklist-add'" @click="addBlacklist">添加</NButton>
              </div>
              <div v-if="state.blacklist?.keywords?.length" class="dc-tags">
                <NTag v-for="kw in state.blacklist.keywords" :key="kw" size="small" closable @close="removeBlacklist(kw)">{{ kw }}</NTag>
              </div>
              <div v-if="state.blacklist?.recent?.length" class="dc-mini-list">
                <div v-for="(hit, i) in state.blacklist.recent.slice(0, 5)" :key="i" class="dc-mini-row">
                  <span class="dc-mini-title">{{ hit.title }}</span>
                  <NTag size="tiny" type="error" :bordered="false">{{ hit.keyword }}</NTag>
                </div>
              </div>
            </div>
          </NPopover>
        </div>

        <div v-if="!queuePending.length && !queueBlocked.length" class="dc-empty">
          <NEmpty description="队列为空" size="small" />
        </div>
        <div v-else class="dc-queue-list">
          <div v-for="item in queuePending.slice(0, 8)" :key="item.douban_ref" class="dc-queue-row">
            <div class="dc-queue-main">
              <div class="dc-queue-title">{{ item.title }}</div>
              <div class="dc-queue-sub">
                <span class="dc-chip">{{ listLabel(item.list) }}</span>
                <span v-if="item.due_at" class="dc-muted">{{ relativeTime(item.due_at) }}到期</span>
                <NTag v-if="item.state === 'needs_review'" size="tiny" type="error" :bordered="false">匹配待确认</NTag>
              </div>
            </div>
            <div class="dc-queue-actions">
              <NButton size="small" secondary type="primary" :loading="busy === 'subscribe-now'" @click="subscribeQueueNow(item)">立即订阅</NButton>
              <NButton size="small" quaternary circle aria-label="打开豆瓣来源" @click="openSource(item)">
                <template #icon><NIcon :component="ExternalLink" :size="14" /></template>
              </NButton>
              <NButton size="small" quaternary circle type="error" aria-label="移出观察队列" @click="removeQueue(item)">
                <template #icon><NIcon :component="Trash2" :size="14" /></template>
              </NButton>
            </div>
          </div>
          <!-- 功能 2/3: 被过滤器/墓碑拦下的终态条目, 只读展示(手动订阅仍可用, 二次确认逻辑不变) -->
          <div v-for="item in queueBlocked.slice(0, 8)" :key="item.douban_ref" class="dc-queue-row">
            <div class="dc-queue-main">
              <div class="dc-queue-title-row">
                <span class="dc-queue-title">{{ item.title }}</span>
                <span v-if="item.state === 'filtered'" class="dc-badge dc-badge-neutral">已过滤</span>
                <span v-else-if="item.state === 'no_resub'" class="dc-badge dc-badge-neutral">已删除不重订</span>
              </div>
              <div class="dc-queue-sub">
                <span class="dc-chip">{{ listLabel(item.list) }}</span>
                <!-- last_error 是后端下发的过滤/拦截原因, 原样渲染 -->
                <span v-if="item.last_error" class="dc-muted dc-queue-reason" :title="item.last_error">{{ item.last_error }}</span>
              </div>
            </div>
            <div class="dc-queue-actions">
              <NButton size="small" secondary :loading="busy === 'subscribe-now'" @click="subscribeQueueNow(item)">手动订阅</NButton>
              <NButton size="small" quaternary circle aria-label="打开豆瓣来源" @click="openSource(item)">
                <template #icon><NIcon :component="ExternalLink" :size="14" /></template>
              </NButton>
              <NButton size="small" quaternary circle type="error" aria-label="移出观察队列" @click="removeQueue(item)">
                <template #icon><NIcon :component="Trash2" :size="14" /></template>
              </NButton>
            </div>
          </div>
        </div>
        <p class="dc-footnote">命中不再订阅名单的手动订阅，将需要二次确认并展示历史原因</p>
      </div>

      <!-- 我的想看: CookieCloud 状态胶囊如实, 未配置指路设置 -->
      <div class="dc-card" aria-label="我的想看">
        <div class="dc-card-head">
          <h3>我的想看</h3>
          <div class="dc-head-right">
            <button v-if="!ccConfigured" type="button" class="dc-badge dc-badge-warning dc-badge-btn" @click="openSettings">
              CookieCloud 未配置 · 去设置
            </button>
            <span v-else class="dc-badge dc-badge-success">{{ ccConfiguredLabel }}</span>
            <NButton size="small" secondary :loading="busy === 'wish-sync'" @click="syncWish">
              <template #icon><NIcon :component="RefreshCw" /></template>
              立即同步
            </NButton>
          </div>
        </div>
        <div v-if="!wishItems.length" class="dc-empty">还没有同步到想看条目，点「立即同步」或在设置里配置豆瓣账号</div>
        <div v-else class="dc-wish-list">
          <div v-for="w in wishItems.slice(0, 24)" :key="w.douban_ref" class="dc-wish-row">
            <PosterImg :poster-url="w.poster_url" :api="props.api" :alt="w.title" class="dc-wish-poster" />
            <div class="dc-wish-main">
              <div class="dc-wish-title" :title="w.title">{{ w.title }}</div>
              <div class="dc-wish-sub">{{ [w.year, w.type === 'tv' ? '剧集' : '电影'].filter(Boolean).join(' · ') }}</div>
            </div>
          </div>
          <div v-if="wishItems.length > 24" class="dc-muted dc-wish-more">… 共 {{ wishItems.length }} 条</div>
        </div>
      </div>
    </section>

    <!-- 双栏: 订阅历史 | 观察日志 -->
    <section class="dc-grid-2">
      <div class="dc-card" aria-label="订阅历史">
        <div class="dc-card-head">
          <h3>订阅历史</h3>
          <span v-if="state.stats" class="dc-muted dc-head-note">
            总订阅 {{ state.stats.total || 0 }} · 本月 +{{ state.stats.month_new || 0 }}
          </span>
        </div>
        <div v-if="!historyRecent.length" class="dc-empty">
          <NEmpty description="暂无订阅记录" size="small" />
        </div>
        <div v-else class="dc-history-list">
          <div v-for="(h, i) in historyRecent.slice(0, 8)" :key="i" class="dc-history-row">
            <div class="dc-history-main">
              <div class="dc-history-title">{{ h.title }}</div>
              <div class="dc-history-sub">{{ historyMeta(h) }}</div>
            </div>
            <span class="dc-badge" :class="h.result === 'succeeded' ? 'dc-badge-success' : 'dc-badge-error'">
              {{ h.result === 'succeeded' ? '订阅成功' : '订阅失败' }}
            </span>
          </div>
        </div>
      </div>

      <div class="dc-card" aria-label="观察日志">
        <div class="dc-card-head">
          <h3>观察日志</h3>
        </div>
        <div v-if="!logsRecent.length" class="dc-empty">
          <NEmpty description="暂无日志" size="small" />
        </div>
        <div v-else class="dc-log-list">
          <div v-for="(log, i) in logsRecent.slice(0, 12)" :key="i" class="dc-log-row">
            <span class="dc-log-dot" :class="'is-' + log.level" aria-hidden="true" />
            <span class="dc-log-time">{{ logTime(log.at) }}</span>
            <span class="dc-log-msg">{{ log.message }}</span>
          </div>
        </div>
        <p class="dc-footnote">等宽字体时间戳 · 与 Telegram 日报、日志三处口径一致</p>
      </div>
    </section>

    <!-- 底部整宽条: 不再订阅名单(已删除不重订墓碑集) -->
    <section class="dc-card dc-noresub" aria-label="不再订阅名单">
      <NIcon :component="Ban" :size="16" class="dc-noresub-icon" aria-hidden="true" />
      <strong class="dc-noresub-name">不再订阅名单</strong>
      <span class="dc-badge dc-badge-neutral">{{ noResubCount }} 条</span>
      <span class="dc-noresub-desc">源自「已删除不重订阅墓碑」· 清除为危险操作，需二次确认</span>
      <NButton
        size="small"
        secondary
        type="error"
        class="dc-noresub-action"
        :disabled="!noResubCount"
        :loading="busy === 'no-resub-clear'"
        @click="confirmClearNoResub"
      >
        清除名单
      </NButton>
    </section>

    <!-- 页脚: 静态说明小字(版本号状态里没有可读字段, 不放) -->
    <footer class="dc-footer">
      豆瓣中心 · 抓榜单 → 规则过滤 → 自动/手动订阅 · 同步我的想看 ｜ 状态由宿主注入 · 页面宽度跟随宿主可用宽度，双栏在 900–1000px 回落单栏
    </footer>

    <!-- 设置抽屉 -->
    <NDrawer v-model:show="settingsOpen" :width="520" placement="right">
      <NDrawerContent title="豆瓣中心 · 设置" closable>
        <NForm label-placement="top">
          <div class="dc-settings-section">榜单配置</div>
          <div v-if="!settingsListRows.length" class="dc-empty">
            <NEmpty description="配置尚未加载（插件状态不可用），稍后重试" size="small" />
          </div>
          <div v-for="{ def, row } in settingsListRows" :key="def.key" class="dc-settings-list">
            <div class="dc-settings-list-head">
              <strong>{{ def.label }}</strong>
              <NSwitch v-model:value="row.enabled" size="small" />
            </div>
            <div class="dc-settings-grid">
              <NFormItem label="来源">
                <NSelect v-model:value="row.source" :options="sourceOptions" size="small" />
              </NFormItem>
              <NFormItem v-if="row.source === 'subjects_json'" label="类型">
                <NSelect v-model:value="row.type" :options="typeOptions" size="small" />
              </NFormItem>
              <NFormItem v-if="row.source === 'subjects_json'" label="Tag">
                <NInput v-model:value="row.tag" size="small" placeholder="热门 / 华语 / 欧美" />
              </NFormItem>
              <NFormItem v-if="row.source === 'subjects_json'" label="排序">
                <NInput v-model:value="row.sort" size="small" placeholder="recommend" />
              </NFormItem>
              <NFormItem label="条数">
                <NInputNumber v-model:value="row.limit" size="small" :min="1" :max="20" />
              </NFormItem>
            </div>
          </div>

          <div class="dc-settings-section">我的想看（豆瓣账号）</div>
          <div class="dc-settings-row">
            <span>同步「我的想看」到订阅</span>
            <NSwitch v-model:value="settingsForm.wish_sync_enabled" size="small" />
          </div>
          <div class="dc-settings-row">
            <span>CookieCloud 地址</span>
            <NInput v-model:value="settingsForm.cc_url" size="small" placeholder="http://127.0.0.1:8088" style="max-width: 260px" />
          </div>
          <div class="dc-settings-row">
            <span>UUID</span>
            <NInput v-model:value="settingsForm.cc_uuid" size="small" placeholder="浏览器扩展里的 UUID" style="max-width: 260px" />
          </div>
          <div class="dc-settings-row">
            <span>加密密钥</span>
            <NInput v-model:value="settingsForm.cc_key" size="small" type="password" show-password-on="click" :placeholder="settingsForm.cc_key_set ? '已配置，留空保持不变' : '浏览器扩展里的密钥'" style="max-width: 260px" />
          </div>
          <div class="dc-settings-row">
            <span>手动 Cookie 兜底（dbcl2=...）</span>
            <NInput v-model:value="settingsForm.cc_manual" size="small" :placeholder="settingsForm.cc_manual_set ? '已配置，留空保持不变' : '手动 Cookie 兜底（dbcl2=...）'" style="max-width: 260px" />
          </div>
          <div class="dc-settings-row">
            <span></span>
            <NButton size="small" :loading="busy === 'cookiecloud-test'" @click="testCookieCloud">测试连接</NButton>
          </div>
          <p v-if="wishInfo" class="dc-muted" style="margin: 2px 0 8px; font-size: 12px">
            {{ wishInfo.last_status === 'succeeded'
              ? `上次同步 ${wishInfo.last_sync?.slice(5, 16) || ''}：共 ${wishInfo.last_count ?? 0} 条，新增 ${wishInfo.last_new ?? 0}（uid=${wishInfo.uid}，来源=${wishInfo.source === 'cookiecloud' ? 'CookieCloud' : '手动Cookie'}）`
              : `上次同步失败：${wishInfo.last_error || '未知原因'}` }}
          </p>

          <div class="dc-settings-section">订阅与观察</div>
          <div class="dc-settings-row">
            <span>观察期（小时）</span>
            <NInputNumber v-model:value="settingsForm.observe_period_hours" size="small" :min="0" :max="720" />
          </div>
          <div class="dc-settings-row">
            <span>自动订阅（观察期到期后）</span>
            <NSwitch v-model:value="settingsForm.auto_subscribe" size="small" />
          </div>
          <div class="dc-settings-row">
            <span>订阅成功后发送 Telegram 通知</span>
            <div style="display: flex; gap: 8px; align-items: center">
              <NSwitch v-model:value="settingsForm.notify_on_subscribe" size="small" />
              <NButton size="small" @click="runAction('send-test')">发送测试</NButton>
            </div>
          </div>
          <!-- 功能 2: 订阅过滤器三项(文案与 Rust 侧 UI_COPY_* 常量逐字一致) -->
          <div class="dc-settings-row">
            <span>最低评分</span>
            <NInputNumber v-model:value="settingsForm.min_rating" size="small" :min="0" :max="10" :step="0.1" style="max-width: 260px" />
          </div>
          <p class="dc-muted dc-settings-hint">最低评分（0 = 不限；无评分的条目按“低于阈值”处理，会被过滤）</p>
          <div class="dc-settings-row">
            <span>最低年份</span>
            <NInputNumber v-model:value="settingsForm.min_year" size="small" :min="0" :max="3000" style="max-width: 260px" />
          </div>
          <p class="dc-muted dc-settings-hint">最低年份（0 = 不限；豆瓣口碑榜/即将上映榜多数条目没有年份）</p>
          <div class="dc-settings-row">
            <span>地区</span>
            <NInput v-model:value="regionsText" size="small" placeholder="如：美国, 日本" style="max-width: 260px" />
          </div>
          <p class="dc-muted dc-settings-hint">地区（逗号分隔，留空 = 不限；只在已取到豆瓣条目详情时生效）</p>

          <!-- 归档入口从页头移到这里: 动作不变(runAction('archive')) -->
          <div class="dc-settings-section">维护</div>
          <div class="dc-settings-row">
            <span>归档订阅历史</span>
            <NButton size="small" :loading="busy === 'archive'" @click="archive">
              <template #icon><NIcon :component="Archive" /></template>
              归档
            </NButton>
          </div>

          <div class="dc-settings-row dc-settings-actions">
            <NButton type="primary" :loading="busy === 'settings-update'" @click="saveSettings">保存设置</NButton>
            <NButton @click="settingsOpen = false">取消</NButton>
          </div>
        </NForm>
      </NDrawerContent>
    </NDrawer>
  </main>
</template>

<style scoped>
/* ---- 根容器: 不设全页 max-width/min-width, 宽度跟随宿主可用宽度(规范 §3) ---- */

.dc-page {
  display: grid;
  gap: var(--dian-space-4, 16px);
  padding: var(--dian-space-2, 8px) var(--dian-space-1, 4px);
  width: 100%;
  max-width: 100%;
  min-width: 0;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
  font-family: var(--dian-font-family, inherit);
}

/* ---- 页头(规范 §2.4) ---- */

.dc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--dian-space-3, 12px);
  flex-wrap: wrap;
  padding: var(--dian-space-2, 8px) 0 0;
}

.dc-header-left {
  display: flex;
  align-items: center;
  gap: var(--dian-space-3, 12px);
  min-width: 0;
}

.dc-header-icon {
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

.dc-header-title {
  min-width: 0;
}

.dc-header-title h2,
.dc-header-title p {
  margin: 0;
}

.dc-header-title h2 {
  font-size: 20px;
  font-weight: 600;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
}

.dc-header-title p {
  margin-top: 2px;
  font-size: 13px;
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
}

.dc-header-actions {
  display: flex;
  align-items: center;
  gap: var(--dian-space-2, 8px);
  flex-wrap: wrap;
}

.dc-header-capsule {
  padding: 5px 12px;
}

/* ---- 徽标(规范 §2.1): 文字色 = 语义色, 底色 = 语义色 14% 透明度, 深浅主题同一透明度 ---- */

.dc-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border: none;
  border-radius: var(--dian-radius-pill, 999px);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.dc-badge-success {
  color: var(--dian-success, #18a058);
  background: color-mix(in srgb, var(--dian-success, #18a058) 14%, transparent);
}

.dc-badge-warning {
  color: var(--dian-warning, #f0a020);
  background: color-mix(in srgb, var(--dian-warning, #f0a020) 16%, transparent);
}

.dc-badge-error {
  color: var(--dian-error, #d03050);
  background: color-mix(in srgb, var(--dian-error, #d03050) 13%, transparent);
}

.dc-badge-neutral {
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
  background: color-mix(in srgb, var(--dian-text-secondary, #8a919c) 16%, transparent);
}

.dc-badge-soft {
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
  background: var(--dian-surface-soft, #f7faff);
  border: 1px solid var(--dian-border, #e0e4ea);
}

/* 可点击的徽标(黑名单弹层入口 / CookieCloud 未配置指路设置) */
.dc-badge-btn {
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: filter 0.15s ease;
}

.dc-badge-btn:hover {
  filter: brightness(0.96);
}

/* ---- 卡片区块(规范 §2.3): surface + 1px border + radius-lg + padding 20–24px ---- */

.dc-card {
  border: 1px solid var(--dian-border, #e0e4ea);
  border-radius: var(--dian-radius-lg, 12px);
  background: var(--dian-surface-raised, #ffffff);
  padding: var(--dian-space-5, 20px) var(--dian-space-6, 24px);
  min-width: 0;
  box-shadow: var(--dian-shadow-sm, 0 6px 18px rgba(35, 52, 84, 0.08));
}

.dc-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--dian-space-3, 12px);
  margin-bottom: var(--dian-space-3, 12px);
  flex-wrap: wrap;
}

.dc-card-head h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
  display: inline-flex;
  align-items: center;
  gap: var(--dian-space-2, 8px);
  flex-wrap: wrap;
}

.dc-card-sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
}

.dc-head-right {
  display: flex;
  align-items: center;
  gap: var(--dian-space-2, 8px);
  flex-wrap: wrap;
}

.dc-head-note {
  font-variant-numeric: tabular-nums;
}

.dc-muted {
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
  font-size: 12px;
  overflow-wrap: anywhere;
}

.dc-link {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-size: 13px;
  color: var(--dian-primary, #2080f0);
  cursor: pointer;
  white-space: nowrap;
}

.dc-link:hover {
  color: var(--dian-primary-hover, #4c9af5);
}

.dc-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--dian-radius-sm, 8px);
  background: transparent;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  cursor: pointer;
  flex: none;
  transition: color 0.15s ease, background 0.15s ease;
}

.dc-icon-btn:hover {
  color: var(--dian-primary, #2080f0);
  background: var(--dian-surface-hover, #eaf4fd);
}

/* 次级标签 chip(榜单名 / 年份等) */
.dc-chip {
  display: inline-flex;
  align-items: center;
  padding: 0 8px;
  line-height: 18px;
  border-radius: var(--dian-radius-pill, 999px);
  font-size: 11px;
  font-weight: 500;
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
  background: var(--dian-surface-soft, #f7faff);
  border: 1px solid var(--dian-border, #e0e4ea);
  white-space: nowrap;
}

.dc-chip-muted {
  background: transparent;
}

.dc-chip-hot {
  color: var(--dian-primary, #2080f0);
}

/* ---- 指标瓦片 ×6 ---- */

.dc-tiles {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: var(--dian-space-3, 12px);
}

/* ---- 榜单快照: tab pill + 海报横排 ---- */

.dc-hero-tabs {
  display: flex;
  align-items: center;
  gap: var(--dian-space-2, 8px);
  flex-wrap: wrap;
  margin-bottom: var(--dian-space-3, 12px);
}

.dc-hero-tab {
  border: none;
  border-radius: var(--dian-radius-pill, 999px);
  background: var(--dian-surface-soft, #f7faff);
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
  font: inherit;
  font-size: 12.5px;
  padding: 5px 14px;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.15s ease, background 0.15s ease;
}

.dc-hero-tab:hover {
  color: var(--dian-primary, #2080f0);
}

.dc-hero-tab:focus-visible {
  outline: 2px solid var(--dian-focus-ring, rgba(32, 128, 240, 0.44));
  outline-offset: 1px;
}

.dc-hero-tab.is-active {
  color: var(--dian-primary, #2080f0);
  background: color-mix(in srgb, var(--dian-primary, #2080f0) 12%, transparent);
  font-weight: 600;
}

/* 海报横排: 宽屏一排 5–6 张等宽铺满; 窄屏固定宽度横滑(见 §3 媒体查询) */
.dc-hero-strip {
  display: flex;
  gap: var(--dian-space-3, 12px);
  overflow-x: auto;
  overscroll-behavior-x: contain;
  padding-bottom: var(--dian-space-1, 4px);
  scrollbar-width: thin;
  scrollbar-color: var(--dian-border-strong, #c8d8ec) transparent;
}

.dc-hero-strip::-webkit-scrollbar {
  height: 6px;
}

.dc-hero-strip::-webkit-scrollbar-thumb {
  background: var(--dian-border-strong, #c8d8ec);
  border-radius: var(--dian-radius-pill, 999px);
}

.dc-hero-strip::-webkit-scrollbar-track {
  background: transparent;
}

.dc-poster-card {
  flex: 1 1 0;
  min-width: 120px;
  max-width: 200px;
  display: flex;
  flex-direction: column;
  cursor: pointer;
}

.dc-poster-media {
  position: relative;
  aspect-ratio: 2 / 3;
  width: 100%;
  border-radius: var(--dian-radius-md, 12px);
  overflow: hidden;
  background: var(--dian-surface-hover, #eaf4fd);
  box-shadow: var(--dian-shadow-sm, 0 6px 18px rgba(35, 52, 84, 0.08));
}

.dc-poster-fill,
.dc-poster-fill :deep(img),
.dc-poster-fill :deep(.dc-poster-ph) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.dc-poster-fill :deep(.dc-poster-img) {
  border-radius: 0;
}

.dc-hero-overlay {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 6px;
  padding: 8px;
  background: linear-gradient(to top, var(--dian-scrim, rgba(0, 0, 0, 0.55)), transparent 55%);
  opacity: 0;
  transition: opacity 0.16s ease;
}

.dc-poster-card:hover .dc-hero-overlay,
.dc-poster-card:focus-within .dc-hero-overlay {
  opacity: 1;
}

/* 浮层压在 scrim 之上, 文字需恒为浅色, 由主题变量 --dian-text-inverse 提供 */
.dc-hero-overlay-btn {
  color: var(--dian-text-inverse, #ffffff);
}

.dc-poster-title {
  margin-top: var(--dian-space-2, 8px);
  font-size: 14px;
  font-weight: 500;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dc-poster-meta {
  margin-top: 5px;
  display: flex;
  align-items: center;
  gap: var(--dian-space-2, 8px);
  min-width: 0;
}

.dc-poster-hot {
  font-size: 12px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dc-poster-ext {
  margin-left: auto;
}

/* 骨架: 榜单完全无数据(刷新中/未抓取)时的占位, 节奏与卡片一致 */
.dc-hero-skeleton {
  display: flex;
  gap: var(--dian-space-3, 12px);
  overflow: hidden;
}

.dc-sk-card {
  flex: 1 1 0;
  min-width: 120px;
  max-width: 200px;
  display: grid;
  gap: 8px;
}

.dc-sk {
  border-radius: var(--dian-radius-sm, 8px);
  background: linear-gradient(90deg, var(--dian-surface-hover, #eaf4fd) 25%, var(--dian-surface-soft, #f7faff) 50%, var(--dian-surface-hover, #eaf4fd) 75%);
  background-size: 200% 100%;
  animation: dc-sk-shimmer 1.4s ease infinite;
}

.dc-sk-poster {
  aspect-ratio: 2 / 3;
  border-radius: var(--dian-radius-md, 12px);
}

.dc-sk-line {
  height: 12px;
}

.dc-sk-line-sm {
  width: 60%;
}

@keyframes dc-sk-shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}

/* ---- 完整榜单抽屉 ---- */

.dc-full-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--dian-space-2, 8px);
  margin-bottom: var(--dian-space-3, 12px);
}

.dc-full-list {
  display: grid;
  gap: 8px;
}

.dc-full-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border-radius: var(--dian-radius-sm, 8px);
  border: 1px solid var(--dian-border, #e0e4ea);
  background: var(--dian-surface-soft, #f7faff);
  min-width: 0;
  transition: border-color 0.15s;
}

.dc-full-row:hover {
  border-color: var(--dian-primary, #2080f0);
}

.dc-full-rank {
  width: 22px;
  flex: none;
  text-align: center;
  font-weight: 700;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
}

.dc-full-poster {
  width: 40px;
  height: 56px;
  object-fit: cover;
  border-radius: var(--dian-radius-sm, 8px);
  flex: none;
}

.dc-full-main {
  flex: 1;
  min-width: 0;
}

.dc-full-title {
  font-size: 13px;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dc-full-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.dc-full-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

.dc-item-menu {
  display: flex;
  gap: 8px;
}

.dc-empty {
  display: flex;
  justify-content: center;
  padding: var(--dian-space-2, 8px);
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
  font-size: 13px;
}

/* ---- 双栏(规范 §3: ≥1000px 双栏, 900–1000px 回落单栏) ---- */

.dc-grid-2 {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--dian-space-4, 16px);
}

/* 观察队列 | 我的想看: 左宽右窄(设计图比例约 3:2) */
.dc-grid-queue {
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
}

/* ---- 观察队列 ---- */

.dc-queue-list {
  display: grid;
}

.dc-queue-row {
  display: flex;
  align-items: center;
  gap: var(--dian-space-3, 12px);
  padding: 10px 2px;
  border-bottom: 1px solid var(--dian-divider, #e0e4ea);
  min-width: 0;
}

.dc-queue-row:last-child {
  border-bottom: none;
}

.dc-queue-main {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 4px;
}

.dc-queue-title-row {
  display: flex;
  align-items: center;
  gap: var(--dian-space-2, 8px);
  min-width: 0;
}

.dc-queue-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dc-queue-sub {
  display: flex;
  align-items: center;
  gap: var(--dian-space-2, 8px);
  flex-wrap: wrap;
  min-width: 0;
}

.dc-queue-reason {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.dc-queue-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}

/* ---- 我的想看 ---- */

.dc-wish-list {
  display: grid;
  /* 长列表局部纵向滚动, 不撑整页(规范 §3) */
  max-height: 308px;
  overflow-y: auto;
  scrollbar-width: thin;
}

.dc-wish-row {
  display: flex;
  align-items: center;
  gap: var(--dian-space-3, 12px);
  padding: 8px 2px;
  border-bottom: 1px solid var(--dian-divider, #e0e4ea);
  min-width: 0;
}

.dc-wish-row:last-child {
  border-bottom: none;
}

.dc-wish-poster {
  width: 36px;
  height: 54px;
  object-fit: cover;
  border-radius: var(--dian-radius-sm, 8px);
  flex: none;
}

.dc-wish-main {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 2px;
}

.dc-wish-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dc-wish-sub {
  font-size: 12px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
}

.dc-wish-more {
  font-size: 12px;
  padding: 6px 2px;
}

/* ---- 订阅历史 ---- */

.dc-history-list {
  display: grid;
  max-height: 308px;
  overflow-y: auto;
  scrollbar-width: thin;
}

.dc-history-row {
  display: flex;
  align-items: center;
  gap: var(--dian-space-3, 12px);
  padding: 10px 2px;
  border-bottom: 1px solid var(--dian-divider, #e0e4ea);
  min-width: 0;
}

.dc-history-row:last-child {
  border-bottom: none;
}

.dc-history-main {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 3px;
}

.dc-history-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dc-history-sub {
  font-size: 12px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 观察日志: 等宽小字时间线 ---- */

.dc-log-list {
  display: grid;
  gap: 6px;
  font-family: var(--dian-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  max-height: 308px;
  overflow-y: auto;
  scrollbar-width: thin;
}

.dc-log-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.dc-log-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  align-self: center;
  background: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
}

.dc-log-dot.is-error {
  background: var(--dian-error, #d03050);
}

.dc-log-dot.is-warning {
  background: var(--dian-warning, #f0a020);
}

.dc-log-time {
  font-size: 11.5px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  flex: none;
  font-variant-numeric: tabular-nums;
}

.dc-log-msg {
  font-size: 12px;
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 卡片底注 */
.dc-footnote {
  margin: var(--dian-space-3, 12px) 0 0;
  padding-top: var(--dian-space-2, 8px);
  border-top: 1px dashed var(--dian-divider, #e0e4ea);
  font-size: 12px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
}

/* ---- 黑名单弹层(观察队列卡右上) ---- */

.dc-bl-panel {
  display: grid;
  gap: 10px;
  max-width: 340px;
}

.dc-bl-counts {
  font-size: 12px;
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
  font-variant-numeric: tabular-nums;
}

.dc-inline-form {
  display: flex;
  gap: 8px;
}

.dc-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.dc-mini-list {
  display: grid;
  gap: 6px;
}

.dc-mini-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--dian-radius-sm, 8px);
  background: var(--dian-surface-soft, #f7faff);
}

.dc-mini-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 底部「不再订阅名单」整宽条 ---- */

.dc-noresub {
  display: flex;
  align-items: center;
  gap: var(--dian-space-3, 12px);
  flex-wrap: wrap;
  padding: var(--dian-space-4, 16px) var(--dian-space-6, 24px);
}

.dc-noresub-icon {
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
  flex: none;
}

.dc-noresub-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
  flex: none;
}

.dc-noresub-desc {
  flex: 1;
  min-width: 220px;
  font-size: 12px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
}

.dc-noresub-action {
  margin-left: auto;
}

/* ---- 页脚 ---- */

.dc-footer {
  text-align: center;
  font-size: 12px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  padding: 0 0 var(--dian-space-3, 12px);
}

/* ---- 设置抽屉 ---- */

.dc-settings-section {
  font-weight: 600;
  font-size: 14px;
  margin: var(--dian-space-3, 12px) 0 var(--dian-space-2, 8px);
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
}

.dc-settings-list {
  border: 1px solid var(--dian-border, #e0e4ea);
  border-radius: var(--dian-radius-md, 12px);
  padding: var(--dian-space-3, 12px);
  margin-bottom: var(--dian-space-2, 8px);
}

.dc-settings-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--dian-space-2, 8px);
}

.dc-settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 var(--dian-space-3, 12px);
}

.dc-settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--dian-space-2, 8px) 0;
  font-size: 13px;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
}

.dc-settings-actions {
  justify-content: flex-start;
  gap: var(--dian-space-2, 8px);
  margin-top: var(--dian-space-2, 8px);
}

/* 功能 2: 过滤器输入项下方的说明文字 */
.dc-settings-hint {
  margin: -2px 0 6px;
  font-size: 12px;
}

/* ---- 断点(规范 §3): 900–1000px 双栏回落单栏; ≤640px 移动档 ---- */

@media (max-width: 1000px) {
  .dc-grid-2,
  .dc-grid-queue {
    grid-template-columns: minmax(0, 1fr);
  }

  .dc-tiles {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .dc-page {
    gap: var(--dian-space-3, 12px);
  }

  .dc-header-actions {
    width: 100%;
  }

  .dc-card {
    padding: var(--dian-space-4, 16px);
  }

  .dc-tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--dian-space-2, 8px);
  }

  /* 榜单海报横滑: 固定 92px 宽 + overflow-x + 右缘渐隐提示可滑 */
  .dc-hero-strip {
    mask-image: linear-gradient(to right, #000 88%, transparent);
    -webkit-mask-image: linear-gradient(to right, #000 88%, transparent);
  }

  .dc-poster-card {
    flex: 0 0 92px;
    min-width: 92px;
    max-width: 92px;
  }

  .dc-poster-title {
    font-size: 12px;
  }

  .dc-poster-hot {
    font-size: 11px;
  }

  .dc-sk-card {
    flex: 0 0 92px;
    min-width: 92px;
    max-width: 92px;
  }

  .dc-noresub-action {
    margin-left: 0;
    width: 100%;
  }

  .dc-settings-grid {
    grid-template-columns: 1fr;
  }
}
</style>
