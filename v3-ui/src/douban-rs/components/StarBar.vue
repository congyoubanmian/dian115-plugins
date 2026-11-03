<script setup lang="ts">
// 评分星条：五颗星按豆瓣 10 分制裁切填充，旁边保留原始分值文本。

import { computed } from 'vue'
import { ratingPercent } from '../motion'

const props = withDefaults(defineProps<{ value: unknown; compact?: boolean }>(), { compact: false })

const percent = computed(() => ratingPercent(props.value))
const label = computed(() => String(props.value ?? ''))
</script>

<template>
  <span v-if="percent >= 0" class="db-stars" :class="{ 'db-stars--compact': props.compact }" :title="`豆瓣评分 ${label}`">
    <span class="db-stars__track" role="img" :aria-label="`豆瓣评分 ${label} 分（满分 10）`">
      <span class="db-stars__base" aria-hidden="true">★★★★★</span>
      <span class="db-stars__fill" aria-hidden="true" :style="{ width: `${percent}%` }">★★★★★</span>
    </span>
    <span class="db-stars__num" aria-hidden="true">{{ label }}</span>
  </span>
</template>

<style scoped>
.db-stars {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  line-height: 1;
}

.db-stars__track {
  position: relative;
  display: inline-block;
  letter-spacing: 1px;
  font-size: 12px;
}

.db-stars--compact .db-stars__track {
  font-size: 10px;
}

.db-stars__base {
  color: color-mix(in srgb, var(--app-text, #1f2329) 16%, transparent);
}

.db-stars__fill {
  position: absolute;
  inset: 0 auto 0 0;
  overflow: hidden;
  white-space: nowrap;
  color: var(--db-star, #e6a23c);
  text-shadow: 0 0 6px color-mix(in srgb, var(--db-star, #e6a23c) 35%, transparent);
}

.db-stars__num {
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  color: var(--db-star, #e6a23c);
}
</style>
