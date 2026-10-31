// 立即对齐（旧 action `align-now` 的 v3 形态）：由页面通过 ctx.tasks.run 触发。
//
// 限量对齐：≤1 页订阅池、≤5 次 PATCH、≤3 次 Emby 探测、6 秒墙钟预算。
// 中断恢复同样按幂等处理：resume 重跑。
import { runAlignNow } from './runtime.js'
import { taskCheckpoint, taskUpdate } from './task.js'

export async function run(ctx) {
  await taskUpdate(ctx, { stage: 'align-now', message: '限量对齐中（≤1 页订阅池 · ≤5 次 PATCH · ≤3 次 Emby 探测）' })
  const result = await runAlignNow(ctx)
  await taskCheckpoint(ctx, { stage: 'completed', result })
  await taskUpdate(ctx, { stage: 'done', message: result.message ?? result.status, progress: 100 })
  return result
}

export async function recover(ctx, checkpoint) {
  if (checkpoint?.stage === 'completed') {
    return { action: 'complete', result: checkpoint.result }
  }
  return { action: 'resume' }
}
