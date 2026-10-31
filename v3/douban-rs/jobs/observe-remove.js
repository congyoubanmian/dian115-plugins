// 移出观察队列（action `observe-remove`）。
// input: { douban_ref: string }。
import { Session, observeRemove } from './runtime.js'

export async function run(ctx, input) {
  const session = await Session.open(ctx)
  const doubanRef = typeof input?.douban_ref === 'string' ? input.douban_ref : ''
  const result = observeRemove(session, doubanRef)
  await session.persist()
  return result
}

export async function recover(ctx, checkpoint) {
  void ctx
  void checkpoint
  return { action: 'resume' }
}
