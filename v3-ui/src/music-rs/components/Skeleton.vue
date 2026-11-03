<script setup lang="ts">
// 骨架屏：数据第一次读回之前的占位（流光效果；减少动效时静止）。

withDefaults(defineProps<{ count?: number; variant?: 'row' | 'card' | 'tile' }>(), {
  count: 3,
  variant: 'row',
})
</script>

<template>
  <div class="sk" :class="`sk--${variant}`" role="status" aria-label="加载中">
    <div v-for="index in count" :key="index" class="sk__item">
      <span class="sk__block sk__art" />
      <span class="sk__lines">
        <span class="sk__block sk__line" />
        <span class="sk__block sk__line sk__line--short" />
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
  border: 1px solid color-mix(in srgb, var(--app-border, #e0e4ea) 70%, transparent);
}

.sk--card .sk__item {
  flex-direction: column;
  align-items: stretch;
}

.sk--tile .sk__item {
  flex-direction: column-reverse;
  align-items: flex-start;
  border: none;
  background: color-mix(in srgb, var(--app-surface, #fff) 55%, transparent);
}

.sk__lines {
  flex: 1;
  display: grid;
  gap: 7px;
  width: 100%;
}

.sk__block {
  display: block;
  border-radius: 7px;
  background: linear-gradient(
      100deg,
      transparent 20%,
      color-mix(in srgb, var(--app-surface, #fff) 70%, transparent) 50%,
      transparent 80%
    )
    0 0 / 200% 100% no-repeat,
    color-mix(in srgb, var(--app-text, #333) 8%, transparent);
  animation: sk-shimmer 1.4s linear infinite;
}

.sk__art {
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 10px;
}

.sk--card .sk__art {
  width: 100%;
  height: auto;
  aspect-ratio: 1;
}

.sk--tile .sk__art {
  width: 46px;
  height: 22px;
}

.sk__line {
  height: 10px;
}

.sk__line--short {
  width: 55%;
}

.sk--tile .sk__line--short {
  display: none;
}

@keyframes sk-shimmer {
  from {
    background-position: 150% 0, 0 0;
  }
  to {
    background-position: -50% 0, 0 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sk__block {
    animation: none;
  }
}
</style>
