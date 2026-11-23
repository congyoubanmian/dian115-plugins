// 同步本插件送出去的磁力在 115 上的状态。
//
// 宿主那个「查离线任务」接口会把账号下所有离线任务都拉一遍（115 的列表是加密的，
// 一次调用挺慢），页面点一下就卡。所以改成后台跑：结果写进插件 KV，页面直接读 KV，
// 打开就是秒开。

import { log, syncOfflineState } from '../lib/site.js'

export async function run(ctx, input) {
  const state = await syncOfflineState(ctx)
  await log(ctx, `115 状态同步：${state.length} 条记录，${state.filter(item => item.found).length} 条在 115 列表里`)
  return { count: state.length, found: state.filter(item => item.found).length }
}

// 纯读 KV + 读接口，重跑无害
export async function recover(ctx, checkpoint) {
  return { action: 'resume' }
}
