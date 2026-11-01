// 海报加载器 —— 与原生 JS 版同一套取图链路。
//
// 豆瓣 CDN 有防盗链：浏览器直连 img*.doubanio.com 会返回 418。所以页面用
// ctx.http 带豆瓣 Referer 取回 base64（response_type:'base64'），再拼成 data URL；
// 直连失败（代理/限流/体积）再回退后端 get-poster job —— 那个 job 内部会按
// img1~img9 镜像逐个回退（lib/poster-core.js 的 mirrorCandidates），并把结果
// 限在 128 KiB 以内。页面内存缓存最多 160 张，滚动到视口附近才发起请求。
//
// 页面只读 ctx.http / ctx.tasks，不直接 fetch 豆瓣。

import { inject, provide, reactive, type InjectionKey } from 'vue'
import type { HostContext } from '../shared/types'
import { MAX_POSTER_B64, POSTER_CACHE_LIMIT, POSTER_CONCURRENCY } from './constants'
import type { TaskRun } from './store'

/** 单个 URL 的取图状态。 */
export interface PosterState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  src: string
}

/** 海报加载器。 */
export interface PosterLoader {
  entries: Map<string, PosterState>
  /** 请求某个 URL 的海报；el 给出时走 IntersectionObserver 懒加载。 */
  request(url: string, el?: Element | null): void
  /** 取消对某个元素的懒加载登记。 */
  release(el: Element | null | undefined): void
  dispose(): void
}

/** 注入键。 */
export const POSTER_KEY: InjectionKey<PosterLoader> = Symbol('doubanPosters')

/** 注入海报加载器。 */
export function providePosterLoader(loader: PosterLoader): void {
  provide(POSTER_KEY, loader)
}

/** 组件里取海报加载器。 */
export function usePosterLoader(): PosterLoader {
  const loader = inject(POSTER_KEY, undefined)
  if (!loader) throw new Error('[douban-rs] 组件树里没有海报加载器。')
  return loader
}

/** base64 化（宿主可能给字符串，也可能给字节数组）。 */
function base64Of(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) {
    let binary = ''
    for (const byte of value) binary += String.fromCharCode(byte)
    return btoa(binary)
  }
  return ''
}

/** 从响应头里取某个头（大小写不敏感）。 */
function headerValue(headers: unknown, name: string): string {
  if (!headers || typeof headers !== 'object') return ''
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== name) continue
    return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')
  }
  return ''
}

/**
 * 建海报加载器。
 *
 * @param ctx 宿主上下文。
 * @param invokeJob 提交宿主任务并等终态（用于回退的 get-poster job）。
 */
export function createPosterLoader(
  ctx: HostContext,
  invokeJob: (name: string, input?: Record<string, unknown>, timeoutMs?: number) => Promise<TaskRun>,
): PosterLoader {
  const entries = reactive(new Map<string, PosterState>())
  const cache = new Map<string, string>()
  const queue: string[] = []
  const queued = new Set<string>()
  const inflight = new Set<string>()
  const observed = new Map<Element, string>()

  let active = 0
  let disposed = false

  const ObserverCtor = (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver
  const observer: IntersectionObserver | null =
    typeof ObserverCtor === 'function'
      ? new ObserverCtor((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue
            const url = observed.get(entry.target)
            if (!url) continue
            observed.delete(entry.target)
            observer?.unobserve(entry.target)
            enqueue(url)
          }
        }, { rootMargin: '240px' })
      : null

  function ensureEntry(url: string): PosterState {
    let entry = entries.get(url)
    if (!entry) {
      entries.set(url, { status: 'idle', src: '' })
      entry = entries.get(url)
    }
    return entry as PosterState
  }

  function request(url: string, el?: Element | null): void {
    if (disposed) return
    const clean = typeof url === 'string' ? url.trim() : ''
    if (!/^https?:\/\//i.test(clean)) {
      const entry = ensureEntry(clean)
      entry.status = 'error'
      entry.src = ''
      return
    }
    const cached = cache.get(clean)
    if (cached !== undefined) {
      const entry = ensureEntry(clean)
      entry.status = cached ? 'ready' : 'error'
      entry.src = cached
      return
    }
    const entry = ensureEntry(clean)
    if (entry.status === 'loading') return
    if (el && observer) {
      observed.set(el, clean)
      observer.observe(el)
      return
    }
    enqueue(clean)
  }

  function release(el: Element | null | undefined): void {
    if (!el) return
    observed.delete(el)
    observer?.unobserve(el)
  }

  function enqueue(url: string): void {
    if (disposed) return
    if (!cache.has(url) && !inflight.has(url) && !queued.has(url)) {
      queued.add(url)
      queue.push(url)
    }
    pump()
  }

  function pump(): void {
    if (disposed) return
    while (active < POSTER_CONCURRENCY && queue.length > 0) {
      const url = queue.shift() as string
      queued.delete(url)
      if (cache.has(url) || inflight.has(url)) continue
      inflight.add(url)
      active += 1
      const entry = ensureEntry(url)
      entry.status = 'loading'
      void loadPosterData(url)
        .then((dataUrl) => {
          cache.set(url, dataUrl || '')
          if (cache.size > POSTER_CACHE_LIMIT) {
            for (const key of cache.keys()) {
              if (key === url) continue
              cache.delete(key)
              break
            }
          }
          const target = ensureEntry(url)
          target.status = dataUrl ? 'ready' : 'error'
          target.src = dataUrl
        })
        .finally(() => {
          inflight.delete(url)
          active -= 1
          pump()
        })
    }
  }

  async function loadPosterData(url: string): Promise<string> {
    try {
      return await fetchPosterDirect(url)
    } catch {
      try {
        return await fetchPosterViaJob(url)
      } catch {
        return ''
      }
    }
  }

  /** 页面直连：带豆瓣 Referer 取 base64。 */
  async function fetchPosterDirect(url: string): Promise<string> {
    const result = (await ctx.http.request({
      url,
      method: 'GET',
      headers: {
        Referer: 'https://movie.douban.com/',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      response_type: 'base64',
      timeout_seconds: 30,
      cache_seconds: 3600,
    })) as { status?: number; body_base64?: unknown; headers?: unknown }
    if (!result || (result.status ?? 0) < 200 || (result.status ?? 0) >= 300) {
      throw new Error(`HTTP ${result?.status ?? '?'}`)
    }
    const body = base64Of(result.body_base64)
    if (body === '') throw new Error('空响应')
    if (body.length > MAX_POSTER_B64) throw new Error('海报过大')
    const contentType = headerValue(result.headers, 'content-type') || 'image/jpeg'
    if (!contentType.toLowerCase().startsWith('image/')) throw new Error(`非图片内容 ${contentType}`)
    return `data:${contentType.split(';')[0]};base64,${body}`
  }

  /** 回退后端 job（内部按镜像逐个回退，限 128 KiB）。 */
  async function fetchPosterViaJob(url: string): Promise<string> {
    const run = await invokeJob('get-poster', { poster_url: url })
    const raw = run?.result
    const result = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    if (result.status === 'succeeded' && typeof result.url === 'string' && result.url.startsWith('data:')) {
      return result.url
    }
    throw new Error(String(result.message || '海报获取失败'))
  }

  function dispose(): void {
    disposed = true
    observer?.disconnect()
    observed.clear()
    queue.length = 0
    queued.clear()
    inflight.clear()
    cache.clear()
    entries.clear()
  }

  return { entries, request, release, dispose }
}
