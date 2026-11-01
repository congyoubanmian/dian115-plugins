// 豆瓣中心页面用到的状态文档视图类型。
//
// 字段名与 v3/douban-rs/lib/model.js 的解析契约一致：状态文档既是后端落盘契约，
// 也是页面 UI 契约（同一份 parseStateDoc 解析出来的结构）。这里只声明页面真正
// 读到的字段，其余用索引签名兜住，避免页面因为后端新增字段而编译不过。

/** 榜单条目（snapshot.lists[*][]）。 */
export interface ChartItem {
  title?: string
  poster_url?: string
  douban_ref?: string
  url?: string
  rate?: string
  year?: string
  rank?: number | string
  hotness?: number | string
  [key: string]: unknown
}

/** 观察队列条目（queue.items[]）。 */
export interface QueueItem {
  title?: string
  poster_url?: string
  douban_ref?: string
  url?: string
  state?: string
  list?: string
  media_type?: string
  year?: string
  rating?: number | string
  due_at?: string
  tmdb_ref?: string
  attempt?: number
  last_error?: string
  [key: string]: unknown
}

/** 「我的想看」条目（wish[]）。 */
export interface WishItem {
  title?: string
  poster_url?: string
  douban_ref?: string
  url?: string
  type?: string
  year?: string
  rating?: number | string
  added_at?: string
  [key: string]: unknown
}

/** 订阅历史条目（history[]）。 */
export interface HistoryEntry {
  created_at?: string
  title?: string
  douban_ref?: string
  list?: string
  action?: string
  result?: string
  message?: string
  tmdb_ref?: string
  intent_id?: number | string
  [key: string]: unknown
}

/** 运行日志条目（logs[]）。 */
export interface LogEntry {
  at?: string
  level?: string
  message?: string
  [key: string]: unknown
}

/** 想看同步信息（wish_info）。 */
export interface WishInfo {
  last_sync?: string
  last_status?: string
  last_count?: number
  last_new?: number
  last_error?: string
  uid?: string
  source?: string
  [key: string]: unknown
}

/** 黑名单命中记录（blackstate.recent[]）。 */
export interface BlackHit {
  title?: string
  keyword?: string
  at?: string
  [key: string]: unknown
}

/** 黑名单状态（blackstate）。 */
export interface BlackState {
  hits?: number
  recent?: BlackHit[]
  [key: string]: unknown
}

/** 订阅统计（stats）。 */
export interface Stats {
  total?: number
  month_new?: number
  month?: string
  last_archive_at?: string
  [key: string]: unknown
}

/** 单个榜单的配置（settings.lists[key]）。 */
export interface ListConfig {
  enabled?: boolean
  source?: string
  type?: string
  tag?: string
  sort?: string
  limit?: number
  [key: string]: unknown
}

/** 状态文档里的设置（settings）：清单扁平设置之外还留着榜单与黑名单等嵌套配置。 */
export interface DocSettings {
  lists?: Record<string, ListConfig>
  blacklist?: string[]
  cookiecloud_url?: string
  cookiecloud_uuid?: string
  cookiecloud_key?: string
  manual_cookie?: string
  wish_sync_enabled?: boolean
  [key: string]: unknown
}

/** 状态文档里设置的脱敏视图（凭据不回显，只有 cc_key_set / cc_manual_set 布尔）。 */
export interface SettingsView {
  cc_url?: string
  cc_uuid?: string
  cc_key_set?: boolean
  cc_manual_set?: boolean
  [key: string]: unknown
}

/** 状态文档（storage 的 `state` 键）。 */
export interface StateDoc {
  settings?: DocSettings
  snapshot?: { fetched_at?: string; lists?: Record<string, ChartItem[]> | null }
  queue?: { items?: QueueItem[] | null }
  history?: HistoryEntry[] | null
  logs?: LogEntry[] | null
  stats?: Stats
  blackstate?: BlackState
  wish?: WishItem[] | null
  wish_info?: WishInfo
  cookie?: { source?: string; uid?: string; fetched_at?: string }
  no_resub?: Record<string, { reason?: string; at?: string }> | null
  no_resub_scan_at?: string
  [key: string]: unknown
}

/** 清单扁平设置（宿主 settings KV，lib/settings.js 的运行时视图）。 */
export interface FlatSettings {
  wish_sync_enabled: boolean
  manual_cookie: string
  cookiecloud_url: string
  cookiecloud_uuid: string
  cookiecloud_key: string
  observe_period_hours: number
  auto_subscribe: boolean
  notify_on_subscribe: boolean
  min_rating: number
  min_year: number
  regions: string[]
  subscribe_source_filter: string[]
  max_history: number
  max_logs: number
}
