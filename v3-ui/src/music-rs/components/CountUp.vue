<script setup lang="ts">
// 数字滚动：值变化时从旧值缓动到新值（约 0.7 秒）；减少动效时直接跳到新值。

import { onBeforeUnmount, ref, watch } from 'vue'
import { prefersReducedMotion } from '../ui-kit'

const props = defineProps<{ value: number }>()

const shown = ref(0)
let frame: number | null = null

function stop(): void {
  if (frame !== null) {
    globalThis.cancelAnimationFrame?.(frame)
    frame = null
  }
}

watch(
  () => props.value,
  (target) => {
    stop()
    const from = shown.value
    const raf = globalThis.requestAnimationFrame
    if (from === target || !raf || prefersReducedMotion()) {
      shown.value = target
      return
    }
    const started = Date.now()
    const step = (): void => {
      const t = Math.min(1, (Date.now() - started) / 700)
      const eased = 1 - Math.pow(1 - t, 3)
      shown.value = Math.round(from + (target - from) * eased)
      frame = t < 1 ? raf(step) : null
    }
    frame = raf(step)
  },
  { immediate: true },
)

onBeforeUnmount(stop)
</script>

<template>
  <span class="count-up">{{ shown }}</span>
</template>

<style scoped>
.count-up {
  font-variant-numeric: tabular-nums;
}
</style>
