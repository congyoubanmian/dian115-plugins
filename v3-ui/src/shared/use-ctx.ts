// 组件里取宿主 ctx 的小工具。
//
// ctx 由 mount 装配时 provide('ctx', ctx) 注入（见 shared/mount.ts）；
// 页面所有数据与能力都只能走它（ctx.api / ctx.storage / ctx.settings / ctx.tasks /
// ctx.http / ctx.notifications / ctx.cookiecloud / ctx.theme / ctx.signal）。

import { inject } from 'vue'
import { CTX_KEY } from './mount'
import type { HostContext } from './types'

export function useCtx(): HostContext {
  const ctx = inject<HostContext | undefined>(CTX_KEY, undefined)
  if (!ctx) {
    throw new Error('[v3-ui] 组件树里没有 ctx：页面必须通过 mount(el, ctx) 装配。')
  }
  return ctx
}
