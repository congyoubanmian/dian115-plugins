// 定时订阅处理（旧 job wish-sync / cron */30 * * * * 的 v3 形态，按宿主建议用 interval）。
// 每 30 分钟：想看同步（含内联订阅）→ 到期观察条目订阅 → 墓碑判定（>=6h 节流）→ 落盘。
import { Session } from './runtime.js'
import { runWishSyncJob } from './wish.js'
import { taskUpdate } from './task.js'

export async function run(ctx) {
  const session = await Session.open(ctx)
  await taskUpdate(ctx, { stage: 'wish-sync', message: '开始想看同步与到期订阅' })
  try {
    const result = await runWishSyncJob(session, ctx, ctx.task?.id ?? 'job-wish-sync')
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
  // 链路幂等：想看按 wish_seen 去重、订阅按宿主 (tmdb_id, media_type) 去重、墓碑有 6h 节流。
  void ctx
  void checkpoint
  return { action: 'resume' }
}
