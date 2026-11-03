<script setup lang="ts">
// 页头统计：进行中 / 排队中 / 已完成 / 失败（按完整任务索引计数，数字滚动呈现）。

import { computed } from 'vue'
import {
  CircleAlert as FailIcon,
  CircleCheck as DoneIcon,
  Clock3 as QueueIcon,
  Disc3 as ActiveIcon,
} from '@lucide/vue'
import { useMusicStore } from '../store'
import { useReady } from '../ui-kit'
import CountUp from './CountUp.vue'
import Skeleton from './Skeleton.vue'

const emit = defineEmits<{ (event: 'open'): void }>()

const store = useMusicStore()
const { allTasks } = store
const ready = useReady()

function count(...statuses: string[]): number {
  return allTasks.value.filter((task) => statuses.includes(task.status)).length
}

const tiles = computed(() => [
  { key: 'active', label: '进行中', value: count('downloading', 'copying'), icon: ActiveIcon },
  { key: 'queued', label: '排队中', value: count('queued'), icon: QueueIcon },
  { key: 'done', label: '已完成', value: count('done'), icon: DoneIcon },
  { key: 'failed', label: '失败', value: count('failed'), icon: FailIcon },
])
</script>

<template>
  <Skeleton v-if="!ready" variant="tile" :count="4" class="stats" />
  <div v-else class="stats">
    <button
      v-for="tile in tiles"
      :key="tile.key"
      type="button"
      class="stat"
      :class="[`stat--${tile.key}`, { 'stat--live': tile.value > 0 }]"
      :aria-label="`${tile.label} ${tile.value} 条，查看任务`"
      @click="emit('open')"
    >
      <span class="stat__icon"><component :is="tile.icon" :size="16" aria-hidden="true" /></span>
      <span class="stat__num" aria-hidden="true"><CountUp :value="tile.value" /></span>
      <span class="stat__label" aria-hidden="true">{{ tile.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

@container music-page (max-width: 560px) {
  .stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.stat {
  --tone: var(--app-text-secondary, #6b7280);
  position: relative;
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-areas:
    'icon num'
    'icon label';
  column-gap: 10px;
  align-items: center;
  text-align: left;
  padding: 10px 14px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--tone) 16%, var(--app-border, #e0e4ea));
  background: color-mix(in srgb, var(--app-surface, #fff) 62%, transparent);
  color: var(--app-text, inherit);
  cursor: pointer;
  overflow: hidden;
  transition:
    transform 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

.stat:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--tone) 45%, transparent);
  box-shadow: 0 10px 24px -16px var(--tone);
}

.stat:focus-visible {
  outline: 2px solid var(--mx-accent, #2080f0);
  outline-offset: 2px;
}

.stat--active {
  --tone: var(--mx-accent, var(--app-accent, #2080f0));
}

.stat--queued {
  --tone: color-mix(in srgb, var(--mx-accent, #2080f0) 55%, var(--app-text-secondary, #6b7280));
}

.stat--done {
  --tone: var(--mx-ok, #18a058);
}

.stat--failed {
  --tone: var(--mx-err, #d03050);
}

.stat__icon {
  grid-area: icon;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  color: var(--tone);
  background: color-mix(in srgb, var(--tone) 14%, transparent);
}

.stat--active.stat--live .stat__icon :deep(svg) {
  animation: stat-spin 2.4s linear infinite;
}

.stat__num {
  grid-area: num;
  font-size: 22px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.02em;
}

.stat--live .stat__num {
  color: var(--tone);
}

.stat__label {
  grid-area: label;
  font-size: 12px;
  color: var(--app-text-secondary, #6b7280);
}

@keyframes stat-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .stat {
    transition: none;
  }

  .stat:hover {
    transform: none;
  }

  .stat--active.stat--live .stat__icon :deep(svg) {
    animation: none;
  }
}
</style>
