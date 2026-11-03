<script setup lang="ts">
// 海报放大预览（点击海报墙/队列里的海报打开）。
//
// 放大用的还是页面已经取回的 data URL，不再发请求。Esc 或点背景关闭。
// 注意：不改宿主 body 的样式（宿主全局样式不许被页面覆盖），滚动交给插件区域自己管。

import { onBeforeUnmount, onMounted } from 'vue'
import { ExternalLink, X } from '@lucide/vue'

defineProps<{
  src: string
  title: string
  href?: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="db-lightbox" role="dialog" aria-modal="true" @click.self="emit('close')">
    <div class="db-lightbox__panel">
      <img class="db-lightbox__img" :src="src" :alt="title || '海报'" />
      <div class="db-lightbox__bar">
        <span class="db-lightbox__title">{{ title || '海报' }}</span>
        <span class="db-lightbox__spacer" />
        <a
          v-if="href"
          class="db-lightbox__link"
          :href="href"
          target="_blank"
          rel="noreferrer noopener"
        >
          <ExternalLink :size="14" aria-hidden="true" />
          豆瓣页面
        </a>
        <button type="button" class="db-lightbox__close" aria-label="关闭" @click="emit('close')">
          <X :size="16" aria-hidden="true" />
          关闭
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.db-lightbox {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: grid;
  place-items: center;
  padding: 24px;
  background:
    radial-gradient(circle at 50% 40%, color-mix(in srgb, var(--app-accent, #2080f0) 18%, transparent), transparent 60%),
    rgb(0 0 0 / 62%);
  backdrop-filter: blur(8px);
}

.db-lightbox__panel {
  display: grid;
  gap: 10px;
  max-width: min(560px, 92vw);
  max-height: 92vh;
  justify-items: center;
}

.db-lightbox__img {
  max-width: 100%;
  max-height: 78vh;
  border-radius: 12px;
  box-shadow:
    0 18px 48px rgb(0 0 0 / 45%),
    0 0 0 1px color-mix(in srgb, var(--app-surface, #fff) 18%, transparent);
  object-fit: contain;
  background: var(--app-surface, #fff);
}

.db-lightbox__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  width: 100%;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--app-surface, #fff);
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
}

.db-lightbox__title {
  font-size: 13px;
  color: var(--app-text, #1f2329);
  overflow-wrap: anywhere;
}

.db-lightbox__spacer {
  flex: 1 1 auto;
}

.db-lightbox__link,
.db-lightbox__close {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  background: transparent;
  color: var(--app-text, #1f2329);
  font: inherit;
  font-size: 12px;
  text-decoration: none;
  cursor: pointer;
}

.db-lightbox__close:hover,
.db-lightbox__link:hover {
  border-color: var(--db-accent, #2080f0);
  color: var(--db-accent, #2080f0);
}
</style>
