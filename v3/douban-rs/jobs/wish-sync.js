// 定时订阅处理（旧 job wish-sync / cron */30 * * * * 的 v3 形态，按宿主建议用 interval）。
// 每 30 分钟：想看同步（含内联订阅）→ 到期观察条目订阅 → 墓碑判定（>=6h 节流）→ 落盘。
//
// 中断恢复：先查宿主订阅池的真实状态再决定 complete / resume / attention；
// 本入口一次要建多条订阅（批量），池里命中只说明最后那条已建，批次还要继续 → resume。
// 周期任务不允许重叠，recover 的 attention 在本入口收敛为 resume，避免调度停摆。
import { Session } from './runtime.js'
import { runWishSyncJob } from './wish.js'
import { recoverSubscribe } from './subscribe-engine.js'
import { taskCheckpoint, taskUpdate } from './task.js'

export async function run(ctx) {
  const session = await Session.open(ctx)
  await taskUpdate(ctx, { title: '想看同步与到期订阅', stage: 'wish-sync', message: '开始想看同步与到期订阅' })
  try {
    const result = await runWishSyncJob(session, ctx, ctx.task?.id ?? 'job-wish-sync')
    await taskCheckpoint(ctx, { stage: 'completed', result })
    await taskUpdate(ctx, { stage: 'done', message: result.message, progress: 100 })
    return result
  } catch (error) {
    const message = `想看同步任务失败: ${error.message}`
    session.log('error', message)
    await session.persist()
    await taskUpdate(ctx, { stage: 'failed', message })
    return { status: 'skipped', message }
  }
}

export async function recover(ctx, checkpoint) {
  const decision = await recoverSubscribe(ctx, checkpoint, { batch: true })
  // 本 job 每 30 分钟跑且不允许重叠：attention（需要核对）会拒绝新运行，无人值守的
  // 调度就此停摆。想看同步是批量编排且建订阅前先读池去重（subscribe-engine 的创建
  // 路径），重跑幂等 → attention 收敛为 resume；complete/resume 原样透传。
  return decision.action === 'attention' ? { action: 'resume' } : decision
}
