// 定时任务：推进 KV 下载队列（旧 manifest job `queue-pump` / action `queue-pump` 的 v3 形态）。
//
// 每 5 分钟（default_schedule */5 * * * *）跑一轮 pump：取链接 → 下载到插件暂存目录 →
// 定名 → 移交宿主 move 进目标目录（CD2 挂载自动分流）→ 失败通知。页面可用
// ctx.tasks.run('queue-pump', ...) 手动快进（与旧 action `pump` 同一入口）。
//
// 中断恢复：pump 幂等（入队去重、残留 .part 清理、downloading 残留按 fail 语义计数回队），
// 未到 completed 的中断 resume 重跑即可。

import { buildDeps, readSettings } from './runtime.js'
import { pump, TASKS_IDX_KEY } from '../lib/pump.js'
import { addLog } from '../lib/logs.js'
import { nowRfc3339 } from '../lib/encoding.js'

/** 状态摘要键（UI 展示最近一轮 pump 的结果）。 */
const PUMP_STATE_KEY = 'state'

export async function run(ctx) {
  const deps = buildDeps(ctx)
  const settings = await readSettings(ctx)
  deps.settings = settings
  await ctx.task.update({ stage: 'pump', message: '推进下载队列…' })
  const summary = await pump(ctx, deps)
  const lines = summary.messages.filter((message) => message.trim())
  const message = lines.length > 0
    ? lines[lines.length - 1]
    : `队列已推进（排队 ${summary.queued} · 进行中 ${summary.active}）`
  // 摘要 + 日志落盘（UI 的「最近动作」与状态卡读取）。
  await ctx.storage.set(PUMP_STATE_KEY, {
    last_pump: { ...summary, at: nowRfc3339() },
  })
  for (const line of lines.slice(-10)) await addLog(deps.kv, 'info', line)
  await ctx.task.update({ stage: 'done', message, progress: 100 })
  return summary
}

export async function recover(ctx, checkpoint) {
  if (checkpoint?.stage === 'done') {
    return { action: 'complete', result: checkpoint.result ?? null }
  }
  // 未到 done 的中断：pump 是幂等的（去重入队、残留清理、downloading 残留回队），
  // resume 重跑一轮即可。
  return { action: 'resume' }
}
