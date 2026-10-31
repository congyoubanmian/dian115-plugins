// 只读刷新（旧 action `refresh` 的 v3 形态）：重读 1 页订阅池与追剧日历，刷新界面计数。
// 零 PATCH、零业务写入。
import { runRefresh } from './runtime.js'
import { taskCheckpoint, taskUpdate } from './task.js'

export async function run(ctx) {
  const result = await runRefresh(ctx)
  await taskCheckpoint(ctx, { stage: 'completed', result })
  await taskUpdate(ctx, { stage: 'done', message: result.message, progress: 100 })
  return result
}

export async function recover(ctx, checkpoint) {
  if (checkpoint?.stage === 'completed') {
    return { action: 'complete', result: checkpoint.result }
  }
  return { action: 'resume' }
}
