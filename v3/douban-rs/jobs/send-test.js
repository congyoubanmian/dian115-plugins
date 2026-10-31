// 通知自检（action `send-test` 的 v3 形态）。
// v3 通知通道（ctx.notify）可用，恢复实现 —— 旧版宿主拒绝插件通知 payload，
// 旧实现固定返回 skipped；v3 实发一条测试通知并回报结果。
import { Session, sendTest } from './runtime.js'

export async function run(ctx) {
  const session = await Session.open(ctx)
  const result = await sendTest(session, ctx)
  await session.persist()
  return result
}

export async function recover(ctx, checkpoint) {
  void ctx
  void checkpoint
  return { action: 'resume' }
}
