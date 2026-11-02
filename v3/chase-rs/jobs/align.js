// 整点对齐任务（旧 job `align` / manifest jobs[0].handler=alignHourly 的 v3 形态）。
//
// 每小时：读订阅池 → 解析 Emby 实例 → 逐条对齐（只增 PATCH）→ 追剧日历 →
// 每日一报 → 落盘。中断恢复：整个流程幂等（补订只增、日报按 dedupe_key 去重），
// 已完成的检查点直接 complete，否则 resume 重跑。
import { runHourlyAlign } from './runtime.js'
import { taskCheckpoint, taskUpdate } from './task.js'

export async function run(ctx, input) {
  await taskUpdate(ctx, { title: '整点对齐', stage: 'align', message: '开始整点对齐' })
  const result = await runHourlyAlign(ctx)
  await taskCheckpoint(ctx, { stage: 'completed', result })
  const total = Number(result.intents_seen ?? 0)
  const failed = Number(result.failed ?? 0)
  await taskUpdate(ctx, {
    title: '整点对齐',
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
  if (checkpoint?.stage === 'completed') {
    return { action: 'complete', result: checkpoint.result }
  }
  // 未到 completed 的中断：重跑一轮是幂等的（补订只增、日报 dedupe_key 去重、
  // 状态文档按 CAS 落盘），resume 即可。
  return { action: 'resume' }
}
