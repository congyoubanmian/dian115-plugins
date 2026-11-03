// 界面层的小工具：音质分档配色、封面缓存、动效偏好、首屏就绪标记。
//
// 只做展示，不改业务数据；封面经 ctx.http 取回成 data URL（与歌单封面同一条路径：
// lib/music-api.js imageDataUrl），页面不直接从浏览器去拉第三方图片。

import { computed, inject, reactive, type ComputedRef, type Ref } from 'vue'
import type { HostContext } from '../shared/types'
import { imageDataUrl } from './plugin-api'

export type QualityTier = 'gold' | 'lossless' | 'standard'

const GOLD = new Set(['jymaster', 'jyeffect', 'sky', 'hires', 'dolby', 'master'])
const LOSSLESS = new Set(['lossless', 'flac'])

/** 音质 → 分档：Hi-Res/母带类金色、无损强调色、其余低调。 */
export function qualityTier(value: string | undefined): QualityTier {
  const key = String(value ?? '')
  if (GOLD.has(key)) return 'gold'
  if (LOSSLESS.has(key)) return 'lossless'
  return 'standard'
}

/** 字符串 → 稳定的小整数（生成占位封面角度、波形高度用）。 */
export function hashOf(text: string): number {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** 用户是否要求减少动效。 */
export function prefersReducedMotion(): boolean {
  try {
    return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  } catch {
    return false
  }
}

/** 首屏数据是否已读回过一次（骨架屏只在这之前出现）。 */
export const READY_KEY = 'musicReady'

/** 组件里读就绪标记；没有提供方时视为已就绪（不显示骨架）。 */
export function useReady(): ComputedRef<boolean> {
  const ready = inject<Ref<boolean> | undefined>(READY_KEY, undefined)
  return computed(() => ready?.value ?? true)
}

/** 封面缩略图地址：网易云加尺寸参数、QQ 换小图，减少经宿主转取的字节数。 */
function thumbUrl(raw: string | undefined): string {
  const url = typeof raw === 'string' ? raw.trim() : ''
  if (!/^https?:\/\//i.test(url)) return ''
  if (/music\.126\.net\//i.test(url) && !url.includes('?')) return `${url}?param=200y200`
  return url.replace(/T002R(300|500|800)x\1M000/, 'T002R150x150M000')
}

export const COVER_KEY = 'musicCovers'

export interface CoverCache {
  /** 取缩略图 data URL；还没取到返回空串并排队（并发 3），失败也返回空串。 */
  get(raw: string | undefined): string
  dispose(): void
}

export function createCoverCache(ctx: HostContext): CoverCache {
  const done = reactive(new Map<string, string>())
  const queued = new Set<string>()
  const queue: string[] = []
  let active = 0
  let disposed = false

  function pump(): void {
    while (!disposed && active < 3 && queue.length) {
      const url = queue.shift() as string
      active++
      Promise.resolve()
        .then(() => imageDataUrl({ http: ctx.http }, url) as Promise<string>)
        .then(
          (data) => {
            if (!disposed) done.set(url, data)
          },
          () => {
            if (!disposed) done.set(url, '')
          },
        )
        .finally(() => {
          active--
          pump()
        })
    }
  }

  return {
    get(raw) {
      const url = thumbUrl(raw)
      if (!url) return ''
      const hit = done.get(url)
      if (hit !== undefined) return hit
      if (!queued.has(url) && !disposed) {
        queued.add(url)
        queue.push(url)
        queueMicrotask(pump)
      }
      return ''
    },
    dispose() {
      disposed = true
      queue.length = 0
    },
  }
}

export function useCovers(): CoverCache {
  return inject<CoverCache>(COVER_KEY, { get: () => '', dispose() {} })
}
