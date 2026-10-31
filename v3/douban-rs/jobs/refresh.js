// 立即刷新（action `refresh` 的 v3 形态；页面发起，前台预算 6.5s，订阅交给后台）。
// input: {}（旧 action 无参数）。
import { Session } from './runtime.js'
import { refreshNow } from './charts.js'

export async function run(ctx) {
  const session = await Session.open(ctx)
  try {
    const result = await refreshNow(session, ctx, ctx.task?.id ?? 'action-refresh', { deep: false })
    return { status: 'succeeded', message: result.message }
  } catch (error) {
    const message = `手动刷新失败: ${error.message}`
    session.log('error', message)
    session.bump('failed', message)
    await session.persist()
    return { status: 'failed', message }
  }
}

export async function recover(ctx, checkpoint) {
  void ctx
  void checkpoint
  return { action: 'resume' }
}
