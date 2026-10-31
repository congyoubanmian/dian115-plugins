// 清除重订限制（action `no-resub-clear`：清空墓碑集；空集幂等）。
import { Session, noResubClear } from './runtime.js'

export async function run(ctx) {
  const session = await Session.open(ctx)
  const result = noResubClear(session)
  await session.persist()
  return result
}

export async function recover(ctx, checkpoint) {
  void ctx
  void checkpoint
  return { action: 'resume' }
}
