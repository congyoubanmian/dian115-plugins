<script setup lang="ts">
// 指标瓦片（对应原生版的 db-tile）：图标 + 标签 + 数字（数值变化时滚动计数）+ 说明。
// 数据尚未读完时显示骨架微光。减少动态效果时数字直接跳到终值。

import { onBeforeUnmount, ref, watch, type Component } from 'vue'
import { prefersReducedMotion } from '../motion'
import SkeletonBlock from './SkeletonBlock.vue'

const props = withDefaults(
  defineProps<{
    label: string
    value: string
    hint?: string
    icon?: Component
    tone?: string
    loading?: boolean
  }>(),
  { tone: 'accent', loading: false },
)

const COUNT_MS = 700

const shown = ref(props.value)
let frame = 0

function stop(): void {
  if (frame) cancelAnimationFrame(frame)
  frame = 0
}

function animateTo(next: string, prev: string): void {
  stop()
  const to = Number(next)
  const from = Number(prev)
  if (!/^\d+$/.test(next) || !Number.isFinite(from) || from === to || prefersReducedMotion()) {
    shown.value = next
    return
  }
  const start = performance.now()
  const step = (now: number): void => {
    const t = Math.min(1, (now - start) / COUNT_MS)
    const eased = 1 - (1 - t) ** 3
    shown.value = String(Math.round(from + (to - from) * eased))
    frame = t < 1 ? requestAnimationFrame(step) : 0
  }
  frame = requestAnimationFrame(step)
}

// 首次读完数据（loading → false）时从 0 滚上去；之后数值变化从旧值滚到新值。
watch(
  () => [props.value, props.loading] as const,
  ([next, loading], old) => {
    if (loading) return
    const prev = old && !old[1] ? old[0] : '0'
    animateTo(next, prev)
  },
)

onBeforeUnmount(stop)
</script>

<template>
  <div class="db-tile" :class="`db-tile--${props.tone}`">
    <span v-if="props.icon" class="db-tile__icon" aria-hidden="true">
      <component :is="props.icon" :size="16" />
    </span>
    <span class="db-tile__label">{{ label }}</span>
    <template v-if="props.loading">
      <SkeletonBlock width="56%" height="26px" radius="8px" />
      <SkeletonBlock width="80%" height="10px" />
    </template>
    <template v-else>
      <strong class="db-tile__value" :aria-label="value">{{ shown }}</strong>
      <span class="db-tile__hint">{{ hint }}</span>
    </template>
  </div>
</template>

<style scoped>
.db-tile {
  --tone: var(--db-accent, #2080f0);
  position: relative;
  display: grid;
  gap: 3px;
  align-content: start;
  padding: 13px 14px 12px;
  border-radius: 14px;
  background:
    radial-gradient(120% 90% at 100% 0%, color-mix(in srgb, var(--tone) 12%, transparent), transparent 60%),
    var(--app-surface, #fff);
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  min-width: 0;
  overflow: hidden;
  transition:
    transform 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

.db-tile::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: linear-gradient(180deg, var(--tone), color-mix(in srgb, var(--tone) 20%, transparent));
}

.db-tile:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--tone) 45%, var(--db-line, var(--app-border, #e3e6eb)));
  box-shadow: 0 10px 24px -14px color-mix(in srgb, var(--tone) 55%, transparent);
}

.db-tile--ok {
  --tone: var(--db-ok, #18a058);
}

.db-tile--warn {
  --tone: var(--db-warn, #f0a020);
}

.db-tile--error {
  --tone: var(--db-err, #d03050);
}

.db-tile--muted {
  --tone: var(--db-muted, var(--app-text-secondary, #6b7280));
}

.db-tile--alt {
  --tone: var(--db-accent-2, var(--db-accent, #2080f0));
}

.db-tile__icon {
  position: absolute;
  top: 11px;
  right: 11px;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  color: var(--tone);
  background: color-mix(in srgb, var(--tone) 13%, transparent);
}

.db-tile__label {
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 12px;
  padding-right: 34px;
}

.db-tile__value {
  font-size: 26px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
  letter-spacing: -0.01em;
  color: var(--app-text, #1f2329);
}

.db-tile__hint {
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 11px;
  overflow-wrap: anywhere;
}

@media (prefers-reduced-motion: reduce) {
  .db-tile {
    transition: none;
  }

  .db-tile:hover {
    transform: none;
  }
}
</style>
