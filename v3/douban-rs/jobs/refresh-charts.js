// 定时刷新榜单（旧 job refresh-charts / cron 0 */2 * * * 的 v3 形态）。
// 后台预算 8 分钟：抓全部启用榜单 → 黑名单过滤入队 → 到期条目订阅 → 想看同步 → 落盘。
//
// 中断恢复：先查宿主订阅池的真实状态再决定 complete / resume / attention；
// 本入口是批量入口（一次建多条订阅），池里命中只说明最后那条已建 → resume 继续批次。
// 周期任务不允许重叠，recover 的 attention 在本入口收敛为 resume，避免调度停摆。
import { Session } from './runtime.js'
import { refreshNow } from './charts.js'
import { recoverSubscribe } from './subscribe-engine.js'
import { taskCheckpoint, taskUpdate } from './task.js'

export async function run(ctx) {
  const session = await Session.open(ctx)
  await taskUpdate(ctx, { title: '定时刷新榜单', stage: 'refresh', message: '开始定时刷新' })
  try {
    const result = await refreshNow(session, ctx, ctx.task?.id ?? 'job-refresh-charts', { deep: true })
    const failures = Array.isArray(result.failures) ? result.failures.length : 0
    const total = Number(result.subscribed ?? 0) + Number(result.needs_review ?? 0) + failures
    await taskCheckpoint(ctx, { stage: 'completed', result })
    await taskUpdate(ctx, {
      title: '定时刷新榜单',
      stage: 'done',
      message: result.message,
      progress: 100,
      total,
      done: Number(result.subscribed ?? 0) + Number(result.needs_review ?? 0),
      failed: failures,
    })
    return { status: 'accepted', message: result.message, subscribed: result.subscribed, needs_review: result.needs_review }
  } catch (error) {
    const message = `定时刷新失败: ${error.message}`
    session.log('error', message)
    session.bump('failed', message)
    await session.persist()
    await taskUpdate(ctx, { stage: 'failed', message })
    return { status: 'skipped', message }
  }
}

export async function recover(ctx, checkpoint) {
  const decision = await recoverSubscribe(ctx, checkpoint, { batch: true })
  // 本 job 每 2 小时跑且不允许重叠：attention（需要核对）会拒绝新运行，无人值守的
  // 调度就此停摆。刷新入口是批量编排且建订阅前先读池去重（subscribe-engine 的创建
  // 路径），重跑幂等 → attention 收敛为 resume；complete/resume 原样透传。
  return decision.action === 'attention' ? { action: 'resume' } : decision
}
