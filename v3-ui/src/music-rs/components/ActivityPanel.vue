<script setup lang="ts">
// 最近动作：插件 KV 里的运行日志（logs）+ 上一轮队列推进的摘要。
// 只呈现真实状态，不造数据。

import { computed } from 'vue'
import { formatTime, useMusicStore } from '../store'

const store = useMusicStore()
const { logs, lastPump } = store

const meta = computed(() => {
  const base = `最近 ${logs.value.length} 条`
  return lastPump.value?.at ? `${base} · 上轮推进 ${formatTime(lastPump.value.at)}` : base
})

/** 上一轮推进的最后一条消息。 */
const lastMessage = computed(() => {
  const messages = lastPump.value?.messages ?? []
  return messages.map((item) => String(item).trim()).filter(Boolean).pop() ?? ''
})

function dotClass(level: string): string {
  if (level === 'warning') return 'dot-warning'
  if (level === 'error') return 'dot-error'
  return 'dot-muted'
}
</script>

<template>
  <section class="music-card activity">
    <div class="row">
      <h3 class="card-title">最近动作</h3>
      <span class="spacer" />
      <span class="hint-inline">{{ meta }}</span>
    </div>

    <p v-if="lastMessage" class="hint">{{ lastMessage }}</p>

    <div v-if="logs.length" class="log-list">
      <div v-for="(entry, index) in logs" :key="`${entry.at}-${index}`" class="log-row">
        <span class="log-time">{{ formatTime(entry.at) }}</span>
        <span class="log-dot" :class="dotClass(entry.level)" />
        <span class="log-msg">{{ entry.message || '—' }}</span>
      </div>
    </div>
    <p v-else class="hint">还没有记录。</p>
  </section>
</template>

<style scoped>
.music-card {
  border: 1px solid var(--app-border, #e0e4ea);
  border-radius: 16px;
  background: var(--app-surface, #fff);
  padding: 20px 24px;
  display: grid;
  gap: 12px;
  min-width: 0;
  box-shadow: var(--mx-shadow, none);
}

@container music-page (max-width: 560px) {
  .music-card {
    padding: 14px;
  }
}

.row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.spacer {
  flex: 1;
}

.card-title {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
}

.hint {
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.45));
  font-size: 12px;
  margin: 0;
  line-height: 1.6;
}

.hint-inline {
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.45));
  font-size: 12px;
}

.log-list {
  position: relative;
  display: grid;
  gap: 2px;
  max-height: 260px;
  overflow: auto;
}

.log-row {
  position: relative;
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 12px;
  padding: 5px 8px;
  border-radius: 8px;
}

.log-row:hover {
  background: color-mix(in srgb, var(--app-text, #000) 4%, transparent);
}

.log-time {
  font-variant-numeric: tabular-nums;
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.45));
  flex: none;
}

.log-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 18%, transparent);
  flex: none;
  align-self: center;
}

.dot-muted {
  color: color-mix(in srgb, var(--mx-accent, #2080f0) 55%, var(--app-border, #c8cdd6));
}

.dot-warning {
  color: var(--mx-warn, #f0a020);
}

.dot-error {
  color: var(--mx-err, #d03050);
}

.log-msg {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
