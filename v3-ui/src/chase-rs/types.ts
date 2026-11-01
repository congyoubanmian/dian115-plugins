// 追剧管家 —— 状态文档与设置的类型声明。
//
// 字段逐个对照 v3/chase-rs/lib/state.js 的 newStateDoc()（旧 Rust 版见
// plugins/chase-rs/frontend/src/chase-state.ts 的 AppState）。
//
// 两条 v3 专属约定：
// 1. 状态文档**不再内嵌 settings**（v3 迁移后用户设置走 ctx.settings，宿主存插件 KV 的
//    `settings` 键）。所以界面里的「启用 / dry-run / 日报」一律读扁平设置，不读文档。
// 2. 文档里所有键都是可选的：缺键 = 默认值，界面一个字段都不猜。

/** 逐条对齐结果（lib/state.js 的 align.items[]）。 */
export interface AlignItem {
  intent_id?: number
  tmdb_id?: number
  season?: number
  title?: string
  /** 订阅侧已知的总集数。 */
  total_known?: number
  /** Emby 已有集的最大集号；-1 = 没探测到（不是 0 集）。 */
  emby_have_max?: number
  /** Emby 已有集的条数；-1 = 未知。 */
  emby_have_count?: number
  /** 缺口上沿 = max(0, emby_have_max - total_known)。 */
  gap_max?: number
  /** 该季 TMDB 目标集数；target_known=false 时这个 0 表示「没取到」，不是「0 集」。 */
  target_upper?: number
  /** 目标是否真的取到了；缺字段的旧文档按 target_upper > 0 兜底。 */
  target_known?: boolean
  from_total?: number
  to_total?: number
  /** `patched` | `dry-run` | `skipped` | `failed`。 */
  action?: string
  reason?: string
  at?: string
}

/** 减方向只读建议（lib/state.js 的 trim_suggestions[]）。 */
export interface TrimSuggestion {
  intent_id?: number
  tmdb_id?: number
  season?: number
  title?: string
  total_known?: number
  emby_have_max?: number
  /** 建议裁剪到的目标上限（该季 TMDB 集数）。 */
  target_upper?: number
  reason?: string
  at?: string
}

/** 追剧日历里的一条。 */
export interface CalendarItem {
  tmdb_id?: number
  season?: number
  episode?: number
  title?: string
  /** 播出时间文本；解析不出就是空串（不猜）。 */
  time?: string
}

/** 追剧日历里的一天。 */
export interface CalendarDay {
  /** `YYYY-MM-DD`。 */
  date?: string
  items?: CalendarItem[]
}

/** 一次端点探测快照。 */
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

/** 一次 host.call 尝试记录。 */
export interface ProbeAttempt {
  endpoint?: string
  params?: string
  http_status?: number
  shape?: string
  at?: string
}

/** 一条错误记录。 */
export interface LastError {
  step?: string
  message?: string
  at?: string
}

/** 一条运行日志。 */
export interface LogEntry {
  at?: string
  level?: string
  message?: string
}

/** 宿主侧读到的 Emby 实例。 */
export interface EmbyInstance {
  id?: number
  name?: string
  is_default?: boolean
  key_ready?: boolean
  at?: string
}

/** 状态文档（lib/state.js 的 StateDoc）。 */
export interface StateDoc {
  schema_version?: number
  revision?: number
  /** 整体状态；`failed` 时页头显示「运行异常」。 */
  status?: string
  last_message?: string
  last_run?: string
  align?: {
    last_run_at?: string
    pages?: number
    intents_seen?: number
    matched?: number
    patched?: number
    skipped?: number
    failed?: number
    /** Emby 明确「该季 0 集 / 未收录」的条目数（独立分类，不计 failed）。 */
    absent?: number
    /** 本轮没探到、下一轮优先补探的条目数。 */
    pending_probe?: number
    last_error?: string
    items?: AlignItem[]
  }
  trim_suggestions?: TrimSuggestion[]
  calendar?: { fetched_at?: string; days?: CalendarDay[] }
  daily?: {
    last_sent_date?: string
    last_at?: string
    last_result?: string
    last_error?: string
    sent_total?: number
    notify_channels?: string[]
  }
  debug?: {
    updated_at?: string
    emby_episodes?: ProbeSnapshot
    emby_instances?: ProbeSnapshot
    air_calendar?: ProbeSnapshot
    /** 规格外扩展槽：订阅池列表解析失败时的原文现场。 */
    pool_intents?: ProbeSnapshot
    /** 该季 TMDB 目标的取数现场。 */
    tmdb_target?: ProbeSnapshot
    attempts?: ProbeAttempt[]
    last_errors?: LastError[]
  }
  stats?: { tv_intents?: number; matched?: number; aligned?: number; gap_total?: number; unknown_shape?: number }
  logs?: LogEntry[]
  emby_instances?: EmbyInstance[]
  [key: string]: unknown
}

/**
 * 扁平用户设置（plugin.json 的 settings[] / ctx.settings）。
 * 键名与 v3/chase-rs/lib/settings.js 的 FLAT_KEYS 一一对应。
 */
export interface FlatSettings {
  enabled: boolean
  auto_bump: boolean
  dry_run: boolean
  write_episode_strings: boolean
  emby_proxy_id: number
  max_patch_per_run: number
  max_raise_per_run: number
  catch_up_days: number
  emby_probe_budget: number
  report_enabled: boolean
  report_hour: number
  report_tz_offset_minutes: number
}

/** 设置表单里的一个字段。 */
export type FormKind = 'boolean' | 'number' | 'instance'

export interface FormField {
  key: keyof FlatSettings
  label: string
  kind: FormKind
  help: string
}

/** 页面上可触发的前台动作（对应 plugin.json 里的 queue:false 任务）。 */
export type ActionName = 'refresh' | 'align-now' | 'probe-dump'

/** 徽章类别（对齐结果行）。 */
export type ReasonKind =
  | 'patched'
  | 'absent'
  | 'empty-season'
  | 'unknown-coverage'
  | 'target-unknown'
  | 'no-gap'
  | 'failed'
  | 'other'

export interface ReasonBadge {
  kind: ReasonKind
  /** 徽章短词。 */
  label: string
}

/** 对齐结果的一行（原始条目 + 徽章）。 */
export interface AlignRow {
  item: AlignItem
  badge: ReasonBadge
}

/** 指标瓦片。 */
export interface Tile {
  key: string
  label: string
  value: number
  /** 配色语义：primary / success / warning / error / default。 */
  tone: 'default' | 'primary' | 'success' | 'warning' | 'error'
}

/** 追剧日历里的一条（摊平后的展示形态）。 */
export interface CalendarEntry {
  key: string
  dayLabel: string
  isToday: boolean
  title: string
  episode: string
  time: string
}

/** 顶部浮出的提示。 */
export interface ToastItem {
  id: number
  kind: 'success' | 'error' | 'warning' | 'info'
  message: string
}
