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
    <span class="db-head__aura" aria-hidden="true" />
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
      <span class="db-capsule" :class="`db-capsule--${snapshotTone}`">
        <span class="db-capsule__dot" aria-hidden="true" />{{ snapshotLabel }}
      </span>
      <span class="db-capsule" :class="`db-capsule--${queueTone}`">
        <span class="db-capsule__dot" aria-hidden="true" />{{ queueLabel }}
      </span>
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
  top: 8px;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px 16px;
  flex-wrap: wrap;
  margin-bottom: 14px;
  padding: 14px 16px;
  border-radius: 18px;
  overflow: hidden;
  isolation: isolate;
  border: 1px solid color-mix(in srgb, var(--db-accent, #2080f0) 22%, var(--db-line, var(--app-border, #e3e6eb)));
  background:
    linear-gradient(
      120deg,
      color-mix(in srgb, var(--db-accent, #2080f0) 14%, transparent),
      color-mix(in srgb, var(--db-accent-2, var(--db-accent, #2080f0)) 10%, transparent) 55%,
      transparent
    ),
    color-mix(in srgb, var(--app-surface, #fff) 78%, transparent);
  backdrop-filter: blur(14px) saturate(1.3);
  box-shadow: 0 10px 30px -22px color-mix(in srgb, var(--app-text, #1f2329) 60%, transparent);
}

/* 缓慢漂移的光斑：给玻璃页头一点景深；减少动态效果时静止。 */
.db-head__aura {
  position: absolute;
  z-index: -1;
  inset: -60% -10% auto auto;
  width: 280px;
  height: 280px;
  border-radius: 50%;
  pointer-events: none;
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--db-accent-2, var(--db-accent, #2080f0)) 26%, transparent),
    transparent 65%
  );
  animation: db-aura 14s ease-in-out infinite alternate;
}

@keyframes db-aura {
  to {
    transform: translate(-120px, 40px) scale(1.15);
  }
}

.db-root--dark .db-head {
  border-color: color-mix(in srgb, var(--db-accent, #2080f0) 35%, transparent);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--db-accent, #2080f0) 10%, transparent) inset,
    0 12px 40px -18px color-mix(in srgb, var(--db-accent, #2080f0) 55%, transparent);
}

.db-root--dark .db-head__aura {
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--db-accent-2, var(--db-accent, #2080f0)) 38%, transparent),
    transparent 65%
  );
}

.db-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.db-brand__icon {
  width: 44px;
  height: 44px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 13px;
  color: var(--app-surface, #fff);
  background: linear-gradient(135deg, var(--db-accent, #2080f0), var(--db-accent-2, var(--db-accent, #2080f0)));
  box-shadow:
    0 8px 22px -6px color-mix(in srgb, var(--db-accent, #2080f0) 60%, transparent),
    inset 0 1px 0 color-mix(in srgb, var(--app-surface, #fff) 35%, transparent);
}

.db-root--dark .db-brand__icon {
  color: var(--app-text, #fff);
  box-shadow:
    0 0 22px color-mix(in srgb, var(--db-accent, #2080f0) 55%, transparent),
    inset 0 1px 0 color-mix(in srgb, var(--app-text, #fff) 25%, transparent);
}

.db-brand__text {
  min-width: 0;
}

.db-brand__title {
  font-size: 21px;
  font-weight: 750;
  letter-spacing: 0.02em;
  margin: 0;
  color: var(--app-text, #1f2329);
}

@supports ((-webkit-background-clip: text) or (background-clip: text)) {
  .db-brand__title {
    background: linear-gradient(
      100deg,
      var(--app-text, #1f2329) 30%,
      color-mix(in srgb, var(--db-accent, #2080f0) 75%, var(--app-text, #1f2329))
    );
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
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
  gap: 6px;
  min-height: 28px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  background: color-mix(in srgb, var(--app-surface, #fff) 60%, transparent);
  font-size: 12px;
  white-space: nowrap;
}

.db-capsule__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 20%, transparent);
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

.db-capsule--warn .db-capsule__dot {
  animation: db-pulse 1.8s ease-in-out infinite;
}

@keyframes db-pulse {
  50% {
    box-shadow: 0 0 0 6px color-mix(in srgb, currentColor 0%, transparent);
  }
}

@container db-page (max-width: 720px) {
  .db-head {
    position: static;
    padding: 12px;
  }

  .db-actions {
    width: 100%;
  }

  .db-capsule {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .db-head__aura,
  .db-capsule--warn .db-capsule__dot {
    animation: none;
  }
}
</style>
