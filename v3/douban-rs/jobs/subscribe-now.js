// 立即订阅队列条目（action `subscribe-now` 的 v3 形态；手动入口应用过滤器、不拦墓碑）。
// input: { douban_ref: string }。
import { Session } from './runtime.js'
import { subscribeQueueNow } from './subscribe-engine.js'

export async function run(ctx, input) {
  const session = await Session.open(ctx)
  const doubanRef = typeof input?.douban_ref === 'string' ? input.douban_ref : ''
  if (doubanRef === '') return { status: 'failed', message: '缺少 douban_ref' }
  return subscribeQueueNow(session, ctx, ctx.task?.id ?? 'action-subscribe-now', doubanRef)
}

export async function recover(ctx, checkpoint) {
  void ctx
  void checkpoint
  return { action: 'resume' }
}
