<script setup lang="ts">
// 共享统计卡网格：只做展示与 select 事件转发。
//
// music-rs 原先在 components/StatTiles.vue 里用 store 计算 count/tiles；
// 这部分业务计算搬到页面（或本地组合式），本组件只接收 items。
//
// 默认 4 列；`@container page (max-width:719.98px)` 降为 2 列。
// 容器名统一为 page（插件页面根节点 / 滚动根上声明 container: page / inline-size）。
// loading 时复用共享 Skeleton（tile / card 两种占位形态）。

import { computed } from 'vue'
import StatTile from './StatTile.vue'
import Skeleton from './Skeleton.vue'
import type { StatTileItem } from './types'

const props = withDefaults(
  defineProps<{
    items: StatTileItem[]
    loading?: boolean
    columns?: number
    variant?: 'stat' | 'card' | 'bento'
    interactive?: boolean
  }>(),
  {
    loading: false,
    columns: 4,
    variant: 'stat',
    interactive: false,
  },
)

const emit = defineEmits<{ (event: 'select', key: string): void }>()

const gridStyle = computed<Record<string, string>>(() => ({
  '--ui-tile-columns': String(props.columns),
}))

const skeletonVariant = computed<'card' | 'tile'>(() => (props.variant === 'card' ? 'card' : 'tile'))
</script>

<template>
  <Skeleton
    v-if="loading"
    class="ui-tiles"
    :style="gridStyle"
    :variant="skeletonVariant"
    :count="items.length || columns"
  />
  <div v-else class="ui-tiles" :style="gridStyle">
    <StatTile
      v-for="(item, index) in items"
      :key="item.key"
      :label="item.label"
      :value="item.value"
      :hint="item.hint"
      :icon="item.icon"
      :tone="item.tone"
      :loading="item.loading"
      :series="item.series"
      :series-label="item.seriesLabel"
      :share="item.share"
      :index="item.index ?? index"
      :tile-key="item.tileKey ?? item.key"
      :interactive="interactive || item.interactive"
      :live="item.live"
      :aria-label="item.ariaLabel"
      :variant="item.variant ?? variant"
      @select="emit('select', item.key)"
    />
  </div>
</template>

<style scoped>
.ui-tiles.ui-tiles {
  display: grid;
  grid-template-columns: repeat(var(--ui-tile-columns, 4), minmax(0, 1fr));
  gap: var(--ui-gap, 10px);
  min-width: 0;
}

@container page (max-width: 719.98px) {
  .ui-tiles.ui-tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
