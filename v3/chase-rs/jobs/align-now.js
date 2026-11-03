// 立即对齐（旧 action `align-now` 的 v3 形态）：由页面通过 ctx.tasks.run 触发。
//
// 限量对齐：≤1 页订阅池、≤5 次 PATCH、≤3 次 Emby 探测、6 秒墙钟预算。
// 中断恢复：先查订阅池的真实状态再决定 complete / resume / attention。
import { runAlignNow, recoverAlign } from './runtime.js'
import { taskCheckpoint, taskUpdate } from './task.js'

export async function run(ctx) {
  await taskUpdate(ctx, { title: '立即对齐', stage: 'align-now', message: '限量对齐中（≤1 页订阅池 · ≤5 次 PATCH · ≤3 次 Emby 探测）' })
  const result = await runAlignNow(ctx)
  await taskCheckpoint(ctx, { stage: 'completed', result })
  const total = Number(result.intents_seen ?? 0)
  const failed = Number(result.failed ?? 0)
  await taskUpdate(ctx, {
    title: '立即对齐',
    stage: 'done',
    message: result.message ?? result.status,
    progress: 100,
    total,
    done: Math.max(0, total - failed),
    failed,
  })
  return result
}

export async function recover(ctx, checkpoint) {
  // 恢复语义集中在 runtime.recoverAlign：先查订阅池真实状态，再决定三态。
  return recoverAlign(ctx, checkpoint)
}
