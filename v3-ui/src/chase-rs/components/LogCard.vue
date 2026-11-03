<script setup lang="ts">
// 最近动作：状态文档里的运行日志（最近 8 条，新的在前）。

import { computed } from 'vue'
import { History } from '@lucide/vue'
import { num, text, timeLongAt } from '../format'
import { useChaseStore } from '../use-chase'

const store = useChaseStore()

// 键用「时间 + 文案」（同键再加序号）：新日志进来时旧行的键不变，过渡只作用在新行上。
const recent = computed(() => {
  const seen = new Map<string, number>()
  return store.logs
    .slice(-8)
    .map((entry) => {
      const base = `${entry.at ?? ''}|${text(entry.message, '')}`
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      return { ...entry, key: `${base}|${n}` }
    })
    .reverse()
})
</script>

<template>
  <section class="card c-logs">
    <div class="card-head">
      <div class="card-title">
        <span class="card-icon"><History :size="16" aria-hidden="true" /></span>
        <h3>最近动作</h3>
      </div>
      <span class="card-head-meta">
        {{ store.ctx.id }} · 状态文档 revision {{ num(store.state?.revision, 0) }}
      </span>
    </div>
    <p v-if="store.logs.length === 0" class="muted-line">还没有运行日志。</p>
    <TransitionGroup v-else tag="ul" name="c-list" class="c-log-list">
      <li
        v-for="entry in recent"
        :key="entry.key"
        :class="`log-${text(entry.level, 'info')}`"
      >
        <span class="log-dot" aria-hidden="true" />
        <span class="log-time">{{ timeLongAt(entry.at) }}</span>
        <span class="log-msg">{{ text(entry.message, '') }}</span>
      </li>
    </TransitionGroup>
  </section>
</template>
