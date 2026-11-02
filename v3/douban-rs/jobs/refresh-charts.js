// 定时刷新榜单（旧 job refresh-charts / cron 0 */2 * * * 的 v3 形态）。
// 后台预算 8 分钟：抓全部启用榜单 → 黑名单过滤入队 → 到期条目订阅 → 想看同步 → 落盘。
import { Session } from './runtime.js'
import { refreshNow } from './charts.js'
import { taskUpdate } from './task.js'

export async function run(ctx) {
  const session = await Session.open(ctx)
  await taskUpdate(ctx, { title: '定时刷新榜单', stage: 'refresh', message: '开始定时刷新' })
  try {
    const result = await refreshNow(session, ctx, ctx.task?.id ?? 'job-refresh-charts', { deep: true })
    const failures = Array.isArray(result.failures) ? result.failures.length : 0
    const total = Number(result.subscribed ?? 0) + Number(result.needs_review ?? 0) + failures
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
  // 刷新链路幂等（抓取覆盖快照、入队按 ref 去重、订阅按宿主 (tmdb_id, media_type) 去重）：
  // 未完成的中断直接 resume 重跑。
  void ctx
  void checkpoint
  return { action: 'resume' }
}
