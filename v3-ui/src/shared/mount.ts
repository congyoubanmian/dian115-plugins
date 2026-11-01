// 页面挂载骨架：createApp → provide('ctx', ctx) → mount(el) → 返回清理函数。
//
// 契约（v3-kit/docs/ui-theme.md）：宿主 import ui/page.js 并调用它导出的 mount(el, ctx)；
// mount 可以返回清理函数，宿主关闭页面时调用；清理必须停掉定时器、解绑监听、卸载 app。
//
// 这里只做"每个插件都要写的那一遍"：把 ctx 注入组件树、把宿主主题接到 naive-ui 的
// n-config-provider、并保证 app 一定被卸载。插件自己的业务逻辑写在各自的 AppPage.vue 里。

import { createApp, defineComponent, h, type Component } from 'vue'
import { darkTheme, NConfigProvider, NDialogProvider, NMessageProvider, NNotificationProvider } from 'naive-ui'
import type { HostContext } from './types'
import { createThemeBridge, THEME_KEY, type HostThemeBridge } from './theme'

/** 组件树里取 ctx 的注入键。 */
export const CTX_KEY = 'ctx'

/**
 * 挂载页面。
 *
 * @param el 宿主给的挂载容器（宿主保证它在插件区域内）。
 * @param ctx 宿主上下文；页面所有数据与能力都从这里走。
 * @param Root 根组件（通常是 AppPage.vue）。
 * @returns 清理函数：退订主题并卸载 app。
 */
export function mountPlugin(el: HTMLElement, ctx: HostContext, Root: Component): () => void {
  const theme = createThemeBridge(ctx)

  // naive-ui 的主题必须由 n-config-provider 提供；它在插件页面外面包一层，
  // 插件自己的 AppPage.vue 就只管内容，不用每个插件都写 provider 套娃。
  const Host = defineComponent({
    name: 'HostThemeProvider',
    setup() {
      return () =>
        h(
          NConfigProvider,
          { theme: theme.mode.value === 'dark' ? darkTheme : null },
          {
            default: () =>
              h(NDialogProvider, null, {
                default: () =>
                  h(NMessageProvider, null, {
                    default: () => h(NNotificationProvider, null, { default: () => h(Root) }),
                  }),
              }),
          },
        )
    },
  })

  const app = createApp(Host)
  app.provide(CTX_KEY, ctx)
  app.provide(THEME_KEY, theme)

  app.mount(el)

  return () => {
    theme.dispose()
    app.unmount()
  }
}

/** 主题桥类型再导出，方便插件直接引用。 */
export type { HostThemeBridge }
