<script setup lang="ts">
// 指标瓦片：递增数字 + 名称，可选迷你折线（按日分桶的日志）或占比环。
// 配色语义由 tone 决定（见 use-chase.ts 的 tiles）；布局按 key 在 bento 网格里放大。

import { computed } from 'vue'
import type { Tile } from '../types'
import { useCountUp } from '../visuals'
import Sparkline from './Sparkline.vue'

const props = defineProps<{
  tile: Tile
  series?: number[]
  seriesLabel?: string
  /** 占比环：part / whole（例如已判定 / 订阅池）。 */
  share?: { part: number; whole: number; label: string }
  index?: number
}>()

const shown = useCountUp(() => props.tile.value)
const sharePct = computed(() => {
  const s = props.share
  if (!s || s.whole <= 0) return -1
  return Math.max(0, Math.min(100, Math.round((s.part / s.whole) * 100)))
})
</script>

<template>
  <div
    class="tile"
    :class="[`tile-${tile.tone}`, `tile-k-${tile.key}`]"
    :style="{ '--i': index ?? 0 }"
  >
    <div class="tile-top">
      <div class="tile-label">{{ tile.label }}</div>
      <div class="tile-value">
        <span aria-hidden="true">{{ shown }}</span>
        <span class="sr-only">{{ tile.value }}</span>
      </div>
    </div>
    <div v-if="sharePct >= 0 && share" class="tile-share">
      <svg viewBox="0 0 40 40" class="tile-share-ring" role="img" :aria-label="`${share.label} ${sharePct}%`">
        <circle class="ring-track" cx="20" cy="20" r="16" pathLength="100" />
        <circle class="ring-have" cx="20" cy="20" r="16" pathLength="100" :style="{ strokeDasharray: `${sharePct} 100` }" />
      </svg>
      <span class="tile-share-text"><b>{{ sharePct }}%</b> {{ share.label }}</span>
    </div>
    <Sparkline v-if="series && series.length > 1" :series="series" :label="seriesLabel ?? tile.label" />
  </div>
</template>
