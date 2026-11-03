<script setup lang="ts">
// 共享提示条：右下角（默认）/ 右上角，成功 / 失败 / 警告 / 提示四色。
//
// 合并 chase ToastHost、douban ToastHost、music Toasts 三个实现：
// - items 必需，直接传各插件的 store.toasts；
// - position 默认 bottom-right（douban/music 现有位置），chase 需要时传 top-right；
// - zIndex 默认 80（douban），music 传 50、chase 按需；
// - 固定层宽 min(420px, calc(100vw - 32px))，390px 视口下为 358px。
//
// 提示条在 .c-shell / .music-shell 外面，fixed 定位相对视口，不使用容器查询。

import { computed } from 'vue'
import type { ToastItemLike } from './types'

const props = withDefaults(
  defineProps<{
    items: ToastItemLike[]
    position?: 'top-right' | 'bottom-right'
    zIndex?: number
    maxWidth?: string
  }>(),
  {
    position: 'bottom-right',
    zIndex: 80,
  },
)

const layerStyle = computed<Record<string, string | number>>(() => {
  const style: Record<string, string | number> = { zIndex: props.zIndex }
  if (props.maxWidth) style.maxWidth = props.maxWidth
  return style
})
</script>

<template>
  <TransitionGroup
    tag="div"
    name="ui-toast"
    class="ui-toasts"
    :class="`ui-toasts--${position}`"
    :style="layerStyle"
    role="status"
    aria-live="polite"
  >
    <div v-for="item in items" :key="item.id" class="ui-toast" :class="`ui-toast--${item.kind}`" role="status">
      {{ item.message }}
    </div>
  </TransitionGroup>
</template>

<style scoped>
.ui-toasts {
  position: fixed;
  right: 16px;
  z-index: 80;
  display: grid;
  gap: 8px;
  width: min(420px, calc(100vw - 32px));
  max-width: 100%;
  pointer-events: none;
}

.ui-toasts--top-right {
  top: 16px;
}

.ui-toasts--bottom-right {
  bottom: 16px;
}

.ui-toast {
  padding: 10px 14px;
  border-radius: 12px;
  color: #fff;
  font-size: 13px;
  line-height: 1.45;
  box-shadow:
    0 0 0 1px color-mix(in srgb, #fff 18%, transparent) inset,
    0 10px 28px -10px color-mix(in srgb, var(--ui-text, #000) 45%, transparent);
  overflow-wrap: anywhere;
}

.ui-toast--success {
  background: var(--ui-ok, #18a058);
}

.ui-toast--error {
  background: var(--ui-err, #d03050);
}

.ui-toast--warning {
  background: var(--ui-warn, #f0a020);
}

.ui-toast--info {
  background: var(--ui-info, var(--ui-accent, #2080f0));
}

.ui-toast-enter-active,
.ui-toast-leave-active {
  transition:
    opacity 0.22s ease,
    transform 0.22s ease;
}

.ui-toast-enter-from,
.ui-toast-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.96);
}

.ui-toast-move {
  transition: transform 0.22s ease;
}

@media (prefers-reduced-motion: reduce) {
  .ui-toast-enter-active,
  .ui-toast-leave-active,
  .ui-toast-move {
    transition: none;
  }
}
</style>
