<script setup lang="ts">
// 共享统计卡：内置 0 → 终值滚动、骨架占位、占比环与迷你折线。
//
// 三种皮肤通过 variant 选择，DOM 类名与迁移前的插件实现兼容：
// - bento：chase-rs 的 .tile / .tile-<tone> / .tile-k-<key> / .tile-top /
//   .tile-label / .tile-value / .tile-share / .spark（基础布局仍由 chase styles.css 提供）；
// - card：douban-rs 的 .db-tile / .db-tile--<tone> / .db-tile__icon|label|value|hint；
// - stat：music-rs 的 .stat / .stat--<tone> / .stat--<key> / .stat--live /
//   .stat__icon / .stat__num / .stat__label。
//
// interactive 时根元素渲染为 <button> 并 emit select；否则是普通 div。
// 数字动画只改展示值，不改业务传入的 value。

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Component } from 'vue'
import type { UiTone } from './types'
import SkeletonBlock from './SkeletonBlock.vue'
import Sparkline from './Sparkline.vue'

const props = withDefaults(
  defineProps<{
    label: string
    value: number | string
    hint?: string
    icon?: Component
    tone?: UiTone
    loading?: boolean
    /** 迷你折线数据（少于 2 个点不渲染）。 */
    series?: number[]
    seriesLabel?: string
    /** 占比环：part / whole（例如已判定 / 订阅池）。 */
    share?: { part: number; whole: number; label: string }
    index?: number
    /** bento 的 tile-k-* / stat 的 stat--* 兼容键；缺省不输出。 */
    tileKey?: string
    interactive?: boolean
    /** 音乐页“进行中”状态：数字着色，active 图标旋转。 */
    live?: boolean
    ariaLabel?: string
    variant?: 'card' | 'bento' | 'stat'
  }>(),
  {
    tone: 'default',
    loading: false,
    index: 0,
    interactive: false,
    live: false,
    variant: 'card',
  },
)

const emit = defineEmits<{ (event: 'select'): void }>()

const COUNT_MS = 700

function prefersReducedMotion(): boolean {
  const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia
  return typeof mm === 'function' && mm('(prefers-reduced-motion: reduce)').matches === true
}

/** 只把纯数字（number 或整数字符串）做滚动；其他字符串原样显示。 */
function toNumber(value: number | string): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const trimmed = value.trim()
  return /^-?\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : null
}

const shown = ref('0')
let frame = 0

function stop(): void {
  const caf = (globalThis as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame
  if (frame && typeof caf === 'function') caf(frame)
  frame = 0
}

function animateTo(next: number | string, from: number): void {
  stop()
  const target = toNumber(next)
  const raf = (globalThis as { requestAnimationFrame?: (cb: (time: number) => void) => number }).requestAnimationFrame
  if (target === null || target === from || prefersReducedMotion() || typeof raf !== 'function') {
    shown.value = String(next)
    return
  }
  let start = -1
  const step = (now: number): void => {
    // 用 rAF 自己的时间戳做起点（与 performance.now 同一时基），
    // 不能混用 Date.now()，否则首帧时间差会是负数、动画永远结束不了。
    if (start < 0) start = now
    const t = Math.min(1, (now - start) / COUNT_MS)
    if (t >= 1) {
      shown.value = String(next)
      frame = 0
      return
    }
    const eased = 1 - Math.pow(1 - t, 3)
    shown.value = String(Math.round(from + (target - from) * eased))
    frame = raf(step)
  }
  frame = raf(step)
}

let started = false
// 首次读完数据（loading → false）从 0 滚到终值；之后数值变化从当前显示值滚到新值。
watch(
  () => [props.value, props.loading] as const,
  ([next, loading], old) => {
    if (loading) return
    const fromCurrent = old !== undefined && !old[1] && started
    const from = fromCurrent ? (toNumber(shown.value) ?? 0) : 0
    started = true
    animateTo(next, from)
  },
  { immediate: true },
)

onBeforeUnmount(stop)

const sharePct = computed(() => {
  const s = props.share
  if (!s || s.whole <= 0) return -1
  return Math.max(0, Math.min(100, Math.round((s.part / s.whole) * 100)))
})

const normalizedTone = computed(() => {
  switch (props.tone) {
    case 'primary':
    case 'accent':
      return 'accent'
    case 'success':
    case 'ok':
      return 'ok'
    case 'warning':
    case 'warn':
      return 'warn'
    case 'error':
      return 'error'
    case 'muted':
      return 'muted'
    case 'alt':
      return 'alt'
    default:
      return 'default'
  }
})

const bentoTone = computed(() => {
  switch (normalizedTone.value) {
    case 'accent':
      return 'primary'
    case 'ok':
      return 'success'
    case 'warn':
      return 'warning'
    case 'error':
      return 'error'
    default:
      return 'default'
  }
})

const cardTone = computed(() => {
  switch (normalizedTone.value) {
    case 'ok':
      return 'ok'
    case 'warn':
      return 'warn'
    case 'error':
      return 'error'
    case 'muted':
      return 'muted'
    case 'alt':
      return 'alt'
    default:
      return 'accent'
  }
})

const rootClass = computed(() => {
  const classes = ['ui-tile', `ui-tile--${props.variant}`]
  if (props.variant === 'bento') {
    classes.push('tile', `tile-${bentoTone.value}`)
    // chase 的网格钩子是 tile-k-*（不是 --k-*），SkeletonPage 依赖同一套类名。
    if (props.tileKey) classes.push(`tile-k-${props.tileKey}`)
  } else if (props.variant === 'card') {
    classes.push('db-tile', `db-tile--${cardTone.value}`)
  } else {
    classes.push('stat', `stat--${normalizedTone.value}`)
    if (props.tileKey) classes.push(`stat--${props.tileKey}`)
    if (props.live) classes.push('stat--live')
  }
  return classes
})

const rootStyle = computed<Record<string, string | number>>(() => ({ '--i': props.index }))
const rootTag = computed(() => (props.interactive ? 'button' : 'div'))
const rootLabel = computed(() => {
  if (!props.interactive) return undefined
  if (props.ariaLabel) return props.ariaLabel
  // music-rs 原有的读屏文案带「条，查看任务」；stat 皮肤保持这个默认。
  if (props.variant === 'stat') return `${props.label} ${props.value} 条，查看任务`
  return `${props.label} ${props.value}`
})

function onActivate(): void {
  if (props.interactive) emit('select')
}
</script>

<template>
  <component
    :is="rootTag"
    :class="rootClass"
    :style="rootStyle"
    :type="interactive ? 'button' : undefined"
    :aria-label="rootLabel"
    :aria-busy="loading || undefined"
    @click="onActivate"
  >
    <!-- bento：追剧管家的瓦片结构，样式钩子全部沿用 -->
    <template v-if="variant === 'bento'">
      <div class="tile-top">
        <div class="tile-label">{{ label }}</div>
        <div class="tile-value">
          <SkeletonBlock v-if="loading" width="56%" height="26px" radius="8px" />
          <template v-else>
            <span aria-hidden="true">{{ shown }}</span>
            <span class="sr-only">{{ value }}</span>
          </template>
        </div>
      </div>
      <div v-if="sharePct >= 0 && share" class="tile-share">
        <svg
          viewBox="0 0 40 40"
          class="tile-share-ring"
          role="img"
          :aria-label="`${share.label} ${sharePct}%`"
        >
          <circle class="ring-track" cx="20" cy="20" r="16" pathLength="100" />
          <circle
            class="ring-have"
            cx="20"
            cy="20"
            r="16"
            pathLength="100"
            :style="{ strokeDasharray: `${sharePct} 100` }"
          />
        </svg>
        <span class="tile-share-text"><b>{{ sharePct }}%</b> {{ share.label }}</span>
      </div>
      <Sparkline v-if="series && series.length > 1" :series="series" :label="seriesLabel ?? label" />
    </template>

    <!-- card：豆瓣中心的指标卡 -->
    <template v-else-if="variant === 'card'">
      <span v-if="icon" class="db-tile__icon" aria-hidden="true">
        <component :is="icon" :size="16" />
      </span>
      <span class="db-tile__label">{{ label }}</span>
      <template v-if="loading">
        <SkeletonBlock width="56%" height="26px" radius="8px" />
        <SkeletonBlock width="80%" height="10px" />
      </template>
      <template v-else>
        <strong class="db-tile__value" :aria-label="String(value)">{{ shown }}</strong>
        <span class="db-tile__hint">{{ hint }}</span>
        <div v-if="sharePct >= 0 && share" class="ui-tile__share">
          <svg
            viewBox="0 0 40 40"
            class="ui-tile__share-ring"
            role="img"
            :aria-label="`${share.label} ${sharePct}%`"
          >
            <circle class="ring-track" cx="20" cy="20" r="16" pathLength="100" />
            <circle
              class="ring-have"
              cx="20"
              cy="20"
              r="16"
              pathLength="100"
              :style="{ strokeDasharray: `${sharePct} 100` }"
            />
          </svg>
          <span><b>{{ sharePct }}%</b> {{ share.label }}</span>
        </div>
        <div v-if="series && series.length > 1" class="ui-tile__spark">
          <Sparkline :series="series" :label="seriesLabel ?? label" />
        </div>
      </template>
    </template>

    <!-- stat：音乐下载页头统计 -->
    <template v-else>
      <span v-if="icon" class="stat__icon">
        <component :is="icon" :size="16" aria-hidden="true" />
      </span>
      <span class="stat__num" aria-hidden="true">
        <SkeletonBlock v-if="loading" width="48px" height="20px" radius="6px" />
        <template v-else>{{ shown }}</template>
      </span>
      <span class="stat__label" aria-hidden="true">{{ label }}</span>
      <div v-if="sharePct >= 0 && share" class="ui-tile__share">
        <span><b>{{ sharePct }}%</b> {{ share.label }}</span>
      </div>
      <div v-if="series && series.length > 1" class="ui-tile__spark">
        <Sparkline :series="series" :label="seriesLabel ?? label" />
      </div>
    </template>
  </component>
</template>

<style scoped>
.ui-tile {
  box-sizing: border-box;
  min-width: 0;
}

button.ui-tile {
  font: inherit;
  color: inherit;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* ── card（豆瓣中心）──────────────────────────────────── */

.db-tile {
  --tone: var(--ui-accent, #2080f0);
  position: relative;
  display: grid;
  gap: 3px;
  align-content: start;
  padding: 13px 14px 12px;
  border-radius: 14px;
  background:
    radial-gradient(120% 90% at 100% 0%, color-mix(in srgb, var(--tone) 12%, transparent), transparent 60%),
    var(--ui-surface, #fff);
  border: 1px solid var(--ui-border, #e3e6eb);
  min-width: 0;
  overflow: hidden;
  font: inherit;
  color: inherit;
  text-align: left;
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
  border-color: color-mix(in srgb, var(--tone) 45%, var(--ui-border, #e3e6eb));
  box-shadow: 0 10px 24px -14px color-mix(in srgb, var(--tone) 55%, transparent);
}

.db-tile--accent {
  --tone: var(--ui-accent, #2080f0);
}

.db-tile--ok {
  --tone: var(--ui-ok, #18a058);
}

.db-tile--warn {
  --tone: var(--ui-warn, #f0a020);
}

.db-tile--error {
  --tone: var(--ui-err, #d03050);
}

.db-tile--muted {
  --tone: var(--ui-muted, #6b7280);
}

.db-tile--alt {
  --tone: var(--ui-alt, var(--ui-accent, #2080f0));
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
  color: var(--ui-muted, #6b7280);
  font-size: 12px;
  padding-right: 34px;
}

.db-tile__value {
  font-size: 26px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
  letter-spacing: -0.01em;
  color: var(--ui-text, #1f2329);
}

.db-tile__hint {
  color: var(--ui-muted, #6b7280);
  font-size: 11px;
  overflow-wrap: anywhere;
}

/* ── stat（音乐下载页头）──────────────────────────────── */

.stat {
  --tone: var(--ui-muted, #6b7280);
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
  border: 1px solid color-mix(in srgb, var(--tone) 16%, var(--ui-border, #e0e4ea));
  background: color-mix(in srgb, var(--ui-surface, #fff) 62%, transparent);
  color: var(--ui-text, inherit);
  font: inherit;
  overflow: hidden;
  transition:
    transform 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

button.stat {
  cursor: pointer;
}

.stat:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--tone) 45%, transparent);
  box-shadow: 0 10px 24px -16px var(--tone);
}

.stat:focus-visible {
  outline: 2px solid var(--ui-accent, #2080f0);
  outline-offset: 2px;
}

.stat--accent {
  --tone: var(--ui-accent, #2080f0);
}

.stat--ok {
  --tone: var(--ui-ok, #18a058);
}

.stat--warn {
  --tone: var(--ui-warn, #f0a020);
}

.stat--error {
  --tone: var(--ui-err, #d03050);
}

.stat--muted,
.stat--default {
  --tone: var(--ui-muted, #6b7280);
}

.stat--alt {
  --tone: var(--ui-alt, var(--ui-accent, #2080f0));
}

/* 音乐页原有的按业务键着色（tileKey 兼容） */
.stat--active {
  --tone: var(--ui-accent, #2080f0);
}

.stat--queued {
  --tone: color-mix(in srgb, var(--ui-accent, #2080f0) 55%, var(--ui-muted, #6b7280));
}

.stat--done {
  --tone: var(--ui-ok, #18a058);
}

.stat--failed {
  --tone: var(--ui-err, #d03050);
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
  animation: ui-stat-spin 2.4s linear infinite;
}

.stat__num {
  grid-area: num;
  font-size: 22px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.stat--live .stat__num {
  color: var(--tone);
}

.stat__label {
  grid-area: label;
  font-size: 12px;
  color: var(--ui-muted, #6b7280);
}

/* ── 两种皮肤共用的占比环 / 折线扩展 ──────────────────── */

.ui-tile__share {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--ui-muted, #6b7280);
}

.ui-tile__share b {
  color: var(--ui-text, #1f2329);
  font-variant-numeric: tabular-nums;
}

.ui-tile__share-ring {
  width: 40px;
  height: 40px;
  flex: none;
  transform: rotate(-90deg);
}

.ui-tile__share-ring circle {
  fill: none;
  stroke-width: 5;
}

.ui-tile__share .ring-track {
  stroke: color-mix(in srgb, var(--ui-text, #1f2329) 9%, transparent);
}

.ui-tile__share .ring-have {
  stroke: var(--tone, var(--ui-accent, #2080f0));
  stroke-linecap: round;
}

.stat .ui-tile__share,
.stat .ui-tile__spark {
  grid-column: 1 / -1;
}

@keyframes ui-stat-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .db-tile {
    transition: none;
  }

  .db-tile:hover {
    transform: none;
  }

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
