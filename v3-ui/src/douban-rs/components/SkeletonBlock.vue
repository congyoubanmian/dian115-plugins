<script setup lang="ts">
// 骨架屏占位块（微光扫过）。纯装饰：读屏信息由外层的 role="status" 文本提供。

withDefaults(defineProps<{ width?: string; height?: string; radius?: string }>(), {
  width: '100%',
  height: '12px',
  radius: '6px',
})
</script>

<template>
  <span class="db-skel" aria-hidden="true" :style="{ width, height, borderRadius: radius }" />
</template>

<style scoped>
.db-skel {
  display: block;
  position: relative;
  overflow: hidden;
  background: color-mix(in srgb, var(--app-text, #1f2329) 8%, transparent);
}

.db-skel::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--app-surface, #fff) 55%, transparent),
    transparent
  );
  animation: db-shimmer 1.4s ease-in-out infinite;
}

@keyframes db-shimmer {
  to {
    transform: translateX(100%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .db-skel::after {
    animation: none;
    display: none;
  }
}
</style>
