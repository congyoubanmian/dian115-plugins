// 状态文档模型 —— plugins/douban-rs/src/model.rs 的移植。
//
// 字段名与旧宿主存储文档逐一一致（settings/snapshot/queue/history/logs/stats/
// blackstate/wish/wish_seen/wish_info/cookie/no_resub/no_resub_scan_at），这份文档
// 既是落盘契约也是 UI 契约。JS 侧用 null 表达 Go 的 nil、[] 表达空切片，
// 读写两端都按"缺字段 → 零值、类型不符 → 拒绝"对齐。

/** 落盘预算（runtime.rs MAX_PERSIST_BYTES）：单文档超过即放弃本次落盘。 */
export const MAX_PERSIST_BYTES = 4 << 20
/** 落盘时只保留最近多少条日志（PERSIST_LOG_LIMIT）。 */
export const PERSIST_LOG_LIMIT = 40
/** 单条日志长度上限（LOG_MESSAGE_LIMIT），按字节。 */
export const LOG_MESSAGE_LIMIT = 400
/** state 响应里历史/日志的裁剪上限（STATE_HISTORY_LIMIT / STATE_LOGS_LIMIT）。 */
export const STATE_HISTORY_LIMIT = 30
export const STATE_LOGS_LIMIT = 50

/** 榜单键 `upcoming`（runtime.rs listUpcoming）。 */
export const LIST_UPCOMING = 'upcoming'

/** 榜单来源配置（model.rs ListConfig）。 */
export function newListConfig() {
  return { source: '', type: 'movie', tag: '', sort: '', limit: 0, enabled: false }
}

/** 榜单条目（model.rs ChartItem）。 */
export function newChartItem() {
  return { douban_ref: '', title: '', rate: '', rank: '', hotness: 0, poster_url: '', url: '', year: '' }
}

/** 观察队列条目（model.rs QueueItem；rating 为功能 2 追加字段）。 */
export function newQueueItem() {
  return {
    douban_ref: '', title: '', list: '', poster_url: '', url: '', tmdb_ref: '', media_type: '',
    year: '', rating: 0, poster_path: '', entered_at: '', due_at: '', state: '', attempt: 0, last_error: '',
  }
}

/** 历史条目（model.rs HistoryEntry）。 */
export function newHistoryEntry() {
  return { douban_ref: '', tmdb_ref: '', title: '', list: '', action: '', result: '', message: '', intent_id: 0, created_at: '' }
}

/** 想看条目（model.rs WishItem）。 */
export function newWishItem() {
  return { douban_ref: '', title: '', year: '', type: '', poster_url: '', added_at: '', rating: 0 }
}

/** 想看同步状态摘要（model.rs WishInfo）。 */
export function newWishInfo() {
  return { enabled: false, last_sync: '', last_count: 0, last_new: 0, last_status: '', last_error: '', uid: '', source: '' }
}

/** CookieCloud 解密缓存（model.rs CookieCache）。 */
export function newCookieCache() {
  return { header: '', uid: '', source: '', fetched_at: '' }
}

/** 黑名单状态（model.rs BlackState）。 */
export function newBlackState() {
  return { keywords: null, hits: 0, recent: null }
}

/** 默认设置（model.rs default_settings —— 5 个默认榜单 + 观察期/自动订阅）。 */
export function defaultSettings() {
  const lists = {
    upcoming: { source: 'coming_html', type: 'movie', tag: '', sort: '', limit: 20, enabled: true },
    hot: { source: 'subjects_json', type: 'movie', tag: '热门', sort: 'recommend', limit: 30, enabled: true },
    cn_wom: { source: 'subjects_json', type: 'tv', tag: '国产剧', sort: 'recommend', limit: 30, enabled: true },
    global_wom: { source: 'subjects_json', type: 'movie', tag: '欧美', sort: 'recommend', limit: 30, enabled: true },
    movie_wom: { source: 'chart_html', type: 'movie', tag: '', sort: '', limit: 20, enabled: true },
  }
  return { lists, observe_period_hours: 24, auto_subscribe: true, notify_on_subscribe: true, max_history: 200, max_logs: 200 }
}

/** 全新安装的状态文档（persistedState 零值 + 默认设置）。 */
export function newStateDoc() {
  return {
    settings: defaultSettings(),
    snapshot: { fetched_at: '', lists: null },
    queue: { items: null },
    history: null,
    logs: null,
    stats: { total: 0, month_new: 0, month: '', by_list: {}, last_archive_at: '' },
    blackstate: newBlackState(),
    wish: null,
    wish_seen: null,
    wish_info: newWishInfo(),
    cookie: newCookieCache(),
    no_resub: null,
    no_resub_scan_at: '',
  }
}

/**
 * model.rs `decode` + `strip_nulls`：先按文档原样深拷贝，再把对象里的 null 成员
 * 递归删除（Go 解码时 null → 零值）。返回 null 表示"整份不是对象"。
 */
export function stripNulls(value) {
  if (Array.isArray(value)) return value.map(stripNulls)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === null) continue
      out[key] = stripNulls(item)
    }
    return out
  }
  return value
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}
function asNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
function asBool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}
function asArray(value) {
  if (!Array.isArray(value)) return null
  return value
}

// ── 严格版取值（model.rs 的"类型不符 → 报错"契约：整份文档拒绝） ──

function reqString(value) {
  if (typeof value === 'string') return value
  throw new TypeError('expected string')
}
function reqNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new TypeError('expected number')
}
function reqBool(value) {
  if (typeof value === 'boolean') return value
  throw new TypeError('expected boolean')
}
function reqArray(value) {
  if (Array.isArray(value)) return value
  throw new TypeError('expected array')
}

/** 字段缺失 → 零值；字段存在但类型不符 → 抛错（调用方把整份文档判为无法识别）。 */
function str(raw, key) {
  return raw[key] === undefined ? '' : reqString(raw[key])
}
function num(raw, key) {
  return raw[key] === undefined ? 0 : reqNumber(raw[key])
}
function int(raw, key) {
  return Math.trunc(num(raw, key))
}
function bool(raw, key) {
  return raw[key] === undefined ? false : reqBool(raw[key])
}
function strArray(raw, key) {
  const value = raw[key]
  if (value === undefined || value === null) return null
  return reqArray(value).map((item) => (item === null ? '' : reqString(item)))
}

/** 解析单个榜单配置；字段缺失回零值，类型不符抛错。 */
function parseListConfig(raw) {
  const base = newListConfig()
  if (!raw || typeof raw !== 'object') return base
  return {
    source: str(raw, 'source'),
    type: str(raw, 'type'),
    tag: str(raw, 'tag'),
    sort: str(raw, 'sort'),
    limit: int(raw, 'limit'),
    enabled: bool(raw, 'enabled'),
  }
}

function parseChartItem(raw) {
  const base = newChartItem()
  if (!raw || typeof raw !== 'object') return base
  return {
    douban_ref: str(raw, 'douban_ref'),
    title: str(raw, 'title'),
    rate: str(raw, 'rate'),
    rank: str(raw, 'rank'),
    hotness: int(raw, 'hotness'),
    // v3.0.0 的 deep refresh 曾把未 await 的 Promise 写进 poster_url（JSON 落盘为 {}）。
    // 这是本插件自己的历史脏数据，按空串归一，避免整份文档被判为 foreign；下次刷新会补齐。
    poster_url: typeof raw.poster_url === 'string' ? raw.poster_url : '',
    url: str(raw, 'url'),
    year: str(raw, 'year'),
  }
}

function parseQueueItem(raw) {
  const base = newQueueItem()
  if (!raw || typeof raw !== 'object') return base
  return {
    douban_ref: str(raw, 'douban_ref'),
    title: str(raw, 'title'),
    list: str(raw, 'list'),
    poster_url: str(raw, 'poster_url'),
    url: str(raw, 'url'),
    tmdb_ref: str(raw, 'tmdb_ref'),
    media_type: str(raw, 'media_type'),
    year: str(raw, 'year'),
    rating: num(raw, 'rating'),
    poster_path: str(raw, 'poster_path'),
    entered_at: str(raw, 'entered_at'),
    due_at: str(raw, 'due_at'),
    state: str(raw, 'state'),
    attempt: int(raw, 'attempt'),
    last_error: str(raw, 'last_error'),
  }
}

function parseHistoryEntry(raw) {
  const base = newHistoryEntry()
  if (!raw || typeof raw !== 'object') return base
  return {
    douban_ref: str(raw, 'douban_ref'),
    tmdb_ref: str(raw, 'tmdb_ref'),
    title: str(raw, 'title'),
    list: str(raw, 'list'),
    action: str(raw, 'action'),
    result: str(raw, 'result'),
    message: str(raw, 'message'),
    intent_id: int(raw, 'intent_id'),
    created_at: str(raw, 'created_at'),
  }
}

function parseLogEntry(raw) {
  if (!raw || typeof raw !== 'object') return { at: '', level: '', message: '' }
  return { at: str(raw, 'at'), level: str(raw, 'level'), message: str(raw, 'message') }
}

function parseWishItem(raw) {
  const base = newWishItem()
  if (!raw || typeof raw !== 'object') return base
  return {
    douban_ref: str(raw, 'douban_ref'),
    title: str(raw, 'title'),
    year: str(raw, 'year'),
    type: str(raw, 'type'),
    poster_url: str(raw, 'poster_url'),
    added_at: str(raw, 'added_at'),
    rating: num(raw, 'rating'),
  }
}

function parseNoResubEntry(raw) {
  if (!raw || typeof raw !== 'object') return { tmdb_ref: '', intent_id: 0, at: '', reason: '' }
  return {
    tmdb_ref: str(raw, 'tmdb_ref'),
    intent_id: int(raw, 'intent_id'),
    at: str(raw, 'at'),
    reason: str(raw, 'reason'),
  }
}

/**
 * model.rs `PersistedState::parse`：整份文档解析；解析不出（非对象/字段类型不符）
 * 返回 null —— 调用方按"无法识别"拒绝落盘。字段缺失 → 零值（Go json.Unmarshal 语义）；
 * 字段存在但类型不符 → 整份拒绝（与 Go 一致，不静默吞掉）。
 */
export function parseStateDoc(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  try {
    return parseStateDocStrict(stripNulls(raw))
  } catch {
    return null
  }
}

function parseStateDocStrict(doc) {
  // settings.lists：Go 用 `Lists != nil` 判定"能识别"；null/缺失都算不能识别
  const settingsRaw = doc.settings && typeof doc.settings === 'object' ? doc.settings : {}
  let lists = null
  if (settingsRaw.lists !== undefined && settingsRaw.lists !== null) {
    if (typeof settingsRaw.lists !== 'object' || Array.isArray(settingsRaw.lists)) throw new TypeError('lists')
    lists = {}
    for (const [key, config] of Object.entries(settingsRaw.lists)) {
      lists[key] = parseListConfig(config)
    }
  }
  const snapshotRaw = doc.snapshot && typeof doc.snapshot === 'object' ? doc.snapshot : {}
  let snapshotLists = null
  if (snapshotRaw.lists !== undefined && snapshotRaw.lists !== null) {
    if (typeof snapshotRaw.lists !== 'object' || Array.isArray(snapshotRaw.lists)) throw new TypeError('snapshot.lists')
    snapshotLists = {}
    for (const [key, items] of Object.entries(snapshotRaw.lists)) {
      if (items === null) continue // null 键按"键缺失"处理（model.rs strip_nulls 注释）
      snapshotLists[key] = reqArray(items).map(parseChartItem)
    }
  }
  const queueRaw = doc.queue && typeof doc.queue === 'object' ? doc.queue : {}
  const queueItems =
    queueRaw.items === undefined || queueRaw.items === null ? null : reqArray(queueRaw.items).map(parseQueueItem)
  const statsRaw = doc.stats && typeof doc.stats === 'object' ? doc.stats : {}
  let byList = null
  if (statsRaw.by_list !== undefined && statsRaw.by_list !== null) {
    if (typeof statsRaw.by_list !== 'object' || Array.isArray(statsRaw.by_list)) throw new TypeError('by_list')
    byList = {}
    for (const [key, value] of Object.entries(statsRaw.by_list)) byList[key] = reqNumber(value)
  }
  const blackRaw = doc.blackstate && typeof doc.blackstate === 'object' ? doc.blackstate : {}
  const cookieRaw = doc.cookie && typeof doc.cookie === 'object' ? doc.cookie : {}
  const wishInfoRaw = doc.wish_info && typeof doc.wish_info === 'object' ? doc.wish_info : {}
  const history = doc.history === undefined || doc.history === null ? null : reqArray(doc.history).map(parseHistoryEntry)
  const logs = doc.logs === undefined || doc.logs === null ? null : reqArray(doc.logs).map(parseLogEntry)
  const wish = doc.wish === undefined || doc.wish === null ? null : reqArray(doc.wish).map(parseWishItem)
  let wishSeen = null
  if (doc.wish_seen !== undefined && doc.wish_seen !== null) {
    if (typeof doc.wish_seen !== 'object' || Array.isArray(doc.wish_seen)) throw new TypeError('wish_seen')
    wishSeen = {}
    for (const [key, flag] of Object.entries(doc.wish_seen)) wishSeen[key] = bool(doc.wish_seen, key)
  }
  let noResub = null
  if (doc.no_resub !== undefined && doc.no_resub !== null) {
    if (typeof doc.no_resub !== 'object' || Array.isArray(doc.no_resub)) throw new TypeError('no_resub')
    noResub = {}
    for (const [key, entry] of Object.entries(doc.no_resub)) noResub[key] = parseNoResubEntry(entry)
  }
  let recent = null
  if (blackRaw.recent !== undefined && blackRaw.recent !== null) {
    recent = reqArray(blackRaw.recent).map((hit) => ({
      title: str(hit ?? {}, 'title'),
      keyword: str(hit ?? {}, 'keyword'),
      at: str(hit ?? {}, 'at'),
    }))
  }
  return {
    settings: {
      lists,
      blacklist: strArray(settingsRaw, 'blacklist'),
      observe_period_hours: int(settingsRaw, 'observe_period_hours'),
      auto_subscribe: bool(settingsRaw, 'auto_subscribe'),
      notify_on_subscribe: bool(settingsRaw, 'notify_on_subscribe'),
      subscribe_source_filter: strArray(settingsRaw, 'subscribe_source_filter'),
      max_history: int(settingsRaw, 'max_history'),
      max_logs: int(settingsRaw, 'max_logs'),
      manual_cookie: str(settingsRaw, 'manual_cookie'),
      wish_sync_enabled: bool(settingsRaw, 'wish_sync_enabled'),
      min_rating: num(settingsRaw, 'min_rating'),
      min_year: int(settingsRaw, 'min_year'),
      regions: strArray(settingsRaw, 'regions'),
    },
    snapshot: { fetched_at: str(snapshotRaw, 'fetched_at'), lists: snapshotLists },
    queue: { items: queueItems },
    history,
    logs,
    stats: {
      total: int(statsRaw, 'total'),
      month_new: int(statsRaw, 'month_new'),
      month: str(statsRaw, 'month'),
      by_list: byList ?? {},
      last_archive_at: str(statsRaw, 'last_archive_at'),
    },
    blackstate: {
      keywords: strArray(blackRaw, 'keywords'),
      hits: int(blackRaw, 'hits'),
      recent,
    },
    wish,
    wish_seen: wishSeen,
    wish_info: {
      enabled: bool(wishInfoRaw, 'enabled'),
      last_sync: str(wishInfoRaw, 'last_sync'),
      last_count: int(wishInfoRaw, 'last_count'),
      last_new: int(wishInfoRaw, 'last_new'),
      last_status: str(wishInfoRaw, 'last_status'),
      last_error: str(wishInfoRaw, 'last_error'),
      uid: str(wishInfoRaw, 'uid'),
      source: str(wishInfoRaw, 'source'),
    },
    cookie: {
      header: str(cookieRaw, 'header'),
      uid: str(cookieRaw, 'uid'),
      source: str(cookieRaw, 'source'),
      fetched_at: str(cookieRaw, 'fetched_at'),
    },
    no_resub: noResub,
    no_resub_scan_at: str(doc, 'no_resub_scan_at'),
  }
}

/** model.rs `is_recognizable`：settings.lists 非 null 才算本插件的状态。 */
export function isRecognizable(doc) {
  return doc !== null && doc.settings.lists !== null
}

/** 账号键（account）的解析：只要账号字段，其余忽略。 */
export function parseAccountDoc(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const doc = stripNulls(raw)
  return {
    cookiecloud_url: asString(doc.cookiecloud_url),
    cookiecloud_uuid: asString(doc.cookiecloud_uuid),
    cookiecloud_key: asString(doc.cookiecloud_key),
    manual_cookie: asString(doc.manual_cookie),
    wish_sync_enabled: asBool(doc.wish_sync_enabled),
  }
}

/** 账号字段是否非空（model.rs has_account_fields —— overlay 是否真的生效）。 */
export function hasAccountFields(account) {
  return Boolean(
    account &&
      (account.cookiecloud_url !== '' || account.cookiecloud_uuid !== '' ||
        account.cookiecloud_key !== '' || account.manual_cookie !== '' || account.wish_sync_enabled === true),
  )
}

/**
 * runtime.rs `sanitize_state`：递归清掉会被宿主判定为绝对路径的字符串
 * （豆瓣封面相对路径 /pXXX.jpg 混进 state 会被宿主安全过滤拒绝整个响应）。
 */
export function looksLikeAbsPath(text) {
  return typeof text === 'string' && text.length >= 2 && text.startsWith('/') && !text.startsWith('//')
}

export function sanitizeState(value) {
  if (typeof value === 'string') return looksLikeAbsPath(value) ? '' : value
  if (Array.isArray(value)) return value.map(sanitizeState)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = sanitizeState(item)
    return out
  }
  return value
}

/**
 * runtime.rs `sanitize_settings_view`：state 响应的 settings 脱敏。
 * 凭据字段不回显：URL/UUID 改名预填，密钥/手动 cookie 只回"已配置"布尔。
 */
export function sanitizeSettingsView(settings) {
  const view = { ...settings }
  view.cc_url = view.cookiecloud_url ?? ''
  view.cc_uuid = view.cookiecloud_uuid ?? ''
  view.cc_key_set = Boolean(view.cookiecloud_key && view.cookiecloud_key !== '')
  view.cc_manual_set = Boolean(view.manual_cookie && view.manual_cookie !== '')
  delete view.cookiecloud_url
  delete view.cookiecloud_uuid
  delete view.cookiecloud_key
  delete view.manual_cookie
  return view
}
