// 定时任务：推进 KV 下载队列（旧 manifest job `queue-pump` / action `queue-pump` 的 v3 形态）。
//
// 每 5 分钟（default_schedule */5 * * * *）跑一轮 pump：取链接 → 下载到插件暂存目录 →
// 定名 → 移交宿主 move 进目标目录（CD2 挂载自动分流）→ 失败通知。页面可用
// ctx.tasks.run('queue-pump', ...) 手动快进（与旧 action `pump` 同一入口）。
//
// 中断恢复：恢复语义在 lib/pump.js recoverPump —— 先核对目标目录里的真实文件
// （files.exists / stat），再决定 complete / resume / attention；pump 本身幂等
// （入队去重、残留 .part 清理、downloading 残留按 fail 语义计数回队）。本 job 是
// 周期任务且不允许重叠，recover 的 attention 在这里收敛为 resume（见 recover 注释），
// 避免无人值守的调度停在「需要核对」。

import { buildDeps, readSettings } from './runtime.js'
import { pump, TASKS_IDX_KEY, recoverPump } from '../lib/pump.js'
import { addLogs } from '../lib/logs.js'
import { nowRfc3339 } from '../lib/encoding.js'
import { taskCheckpoint, taskUpdate } from '../lib/task.js'

/** 状态摘要键（UI 展示最近一轮 pump 的结果）。 */
const PUMP_STATE_KEY = 'state'

export async function run(ctx) {
  const deps = buildDeps(ctx)
  const settings = await readSettings(ctx)
  deps.settings = settings
  await taskUpdate(ctx, { stage: 'pump', message: '推进下载队列…' })
  const summary = await pump(ctx, deps)
  const lines = summary.messages.filter((message) => message.trim())
  const message = lines.length > 0
    ? lines[lines.length - 1]
    : `队列已推进（排队 ${summary.queued} · 进行中 ${summary.active}）`
  // 摘要 + 日志落盘（UI 的「最近动作」与状态卡读取）。
  await ctx.storage.set(PUMP_STATE_KEY, {
    last_pump: { ...summary, at: nowRfc3339() },
  })
  // 一次 CAS 读改写追加整批日志（与页面同时追加时不互相覆盖，也不逐条往返）。
  if (lines.length > 0) await addLogs(deps.kv, 'info', lines.slice(-10))
  // 整轮结束的检查点：单任务的检查点会被下一首覆盖，run 级 completed 必须最后写。
  await taskCheckpoint(ctx, {
    stage: 'completed',
    task_ref: typeof ctx.task?.id === 'string' ? ctx.task.id : '',
    result: summary,
    updated_at: nowRfc3339(),
  })
  await taskUpdate(ctx, { stage: 'done', message, progress: 100 })
  return summary
}

export async function recover(ctx, checkpoint) {
  const decision = await recoverPump(ctx, checkpoint)
  // 周期任务不允许重叠：recover 落在 attention（需要核对）时会拒绝新运行，无人值守
  // 的 5 分钟调度就此停摆，页面也没有逐条核对入口。pump 入口幂等（入队去重、
  // downloading/copying 残留按既有语义兜底、同名预检拦住撞墙重试），核对不上时
  // 收敛为 resume，交给下一轮 pump 兜底；complete/resume 原样透传。
  return decision.action === 'attention' ? { action: 'resume' } : decision
}
