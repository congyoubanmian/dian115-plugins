// 立即同步想看（action `wish-sync` 的 v3 形态；前台只入队，订阅由后台任务自动完成）。
import { Session } from './runtime.js'
import { actionWishSync } from './wish.js'

export async function run(ctx) {
  const session = await Session.open(ctx)
  const result = await actionWishSync(session, ctx, ctx.task?.id ?? 'action-wish-sync', { deep: false })
  await session.persist()
  return result
}

export async function recover(ctx, checkpoint) {
  void ctx
  void checkpoint
  return { action: 'resume' }
}
