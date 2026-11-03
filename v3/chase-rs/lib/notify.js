// TG 日报：文案组装 + 当日去重判定 + 宿主结论落账 —— 对照 notify.rs。
//
// v3 的发送走 ctx.notify({title, body, level, dedupe_key})，宿主返回
// NotificationResult{accepted, deduplicated, suppressed, suppression_reason, ...}，
// 与旧 `POST /api/notifications/plugin` 的响应语义一致：
// - accepted / deduplicated ⇒ 记日期（宿主已有当日记录）；
// - suppressed ⇒ 不记日期，下一小时重试并记 suppression_reason；
// - 失败 ⇒ 不记日期 + last_error。
// 本模块只做纯计算；发送由 jobs/runtime.js 负责。

import { truncateUtf8 } from './loose.js'

/** 标题字节上限（宿主 schema maxLength: 160）。 */
export const TITLE_MAX = 160
/** 正文字节上限（宿主 schema maxLength: 2000）。 */
export const BODY_MAX = 2000
/** 日报去重键前缀。 */
export const DEDUPE_PREFIX = 'chase-daily-'
/** 正文里"今日播出"最多几条。 */
export const TODAY_MAX = 15
/** 正文里"本次补订"最多几条。 */
export const PATCHED_MAX = 15

/**
 * 去重键。当天首发用 `chase-daily-<date>`；同一天发送失败后的重试带 `-r<n>` 后缀：
 * 宿主对"投递结果未确认"的键要求换新键，且同键不同内容会返回冲突（每小时重试时
 * 正文里的补订列表通常已经变了），沿用旧键会让当天剩下的重试全部失败。
 */
export function dedupeKey(date, retrySeq = 0) {
  return retrySeq > 0 ? `${DEDUPE_PREFIX}${date}-r${retrySeq}` : `${DEDUPE_PREFIX}${date}`
}

/** 当天应使用的重试序号（跨天归零）。 */
export function retrySeqFor(daily, today) {
  return daily.retry_date === today ? Math.max(0, daily.retry_seq ?? 0) : 0
}

/** 发送抛错后记下当天的重试序号，下次换新键。 */
export function bumpRetry(daily, today) {
  daily.retry_seq = retrySeqFor(daily, today) + 1
  daily.retry_date = today
}

/** 是否到了该发日报的时刻：开关打开、本地日期与上次成功日不同、本地小时 >= 配置小时。 */
export function shouldSend(report, lastSentDate, today, hour) {
  return report.enabled && today !== '' && lastSentDate !== today && hour >= report.hour
}

/** 组装日报（标题 + 正文）。段①今日播出、段②本次补订、段③跳过/失败计数与首个原因。 */
export function compose(today, todayItems, patched, skipped, failed, firstReason) {
  const patchedItems = patched.filter(
    (item) => item.action === 'patched' || item.action === 'dry-run',
  )
  const realPatches = patchedItems.filter((item) => item.action === 'patched').length
  const title = truncateUtf8(`追剧管家 ${today}: 补订 ${realPatches} 条`, TITLE_MAX)

  const lines = []
  lines.push(`① 今日播出(${todayItems.length})`)
  if (todayItems.length === 0) lines.push('  今日没有订阅剧集更新')
  for (const item of todayItems.slice(0, TODAY_MAX)) {
    const showTitle = item.title === '' ? '未命名' : item.title
    const clock = item.time === '' ? '--:--' : item.time
    lines.push(`  ${clock} ${showTitle} S${item.season}E${item.episode}`)
  }
  if (todayItems.length > TODAY_MAX) lines.push(`  …另有 ${todayItems.length - TODAY_MAX} 条`)

  const dryRun = patchedItems.some((item) => item.action === 'dry-run')
  lines.push(`② 本次补订(${patchedItems.length})${dryRun ? ' [dry-run 未写入]' : ''}`)
  if (patchedItems.length === 0) lines.push('  本轮没有需要补订的条目')
  for (const item of patchedItems.slice(0, PATCHED_MAX)) {
    const showTitle = item.title === '' ? '未命名' : item.title
    lines.push(`  ${showTitle} S${item.season}: ${item.from_total} → ${item.to_total}`)
  }
  if (patchedItems.length > PATCHED_MAX) lines.push(`  …另有 ${patchedItems.length - PATCHED_MAX} 条`)

  lines.push(`③ 跳过 ${skipped} 条, 失败 ${failed} 条`)
  if (firstReason !== '') lines.push(`  首个原因: ${firstReason}`)

  return {
    title,
    body: truncateUtf8(lines.join('\n'), BODY_MAX),
  }
}

/**
 * 按宿主结论更新 daily 账本。
 * 只有 accepted / deduplicated 才记 last_sent_date；suppressed 留到下一小时重试；
 * 通道能力随每次响应原地更新（空上报也如实覆盖，不残留旧通道）。
 */
export function applyOutcome(daily, date, outcome, at) {
  daily.last_at = at
  daily.notify_channels = (outcome.channels ?? []).map((channel) => ({
    channel: channel.channel ?? '',
    preserved: [...(channel.preserved ?? [])],
    dropped: [...(channel.dropped ?? [])],
  }))
  if (outcome.accepted || outcome.deduplicated) {
    daily.last_sent_date = date
    daily.sent_total = Math.max(0, daily.sent_total ?? 0) + 1
    daily.last_result = outcome.accepted ? 'accepted' : 'deduplicated'
    daily.last_error = ''
    return
  }
  if (outcome.suppressed) {
    daily.last_result = 'suppressed'
    daily.last_error = truncateUtf8(outcome.suppression_reason ?? '', 200)
    return
  }
  daily.last_result = 'failed'
}
