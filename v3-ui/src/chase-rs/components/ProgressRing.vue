<script setup lang="ts">
// 双层进度环（纯 SVG）：外环 = Emby 已入库 / 目标，内环 = 订阅集数 / 目标。
// 中间是海报（若状态文档带了地址）或首字头像。

import { computed, ref } from 'vue'
import type { RingData } from '../visuals'

const props = defineProps<{ ring: RingData; poster: string; initial: string; tone: number; size?: number }>()
const broken = ref(false)
const showPoster = computed(() => props.poster !== '' && !broken.value)
</script>

<template>
  <div class="ring" :class="`ring-tone-${tone}`" :style="{ '--ring-size': `${size ?? 64}px` }" role="img" :aria-label="ring.label">
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <circle class="ring-track" cx="32" cy="32" r="29" pathLength="100" />
      <circle
        v-if="ring.havePct >= 0"
        class="ring-have"
        cx="32"
        cy="32"
        r="29"
        pathLength="100"
        :style="{ strokeDasharray: `${ring.havePct} 100` }"
      />
      <circle class="ring-track ring-track-in" cx="32" cy="32" r="24" pathLength="100" />
      <circle class="ring-sub" cx="32" cy="32" r="24" pathLength="100" :style="{ strokeDasharray: `${ring.subPct} 100` }" />
    </svg>
    <span class="ring-face">
      <img v-if="showPoster" :src="poster" alt="" loading="lazy" referrerpolicy="no-referrer" @error="broken = true" />
      <span v-else class="ring-initial">{{ initial }}</span>
    </span>
  </div>
</template>
