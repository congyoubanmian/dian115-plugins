// 立即订阅队列条目（action `subscribe-now` 的 v3 形态；手动入口应用过滤器、不拦墓碑）。
// input: { douban_ref: string }。
//
// 中断恢复：先查宿主订阅池的真实状态再决定 complete / resume / attention。
import { Session } from './runtime.js'
import { subscribeQueueNow, recoverSubscribe } from './subscribe-engine.js'
import { taskCheckpoint } from './task.js'

export async function run(ctx, input) {
  const session = await Session.open(ctx)
  const doubanRef = typeof input?.douban_ref === 'string' ? input.douban_ref : ''
  if (doubanRef === '') return { status: 'failed', message: '缺少 douban_ref' }
  const result = await subscribeQueueNow(session, ctx, ctx.task?.id ?? 'action-subscribe-now', doubanRef)
  await taskCheckpoint(ctx, { stage: 'completed', result })
  return result
}

export async function recover(ctx, checkpoint) {
  return recoverSubscribe(ctx, checkpoint)
}
