<script setup lang="ts">
// 音乐下载（music.rs）页面 —— Vue 3 版。
//
// 结构与行为对齐改写前的原生 JS 版（v3-ui/legacy/music-rs/page.js）：
// 页头（登录状态胶囊 + 手动 Cookie + 刷新 + ⚙）→ 登录卡（QR + stepper + 其他登录方式 +
// 音质档位）→ 下划线式 Tabs（搜索 / 我的歌单 / 任务 / 设置）→ 最近动作 → 页脚。
//
// 数据与能力只走 ctx（store.ts 装配）：ctx.storage / ctx.settings / ctx.tasks / ctx.http /
// ctx.cookiecloud / ctx.notify；主题由 shared/mount.ts 接到 naive-ui 的 n-config-provider。
// 页面不直接 fetch 宿主业务接口，也不自建 WebSocket。

import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { NButton, NTag } from 'naive-ui'
import {
  Cookie as CookieIcon,
  Music as MusicIcon,
  RefreshCw as RefreshIcon,
  Settings as SettingsIcon,
} from '@lucide/vue'
import { useCtx } from '../shared/use-ctx'
import { createMusicStore, MUSIC_STORE_KEY } from './store'
import LoginCard from './components/LoginCard.vue'
import SearchPanel from './components/SearchPanel.vue'
import PlaylistPanel from './components/PlaylistPanel.vue'
import TaskPanel from './components/TaskPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import ActivityPanel from './components/ActivityPanel.vue'
import Toasts from './components/Toasts.vue'

type TabId = 'search' | 'playlists' | 'tasks' | 'settings'

const TABS: Array<{ id: TabId; text: string }> = [
  { id: 'search', text: '搜索' },
  { id: 'playlists', text: '我的歌单' },
  { id: 'tasks', text: '任务' },
  { id: 'settings', text: '设置' },
]

const ctx = useCtx()
const store = createMusicStore(ctx)
provide(MUSIC_STORE_KEY, store)

const { login, loginSource, pendingTasks, busy, loading, playlists, playlistView } = store

const tab = ref<TabId>('search')
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
})
</script>

<template>
  <div class="music-page">
    <!-- 页头：图标瓦片 + 标题 | 登录胶囊 + 手动 Cookie + 刷新 + ⚙ -->
    <header class="music-head">
      <div class="music-brand">
        <span class="music-brand__icon"><MusicIcon :size="22" aria-hidden="true" /></span>
        <div class="music-brand__text">
          <h1>音乐下载</h1>
          <p>扫码登录网易云 / QQ 音乐 · 下载至 115 网盘 · 队列自动推进</p>
        </div>
      </div>
      <div class="music-head__actions">
        <NTag size="small" :bordered="false" :type="headLogin.logged_in ? 'success' : 'warning'">
          {{ headLogin.logged_in ? '已登录' : '未登录' }} · {{ store.sourceName(loginSource) }}
        </NTag>
        <NButton size="small" secondary @click="openCookiePanel">
          <template #icon><CookieIcon :size="14" /></template>
          手动 Cookie
        </NButton>
        <NButton size="small" quaternary circle :loading="loading" title="刷新状态" @click="store.refresh()">
          <template #icon><RefreshIcon :size="15" /></template>
        </NButton>
        <NButton size="small" quaternary circle title="设置" @click="switchTab('settings')">
          <template #icon><SettingsIcon :size="16" /></template>
        </NButton>
      </div>
    </header>

    <!-- 登录卡：左 QR 白底卡 | 右 stepper + 其他登录方式 + 音质档位 -->
    <section ref="loginCardRef" class="music-card music-login">
      <LoginCard />
    </section>

    <!-- 下划线式 Tabs -->
    <nav class="music-tabs">
      <button
        v-for="item in TABS"
        :key="item.id"
        type="button"
        class="music-tab"
        :class="{ 'music-tab--on': tab === item.id }"
        @click="switchTab(item.id)"
      >
        {{ item.text }}
        <span v-if="item.id === 'tasks' && pendingTasks.length" class="music-tab__badge">
          {{ pendingTasks.length }}
        </span>
      </button>
    </nav>

    <!-- 各分页 -->
    <section v-show="tab === 'search'" class="music-card">
      <SearchPanel />
    </section>
    <section v-show="tab === 'playlists'" class="music-card">
      <PlaylistPanel />
    </section>
    <section v-show="tab === 'tasks'" class="music-card">
      <TaskPanel />
    </section>
    <section v-show="tab === 'settings'" class="music-card">
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
  /* 页面占满内容区并在插件区域内滚动；sticky 相对插件区域生效。 */
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
  display: grid;
  gap: 16px;
  width: 100%;
  min-width: 0;
  padding: 12px 16px 16px;
  background: var(--app-bg, transparent);
  color: var(--app-text, inherit);
}

.music-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.music-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.music-brand__icon {
  width: 44px;
  height: 44px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  color: var(--app-accent, #2080f0);
  background: color-mix(in srgb, var(--app-accent, #2080f0) 11%, transparent);
}

.music-brand__text h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.music-brand__text p {
  margin: 2px 0 0;
  font-size: 13px;
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.72));
}

.music-head__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.music-card {
  border: 1px solid var(--app-border, #e0e4ea);
  border-radius: 12px;
  background: var(--app-surface, #fff);
  padding: 20px 24px;
  display: grid;
  gap: 12px;
  min-width: 0;
}

.music-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--app-border, #e0e4ea);
}

.music-tab {
  position: relative;
  border: none;
  background: none;
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.6));
  padding: 10px 16px;
  font-size: 14px;
  cursor: pointer;
}

.music-tab--on {
  color: var(--app-accent, #2080f0);
  font-weight: 600;
}

.music-tab--on::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: -1px;
  height: 2px;
  background: var(--app-accent, #2080f0);
  border-radius: 2px;
}

.music-tab__badge {
  display: inline-flex;
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  background: #d03050;
  color: #fff;
}

.music-foot {
  font-size: 11px;
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.4));
  text-align: center;
  padding: 4px 0 8px;
}
</style>
