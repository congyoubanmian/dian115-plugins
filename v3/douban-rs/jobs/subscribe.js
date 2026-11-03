// 订阅榜单条目（action `subscribe` 的 v3 形态；编排层在 jobs/subscribe-engine.js）。
// input: { douban_ref: string }（快照里的 db:subj:<id>）。
//
// 中断恢复：先查宿主订阅池的真实状态再决定 complete / resume / attention
// （恢复不换 business_key，也不会重复创建订阅）。
import { Session } from './runtime.js'
import { subscribeFromSnapshot, recoverSubscribe } from './subscribe-engine.js'
import { taskCheckpoint } from './task.js'

export async function run(ctx, input) {
  const session = await Session.open(ctx)
  const doubanRef = typeof input?.douban_ref === 'string' ? input.douban_ref : ''
  if (doubanRef === '') return { status: 'failed', message: '缺少 douban_ref' }
  const result = await subscribeFromSnapshot(session, ctx, ctx.task?.id ?? 'action-subscribe', doubanRef)
  await taskCheckpoint(ctx, { stage: 'completed', result })
  return result
}

export async function recover(ctx, checkpoint) {
  return recoverSubscribe(ctx, checkpoint)
}
