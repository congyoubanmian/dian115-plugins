<script setup lang="ts">
// 榜单与海报墙（对应原生版的 renderCharts）。
//
// 每个榜单一个区块：标题 + 来源提示 + 条数；下面是海报轮播（横向 scroll-snap）
// 或网格（右上角切换）。条目卡片见 PosterCard：海报（可点开放大）、排名缎带、
// 队列状态角标、星条评分、年份/热度、订阅动作与豆瓣链接。

import { computed, ref } from 'vue'
import { ChevronLeft, ChevronRight, GalleryHorizontal, LayoutGrid } from '@lucide/vue'
import { doubanHref, formatTime, listHint, listTitle, sortListKeys, text } from '../format'
import { QUEUE_STATE_META } from '../constants'
import { prefersReducedMotion } from '../motion'
import { useDoubanStore } from '../store'
import type { ChartItem } from '../types'
import BlockCard from './BlockCard.vue'
import PosterCard from './PosterCard.vue'
import SkeletonBlock from '../../shared/components/SkeletonBlock.vue'
import StateBadge from './StateBadge.vue'

const emit = defineEmits<{
  (e: 'zoom', payload: { url: string; title: string; href?: string }): void
}>()

const store = useDoubanStore()
const { docSettings, stateDoc, snapshotLists, snapshotListCount, queueIndex, busy, loaded } = store

const locked = computed(() => busy.value !== '')

/** 展示方式：轮播（默认，一行横向滑动）或网格（一次看全）。 */
const layout = ref<'carousel' | 'grid'>('carousel')
const layouts = [
  { key: 'carousel' as const, label: '轮播', icon: GalleryHorizontal },
  { key: 'grid' as const, label: '网格', icon: LayoutGrid },
]

const listKeys = computed(() => sortListKeys(Object.keys(snapshotLists.value)))

function itemsOf(key: string): ChartItem[] {
  const items = snapshotLists.value[key]
  return Array.isArray(items) ? items : []
}

/** 带稳定 key 的条目（同一豆瓣条目在榜单里重复出现时追加序号，避免 key 冲突）。 */
function keyedItems(key: string): Array<{ id: string; item: ChartItem; position: number }> {
  const seen = new Set<string>()
  return itemsOf(key).map((item, index) => {
    let id = item.douban_ref ? `ref:${item.douban_ref}` : `idx:${index}`
    if (seen.has(id)) id = `${id}#${index}`
    seen.add(id)
    return { id, item, position: index + 1 }
  })
}

function hintOf(key: string): string {
  return `${listHint(key, docSettings.value.lists?.[key])} · ${itemsOf(key).length} 条`
}

function stateOf(item: ChartItem): { label: string; tone: string; state: string } {
  const queued = item.douban_ref ? queueIndex.value.get(item.douban_ref) : undefined
  if (!queued) return { label: '', tone: 'muted', state: '' }
  const meta = QUEUE_STATE_META[queued.state ?? ''] ?? { label: queued.state || '在队列', cls: 'muted' }
  return { label: meta.label, tone: meta.cls, state: queued.state ?? '' }
}

function onZoom(item: ChartItem, payload: { url: string; title: string }): void {
  emit('zoom', { url: payload.url, title: payload.title, href: doubanHref(item) })
}

function subscribe(item: ChartItem): void {
  void store.runAction(
    'subscribe',
    { douban_ref: item.douban_ref },
    {
      label: `订阅「${text(item.title) || item.douban_ref}」`,
      tombstoneRef: item.douban_ref,
    },
  )
}

const tracks = new Map<string, HTMLElement>()

function setTrack(key: string, el: unknown): void {
  if (el instanceof HTMLElement) tracks.set(key, el)
  else tracks.delete(key)
}

function scrollTrack(key: string, direction: 1 | -1): void {
  const el = tracks.get(key)
  if (!el) return
  const left = direction * Math.max(160, el.clientWidth * 0.85)
  el.scrollBy?.({ left, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
}
</script>

<template>
  <div class="db-charts">
    <div class="db-panel-head">
      <div class="db-panel-head__text">
        <h2 class="db-panel-title">榜单与海报墙</h2>
        <p class="db-panel-sub">
          快照时间：{{ formatTime(stateDoc?.snapshot?.fetched_at) || '尚未刷新' }}。海报经宿主 HTTP 带豆瓣 Referer 获取。
        </p>
      </div>
      <div v-if="snapshotListCount > 0" class="db-seg" role="group" aria-label="海报墙展示方式">
        <button
          v-for="mode in layouts"
          :key="mode.key"
          type="button"
          class="db-seg__btn"
          :class="{ 'db-seg__btn--on': layout === mode.key }"
          :aria-pressed="layout === mode.key"
          @click="layout = mode.key"
        >
          <component :is="mode.icon" :size="14" aria-hidden="true" />
          {{ mode.label }}
        </button>
      </div>
    </div>

    <!-- 首次读取：骨架海报墙 -->
    <div v-if="!loaded" class="db-skeleton-wall" role="status">
      <span class="db-sr">正在读取榜单快照…</span>
      <div v-for="row in 2" :key="row" class="db-skeleton-row">
        <SkeletonBlock width="160px" height="16px" />
        <div class="db-skeleton-track">
          <div v-for="col in 6" :key="col" class="db-skeleton-card">
            <SkeletonBlock height="auto" radius="12px" class="db-skeleton-poster" />
            <SkeletonBlock width="85%" height="11px" />
            <SkeletonBlock width="55%" height="9px" />
          </div>
        </div>
      </div>
    </div>

    <div v-else-if="snapshotListCount === 0" class="db-empty">
      <p>还没有榜单快照。</p>
      <p class="db-empty__note">
        点击右上角「刷新榜单」按已启用的榜单抓取；抓取完成后，通过黑名单/过滤器的条目会进入观察队列。
      </p>
    </div>

    <BlockCard
      v-for="key in listKeys"
      :key="key"
      class="db-list"
      :title="listTitle(key)"
      :subtitle="hintOf(key)"
    >
      <template #actions>
        <StateBadge
          v-if="docSettings.lists?.[key]?.enabled === false"
          label="已在设置里停用"
          tone="muted"
        />
        <template v-if="layout === 'carousel' && itemsOf(key).length > 0">
          <button type="button" class="db-nav" :aria-label="`${listTitle(key)}：向左滚动`" @click="scrollTrack(key, -1)">
            <ChevronLeft :size="16" aria-hidden="true" />
          </button>
          <button type="button" class="db-nav" :aria-label="`${listTitle(key)}：向右滚动`" @click="scrollTrack(key, 1)">
            <ChevronRight :size="16" aria-hidden="true" />
          </button>
        </template>
      </template>

      <div v-if="itemsOf(key).length === 0" class="db-empty">
        <p>本轮该榜单没有条目。</p>
        <p class="db-empty__note">抓取失败或榜单为空时后端会在日志里记录原因。</p>
      </div>

      <TransitionGroup
        v-else
        :ref="(el) => setTrack(key, (el as { $el?: unknown } | null)?.$el)"
        tag="div"
        name="db-pop"
        class="db-wall"
        :class="layout === 'carousel' ? 'db-wall--carousel' : 'db-wall--grid'"
        :aria-label="`${listTitle(key)}海报墙`"
        role="list"
      >
        <PosterCard
          v-for="entry in keyedItems(key)"
          :key="entry.id"
          role="listitem"
          class="db-wall__cell"
          :item="entry.item"
          :position="entry.position"
          :queue-label="stateOf(entry.item).label"
          :queue-tone="stateOf(entry.item).tone"
          :queue-state="stateOf(entry.item).state"
          :locked="locked"
          @zoom="onZoom(entry.item, $event)"
          @subscribe="subscribe(entry.item)"
        />
      </TransitionGroup>
    </BlockCard>
  </div>
</template>

<style scoped>
.db-charts {
  display: grid;
  gap: 14px;
}

.db-panel-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

.db-panel-head__text {
  min-width: 0;
}

.db-panel-title {
  font-size: 17px;
  font-weight: 700;
  margin: 0;
}

.db-panel-sub {
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 12px;
  margin: 3px 0 0;
  overflow-wrap: anywhere;
}

/* 分段切换：轮播 / 网格 */
.db-seg {
  display: inline-flex;
  padding: 3px;
  gap: 2px;
  border-radius: 10px;
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  background: var(--app-surface, #fff);
}

.db-seg__btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    background-color 0.2s ease,
    color 0.2s ease;
}

.db-seg__btn:hover {
  color: var(--app-text, #1f2329);
}

.db-seg__btn--on {
  color: var(--db-accent, #2080f0);
  font-weight: 600;
  background: color-mix(in srgb, var(--db-accent, #2080f0) 13%, transparent);
}

.db-seg__btn:focus-visible,
.db-nav:focus-visible {
  outline: 2px solid var(--db-accent, #2080f0);
  outline-offset: 2px;
}

.db-nav {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  background: var(--app-surface, #fff);
  color: var(--app-text, #1f2329);
  cursor: pointer;
  transition:
    border-color 0.2s ease,
    color 0.2s ease;
}

.db-nav:hover {
  border-color: var(--db-accent, #2080f0);
  color: var(--db-accent, #2080f0);
}

.db-wall {
  position: relative;
  min-width: 0;
}

.db-wall--grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(142px, 1fr));
  gap: 16px 14px;
}

.db-wall--carousel {
  display: flex;
  gap: 14px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scroll-snap-type: x mandatory;
  scroll-padding-inline: 4px;
  padding: 10px 4px 12px;
  margin: -10px -4px -6px;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--db-accent, #2080f0) 35%, transparent) transparent;
  -webkit-mask-image: linear-gradient(90deg, #000, #000 calc(100% - 28px), transparent);
  mask-image: linear-gradient(90deg, #000, #000 calc(100% - 28px), transparent);
}

.db-wall--carousel > .db-wall__cell {
  flex: 0 0 clamp(128px, 15cqi, 168px);
  scroll-snap-align: start;
}

/* TransitionGroup：条目进出与位移 */
.db-pop-enter-active,
.db-pop-leave-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}

.db-pop-enter-from,
.db-pop-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.96);
}

.db-pop-move {
  transition: transform 0.35s ease;
}

/* 骨架海报墙 */
.db-skeleton-wall {
  display: grid;
  gap: 14px;
}

.db-skeleton-row {
  display: grid;
  gap: 12px;
  padding: 14px 16px;
  border-radius: var(--db-radius, 14px);
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  background: var(--app-surface, #fff);
}

.db-skeleton-track {
  display: flex;
  gap: 14px;
  overflow: hidden;
}

.db-skeleton-card {
  flex: 0 0 clamp(120px, 15cqi, 160px);
  display: grid;
  gap: 7px;
}

.db-skeleton-poster {
  aspect-ratio: 2 / 3;
}

.db-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.db-empty {
  display: grid;
  gap: 4px;
  padding: 18px 6px;
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 13px;
}

.db-empty p {
  margin: 0;
}

.db-empty__note {
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 11px;
}

@container page (max-width: 719.98px) {
  .db-wall--grid {
    grid-template-columns: repeat(auto-fill, minmax(116px, 1fr));
    gap: 12px 10px;
  }

  .db-wall--carousel > .db-wall__cell {
    flex-basis: 118px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .db-seg__btn,
  .db-nav,
  .db-pop-enter-active,
  .db-pop-leave-active,
  .db-pop-move {
    transition: none;
  }
}
</style>
