// 主题桥接：把宿主的 ctx.theme.mode 变成 Vue 响应式状态。
//
// 契约（v3-kit/docs/ui-theme.md）：ctx.theme.mode 是 'light' | 'dark'；
// ctx.theme.subscribe(fn) 立即回调当前值并返回取消订阅函数。
// 订阅必须在页面卸载时取消，否则宿主切主题会写到已卸载的组件上。

import { inject, onBeforeUnmount, readonly, ref, type Ref } from 'vue'
import type { HostContext } from './types'

/** 注入键：主题桥。 */
export const THEME_KEY = 'hostTheme'

export interface HostThemeBridge {
  /** 当前模式（只读响应式）。 */
  mode: Ref<'light' | 'dark'>
  /** 是否深色。 */
  isDark: Ref<boolean>
  /** 取消订阅；页面卸载时调用。 */
  dispose(): void
}

/**
 * 建立主题桥（在 mount 里调用一次）。
 *
 * 不依赖组件生命周期：订阅与退订都由页面自己掌控，卸载顺序不会出问题。
 */
export function createThemeBridge(ctx: HostContext): HostThemeBridge {
  const mode = ref<'light' | 'dark'>(ctx.theme?.mode ?? 'light')
  const isDark = ref(mode.value === 'dark')
  let unsubscribe: (() => void) | undefined

  if (ctx.theme?.subscribe) {
    unsubscribe = ctx.theme.subscribe((next) => {
      mode.value = next
      isDark.value = next === 'dark'
    })
  }

  return {
    mode: readonly(mode) as Ref<'light' | 'dark'>,
    isDark: readonly(isDark) as Ref<boolean>,
    dispose() {
      unsubscribe?.()
      unsubscribe = undefined
    },
  }
}

/**
 * 组件里读主题（必须在 mount 提供的主题桥下使用）。
 */
export function useHostTheme(): HostThemeBridge {
  const bridge = inject<HostThemeBridge | undefined>(THEME_KEY, undefined)
  if (bridge) return bridge

  // 没经过 mount 装配时（例如单元测试单独渲染组件），退化成静态浅色，
  // 免得整棵组件树因为缺 provider 直接崩掉。
  const mode = ref<'light' | 'dark'>('light')
  const isDark = ref(false)
  onBeforeUnmount(() => undefined)
  return { mode: readonly(mode) as Ref<'light' | 'dark'>, isDark: readonly(isDark) as Ref<boolean>, dispose() {} }
}
