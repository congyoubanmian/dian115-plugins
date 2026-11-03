// 每日下载日报（清单 job daily-report，default_schedule 每天 08:30 一次，queue:false）。
//
// 读 KV 任务索引（tasks.idx）做统计：done/failed/queued/进行中 各多少、今日完成与
// 今日失败（口径 = lib/encoding.js startOfLocalDay，与 TG 状态命令一致），用
// ctx.notify 发一条 TG 日报（channels 限 telegram，走用户的通知模板与静默时段）。
//
// 去重语义（notifications.md §去重）：相同键 + 相同内容直接返回上次结果；相同键 +
// 不同内容返回冲突；所有渠道都发送失败的键记为「待核对」，再次发送必须换新键。
// 日报正文随队列统计变化，所以：
// - 首发键 `music:daily-report:<YYYY-MM-DD>`（一天一个）；
// - 当天已送达（accepted / deduplicated）→ 同日重跑不再发送（正文多半已变，同键会冲突），
//   返回 already_sent；
// - 发送抛错（键可能已记为待核对）→ 轮次 +1，下次重跑用 `…:<日期>:r<n>` 新键；
// - 全部渠道被跳过（suppressed，不占用键）→ 不算送达、不换键，重跑可用同键重试。
// 当天的发送状态存 KV `daily_report`（CAS 写，与其它写者不互相覆盖）。
// notify 抛错（限流/所有渠道失败等）不拖垮本 job：吞错记进检查点与返回值 notify_error。

import { buildDeps } from './runtime.js'
import { loadIndex } from '../lib/queue-store.js'
import { displayName, STATUS_QUEUED, STATUS_DOWNLOADING, STATUS_COPYING, STATUS_DONE, STATUS_FAILED } from '../lib/tasks-core.js'
import { taskCheckpoint } from '../lib/task.js'
import { casWrite } from '../lib/kv.js'
import { localDateKey, nowRfc3339, startOfLocalDay, truncateChars } from '../lib/encoding.js'

/** 当天日报发送状态的 KV 键：{date, round, sent, at, last_error}。 */
export const DAILY_REPORT_STATE_KEY = 'daily_report'

/** 日报 dedupe_key（≤200 字；插件前缀 + 动作 + 日期 [+ 失败后的换键轮次]，无时间戳无凭据）。 */
export function dailyReportKey(now = new Date(), round = 0) {
  const base = `music:daily-report:${localDateKey(now)}`
  return round > 0 ? `${base}:r${round}` : base
}

/** 读当天的发送状态（别的日期 / 缺失 / 损坏 → 全新的一天）。 */
function dayState(value, dateKey) {
  if (value && typeof value === 'object' && value.date === dateKey) {
    const round = Number.isInteger(value.round) && value.round > 0 ? value.round : 0
    return { date: dateKey, round, sent: value.sent === true, at: String(value.at ?? ''), last_error: String(value.last_error ?? '') }
  }
  return { date: dateKey, round: 0, sent: false, at: '', last_error: '' }
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
  const taskRef = typeof ctx.task?.id === 'string' ? ctx.task.id : ''
  const state = dayState(await deps.kv.get(DAILY_REPORT_STATE_KEY), dateKey)
  const dedupeKey = dailyReportKey(now, state.round)
  const stats = summarizeIndex(await loadIndex(deps.kv), now)

  if (state.sent) {
    // 当天已送达：不再发（正文多半已变，同键不同内容会被宿主判冲突）。
    return {
      date: dateKey,
      dedupe_key: dedupeKey,
      stats,
      accepted: false,
      deduplicated: true,
      suppressed: false,
      already_sent: true,
      notify_error: '',
      at: nowRfc3339(),
    }
  }

  const body = reportBody(stats)
  // 写前检查点：记录「准备发哪一天的哪条日报」，中断后可据此核对是否已送达。
  await taskCheckpoint(ctx, {
    stage: 'before-report',
    task_ref: taskRef,
    report_date: dateKey,
    dedupe_key: dedupeKey,
    updated_at: nowRfc3339(),
  })
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
  const accepted = outcome?.accepted === true
  const deduplicated = outcome?.deduplicated === true
  const suppressed = outcome?.suppressed === true
  // 记账：送达 → sent；抛错 → 换键轮次 +1（键可能已记为待核对）；suppressed → 原样。
  try {
    await casWrite(deps.kv, DAILY_REPORT_STATE_KEY, (current) => {
      const next = dayState(current, dateKey)
      if (accepted || deduplicated) {
        next.sent = true
        next.at = nowRfc3339()
        next.last_error = ''
      } else if (notifyError) {
        next.round = Math.max(next.round, state.round) + 1
        next.last_error = truncateChars(notifyError, 200)
      }
      return { next, result: next }
    })
  } catch {
    /* 状态记不下：最坏是下次重跑沿用旧键，宿主按去重语义兜底 */
  }
  // 写后检查点：通知已提交（accepted / deduplicated / suppressed 原样留档）。
  await taskCheckpoint(ctx, {
    stage: 'after-report',
    task_ref: taskRef,
    report_date: dateKey,
    dedupe_key: dedupeKey,
    accepted,
    deduplicated,
    suppressed,
    notify_error: notifyError,
    updated_at: nowRfc3339(),
  })
  return {
    date: dateKey,
    dedupe_key: dedupeKey,
    stats,
    accepted,
    deduplicated,
    suppressed,
    already_sent: false,
    notify_error: notifyError,
    at: nowRfc3339(),
  }
}
