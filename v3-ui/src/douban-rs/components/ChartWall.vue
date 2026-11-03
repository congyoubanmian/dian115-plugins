<script setup lang="ts">
// 榜单与海报墙（对应原生版的 renderCharts）。
//
// 每个榜单一个区块：标题 + 来源提示 + 条数；下面��海报网格。
// 条目卡片：海报（可点开放大）、标题（豆瓣链接）、评分/年份/排名/热度、
// 队列状态徽标、订阅动作。

import { computed } from 'vue'
import { NButton } from 'naive-ui'
import { ExternalLink } from '@lucide/vue'
import { doubanHref, formatTime, listHint, listTitle, num, sortListKeys, text } from '../format'
import { QUEUE_STATE_META } from '../constants'
import { useDoubanStore } from '../store'
import type { ChartItem } from '../types'
import BlockCard from './BlockCard.vue'
import PosterImg from './PosterImg.vue'
import StateBadge from './StateBadge.vue'

const emit = defineEmits<{
  (e: 'zoom', payload: { url: string; title: string; href?: string }): void
}>()

const store = useDoubanStore()
const { docSettings, stateDoc, snapshotLists, snapshotListCount, queueIndex, busy } = store

const locked = computed(() => busy.value !== '')

const listKeys = computed(() => sortListKeys(Object.keys(snapshotLists.value)))

function itemsOf(key: string): ChartItem[] {
  const items = snapshotLists.value[key]
  return Array.isArray(items) ? items : []
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
    </div>

    <div v-if="snapshotListCount === 0" class="db-empty">
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
      </template>

      <div v-if="itemsOf(key).length === 0" class="db-empty">
        <p>本轮该榜单没有条目。</p>
        <p class="db-empty__note">抓取失败或榜单为空时后端会在日志里记录原因。</p>
      </div>

      <div v-else class="db-poster-grid">
        <article v-for="(item, index) in itemsOf(key)" :key="`${key}-${index}`" class="db-item">
          <PosterImg
            :url="item.poster_url"
            :title="text(item.title)"
            variant="poster"
            @zoom="onZoom(item, $event)"
          />
          <div class="db-item__body">
            <a
              v-if="doubanHref(item)"
              class="db-item__title"
              :href="doubanHref(item)"
              target="_blank"
              rel="noreferrer noopener"
            >{{ text(item.title) || '(无标题)' }}</a>
            <span v-else class="db-item__title">{{ text(item.title) || '(无标题)' }}</span>

            <div
              v-if="(item.rate && item.rate !== '0') || item.year || item.rank || num(item.hotness) > 0"
              class="db-item__meta"
            >
              <span v-if="item.rate && item.rate !== '0'" class="db-rate">★ {{ item.rate }}</span>
              <span v-if="item.year">{{ item.year }}</span>
              <span v-if="item.rank">第 {{ item.rank }} 名</span>
              <span v-if="num(item.hotness) > 0">热度 {{ item.hotness }}</span>
            </div>

            <StateBadge
              v-if="stateOf(item).label"
              :label="stateOf(item).label"
              :tone="stateOf(item).tone"
            />

            <div class="db-item__actions">
              <NButton
                v-if="stateOf(item).state !== 'subscribed'"
                size="tiny"
                type="primary"
                :disabled="locked"
                data-busy-lock="1"
                @click="
                  store.runAction(
                    'subscribe',
                    { douban_ref: item.douban_ref },
                    {
                      label: `订阅「${text(item.title) || item.douban_ref}」`,
                      tombstoneRef: item.douban_ref,
                    },
                  )
                "
              >
                订阅
              </NButton>
              <NButton v-else size="tiny" quaternary disabled data-busy-lock="1">已订阅</NButton>
              <a
                v-if="doubanHref(item)"
                class="db-link"
                :href="doubanHref(item)"
                target="_blank"
                rel="noreferrer noopener"
              >
                <ExternalLink :size="12" aria-hidden="true" />
                豆瓣
              </a>
            </div>
          </div>
        </article>
      </div>
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
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

.db-panel-head__text {
  min-width: 0;
}

.db-panel-title {
  font-size: 16px;
  font-weight: 650;
  margin: 0;
}

.db-panel-sub {
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 12px;
  margin: 3px 0 0;
  overflow-wrap: anywhere;
}

.db-poster-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(142px, 1fr));
  gap: 14px;
}

.db-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.db-item__body {
  display: grid;
  gap: 5px;
  min-width: 0;
  justify-items: start;
}

.db-item__title {
  font-size: 13px;
  font-weight: 550;
  line-height: 1.35;
  text-decoration: none;
  color: var(--app-text, #1f2329);
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

a.db-item__title:hover {
  color: var(--db-accent, #2080f0);
}

.db-item__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 11px;
}

.db-rate {
  color: #e6a23c;
  font-weight: 600;
}

.db-item__actions {
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

@media (max-width: 720px) {
  .db-poster-grid {
    grid-template-columns: repeat(auto-fill, minmax(116px, 1fr));
    gap: 10px;
  }
}
</style>
