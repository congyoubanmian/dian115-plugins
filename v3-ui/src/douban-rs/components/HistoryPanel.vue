<script setup lang="ts">
// 历史与日志（对应原生版的 renderHistory）。
//
// 三块：订阅历史表、运行日志列表、黑名单命中记录。
// 头部动作：归档历史与日志（危险操作，二次确认）、通知自检。

import { computed } from 'vue'
import { NButton } from 'naive-ui'
import { formatTime, listTitle, num } from '../format'
import { useDoubanStore } from '../store'
import BlockCard from './BlockCard.vue'
import StateBadge from './StateBadge.vue'

const store = useDoubanStore()
const { historyItems, logItems, blackState, busy } = store

const locked = computed(() => busy.value !== '')

function archive(): void {
  void store.runAction('archive', {}, {
    label: '归档历史与日志',
    confirm:
      '归档会清空历史、日志、黑名单命中与统计（不会清除「已删除不重订」墓碑集）。继续吗？',
  })
}
</script>

<template>
  <div class="db-history">
    <div class="db-panel-head">
      <div class="db-panel-head__text">
        <h2 class="db-panel-title">历史与日志</h2>
        <p class="db-panel-sub">
          当前展示 {{ historyItems.length }} 条历史、{{ logItems.length }} 条日志（落盘日志只保留最近 40 条）；
          归档会清空历史/日志/黑名单命中，不会清除重订墓碑。
        </p>
      </div>
      <div class="db-inline-actions">
        <NButton
          size="small"
          type="error"
          secondary
          :disabled="locked"
          data-busy-lock="1"
          @click="archive"
        >
          归档历史与日志
        </NButton>
        <NButton
          size="small"
          secondary
          :disabled="locked"
          data-busy-lock="1"
          @click="store.runAction('send-test', {})"
        >
          通知自检
        </NButton>
      </div>
    </div>

    <!-- 订阅历史 -->
    <BlockCard title="订阅历史" subtitle="result=succeeded 且 action=subscribe 才计入订阅统计。">
      <div v-if="historyItems.length === 0" class="db-empty">
        <p>还没有订阅历史。</p>
        <p class="db-empty__note">观察期到期或手动订阅后，这里会记录成功/失败与原因。</p>
      </div>
      <div v-else class="db-scroll">
        <table class="db-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>条目</th>
              <th>来源</th>
              <th>动作</th>
              <th>结果</th>
              <th>消息</th>
              <th>TMDB</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(entry, index) in historyItems" :key="index">
              <td class="db-nowrap" data-label="时间">
                <div class="db-cell-value">{{ formatTime(entry.created_at) || '—' }}</div>
              </td>
              <td data-label="条目">
                <div class="db-cell-value">
                  <span class="db-item-title">{{ entry.title || entry.douban_ref || '—' }}</span>
                  <div v-if="entry.douban_ref" class="db-mono db-sub">{{ entry.douban_ref }}</div>
                </div>
              </td>
              <td data-label="来源">
                <div class="db-cell-value">{{ entry.list ? listTitle(entry.list) : '—' }}</div>
              </td>
              <td data-label="动作">
                <div class="db-cell-value">{{ entry.action || '—' }}</div>
              </td>
              <td data-label="结果">
                <div class="db-cell-value">
                  <StateBadge
                    :label="entry.result || '未知'"
                    :tone="entry.result === 'succeeded' ? 'ok' : 'error'"
                  />
                </div>
              </td>
              <td class="db-wrap db-cell--wide" data-label="消息">
                <div class="db-cell-value">{{ entry.message || '—' }}</div>
              </td>
              <td class="db-mono db-nowrap" data-label="TMDB">
                <div class="db-cell-value">{{ entry.tmdb_ref || (entry.intent_id ? `#${entry.intent_id}` : '—') }}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </BlockCard>

    <!-- 运行日志 -->
    <BlockCard title="运行日志" subtitle="单条日志按后端规则截断到 400 字节；落盘只保留最近 40 条。">
      <div v-if="logItems.length === 0" class="db-empty">
        <p>暂无日志。</p>
      </div>
      <div v-else class="db-log-list">
        <div v-for="(entry, index) in logItems" :key="index" class="db-log-row">
          <span class="db-log-time">{{ formatTime(entry.at) || entry.at || '—' }}</span>
          <span class="db-log-dot" :class="`db-log-dot--${entry.level || 'info'}`" />
          <span class="db-log-msg">{{ entry.message || '' }}</span>
        </div>
      </div>
    </BlockCard>

    <!-- 黑名单命中 -->
    <BlockCard title="黑名单命中" :subtitle="`累计命中 ${num(blackState.hits)} 次；最近命中保留 20 条。`">
      <div v-if="(blackState.recent ?? []).length === 0" class="db-empty">
        <p>还没有黑名单命中记录。</p>
      </div>
      <div v-else class="db-hit-list">
        <div v-for="(hit, index) in blackState.recent" :key="index" class="db-hit-row">
          <span class="db-item-title">{{ hit.title || '—' }}</span>
          <StateBadge :label="hit.keyword || '—'" tone="warn" />
          <span class="db-sub">{{ formatTime(hit.at) || '—' }}</span>
        </div>
      </div>
    </BlockCard>
  </div>
</template>

<style scoped>
.db-history {
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

.db-scroll {
  overflow: auto;
  max-width: 100%;
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  border-radius: 10px;
}

.db-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  min-width: 720px;
}

.db-table th,
.db-table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  vertical-align: top;
}

.db-table th {
  position: sticky;
  top: 0;
  background: var(--app-surface, #fff);
  font-weight: 600;
  white-space: nowrap;
  z-index: 1;
}

.db-table tr:last-child td {
  border-bottom: none;
}

.db-nowrap {
  white-space: nowrap;
}

.db-wrap {
  overflow-wrap: anywhere;
  min-width: 180px;
}

.db-sub {
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 11px;
  margin-top: 2px;
  overflow-wrap: anywhere;
}

.db-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
}

.db-item-title {
  font-size: 13px;
  font-weight: 550;
}

.db-log-list {
  display: grid;
  gap: 5px;
  max-height: 420px;
  overflow: auto;
}

.db-log-row {
  display: grid;
  grid-template-columns: 108px 8px minmax(0, 1fr);
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
}

.db-log-time {
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}

.db-log-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  align-self: center;
  background: var(--db-muted, var(--app-text-secondary, #6b7280));
}

.db-log-dot--info {
  background: var(--db-accent, #2080f0);
}

.db-log-dot--warning {
  background: var(--db-warn, #f0a020);
}

.db-log-dot--error {
  background: var(--db-err, #d03050);
}

.db-log-msg {
  overflow-wrap: anywhere;
}

.db-hit-list {
  display: grid;
  gap: 6px;
}

.db-hit-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 7px 9px;
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  border-radius: 9px;
  font-size: 12px;
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

/* 窄容器：订阅历史表改成逐条卡片（不横向滚动），日志时间列再收窄。 */
@container page (max-width: 719.98px) {
  .db-scroll {
    overflow: visible;
    border: 0;
  }

  .db-table {
    display: block;
    min-width: 0;
  }

  .db-table thead {
    display: none;
  }

  .db-table tbody {
    display: block;
  }

  .db-table tr {
    display: block;
    padding: 8px 0;
    border-bottom: 1px solid var(--db-line, var(--ui-border, #e3e6eb));
  }

  .db-table tr:last-child {
    border-bottom: 0;
  }

  .db-table td {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr);
    column-gap: 8px;
    padding: 3px 0;
    border: 0;
  }

  .db-table td::before {
    content: attr(data-label);
    grid-column: 1;
    grid-row: 1;
    color: var(--db-muted, var(--ui-muted, #6b7280));
    font-size: 11px;
  }

  .db-table td > .db-cell-value {
    grid-column: 2;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .db-cell-value > * {
    overflow-wrap: anywhere;
  }

  .db-table td.db-cell--wide {
    grid-template-columns: minmax(0, 1fr);
  }

  .db-table td.db-cell--wide::before {
    display: none;
  }

  .db-table td.db-cell--wide > .db-cell-value {
    grid-column: 1;
  }

  .db-wrap {
    min-width: 0;
  }

  .db-nowrap {
    white-space: normal;
  }

  .db-log-row {
    grid-template-columns: 72px 8px minmax(0, 1fr);
  }
}
</style>
