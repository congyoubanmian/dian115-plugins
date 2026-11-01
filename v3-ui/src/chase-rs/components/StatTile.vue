<script setup lang="ts">
// 指标瓦片：数值 + 名称（配色语义由 tone 决定，见 use-chase.ts 的 tiles）。

import type { Tile } from '../types'

defineProps<{ tile: Tile }>()
</script>

<template>
  <div class="tile" :class="`tile-${tile.tone}`">
    <div class="tile-value">{{ tile.value }}</div>
    <div class="tile-label">{{ tile.label }}</div>
  </div>
</template>
