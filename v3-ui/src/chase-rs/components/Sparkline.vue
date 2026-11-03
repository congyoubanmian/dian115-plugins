<script setup lang="ts">
// 迷你折线（纯 SVG）：数据点少于 2 个时不渲染。

import { computed } from 'vue'
import { sparkPath } from '../visuals'

const props = defineProps<{ series: number[]; label: string }>()
const path = computed(() => sparkPath(props.series))
</script>

<template>
  <svg v-if="path.line" class="spark" viewBox="0 0 100 28" preserveAspectRatio="none" role="img" :aria-label="label">
    <path class="spark-area" :d="path.area" />
    <path class="spark-line" :d="path.line" vector-effect="non-scaling-stroke" />
  </svg>
</template>
