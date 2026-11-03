// 海报加载器 —— 与原生 JS 版同一套取图链路。
//
// 取图优先级与降级链在 ./poster-chain.js（框架无关，node --test 用假 ctx 覆盖）：
// ① 文件缓存快路径（state 里 poster_file → ctx.files.downloadURL，Range 探测）
// ② 页面直连（ctx.http 带豆瓣 Referer 取 base64 拼 data URL）
// ③ 回退后端 get-poster job（镜像回退 + 128 KiB 上限 + 写插件文件缓存 → downloadURL）
// 本文件只管并发/懒加载/内存缓存这些页面侧机制：滚动到视口附近才发起请求，内存缓存
// 最多 160 张、条目只存 URL 字符串（downloadURL 或 data:），不再把 base64 大块头搬进页面。
//
// 页面只读 ctx.http / ctx.tasks / ctx.files.downloadURL，不直接 fetch 豆瓣
// （探测文件缓存用的是同源 downloadURL 的全局 fetch，不是豆瓣）。

import { inject, provide, reactive, type InjectionKey } from 'vue'
import type { HostContext } from '../shared/types'
import { POSTER_CACHE_LIMIT, POSTER_CONCURRENCY } from './constants'
// @ts-ignore -- 纯 JS 模块，没有类型声明（与 lib-bridge.ts 引 v3/lib/*.js 同一模式）
import { createPosterFetcher } from './poster-chain.js'
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

/**
 * 建海报加载器。
 *
 * @param ctx 宿主上下文。
 * @param invokeJob 提交宿主任务并等终态（用于回退的 get-poster job）。
 * @param findPosterFile 从 state 里查某条 poster_url 已回填的海报文件相对路径
 *   （posters/<sha256>.<ext>，缺省没有 → 跳过快路径）。
 */
export function createPosterLoader(
  ctx: HostContext,
  invokeJob: (name: string, input?: Record<string, unknown>, timeoutMs?: number) => Promise<TaskRun>,
  findPosterFile?: (url: string) => string,
): PosterLoader {
  const fetcher = createPosterFetcher({
    http: ctx.http,
    files: ctx.files,
    invokeJob,
    findPosterFile,
    fetchImpl: (globalThis as { fetch?: typeof fetch }).fetch,
  })
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
      void fetcher
        .load(url)
        .then((srcUrl: string) => {
          // 缓存条目只存 URL 字符串（downloadURL 或 data:），不再塞 base64 大块头
          cache.set(url, srcUrl || '')
          if (cache.size > POSTER_CACHE_LIMIT) {
            for (const key of cache.keys()) {
              if (key === url) continue
              cache.delete(key)
              break
            }
          }
          const target = ensureEntry(url)
          target.status = srcUrl ? 'ready' : 'error'
          target.src = srcUrl
        })
        .finally(() => {
          inflight.delete(url)
          active -= 1
          pump()
        })
    }
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
