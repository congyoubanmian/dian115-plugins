<script setup lang="ts">
// 海报墙卡片：海报（悬停 3D 倾斜 + 光泽）、左上角排名缎带、右上角队列状态角标、
// 星条评分、年份/热度、订阅与豆瓣链接。
//
// 倾斜只写两个 CSS 变量（--rx/--ry）和光泽位置（--mx/--my），动画全在 CSS 里；
// 系统要求减少动态效果时不处理指针事件，CSS 侧也会把 transform 关掉。

import { computed, ref } from 'vue'
import { NButton } from 'naive-ui'
import { ExternalLink } from '@lucide/vue'
import { doubanHref, num, text } from '../format'
import { prefersReducedMotion } from '../motion'
import type { ChartItem } from '../types'
import PosterImg from './PosterImg.vue'
import StarBar from './StarBar.vue'

const props = defineProps<{
  item: ChartItem
  position: number
  queueLabel: string
  queueTone: string
  queueState: string
  locked: boolean
}>()

const emit = defineEmits<{
  (e: 'zoom', payload: { url: string; title: string }): void
  (e: 'subscribe'): void
}>()

const frame = ref<HTMLElement | null>(null)
const title = computed(() => text(props.item.title))
const href = computed(() => doubanHref(props.item))
const rank = computed(() => {
  const value = num(props.item.rank)
  return value > 0 ? value : props.position
})
const hasRate = computed(() => Boolean(props.item.rate) && props.item.rate !== '0')

const MAX_TILT = 9

function onMove(event: PointerEvent): void {
  const el = frame.value
  if (!el || event.pointerType === 'touch' || prefersReducedMotion()) return
  const box = el.getBoundingClientRect()
  if (!box.width || !box.height) return
  const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
  const y = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height))
  el.style.setProperty('--rx', `${((0.5 - y) * MAX_TILT * 2).toFixed(2)}deg`)
  el.style.setProperty('--ry', `${((x - 0.5) * MAX_TILT * 2).toFixed(2)}deg`)
  el.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`)
  el.style.setProperty('--my', `${(y * 100).toFixed(1)}%`)
}

function onLeave(): void {
  const el = frame.value
  if (!el) return
  el.style.setProperty('--rx', '0deg')
  el.style.setProperty('--ry', '0deg')
}
</script>

<template>
  <article class="db-card3d">
    <div ref="frame" class="db-card3d__frame" @pointermove="onMove" @pointerleave="onLeave">
      <PosterImg :url="item.poster_url" :title="title" variant="poster" @zoom="emit('zoom', $event)" />
      <span class="db-card3d__sheen" aria-hidden="true" />
      <span class="db-ribbon" :class="{ 'db-ribbon--top': rank <= 3 }" :title="`第 ${rank} 名`">
        <span class="db-sr">第 </span>{{ rank }}<span class="db-sr"> 名</span>
      </span>
      <span v-if="queueLabel" class="db-corner" :class="`db-corner--${queueTone}`">{{ queueLabel }}</span>
    </div>

    <div class="db-card3d__body">
      <a v-if="href" class="db-card3d__title" :href="href" target="_blank" rel="noreferrer noopener">{{
        title || '(无标题)'
      }}</a>
      <span v-else class="db-card3d__title">{{ title || '(无标题)' }}</span>

      <StarBar v-if="hasRate" :value="item.rate" />
      <div v-if="item.year || num(item.hotness) > 0" class="db-card3d__meta">
        <span v-if="item.year">{{ item.year }}</span>
        <span v-if="num(item.hotness) > 0">热度 {{ item.hotness }}</span>
      </div>

      <div class="db-card3d__actions">
        <NButton
          v-if="queueState !== 'subscribed'"
          size="tiny"
          type="primary"
          :disabled="locked"
          data-busy-lock="1"
          @click="emit('subscribe')"
        >
          订阅
        </NButton>
        <NButton v-else size="tiny" quaternary disabled data-busy-lock="1">已订阅</NButton>
        <a v-if="href" class="db-link" :href="href" target="_blank" rel="noreferrer noopener">
          <ExternalLink :size="12" aria-hidden="true" />
          豆瓣
        </a>
      </div>
    </div>
  </article>
</template>

<style scoped>
.db-card3d {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
  perspective: 700px;
}

.db-card3d__frame {
  --rx: 0deg;
  --ry: 0deg;
  --mx: 50%;
  --my: 50%;
  position: relative;
  border-radius: 12px;
  transform: rotateX(var(--rx)) rotateY(var(--ry));
  transform-style: preserve-3d;
  transition:
    transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1),
    box-shadow 0.35s ease;
  box-shadow: 0 6px 16px -10px color-mix(in srgb, var(--app-text, #1f2329) 55%, transparent);
  will-change: transform;
}

.db-card3d__frame:hover {
  transition:
    transform 0.08s linear,
    box-shadow 0.35s ease;
  box-shadow:
    0 18px 34px -16px color-mix(in srgb, var(--app-text, #1f2329) 65%, transparent),
    0 0 0 1px color-mix(in srgb, var(--db-accent, #2080f0) 35%, transparent);
}

.db-root--dark .db-card3d__frame:hover {
  box-shadow:
    0 18px 40px -14px color-mix(in srgb, var(--db-accent, #2080f0) 45%, transparent),
    0 0 0 1px color-mix(in srgb, var(--db-accent, #2080f0) 45%, transparent);
}

.db-card3d__frame :deep(.db-poster) {
  width: 100%;
  border-radius: 12px;
}

.db-card3d__sheen {
  position: absolute;
  inset: 0;
  border-radius: 12px;
  pointer-events: none;
  opacity: 0;
  background: radial-gradient(
    circle at var(--mx) var(--my),
    color-mix(in srgb, var(--app-surface, #fff) 55%, transparent),
    transparent 55%
  );
  mix-blend-mode: soft-light;
  transition: opacity 0.3s ease;
}

.db-card3d__frame:hover .db-card3d__sheen {
  opacity: 1;
}

/* 左上角排名缎带：前三名用渐变强调。 */
.db-ribbon {
  position: absolute;
  top: 8px;
  left: 0;
  min-width: 26px;
  padding: 2px 9px 2px 8px;
  border-radius: 0 999px 999px 0;
  font-size: 12px;
  font-weight: 750;
  font-variant-numeric: tabular-nums;
  line-height: 18px;
  text-align: center;
  pointer-events: none;
  color: var(--app-text, #1f2329);
  background: color-mix(in srgb, var(--app-surface, #fff) 88%, transparent);
  box-shadow: 0 3px 8px -3px color-mix(in srgb, var(--app-text, #1f2329) 50%, transparent);
  transform: translateZ(24px);
}

.db-ribbon--top {
  color: var(--app-surface, #fff);
  background: linear-gradient(135deg, var(--db-accent, #2080f0), var(--db-accent-2, var(--db-accent, #2080f0)));
}

.db-root--dark .db-ribbon--top {
  color: var(--app-text, #fff);
}

/* 右上角队列状态角标。 */
.db-corner {
  --tone: var(--db-muted, var(--app-text-secondary, #6b7280));
  position: absolute;
  top: 8px;
  right: 8px;
  max-width: calc(100% - 52px);
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 17px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  color: var(--tone);
  background: color-mix(in srgb, var(--app-surface, #fff) 90%, transparent);
  border: 1px solid color-mix(in srgb, var(--tone) 55%, transparent);
  backdrop-filter: blur(6px);
  transform: translateZ(24px);
}

.db-corner--ok {
  --tone: var(--db-ok, #18a058);
}

.db-corner--warn {
  --tone: var(--db-warn, #f0a020);
}

.db-corner--error {
  --tone: var(--db-err, #d03050);
}

.db-corner--info {
  --tone: var(--db-accent, #2080f0);
}

.db-card3d__body {
  display: grid;
  gap: 5px;
  min-width: 0;
  justify-items: start;
}

.db-card3d__title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  text-decoration: none;
  color: var(--app-text, #1f2329);
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

a.db-card3d__title:hover {
  color: var(--db-accent, #2080f0);
}

.db-card3d__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 11px;
}

.db-card3d__actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}

.db-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 7px;
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  font-size: 12px;
  text-decoration: none;
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
}

.db-link:hover {
  border-color: var(--db-accent, #2080f0);
  color: var(--db-accent, #2080f0);
}

.db-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .db-card3d__frame,
  .db-card3d__frame:hover {
    transform: none;
    transition: none;
  }

  .db-card3d__sheen {
    display: none;
  }
}
</style>
