<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import PosterImg from './PosterImg.vue'
import {
  NAlert,
  NButton,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NForm,
  NFormItem,
  NGrid,
  NGridItem,
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
  CheckCircle2,
  Eye,
  ExternalLink,
  Flame,
  ListChecks,
  RefreshCw,
  Settings,
  Star,
  Trash2,
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
const historyRecent = computed(() => state.value.history || [])
const logsRecent = computed(() => state.value.logs || [])
const snapshotLists = computed(() => state.value.snapshot?.lists || {})

// 纯展示层辅助: 榜单总数 / 榜单区是否完全无数据(骨架切换用, 不改任何数据流)
const snapshotListCount = computed(() => Object.keys(snapshotLists.value).length)
const snapshotEmpty = computed(() =>
  !listDefs.some((def) => (snapshotLists.value[def.key] || []).length > 0),
)

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

// 榜单卡片 meta: 评分与热度分开成徽章数据(无则回退原 displayHot 文案)
const hasRate = (item: ChartItem): boolean => Boolean(item.rate && parseFloat(item.rate) > 0)
const hasHot = (item: ChartItem): boolean => Boolean(item.hotness && item.hotness > 0)

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
    <header class="dc-header">
      <div class="dc-header-title">
        <h2>豆瓣中心 · 运行详情</h2>
        <p>榜单刷新 → 黑名筛选 → 观察队列 → 订阅记录</p>
      </div>
      <div class="dc-header-actions">
        <NTag type="success" size="small">{{ themeContract || 'dian115-theme-v1' }}</NTag>
        <NButton size="small" :loading="busy === 'refresh'" @click="refreshNow">
          <template #icon><NIcon :component="RefreshCw" /></template>
          刷新
        </NButton>
        <NButton size="small" :loading="busy === 'archive'" @click="archive">
          <template #icon><NIcon :component="Archive" /></template>
          归档
        </NButton>
        <NButton size="small" @click="openSettings">
          <template #icon><NIcon :component="Settings" /></template>
          设置
        </NButton>
      </div>
    </header>

    <NAlert v-if="state.last_message" :type="state.status === 'failed' ? 'error' : 'info'" :bordered="false" closable>
      {{ state.last_message }}
    </NAlert>

    <!-- 榜单快照: 海报卡片媒体区 -->
    <section class="dc-card dc-hero" aria-label="榜单快照">
      <div class="dc-section-head">
        <h3>榜单快照</h3>
        <span class="dc-muted">
          <template v-if="state.snapshot?.fetched_at">更新于 {{ relativeTime(state.snapshot.fetched_at) }}</template>
          <template v-else>最近抓取 —</template>
        </span>
        <div class="dc-hero-tabs">
          <button
            v-for="def in listDefs"
            :key="def.key"
            type="button"
            class="dc-hero-tab"
            :class="{ 'is-active': fullListKey === def.key }"
            @click="openFullList(def.key)"
          >
            <span>{{ def.label }}</span>
            <span class="dc-hero-tab-count">{{ (snapshotLists[def.key] || []).length }}</span>
          </button>
        </div>
      </div>

      <!-- 加载/空态骨架: 榜单完全无数据时以节奏一致的骨架填充 -->
      <div v-if="snapshotEmpty" class="dc-hero-skeleton" aria-hidden="true">
        <div v-for="n in 6" :key="n" class="dc-sk-card">
          <div class="dc-sk dc-sk-poster" />
          <div class="dc-sk dc-sk-line" />
          <div class="dc-sk dc-sk-line dc-sk-line-sm" />
        </div>
      </div>

      <div v-else class="dc-hero-strip">
        <template v-for="def in listDefs" :key="def.key">
          <NPopover
            v-for="item in (snapshotLists[def.key] || []).slice(0, 5)"
            :key="item.douban_ref"
            trigger="click"
            placement="bottom"
            :show="itemMenuOpen && targetItem?.douban_ref === item.douban_ref"
            @update:show="(v: boolean) => { itemMenuOpen = v; if (v) targetItem = item }"
          >
            <template #trigger>
              <article class="dc-hero-card" :title="item.title">
                <div class="dc-hero-poster">
                  <PosterImg :poster-url="item.poster_url" :api="props.api" :alt="item.title" class="dc-hero-poster-img" />
                  <span v-if="hasRate(item)" class="dc-rate-badge">
                    <NIcon :component="Star" :size="11" />{{ item.rate }}
                  </span>
                  <span v-else-if="hasHot(item)" class="dc-hot-badge">
                    <NIcon :component="Flame" :size="11" />{{ item.hotness }}
                  </span>
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
                <div class="dc-hero-info">
                  <div class="dc-hero-title">{{ item.title }}</div>
                  <div class="dc-hero-meta">
                    <span class="dc-chip">{{ listLabel(def.key) }}</span>
                    <span v-if="item.year" class="dc-chip dc-chip-muted">{{ item.year }}</span>
                  </div>
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
        </template>
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
                <span v-if="hasRate(item)" class="dc-rate-badge dc-rate-badge-inline">
                  <NIcon :component="Star" :size="11" />{{ item.rate }}
                </span>
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

    <!-- 黑名拦截 + 观察队列 -->
    <section class="dc-grid-2">
      <div class="dc-card" aria-label="黑名拦截">
        <div class="dc-section-head">
          <h3><NIcon :component="Ban" :size="15" /> 黑名拦截</h3>
          <NTag size="small" type="error" :bordered="false">关键词 {{ state.blacklist?.keywords?.length || 0 }} 个 · 最近命中 {{ state.blacklist?.hits || 0 }} 条</NTag>
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

      <div class="dc-card" aria-label="观察队列">
        <div class="dc-section-head">
          <h3><NIcon :component="Eye" :size="15" /> 观察队列</h3>
          <NTag size="small" type="warning" :bordered="false">待自动订阅 {{ queuePending.length }} 条</NTag>
        </div>
        <div v-if="!queuePending.length && !queueBlocked.length" class="dc-empty">
          <NEmpty description="队列为空" size="small" />
        </div>
        <div v-else class="dc-queue-list">
          <div v-for="item in queuePending.slice(0, 8)" :key="item.douban_ref" class="dc-queue-row">
            <div class="dc-queue-main">
              <div class="dc-queue-title">{{ item.title }}</div>
              <div class="dc-queue-meta">
                <span class="dc-chip">{{ listLabel(item.list) }}</span>
                <span v-if="item.due_at" class="dc-muted">{{ relativeTime(item.due_at) }}到期</span>
                <NTag v-if="item.state === 'needs_review'" size="tiny" type="error" :bordered="false">匹配待确认</NTag>
              </div>
            </div>
            <div class="dc-queue-actions">
              <NButton size="tiny" type="primary" :loading="busy === 'subscribe-now'" @click="subscribeQueueNow(item)">立即订阅</NButton>
              <NButton size="tiny" quaternary @click="openSource(item)">
                <template #icon><NIcon :component="ExternalLink" /></template>
              </NButton>
              <NButton size="tiny" quaternary type="error" @click="removeQueue(item)">
                <template #icon><NIcon :component="Trash2" /></template>
              </NButton>
            </div>
          </div>
          <!-- 功能 2/3: 被过滤器/墓碑拦下的终态条目, 只读展示(手动订阅仍可用) -->
          <div v-for="item in queueBlocked.slice(0, 8)" :key="item.douban_ref" class="dc-queue-row">
            <div class="dc-queue-main">
              <div class="dc-queue-title" :title="item.last_error">{{ item.title }}</div>
              <div class="dc-queue-meta">
                <span class="dc-chip">{{ listLabel(item.list) }}</span>
                <NTag v-if="item.state === 'filtered'" size="tiny" type="warning" :bordered="false" :title="item.last_error">已过滤</NTag>
                <NTag v-else-if="item.state === 'no_resub'" size="tiny" :bordered="false">已删除不重订</NTag>
              </div>
            </div>
            <div class="dc-queue-actions">
              <NButton size="tiny" :loading="busy === 'subscribe-now'" @click="subscribeQueueNow(item)">仍要订阅</NButton>
              <NButton size="tiny" quaternary @click="openSource(item)">
                <template #icon><NIcon :component="ExternalLink" /></template>
              </NButton>
              <NButton size="tiny" quaternary type="error" @click="removeQueue(item)">
                <template #icon><NIcon :component="Trash2" /></template>
              </NButton>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 我的想看 -->
    <section v-if="wishItems.length || wishInfo?.enabled || settingsForm.wish_sync_enabled" class="dc-card" aria-label="我的想看">
      <div class="dc-section-head">
        <h3>我的想看 <NTag v-if="wishItems.length" size="small" :bordered="false">{{ wishItems.length }}</NTag></h3>
        <div class="dc-head-actions">
          <NButton size="small" :loading="busy === 'wish-sync'" @click="syncWish">立即同步</NButton>
        </div>
      </div>
      <div v-if="!wishItems.length" class="dc-empty">还没有同步到想看条目，点「立即同步」或在设置里配置豆瓣账号</div>
      <div v-else class="dc-wish-list">
        <!-- 功能 3: 墓碑集非空时给出条数与清除入口 -->
        <div v-if="noResubCount > 0" class="dc-wish-row dc-wish-resub-row">
          <span class="dc-muted">已删除不重订：{{ noResubCount }} 条</span>
          <NButton size="tiny" :loading="busy === 'no-resub-clear'" @click="clearNoResub">清除重订限制</NButton>
        </div>
        <div v-for="w in wishItems.slice(0, 24)" :key="w.douban_ref" class="dc-wish-row">
          <PosterImg :poster-url="w.poster_url" :api="props.api" :alt="w.title" class="dc-wish-poster" />
          <span class="dc-wish-title" :title="w.title">{{ w.title }}</span>
          <span class="dc-wish-meta">
            <span v-if="w.year" class="dc-chip dc-chip-muted">{{ w.year }}</span>
            <span class="dc-chip">{{ w.type === 'tv' ? '剧集' : '电影' }}</span>
          </span>
        </div>
        <div v-if="wishItems.length > 24" class="dc-muted dc-wish-more">… 共 {{ wishItems.length }} 条</div>
      </div>
    </section>

    <!-- 订阅历史 + 订阅统计 -->
    <section class="dc-grid-2">
      <div class="dc-card" aria-label="订阅历史">
        <div class="dc-section-head">
          <h3><NIcon :component="CheckCircle2" :size="15" /> 订阅历史</h3>
        </div>
        <div v-if="!historyRecent.length" class="dc-empty">
          <NEmpty description="暂无订阅记录" size="small" />
        </div>
        <div v-else class="dc-history-list">
          <div v-for="(h, i) in historyRecent.slice(0, 8)" :key="i" class="dc-history-row">
            <div class="dc-history-main">
              <div class="dc-history-title">{{ h.title }}</div>
              <div class="dc-history-meta">
                <span class="dc-chip">{{ listLabel(h.list) }}</span>
                <span class="dc-status-dot" :class="h.result === 'succeeded' ? 'is-ok' : 'is-fail'" aria-hidden="true" />
                <span class="dc-history-result" :class="h.result === 'succeeded' ? 'is-ok' : 'is-fail'">
                  {{ h.result === 'succeeded' ? '订阅成功' : '订阅失败' }}
                </span>
                <span class="dc-muted">{{ relativeTime(h.created_at) || h.created_at?.slice(5, 16) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="dc-card" aria-label="订阅统计">
        <div class="dc-section-head">
          <h3><NIcon :component="ListChecks" :size="15" /> 订阅统计</h3>
        </div>
        <NGrid cols="2" :x-gap="10" :y-gap="10">
          <NGridItem span="2">
            <div class="dc-stat-box dc-stat-hero">
              <div class="dc-stat-num">{{ state.stats?.total || 0 }}</div>
              <div class="dc-stat-label">总订阅数</div>
            </div>
          </NGridItem>
          <NGridItem span="2">
            <div class="dc-stat-box">
              <div class="dc-stat-num dc-stat-accent">{{ state.stats?.month_new || 0 }}</div>
              <div class="dc-stat-label">本月新增</div>
            </div>
          </NGridItem>
          <NGridItem>
            <div class="dc-stat-box">
              <div class="dc-stat-num">{{ (state.stats?.by_list || {}).upcoming || 0 }}</div>
              <div class="dc-stat-label">即将上映</div>
            </div>
          </NGridItem>
          <NGridItem>
            <div class="dc-stat-box">
              <div class="dc-stat-num">{{ (state.stats?.by_list || {}).hot || 0 }}</div>
              <div class="dc-stat-label">实时热门</div>
            </div>
          </NGridItem>
          <NGridItem>
            <div class="dc-stat-box">
              <div class="dc-stat-num">{{ (state.stats?.by_list || {}).cn_wom || 0 }}</div>
              <div class="dc-stat-label">华语口碑</div>
            </div>
          </NGridItem>
          <NGridItem>
            <div class="dc-stat-box">
              <div class="dc-stat-num">{{ (state.stats?.by_list || {}).global_wom || 0 }}</div>
              <div class="dc-stat-label">全球口碑</div>
            </div>
          </NGridItem>
        </NGrid>
      </div>
    </section>

    <!-- 观察日志: 等宽时间线 -->
    <section class="dc-card" aria-label="观察日志">
      <div class="dc-section-head">
        <h3>观察日志</h3>
      </div>
      <div v-if="!logsRecent.length" class="dc-empty">
        <NEmpty description="暂无日志" size="small" />
      </div>
      <div v-else class="dc-log-list">
        <div v-for="(log, i) in logsRecent.slice(0, 12)" :key="i" class="dc-log-row">
          <span class="dc-log-dot" :class="'is-' + log.level" aria-hidden="true" />
          <span class="dc-log-time">{{ log.at.slice(5, 19) }}</span>
          <span class="dc-log-msg">{{ log.message }}</span>
        </div>
      </div>
    </section>

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
            <NSwitch v-model:value="settingsForm.notify_on_subscribe" size="small" />
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
/* ---- 根容器: 媒体优先仪表盘的统一节奏 ---- */

.dc-page {
  display: grid;
  gap: var(--dian-space-4);
  padding: var(--dian-space-1);
  width: 100%;
  max-width: 100%;
  min-width: 0;
  color: var(--dian-text-primary);
}

.dc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--dian-space-3);
  border-bottom: 1px solid var(--dian-divider);
  padding-bottom: var(--dian-space-4);
}

.dc-header-title {
  min-width: 0;
}

.dc-header-title h2,
.dc-header-title p {
  margin: 0;
  letter-spacing: 0;
}

.dc-header-title h2 {
  font-size: 22px;
  color: var(--dian-text-primary);
}

.dc-header-title p {
  margin-top: var(--dian-space-1);
  color: var(--dian-text-secondary);
  font-size: 13px;
}

.dc-header-actions {
  display: flex;
  align-items: center;
  gap: var(--dian-space-2);
  flex-wrap: wrap;
}

.dc-card {
  border: 1px solid var(--dian-border);
  border-radius: var(--dian-radius-lg);
  background: var(--dian-surface-raised);
  padding: var(--dian-space-4);
  min-width: 0;
  box-shadow: var(--dian-shadow-sm);
  transition: border-color 0.18s ease;
}

.dc-card:hover {
  border-color: var(--dian-border-strong);
}

.dc-section-head {
  display: flex;
  align-items: center;
  gap: var(--dian-space-2);
  margin-bottom: var(--dian-space-3);
  color: var(--dian-primary);
  flex-wrap: wrap;
  padding-bottom: var(--dian-space-2);
  border-bottom: 1px solid var(--dian-divider);
}

.dc-section-head h3 {
  margin: 0;
  font-size: 15px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--dian-text-primary);
}

.dc-muted {
  color: var(--dian-text-secondary);
  font-size: 12px;
  overflow-wrap: anywhere;
}

/* ---- 通用徽标: 评分 / 次级标签 chip / 状态点 ---- */

.dc-rate-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 7px;
  border-radius: var(--dian-radius-pill);
  font-size: 11.5px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--dian-primary);
  background: var(--dian-surface-raised);
  border: 1px solid var(--dian-primary);
  box-shadow: var(--dian-shadow-sm);
  line-height: 16px;
}

.dc-rate-badge-inline {
  position: static;
  box-shadow: none;
}

.dc-hot-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 7px;
  border-radius: var(--dian-radius-pill);
  font-size: 11.5px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--dian-primary);
  background: var(--dian-surface-raised);
  border: 1px solid var(--dian-primary);
  box-shadow: var(--dian-shadow-sm);
  line-height: 16px;
}

.dc-chip {
  display: inline-flex;
  align-items: center;
  padding: 0 7px;
  line-height: 18px;
  border-radius: var(--dian-radius-pill);
  font-size: 11px;
  font-weight: 500;
  color: var(--dian-text-secondary);
  background: var(--dian-surface-hover);
  white-space: nowrap;
}

.dc-chip-muted {
  background: transparent;
  border: 1px solid var(--dian-border);
}

.dc-chip-hot {
  color: var(--dian-primary);
}

/* ---- 榜单快照: 海报卡片媒体区 ---- */

.dc-hero {
  padding-top: var(--dian-space-3);
}

.dc-hero-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  flex-wrap: wrap;
}

.dc-hero-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--dian-border);
  border-radius: var(--dian-radius-pill);
  background: var(--dian-surface-soft);
  color: var(--dian-text-secondary);
  font: inherit;
  font-size: 12px;
  padding: 2px 10px;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}

.dc-hero-tab:hover {
  border-color: var(--dian-primary);
  color: var(--dian-primary);
}

.dc-hero-tab:focus-visible {
  outline: 2px solid var(--dian-focus-ring);
  outline-offset: 1px;
}

.dc-hero-tab.is-active {
  border-color: var(--dian-primary);
  color: var(--dian-primary);
  background: var(--dian-surface-hover);
  font-weight: 600;
}

.dc-hero-tab-count {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  background: var(--dian-surface-hover);
  border-radius: var(--dian-radius-pill);
  padding: 0 6px;
  line-height: 16px;
}

.dc-hero-tab.is-active .dc-hero-tab-count {
  color: var(--dian-primary-contrast);
  background: var(--dian-primary);
}

.dc-hero-strip {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 148px;
  justify-content: start;
  gap: var(--dian-space-3);
  overflow-x: auto;
  overscroll-behavior-x: contain;
  padding: var(--dian-space-1) 2px var(--dian-space-2);
  scrollbar-width: thin;
  scrollbar-color: var(--dian-border-strong) transparent;
}

.dc-hero-strip::-webkit-scrollbar {
  height: 6px;
}

.dc-hero-strip::-webkit-scrollbar-thumb {
  background: var(--dian-border-strong);
  border-radius: var(--dian-radius-pill);
}

.dc-hero-strip::-webkit-scrollbar-track {
  background: transparent;
}

.dc-hero-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dian-border);
  border-radius: var(--dian-radius-md);
  background: var(--dian-surface-soft);
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
}

.dc-hero-card:hover {
  transform: translateY(-3px);
  border-color: var(--dian-primary);
  box-shadow: var(--dian-shadow-md);
}

.dc-hero-poster {
  position: relative;
  aspect-ratio: 2 / 3;
  width: 100%;
  background: var(--dian-surface-hover);
}

.dc-hero-poster-img,
.dc-hero-poster-img :deep(img),
.dc-hero-poster-img :deep(.dc-poster-ph) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.dc-hero-poster-img :deep(.dc-poster-img) {
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
  background: linear-gradient(to top, var(--dian-scrim), transparent 55%);
  opacity: 0;
  transition: opacity 0.16s ease;
}

.dc-hero-card:hover .dc-hero-overlay,
.dc-hero-card:focus-within .dc-hero-overlay {
  opacity: 1;
}

/* 浮层压在 scrim 之上, 文字需恒为浅色, 由主题变量 --dian-text-inverse 提供 */
.dc-hero-overlay-btn {
  color: var(--dian-text-inverse);
}

.dc-hero-info {
  padding: var(--dian-space-2) 8px;
  display: grid;
  gap: 5px;
}

.dc-hero-title {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--dian-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: 1.35;
  min-height: 2.7em;
  overflow-wrap: anywhere;
}

.dc-hero-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

/* 骨架: 榜单完全无数据(刷新中/未抓取)时的占位, 节奏与卡片一致 */
.dc-hero-skeleton {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 148px;
  justify-content: start;
  gap: var(--dian-space-3);
  overflow: hidden;
  padding: var(--dian-space-1) 2px var(--dian-space-2);
}

.dc-sk-card {
  border: 1px solid var(--dian-border);
  border-radius: var(--dian-radius-md);
  background: var(--dian-surface-soft);
  padding: 8px;
  display: grid;
  gap: 8px;
}

.dc-sk {
  border-radius: var(--dian-radius-sm);
  background: linear-gradient(90deg, var(--dian-surface-hover) 25%, var(--dian-surface-soft) 50%, var(--dian-surface-hover) 75%);
  background-size: 200% 100%;
  animation: dc-sk-shimmer 1.4s ease infinite;
}

.dc-sk-poster {
  aspect-ratio: 2 / 3;
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
  gap: var(--dian-space-2);
  margin-bottom: var(--dian-space-3);
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
  border-radius: var(--dian-radius-sm);
  border: 1px solid var(--dian-border);
  background: var(--dian-surface-soft);
  min-width: 0;
  transition: border-color 0.15s;
}

.dc-full-row:hover {
  border-color: var(--dian-primary);
}

.dc-full-rank {
  width: 22px;
  flex: none;
  text-align: center;
  font-weight: 700;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--dian-text-secondary);
}

.dc-full-poster {
  width: 40px;
  height: 56px;
  object-fit: cover;
  border-radius: var(--dian-radius-sm);
  flex: none;
}

.dc-full-poster-ph {
  background: linear-gradient(135deg, var(--dian-surface-hover), var(--dian-surface-soft));
}

.dc-full-main {
  flex: 1;
  min-width: 0;
}

.dc-full-title {
  font-size: 13px;
  color: var(--dian-text-primary);
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
  padding: var(--dian-space-2);
}

/* ---- 双栏信息区 ---- */

.dc-grid-2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: var(--dian-space-4);
}

.dc-inline-form {
  display: flex;
  gap: 8px;
  margin-bottom: var(--dian-space-2);
}

.dc-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: var(--dian-space-2);
}

.dc-mini-list,
.dc-history-list,
.dc-queue-list,
.dc-log-list {
  display: grid;
  gap: 6px;
}

.dc-mini-row,
.dc-history-row,
.dc-queue-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--dian-radius-sm);
  background: var(--dian-surface-soft);
  border: 1px solid transparent;
  transition: border-color 0.15s;
}

.dc-history-row:hover,
.dc-queue-row:hover {
  border-color: var(--dian-border);
}

.dc-mini-title,
.dc-history-title,
.dc-queue-title {
  font-size: 13px;
  color: var(--dian-text-primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dc-history-main,
.dc-queue-main {
  min-width: 0;
  flex: 1;
}

.dc-history-meta,
.dc-queue-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  flex-wrap: wrap;
}

.dc-queue-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}

.dc-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}

.dc-status-dot.is-ok {
  background: var(--dian-success);
}

.dc-status-dot.is-fail {
  background: var(--dian-error);
}

.dc-history-result {
  font-size: 12px;
  font-weight: 500;
}

.dc-history-result.is-ok {
  color: var(--dian-success);
}

.dc-history-result.is-fail {
  color: var(--dian-error);
}

/* ---- 我的想看 ---- */

.dc-wish-list {
  display: grid;
  gap: 4px;
}

.dc-wish-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--dian-divider);
  font-size: 13px;
  border-radius: var(--dian-radius-sm);
  color: var(--dian-text-primary);
  transition: background 0.15s ease;
}

.dc-wish-row:hover {
  background: var(--dian-surface-hover);
}

.dc-wish-poster {
  width: 28px;
  height: 40px;
  object-fit: cover;
  border-radius: var(--dian-radius-sm);
  flex: none;
}

.dc-wish-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dian-text-primary);
}

.dc-wish-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.dc-wish-more {
  font-size: 12px;
  padding: 4px 8px;
}

/* ---- 统计数字卡 ---- */

.dc-stat-box {
  border: 1px solid var(--dian-border);
  border-radius: var(--dian-radius-md);
  background: var(--dian-surface-soft);
  padding: var(--dian-space-3);
  text-align: center;
  min-width: 0;
}

.dc-stat-hero {
  border-color: var(--dian-primary);
  background: linear-gradient(160deg, var(--dian-surface-soft), var(--dian-surface-hover));
}

.dc-stat-num {
  font-size: 22px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--dian-text-primary);
}

.dc-stat-hero .dc-stat-num {
  font-size: 30px;
  color: var(--dian-primary);
}

.dc-stat-accent {
  color: var(--dian-primary);
}

.dc-stat-label {
  font-size: 12px;
  color: var(--dian-text-secondary);
  margin-top: 2px;
}

/* ---- 观察日志: 等宽小字时间线 ---- */

.dc-log-list {
  font-family: var(--dian-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  border-left: 2px solid var(--dian-divider);
  padding-left: var(--dian-space-3);
  gap: 2px;
}

.dc-log-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 6px;
  border-radius: var(--dian-radius-sm);
  position: relative;
}

.dc-log-row:hover {
  background: var(--dian-surface-soft);
}

.dc-log-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  align-self: center;
  background: var(--dian-text-secondary);
  margin-left: calc(-1 * var(--dian-space-3) - 4px);
  margin-right: 2px;
}

.dc-log-dot.is-error {
  background: var(--dian-error);
}

.dc-log-dot.is-warning {
  background: var(--dian-warning);
}

.dc-log-time {
  font-size: 11px;
  color: var(--dian-text-secondary);
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

.dc-log-msg {
  font-size: 12px;
  color: var(--dian-text-secondary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 设置抽屉 ---- */

.dc-settings-section {
  font-weight: 600;
  font-size: 14px;
  margin: var(--dian-space-3) 0 var(--dian-space-2);
  color: var(--dian-text-primary);
}

.dc-settings-list {
  border: 1px solid var(--dian-border);
  border-radius: var(--dian-radius-md);
  padding: var(--dian-space-3);
  margin-bottom: var(--dian-space-2);
}

.dc-settings-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--dian-space-2);
}

.dc-settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 var(--dian-space-3);
}

.dc-settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--dian-space-2) 0;
  font-size: 13px;
  color: var(--dian-text-primary);
}

.dc-settings-actions {
  justify-content: flex-start;
  gap: var(--dian-space-2);
  margin-top: var(--dian-space-2);
}

/* 功能 2: 过滤器输入项下方的说明文字 */
.dc-settings-hint {
  margin: -2px 0 6px;
  font-size: 12px;
}

/* ---- 视口折叠: 宿主侧边栏打开时 iframe 变窄, 单栏 + 头部纵排 ---- */

@media (max-width: 1000px) {
  .dc-grid-2 {
    grid-template-columns: 1fr;
  }

  /* 榜单切换 pill 从头行右侧落到整行, 避免挤压标题 */
  .dc-hero-tabs {
    margin-left: 0;
    width: 100%;
  }
}

@media (max-width: 600px) {
  .dc-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .dc-card {
    padding: var(--dian-space-3);
  }

  .dc-hero-strip,
  .dc-hero-skeleton {
    grid-auto-columns: 128px;
  }

  .dc-settings-grid {
    grid-template-columns: 1fr;
  }
}
</style>
