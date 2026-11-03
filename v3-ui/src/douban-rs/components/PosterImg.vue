<script setup lang="ts">
// 海报（对应原生版的 posterNode）。
//
// 取图走页面自己的海报加载器（ctx.http 带 Referer 直取 → 失败回退 get-poster job，
// 那个 job 内部按 img1~img9 镜像回退）。滚动到视口附近才发起请求。
// 点击海报放大预览（zoom 事件由页面统一接管）。

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { usePosterLoader } from '../posters'

const props = withDefaults(
  defineProps<{
    url?: string
    title?: string
    variant?: 'poster' | 'thumb' | 'thumb-sm'
    zoomable?: boolean
  }>(),
  { variant: 'poster', zoomable: true },
)

const emit = defineEmits<{
  (e: 'zoom', payload: { url: string; title: string }): void
}>()

const loader = usePosterLoader()
const root = ref<HTMLElement | null>(null)
const broken = ref(false)

const key = computed(() => (typeof props.url === 'string' ? props.url.trim() : ''))
const valid = computed(() => /^https?:\/\//i.test(key.value))
const entry = computed(() => (key.value ? loader.entries.get(key.value) : undefined))
const status = computed(() => {
  if (!valid.value) return 'invalid'
  if (broken.value) return 'broken'
  return entry.value?.status ?? 'idle'
})
const src = computed(() => entry.value?.src ?? '')
const pending = computed(() => status.value === 'loading' || status.value === 'idle')

const placeholder = computed(() => {
  switch (status.value) {
    case 'invalid':
      return '无海报'
    case 'loading':
      return '加载中…'
    case 'broken':
      return '海报加载失败'
    case 'error':
      return '海报不可用'
    default:
      return '海报'
  }
})

function requestPoster(): void {
  broken.value = false
  loader.request(props.url ?? '', root.value)
}

function onZoom(): void {
  if (!props.zoomable || !src.value) return
  emit('zoom', { url: src.value, title: props.title ?? '' })
}

onMounted(requestPoster)
watch(() => props.url, requestPoster)
onBeforeUnmount(() => loader.release(root.value))
</script>

<template>
  <component
    :is="props.zoomable ? 'button' : 'div'"
    ref="root"
    class="db-poster"
    :class="[`db-poster--${props.variant}`, { 'db-poster--link': props.zoomable }]"
    :type="props.zoomable ? 'button' : undefined"
    :aria-label="props.zoomable ? `放大查看${props.title || '海报'}` : undefined"
    @click="onZoom"
  >
    <img
      v-if="status === 'ready' && src"
      class="db-poster__img"
      :src="src"
      :alt="props.title ? `${props.title} 海报` : '海报'"
      decoding="async"
      @error="broken = true"
    />
    <span v-else-if="pending" class="db-poster__ph db-poster__ph--shimmer">
      <span class="db-poster__sr">{{ placeholder }}</span>
    </span>
    <span v-else class="db-poster__ph">{{ placeholder }}</span>
  </component>
</template>

<style scoped>
.db-poster {
  position: relative;
  display: block;
  aspect-ratio: 2 / 3;
  border-radius: 10px;
  overflow: hidden;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--db-line, var(--app-border, #e3e6eb)) 70%, transparent);
  background: color-mix(in srgb, var(--db-accent, #2080f0) 9%, var(--app-bg, #f0f2f5));
  color: inherit;
  font: inherit;
  cursor: default;
}

.db-poster--link {
  cursor: zoom-in;
}

.db-poster--thumb {
  width: 62px;
  height: 93px;
  flex: none;
}

.db-poster--thumb-sm {
  width: 52px;
  height: 78px;
  flex: none;
  border-radius: 8px;
}

.db-poster__img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.db-poster__ph {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 6px;
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 12px;
  text-align: center;
  background: transparent;
}

.db-poster__img {
  animation: db-poster-in 0.45s ease both;
}

@keyframes db-poster-in {
  from {
    opacity: 0;
    filter: blur(6px);
    transform: scale(1.04);
  }
}

.db-poster__ph--shimmer {
  overflow: hidden;
  background: linear-gradient(
    110deg,
    transparent 30%,
    color-mix(in srgb, var(--app-surface, #fff) 50%, transparent) 50%,
    transparent 70%
  );
  background-size: 250% 100%;
  animation: db-poster-shimmer 1.4s ease-in-out infinite;
}

@keyframes db-poster-shimmer {
  from {
    background-position: 120% 0;
  }
  to {
    background-position: -120% 0;
  }
}

.db-poster__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .db-poster__img,
  .db-poster__ph--shimmer {
    animation: none;
  }
}

@container db-page (max-width: 720px) {
  .db-poster--thumb {
    width: 48px;
    height: 72px;
  }
}
</style>
