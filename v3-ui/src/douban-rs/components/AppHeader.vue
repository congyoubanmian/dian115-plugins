<script setup lang="ts">
// 页头：品牌 + 状态胶囊 + 动作组（对应原生版的 db3-head）。
// 胶囊与原生版一致：榜单时间、队列/想看条数（有到期条目时变警示色）。

import { computed } from 'vue'
import { NButton } from 'naive-ui'
import { Film, RefreshCw, RotateCw, Settings } from '@lucide/vue'
import { formatTime } from '../format'
import { useDoubanStore } from '../store'

const store = useDoubanStore()
const { busy, stateDoc, rawState, queueItems, wishItems, dueItems } = store

const snapshotAt = computed(() => {
  const fromState = stateDoc.value?.snapshot?.fetched_at
  if (fromState) return String(fromState)
  const lastRun = rawState.value?.last_run
  return typeof lastRun === 'string' ? lastRun : ''
})

const snapshotLabel = computed(() =>
  snapshotAt.value ? `榜单 · ${formatTime(snapshotAt.value)}` : '榜单 · 未刷新',
)
const snapshotTone = computed(() => (snapshotAt.value ? 'ok' : 'muted'))

const queueLabel = computed(() => `队列 ${queueItems.value.length} · 想看 ${wishItems.value.length}`)
const queueTone = computed(() => (dueItems.value.length > 0 ? 'warn' : 'muted'))

const locked = computed(() => busy.value !== '')
</script>

<template>
  <header class="db-head">
    <div class="db-brand">
      <span class="db-brand__icon">
        <Film :size="22" aria-hidden="true" />
      </span>
      <div class="db-brand__text">
        <h1 class="db-brand__title">豆瓣中心</h1>
        <p class="db-brand__sub">榜单抓取 · 黑名单过滤 · 观察队列 · 我的想看 · 聚合订阅</p>
      </div>
    </div>

    <div class="db-actions">
      <span class="db-capsule" :class="`db-capsule--${snapshotTone}`">{{ snapshotLabel }}</span>
      <span class="db-capsule" :class="`db-capsule--${queueTone}`">{{ queueLabel }}</span>
      <NButton
        size="small"
        type="primary"
        :disabled="locked"
        data-busy-lock="1"
        @click="store.runAction('refresh', {})"
      >
        <template #icon>
          <RefreshCw :size="14" aria-hidden="true" />
        </template>
        刷新榜单
      </NButton>
      <NButton
        size="small"
        secondary
        :disabled="locked"
        data-busy-lock="1"
        @click="store.runAction('wish-sync-now', {})"
      >
        同步想看
      </NButton>
      <NButton
        size="small"
        quaternary
        :disabled="locked"
        data-busy-lock="1"
        @click="store.refreshUi()"
      >
        <template #icon>
          <RotateCw :size="14" aria-hidden="true" />
        </template>
        重读
      </NButton>
      <NButton
        size="small"
        quaternary
        :disabled="locked"
        data-busy-lock="1"
        @click="store.showTab('settings')"
      >
        <template #icon>
          <Settings :size="14" aria-hidden="true" />
        </template>
        设置
      </NButton>
    </div>
  </header>
</template>

<style scoped>
.db-head {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 10px 0 14px;
  background: color-mix(in srgb, var(--app-bg, #f5f6f8) 88%, transparent);
  backdrop-filter: blur(12px);
}

.db-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.db-brand__icon {
  width: 42px;
  height: 42px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 12px;
  color: #fff;
  background: linear-gradient(135deg, var(--db-accent, #2080f0), #7c5cfc);
  box-shadow: 0 6px 18px color-mix(in srgb, var(--db-accent, #2080f0) 30%, transparent);
}

.db-brand__text {
  min-width: 0;
}

.db-brand__title {
  font-size: 20px;
  font-weight: 650;
  letter-spacing: 0.01em;
  margin: 0;
  color: var(--app-text, #1f2329);
}

.db-brand__sub {
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 12px;
  margin: 2px 0 0;
}

.db-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.db-capsule {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  font-size: 12px;
  white-space: nowrap;
}

.db-capsule--muted {
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
}

.db-capsule--ok {
  color: var(--db-ok, #18a058);
  border-color: color-mix(in srgb, var(--db-ok, #18a058) 40%, transparent);
  background: color-mix(in srgb, var(--db-ok, #18a058) 10%, transparent);
}

.db-capsule--warn {
  color: var(--db-warn, #f0a020);
  border-color: color-mix(in srgb, var(--db-warn, #f0a020) 45%, transparent);
  background: color-mix(in srgb, var(--db-warn, #f0a020) 10%, transparent);
}

@media (max-width: 720px) {
  .db-head {
    position: static;
  }

  .db-actions {
    width: 100%;
  }

  .db-capsule {
    display: none;
  }
}
</style>
