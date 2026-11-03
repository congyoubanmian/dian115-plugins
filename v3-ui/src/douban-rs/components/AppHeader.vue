<script setup lang="ts">
// 页头：品牌 + 状态胶囊 + 动作组（对应原生版的 db3-head）。
// 胶囊与原生版一致：榜单时间、队列/想看条数（有到期条目时变警示色）。
// 结构交给 shared PageHeader：背景/边框/阴影/光斑仍由本文件的 .db-head 提供。

import { computed } from 'vue'
import { NButton } from 'naive-ui'
import { Film, RefreshCw, RotateCw, Settings } from '@lucide/vue'
import { formatTime } from '../format'
import { useDoubanStore } from '../store'
import PageHeader from '../../shared/components/PageHeader.vue'

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
  <PageHeader
    class="db-head"
    title="豆瓣中心"
    subtitle="榜单抓取 · 黑名单过滤 · 观察队列 · 我的想看 · 聚合订阅"
    :heading-level="1"
    sticky
    hide-capsules-on-compact
  >
    <template #icon>
      <Film :size="22" aria-hidden="true" />
    </template>

    <template #capsules>
      <span class="db-capsule" :class="`db-capsule--${snapshotTone}`">
        <span class="db-capsule__dot" aria-hidden="true" />{{ snapshotLabel }}
      </span>
      <span class="db-capsule" :class="`db-capsule--${queueTone}`">
        <span class="db-capsule__dot" aria-hidden="true" />{{ queueLabel }}
      </span>
    </template>

    <template #actions>
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
    </template>

    <template #art>
      <span class="db-head__aura" aria-hidden="true" />
    </template>
  </PageHeader>
</template>

<style scoped>
/* 网格 / sticky / compact / 内边距 / 圆角由 shared PageHeader 负责，这里只保留皮肤。 */
.db-head {
  --ui-head-padding: 14px 16px;
  --ui-head-padding-compact: 12px;
  --ui-head-radius: 18px;
  --ui-head-margin-bottom: 14px;

  border: 1px solid color-mix(in srgb, var(--db-accent, #2080f0) 22%, var(--db-line, var(--ui-border, #e3e6eb)));
  background:
    linear-gradient(
      120deg,
      color-mix(in srgb, var(--db-accent, #2080f0) 14%, transparent),
      color-mix(in srgb, var(--db-accent-2, var(--db-accent, #2080f0)) 10%, transparent) 55%,
      transparent
    ),
    color-mix(in srgb, var(--ui-surface, var(--app-surface, #fff)) 78%, transparent);
  backdrop-filter: blur(14px) saturate(1.3);
  box-shadow: 0 10px 30px -22px color-mix(in srgb, var(--ui-text, var(--app-text, #1f2329)) 60%, transparent);
}

/* 共享页头的品牌皮肤：沿用豆瓣原来的图标尺寸与标题字距。 */
.db-head.db-head :deep(.ui-head__icon) {
  width: 44px;
  height: 44px;
  border-radius: 13px;
}

.db-head.db-head :deep(.ui-head__title) {
  font-size: 21px;
  letter-spacing: 0.02em;
}

.db-head.db-head :deep(.ui-head__sub) {
  font-size: 12px;
}

/* 缓慢漂移的光斑：给玻璃页头一点景深；减少动态效果时静止。 */
.db-head__aura {
  position: absolute;
  z-index: -1;
  inset: -60% -10% auto auto;
  width: min(280px, 72%);
  height: auto;
  aspect-ratio: 1;
  width: clamp(160px, 46cqw, 280px);
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

.db-root--dark .db-head :deep(.ui-head__icon) {
  color: var(--ui-text, var(--app-text, #fff));
  box-shadow:
    0 0 22px color-mix(in srgb, var(--db-accent, #2080f0) 55%, transparent),
    inset 0 1px 0 color-mix(in srgb, var(--ui-text, var(--app-text, #fff)) 25%, transparent);
}

.db-root--dark .db-head__aura {
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--db-accent-2, var(--db-accent, #2080f0)) 38%, transparent),
    transparent 65%
  );
}

.db-capsule {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--db-line, var(--ui-border, #e3e6eb));
  background: color-mix(in srgb, var(--ui-surface, var(--app-surface, #fff)) 60%, transparent);
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
  color: var(--db-muted, var(--ui-muted, #6b7280));
}

.db-capsule--ok {
  color: var(--db-ok, var(--ui-ok, #18a058));
  border-color: color-mix(in srgb, var(--db-ok, var(--ui-ok, #18a058)) 40%, transparent);
  background: color-mix(in srgb, var(--db-ok, var(--ui-ok, #18a058)) 10%, transparent);
}

.db-capsule--warn {
  color: var(--db-warn, var(--ui-warn, #f0a020));
  border-color: color-mix(in srgb, var(--db-warn, var(--ui-warn, #f0a020)) 45%, transparent);
  background: color-mix(in srgb, var(--db-warn, var(--ui-warn, #f0a020)) 10%, transparent);
}

.db-capsule--warn .db-capsule__dot {
  animation: db-pulse 1.8s ease-in-out infinite;
}

@keyframes db-pulse {
  50% {
    box-shadow: 0 0 0 6px color-mix(in srgb, currentColor 0%, transparent);
  }
}

@container page (max-width: 719.98px) {
  .db-head__aura {
    top: -40%;
    right: -6%;
    animation: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .db-head__aura,
  .db-capsule--warn .db-capsule__dot {
    animation: none;
  }
}
</style>
