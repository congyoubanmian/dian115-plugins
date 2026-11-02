// 探测诊断（旧 action `probe-dump` 的 v3 形态）：
// emby/instances + emby/episodes 参数矩阵 + air-calendar + tmdb 该季集数，
// 结果写 state.debug（原文样本 ≤2048 字节）。
import { runProbeDump } from './runtime.js'
import { taskCheckpoint, taskUpdate } from './task.js'

export async function run(ctx) {
  await taskUpdate(ctx, { title: '探测诊断', stage: 'probe', message: '正在探测诊断（emby/instances + 未知端点的参数矩阵）' })
  const result = await runProbeDump(ctx)
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
