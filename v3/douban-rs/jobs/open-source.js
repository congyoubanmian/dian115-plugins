// 打开豆瓣来源（action `open-source`：按 ref 从快照/队列找回条目链接）。
// input: { douban_ref: string }。
import { Session, openSource } from './runtime.js'

export async function run(ctx, input) {
  const session = await Session.open(ctx)
  const doubanRef = typeof input?.douban_ref === 'string' ? input.douban_ref : ''
  return openSource(session, doubanRef)
}

export async function recover(ctx, checkpoint) {
  void ctx
  void checkpoint
  return { action: 'resume' }
}
