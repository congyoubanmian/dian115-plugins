// 设置视图 —— 清单扁平设置（宿主 settings 表单 / settings 键 KV）与状态文档内嵌
// 设置（lists / blacklist）的拼装与清洗。
//
// 旧实现把全部设置放在状态文档 settings 里；v3 的做法（developer-guide「设置、图标
// 与菜单」）：扁平开关走清单 settings + 宿主 settings 表单，榜单/黑名单这类嵌套
// 配置仍留在状态文档。两处在本模块拼成一个运行时视图。

import { defaultSettings } from './model.js'

/** 清单 settings 的默认值（与 plugin.json 的 default 字段保持一致；宿主会叠加，这里是代码侧兜底）。 */
export const FLAT_DEFAULTS = {
  wish_sync_enabled: true,
  manual_cookie: '',
  cookiecloud_url: '',
  cookiecloud_uuid: '',
  cookiecloud_key: '',
  observe_period_hours: 24,
  auto_subscribe: true,
  notify_on_subscribe: true,
  min_rating: 0,
  min_year: 0,
  regions: '',
  subscribe_source_filter: '',
  max_history: 200,
  max_logs: 200,
}

function toNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function toBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function toStringOrEmpty(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

/** 逗号/顿号分隔 → 数组；逐项 trim、丢弃空项。 */
export function splitList(text) {
  return String(text ?? '')
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/**
 * 清单扁平设置 → 运行时视图（runtime.rs `Settings` 的扁平部分）。
 * 宿主 settings.get() 已做"默认值叠加已保存值"，这里再做类型收敛与兜底，
 * 保证脏值（表单传字符串数字等）不会漏进业务逻辑。
 */
export function normalizeFlat(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const merged = { ...FLAT_DEFAULTS, ...input }
  const minRating = toNumber(merged.min_rating, FLAT_DEFAULTS.min_rating)
  const minYear = Math.trunc(toNumber(merged.min_year, FLAT_DEFAULTS.min_year))
  const observe = Math.trunc(toNumber(merged.observe_period_hours, FLAT_DEFAULTS.observe_period_hours))
  return {
    wish_sync_enabled: toBool(merged.wish_sync_enabled, FLAT_DEFAULTS.wish_sync_enabled),
    manual_cookie: toStringOrEmpty(merged.manual_cookie).trim(),
    cookiecloud_url: toStringOrEmpty(merged.cookiecloud_url).trim(),
    cookiecloud_uuid: toStringOrEmpty(merged.cookiecloud_uuid).trim(),
    cookiecloud_key: toStringOrEmpty(merged.cookiecloud_key).trim(),
    observe_period_hours: observe > 0 ? observe : 0,
    auto_subscribe: toBool(merged.auto_subscribe, FLAT_DEFAULTS.auto_subscribe),
    notify_on_subscribe: toBool(merged.notify_on_subscribe, FLAT_DEFAULTS.notify_on_subscribe),
    // 数值只在"非负有限"时接受（runtime.rs settingsUpdate 的契约：负数当脏数据忽略）
    min_rating: Number.isFinite(minRating) && minRating >= 0 ? minRating : 0,
    min_year: Number.isFinite(minYear) && minYear >= 0 ? minYear : 0,
    regions: splitList(merged.regions),
    subscribe_source_filter: splitList(merged.subscribe_source_filter),
    max_history: Math.trunc(toNumber(merged.max_history, FLAT_DEFAULTS.max_history)),
    max_logs: Math.trunc(toNumber(merged.max_logs, FLAT_DEFAULTS.max_logs)),
  }
}

/**
 * 把扁平设置合并进保存用的 settings KV 对象（settings-update 的写路径）：
 * 只覆盖补丁里出现的键，值为空串的 regions/subscribe_source_filter 归一成 ''。
 */
export function applyFlatPatch(saved, patch) {
  const next = { ...(saved && typeof saved === 'object' ? saved : {}) }
  for (const key of Object.keys(FLAT_DEFAULTS)) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key]
  }
  return next
}

/**
 * runtime.rs `normalize_settings`：即将上映强制 coming_html/movie 来源，
 * 并把缺失的榜单键从默认配置补回（状态未加载时保存会丢键）。
 */
export function normalizeDocSettings(docSettings) {
  const defaults = defaultSettings().lists
  const lists = docSettings?.lists ? { ...docSettings.lists } : {}
  for (const [key, config] of Object.entries(defaults)) {
    if (!lists[key]) lists[key] = { ...config }
  }
  const upcoming = { ...(lists.upcoming ?? {}) }
  if (upcoming.source !== 'coming_html' || upcoming.type !== 'movie') {
    upcoming.source = 'coming_html'
    upcoming.type = 'movie'
    upcoming.sort = ''
    upcoming.tag = ''
    if (!(upcoming.limit > 0)) upcoming.limit = 20
    upcoming.enabled = true
  }
  lists.upcoming = upcoming
  return { ...docSettings, lists }
}
