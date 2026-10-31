// 订阅榜单条目（action `subscribe` 的 v3 形态；编排层在 jobs/subscribe-engine.js）。
// input: { douban_ref: string }（快照里的 db:subj:<id>）。
import { Session } from './runtime.js'
import { subscribeFromSnapshot } from './subscribe-engine.js'

export async function run(ctx, input) {
  const session = await Session.open(ctx)
  const doubanRef = typeof input?.douban_ref === 'string' ? input.douban_ref : ''
  if (doubanRef === '') return { status: 'failed', message: '缺少 douban_ref' }
  return subscribeFromSnapshot(session, ctx, ctx.task?.id ?? 'action-subscribe', doubanRef)
}

export async function recover(ctx, checkpoint) {
  void ctx
  void checkpoint
  return { action: 'resume' }
}
