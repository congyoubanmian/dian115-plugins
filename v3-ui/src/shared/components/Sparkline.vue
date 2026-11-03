<script setup lang="ts">
// 共享迷你折线（纯 SVG）：数据点少于 2 个时不渲染。
//
// 从 chase-rs/components/Sparkline.vue 抽出；根元素保留 `.spark` 类名，
// 这样 chase 在 styles.css 里已有的 .spark / .spark-area / .spark-line
// 规则仍然命中，视觉与迁移前一致。其他插件没有这些规则时用本组件的 scoped 兜底样式。

import { computed } from 'vue'
import { sparkPath } from './sparkline'

const props = defineProps<{ series: number[]; label: string }>()
const path = computed(() => sparkPath(props.series))
</script>

<template>
  <svg v-if="path.line" class="spark" viewBox="0 0 100 28" preserveAspectRatio="none" role="img" :aria-label="label">
    <path class="spark-area" :d="path.area" />
    <path class="spark-line" :d="path.line" vector-effect="non-scaling-stroke" />
  </svg>
</template>

<style scoped>
.spark {
  display: block;
  width: 100%;
  height: 30px;
  overflow: visible;
}

.spark-area {
  fill: color-mix(in srgb, var(--tone, var(--ui-accent, #2080f0)) 16%, transparent);
}

.spark-line {
  fill: none;
  stroke: var(--tone, var(--ui-accent, #2080f0));
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
