// 追剧管家 —— 纯视觉层的派生与小工具（不碰 ctx、不改业务语义）。
//
// - 迷你折线：按本地日期把运行日志分桶（数据不足时不画，绝不编造）；
//   数字递增与折线路径已交给 shared 组件（shared/components/StatTile、Sparkline）；
// - 进度环：Emby 已入库 / 该季目标；
// - 海报：状态文档里若带了 http(s) 海报地址就用，没有就用首字头像；
// - 日报预览：复用 lib/notify.js 的 compose()（与后台发送同一份文案逻辑）。

import type { AlignItem, CalendarDay, LogEntry, StateDoc } from './types'
import { list, localDateOf, num, targetKnown, text } from './format'
// @ts-ignore —— lib/notify.js 是纯 JS 模块，没有类型声明；打包时内联进 ui/page.js。
import { compose } from '../../../v3/chase-rs/lib/notify.js'

const DAY_MS = 86_400_000

/** 最近 n 个本地日期（旧 → 新）。 */
export function recentDates(offsetMinutes: number, n = 7): string[] {
  const out: string[] = []
  const now = Date.now() + offsetMinutes * 60_000
  for (let i = n - 1; i >= 0; i -= 1) out.push(new Date(now - i * DAY_MS).toISOString().slice(0, 10))
  return out
}

/** 按本地日期给日志分桶计数；没有任何命中返回空数组（调用方据此不画折线）。 */
export function logSeries(
  logs: LogEntry[],
  offsetMinutes: number,
  match: (entry: LogEntry) => boolean,
  days = 7,
): number[] {
  const dates = recentDates(offsetMinutes, days)
  const counts = dates.map(() => 0)
  let hits = 0
  for (const entry of logs) {
    if (!match(entry)) continue
    const index = dates.indexOf(localDateOf(offsetMinutes, text(entry.at, '')))
    if (index >= 0) {
      counts[index] += 1
      hits += 1
    }
  }
  return hits > 0 ? counts : []
}

/** 单行进度环的数据：Emby 已入库 / 目标，以及订阅集数 / 目标。 */
export interface RingData {
  have: number
  total: number
  sub: number
  /** 0–100；have 未探测时为 -1。 */
  havePct: number
  subPct: number
  label: string
}

export function ringOf(item: AlignItem): RingData {
  const have = num(item.emby_have_max, -1)
  const sub = num(item.total_known, 0)
  const total = targetKnown(item) ? num(item.target_upper, 0) : Math.max(sub, have, 0)
  const pct = (value: number) => (total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0)
  const label =
    have >= 0
      ? `Emby 已入库 ${have} 集 / ${targetKnown(item) ? 'TMDB 目标' : '已知上限'} ${total} 集，订阅 ${sub} 集`
      : `Emby 未探测，订阅 ${sub} 集`
  return { have, total, sub, havePct: have >= 0 ? pct(have) : -1, subPct: pct(sub), label }
}

/** 状态文档里可能带的海报地址（规格外字段，只认 http(s) 绝对地址）。 */
export function posterOf(item: AlignItem): string {
  const loose = item as Record<string, unknown>
  for (const key of ['poster', 'poster_url', 'poster_path', 'cover', 'image']) {
    const value = loose[key]
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value
  }
  return ''
}

/** 首字头像。 */
export function monogram(title: string): string {
  const trimmed = title.trim()
  return trimmed ? Array.from(trimmed)[0].toUpperCase() : '?'
}

/** 首字头像的色调档位（0–4），用于在主题色上做不同深浅。 */
export function toneIndex(seed: string): number {
  let hash = 0
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return hash % 5
}

/** 日报预览：与 jobs/runtime.js 的 maybeSendDaily 同口径组装。 */
export function reportPreview(state: StateDoc | null, today: string): { title: string; body: string } {
  const align = state?.align ?? {}
  const items = list(align.items)
  const day = list<CalendarDay>(state?.calendar?.days).find((d) => text(d.date, '') === today)
  const todayItems = list(day?.items).map((entry) => ({
    title: text(entry.title, ''),
    time: text(entry.time, ''),
    season: num(entry.season, 0),
    episode: num(entry.episode, 0),
  }))
  const patched = items
    .filter((item) => item.action === 'patched' || item.action === 'dry-run')
    .map((item) => ({ ...item, title: text(item.title, ''), from_total: num(item.from_total, 0), to_total: num(item.to_total, 0), season: num(item.season, 0) }))
  const firstReason =
    items.find((item) => (item.action === 'failed' || item.action === 'skipped') && text(item.reason, '') !== '')
      ?.reason ??
    align.last_error ??
    ''
  return compose(today, todayItems, patched, num(align.skipped, 0), num(align.failed, 0), firstReason) as {
    title: string
    body: string
  }
}

/** HH:mm → 一天中的分钟数；认不出返回 -1。 */
export function minutesOf(time: string): number {
  const match = /(\d{1,2}):(\d{2})/.exec(time)
  if (!match) return -1
  const h = Number(match[1])
  const m = Number(match[2])
  return h < 24 && m < 60 ? h * 60 + m : -1
}
