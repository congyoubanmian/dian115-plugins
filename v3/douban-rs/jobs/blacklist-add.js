// 添加黑名单关键词（action `blacklist-add`）。
// input: { keyword: string }。
import { Session, blacklistAdd } from './runtime.js'

export async function run(ctx, input) {
  const session = await Session.open(ctx)
  const result = blacklistAdd(session, input?.keyword)
  if (result.status === 'succeeded' && result.message !== '关键词已存在') {
    await session.persist()
  }
  return result
}

export async function recover(ctx, checkpoint) {
  void ctx
  void checkpoint
  return { action: 'resume' }
}
