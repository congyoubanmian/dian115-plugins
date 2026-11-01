<script setup lang="ts">
// 最近动作：状态文档里的运行日志（最近 8 条，新的在前）。

import { num, text, timeLongAt } from '../format'
import { useChaseStore } from '../use-chase'

const store = useChaseStore()
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h3>最近动作</h3>
      <span class="card-head-meta">
        {{ store.ctx.id }} · 状态文档 revision {{ num(store.state?.revision, 0) }}
      </span>
    </div>
    <p v-if="store.logs.length === 0" class="muted-line">还没有运行日志。</p>
    <ul v-else class="c-log-list">
      <li v-for="(entry, index) in store.logs.slice(-8).reverse()" :key="`${entry.at ?? ''}-${index}`">
        <span class="log-time">{{ timeLongAt(entry.at) }}</span>
        <span class="log-msg">{{ text(entry.message, '') }}</span>
      </li>
    </ul>
  </section>
</template>
