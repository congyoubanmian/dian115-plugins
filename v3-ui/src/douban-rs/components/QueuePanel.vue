<script setup lang="ts">
// 观察队列 / 我的想看 双栏（对应原生版的 renderQueue）。
//
// 左栏：观察队列（榜单/想看新条目先入队；墓碑与过滤器在自动路径生效）。
// 右栏：我的想看（同步开关、上次同步结果、条目列表）。
// 队列条目支持逐条「立即订阅」「移出」；面板头部提供「订阅全部到期条目」的批量入口。

import { computed } from 'vue'
import { NButton } from 'naive-ui'
import { ExternalLink } from '@lucide/vue'
import { QUEUE_STATE_META, TYPE_LABEL } from '../constants'
import { doubanHref, dueLabel, formatTime, listTitle, num, text } from '../format'
import { useDoubanStore } from '../store'
import type { QueueItem, WishItem } from '../types'
import BlockCard from './BlockCard.vue'
import PosterImg from './PosterImg.vue'
import StateBadge from './StateBadge.vue'

const emit = defineEmits<{
  (e: 'zoom', payload: { url: string; title: string; href?: string }): void
}>()

const store = useDoubanStore()
const { queueItems, wishItems, wishInfo, flat, queueIndex, dueItems, busy } = store

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

function wishState(item: WishItem): { label: string; tone: string } {
  const queued = item.douban_ref ? queueIndex.value.get(item.douban_ref) : undefined
  if (!queued) return { label: '未入队', tone: 'muted' }
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

    <div class="db-duo">
      <!-- 左：观察队列 -->
      <BlockCard title="观察队列" subtitle="榜单/想看新条目先入队；墓碑与过滤器在自动路径生效。">
        <div v-if="queueItems.length === 0" class="db-empty">
          <p>观察队列为空。</p>
          <p class="db-empty__note">刷新榜单或同步想看后，通过过滤的新条目会出现在这里。</p>
        </div>
        <div v-else class="db-queue-list">
          <article v-for="(item, index) in queueItems" :key="item.douban_ref || index" class="db-queue-item">
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
                <span v-if="num(item.rating) > 0" class="db-rate">★ {{ item.rating }}</span>
              </div>

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
        </div>
      </BlockCard>

      <!-- 右：我的想看 -->
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
              {{ wishInfo.last_status ? `${wishInfo.last_status}（共 ${num(wishInfo.last_count)} 条，新增 ${num(wishInfo.last_new)}）` : '—' }}
            </span>
          </div>
          <div class="db-kv">
            <span class="db-kv__label">豆瓣 UID</span>
            <span class="db-kv__value">{{ text(wishInfo.uid) || '—' }}</span>
          </div>
          <div class="db-kv">
            <span class="db-kv__label">登录态来源</span>
            <span class="db-kv__value">{{ text(wishInfo.source) || '—' }}</span>
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

        <div v-if="wishItems.length === 0" class="db-empty">
          <p>还没有想看数据。</p>
          <p class="db-empty__note">
            先在设置里粘贴浏览器里的豆瓣 Cookie（需含 dbcl2），再点「同步想看」。
          </p>
        </div>
        <div v-else class="db-wish-list">
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
                <span v-if="num(item.rating) > 0" class="db-rate">★ {{ item.rating }}</span>
                <span v-if="item.added_at">加入 {{ formatTime(item.added_at) }}</span>
              </div>
              <StateBadge :label="wishState(item).label" :tone="wishState(item).tone" />
            </div>
          </article>
        </div>
      </BlockCard>
    </div>
  </div>
</template>

<style scoped>
.db-queue-panel {
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

.db-inline-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.db-duo {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
  gap: 14px;
  align-items: start;
}

.db-queue-list,
.db-wish-list {
  display: grid;
  gap: 10px;
  max-height: 760px;
  overflow: auto;
  padding-right: 2px;
}

.db-queue-item {
  display: grid;
  grid-template-columns: 62px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
  padding: 10px;
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  border-radius: 11px;
  background: color-mix(in srgb, var(--app-bg, #f5f6f8) 35%, transparent);
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
  font-weight: 550;
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

.db-rate {
  color: #e6a23c;
  font-weight: 600;
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
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: stretch;
}

.db-wish-item {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  padding: 9px;
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  border-radius: 11px;
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

@media (max-width: 1080px) {
  .db-duo {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 720px) {
  .db-queue-item {
    grid-template-columns: 48px minmax(0, 1fr);
  }

  .db-queue-actions {
    grid-column: 1 / -1;
    flex-direction: row;
    flex-wrap: wrap;
  }
}
</style>
