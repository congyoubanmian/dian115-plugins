// 归档历史与日志（action `archive`；明确不清 no_resub 墓碑集 —— 那是用户的删除决定）。
import { Session, archive } from './runtime.js'

export async function run(ctx) {
  const session = await Session.open(ctx)
  const result = archive(session)
  await session.persist()
  return result
}

export async function recover(ctx, checkpoint) {
  void ctx
  void checkpoint
  return { action: 'resume' }
}
