<script setup lang="ts">
import { ref, watch } from 'vue'

// 豆瓣海报 CDN 防盗链：浏览器直连返回 418，必须由运行时带豆瓣 Referer 抓取后转 dataURL。
// 模块级缓存避免重复抓取；并发限制避免一次性请求过多触发豆瓣限流。
const posterCache = new Map<string, string>()
const inflight = new Map<string, Promise<string>>()
const MAX_CONCURRENT = 4
let active = 0
const queue: Array<() => void> = []

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++
    return Promise.resolve()
  }
  return new Promise((resolve) => queue.push(resolve))
}
function release() {
  active--
  const next = queue.shift()
  if (next) next()
}

const props = defineProps<{
  posterUrl?: string
  api: {
    invokeAction(action: string, input?: unknown): Promise<{ result?: { url?: string } }>
  }
  alt?: string
}>()

const src = ref('')

async function load(url: string): Promise<string> {
  if (!url) return ''
  const cached = posterCache.get(url)
  if (cached !== undefined) return cached
  const running = inflight.get(url)
  if (running) return running
  const task = (async () => {
    await acquire()
    try {
      const r = await props.api.invokeAction('get-poster', { poster_url: url })
      const v = String((r as any)?.result?.url || '')
      if (v.startsWith('data:image') || /^https?:\/\//i.test(v)) {
        posterCache.set(url, v)
        return v
      }
      return ''
    } catch {
      return ''
    } finally {
      release()
      inflight.delete(url)
    }
  })()
  inflight.set(url, task)
  return task
}

watch(
  () => props.posterUrl,
  (u) => {
    load(u || '').then((v) => {
      src.value = v
    })
  },
  { immediate: true },
)
</script>

<template>
  <img v-if="src" :src="src" :alt="alt || ''" loading="lazy" class="dc-poster-img" />
  <div v-else class="dc-poster-img dc-poster-ph">
    <svg class="dc-poster-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4 19l5-5 3 3 4-4 4 4" />
    </svg>
  </div>
</template>

<style scoped>
.dc-poster-img {
  display: block;
  object-fit: cover;
  border-radius: var(--dian-radius-sm, 6px);
  flex: none;
}
.dc-poster-ph {
  background: linear-gradient(135deg, var(--dian-surface-hover, rgba(120, 120, 120, 0.2)), var(--dian-surface-soft, rgba(120, 120, 120, 0.08)));
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--dian-text-secondary, rgba(120, 120, 120, 0.55));
}
.dc-poster-icon {
  width: 40%;
  height: 40%;
}
</style>
