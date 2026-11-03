// 每日下载日报（清单 job daily-report，default_schedule 每天 08:30 一次，queue:false）。
//
// 读 KV 任务索引（tasks.idx）做统计：done/failed/queued/进行中 各多少、今日完成与
// 今日失败（口径 = lib/encoding.js startOfLocalDay，与 TG 状态命令一致），用
// ctx.notify 发一条 TG 日报（channels 限 telegram，走用户的通知模板与静默时段）。
//
// dedupe_key = `music:daily-report:<YYYY-MM-DD>`：粒度是「天」，不含时刻 —— 同一天
// 内宿主重投 / 重跑都会命中同键同内容直接去重（notifications.md §去重），这是本 job
// 不带 recover 函数也能保证幂等的原因：外部写只有 notify 一次，若投递结果未达任何
// 渠道，同键重试是安全的（没占用去重键）；写操作前后各落一次检查点便于人工核对。
// notify 抛错（限流/所有渠道失败等）不拖垮本 job：吞错记进检查点与返回值 notify_error。

import { buildDeps } from './runtime.js'
import { loadIndex } from '../lib/queue-store.js'
import { displayName, STATUS_QUEUED, STATUS_DOWNLOADING, STATUS_COPYING, STATUS_DONE, STATUS_FAILED } from '../lib/tasks-core.js'
import { taskCheckpoint } from '../lib/task.js'
import { localDateKey, nowRfc3339, startOfLocalDay, truncateChars } from '../lib/encoding.js'

/** 日报 dedupe_key（≤200 字；键里只有插件前缀 + 动作 + 日期，无时间戳无凭据）。 */
export function dailyReportKey(now = new Date()) {
  return `music:daily-report:${localDateKey(now)}`
}

/** 通知正文上限（notifications.md：text ≤2000 字）。 */
const BODY_LIMIT = 1800
/** 今日完成 / 失败清单最多列几条名字。 */
const LIST_LIMIT = 5

/** 汇总任务索引：状态计数 + 今日完成/失败清单。 */
export function summarizeIndex(index, now = new Date()) {
  const entries = Array.isArray(index) ? index : []
  const count = (status) => entries.filter((entry) => entry.status === status).length
  const todayStart = startOfLocalDay(now)
  const doneToday = entries.filter((entry) => entry.status === STATUS_DONE && Number(entry.updated_ms ?? 0) >= todayStart)
  const failedToday = entries.filter((entry) => entry.status === STATUS_FAILED && Number(entry.updated_ms ?? 0) >= todayStart)
  const label = (entry) => truncateChars(displayName(entry) || entry.id, 60)
  return {
    total: entries.length,
    done: count(STATUS_DONE),
    failed: count(STATUS_FAILED),
    queued: count(STATUS_QUEUED),
    active: count(STATUS_DOWNLOADING) + count(STATUS_COPYING),
    done_today: doneToday.map(label),
    failed_today: failedToday.map(label),
  }
}

/** 组装日报正文（纯文本，走用户通知模板）。 */
export function reportBody(stats) {
  const lines = [
    `📦 下载日报 — 完成 ${stats.done} · 失败 ${stats.failed} · 排队 ${stats.queued} · 进行中 ${stats.active}`,
    `今日: 完成 ${stats.done_today.length} · 失败 ${stats.failed_today.length}`,
  ]
  if (stats.done_today.length > 0) {
    lines.push(`今日入库: ${stats.done_today.slice(0, LIST_LIMIT).join('、')}${stats.done_today.length > LIST_LIMIT ? ' 等' : ''}`)
  }
  if (stats.failed_today.length > 0) {
    lines.push(`今日失败: ${stats.failed_today.slice(0, LIST_LIMIT).join('、')}${stats.failed_today.length > LIST_LIMIT ? ' 等' : ''}（失败通知里有「重试」按钮）`)
  }
  if (stats.total === 0) lines.push('暂无下载任务。')
  return lines.join('\n')
}

/** 定时任务入口。 */
export async function run(ctx) {
  const deps = buildDeps(ctx)
  const now = new Date()
  const dateKey = localDateKey(now)
  const dedupeKey = dailyReportKey(now)
  const stats = summarizeIndex(await loadIndex(deps.kv), now)
  const body = reportBody(stats)

  // 写前检查点：记录「准备发哪一天的哪条日报」，中断后可据此核对是否已送达。
  await taskCheckpoint(ctx, {
    stage: 'before-report',
    task_ref: typeof ctx.task?.id === 'string' ? ctx.task.id : '',
    report_date: dateKey,
    dedupe_key: dedupeKey,
    updated_at: nowRfc3339(),
  })
  // 投递失败不拖垮日报任务（notifications.md：所有渠道都发送失败时 ctx.notify 抛错，
  // 且该键记为「待核对」；dedupe_key 按天稳定，而正文随队列统计变化，同日重跑很
  // 可能同键不同内容、命中冲突语义）—— 吞错记账进检查点与返回值，当天不再自动重发。
  let outcome = null
  let notifyError = ''
  try {
    outcome = await deps.notify({
      level: 'info',
      title: `音乐下载日报 ${dateKey}`,
      body,
      channels: ['telegram'],
      dedupe_key: dedupeKey,
    })
  } catch (error) {
    notifyError = error?.message ?? String(error)
  }
  // 写后检查点：通知已提交（accepted / deduplicated / suppressed 原样留档）。
  await taskCheckpoint(ctx, {
    stage: 'after-report',
    task_ref: typeof ctx.task?.id === 'string' ? ctx.task.id : '',
    report_date: dateKey,
    dedupe_key: dedupeKey,
    accepted: outcome?.accepted === true,
    deduplicated: outcome?.deduplicated === true,
    suppressed: outcome?.suppressed === true,
    notify_error: notifyError,
    updated_at: nowRfc3339(),
  })
  return {
    date: dateKey,
    dedupe_key: dedupeKey,
    stats,
    accepted: outcome?.accepted === true,
    deduplicated: outcome?.deduplicated === true,
    suppressed: outcome?.suppressed === true,
    notify_error: notifyError,
    at: nowRfc3339(),
  }
}
