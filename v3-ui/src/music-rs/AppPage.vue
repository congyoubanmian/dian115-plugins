<script setup lang="ts">
// 音乐下载（music.rs）页面 —— Vue 3 版。
//
// 结构与行为对齐改写前的原生 JS 版（v3-ui/legacy/music-rs/page.js）：
// 玻璃质感页头（登录状态胶囊 + 手动 Cookie + 刷新 + ⚙ + 统计磁贴）→「正在下载」主视觉 →
// 登录卡（QR + stepper + 其他登录方式 + 音质档位）→ 胶囊式 Tabs（搜索 / 我的歌单 / 任务 / 设置）
// → 最近动作 → 页脚。
//
// 样式只写在 .music-page 之下（scoped），颜色全部从宿主变量 --app-* 派生（color-mix），
// 深浅两套主题都可读；动效都尊重 prefers-reduced-motion。
//
// 数据与能力只走 ctx（store.ts 装配）：ctx.storage / ctx.settings / ctx.tasks / ctx.http /
// ctx.notify；主题由 shared/mount.ts 接到 naive-ui 的 n-config-provider。
// 页面不直接 fetch 宿主业务接口，也不自建 WebSocket。

import { computed, onBeforeUnmount, onMounted, provide, ref, watch, type Component } from 'vue'
import { NButton, NTag } from 'naive-ui'
import {
  Cookie as CookieIcon,
  Download as DownloadIcon,
  ListMusic as ListMusicIcon,
  RefreshCw as RefreshIcon,
  Search as SearchIcon,
  Settings as SettingsIcon,
} from '@lucide/vue'
import { useCtx } from '../shared/use-ctx'
import { useHostTheme } from '../shared/theme'
import { COVER_KEY, createCoverCache, READY_KEY } from './ui-kit'
import { createMusicStore, MUSIC_STORE_KEY } from './store'
import LoginCard from './components/LoginCard.vue'
import SearchPanel from './components/SearchPanel.vue'
import PlaylistPanel from './components/PlaylistPanel.vue'
import TaskPanel from './components/TaskPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import ActivityPanel from './components/ActivityPanel.vue'
import Toasts from './components/Toasts.vue'
import StatTiles from './components/StatTiles.vue'
import NowDownloading from './components/NowDownloading.vue'

type TabId = 'search' | 'playlists' | 'tasks' | 'settings'

const TABS: Array<{ id: TabId; text: string; icon: Component }> = [
  { id: 'search', text: '搜索', icon: SearchIcon },
  { id: 'playlists', text: '我的歌单', icon: ListMusicIcon },
  { id: 'tasks', text: '任务', icon: DownloadIcon },
  { id: 'settings', text: '设置', icon: SettingsIcon },
]

const ctx = useCtx()
const store = createMusicStore(ctx)
provide(MUSIC_STORE_KEY, store)
const covers = createCoverCache(ctx)
provide(COVER_KEY, covers)
const { isDark } = useHostTheme()

const { login, loginSource, pendingTasks, busy, loading, playlists, playlistView } = store

const tab = ref<TabId>('search')
const tabIndex = computed(() => TABS.findIndex((item) => item.id === tab.value))

/** 首次状态读回之前显示骨架屏（之后的定时刷新不再闪骨架）。 */
const ready = ref(false)
watch(loading, (now, before) => {
  if (before && !now) ready.value = true
})
provide(READY_KEY, ready)
const loginCardRef = ref<HTMLElement | null>(null)

/** 页头的登录胶囊跟随登录卡当前来源。 */
const headLogin = computed(() => (loginSource.value === 'qq' ? login.qq : login.netease))

function switchTab(id: TabId): void {
  tab.value = id
  // 第一次进「我的歌单」页签时拉取歌单（需要登录）。
  if (id === 'playlists' && !playlists.value.length && !playlistView.value && !busy.value) {
    void store.loadPlaylists()
  }
}

/** 页头的「手动 Cookie」：展开/收起登录卡里的粘贴面板，展开时滚到登录卡（原生版同行为）。 */
function openCookiePanel(): void {
  const opening = !store.cookiePanelOpen.value
  store.toggleCookiePanel()
  if (opening) loginCardRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// 任务页有进行中任务时每 5 秒跟随队列刷新（原生版 ensureTaskTimer）。
watch(
  [tab, pendingTasks],
  () => {
    store.setTaskRefresh(tab.value === 'tasks' && pendingTasks.value.length > 0)
  },
  { immediate: true },
)

/** 宿主中止 signal 时的兜底清理；正常卸载时也要解绑，避免回调持有旧 store。 */
function onHostAbort(): void {
  store.dispose()
}

onMounted(() => {
  void store.refresh()
  // 宿主关页面时会中止 ctx.signal：那时也把定时器停掉（清理函数通常也会被调用，这里是兜底）。
  ctx.signal?.addEventListener('abort', onHostAbort, { once: true })
})

onBeforeUnmount(() => {
  // 停掉扫码轮询与任务刷新定时器（store 自己登记，dispose 一次清完）。
  ctx.signal?.removeEventListener('abort', onHostAbort)
  store.dispose()
  covers.dispose()
})
</script>


<template>
  <div class="music-page" :class="{ 'music-page--dark': isDark }">
    <!-- 页头：玻璃质感 + 强调色渐变；深色主题带柔光 -->
    <header class="music-head">
      <div class="music-head__top">
        <div class="music-brand">
          <span class="music-brand__icon" aria-hidden="true">
            <span v-for="bar in 4" :key="bar" class="music-brand__bar" />
          </span>
          <div class="music-brand__text">
            <h1>音乐下载</h1>
            <p>扫码登录网易云 / QQ 音乐 · 下载至 115 网盘 · 队列自动推进</p>
          </div>
        </div>
        <div class="music-head__actions">
          <NTag size="small" round :bordered="false" :type="headLogin.logged_in ? 'success' : 'warning'">
            {{ headLogin.logged_in ? '已登录' : '未登录' }} · {{ store.sourceName(loginSource) }}
          </NTag>
          <NButton size="small" secondary round @click="openCookiePanel">
            <template #icon><CookieIcon :size="14" /></template>
            手动 Cookie
          </NButton>
          <NButton
            size="small"
            quaternary
            circle
            :loading="loading"
            title="刷新状态"
            aria-label="刷新状态"
            @click="store.refresh()"
          >
            <template #icon><RefreshIcon :size="15" /></template>
          </NButton>
          <NButton size="small" quaternary circle title="设置" aria-label="设置" @click="switchTab('settings')">
            <template #icon><SettingsIcon :size="16" /></template>
          </NButton>
        </div>
      </div>
      <StatTiles @open="switchTab('tasks')" />
    </header>

    <!-- 进行中任务的主视觉（无进行中任务时不占位） -->
    <NowDownloading />

    <!-- 登录卡：左 QR 白底卡 | 右 stepper + 其他登录方式 + 音质档位 -->
    <section ref="loginCardRef" class="music-card music-login">
      <LoginCard />
    </section>

    <!-- 胶囊式 Tabs：指示块随选中项滑动 -->
    <nav class="music-tabs" role="tablist" aria-label="功能分页" :style="{ '--tab-i': tabIndex, '--tab-n': TABS.length }">
      <span class="music-tabs__pill" aria-hidden="true" />
      <button
        v-for="item in TABS"
        :key="item.id"
        type="button"
        role="tab"
        class="music-tab"
        :class="{ 'music-tab--on': tab === item.id }"
        :aria-selected="tab === item.id"
        :aria-label="item.text"
        :title="item.text"
        @click="switchTab(item.id)"
      >
        <component :is="item.icon" :size="15" aria-hidden="true" />
        <span class="music-tab__text">{{ item.text }}</span>
        <span v-if="item.id === 'tasks' && pendingTasks.length" class="music-tab__badge">
          {{ pendingTasks.length }}
        </span>
      </button>
    </nav>

    <!-- 各分页 -->
    <section v-show="tab === 'search'" class="music-card music-panel" role="tabpanel" aria-label="搜索">
      <SearchPanel />
    </section>
    <section v-show="tab === 'playlists'" class="music-card music-panel" role="tabpanel" aria-label="我的歌单">
      <PlaylistPanel />
    </section>
    <section v-show="tab === 'tasks'" class="music-card music-panel" role="tabpanel" aria-label="任务">
      <TaskPanel />
    </section>
    <section v-show="tab === 'settings'" class="music-card music-panel" role="tabpanel" aria-label="设置">
      <SettingsPanel />
    </section>

    <!-- 最近动作 -->
    <ActivityPanel />

    <footer class="music-foot">
      状态由页面实时读插件 KV 组装 · 任务页有进行中任务时每 5 秒刷新 · 扫码登录每 2 秒轮询 ·
      页面宽度跟随宿主可用宽度
    </footer>

    <Toasts />
  </div>
</template>

<style scoped>
.music-page {
  /* 设计变量：全部从宿主 --app-* 派生，挂在页面根上，子组件继承使用。 */
  --mx-accent: var(--app-accent, #2080f0);
  --mx-gold: color-mix(in srgb, #c9971c 72%, var(--app-text, #1f2329));
  --mx-ok: color-mix(in srgb, #18a058 82%, var(--app-text, #1f2329));
  --mx-err: color-mix(in srgb, #d03050 84%, var(--app-text, #1f2329));
  --mx-warn: color-mix(in srgb, #f0a020 70%, var(--app-text, #1f2329));
  --mx-shadow:
    0 1px 2px color-mix(in srgb, var(--app-text, #000) 5%, transparent),
    0 12px 32px -20px color-mix(in srgb, var(--app-text, #000) 30%, transparent);
  --mx-glow: var(--mx-shadow);

  /* 页面占满内容区并在插件区域内滚动；sticky 相对插件区域生效。 */
  container: music-page / inline-size;
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
  display: grid;
  align-content: start;
  gap: 16px;
  width: 100%;
  min-width: 0;
  padding: 14px 18px 18px;
  background: var(--app-bg, transparent);
  color: var(--app-text, inherit);
}

.music-page--dark {
  --mx-glow:
    0 0 0 1px color-mix(in srgb, var(--mx-accent) 18%, transparent),
    0 18px 50px -18px color-mix(in srgb, var(--mx-accent) 55%, transparent);
}

/* ── 页头 ─────────────────────────────────────── */
.music-head {
  position: relative;
  display: grid;
  gap: 16px;
  padding: 18px 20px;
  border-radius: 20px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--mx-accent) 22%, var(--app-border, #e0e4ea));
  background:
    radial-gradient(110% 150% at 0% 0%, color-mix(in srgb, var(--mx-accent) 24%, transparent), transparent 58%),
    radial-gradient(90% 130% at 100% 0%, color-mix(in srgb, var(--mx-accent) 12%, transparent), transparent 62%),
    color-mix(in srgb, var(--app-surface, #fff) 80%, transparent);
  backdrop-filter: blur(16px) saturate(1.3);
  box-shadow: var(--mx-glow);
}

.music-head::before {
  /* 一道斜向高光，增加玻璃质感 */
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(
    115deg,
    transparent 35%,
    color-mix(in srgb, var(--app-surface, #fff) 30%, transparent) 50%,
    transparent 65%
  );
}

.music-head > * {
  position: relative;
}

.music-head__top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.music-brand {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.music-brand__icon {
  width: 48px;
  height: 48px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  border-radius: 14px;
  background: linear-gradient(
    140deg,
    var(--mx-accent),
    color-mix(in srgb, var(--mx-accent) 60%, var(--app-text, #000))
  );
  box-shadow: 0 8px 22px -8px color-mix(in srgb, var(--mx-accent) 70%, transparent);
}

.music-brand__bar {
  width: 4px;
  height: 22px;
  border-radius: 2px;
  background: color-mix(in srgb, #fff 92%, var(--mx-accent));
  transform-origin: bottom;
  animation: music-eq 1.1s ease-in-out infinite;
}

.music-brand__bar:nth-child(2) {
  animation-delay: -0.35s;
}

.music-brand__bar:nth-child(3) {
  animation-delay: -0.7s;
}

.music-brand__bar:nth-child(4) {
  animation-delay: -0.2s;
}

.music-brand__text {
  min-width: 0;
}

.music-brand__text h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 750;
  letter-spacing: -0.01em;
  background: linear-gradient(
    90deg,
    var(--app-text, #1f2329),
    color-mix(in srgb, var(--mx-accent) 75%, var(--app-text, #1f2329))
  );
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.music-brand__text p {
  margin: 3px 0 0;
  font-size: 13px;
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.72));
}

.music-head__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* ── 卡片 ─────────────────────────────────────── */
.music-card {
  border: 1px solid var(--app-border, #e0e4ea);
  border-radius: 16px;
  background: var(--app-surface, #fff);
  padding: 20px 24px;
  display: grid;
  gap: 14px;
  min-width: 0;
  box-shadow: var(--mx-shadow);
}

@container music-page (max-width: 560px) {
  .music-page {
    padding: 10px;
    gap: 12px;
  }

  .music-head {
    padding: 14px;
  }

  .music-card {
    padding: 14px;
  }

  .music-brand__text p {
    display: none;
  }
}

.music-panel {
  animation: music-panel-in 0.28s ease-out;
}

/* ── 胶囊 Tabs ───────────────────────────────── */
.music-tabs {
  position: sticky;
  top: 0;
  z-index: 5;
  display: grid;
  grid-template-columns: repeat(var(--tab-n), minmax(0, 1fr));
  justify-self: start;
  width: min(100%, 560px);
  padding: 4px;
  border-radius: 999px;
  border: 1px solid var(--app-border, #e0e4ea);
  background: color-mix(in srgb, var(--app-surface, #fff) 82%, transparent);
  backdrop-filter: blur(12px);
  box-shadow: var(--mx-shadow);
}

.music-tabs__pill {
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 4px;
  width: calc((100% - 8px) / var(--tab-n));
  border-radius: 999px;
  background: linear-gradient(
    135deg,
    var(--mx-accent),
    color-mix(in srgb, var(--mx-accent) 72%, var(--app-text, #000))
  );
  box-shadow: 0 6px 18px -6px color-mix(in srgb, var(--mx-accent) 75%, transparent);
  transform: translateX(calc(var(--tab-i) * 100%));
  transition: transform 0.38s cubic-bezier(0.34, 1.36, 0.5, 1);
}

.music-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 0;
  border: none;
  border-radius: 999px;
  background: none;
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.6));
  padding: 8px 10px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.2s ease;
}

.music-tab:hover {
  color: var(--app-text, inherit);
}

.music-tab:focus-visible {
  outline: 2px solid var(--mx-accent);
  outline-offset: 2px;
}

.music-tab--on,
.music-tab--on:hover {
  color: #fff;
  font-weight: 600;
}

.music-tab__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@container music-page (max-width: 420px) {
  .music-tab__text {
    display: none;
  }
}

.music-tab__badge {
  display: inline-flex;
  min-width: 18px;
  justify-content: center;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;
  background: var(--mx-err);
  color: #fff;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--app-surface, #fff) 80%, transparent);
}

.music-foot {
  font-size: 11px;
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.4));
  text-align: center;
  padding: 4px 0 8px;
}

@keyframes music-eq {
  0%,
  100% {
    transform: scaleY(0.35);
  }
  50% {
    transform: scaleY(1);
  }
}

@keyframes music-panel-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .music-brand__bar,
  .music-panel {
    animation: none;
  }

  .music-brand__bar {
    transform: scaleY(0.7);
  }

  .music-tabs__pill,
  .music-tab {
    transition: none;
  }
}
</style>
