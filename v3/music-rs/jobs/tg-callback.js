// Telegram 回调事件（旧 wasm event op `telegram.callback` 的 v3 形态）。
//
// 失败通知带「重试」按钮（callback_data `retry:<短id>`）；用户点击后宿主把按钮事件
// 投递给清单 event=callback 的本任务。语义与旧 tasks.rs on_telegram_callback 一致：
// - `retry:<id>` → 失败任务重新排队（attempts 归零、retry_round 自增），并发一条
//   确认通知（旧版由宿主把 event 返回值变成 inline answer；v3 无该通道，改用通知反馈）；
// - 其他前缀 → 忽略（不是本插件的按钮）；
// - 任务不存在 → 静默确认（避免宿主无限重投）。

import { buildDeps } from './runtime.js'
import { extractCallbackData, RETRY_PREFIX, displayName } from '../lib/tasks-core.js'
import { retry } from '../lib/queue-store.js'
import { addLog } from '../lib/logs.js'

export async function run(ctx, input) {
  const deps = buildDeps(ctx)
  const data = input && typeof input === 'object' ? input : {}
  const raw = extractCallbackData(data)
  if (!raw) throw new Error('callback 事件缺少回调数据')
  if (!raw.startsWith(RETRY_PREFIX)) return { handled: false }
  const taskId = raw.slice(RETRY_PREFIX.length).trim()
  if (!taskId) throw new Error('重试回调缺少任务 id')

  let outcome
  try {
    outcome = await retry(deps.kv, taskId)
  } catch (error) {
    const message = String(error?.message ?? error)
    if (message.includes('不存在')) {
      // 任务被清理或不是本实例的任务：静默确认，避免宿主无限重投。
      return { handled: true, answer: '任务不存在或已被清理', alert: false }
    }
    throw error
  }
  if (outcome.message !== '已重新排队') {
    return { handled: true, answer: `任务状态为 ${outcome.status}, 无需重试`, alert: false }
  }
  // 重新入队成功：发一条确认通知（dedupe_key 带轮次，避免同任务连点被去重吞掉）。
  let label = taskId
  try {
    const task = await ctx.storage.get(`task.${taskId}`)
    if (task && typeof task === 'object') label = displayName(task)
    await ctx.notify({
      level: 'info',
      title: `已重新排队: ${label}`,
      body: `任务 ${taskId} 已重新排队，下一轮队列推进（每 5 分钟）会自动处理。`,
      dedupe_key: `dl-retry-${taskId}-r${(task?.retry_round ?? 0) + 1}`,
    })
  } catch {
    // 通知失败不影响重试本身。
  }
  await addLog(deps.kv, 'info', `Telegram 重试回调: 任务 ${taskId} 已重新排队`)
  return { handled: true, answer: `已重新排队: ${label}`, alert: false }
}
