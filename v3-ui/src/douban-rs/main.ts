// 豆瓣中心（douban.rs）的 Vue 3 界面入口。
//
// 宿主契约（v3-kit/docs/ui-theme.md）：宿主 import 这个模块后调用 mount(el, ctx)；
// el 是插件区域内的挂载容器，ctx 是宿主上下文（所有数据与能力都只能走 ctx）。
// mount 返回清理函数：宿主关闭页面时调用，清理必须停定时器、解绑监听、卸载 app。
//
// 装配在 shared/mount.ts 里做：createApp → provide('ctx', ctx) → mount(el)，
// 并把 ctx.theme.mode 接到 naive-ui 的 n-config-provider（订阅在卸载时退订）。
// 本文件只负责把根组件交出去。

import { mountPlugin } from '../shared/mount'
import type { HostContext } from '../shared/types'
import AppPage from './AppPage.vue'

export function mount(el: HTMLElement, ctx: HostContext): () => void {
  return mountPlugin(el, ctx, AppPage)
}
