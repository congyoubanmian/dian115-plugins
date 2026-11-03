<script setup lang="ts">
// 豆瓣中心（douban.rs）页面 —— Vue 3 版。
//
// 功能与原生 JS 版（v3-ui/legacy/douban-rs/page.native.js）一一对应：
// 页头（榜单/队列胶囊 + 刷新/同步/重读/设置）、指标瓦片、状态提示条、
// 四个标签页（榜单海报墙 / 观察队列与我的想看 / 历史与日志 / 设置）、页脚。
//
// 数据与能力全部走 ctx（storage / settings / tasks / http），
// 主题跟着 ctx.theme.mode 走（naive-ui 的 n-config-provider 由 shared/mount.ts 提供）。

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArchiveX, BellRing, Clapperboard, Eye, Heart, History, ListTodo, Settings, ShieldBan } from '@lucide/vue'
import { formatTime, num } from './format'
import { createPosterLoader, providePosterLoader } from './posters'
import { createDoubanStore, provideDoubanStore, type TabKey } from './store'
import AppHeader from './components/AppHeader.vue'
import ChartWall from './components/ChartWall.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import PosterLightbox from './components/PosterLightbox.vue'
import QueuePanel from './components/QueuePanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import StatTile from './components/StatTile.vue'
import ToastHost from './components/ToastHost.vue'
import { useCtx } from '../shared/use-ctx'
import { useHostTheme } from '../shared/theme'

const ctx = useCtx()
const { isDark } = useHostTheme()

// 状态中枢 + 海报加载器（页面级单例，卸载时一起销毁）。
const store = createDoubanStore(ctx)
provideDoubanStore(store)
const posters = createPosterLoader(ctx, store.invokeJob)
providePosterLoader(posters)

const {
  activeTab,
  busy,
  busyText,
  stateDoc,
  stateError,
  stateInvalid,
  loaded,
  settingsError,
  docSettings,
  snapshotItems,
  snapshotListCount,
  queueItems,
  wishItems,
  historyItems,
  logItems,
  blackState,
  wishInfo,
  tombstones,
  dueItems,
} = store

/** 海报放大预览的当前对象。 */
const zoom = ref<{ url: string; title: string; href?: string } | null>(null)
/** 设置面板容器（切到设置页时滚过去，与原生版一致）。 */
const settingsSection = ref<HTMLElement | null>(null)

const tabs = [
  { key: 'charts' as TabKey, label: '榜单', icon: Clapperboard },
  { key: 'queue' as TabKey, label: '队列与想看', icon: ListTodo },
  { key: 'history' as TabKey, label: '历史与日志', icon: History },
  { key: 'settings' as TabKey, label: '设置', icon: Settings },
]

const tabCounts = computed<Record<TabKey, string>>(() => ({
  charts: String(snapshotItems.value.length),
  queue: String(queueItems.value.length + wishItems.value.length),
  history: String(historyItems.value.length + logItems.value.length),
  settings: tombstones.value.length > 0 ? String(tombstones.value.length) : '',
}))

const tiles = computed(() => {
  const stats = stateDoc.value?.stats ?? {}
  const blacklist = docSettings.value.blacklist ?? []
  const due = dueItems.value.length
  return [
    {
      label: '榜单条目',
      icon: Clapperboard, tone: 'accent',
      value: String(snapshotItems.value.length),
      hint: `${snapshotListCount.value} 个榜单 · ${formatTime(stateDoc.value?.snapshot?.fetched_at) || '尚未刷新'}`,
    },
    {
      label: '观察队列',
      icon: Eye, tone: due > 0 ? 'warn' : 'accent',
      value: String(queueItems.value.length),
      hint: due > 0 ? `${due} 条已到期` : '暂无到期条目',
    },
    {
      label: '我的想看',
      icon: Heart, tone: 'alt',
      value: String(wishItems.value.length),
      hint: wishInfo.value.last_sync ? `上次同步 ${formatTime(wishInfo.value.last_sync)}` : '尚未同步',
    },
    {
      label: '累计订阅',
      icon: BellRing, tone: 'ok',
      value: String(num(stats.total)),
      hint: `本月 +${num(stats.month_new)}${stats.month ? `（${stats.month}）` : ''}`,
    },
    {
      label: '黑名单命中',
      icon: ShieldBan, tone: 'error',
      value: String(num(blackState.value.hits)),
      hint: `${blacklist.length} 个关键词`,
    },
    {
      label: '已删除不重订',
      icon: ArchiveX, tone: 'muted',
      value: String(tombstones.value.length),
      hint: tombstones.value.length > 0 ? '自动订阅会跳过' : '暂无墓碑',
    },
  ]
})

const showFreshHint = computed(() => loaded.value && !stateDoc.value && !stateError.value)
const showNoSnapshotHint = computed(() => Boolean(stateDoc.value) && !stateDoc.value?.snapshot?.fetched_at)

onMounted(() => {
  void store.loadData()
})

// 切到「设置」时把设置面板滚到视野里（原生版 showTab('settings') 的 scrollIntoView）。
watch(activeTab, (key) => {
  if (key !== 'settings') return
  void nextTick(() => {
    settingsSection.value?.scrollIntoView?.({ block: 'start' })
  })
})

onBeforeUnmount(() => {
  posters.dispose()
  store.dispose()
})
</script>

<template>
  <div class="db-root" :class="{ 'db-root--dark': isDark }">
    <div class="db-shell">
      <AppHeader />

      <Transition name="db-fade">
        <p v-if="busy" class="db-progress" role="status">
          <span class="db-spinner" />
          <span>{{ busyText }}</span>
          <span class="db-progress__bar" aria-hidden="true" />
        </p>
      </Transition>

      <section class="db-tiles" :aria-busy="!loaded">
        <StatTile
          v-for="tile in tiles"
          :key="tile.label"
          :label="tile.label"
          :value="tile.value"
          :hint="tile.hint"
          :icon="tile.icon"
          :tone="tile.tone"
          :loading="!loaded"
        />
      </section>

      <p v-if="!loaded && !busy" class="db-sr" role="status">正在读取插件数据…</p>

      <TransitionGroup tag="div" name="db-fade" class="db-banners">
        <div v-if="stateError" key="state-error" class="db-banner db-banner--error" role="alert">
          <span class="db-banner__dot" />
          <span>{{ stateError }}</span>
        </div>
        <div v-if="settingsError" key="settings-error" class="db-banner db-banner--warning" role="alert">
          <span class="db-banner__dot" />
          <span>{{ settingsError }}</span>
        </div>
        <div v-if="stateInvalid" key="invalid" class="db-banner db-banner--warning">
          <span class="db-banner__dot" />
          <span>页面不会覆盖无法识别的旧数据；如需重新开始，请先在宿主存储里处理 state 键。</span>
        </div>
        <div v-if="showFreshHint" key="fresh" class="db-banner db-banner--info">
          <span class="db-banner__dot" />
          <span>全新安装：还没有榜单快照。点击「刷新榜单」抓取第一轮数据；想看同步需要先在设置里粘贴豆瓣 Cookie。</span>
        </div>
        <div v-if="showNoSnapshotHint" key="no-snapshot" class="db-banner db-banner--info">
          <span class="db-banner__dot" />
          <span>当前还没有榜单快照。点击右上角「刷新榜单」，后台会按已启用的榜单逐项抓取。</span>
        </div>
      </TransitionGroup>

      <nav class="db-tabs" role="tablist" aria-label="豆瓣中心分区">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          role="tab"
          class="db-tab"
          :aria-selected="activeTab === tab.key"
          :class="{ 'db-tab--active': activeTab === tab.key }"
          @click="store.showTab(tab.key)"
        >
          <component :is="tab.icon" :size="15" aria-hidden="true" />
          <span>{{ tab.label }}</span>
          <span class="db-tab-count">{{ tabCounts[tab.key] }}</span>
        </button>
      </nav>

      <div class="db-panels">
        <section v-show="activeTab === 'charts'" class="db-panel">
          <ChartWall @zoom="zoom = $event" />
        </section>
        <section v-show="activeTab === 'queue'" class="db-panel">
          <QueuePanel @zoom="zoom = $event" />
        </section>
        <section v-show="activeTab === 'history'" class="db-panel">
          <HistoryPanel />
        </section>
        <section v-show="activeTab === 'settings'" ref="settingsSection" class="db-panel">
          <SettingsPanel />
        </section>
      </div>

      <footer class="db-foot">
        数据来自插件存储 state 键与宿主设置 KV；动作通过宿主任务队列执行。
      </footer>
    </div>

    <ToastHost />

    <Transition name="db-zoom">
      <PosterLightbox
        v-if="zoom"
        :src="zoom.url"
        :title="zoom.title"
        :href="zoom.href"
        @close="zoom = null"
      />
    </Transition>
  </div>
</template>

<style scoped>
.db-root {
  /* 页面占满内容区并在插件区域内滚动；sticky 相对插件区域生效。 */
  height: 100%;
  min-height: 0;
  overflow: auto;
  box-sizing: border-box;
  position: relative;
  padding: 12px clamp(12px, 2.4vw, 28px) 42px;
  color: var(--app-text, #1f2329);
  font-size: 14px;
  line-height: 1.5;

  /* 页面内的语义色（继承宿主的明暗变量）。 */
  --db-line: var(--app-border, #e3e6eb);
  --db-muted: var(--app-text-secondary, #6b7280);
  --db-accent: var(--app-accent, #2080f0);
  /* 第二强调色：由宿主强调色混出，支持相对颜色语法时转一个色相。 */
  --db-accent-2: color-mix(in oklab, var(--db-accent) 70%, var(--app-text, #1f2329));
  --db-ok: #18a058;
  --db-warn: #f0a020;
  --db-err: #d03050;
  --db-star: var(--db-warn);
  --db-radius: 14px;

  /* 背景：宿主底色上叠两团很淡的强调色光晕。 */
  background:
    radial-gradient(900px 420px at 100% -10%, color-mix(in srgb, var(--db-accent) 9%, transparent), transparent 70%),
    radial-gradient(700px 380px at -10% 0%, color-mix(in srgb, var(--db-accent-2) 7%, transparent), transparent 70%),
    var(--app-bg, #f5f6f8);
}

@supports (color: oklch(from red l c h)) {
  .db-root {
    --db-accent-2: oklch(from var(--db-accent) l c calc(h + 55));
  }
}

.db-root--dark {
  background:
    radial-gradient(900px 420px at 100% -10%, color-mix(in srgb, var(--db-accent) 16%, transparent), transparent 70%),
    radial-gradient(700px 380px at -10% 0%, color-mix(in srgb, var(--db-accent-2) 12%, transparent), transparent 70%),
    var(--app-bg, #18181c);
}

/* 容器查询：子组件按页面自身宽度（而不是视口）调整布局。 */
.db-shell {
  container: db-page / inline-size;
  min-width: 0;
}

.db-root :deep(a) {
  color: inherit;
}

.db-root :deep(h1),
.db-root :deep(h2),
.db-root :deep(h3),
.db-root :deep(p) {
  margin: 0;
}

.db-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.db-progress {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 12px;
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 13px;
  color: var(--db-accent);
  background: color-mix(in srgb, var(--db-accent) 8%, var(--app-surface, #fff));
  border: 1px solid color-mix(in srgb, var(--db-accent) 25%, transparent);
}

.db-progress__bar {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  width: 35%;
  background: linear-gradient(90deg, transparent, var(--db-accent), var(--db-accent-2), transparent);
  animation: db-indeterminate 1.3s ease-in-out infinite;
}

@keyframes db-indeterminate {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(300%);
  }
}

.db-spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  flex: none;
  border: 2px solid color-mix(in srgb, var(--db-accent) 30%, transparent);
  border-top-color: var(--db-accent);
  animation: db-spin 0.8s linear infinite;
}

@keyframes db-spin {
  to {
    transform: rotate(360deg);
  }
}

.db-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}

.db-banners {
  display: grid;
  gap: 8px;
  margin-bottom: 12px;
}

.db-banners:empty {
  display: none;
}

.db-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  border: 1px solid transparent;
  overflow-wrap: anywhere;
}

.db-banner__dot {
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 50%;
  flex: none;
  background: currentColor;
}

.db-banner--info {
  color: var(--db-accent);
  background: color-mix(in srgb, var(--db-accent) 7%, transparent);
  border-color: color-mix(in srgb, var(--db-accent) 22%, transparent);
}

.db-banner--warning {
  color: var(--db-warn);
  background: color-mix(in srgb, var(--db-warn) 8%, transparent);
  border-color: color-mix(in srgb, var(--db-warn) 30%, transparent);
}

.db-banner--error {
  color: var(--db-err);
  background: color-mix(in srgb, var(--db-err) 8%, transparent);
  border-color: color-mix(in srgb, var(--db-err) 30%, transparent);
}

/* 分区标签：胶囊式分段导航 */
.db-tabs {
  box-sizing: border-box;
  display: flex;
  gap: 4px;
  width: fit-content;
  max-width: 100%;
  margin-bottom: 16px;
  padding: 4px;
  border-radius: 14px;
  border: 1px solid var(--db-line);
  background: color-mix(in srgb, var(--app-surface, #fff) 85%, transparent);
  overflow-x: auto;
  scrollbar-width: none;
}

.db-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 13px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--db-muted);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color 0.2s ease,
    color 0.2s ease,
    box-shadow 0.2s ease;
}

.db-tab:hover {
  color: var(--app-text, #1f2329);
  background: color-mix(in srgb, var(--app-text, #1f2329) 5%, transparent);
}

.db-tab:focus-visible {
  outline: 2px solid var(--db-accent);
  outline-offset: 1px;
}

.db-tab--active,
.db-tab--active:hover {
  color: var(--db-accent);
  font-weight: 600;
  background: color-mix(in srgb, var(--db-accent) 13%, var(--app-surface, #fff));
  box-shadow: 0 4px 14px -8px color-mix(in srgb, var(--db-accent) 70%, transparent);
}

.db-root--dark .db-tab--active {
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--db-accent) 30%, transparent),
    0 0 18px -6px color-mix(in srgb, var(--db-accent) 60%, transparent);
}

.db-tab-count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  background: color-mix(in srgb, var(--db-accent) 12%, transparent);
  color: var(--db-accent);
}

.db-tab-count:empty {
  display: none;
}

.db-panels {
  min-width: 0;
}

.db-panel {
  display: grid;
  gap: 14px;
  animation: db-panel-in 0.32s ease both;
}

@keyframes db-panel-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}

.db-foot {
  display: flex;
  justify-content: center;
  padding: 18px 0 4px;
  color: var(--db-muted);
  font-size: 11px;
  text-align: center;
}

/* 进度条/提示条淡入淡出 */
.db-fade-enter-active,
.db-fade-leave-active {
  transition:
    opacity 0.22s ease,
    transform 0.22s ease;
}

.db-fade-enter-from,
.db-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* 海报放大：背景淡入 + 面板缩放 */
.db-zoom-enter-active,
.db-zoom-leave-active {
  transition: opacity 0.24s ease;
}

.db-zoom-enter-active :deep(.db-lightbox__panel),
.db-zoom-leave-active :deep(.db-lightbox__panel) {
  transition:
    transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1.2),
    opacity 0.24s ease;
}

.db-zoom-enter-from,
.db-zoom-leave-to {
  opacity: 0;
}

.db-zoom-enter-from :deep(.db-lightbox__panel),
.db-zoom-leave-to :deep(.db-lightbox__panel) {
  transform: scale(0.88) translateY(12px);
  opacity: 0;
}

@container db-page (max-width: 720px) {
  .db-tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .db-tabs {
    width: 100%;
  }
}

@media (max-width: 720px) {
  .db-root {
    padding: 10px 10px 30px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .db-spinner,
  .db-progress__bar,
  .db-panel {
    animation: none;
  }

  .db-tab,
  .db-fade-enter-active,
  .db-fade-leave-active,
  .db-zoom-enter-active,
  .db-zoom-leave-active,
  .db-zoom-enter-active :deep(.db-lightbox__panel),
  .db-zoom-leave-active :deep(.db-lightbox__panel) {
    transition: none;
  }
}
</style>
