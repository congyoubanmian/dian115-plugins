// 页面里的小工具函数（与原生 JS 版逐字对齐的格式化逻辑）。

import { LIST_META, LIST_ORDER, SOURCE_LABEL, TYPE_LABEL } from './constants'
import type { ListConfig } from './types'

/** 取字符串；null/undefined 走兜底。 */
export function text(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return fallback
  return String(value)
}

/** 取有限数字；否则走兜底。 */
export function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 时间格式化：YYYY-MM-DD HH:mm（宿主时区）。 */
export function formatTime(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return ''
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return value
  const date = new Date(parsed)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 条目的到期时间（毫秒）；没有或不可解析时返回 null。 */
export function dueAtMs(item: { due_at?: string } | null | undefined): number | null {
  if (typeof item?.due_at !== 'string' || item.due_at === '') return null
  const parsed = Date.parse(item.due_at)
  return Number.isFinite(parsed) ? parsed : null
}

/** 条目是否已到期。 */
export function isDue(item: { due_at?: string } | null | undefined): boolean {
  const due = dueAtMs(item)
  return due !== null && due <= Date.now()
}

/** 到期文案。 */
export function dueLabel(item: { due_at?: string } | null | undefined): string {
  const due = dueAtMs(item)
  if (due === null) return '待后台处理'
  const diff = due - Date.now()
  if (diff <= 0) return '已到期'
  const hours = Math.ceil(diff / 3_600_000)
  if (hours < 48) return `${hours} 小时后`
  return `${Math.ceil(hours / 24)} 天后`
}

/** 榜单标题。 */
export function listTitle(key: string): string {
  if (key === 'wish') return '我的想看'
  return LIST_META[key]?.name ?? key
}

/** 榜单副标题：来源 · 类型 · 标签。 */
export function listHint(key: string, config?: ListConfig | null): string {
  const parts: string[] = []
  if (config?.source) parts.push(SOURCE_LABEL[config.source] ?? config.source)
  if (config?.type) parts.push(TYPE_LABEL[config.type] ?? config.type)
  if (config?.tag) parts.push(config.tag)
  return parts.join(' · ') || LIST_META[key]?.hint || ''
}

/** 条目的豆瓣页面地址：优先条目自带 url，否则由 db:subj:<id> 拼出来。 */
export function doubanHref(item: { url?: string; douban_ref?: string } | null | undefined): string {
  const direct = text(item?.url)
  if (direct) return direct
  const match = /^db:subj:(.+)$/.exec(text(item?.douban_ref))
  return match ? `https://www.douban.com/subject/${encodeURIComponent(match[1])}/` : ''
}

/** 逗号/顿号/换行分隔的列表 → 数组（trim、丢空项）。 */
export function splitListValue(value: unknown): string[] {
  return String(value ?? '')
    .split(/[,，、\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/** 榜单键排序：按 LIST_ORDER，已知在前，未知按字典序排在后面。 */
export function sortListKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const ai = LIST_ORDER.indexOf(a)
    const bi = LIST_ORDER.indexOf(b)
    if (ai === -1 && bi === -1) return a.localeCompare(b)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
}
