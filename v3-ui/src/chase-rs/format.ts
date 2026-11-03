// 追剧管家 —— 纯展示助手（无副作用、不碰网络、不读 ctx）。
//
// 逐条对应原生 JS 版页面（v3-ui/legacy/chase-rs/page.native.js）里的同名函数，
// 也对齐旧 Vue 版 plugins/chase-rs/frontend/src/chase-state.ts 的语义：
// 认不出的字段就照原样显示，绝不猜。

import type { AlignItem, ReasonBadge, ReasonKind } from './types'

/** 文本：null / undefined / '' 走 fallback。 */
export function text(value: unknown, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback
  return String(value)
}

/** 数字：非有限数走 fallback。 */
export function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 数组：不是数组就当空数组。 */
export function list<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : []
}

/** RFC3339 → `YYYY-MM-DD HH:mm`；认不出的原样回显（不猜）。 */
export function formatAt(value: unknown): string {
  const raw = text(value, '')
  if (!raw) return '—'
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(raw)
  if (!match) return raw
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`
}

/** 只要时分（`HH:mm`）；没有就空串。 */
export function timeAt(value: unknown): string {
  const formatted = formatAt(value)
  if (formatted === '—') return ''
  const parts = formatted.split(' ')
  return parts.length === 2 ? parts[1] : formatted
}

/** 只要秒（`HH:mm:ss`），用于日志行。 */
export function timeLongAt(value: unknown): string {
  const raw = text(value, '')
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(raw)
  return match ? match[1] : formatAt(raw)
}

/** 本地日期 `YYYY-MM-DD`（按设置的时区偏移换算，与运行时 clock::local_date 同义）。 */
export function localDateOf(offsetMinutes: number, at?: unknown): string {
  const base = at === undefined ? Date.now() : typeof at === 'string' && at !== '' ? Date.parse(at) : NaN
  if (!Number.isFinite(base)) return ''
  const shifted = new Date(base + offsetMinutes * 60_000)
  return shifted.toISOString().slice(0, 10)
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** `YYYY-MM-DD` → 星期几；认不出返回空串。 */
export function weekdayOf(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return ''
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
  return WEEKDAYS[day] ?? ''
}

/** 季标签：`S05` / `整剧`（季未知或 0）。 */
export function seasonPad(season: unknown): string {
  const value = num(season, 0)
  return value > 0 ? `S${String(value).padStart(2, '0')}` : '整剧'
}

/** Emby 覆盖副标题：探到集号就报集号，没探到就说没探到（不假装 0 集）。 */
export function coverageSub(item: AlignItem): string {
  const have = num(item.emby_have_max, -1)
  return have >= 0 ? `Emby 至 E${String(have).padStart(2, '0')}` : 'Emby 未探测'
}

/** 有缺口：Emby 探到了、且缺口上沿 > 0。 */
export function hasGap(item: AlignItem): boolean {
  return num(item.emby_have_max, -1) >= 0 && num(item.gap_max, 0) > 0
}

/** TMDB 目标是否已知（缺 target_known 的旧行按 target_upper > 0 兜底）。 */
export function targetKnown(item: AlignItem): boolean {
  return item.target_known ?? num(item.target_upper, 0) > 0
}

/** 日历条目：`S5 E4`；季 ≤1 时只留 `E4`。 */
export function episodeCompact(season: unknown, episode: unknown): string {
  const ep = num(episode, 0)
  if (ep <= 0) return ''
  const s = num(season, 0)
  return s > 1 ? `S${s} E${ep}` : `E${ep}`
}

/** 探测失败（结构未识别 / HTTP 错误）——空态文案与告警共用的判据。 */
export function probeFailed(status: unknown): boolean {
  return status === 'unparsed' || status === 'http_error'
}

/** 动作词的展示文案。 */
export function alignActionLabel(action: unknown): string {
  switch (action) {
    case 'patched':
      return '已补订'
    case 'dry-run':
      return '待补订(dry-run)'
    case 'skipped':
      return '跳过'
    case 'failed':
      return '失败'
    default:
      return action === '' || action === undefined || action === null ? '' : text(action)
  }
}

/**
 * reason 的分类。
 *
 * 顺序即优先级：动作词 > 「Emby 未收录」> 失败 > 「该季 0 集」> 「覆盖未知」>
 * 「目标未知」> 「无缺口」；认不出的一律 other，界面照原样显示 reason 原文。
 *
 * 「Emby 未收录」不看动作词：整点 job 记 failed、立即对齐记 skipped，同一个事实
 * 必须打同一个徽章。
 */
export function reasonBadge(item: AlignItem): ReasonBadge {
  const reason = text(item.reason, '')
  const action = text(item.action, '')
  if (action === 'patched') return { kind: 'patched', label: '已补订' }
  if (action === 'dry-run') return { kind: 'patched', label: '待补订(dry-run)' }
  if (reason.includes('Emby 未收录')) return { kind: 'absent', label: 'Emby 无此剧' }
  if (action === 'failed') return { kind: 'failed', label: '失败' }
  if (reason.includes('Emby 该季 0 集')) return { kind: 'empty-season', label: '未收录/未入库' }
  if (reason.includes('覆盖未知')) return { kind: 'unknown-coverage', label: '覆盖未知' }
  // 覆盖已核实但目标未知不是无缺口：必须排在「无缺口」之前。
  if (reason.includes('目标未知')) return { kind: 'target-unknown', label: '目标未知' }
  if (reason.includes('无缺口')) return { kind: 'no-gap', label: '无缺口' }
  return { kind: 'other', label: alignActionLabel(action) || '跳过' }
}

/** 需要单独标红/标黄的类别（对齐结果卡的「异常」筛选）。 */
export const ABNORMAL_KINDS: ReadonlySet<ReasonKind> = new Set<ReasonKind>([
  'failed',
  'absent',
  'empty-season',
  'unknown-coverage',
])

/** 缺口格：`+N` / `待探测` / `0` / `—`。 */
export function gapCell(item: AlignItem): { label: string; cls: string } {
  if (hasGap(item)) return { label: `+${num(item.gap_max, 0)}`, cls: 'gap-num' }
  const reason = text(item.reason, '')
  if (reason.includes('下轮优先') || reason.includes('预算用尽')) return { label: '待探测', cls: 'gap-probe' }
  if (num(item.emby_have_max, -1) >= 0) return { label: '0', cls: 'muted' }
  return { label: '—', cls: 'muted' }
}

/** 动作格：`补订至 N` / `待补订至 N` / 失败行的「重试」 / `—`。 */
export function actionCell(item: AlignItem, kind: ReasonKind): { label: string; cls: string } {
  switch (item.action) {
    case 'patched':
      return { label: `补订至 ${num(item.to_total, 0)}`, cls: 'action-link' }
    case 'dry-run':
      return { label: `待补订至 ${num(item.to_total, 0)}`, cls: 'action-dry' }
    case 'failed':
      return kind === 'failed' ? { label: '重试', cls: 'action-link' } : { label: '—', cls: 'muted' }
    default:
      return { label: '—', cls: 'muted' }
  }
}

/** 结果行下方的补充说明（动作结果或 reason 原文）。 */
export function alignActionResultText(item: AlignItem): string {
  const from = num(item.from_total, 0)
  const to = num(item.to_total, 0)
  switch (item.action) {
    case 'patched':
      return `已补订 ${from} → ${to}`
    case 'dry-run':
      return `待补订 ${from} → ${to}（dry-run, 未写入）`
    case 'skipped':
      return `跳过: ${text(item.reason, '未给原因')}`
    case 'failed':
      return `失败: ${text(item.reason, '未给原因')}`
    default:
      return text(item.reason, '—')
  }
}
