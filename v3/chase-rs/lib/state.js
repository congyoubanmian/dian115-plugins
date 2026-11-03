// 状态文档模型 —— 对照 plugins/chase-rs/src/model.rs 的 StateDoc。
//
// v3 差异：
// - `settings` 不再内嵌（迁移到 ctx.settings，见 lib/settings.js）；探测指纹缓存
//   `settings.probe.*` 是运行时内部状态而非用户配置，保留为文档的 `probe` 键；
// - `schema_version` 升到 3（认不出这个数字的文档不当作本插件的状态）；
// - 落盘走 ctx.storage（KV 单键 `state`），上限/裁剪/脱敏纪律全部保留。

import { containsForbiddenKey, looseI64, looseString, sampleText, sanitize, truncateUtf8 } from './loose.js'

/** 文档版本标记：认不出这个数字的文档不当作本插件的状态。 */
export const SCHEMA_VERSION = 3

/** 单文档字节上限（写入前先裁剪）。 */
export const MAX_STATE_BYTES = 256 * 1024
/** `align.items` 上限。 */
export const ALIGN_ITEMS_MAX = 50
/** `trim_suggestions` 上限。 */
export const TRIM_MAX = 50
/** `calendar.days` 上限。 */
export const CALENDAR_DAYS_MAX = 8
/** 每天日历条目上限。 */
export const CALENDAR_ITEMS_MAX = 20
/** `debug.attempts` 上限。 */
export const DEBUG_ATTEMPTS_MAX = 20
/** `debug.last_errors` 上限。 */
export const DEBUG_ERRORS_MAX = 10
/** `logs` 上限。 */
export const LOGS_MAX = 50
/** 单条日志消息的字节上限。 */
export const LOG_MESSAGE_MAX = 400
/** `debug` 里原始响应片段的字节上限。 */
export const SAMPLE_MAX = 2048
/** `emby_instances` 上限。 */
export const INSTANCES_MAX = 20
/** 单轮 PATCH 的代码硬上限（用户配置再大也不越过）。 */
export const PATCH_HARD_LIMIT = 20
/** `probe_book` 上限。 */
export const PROBE_BOOK_MAX = 200
/** `tmdb_targets` 上限。 */
export const TMDB_TARGETS_MAX = 50
/** `posters` 上限（按 tmdb_id 去重）。 */
export const POSTERS_MAX = 50
/** 海报相对路径的字节上限。 */
export const POSTER_PATH_MAX = 200
/** 海报绝对地址的字节上限。 */
export const POSTER_URL_MAX = 400
/**
 * TMDB 海报尺寸档位。宿主文档（host-api-reference.md 的 poster_path 字段）示例
 * 拼接 w500；本插件按产品口径统一用 w342。要切回文档口径只改这一行。
 */
export const POSTER_SIZE = 'w342'
/** 目标集数的硬上限（元数据异常的保护阈值）。 */
export const TARGET_UPPER_LIMIT = 2000

/** TMDB 海报相对路径 → 可直接放进 <img src> 的绝对地址（已是 http(s) 的原样返回）。 */
export function posterUrlOf(path) {
  const text = typeof path === 'string' ? path.trim() : ''
  if (text === '') return ''
  if (/^https?:\/\//i.test(text)) return text
  const suffix = text.startsWith('/') ? text : `/${text}`
  return `https://image.tmdb.org/t/p/${POSTER_SIZE}${suffix}`
}

/** 全新的空快照：缺键的槽位是 `never`，不是空串。 */
export function probeSnapshotNever() {
  return { status: 'never', shape: '', params_tried: [], http_status: 0, sample: '', at: '' }
}

/** 整个状态文档的初始值。 */
export function newStateDoc() {
  return {
    schema_version: SCHEMA_VERSION,
    revision: 0,
    status: '',
    last_message: '',
    last_run: '',
    align: {
      last_run_at: '',
      pages: 0,
      intents_seen: 0,
      matched: 0,
      patched: 0,
      skipped: 0,
      failed: 0,
      absent: 0,
      pending_probe: 0,
      last_error: '',
      items: [],
    },
    trim_suggestions: [],
    calendar: { fetched_at: '', days: [] },
    daily: {
      last_sent_date: '',
      last_at: '',
      last_result: '',
      last_error: '',
      sent_total: 0,
      notify_channels: [],
      // 当天发送失败后的重试序号：宿主要求"投递未确认的去重键换新键再发"。
      retry_date: '',
      retry_seq: 0,
    },
    debug: {
      updated_at: '',
      emby_episodes: probeSnapshotNever(),
      emby_instances: probeSnapshotNever(),
      air_calendar: probeSnapshotNever(),
      pool_intents: probeSnapshotNever(),
      tmdb_target: probeSnapshotNever(),
      attempts: [],
      last_errors: [],
    },
    stats: { tv_intents: 0, matched: 0, aligned: 0, gap_total: 0, unknown_shape: 0 },
    logs: [],
    emby_instances: [],
    probe_book: [],
    tmdb_targets: [],
    posters: [],
    probe: { emby_episodes_shape: '', air_calendar_shape: '' },
  }
}

const SNAPSHOT_KEYS = ['emby_episodes', 'emby_instances', 'air_calendar', 'pool_intents', 'tmdb_target']

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function asNumber(value, fallback = 0) {
  const parsed = looseI64(value)
  return parsed === null ? fallback : parsed
}

function asText(value, fallback = '') {
  const text = looseString(value)
  return text === null ? fallback : text
}

/** 海报缓存条目：只留 `{tmdb_id, path, url}`，按 tmdb_id 去重、裁到上限。 */
function normalizePosters(value) {
  const byId = new Map()
  for (const item of asArray(value)) {
    const poster = asObject(item)
    const tmdbId = asNumber(poster.tmdb_id)
    const path = truncateUtf8(asText(poster.path), POSTER_PATH_MAX)
    let url = truncateUtf8(asText(poster.url), POSTER_URL_MAX)
    if (tmdbId <= 0 || path === '') continue
    if (!/^https?:\/\//i.test(url)) url = posterUrlOf(path)
    if (url === '') continue
    // 后出现的同 id 覆盖先出现的（最近一次成功取数优先）。
    byId.delete(tmdbId)
    byId.set(tmdbId, { tmdb_id: tmdbId, path, url })
  }
  return [...byId.values()].slice(-POSTERS_MAX)
}

/**
 * 把读到的任意 JSON 收敛成完整状态文档；认不出（schema_version 不对）返回 null，
 * 调用方据此禁止落盘（避免默认值覆盖用户数据）。缺键落默认，未知键忽略。
 */
export function normalizeStateDoc(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (asNumber(raw.schema_version, -1) !== SCHEMA_VERSION) return null
  const doc = newStateDoc()
  doc.revision = Math.max(0, asNumber(raw.revision, 0))
  doc.status = asText(raw.status)
  doc.last_message = asText(raw.last_message)
  doc.last_run = asText(raw.last_run)

  const align = asObject(raw.align)
  Object.assign(doc.align, {
    last_run_at: asText(align.last_run_at),
    pages: asNumber(align.pages),
    intents_seen: asNumber(align.intents_seen),
    matched: asNumber(align.matched),
    patched: asNumber(align.patched),
    skipped: asNumber(align.skipped),
    failed: asNumber(align.failed),
    absent: asNumber(align.absent),
    pending_probe: asNumber(align.pending_probe),
    last_error: asText(align.last_error),
    items: asArray(align.items).map((item) => ({
      intent_id: asNumber(asObject(item).intent_id),
      tmdb_id: asNumber(asObject(item).tmdb_id),
      season: asNumber(asObject(item).season),
      title: asText(asObject(item).title),
      total_known: asNumber(asObject(item).total_known),
      emby_have_max: asNumber(asObject(item).emby_have_max, -1),
      emby_have_count: asNumber(asObject(item).emby_have_count, -1),
      gap_max: asNumber(asObject(item).gap_max),
      target_upper: asNumber(asObject(item).target_upper),
      target_known: asObject(item).target_known === true,
      from_total: asNumber(asObject(item).from_total),
      to_total: asNumber(asObject(item).to_total),
      action: asText(asObject(item).action),
      reason: asText(asObject(item).reason),
      at: asText(asObject(item).at),
      poster: asText(asObject(item).poster),
    })),
  })
  doc.trim_suggestions = asArray(raw.trim_suggestions).map((item) => {
    const trim = asObject(item)
    return {
      intent_id: asNumber(trim.intent_id),
      tmdb_id: asNumber(trim.tmdb_id),
      season: asNumber(trim.season),
      title: asText(trim.title),
      total_known: asNumber(trim.total_known),
      emby_have_max: asNumber(trim.emby_have_max, -1),
      target_upper: asNumber(trim.target_upper),
      reason: asText(trim.reason),
      at: asText(trim.at),
    }
  })

  const calendar = asObject(raw.calendar)
  doc.calendar.fetched_at = asText(calendar.fetched_at)
  doc.calendar.days = asArray(calendar.days).map((day) => {
    const entry = asObject(day)
    return {
      date: asText(entry.date),
      items: asArray(entry.items).map((item) => {
        const inner = asObject(item)
        return {
          tmdb_id: asNumber(inner.tmdb_id),
          season: asNumber(inner.season),
          episode: asNumber(inner.episode),
          title: asText(inner.title),
          time: asText(inner.time),
        }
      }),
    }
  })

  const daily = asObject(raw.daily)
  Object.assign(doc.daily, {
    last_sent_date: asText(daily.last_sent_date),
    last_at: asText(daily.last_at),
    last_result: asText(daily.last_result),
    last_error: asText(daily.last_error),
    sent_total: asNumber(daily.sent_total),
    retry_date: asText(daily.retry_date),
    retry_seq: Math.max(0, asNumber(daily.retry_seq)),
    notify_channels: asArray(daily.notify_channels).map((item) => {
      const channel = asObject(item)
      return {
        channel: asText(channel.channel),
        preserved: asArray(channel.preserved).map((entry) => asText(entry)),
        dropped: asArray(channel.dropped).map((entry) => asText(entry)),
      }
    }),
  })

  const debug = asObject(raw.debug)
  doc.debug.updated_at = asText(debug.updated_at)
  for (const key of SNAPSHOT_KEYS) {
    const snapshot = asObject(debug[key])
    doc.debug[key] = {
      status: asText(snapshot.status, 'never') || 'never',
      shape: asText(snapshot.shape),
      params_tried: asArray(snapshot.params_tried).map((entry) => asText(entry)),
      http_status: asNumber(snapshot.http_status),
      sample: asText(snapshot.sample),
      at: asText(snapshot.at),
    }
  }
  doc.debug.attempts = asArray(debug.attempts).map((item) => {
    const attempt = asObject(item)
    return {
      endpoint: asText(attempt.endpoint),
      params: asText(attempt.params),
      http_status: asNumber(attempt.http_status),
      shape: asText(attempt.shape),
      at: asText(attempt.at),
    }
  })
  doc.debug.last_errors = asArray(debug.last_errors).map((item) => {
    const error = asObject(item)
    return { step: asText(error.step), message: asText(error.message), at: asText(error.at) }
  })

  const stats = asObject(raw.stats)
  Object.assign(doc.stats, {
    tv_intents: asNumber(stats.tv_intents),
    matched: asNumber(stats.matched),
    aligned: asNumber(stats.aligned),
    gap_total: asNumber(stats.gap_total),
    unknown_shape: asNumber(stats.unknown_shape),
  })

  doc.logs = asArray(raw.logs).map((item) => {
    const entry = asObject(item)
    return { at: asText(entry.at), level: asText(entry.level), message: asText(entry.message) }
  })
  doc.emby_instances = asArray(raw.emby_instances).map((item) => {
    const instance = asObject(item)
    return {
      id: asNumber(instance.id),
      name: asText(instance.name),
      is_default: instance.is_default === true,
      key_ready: instance.key_ready === true,
      at: asText(instance.at),
    }
  })
  doc.probe_book = asArray(raw.probe_book).map((item) => {
    const entry = asObject(item)
    return {
      key: asText(entry.key),
      at: asText(entry.at),
      emby: asText(entry.emby),
      target: asText(entry.target),
    }
  })
  doc.tmdb_targets = asArray(raw.tmdb_targets).map((item) => {
    const target = asObject(item)
    return {
      tmdb_id: asNumber(target.tmdb_id),
      season: asNumber(target.season),
      episode_count: asNumber(target.episode_count),
      at: asText(target.at),
    }
  })
  doc.posters = normalizePosters(raw.posters)
  const probe = asObject(raw.probe)
  doc.probe.emby_episodes_shape = asText(probe.emby_episodes_shape)
  doc.probe.air_calendar_shape = asText(probe.air_calendar_shape)
  return doc
}

/** 每次状态变化 +1（幂等键的轮次跟着它走）。 */
export function bumpRevision(doc) {
  doc.revision = Math.max(0, doc.revision) + 1
  return doc.revision
}

/** 写一条自持日志（≤400 字节、≤50 条）。 */
export function log(doc, level, message, now) {
  doc.logs.push({ at: now, level: String(level), message: truncateUtf8(message, LOG_MESSAGE_MAX) })
  trimTail(doc.logs, LOGS_MAX)
}

/** 记一条诊断错误（≤10 条，最新的在最后）。 */
export function recordError(doc, step, message, now) {
  doc.debug.last_errors.push({ step: String(step), message: truncateUtf8(message, LOG_MESSAGE_MAX), at: now })
  trimTail(doc.debug.last_errors, DEBUG_ERRORS_MAX)
  doc.debug.updated_at = now
}

/** 记一次宿主调用尝试（≤20 条）。 */
export function recordAttempt(doc, endpoint, params, httpStatus, shape, now) {
  doc.debug.attempts.push({
    endpoint: String(endpoint),
    params: truncateUtf8(params, 200),
    http_status: Math.trunc(httpStatus) || 0,
    shape: truncateUtf8(shape, 200),
    at: now,
  })
  trimTail(doc.debug.attempts, DEBUG_ATTEMPTS_MAX)
  doc.debug.updated_at = now
}

/** 记下/更新该季的 TMDB 目标（成功取数时调用；≤TMDB_TARGETS_MAX 条）。 */
export function rememberTmdbTarget(doc, tmdbId, season, episodeCount, at) {
  doc.tmdb_targets = doc.tmdb_targets.filter(
    (target) => !(target.tmdb_id === tmdbId && target.season === season),
  )
  doc.tmdb_targets.push({ tmdb_id: tmdbId, season, episode_count: Math.max(0, episodeCount), at })
  if (doc.tmdb_targets.length > TMDB_TARGETS_MAX) {
    doc.tmdb_targets.splice(0, doc.tmdb_targets.length - TMDB_TARGETS_MAX)
  }
}

/** 忘记该季的目标（本轮取数失败时调用：不拿旧值冒充"取到了"）。 */
export function forgetTmdbTarget(doc, tmdbId, season) {
  doc.tmdb_targets = doc.tmdb_targets.filter(
    (target) => !(target.tmdb_id === tmdbId && target.season === season),
  )
}

/** 取该季最近一次成功记录的目标（不做新鲜度判断，由调用方决定窗口）。 */
export function tmdbTargetOf(doc, tmdbId, season) {
  for (let index = doc.tmdb_targets.length - 1; index >= 0; index -= 1) {
    const target = doc.tmdb_targets[index]
    if (target.tmdb_id === tmdbId && target.season === season) return target
  }
  return null
}

/**
 * 记下该剧的海报（成功取数时调用）。缓存按 tmdb_id 去重、无 TTL（海报稳定），
 * 同一 id 再次成功即覆盖；条目只存 `{tmdb_id, path, url}`。`now` 仅为调用方
 * 语义保留，不写入缓存（避免把缓存做成带过期的判定数据）。
 */
export function rememberPoster(doc, tmdbId, path, now) {
  const id = looseI64(tmdbId)
  const clean = truncateUtf8(typeof path === 'string' ? path.trim() : '', POSTER_PATH_MAX)
  if (id === null || id <= 0 || clean === '') return false
  const url = truncateUtf8(posterUrlOf(clean), POSTER_URL_MAX)
  if (url === '') return false
  if (!Array.isArray(doc.posters)) doc.posters = []
  doc.posters = doc.posters.filter((item) => asNumber(asObject(item).tmdb_id) !== id)
  doc.posters.push({ tmdb_id: id, path: clean, url })
  trimTail(doc.posters, POSTERS_MAX)
  return true
}

function trimTail(items, max) {
  if (items.length > max) items.splice(0, items.length - max)
}

/** 按上限裁剪所有列表（落盘前调用）。 */
export function enforceLimits(doc) {
  trimTail(doc.align.items, ALIGN_ITEMS_MAX)
  trimTail(doc.trim_suggestions, TRIM_MAX)
  trimTail(doc.calendar.days, CALENDAR_DAYS_MAX)
  for (const day of doc.calendar.days) trimTail(day.items, CALENDAR_ITEMS_MAX)
  trimTail(doc.debug.attempts, DEBUG_ATTEMPTS_MAX)
  trimTail(doc.debug.last_errors, DEBUG_ERRORS_MAX)
  trimTail(doc.logs, LOGS_MAX)
  trimTail(doc.emby_instances, INSTANCES_MAX)
  trimTail(doc.probe_book, PROBE_BOOK_MAX)
  trimTail(doc.tmdb_targets, TMDB_TARGETS_MAX)
  doc.posters = asArray(doc.posters)
  trimTail(doc.posters, POSTERS_MAX)
  for (const poster of doc.posters) {
    poster.path = truncateUtf8(poster.path, POSTER_PATH_MAX)
    poster.url = truncateUtf8(poster.url, POSTER_URL_MAX)
  }
  for (const key of SNAPSHOT_KEYS) {
    doc.debug[key].sample = truncateUtf8(doc.debug[key].sample, SAMPLE_MAX)
    trimTail(doc.debug[key].params_tried, 8)
  }
  for (const item of doc.align.items) {
    item.reason = truncateUtf8(item.reason, LOG_MESSAGE_MAX)
    item.title = truncateUtf8(item.title, 120)
    if (item.poster) item.poster = truncateUtf8(item.poster, POSTER_URL_MAX)
  }
  for (const item of doc.trim_suggestions) {
    item.reason = truncateUtf8(item.reason, LOG_MESSAGE_MAX)
    item.title = truncateUtf8(item.title, 120)
  }
  for (const item of doc.logs) item.message = truncateUtf8(item.message, LOG_MESSAGE_MAX)
  for (const item of doc.debug.last_errors) item.message = truncateUtf8(item.message, LOG_MESSAGE_MAX)
}

/**
 * 序列化到 ≤MAX_STATE_BYTES 的 JSON 文本（超限则逐级降级裁掉诊断，仍超限抛错）。
 * 降级顺序与 model.rs to_bytes 一致：attempts+海报 → 样本 → logs → align 减半 → 日历砍半 → 建议减半。
 */
export function serializeState(doc) {
  enforceLimits(doc)
  let text = JSON.stringify(doc)
  for (let step = 0; step < 6 && text.length > MAX_STATE_BYTES; step += 1) {
    if (step === 0) {
      doc.debug.attempts = []
      // 海报缓存是纯展示数据，和 attempts 同批清掉；行上的 poster 也一并去掉，
      // 避免下一步只用得上 poster 的行仍撑爆文档。step 上限保持 6，最后一步
      // trim_suggestions 仍可达。
      doc.posters = []
      for (const item of doc.align.items) delete item.poster
    } else if (step === 1) for (const key of SNAPSHOT_KEYS) doc.debug[key].sample = ''
    else if (step === 2) doc.logs = []
    else if (step === 3) trimTail(doc.align.items, Math.floor(ALIGN_ITEMS_MAX / 2))
    else if (step === 4) trimTail(doc.calendar.days, 4)
    else trimTail(doc.trim_suggestions, Math.floor(TRIM_MAX / 2))
    text = JSON.stringify(doc)
  }
  if (text.length > MAX_STATE_BYTES) throw new Error(`状态文档超过 ${MAX_STATE_BYTES} 字节`)
  return text
}

/** 落盘前的最后闸门：含凭据键名就脱敏（返回是否做过修改）。 */
export function sanitizeForPersist(doc) {
  if (containsForbiddenKey(doc) === null) return false
  sanitize(doc)
  return true
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 追加型列表的合并：对方的全部 + 本会话新增（基线里没有的）条目，按上限保留最新。 */
function unionAppended(base, ours, theirs, max) {
  const seen = new Set(asArray(base).map((entry) => JSON.stringify(entry)))
  const merged = asArray(theirs).map(cloneJson)
  const present = new Set(merged.map((entry) => JSON.stringify(entry)))
  for (const entry of asArray(ours)) {
    const key = JSON.stringify(entry)
    if (seen.has(key) || present.has(key)) continue
    merged.push(cloneJson(entry))
    present.add(key)
  }
  trimTail(merged, max)
  return merged
}

/** 追加型列表（日志/诊断）：两边的新条目都保留，不互相覆盖。 */
const APPEND_LISTS = {
  logs: LOGS_MAX,
  'debug.attempts': DEBUG_ATTEMPTS_MAX,
  'debug.last_errors': DEBUG_ERRORS_MAX,
}

/**
 * 海报缓存的并发合并：以对方（存储里最新）为底，本会话同 tmdb_id 覆盖；
 * 不交给顶层的「整体取 ours / 整体取 theirs」，免得住点对齐与 probe-dump
 * 并发落盘时互相清空对方的缓存。按 tmdb_id 去重并裁到 POSTERS_MAX。
 */
export function mergePosters(ours, theirs) {
  const byId = new Map()
  for (const item of [...asArray(theirs), ...asArray(ours)]) {
    const poster = asObject(item)
    const tmdbId = asNumber(poster.tmdb_id)
    const path = asText(poster.path)
    let url = asText(poster.url)
    if (tmdbId <= 0 || path === '') continue
    if (!/^https?:\/\//i.test(url)) url = posterUrlOf(path)
    if (url === '') continue
    // 已有的 id 直接覆盖（保留对方的位置），本会话新增的 id 追加在末尾。
    byId.set(tmdbId, { tmdb_id: tmdbId, path, url })
  }
  return [...byId.values()].slice(-POSTERS_MAX)
}

/**
 * 存储 CAS 冲突时的三方合并：以对方（存储里最新的文档）为底，本会话相对基线改过的
 * 字段（顶层键，及其下一层子键）用本会话的值；日志与诊断列表两边的新条目都保留。
 * 这样并发的两个任务各自只覆盖自己真正写过的部分。
 */
export function mergeStateDocs(base, ours, theirs) {
  const baseDoc = isPlainObject(base) ? base : newStateDoc()
  const merged = cloneJson(theirs)
  for (const key of Object.keys(ours)) {
    if (key === 'revision' || key === 'schema_version') continue
    if (APPEND_LISTS[key] !== undefined) {
      merged[key] = unionAppended(baseDoc[key], ours[key], theirs[key], APPEND_LISTS[key])
      continue
    }
    if (key === 'posters') {
      merged[key] = mergePosters(ours[key], theirs[key])
      continue
    }
    const mine = ours[key]
    const before = baseDoc[key]
    if (isPlainObject(mine) && isPlainObject(before) && isPlainObject(merged[key])) {
      for (const sub of Object.keys(mine)) {
        const listKey = `${key}.${sub}`
        if (APPEND_LISTS[listKey] !== undefined) {
          merged[key][sub] = unionAppended(before[sub], mine[sub], theirs[key]?.[sub], APPEND_LISTS[listKey])
        } else if (!sameJson(mine[sub], before[sub])) {
          merged[key][sub] = cloneJson(mine[sub])
        }
      }
    } else if (!sameJson(mine, before)) {
      merged[key] = cloneJson(mine)
    }
  }
  merged.revision = Math.max(asNumber(ours.revision), asNumber(theirs.revision) + 1)
  return merged
}

/** 追加一行对齐结果；满 ALIGN_ITEMS_MAX 时优先丢掉最旧的 `skipped`。 */
export function pushAlignItem(items, item) {
  if (items.length >= ALIGN_ITEMS_MAX) {
    const position = items.findIndex((existing) => existing.action === 'skipped')
    items.splice(position >= 0 ? position : 0, 1)
  }
  items.push(item)
}
