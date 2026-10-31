// 移除黑名单关键词（action `blacklist-remove`；与添加不同，不校验空关键词）。
// input: { keyword: string }。
import { Session, blacklistRemove } from './runtime.js'

export async function run(ctx, input) {
  const session = await Session.open(ctx)
  const result = blacklistRemove(session, input?.keyword)
  await session.persist()
  return result
}

export async function recover(ctx, checkpoint) {
  void ctx
  void checkpoint
  return { action: 'resume' }
}
