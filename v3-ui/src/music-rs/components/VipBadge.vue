<script setup lang="ts">
// 歌曲会员/付费标签：VIP / SVIP / 付费专辑。
// 数据来自 lib/vip-tag.js 的 songVipTag（网易 fee、QQ pay），没有标识时不渲染。

import { computed } from 'vue'

const props = defineProps<{ tag?: string }>()
const label = computed(() => ({ svip: 'SVIP', vip: 'VIP', paid: '付费专辑' })[props.tag ?? ''] ?? '')
</script>

<template>
  <span v-if="label" class="vip-tag" :class="`vip-tag--${tag}`">{{ label }}</span>
</template>

<style scoped>
/* 文字色与 QualityTag 同思路：向 --app-text 混一档，明/暗主题都有可读对比度
   （之前是固定深色系 #a16207/#c2410c，深色背景下糊成一团）。 */
.vip-tag {
  --q: var(--app-text-secondary, #6b7280);
  flex: none;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.6;
  padding: 0 5px;
  border-radius: 5px;
  letter-spacing: 0.02em;
  white-space: nowrap;
  color: var(--q);
}

.vip-tag--vip {
  --q: color-mix(in srgb, #f59e0b 65%, var(--app-text, #1f2329));
  background: color-mix(in srgb, #f59e0b 18%, transparent);
  border: 1px solid color-mix(in srgb, #f59e0b 35%, transparent);
}

.vip-tag--svip {
  --q: color-mix(in srgb, #f97316 62%, var(--app-text, #1f2329));
  background: linear-gradient(
    135deg,
    color-mix(in srgb, #f97316 24%, transparent),
    color-mix(in srgb, #ef4444 18%, transparent)
  );
  border: 1px solid color-mix(in srgb, #f97316 42%, transparent);
}

.vip-tag--paid {
  --q: color-mix(in srgb, #8b5cf6 68%, var(--app-text, #1f2329));
  background: color-mix(in srgb, #8b5cf6 16%, transparent);
  border: 1px solid color-mix(in srgb, #8b5cf6 32%, transparent);
}
</style>
