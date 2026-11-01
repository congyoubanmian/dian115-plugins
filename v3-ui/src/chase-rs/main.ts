// 追剧管家（chase.rs）的 Vue 3 界面入口。
//
// 宿主契约（v3-kit/docs/ui-theme.md）：宿主 import 这个模块后调用 mount(el, ctx)；
// el 是插件区域内的挂载容器，ctx 是宿主上下文（所有数据与能力都只能走 ctx）。
// mount 返回清理函数：宿主关闭页面时调用，清理必须停定时器、解绑监听、卸载 app。
//
// 共享底座（src/shared/mount.ts）做的是每个插件都要写的那一遍：
// createApp → provide('ctx', ctx) → 主题桥接 naive-ui 的 n-config-provider → mount(el)
// → 返回 () => { 退订主题; app.unmount() }。
// 页面内容与业务全在 AppPage.vue 里。

import { mountPlugin } from '../shared/mount'
import type { HostContext } from '../shared/types'
import AppPage from './AppPage.vue'

export function mount(el: HTMLElement, ctx: HostContext): () => void {
  return mountPlugin(el, ctx, AppPage)
}
