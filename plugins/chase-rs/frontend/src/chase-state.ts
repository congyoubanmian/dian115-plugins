// 追剧管家 —— 状态文档类型与纯展示助手(无副作用, 不碰网络)。
//
// 逐键对应运行时 `plugins/chase-rs/src/model.rs` 的 `StateDoc`(serde `default`:
// 缺键 = 默认值, 所以这里全部可选)。界面只读这些键, 一个字段都不猜:
// `emby_have_max = -1` 表示"没探测到", 不是 0 集。

/** 逐条对齐结果(model.rs `AlignItem`)。 */
export interface AlignItem {
  intent_id?: number
  tmdb_id?: number
  season?: number
  title?: string
  total_known?: number
  /** Emby 已有集的最大集号; -1 = 未知。 */
  emby_have_max?: number
  /** Emby 已有集的条数; -1 = 未知。 */
  emby_have_count?: number
  /** 缺口上沿 = max(0, emby_have_max - total_known)。 */
  gap_max?: number
  from_total?: number
  to_total?: number
  /** `patched` | `dry-run` | `skipped` | `failed`。 */
  action?: string
  reason?: string
  at?: string
}

/** 减方向只读建议(model.rs `TrimSuggestion`)。 */
export interface TrimSuggestion {
  intent_id?: number
  tmdb_id?: number
  season?: number
  title?: string
  total_known?: number
  emby_have_max?: number
  /** 建议裁剪到的目标上限(该季 TMDB 集数)。 */
  target_upper?: number
  reason?: string
  at?: string
}

/** 追剧日历里的一条(model.rs `CalendarItem`)。 */
export interface CalendarItem {
  tmdb_id?: number
  season?: number
  episode?: number
  title?: string
  /** 播出时间文本; 解析不出就是空串(不猜)。 */
  time?: string
}

/** 追剧日历里的一天(model.rs `CalendarDay`)。 */
export interface CalendarDay {
  /** `YYYY-MM-DD`。 */
  date?: string
  items?: CalendarItem[]
}

/** 一次端点探测快照(model.rs `ProbeSnapshot`)。 */
export interface ProbeSnapshot {
  /** `ok` | `unparsed` | `http_error` | `skipped` | `never`。 */
  status?: string
  shape?: string
  params_tried?: string[]
  http_status?: number
  /** ≤2048 字节的脱敏原文片段。 */
  sample?: string
  at?: string
}

/** 状态文档(model.rs `StateDoc`)。 */
export interface AppState {
  schema_version?: number
  revision?: number
  status?: string
  last_message?: string
  last_run?: string
  settings?: {
    enabled?: boolean
    /** -1 = 跟随宿主默认实例; ≥1 = 指定实例 id; 0 = 旧版单实例。 */
    emby_proxy_id?: number
    max_patch_per_run?: number
    max_raise_per_run?: number
    catch_up_days?: number
    emby_probe_budget?: number
    dry_run?: boolean
    write_episode_strings?: boolean
    report?: { enabled?: boolean; hour?: number; tz_offset_minutes?: number }
    probe?: { emby_episodes_shape?: string; air_calendar_shape?: string }
  }
  align?: {
    last_run_at?: string
    pages?: number
    intents_seen?: number
    matched?: number
    patched?: number
    skipped?: number
    failed?: number
    last_error?: string
    items?: AlignItem[]
  }
  trim_suggestions?: TrimSuggestion[]
  calendar?: { fetched_at?: string; days?: CalendarDay[] }
  daily?: {
    last_sent_date?: string
    last_at?: string
    /** `accepted` | `deduplicated` | `suppressed` | `failed` | ""。 */
    last_result?: string
    last_error?: string
    sent_total?: number
  }
  debug?: {
    updated_at?: string
    emby_episodes?: ProbeSnapshot
    air_calendar?: ProbeSnapshot
    /** 规格外扩展槽: 订阅池列表解析失败时的原文现场。 */
    pool_intents?: ProbeSnapshot
    attempts?: Array<{ endpoint?: string; params?: string; http_status?: number; shape?: string; at?: string }>
    last_errors?: Array<{ step?: string; message?: string; at?: string }>
  }
  stats?: { tv_intents?: number; matched?: number; aligned?: number; gap_total?: number; unknown_shape?: number }
  logs?: Array<{ at?: string; level?: string; message?: string }>
  emby_instances?: Array<{ id?: number; name?: string; is_default?: boolean; key_ready?: boolean; at?: string }>
  [key: string]: unknown
}

export interface RuntimeCallback {
  invocation_id?: string
  replayed?: boolean
  result?: {
    status?: 'succeeded' | 'failed' | 'accepted' | 'skipped'
    message?: string
    patched?: number
    skipped?: number
    failed?: number
    planned?: number
    budget_hit?: boolean
    changed?: string[]
    [key: string]: unknown
  }
}

/** 宿主的唯一交互桥(douban-center/src/AppPage.vue:49-53 的同名契约)。 */
export interface HostBridge {
  getState(view?: string): Promise<{ state?: Record<string, unknown>; state_version?: string; etag?: string }>
  invokeAction(action: string, input?: unknown): Promise<RuntimeCallback>
  refresh(): Promise<Record<string, unknown>>
}

// ─────────────────────────── 纯展示助手 ───────────────────────────

export function text(value: unknown, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback
  return String(value)
}

export function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function list<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : []
}

/** RFC3339 → 本地可读; 认不出的原样回显(不猜)。 */
export function formatAt(value: unknown): string {
  const raw = text(value, '')
  if (!raw) return '—'
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(raw)
  if (!match) return raw
  const [, y, mo, d, h, mi] = match
  return `${y}-${mo}-${d} ${h}:${mi}`
}

/** `S5` / 0 或缺失时给「整剧」。 */
export function seasonLabel(season: unknown): string {
  const value = num(season, 0)
  return value > 0 ? `S${value}` : '整剧'
}

/** 日历里的一条: `S5E4`, 季未知时只留 `E4`。 */
export function episodeLabel(season: unknown, episode: unknown): string {
  const value = num(season, 0)
  const ep = num(episode, 0)
  return value > 0 ? `S${value}E${ep}` : `E${ep}`
}

/** 缺口集号区间: 订阅 N 集、Emby 到 M 集 ⇒ `N+1-M`; 无缺口/未知各有专门文案。 */
export function gapRange(item: AlignItem): string {
  const have = num(item.emby_have_max, -1)
  if (have < 0) return '未知'
  const gap = num(item.gap_max, 0)
  if (gap <= 0) return '无缺口'
  const known = num(item.total_known, 0)
  return `${known + 1}-${have}`
}

export function hasGap(item: AlignItem): boolean {
  return num(item.emby_have_max, -1) >= 0 && num(item.gap_max, 0) > 0
}

export function alignActionLabel(action: string | undefined): string {
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
      return text(action)
  }
}

export function alignActionResult(item: AlignItem): string {
  const from = num(item.from_total, 0)
  const to = num(item.to_total, 0)
  switch (item.action) {
    case 'patched':
      return `已补订 ${from} → ${to}`
    case 'dry-run':
      return `待补订 ${from} → ${to}(dry-run, 未写入)`
    case 'skipped':
      return `跳过: ${text(item.reason, '未给原因')}`
    case 'failed':
      return `失败: ${text(item.reason, '未给原因')}`
    default:
      return text(item.reason, '—')
  }
}

export type TagType = 'default' | 'primary' | 'info' | 'success' | 'warning' | 'error'

export function alignActionTagType(action: string | undefined): TagType {
  switch (action) {
    case 'patched':
      return 'success'
    case 'dry-run':
      return 'warning'
    case 'failed':
      return 'error'
    default:
      return 'default'
  }
}

export function probeStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'ok':
      return '已识别'
    case 'unparsed':
      return '结构未识别'
    case 'http_error':
      return 'HTTP 错误'
    case 'skipped':
      return '本轮跳过'
    case 'never':
      return '从未探测'
    default:
      return text(status, '从未探测')
  }
}

export function probeStatusType(status: string | undefined): TagType {
  switch (status) {
    case 'ok':
      return 'success'
    case 'unparsed':
      return 'warning'
    case 'http_error':
      return 'error'
    default:
      return 'default'
  }
}

/** 探测失败(结构未识别 / HTTP 错误)——空态文案与警告共用的判据。 */
export function probeFailed(status: string | undefined): boolean {
  return status === 'unparsed' || status === 'http_error'
}

/** 本地日期的 `YYYY-MM-DD`(时区偏移取自日报设置, 与运行时 `clock::local_date` 同义)。 */
export function localDate(offsetMinutes: number): string {
  const shifted = new Date(Date.now() + offsetMinutes * 60_000)
  return shifted.toISOString().slice(0, 10)
}
