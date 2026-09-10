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
  NModal,
  NPopover,
  NSelect,
  NSpin,
  NSwitch,
  NTag,
  useMessage,
} from 'naive-ui'
import {
  Archive,
  Ban,
  CheckCircle2,
  Eye,
  ExternalLink,
  ListChecks,
  RefreshCw,
  Settings,
  Trash2,
  XCircle,
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
  }
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
})

watch(
  () => state.value.settings,
  (s) => {
    if (s) Object.assign(settingsForm, JSON.parse(JSON.stringify(s)))
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
    if (!opts.silent) message.success(String(result.message || '操作完成'))
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

async function subscribeItem(item: ChartItem) {
  itemMenuOpen.value = false
  targetItem.value = null
  await runAction('subscribe', { douban_ref: item.douban_ref })
}

async function subscribeQueueNow(item: QueueItem) {
  await runAction('subscribe-now', { douban_ref: item.douban_ref })
}

async function removeQueue(item: QueueItem) {
  await runAction('observe-remove', { douban_ref: item.douban_ref })
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
  await runAction('settings-update', { ...settingsForm })
  settingsOpen.value = false
}

async function archive() {
  await runAction('archive')
}

const queuePending = computed(() => (state.value.observe_queue?.items || []).filter((i) => i.state !== 'subscribed'))
const historyRecent = computed(() => state.value.history || [])
const logsRecent = computed(() => state.value.logs || [])
const snapshotLists = computed(() => state.value.snapshot?.lists || {})

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

    <!-- 榜单快照 -->
    <section class="dc-card" aria-label="榜单快照">
      <div class="dc-section-head">
        <h3>榜单快照</h3>
        <span class="dc-muted">最近抓取 {{ state.snapshot?.fetched_at || '—' }}</span>
      </div>
      <div class="dc-lists">
        <div v-for="def in listDefs" :key="def.key" class="dc-list-col">
          <button type="button" class="dc-list-head dc-list-head-btn" @click="openFullList(def.key)">
            <span>{{ def.label }}</span>
            <span class="dc-list-count">{{ (snapshotLists[def.key] || []).length }}</span>
            <span class="dc-list-more">查看全部 ›</span>
          </button>
          <div v-if="!(snapshotLists[def.key] && snapshotLists[def.key].length)" class="dc-empty">
            <NEmpty description="暂无数据" size="small" />
          </div>
          <NPopover
            v-for="item in (snapshotLists[def.key] || []).slice(0, 5)"
            :key="item.douban_ref"
            trigger="click"
            placement="right"
            :show="itemMenuOpen && targetItem?.douban_ref === item.douban_ref"
            @update:show="(v: boolean) => { itemMenuOpen = v; if (v) targetItem = item }"
          >
            <template #trigger>
              <div class="dc-item" :title="item.title">
                <PosterImg :poster-url="item.poster_url" :api="props.api" class="dc-item-poster" />
                <div class="dc-item-main">
                  <div class="dc-item-title">{{ item.title }}</div>
                  <div class="dc-item-meta">
                    <NTag size="tiny" :bordered="false" type="info">{{ displayHot(item) }}</NTag>
                  </div>
                </div>
              </div>
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
      </div>
    </section>

    <!-- 完整榜单抽屉 -->
    <NDrawer v-model:show="fullListOpen" :width="520" placement="right">
      <NDrawerContent :title="`${fullListLabel} · 完整榜单`" closable>
        <div class="dc-full-head">
          <span class="dc-muted">最近抓取 {{ state.snapshot?.fetched_at || '—' }}</span>
          <NTag size="small" type="info" :bordered="false">共 {{ fullListItems.length }} 条</NTag>
        </div>
        <div v-if="!fullListItems.length" class="dc-empty">
          <NEmpty description="该榜单暂无数据" size="small" />
        </div>
        <div v-else class="dc-full-list">
          <div v-for="(item, i) in fullListItems" :key="item.douban_ref" class="dc-full-row">
            <span class="dc-full-rank">{{ i + 1 }}</span>
            <PosterImg :poster-url="item.poster_url" :api="props.api" class="dc-full-poster" />
            <div class="dc-full-main">
              <div class="dc-full-title" :title="item.title">{{ item.title }}</div>
              <div class="dc-full-meta">
                <NTag size="tiny" :bordered="false" type="info">{{ displayHot(item) }}</NTag>
                <span v-if="item.year" class="dc-muted">{{ item.year }}</span>
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
        <div v-if="!queuePending.length" class="dc-empty">
          <NEmpty description="队列为空" size="small" />
        </div>
        <div v-else class="dc-queue-list">
          <div v-for="item in queuePending.slice(0, 8)" :key="item.douban_ref" class="dc-queue-row">
            <div class="dc-queue-main">
              <div class="dc-queue-title">{{ item.title }}</div>
              <div class="dc-queue-meta">
                <NTag size="tiny" :bordered="false">{{ listLabel(item.list) }}</NTag>
                <span class="dc-muted">{{ item.due_at ? '到期 ' + item.due_at.slice(5, 16) : '' }}</span>
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
        </div>
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
                <NTag size="tiny" :bordered="false">{{ listLabel(h.list) }}</NTag>
                <NTag size="tiny" :type="h.result === 'succeeded' ? 'success' : 'error'" :bordered="false">
                  {{ h.result === 'succeeded' ? '订阅成功' : '订阅失败' }}
                </NTag>
                <span class="dc-muted">{{ h.created_at?.slice(5, 16) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="dc-card" aria-label="订阅统计">
        <div class="dc-section-head">
          <h3><NIcon :component="ListChecks" :size="15" /> 订阅统计</h3>
        </div>
        <NGrid cols="2 s:3" responsive="screen" :x-gap="10" :y-gap="10">
          <NGridItem>
            <div class="dc-stat-box">
              <div class="dc-stat-num">{{ state.stats?.total || 0 }}</div>
              <div class="dc-stat-label">总订阅数</div>
            </div>
          </NGridItem>
          <NGridItem>
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

    <!-- 观察日志 -->
    <section class="dc-card" aria-label="观察日志">
      <div class="dc-section-head">
        <h3>观察日志</h3>
      </div>
      <div v-if="!logsRecent.length" class="dc-empty">
        <NEmpty description="暂无日志" size="small" />
      </div>
      <div v-else class="dc-log-list">
        <div v-for="(log, i) in logsRecent.slice(0, 12)" :key="i" class="dc-log-row">
          <span class="dc-log-time">{{ log.at.slice(5, 19) }}</span>
          <NTag size="tiny" :type="log.level === 'error' ? 'error' : log.level === 'warning' ? 'warning' : 'info'" :bordered="false">
            {{ log.level }}
          </NTag>
          <span class="dc-log-msg">{{ log.message }}</span>
        </div>
      </div>
    </section>

    <!-- 设置抽屉 -->
    <NDrawer v-model:show="settingsOpen" :width="520" placement="right">
      <NDrawerContent title="豆瓣中心 · 设置" closable>
        <NForm label-placement="top">
          <div class="dc-settings-section">榜单配置</div>
          <div v-for="def in listDefs" :key="def.key" class="dc-settings-list">
            <div class="dc-settings-list-head">
              <strong>{{ def.label }}</strong>
              <NSwitch v-model:value="settingsForm.lists![def.key]!.enabled" size="small" />
            </div>
            <div class="dc-settings-grid">
              <NFormItem label="来源">
                <NSelect v-model:value="settingsForm.lists![def.key]!.source" :options="sourceOptions" size="small" />
              </NFormItem>
              <NFormItem v-if="settingsForm.lists![def.key]!.source === 'subjects_json'" label="类型">
                <NSelect v-model:value="settingsForm.lists![def.key]!.type" :options="typeOptions" size="small" />
              </NFormItem>
              <NFormItem v-if="settingsForm.lists![def.key]!.source === 'subjects_json'" label="Tag">
                <NInput v-model:value="settingsForm.lists![def.key]!.tag" size="small" placeholder="热门 / 华语 / 欧美" />
              </NFormItem>
              <NFormItem v-if="settingsForm.lists![def.key]!.source === 'subjects_json'" label="排序">
                <NInput v-model:value="settingsForm.lists![def.key]!.sort" size="small" placeholder="recommend" />
              </NFormItem>
              <NFormItem label="条数">
                <NInputNumber v-model:value="settingsForm.lists![def.key]!.limit" size="small" :min="1" :max="20" />
              </NFormItem>
            </div>
          </div>

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
.dc-page {
  display: grid;
  gap: var(--dian-space-4);
  padding: var(--dian-space-1);
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
}

.dc-section-head {
  display: flex;
  align-items: center;
  gap: var(--dian-space-2);
  margin-bottom: var(--dian-space-3);
  color: var(--dian-primary);
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

.dc-grid-2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: var(--dian-space-4);
}

.dc-lists {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--dian-space-3);
}

.dc-list-col {
  border: 1px solid var(--dian-border);
  border-radius: var(--dian-radius-md);
  background: var(--dian-surface-soft);
  padding: var(--dian-space-2);
  min-width: 0;
}

.dc-list-head {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: var(--dian-space-2);
  color: var(--dian-text-primary);
}

.dc-list-head-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: 0;
  padding: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font: inherit;
}

.dc-list-head-btn:hover .dc-list-more {
  color: var(--dian-primary);
}

.dc-list-count {
  font-size: 11px;
  font-weight: 400;
  color: var(--dian-text-secondary);
  background: var(--dian-surface-hover);
  border-radius: 999px;
  padding: 0 7px;
  line-height: 18px;
}

.dc-list-more {
  margin-left: auto;
  font-size: 11px;
  font-weight: 400;
  color: var(--dian-text-secondary);
  transition: color 0.2s;
  white-space: nowrap;
}

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
}

.dc-full-rank {
  width: 22px;
  flex: none;
  text-align: center;
  font-weight: 600;
  font-size: 13px;
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


.dc-item {
  display: flex;
  gap: 8px;
  padding: 6px 4px;
  border-radius: var(--dian-radius-sm);
  cursor: pointer;
  align-items: center;
}

.dc-item:hover {
  background: var(--dian-surface-hover);
}

.dc-item-poster {
  width: 40px;
  height: 56px;
  object-fit: cover;
  border-radius: 6px;
  flex: 0 0 40px;
  background: var(--dian-surface-raised);
}

.dc-item-poster-ph {
  background: linear-gradient(135deg, rgba(139, 200, 234, 0.3), rgba(155, 187, 244, 0.3));
}

.dc-item-main {
  min-width: 0;
}

.dc-item-title {
  font-size: 12.5px;
  color: var(--dian-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: 1.35;
}

.dc-item-meta {
  margin-top: 4px;
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
.dc-queue-row,
.dc-log-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--dian-radius-sm);
  background: var(--dian-surface-soft);
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
  margin-top: 3px;
  flex-wrap: wrap;
}

.dc-queue-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}

.dc-stat-box {
  border: 1px solid var(--dian-border);
  border-radius: var(--dian-radius-md);
  background: var(--dian-surface-soft);
  padding: var(--dian-space-3);
  text-align: center;
}

.dc-stat-num {
  font-size: 22px;
  font-weight: 700;
  color: var(--dian-text-primary);
}

.dc-stat-accent {
  color: var(--dian-primary);
}

.dc-stat-label {
  font-size: 12px;
  color: var(--dian-text-secondary);
  margin-top: 2px;
}

.dc-log-time {
  font-size: 11px;
  color: var(--dian-text-secondary);
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

.dc-log-msg {
  font-size: 12.5px;
  color: var(--dian-text-primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

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

@media (max-width: 600px) {
  .dc-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .dc-lists {
    grid-template-columns: 1fr 1fr;
  }

  .dc-settings-grid {
    grid-template-columns: 1fr;
  }
}
</style>
