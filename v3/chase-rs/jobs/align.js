// 整点对齐任务（旧 job `align` / manifest jobs[0].handler=alignHourly 的 v3 形态）。
//
// 每小时：读订阅池 → 解析 Emby 实例 → 逐条对齐（只增 PATCH）→ 追剧日历 →
// 每日一报 → 落盘。中断恢复：恢复时先查订阅池的真实状态再决定
// complete / resume / attention（补订只增 + 日报 dedupe_key 去重，重跑不会重复写）；
// 周期任务不允许重叠，recover 的 attention 在本入口收敛为 resume，避免整点调度停摆。
import { runHourlyAlign, recoverAlign } from './runtime.js'
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
  // 恢复语义集中在 runtime.recoverAlign：先查订阅池真实状态，再决定三态。
  const decision = await recoverAlign(ctx, checkpoint)
  // 本 job 每小时跑且不允许重叠：attention（需要核对）会拒绝新运行，无人值守的
  // 整点调度就此停摆。对齐入口只增不缩（PATCH 前有只增守卫，重跑不会写同一个值），
  // 核对不上时收敛为 resume，交给下一轮整点对齐兜底；complete/resume 原样透传。
  return decision.action === 'attention' ? { action: 'resume' } : decision
}
