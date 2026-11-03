<script setup lang="ts">
// 观察队列看板 + 我的想看（对应原生版的 renderQueue）。
//
// 上：观察队列按状态分列成看板（观察中 → 到期待订阅 → 已订阅 / 待人工确认，
//     被过滤器或墓碑拦下的条目另起一列，仅在有条目时出现）。
// 下：我的想看（同步开关、上次同步结果、条目卡片）。
// 队列条目支持逐条「立即订阅」「移出」；面板头部提供「订阅全部到期条目」的批量入口。

import { computed, type Component } from 'vue'
import { NButton } from 'naive-ui'
import { Ban, CircleCheck, ExternalLink, Eye, Hourglass } from '@lucide/vue'
import { COOKIE_SOURCE_LABEL, QUEUE_STATE_META, TYPE_LABEL, WISH_STATUS_LABEL } from '../constants'
import { doubanHref, dueLabel, formatTime, listTitle, num, text } from '../format'
import { FILTERED_QUEUE_STATE, NO_RESUB_QUEUE_STATE } from '../lib-bridge'
import { useDoubanStore } from '../store'
import type { QueueItem, WishItem } from '../types'
import BlockCard from './BlockCard.vue'
import PosterImg from './PosterImg.vue'
import SkeletonBlock from '../../shared/components/SkeletonBlock.vue'
import StarBar from './StarBar.vue'
import StateBadge from './StateBadge.vue'

const emit = defineEmits<{
  (e: 'zoom', payload: { url: string; title: string; href?: string }): void
}>()

const store = useDoubanStore()
const { queueItems, wishItems, wishInfo, flat, queueIndex, dueItems, busy, historyItems, loaded } = store

type LaneKey = 'watching' | 'due' | 'done' | 'blocked'

const metaLabel = (state: string): string => QUEUE_STATE_META[state]?.label ?? state

/** 看板列（文案取自 QUEUE_STATE_META，与徽标口径一致）。 */
const laneDefs: Array<{ key: LaneKey; title: string; note: string; tone: string; icon: Component }> = [
  { key: 'watching', title: metaLabel('observing'), note: '尚未到观察期', tone: 'warn', icon: Eye },
  { key: 'due', title: '到期待订阅', note: '可批量或逐条订阅', tone: 'info', icon: Hourglass },
  {
    key: 'done',
    title: `${metaLabel('subscribed')} / ${metaLabel('needs_review')}`,
    note: '订阅完成或需人工处理',
    tone: 'ok',
    icon: CircleCheck,
  },
  {
    key: 'blocked',
    title: `${metaLabel(FILTERED_QUEUE_STATE)} / ${metaLabel(NO_RESUB_QUEUE_STATE)}`,
    note: '自动路径不会订阅',
    tone: 'muted',
    icon: Ban,
  },
]

function laneOf(item: QueueItem, due: Set<QueueItem>): LaneKey {
  const state = item.state ?? ''
  if (state === 'subscribed' || state === 'needs_review') return 'done'
  if (state === FILTERED_QUEUE_STATE || state === NO_RESUB_QUEUE_STATE) return 'blocked'
  return due.has(item) ? 'due' : 'watching'
}

const lanes = computed(() => {
  const due = new Set(dueItems.value)
  const buckets: Record<LaneKey, Array<{ id: string; item: QueueItem }>> = {
    watching: [],
    due: [],
    done: [],
    blocked: [],
  }
  queueItems.value.forEach((item, index) => {
    buckets[laneOf(item, due)].push({ id: item.douban_ref || `idx:${index}`, item })
  })
  return laneDefs
    .filter((lane) => lane.key !== 'blocked' || buckets.blocked.length > 0)
    .map((lane) => ({ ...lane, items: buckets[lane.key] }))
})

const locked = computed(() => busy.value !== '')

function stateMeta(state?: string): { label: string; tone: string } {
  const meta = QUEUE_STATE_META[state ?? ''] ?? { label: state || '状态未知', cls: 'muted' }
  return { label: meta.label, tone: meta.cls }
}

function onZoom(item: QueueItem | WishItem, payload: { url: string; title: string }): void {
  emit('zoom', { url: payload.url, title: payload.title, href: doubanHref(item) })
}

function subscribeNow(item: QueueItem): void {
  void store.runAction(
    'subscribe-now',
    { douban_ref: item.douban_ref },
    {
      label: `立即订阅「${text(item.title) || item.douban_ref}」`,
      tombstoneRef: item.douban_ref,
    },
  )
}

function removeObserved(item: QueueItem): void {
  void store.runAction(
    'observe-remove',
    { douban_ref: item.douban_ref },
    { label: `移出「${text(item.title) || item.douban_ref}」` },
  )
}

/** 订阅成功过的豆瓣条目（订阅后条目会移出队列，不能再显示成「未入队」）。 */
const subscribedRefs = computed(() => {
  const refs = new Set<string>()
  for (const entry of historyItems.value) {
    if (entry?.action === 'subscribe' && entry.result === 'succeeded' && entry.douban_ref) refs.add(entry.douban_ref)
  }
  return refs
})

function wishState(item: WishItem): { label: string; tone: string } {
  const queued = item.douban_ref ? queueIndex.value.get(item.douban_ref) : undefined
  if (!queued) {
    if (item.douban_ref && subscribedRefs.value.has(item.douban_ref)) return stateMeta('subscribed')
    return { label: '未入队', tone: 'muted' }
  }
  return stateMeta(queued.state)
}
</script>

<template>
  <div class="db-queue-panel">
    <div class="db-panel-head">
      <div class="db-panel-head__text">
        <h2 class="db-panel-title">观察队列与我的想看</h2>
        <p class="db-panel-sub">
          队列 {{ queueItems.length }} 条（{{ dueItems.length }} 条到期）· 想看 {{ wishItems.length }} 条。
          到期订阅由后台任务处理，也可逐条立即订阅。
        </p>
      </div>
      <div class="db-inline-actions">
        <NButton
          size="small"
          type="primary"
          :disabled="locked || dueItems.length === 0"
          data-busy-lock="1"
          @click="store.subscribeDueBatch()"
        >
          订阅全部到期（{{ dueItems.length }}）
        </NButton>
      </div>
    </div>

    <!-- 观察队列看板 -->
    <BlockCard title="观察队列" subtitle="榜单/想看新条目先入队；墓碑与过滤器在自动路径生效。">
      <div v-if="!loaded" class="db-board" role="status">
        <span class="db-sr">正在读取观察队列…</span>
        <div v-for="col in 3" :key="col" class="db-lane db-lane--muted">
          <SkeletonBlock width="50%" height="14px" />
          <div v-for="row in 2" :key="row" class="db-skel-card">
            <SkeletonBlock width="48px" height="72px" radius="8px" />
            <div class="db-skel-lines">
              <SkeletonBlock width="80%" height="11px" />
              <SkeletonBlock width="55%" height="9px" />
              <SkeletonBlock width="65%" height="9px" />
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="queueItems.length === 0" class="db-empty">
        <p>观察队列为空。</p>
        <p class="db-empty__note">刷新榜单或同步想看后，通过过滤的新条目会出现在这里。</p>
      </div>

      <div v-else class="db-board">
        <section
          v-for="lane in lanes"
          :key="lane.key"
          class="db-lane"
          :class="`db-lane--${lane.tone}`"
          :aria-label="`${lane.title}（${lane.items.length} 条）`"
        >
          <header class="db-lane__head">
            <span class="db-lane__icon" aria-hidden="true">
              <component :is="lane.icon" :size="14" />
            </span>
            <span class="db-lane__title">{{ lane.title }}</span>
            <span class="db-lane__count">{{ lane.items.length }}</span>
          </header>
          <p class="db-lane__note">{{ lane.note }}</p>

          <TransitionGroup tag="div" name="db-card" class="db-lane__list">
            <article v-for="{ id, item } in lane.items" :key="id" class="db-queue-item">
              <PosterImg
                :url="item.poster_url"
                :title="text(item.title)"
                variant="thumb"
                @zoom="onZoom(item, $event)"
              />
              <div class="db-queue-main">
                <a
                  v-if="doubanHref(item)"
                  class="db-item__title"
                  :href="doubanHref(item)"
                  target="_blank"
                  rel="noreferrer noopener"
                >{{ text(item.title) || '(无标题)' }}</a>
                <span v-else class="db-item__title">{{ text(item.title) || '(无标题)' }}</span>

                <div class="db-item__meta">
                  <StateBadge :label="stateMeta(item.state).label" :tone="stateMeta(item.state).tone" />
                  <span v-if="item.list">来源 {{ listTitle(item.list) }}</span>
                  <span v-if="item.media_type">{{ TYPE_LABEL[item.media_type] ?? item.media_type }}</span>
                  <span v-if="item.year">{{ item.year }}</span>
                </div>
                <StarBar v-if="num(item.rating) > 0" :value="item.rating" compact />

                <div class="db-queue-due">
                  <span>观察到期：{{ dueLabel(item) }}</span>
                  <span class="db-mono">{{ item.due_at ? formatTime(item.due_at) : '—' }}</span>
                </div>

                <p v-if="item.tmdb_ref" class="db-queue-extra db-mono">TMDB：{{ item.tmdb_ref }}</p>
                <p v-if="num(item.attempt) > 0" class="db-queue-extra">尝试 {{ item.attempt }} 次</p>
                <p v-if="item.last_error" class="db-error-text">{{ item.last_error }}</p>
              </div>

              <div class="db-queue-actions">
                <NButton
                  v-if="item.state !== 'subscribed'"
                  size="tiny"
                  type="primary"
                  :disabled="locked"
                  data-busy-lock="1"
                  @click="subscribeNow(item)"
                >
                  立即订阅
                </NButton>
                <NButton v-else size="tiny" quaternary disabled data-busy-lock="1">已订阅</NButton>
                <NButton
                  size="tiny"
                  type="error"
                  quaternary
                  :disabled="locked"
                  data-busy-lock="1"
                  @click="removeObserved(item)"
                >
                  移出
                </NButton>
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
            </article>
          </TransitionGroup>
          <p v-if="lane.items.length === 0" class="db-lane__empty">暂无条目</p>
        </section>
      </div>
    </BlockCard>

    <!-- 我的想看 -->
    <BlockCard title="我的想看" subtitle="来自豆瓣 rexxar 的 kind=mark 列表（movie + tv）。">
      <template #actions>
        <NButton
          size="tiny"
          secondary
          :disabled="locked"
          data-busy-lock="1"
          @click="store.runAction('wish-sync-now', {})"
        >
          同步想看
        </NButton>
      </template>

      <div class="db-kv-grid db-kv-grid--tight">
        <div class="db-kv">
          <span class="db-kv__label">同步开关</span>
          <span class="db-kv__value">{{ flat.wish_sync_enabled ? '已开启' : '已关闭' }}</span>
        </div>
        <div class="db-kv">
          <span class="db-kv__label">上次同步</span>
          <span class="db-kv__value">{{ formatTime(wishInfo.last_sync) || '未同步' }}</span>
        </div>
        <div class="db-kv">
          <span class="db-kv__label">上次结果</span>
          <span class="db-kv__value">
            {{ wishInfo.last_status ? `${WISH_STATUS_LABEL[wishInfo.last_status] ?? wishInfo.last_status}（共 ${num(wishInfo.last_count)} 条，新增 ${num(wishInfo.last_new)}）` : '—' }}
          </span>
        </div>
        <div class="db-kv">
          <span class="db-kv__label">豆瓣 UID</span>
          <span class="db-kv__value">{{ text(wishInfo.uid) || '—' }}</span>
        </div>
        <div class="db-kv">
          <span class="db-kv__label">登录态来源</span>
          <span class="db-kv__value">{{ COOKIE_SOURCE_LABEL[text(wishInfo.source)] ?? (text(wishInfo.source) || '—') }}</span>
        </div>
      </div>

      <div v-if="wishInfo.last_error" class="db-banner db-banner--warning">
        <span class="db-banner__dot" />
        <span>上次同步错误：{{ wishInfo.last_error }}</span>
      </div>
      <div v-if="!flat.wish_sync_enabled" class="db-banner db-banner--info">
        <span class="db-banner__dot" />
        <span>「同步我的想看」当前关闭；到「设置」里打开后再点同步。</span>
      </div>

      <div v-if="!loaded" class="db-wish-list" role="status">
        <span class="db-sr">正在读取想看列表…</span>
        <div v-for="row in 4" :key="row" class="db-skel-card">
          <SkeletonBlock width="52px" height="78px" radius="8px" />
          <div class="db-skel-lines">
            <SkeletonBlock width="75%" height="11px" />
            <SkeletonBlock width="50%" height="9px" />
          </div>
        </div>
      </div>
      <div v-else-if="wishItems.length === 0" class="db-empty">
        <p>还没有想看数据。</p>
        <p class="db-empty__note">
          先在设置里粘贴浏览器里的豆瓣 Cookie（需含 dbcl2），再点「同步想看」。
        </p>
      </div>
      <TransitionGroup v-else tag="div" name="db-card" class="db-wish-list">
        <article v-for="(item, index) in wishItems" :key="item.douban_ref || index" class="db-wish-item">
          <PosterImg
            :url="item.poster_url"
            :title="text(item.title)"
            variant="thumb-sm"
            @zoom="onZoom(item, $event)"
          />
          <div class="db-wish-main">
            <a
              v-if="doubanHref(item)"
              class="db-item__title"
              :href="doubanHref(item)"
              target="_blank"
              rel="noreferrer noopener"
            >{{ text(item.title) || '(无标题)' }}</a>
            <span v-else class="db-item__title">{{ text(item.title) || '(无标题)' }}</span>
            <div class="db-item__meta">
              <StateBadge
                v-if="item.type"
                :label="TYPE_LABEL[item.type] ?? item.type"
                tone="info"
              />
              <span v-if="item.year">{{ item.year }}</span>
              <span v-if="item.added_at">加入 {{ formatTime(item.added_at) }}</span>
            </div>
            <StarBar v-if="num(item.rating) > 0" :value="item.rating" compact />
            <StateBadge :label="wishState(item).label" :tone="wishState(item).tone" />
          </div>
        </article>
      </TransitionGroup>
    </BlockCard>
  </div>
</template>

<style scoped>
.db-queue-panel {
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

.db-inline-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* 看板 */
.db-board {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 12px;
  align-items: start;
}

.db-lane {
  --tone: var(--db-muted, var(--app-text-secondary, #6b7280));
  display: grid;
  gap: 8px;
  align-content: start;
  min-width: 0;
  padding: 10px;
  border-radius: 13px;
  border: 1px solid color-mix(in srgb, var(--tone) 22%, var(--db-line, var(--app-border, #e3e6eb)));
  border-top: 3px solid var(--tone);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--tone) 8%, transparent),
    color-mix(in srgb, var(--app-bg, #f5f6f8) 40%, transparent) 120px
  );
}

.db-lane--warn {
  --tone: var(--db-warn, #f0a020);
}

.db-lane--info {
  --tone: var(--db-accent, #2080f0);
}

.db-lane--ok {
  --tone: var(--db-ok, #18a058);
}

.db-lane__head {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.db-lane__icon {
  width: 24px;
  height: 24px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 7px;
  color: var(--tone);
  background: color-mix(in srgb, var(--tone) 14%, transparent);
}

.db-lane__title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 650;
  overflow-wrap: anywhere;
}

.db-lane__count {
  min-width: 22px;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 650;
  line-height: 20px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  color: var(--tone);
  background: color-mix(in srgb, var(--tone) 14%, transparent);
}

.db-lane__note,
.db-lane__empty {
  margin: 0;
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 11px;
}

.db-lane__empty {
  padding: 14px 0;
  text-align: center;
  border: 1px dashed var(--db-line, var(--app-border, #e3e6eb));
  border-radius: 10px;
}

.db-lane__list {
  position: relative;
  display: grid;
  gap: 8px;
  max-height: 720px;
  overflow: auto;
  padding: 2px;
  margin: -2px;
}

.db-lane__list:empty {
  display: none;
}

.db-queue-item {
  display: grid;
  grid-template-columns: 62px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  padding: 10px;
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  border-radius: 11px;
  background: var(--app-surface, #fff);
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease,
    border-color 0.2s ease;
}

.db-queue-item:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--tone) 45%, var(--db-line, var(--app-border, #e3e6eb)));
  box-shadow: 0 8px 18px -12px color-mix(in srgb, var(--tone) 70%, transparent);
}

.db-queue-main,
.db-wish-main {
  display: grid;
  gap: 4px;
  min-width: 0;
  justify-items: start;
}

.db-item__title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  text-decoration: none;
  color: var(--app-text, #1f2329);
  overflow-wrap: anywhere;
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

.db-queue-due {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 11px;
  flex-wrap: wrap;
  width: 100%;
}

.db-queue-extra {
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 11px;
  overflow-wrap: anywhere;
  margin: 0;
}

.db-error-text {
  color: var(--db-err, #d03050);
  font-size: 11px;
  overflow-wrap: anywhere;
  margin: 0;
}

.db-queue-actions {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding-top: 8px;
  border-top: 1px dashed var(--db-line, var(--app-border, #e3e6eb));
}

/* 想看 */
.db-wish-list {
  position: relative;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
  max-height: 760px;
  overflow: auto;
  padding: 2px;
}

.db-wish-item {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  padding: 9px;
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  border-radius: 11px;
  background: color-mix(in srgb, var(--app-bg, #f5f6f8) 35%, transparent);
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

.db-wish-item:hover {
  border-color: color-mix(in srgb, var(--db-accent, #2080f0) 40%, var(--db-line, var(--app-border, #e3e6eb)));
  box-shadow: 0 8px 18px -14px color-mix(in srgb, var(--db-accent, #2080f0) 70%, transparent);
}

/* 骨架 */
.db-skel-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px;
  padding: 10px;
  border-radius: 11px;
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
}

.db-skel-lines {
  display: grid;
  gap: 8px;
  align-content: start;
  padding-top: 4px;
}

.db-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* TransitionGroup：卡片进出与位移（离场时脱离文档流，其余卡片平滑补位） */
.db-card-enter-active,
.db-card-leave-active {
  transition:
    opacity 0.28s ease,
    transform 0.28s ease;
}

.db-card-enter-from,
.db-card-leave-to {
  opacity: 0;
  transform: translateX(-12px) scale(0.98);
}

.db-card-leave-active {
  position: absolute;
  inset-inline: 2px;
}

.db-card-move {
  transition: transform 0.32s ease;
}

.db-kv-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 8px 14px;
}

.db-kv-grid--tight {
  gap: 6px 12px;
}

.db-kv {
  display: grid;
  gap: 1px;
  min-width: 0;
}

.db-kv__label {
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 11px;
}

.db-kv__value {
  font-size: 12px;
  overflow-wrap: anywhere;
}

.db-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  border: 1px solid transparent;
  overflow-wrap: anywhere;
}

.db-banner__dot {
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 50%;
  flex: none;
  background: currentColor;
}

.db-banner--info {
  color: var(--db-accent, #2080f0);
  background: color-mix(in srgb, var(--db-accent, #2080f0) 7%, transparent);
  border-color: color-mix(in srgb, var(--db-accent, #2080f0) 22%, transparent);
}

.db-banner--warning {
  color: var(--db-warn, #f0a020);
  background: color-mix(in srgb, var(--db-warn, #f0a020) 8%, transparent);
  border-color: color-mix(in srgb, var(--db-warn, #f0a020) 30%, transparent);
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

.db-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
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

@container page (max-width: 719.98px) {
  .db-queue-item {
    grid-template-columns: 48px minmax(0, 1fr);
  }

  .db-board {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  .db-queue-item,
  .db-wish-item,
  .db-card-enter-active,
  .db-card-leave-active,
  .db-card-move {
    transition: none;
  }

  .db-queue-item:hover {
    transform: none;
  }
}
</style>
