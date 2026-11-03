<script setup lang="ts">
// 共享骨架屏列表：数据第一次读回之前的占位。
//
// 合并 music-rs/components/Skeleton.vue 的 count/variant，内部统一用 SkeletonBlock；
// 布局类名保留 .sk / .sk--row|card|tile / .sk__*，迁移后的页面不需要重写父级样式。
// 动效在 SkeletonBlock 内部处理（shimmer，减少动效时静止）。

import { computed } from 'vue'
import SkeletonBlock from './SkeletonBlock.vue'

const props = withDefaults(
  defineProps<{
    count?: number
    variant?: 'row' | 'card' | 'tile'
  }>(),
  {
    count: 3,
    variant: 'row',
  },
)

const artWidth = computed(() => (props.variant === 'card' ? '100%' : props.variant === 'tile' ? '46px' : '40px'))
const artHeight = computed(() => (props.variant === 'card' ? 'auto' : props.variant === 'tile' ? '22px' : '40px'))
</script>

<template>
  <div class="sk" :class="`sk--${variant}`" role="status" aria-label="加载中">
    <div v-for="index in count" :key="index" class="sk__item">
      <SkeletonBlock class="sk__art" :width="artWidth" :height="artHeight" radius="10px" />
      <span class="sk__lines">
        <SkeletonBlock class="sk__line" width="100%" height="10px" radius="7px" />
        <SkeletonBlock class="sk__line sk__line--short" width="55%" height="10px" radius="7px" />
      </span>
    </div>
  </div>
</template>

<style scoped>
.sk {
  display: grid;
  gap: 10px;
}

.sk--card {
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px;
}

.sk--tile {
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
}

.sk__item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--ui-border, #e0e4ea) 70%, transparent);
  min-width: 0;
}

.sk--card .sk__item {
  flex-direction: column;
  align-items: stretch;
}

.sk--tile .sk__item {
  flex-direction: column-reverse;
  align-items: flex-start;
  border: none;
  background: color-mix(in srgb, var(--ui-surface, #fff) 55%, transparent);
}

.sk__art {
  flex: none;
}

.sk--card .sk__art {
  width: 100%;
  aspect-ratio: 1;
}

.sk__lines {
  flex: 1;
  display: grid;
  gap: 7px;
  width: 100%;
  min-width: 0;
}

.sk__line--short {
  width: 55%;
}

.sk--tile .sk__line--short {
  display: none;
}
</style>
