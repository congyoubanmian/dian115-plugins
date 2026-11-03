<script setup lang="ts">
// 共享骨架占位块（微光扫过）。纯装饰：读屏信息由外层 role="status" 文本提供。
//
// 合并 douban-rs/components/SkeletonBlock.vue 的 width/height/radius，
// 新增 shimmer?:boolean（默认 true，保持豆瓣原来的微光观感）。
// 根 class 不设 inheritAttrs:false，父级传入的 class（例如 ChartWall 的
// .db-skeleton-poster）会合并到根元素上，父级 scoped 样式继续命中。

withDefaults(
  defineProps<{
    width?: string
    height?: string
    radius?: string
    shimmer?: boolean
  }>(),
  {
    width: '100%',
    height: '12px',
    radius: '6px',
    shimmer: true,
  },
)
</script>

<template>
  <span
    class="ui-skel"
    :class="{ 'ui-skel--shimmer': shimmer }"
    aria-hidden="true"
    :style="{ width, height, borderRadius: radius }"
  />
</template>

<style scoped>
.ui-skel {
  display: block;
  position: relative;
  overflow: hidden;
  background: color-mix(in srgb, var(--ui-text, #1f2329) 8%, transparent);
}

.ui-skel--shimmer::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--ui-surface, #fff) 55%, transparent),
    transparent
  );
  animation: ui-skel-shimmer 1.4s ease-in-out infinite;
}

@keyframes ui-skel-shimmer {
  to {
    transform: translateX(100%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ui-skel--shimmer::after {
    animation: none;
    display: none;
  }
}
</style>
