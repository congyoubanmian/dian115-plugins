// 共享编排层 —— 对照 plugins/chase-rs/src/runtime.rs 的 Runtime。
//
// v3 与旧 WASM 运行时的两个结构性差异（都如实标注在 README 的"迁移差异"里）：
// 1. 宿主无常驻 JS VM：每个 job 都是独立加载的一次性运行，`state` 单键 + 存储乐观锁
//    的语义通过 ctx.storage（CAS）保留；旧版"align-now/refresh 不落盘"的 host.call
//    预算技巧在 v3 没有意义（页面看不到内存态），因此这两条路径改为落盘；
// 2. 通知走 ctx.notify（宿主返回 accepted/deduplicated/suppressed，语义与旧
//    POST /api/notifications/plugin 一致）；idempotency-key 头不再由插件携带
//    （v3 的 ctx.api 不暴露自定义头；补订"只增"语义与任务队列的 business_key 保底）。

import {
  bumpRevision,
  forgetTmdbTarget,
  log,
  mergeStateDocs,
  newStateDoc,
  normalizeStateDoc,
  pushAlignItem,
  recordAttempt,
  recordError,
  rememberTmdbTarget,
  sanitizeForPersist,
  serializeState,
  tmdbTargetOf,
  PATCH_HARD_LIMIT,
  SAMPLE_MAX,
} from '../lib/state.js'
import { isFresh, localDate as localDateOf, localHour as localHourOf, nowRfc3339, nowUnixSecs } from '../lib/clock.js'
import { normalizeFlat, toNested } from '../lib/settings.js'
import {
  actionable,
  LIMIT_MAX,
  listPath,
  MEDIA_TYPE,
  patchBody,
  patchIdempotencyKey,
  patchPath,
  PAGES_MAX,
  parseList,
  trimCandidate,
} from '../lib/intents.js'
import {
  candidates,
  failureIsAbsent,
  INSTANCES_PATH,
  parseCoverage,
  parseInstances,
  selectionFromSettings,
  select as selectInstance,
  variantFromShape,
} from '../lib/emby.js'
import { parse as parseCalendar, PATH as CALENDAR_PATH } from '../lib/aircal.js'
import {
  ACTION_FAILED,
  ACTION_PATCHED,
  ACTION_SKIPPED,
  Decision,
  decide,
  Evidence,
  parseTargetUpper,
  shouldSuggestTrim,
  trimReason,
} from '../lib/align.js'
import {
  applyOutcome,
  bumpRetry,
  compose,
  dedupeKey,
  isDedupeConflict,
  markAlreadySent,
  retrySeqFor,
  shouldSend,
} from '../lib/notify.js'
import { sampleText, truncateUtf8 } from '../lib/loose.js'
import { taskCheckpoint, taskCheckpointRequired } from './task.js'

// ─────────────────────────── 预算与窗口（与 runtime.rs 一致） ───────────────────────────

/** 后台 job 的墙钟预算（旧 manifest background_timeout_ms=240s，这里留了余量）。 */
export const RUN_BUDGET_SECS = 180
/** align-now 的墙钟预算（规格：硬预算 6s）。 */
export const ALIGN_NOW_BUDGET_SECS = 6
/** align-now 的 PATCH 硬上限（规格：≤5）。 */
export const ALIGN_NOW_PATCH_LIMIT = 5
/** align-now 对未命中缓存的条目最多补发几次 Emby 探测。 */
export const ALIGN_NOW_PROBE_LIMIT = 3
/** align-now 复用的缓存新鲜度（6 小时）。 */
export const CACHE_FRESH_SECS = 6 * 3600
/** Emby 探测失败后的负缓存窗口（6 小时）。 */
export const PROBE_NEGATIVE_TTL_SECS = 6 * 3600
/** 整点 job 复用「已核实无缺口」行的窗口（5 小时）。 */
export const NO_GAP_TTL_SECS = 5 * 3600
/** align-now 只读 1 页的大小。 */
export const ALIGN_NOW_PAGE_SIZE = 50

/** 状态文档在插件 KV 里的单键（与旧实现同名，便于对照）。 */
export const STATE_KEY = 'state'

// ─────────────────────────── 失败现场 ───────────────────────────

/** 一次外部结构解析失败的完整现场（对照 raw.rs ParseFailure）。 */
export class Failure extends Error {
  constructor({ http_status = 0, raw = '', message, attempts = 1 }) {
    super(message)
    this.name = 'Failure'
    this.http_status = http_status
    this.raw = typeof raw === 'string' ? raw : ''
    this.attempts = attempts
  }

  /** 诊断快照里的状态词：http_error（含传输失败）或 unparsed（结构认不出）。 */
  kind() {
    return this.http_status === 0 || this.http_status >= 400 ? 'http_error' : 'unparsed'
  }

  sample() {
    return sampleText(this.raw, SAMPLE_MAX)
  }
}

/** 一次宿主业务 API 调用：非 2xx 抛 APIError（含 status/data），这里收敛成统一形状。 */
export async function tryApi(ctx, method, path, body) {
  try {
    const data = method === 'GET' ? await ctx.api.get(path) : await ctx.api[method.toLowerCase()](path, body)
    return { ok: true, status: 200, data, message: '' }
  } catch (error) {
    return {
      ok: false,
      status: typeof error?.status === 'number' ? error.status : 0,
      data: error?.data,
      message: error?.message || String(error),
    }
  }
}

function apiRawText(result) {
  if (result?.data === undefined || result?.data === null) return ''
  try {
    return JSON.stringify(result.data)
  } catch {
    return String(result.data)
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─────────────────────────── 运行时会话 ───────────────────────────

/** 后台 ctx 只有 ctx.plugin.id（页面才有 ctx.id）；统一取插件 ID。 */
export function pluginIdOf(ctx) {
  const id = ctx?.id ?? ctx?.plugin?.id ?? ''
  if (id === '') throw new Error('缺少插件 ID（ctx.id / ctx.plugin.id）')
  return id
}

/**
 * 读取状态文档三态（对照 store.rs load_state_with_retry）：
 * loaded（读到本文档）/ fresh（确认无键的全新安装）/ unavailable（宿主不可读）。
 * 只有前两种才允许落盘 —— unavailable 时绝不落盘，免得默认值覆盖用户配置。
 */
/**
 * 读插件自己的数据：值走官方 `ctx.storage.get`（无键 = 全新安装）。
 *
 * CAS 需要的版本号仍从自有存储信封读：后台 `ctx.storage.set(key, value)` 不暴露
 * `expected_revision`（见 v3-kit/docs/sdk/background.d.ts），拿不到版本号就没法做
 * 乐观锁；信封读只在会话开始时做一次。
 */
export async function loadRuntimeState(ctx) {
  const path = `/api/extensions/v3/${encodeURIComponent(pluginIdOf(ctx))}/storage/${STATE_KEY}`
  let lastMessage = ''
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stored = await readStoredValue(ctx, STATE_KEY)
    if (stored.ok) {
      if (stored.missing) return { kind: 'fresh', doc: null, revision: 0 }
      const envelope = await readStoredEnvelope(ctx, path)
      // 值与版本号必须出自同一次读取：两次读之间有别的任务落盘时，拿新版本号配旧值
      // 会让 CAS 放行一份过期文档（静默覆盖对方结果）。信封带值就以信封为准。
      const value = envelope.value !== null && envelope.value !== undefined ? envelope.value : stored.value
      const doc = normalizeStateDoc(value)
      return { kind: doc ? 'loaded' : 'foreign', doc, revision: envelope.revision }
    }
    lastMessage = stored.message
    await delay(200)
  }
  return { kind: 'unavailable', doc: null, revision: 0, message: lastMessage }
}

/** 用官方 ctx.storage.get 取值；404 = 没有这个键。 */
async function readStoredValue(ctx, key) {
  if (typeof ctx.storage?.get === 'function') {
    try {
      const value = await ctx.storage.get(key)
      return { ok: true, missing: value === null || value === undefined, value }
    } catch (error) {
      const status = Number(error?.status ?? 0)
      if (status === 404) return { ok: true, missing: true, value: null }
      return { ok: false, message: error?.message ?? String(error) }
    }
  }
  // 宿主没有 ctx.storage（极老版本）→ 回落自有存储信封
  const result = await tryApi(ctx, 'GET', `/api/extensions/v3/${encodeURIComponent(pluginIdOf(ctx))}/storage/${encodeURIComponent(key)}`)
  if (!result.ok) {
    if (result.status === 404) return { ok: true, missing: true, value: null }
    return { ok: false, message: result.message }
  }
  const value = result.data?.value
  return { ok: true, missing: value === null || value === undefined, value }
}

/** 读存储信封（版本号 + 值，CAS 用）。读不到时版本号记 0、值记 null。 */
async function readStoredEnvelope(ctx, path) {
  const result = await tryApi(ctx, 'GET', path)
  if (!result.ok) return { revision: 0, value: null }
  return {
    revision: typeof result.data?.revision === 'number' ? result.data.revision : 0,
    value: result.data?.value ?? null,
  }
}

/** 一次性运行时会话：文档 + 存储可用性 + 轮次序号。 */
export class Session {
  constructor(ctx, loaded) {
    this.ctx = ctx
    this.doc = loaded.kind === 'loaded' && loaded.doc ? loaded.doc : newStateDoc()
    // loaded/foreign/fresh 都证明存储可读；unavailable 禁止落盘。
    this.storageOk = loaded.kind !== 'unavailable'
    // 认不出的文档（foreign）不落盘：避免默认值覆盖未知内容（对照 apply_loaded）。
    this.persistAllowed = this.storageOk && loaded.kind !== 'foreign'
    this.revision = loaded.revision ?? 0
    // 本会话起点（三方合并的基线）：冲突时据此判断哪些字段是本会话改的。
    this.baseline = JSON.parse(JSON.stringify(this.doc))
    // 轮次序号跟着已落盘的版本走：新会话的幂等键不会与上一会话撞车。
    this.runSeq = this.revision
    this.loadedKind = loaded.kind
  }

  now() {
    return nowRfc3339()
  }

  /** 读用户设置（宿主 KV `settings` 键，清单默认值叠加已保存值）。 */
  async settings() {
    let raw = {}
    try {
      raw = (await this.ctx.settings.get()) ?? {}
    } catch {
      raw = {}
    }
    return toNested(normalizeFlat(raw))
  }

  /**
   * 落盘：脱敏 + 裁剪 + CAS 写回（对照 store.rs put 的 If-Match 重试）。
   *
   * conflict 时不再"同字节重放"：那会把并发任务（例如整点对齐与页面触发的刷新）
   * 刚写下的结果整份盖掉 —— 包括 daily.last_sent_date，下一小时就会重复发日报。
   * 改为重读最新文档，按「本会话改过的字段用自己的、没改过的用对方的」三方合并后再写。
   * 存储不可用时按"本轮只读"直接返回成功。
   */
  async persist() {
    if (!this.persistAllowed) return { ok: true, skipped: true }
    sanitizeForPersist(this.doc)
    const revision = bumpRevision(this.doc)
    this.runSeq = Math.max(this.runSeq, revision)
    const path = `/api/extensions/v3/${encodeURIComponent(pluginIdOf(this.ctx))}/storage/${STATE_KEY}`
    let expected = this.revision
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let text
      try {
        text = serializeState(this.doc)
      } catch (error) {
        return { ok: false, message: error.message }
      }
      const result = await tryApi(this.ctx, 'PUT', path, { value: JSON.parse(text), expected_revision: expected })
      if (result.ok) {
        this.revision = typeof result.data?.revision === 'number' ? result.data.revision : this.doc.revision
        this.baseline = JSON.parse(text)
        return { ok: true }
      }
      if (result.status !== 409 && result.status !== 412) {
        return { ok: false, message: `storage PUT HTTP ${result.status}: ${truncateUtf8(result.message, 160)}` }
      }
      const fresh = await tryApi(this.ctx, 'GET', path)
      if (!fresh.ok) return { ok: false, message: `storage 冲突后重读失败: ${fresh.message}` }
      expected = typeof fresh.data?.revision === 'number' ? fresh.data.revision : expected + 1
      const freshValue = fresh.data?.value
      if (freshValue !== null && freshValue !== undefined) {
        const theirs = normalizeStateDoc(freshValue)
        if (!theirs) return { ok: false, message: 'storage 冲突后读到认不出的文档, 不覆盖' }
        this.doc = mergeStateDocs(this.baseline, this.doc, theirs)
        sanitizeForPersist(this.doc)
      }
    }
    return { ok: false, message: 'storage PUT 冲突重试后仍失败' }
  }

  /** 落盘并吞掉错误（错误写进 last_message / 日志）。 */
  async persistQuietly() {
    const outcome = await this.persist()
    if (outcome.ok === false && outcome.message) {
      const message = `状态落盘失败: ${outcome.message}`
      this.doc.last_message = message
      log(this.doc, 'warning', message, this.now())
    }
    return outcome
  }
}

// ─────────────────────────── 取数路径 ───────────────────────────

/** 拉一页订阅池。成功返回 {items, skipped, http_status}；失败抛 Failure。 */
export async function fetchIntentsPage(session, limit, offset) {
  const path = listPath(limit, offset)
  const result = await tryApi(session.ctx, 'GET', path)
  if (!result.ok || result.status >= 400) {
    throw new Failure({
      http_status: result.status,
      raw: apiRawText(result),
      message: result.ok ? `订阅池 HTTP ${result.status}` : `订阅池请求失败: ${result.message}`,
    })
  }
  try {
    const page = parseList(result.data)
    return { ...page, http_status: result.status }
  } catch (error) {
    throw new Failure({ http_status: result.status, raw: apiRawText(result), message: error.message })
  }
}

/** 拉取实例列表并保留原始响应（供探测快照落 state.debug）。 */
export async function fetchInstancesDetailed(session) {
  const result = await tryApi(session.ctx, 'GET', INSTANCES_PATH)
  if (!result.ok || result.status >= 400) {
    throw new Failure({
      http_status: result.status,
      raw: apiRawText(result),
      message: result.ok ? `Emby 实例 HTTP ${result.status}` : `Emby 实例请求失败: ${result.message}`,
    })
  }
  try {
    return { instances: parseInstances(result.data), status: result.status, raw: apiRawText(result) }
  } catch (error) {
    throw new Failure({ http_status: result.status, raw: apiRawText(result), message: error.message })
  }
}

export async function fetchInstances(session) {
  const detailed = await fetchInstancesDetailed(session)
  return detailed.instances
}

/** 拉取并解析追剧日历。 */
export async function fetchCalendar(session) {
  const result = await tryApi(session.ctx, 'GET', CALENDAR_PATH)
  if (!result.ok || result.status >= 400) {
    throw new Failure({
      http_status: result.status,
      raw: apiRawText(result),
      message: result.ok ? `追剧日历 HTTP ${result.status}` : `追剧日历请求失败: ${result.message}`,
    })
  }
  try {
    return parseCalendar(result.data)
  } catch (error) {
    throw new Failure({ http_status: result.status, raw: apiRawText(result), message: error.message })
  }
}

/**
 * 拉取一次 Emby 覆盖。
 * shapeHint 非空时先把指纹命中的参数组合排到最前；maxAttempts 是本次允许发出的
 * 调用次数上限。返回实际发出的次数，预算必须按真实调用数扣减。
 */
export async function fetchCoverage(session, tmdbId, season, proxyId, total, shapeHint, maxAttempts) {
  if (maxAttempts <= 0) {
    throw new Failure({ message: 'Emby 探测预算已用尽', attempts: 0 })
  }
  const order = candidates(tmdbId, season, proxyId, total)
  if (shapeHint) {
    const variant = variantFromShape(shapeHint)
    if (variant !== null) {
      const position = order.findIndex((query) => query.variant === variant)
      if (position > 0) {
        const [preferred] = order.splice(position, 1)
        order.unshift(preferred)
      }
    }
  }
  let calls = 0
  let lastFailure = null
  for (const query of order) {
    if (calls >= maxAttempts) break
    calls += 1
    const result = await tryApi(session.ctx, 'GET', query.path())
    if (!result.ok || result.status >= 400) {
      lastFailure = new Failure({
        http_status: result.status,
        raw: apiRawText(result),
        message: result.ok ? `Emby 覆盖 HTTP ${result.status}` : `Emby 覆盖请求失败: ${result.message}`,
        attempts: calls,
      })
      continue
    }
    try {
      const coverage = parseCoverage(result.data)
      return { coverage, query, calls }
    } catch (error) {
      lastFailure = new Failure({
        http_status: result.status,
        raw: apiRawText(result),
        message: error.message,
        attempts: calls,
      })
    }
  }
  throw lastFailure ?? new Failure({ message: '没有可用的 Emby 探测参数', attempts: calls })
}

/**
 * 该季 TMDB 集数。带 raw_episode_counts=true（不套宿主保存的集数修正规则），
 * 每次取数恰好 1 次调用（预算按这个扣），每一次取数（含失败）都记进 attempts。
 */
export async function fetchTargetUpper(session, tmdbId, season) {
  const path = `/api/tmdb/tv/${tmdbId}?raw_episode_counts=true`
  const label = `id=${tmdbId}&season=${season}&raw=1`
  const now = session.now()
  const attempts = 1
  const result = await tryApi(session.ctx, 'GET', path)
  if (result.ok && result.status < 400) {
    try {
      const target = parseTargetUpper(result.data, season)
      recordAttempt(session.doc, 'tmdb.tv', label, result.status, `target=${target}`, now)
      return { value: targetUpperKnown(target), attempts }
    } catch (error) {
      recordAttempt(session.doc, 'tmdb.tv', label, result.status, 'unparsed', now)
      recordError(session.doc, 'job.tmdb', error.message, now)
      return { value: targetUpperUnknown('该季在 TMDB 详情里取不到'), attempts }
    }
  }
  if (result.ok) {
    recordAttempt(session.doc, 'tmdb.tv', label, result.status, 'http_error', now)
    recordError(session.doc, 'job.tmdb', `TMDB HTTP ${result.status}`, now)
    return { value: targetUpperUnknown('TMDB 返回非 200'), attempts }
  }
  recordAttempt(session.doc, 'tmdb.tv', label, 0, `transport_error: ${result.message}`, now)
  recordError(session.doc, 'job.tmdb', `TMDB 请求失败: ${result.message}`, now)
  return { value: targetUpperUnknown('TMDB 请求失败'), attempts }
}

export function targetUpperKnown(value) {
  return { value: Math.max(0, value), known: true, note: '' }
}

export function targetUpperUnknown(note) {
  return { value: 0, known: false, note }
}

// ─────────────────────────── 逐条结果的组装 ───────────────────────────

/** 判定结果 → 状态文档里的一行（对照 runtime.rs item_of）。 */
export function itemOf(intent, decision, at, target) {
  return {
    intent_id: intent.id,
    tmdb_id: intent.tmdb_id,
    season: intent.season,
    title: intent.title,
    total_known: intent.total_known,
    emby_have_max: decision.have_max,
    emby_have_count: decision.have_count,
    gap_max: decision.gap_max,
    target_upper: Math.max(0, target.value),
    target_known: target.known,
    from_total: decision.from_total,
    to_total: decision.to_total,
    action: decision.action,
    reason: truncateUtf8(decision.reason, 400),
    at,
  }
}

/** 该条证据是否属于「探到了，但 Emby 该季一集都没有」。 */
export function coverageIsAbsent(evidence) {
  return evidence.have_max === null && evidence.have_count === 0
}

/**
 * 缓存行是否带着一次真实的 Emby 覆盖观测（有集号，或探到了「该季 0 集」）。
 * 整点任务因预算/时间/负缓存跳过的行同样带着新鲜的 at，却从没探过 Emby；
 * 若当缓存复用，「立即对齐」在 6 小时内永远不会去补探这些条目。
 */
export function rowHasCoverage(row) {
  return row.emby_have_max >= 0 || row.emby_have_count === 0
}

/** 轮内/跨轮共用的探测键：`{proxy_id}:{tmdb_id}:{season}`。 */
export function probeKey(proxyId, tmdbId, season) {
  return `${proxyId ?? 0}:${tmdbId}:${season}`
}

/**
 * 该条目本轮排在哪里：上轮被预算/墙钟/补订上限挡下的先探，从没探过的其次，
 * 最近探过的最后；负缓存（近期探测失败）最末并直接跳过。
 */
export function probePriority(book, key) {
  const entry = book.get(key)
  if (!entry) return 2
  if (entry.emby === 'budget' || entry.emby === 'time' || entry.emby === 'limit') return 1
  if (entry.target === 'budget') return 1
  if (entry.emby === 'ok') return 3
  if (entry.emby === 'failed' && isFresh(entry.at, PROBE_NEGATIVE_TTL_SECS)) return 4
  // 失败事实太旧 / absent 等：当"没探过"重新排队（未收录的剧可能已被用户补进库）。
  return 2
}

/**
 * 上一轮已核实的「无缺口」行能否在本轮直接复用（零调用）。
 * 每一道都对应一类"复用就会说假话"的行：行够新；上一轮动作是 skipped；
 * 订阅总数没改过；目标与覆盖都取到过且不超过订阅总数。
 */
export function cachedNoGapRow(row, totalKnown) {
  if (row.total_known !== totalKnown || row.action !== ACTION_SKIPPED) return false
  if (!row.target_known || row.emby_have_max < 0) return false
  if (row.target_upper > totalKnown || row.emby_have_max > totalKnown) return false
  return isFresh(row.at, NO_GAP_TTL_SECS)
}

/** 解析失败落在哪个端点上（debug.attempts[].endpoint）。 */
export function endpointOf(step) {
  if (step.includes('emby')) return 'emby'
  if (step.includes('calendar')) return 'subscribe.air-calendar'
  if (step.includes('intents') || step.includes('patch')) return 'subscribe.pool.intents'
  if (step.includes('notify')) return 'notifications.plugin'
  return step
}

/** 解析失败：记错误列表 + 日志 + 尝试记录；需要时把 ≤2048 字节原文写进 debug 快照。 */
export function recordFailure(session, step, failure, slot) {
  const now = session.now()
  const message = failure.http_status > 0
    ? `${failure.message} (HTTP ${failure.http_status})`
    : failure.message
  recordError(session.doc, step, message, now)
  log(session.doc, 'warning', `${step}: ${message}`, now)
  recordAttempt(session.doc, endpointOf(step), '(见 last_errors)', failure.http_status, failure.kind(), now)
  const sample = failure.sample()
  const snapshot = {
    status: failure.kind(),
    shape: '',
    params_tried: [],
    http_status: failure.http_status,
    sample: '',
    at: now,
  }
  if (slot === 'emby') session.doc.debug.emby_episodes = { ...snapshot, sample }
  else if (slot === 'calendar') session.doc.debug.air_calendar = { ...snapshot, sample }
  else if (slot === 'intents') session.doc.debug.pool_intents = { ...snapshot, sample }
  else if (slot === 'tmdb') session.doc.debug.tmdb_target = { ...snapshot, sample }
}

/** 记下最近一次成功解析的实例列表（界面设置抽屉的数据源）。 */
export function rememberInstances(session, instances, now) {
  session.doc.emby_instances = instances.map((instance) => ({
    id: instance.id,
    name: truncateUtf8(instance.name, 160),
    is_default: instance.is_default,
    key_ready: instance.key_ready,
    at: now,
  }))
}

/** 取当前应使用的 Emby 实例（不发起请求，用内存里的实例列表 + 显式钉住的配置）。 */
export function selectedInstance(session, settings) {
  const instances = session.doc.emby_instances.map((view) => ({
    id: view.id,
    name: view.name,
    is_default: view.is_default,
    key_ready: view.key_ready,
  }))
  try {
    return selectInstance(instances, settings.emby_proxy_id)
  } catch (error) {
    if (instances.length === 0) {
      const pinned = selectionFromSettings(settings.emby_proxy_id)
      if (pinned) {
        recordAttempt(session.doc, 'emby.instances', '(无列表, 按配置直连)', 0, `id=${pinned.id}`, session.now())
        return pinned
      }
    }
    recordError(session.doc, 'emby.select', error.message, session.now())
    return null
  }
}

/** 状态文档里 6 小时内新鲜的该季目标（整点 job 顺手取到的），复用时零新增调用。 */
export function freshTmdbTarget(session, tmdbId, season) {
  const target = tmdbTargetOf(session.doc, tmdbId, season)
  if (target && isFresh(target.at, CACHE_FRESH_SECS)) return targetUpperKnown(target.episode_count)
  return targetUpperUnknown('状态里没有该季的新鲜目标')
}

// ─────────────────────────── 发送 ───────────────────────────

/** 任务引用：写进检查点，把检查点与某次运行绑定（宿主运行记录里也有 task id）。 */
function taskRefOf(ctx) {
  return typeof ctx?.task?.id === 'string' ? ctx.task.id : ''
}

/** ⑦ 发一次 PATCH（非 200 记 failed，本轮不重试）。双保险：只增 + 幅度上限。 */
export async function sendPatch(session, intent, decision, settings, runSeq) {
  if (decision.to_total <= intent.total_known ||
      decision.to_total - intent.total_known > settings.max_raise_per_run) {
    return new Decision({
      action: ACTION_SKIPPED,
      from_total: intent.total_known,
      to_total: intent.total_known,
      have_max: decision.have_max,
      have_count: decision.have_count,
      gap_max: decision.gap_max,
      reason: '守卫拒绝: 目标集数不满足只增与幅度上限',
    })
  }
  const needed = settings.write_episode_strings ? intent.needed_episodes : null
  const covered = settings.write_episode_strings ? intent.covered_episodes : null
  const body = patchBody(decision.to_total, needed, covered)
  const key = patchIdempotencyKey(intent.id, decision.from_total, decision.to_total, runSeq)
  const path = patchPath(intent.id)
  // 写前检查点：超时 / 重启 / 调用失败都不能证明这次 PATCH 没发生 —— 落一条
  // 「准备写哪条 intent、从几集抬到几集」，恢复时拿它去订阅池核对真实状态。
  // 检查点落不下就不写：否则中断后 recover 看不到这次写，会把「可能写了」误判成「没开始」。
  const guard = await taskCheckpointRequired(session.ctx, {
    stage: 'before-patch-episodes',
    task_ref: taskRefOf(session.ctx),
    intent_id: intent.id,
    from_total: decision.from_total,
    to_total: decision.to_total,
    media_type: intent.media_type,
    season: intent.season,
    run_seq: runSeq,
    updated_at: nowRfc3339(),
  })
  if (!guard.ok) {
    const message = `写前检查点落盘失败, 本条不写: ${truncateUtf8(guard.message, 160)}`
    recordError(session.doc, 'job.checkpoint', message, session.now())
    return new Decision({
      ...decision,
      action: ACTION_FAILED,
      to_total: decision.from_total,
      reason: message,
    })
  }
  const result = await tryApi(session.ctx, 'PATCH', path, body)
  const now = session.now()
  if (result.ok && result.status === 200) {
    // 写后检查点：写已确认成功（宿主回了 200），恢复时据此判定 complete。
    await taskCheckpoint(session.ctx, {
      stage: 'after-patch-episodes',
      task_ref: taskRefOf(session.ctx),
      intent_id: intent.id,
      from_total: decision.from_total,
      to_total: decision.to_total,
      media_type: intent.media_type,
      season: intent.season,
      run_seq: runSeq,
      updated_at: nowRfc3339(),
    })
    recordAttempt(session.doc, 'pool.intents.patch', key, 200, 'patched', now)
    log(session.doc, 'info', `补订 intent=${intent.id} ${intent.title} S${intent.season}: ${decision.from_total} → ${decision.to_total}`, now)
    return new Decision({ ...decision, action: ACTION_PATCHED })
  }
  const message = result.ok
    ? `PATCH HTTP ${result.status}: ${truncateUtf8(apiRawText(result), 160)}`
    : `PATCH 请求失败: ${result.message}`
  recordAttempt(session.doc, 'pool.intents.patch', key, result.status, 'failed', now)
  recordError(session.doc, 'job.patch', message, now)
  return new Decision({
    ...decision,
    action: ACTION_FAILED,
    to_total: decision.from_total,
    reason: message,
  })
}

// ─────────────────────────── 中断恢复（recover） ───────────────────────────

/**
 * 读一条 intent 在订阅池里的真实 total_known（分页查找）。
 * 返回 {ok, found, total_known}：ok=false 表示读不到（结构认不出 / 请求失败），
 * found=false 表示这一轮翻完了池子也没找到这条 intent。
 */
export async function probeIntentTotalKnown(ctx, intentId) {
  for (let page = 0; page < PAGES_MAX; page += 1) {
    const offset = page * LIMIT_MAX
    const result = await tryApi(ctx, 'GET', listPath(LIMIT_MAX, offset))
    if (!result.ok || result.status >= 400) return { ok: false, found: false, total_known: 0 }
    let parsed
    try {
      parsed = parseList(result.data)
    } catch {
      return { ok: false, found: false, total_known: 0 }
    }
    const hit = parsed.items.find((intent) => intent.id === intentId)
    if (hit) return { ok: true, found: true, total_known: hit.total_known }
    if (parsed.items.length < LIMIT_MAX) break
  }
  return { ok: true, found: false, total_known: 0 }
}

/**
 * 对齐任务的中断恢复：先查订阅池的真实状态，再决定 complete / resume / attention。
 *
 * 判定口径（外部写只有 PATCH 集数这一条）：
 * - stage=completed            → 整轮已跑完，complete（带结果）。
 * - stage=after-patch-episodes → 订阅池的 total_known 已到目标值 → complete；
 *                                仍是旧值 / 读不到 → 结果矛盾，attention（不猜、不重写）。
 * - stage=before-patch-episodes→ 订阅池已到目标值 → complete（写其实落地了）；
 *                                仍是旧值 → 明确没写，resume（只增守卫保证重跑不会写同一个值）；
 *                                读不到 → attention。
 * - 无检查点                  → 写前检查点是 PATCH 的前置条件（落不下就不写），没有它
 *                                就说明这一轮还没开始写订阅池，resume（重跑幂等）。
 * - 阶段未知                    → 定位不到是哪条 intent，attention。
 */
export async function recoverAlign(ctx, checkpoint) {
  const stage = typeof checkpoint?.stage === 'string' ? checkpoint.stage : ''
  if (stage === 'completed') return { action: 'complete', result: checkpoint.result }
  if (checkpoint === null || checkpoint === undefined) return { action: 'resume' }
  const intentId = Number(checkpoint?.intent_id ?? 0)
  const fromTotal = Number(checkpoint?.from_total ?? -1)
  const toTotal = Number(checkpoint?.to_total ?? -1)
  if (stage !== 'before-patch-episodes' && stage !== 'after-patch-episodes') {
    return { action: 'attention' }
  }
  if (!Number.isFinite(intentId) || intentId <= 0) return { action: 'attention' }
  if (!Number.isFinite(toTotal) || toTotal <= 0) return { action: 'attention' }
  const probe = await probeIntentTotalKnown(ctx, intentId)
  if (!probe.ok || !probe.found) return { action: 'attention' }
  const known = probe.total_known
  const result = {
    status: 'succeeded',
    recovered: true,
    intent_id: intentId,
    total_episodes: known,
    message: `中断恢复: 订阅池 intent #${intentId} 已是 ${known} 集（目标 ${toTotal}），写已落地，不再重写`,
  }
  if (known >= toTotal) return { action: 'complete', result }
  if (stage === 'after-patch-episodes') return { action: 'attention' }
  if (Number.isFinite(fromTotal) && fromTotal >= 0 && known === fromTotal) {
    return { action: 'resume' }
  }
  return { action: 'attention' }
}

/** ⑨⑩ 日报判定与落账；返回给 job 响应的简述。 */
export async function maybeSendDaily(session, settings, calendarToday, now) {
  const report = settings.report
  const today = localDateOf(report.tz_offset_minutes)
  const hour = localHourOf(report.tz_offset_minutes)
  if (!shouldSend(report, session.doc.daily.last_sent_date, today, hour)) {
    return { status: 'idle', date: today }
  }
  const patched = session.doc.align.items.filter(
    (item) => item.action === ACTION_PATCHED || item.action === 'dry-run',
  )
  const firstReason = session.doc.align.items
    .find((item) => (item.action === ACTION_FAILED || item.action === ACTION_SKIPPED) && item.reason !== '')
    ?.reason ?? session.doc.align.last_error ?? ''
  const { title, body } = compose(
    today, calendarToday, patched, session.doc.align.skipped, session.doc.align.failed, firstReason,
  )
  const key = dedupeKey(today, retrySeqFor(session.doc.daily, today))
  try {
    const outcome = await session.ctx.notify({
      level: 'info',
      title,
      body,
      dedupe_key: key,
    })
    applyOutcome(session.doc.daily, today, outcome ?? {}, now)
    recordAttempt(session.doc, 'notifications.plugin', 'chase-daily', 200, 'sent', now)
    return {
      status: session.doc.daily.last_result,
      accepted: outcome?.accepted === true,
      deduplicated: outcome?.deduplicated === true,
      suppressed: outcome?.suppressed === true,
    }
  } catch (error) {
    if (isDedupeConflict(error)) {
      // 同键不同内容：今天的报告已经用这个键送出过（上一轮落账前中断/落盘失败），
      // 换新键重发会让用户收到第二份日报 —— 记为已发，不重试。
      const note = `日报去重键 ${key} 已被今天更早的一轮使用, 视为已发送`
      markAlreadySent(session.doc.daily, today, now, note)
      recordAttempt(session.doc, 'notifications.plugin', 'chase-daily', 409, 'deduplicated', now)
      log(session.doc, 'info', note, now)
      return { status: 'deduplicated', accepted: false, deduplicated: true, suppressed: false }
    }
    session.doc.daily.last_at = now
    session.doc.daily.last_result = 'failed'
    session.doc.daily.last_error = truncateUtf8(error?.message || String(error), 200)
    bumpRetry(session.doc.daily, today)
    recordError(session.doc, 'job.notify', session.doc.daily.last_error, now)
    return { status: 'failed', message: session.doc.daily.last_error }
  }
}

// ─────────────────────────── 整点对齐（job align） ───────────────────────────

/** `align`：① 加载 → ② 实例 → ③ 订阅池 → ④ 日历 → ⑤⑥⑦⑧ 逐条对齐 → ⑨⑩ 日报 → ⑪ 落盘。 */
export async function runHourlyAlign(ctx) {
  const deadline = nowUnixSecs() + RUN_BUDGET_SECS
  const loaded = await loadRuntimeState(ctx)
  const session = new Session(ctx, loaded)
  session.runSeq = session.revision + 1
  const now = session.now()
  session.doc.last_run = now

  // ① 存储不可用 ⇒ 本轮只读、绝不落盘
  if (!session.storageOk) {
    const message = '宿主存储不可用: 本轮只读, 不落盘'
    log(session.doc, 'warning', message, now)
    session.doc.last_message = message
    return { status: 'skipped', message }
  }

  const settings = await session.settings()
  if (!settings.enabled) {
    session.doc.status = 'skipped'
    session.doc.last_message = '插件已停用'
    log(session.doc, 'info', '插件已停用, 跳过本轮对齐', now)
    await session.persistQuietly()
    return { status: 'skipped', message: '插件已停用' }
  }

  const counters = emptyCounters()
  const items = []
  const trims = []

  // ② 实例解析
  let selection = null
  let alignmentBlocked = null
  try {
    const instances = await fetchInstances(session)
    rememberInstances(session, instances, now)
    recordAttempt(session.doc, 'emby.instances', '(无参数)', 200, `items=${instances.length}`, now)
    try {
      selection = selectInstance(instances, settings.emby_proxy_id)
    } catch (error) {
      recordError(session.doc, 'emby.select', error.message, now)
      log(session.doc, 'warning', `Emby 段跳过: ${error.message}`, now)
      alignmentBlocked = `本轮未对齐: ${error.message}`
    }
  } catch (failure) {
    recordFailure(session, 'emby.instances', failure, null)
    log(session.doc, 'warning', `Emby 段跳过: ${failure.message}`, now)
    alignmentBlocked = `本轮未对齐: ${failure.message}`
  }
  if (selection === null) {
    if (alignmentBlocked === null) alignmentBlocked = '本轮未对齐: 没有可用的 Emby 实例'
    const status = session.doc.debug.emby_episodes.status
    if (status === '' || status === 'never') session.doc.debug.emby_episodes.status = 'skipped'
  }

  // ③ 订阅池（≤4 页 / 2000 条）
  const pool = []
  let listFailure = null
  for (let page = 0; page < PAGES_MAX; page += 1) {
    const offset = page * LIMIT_MAX
    try {
      const fetched = await fetchIntentsPage(session, LIMIT_MAX, offset)
      counters.pages += 1
      const received = fetched.items.length
      pool.push(...fetched.items)
      recordAttempt(session.doc, 'pool.intents', `limit=${LIMIT_MAX}&offset=${offset}`, fetched.http_status, `items=${received}&skipped=${fetched.skipped}`, now)
      if (fetched.skipped > 0) {
        log(session.doc, 'warning', `订阅池第 ${page + 1} 页有 ${fetched.skipped} 条条目字段不完整, 已跳过(不填默认值)`, now)
      }
      if (received < LIMIT_MAX) break
    } catch (failure) {
      listFailure = failure
      break
    }
  }
  if (listFailure) {
    // 整轮跳过：零业务写入，只写 debug（含 ≤2048 字节原文）
    recordFailure(session, 'job.intents', listFailure, 'intents')
    session.doc.align.last_error = listFailure.message
    session.doc.stats.tv_intents = pool.filter((intent) => intent.media_type === MEDIA_TYPE).length
    const message = `订阅池不可解析, 整轮跳过(零写入): ${listFailure.message}`
    session.doc.status = 'failed'
    session.doc.last_message = message
    log(session.doc, 'error', message, now)
    await session.persistQuietly()
    return { status: 'failed', message }
  }
  counters.intents_seen = pool.filter((intent) => intent.media_type === MEDIA_TYPE).length
  session.doc.stats.tv_intents = counters.intents_seen

  // ④ 追剧日历（失败只影响界面与日报段①，对齐照常）
  let calendarToday = []
  try {
    const calendar = await fetchCalendar(session)
    const today = localDateOf(settings.report.tz_offset_minutes)
    calendarToday = calendar.itemsOn(today)
    session.doc.calendar.days = calendar.window(today, settings.catch_up_days)
    session.doc.calendar.fetched_at = now
    session.doc.probe.air_calendar_shape = calendar.shape
    session.doc.debug.air_calendar = {
      status: 'ok', shape: calendar.shape, params_tried: ['(无参数)'], http_status: 200, sample: '', at: now,
    }
    recordAttempt(session.doc, 'subscribe.air-calendar', '(无参数)', 200, calendar.shape, now)
  } catch (failure) {
    recordFailure(session, 'job.air-calendar', failure, 'calendar')
    log(session.doc, 'warning', `追剧日历不可解析, 日报只发补订段: ${failure.message}`, now)
  }

  // ⑤⑥⑦⑧ 逐条对齐
  const patchLimit = Math.min(settings.max_patch_per_run, PATCH_HARD_LIMIT)
  const coverageCache = new Map()
  const failedKeys = new Set()
  const targetCache = new Map()
  let probes = 0
  let patches = 0
  let budgetHit = false
  let pendingProbe = 0
  let targetCalls = 0
  let targetOk = 0
  let degraded = null
  const book = new Map(session.doc.probe_book.map((entry) => [entry.key, entry]))
  const bookUpdates = new Map()
  const previousRows = new Map(
    session.doc.align.items.map((item) => [`${item.intent_id}:${item.tmdb_id}:${item.season}`, item]),
  )
  let reusedRows = 0

  if (selection !== null) {
    const proxy = selection.proxy_id
    // 排序（稳定）：欠账的先探，没探过的其次，最近探过的最后；负缓存最末直接跳过。
    const order = pool.map((intent, index) => ({
      intent,
      index,
      priority: intent.media_type !== MEDIA_TYPE || !actionable(intent)
        ? 0
        : probePriority(book, probeKey(proxy, intent.tmdb_id, intent.season)),
    }))
    order.sort((left, right) => left.priority - right.priority || left.index - right.index)

    const deferRest = (from) => {
      for (let position = from; position < order.length; position += 1) {
        const { intent } = order[position]
        if (intent.media_type === MEDIA_TYPE && actionable(intent)) {
          pendingProbe += 1
          if (!bookUpdates.has(probeKey(proxy, intent.tmdb_id, intent.season))) {
            bookUpdates.set(probeKey(proxy, intent.tmdb_id, intent.season), ['time', 'unknown'])
          }
        }
      }
    }

    for (let position = 0; position < order.length; position += 1) {
      const { intent } = order[position]
      if (intent.media_type !== MEDIA_TYPE) continue
      if (!actionable(intent)) {
        counters.skipped += 1
        pushAlignItem(items, itemOf(intent, {
          action: ACTION_SKIPPED,
          from_total: intent.total_known,
          to_total: intent.total_known,
          have_max: -1,
          have_count: -1,
          gap_max: 0,
          reason: `状态 ${displayState(intent.state)} 不参与补订`,
        }, now, targetUpperUnknown('未探测')))
        continue
      }
      // 复用上一轮「已核实无缺口」的行：零调用，必须排在墙钟判定之前。
      const previousRow = previousRows.get(`${intent.id}:${intent.tmdb_id}:${intent.season}`)
      if (previousRow && cachedNoGapRow(previousRow, intent.total_known)) {
        reusedRows += 1
        counters.matched += 1
        counters.skipped += 1
        pushAlignItem(items, {
          ...previousRow,
          reason: `${previousRow.reason}（${NO_GAP_TTL_SECS / 3600} 小时窗口内已核实, 本轮复用缓存, 不重复探测 Emby）`,
        })
        continue
      }
      if (nowUnixSecs() > deadline) {
        budgetHit = true
        deferRest(position)
        break
      }

      // ⑤ Emby 覆盖（同一 (实例, 剧, 季) 本轮只探一次）
      const key = probeKey(selection.proxy_id, intent.tmdb_id, intent.season)
      let bookEmby = 'ok'
      let bookTarget
      let coverage
      if (coverageCache.has(key)) {
        coverage = coverageCache.get(key)
      } else if (failedKeys.has(key)) {
        counters.skipped += 1
        pushAlignItem(items, itemOf(intent, {
          action: ACTION_SKIPPED,
          from_total: intent.total_known,
          to_total: intent.total_known,
          have_max: -1,
          have_count: -1,
          gap_max: 0,
          reason: '同一剧集本轮已探测失败, 不重复消耗预算',
        }, now, targetUpperUnknown('同一剧集本轮已探测失败')))
        continue
      } else {
        const booked = book.get(key)
        if (booked && booked.emby === 'failed' && isFresh(booked.at, PROBE_NEGATIVE_TTL_SECS)) {
          // 跨轮负缓存：不写 book_updates（一刷 at 就等于 TTL 永不过期）。
          counters.skipped += 1
          pushAlignItem(items, itemOf(intent, {
            action: ACTION_SKIPPED,
            from_total: intent.total_known,
            to_total: intent.total_known,
            have_max: -1,
            have_count: -1,
            gap_max: 0,
            reason: `该季上次 Emby 探测失败(负缓存 ${PROBE_NEGATIVE_TTL_SECS / 3600} 小时内), 本轮不重复消耗预算`,
          }, now, targetUpperUnknown('探测失败负缓存')))
          continue
        }
        const remaining = Math.max(0, settings.emby_probe_budget - probes)
        if (remaining === 0) {
          counters.skipped += 1
          pendingProbe += 1
          bookUpdates.set(key, ['budget', 'unknown'])
          pushAlignItem(items, itemOf(intent, {
            action: ACTION_SKIPPED,
            from_total: intent.total_known,
            to_total: intent.total_known,
            have_max: -1,
            have_count: -1,
            gap_max: 0,
            reason: `Emby 探测预算用尽(${settings.emby_probe_budget} 次调用): 本轮跳过, 下轮优先`,
          }, now, targetUpperUnknown('预算用尽')))
          continue
        }
        if (nowUnixSecs() > deadline) {
          budgetHit = true
          deferRest(position)
          break
        }
        try {
          const fetched = await fetchCoverage(
            session, intent.tmdb_id, intent.season, selection.proxy_id,
            intent.total_known > 0 ? intent.total_known : null,
            session.doc.probe.emby_episodes_shape, Math.min(remaining, 3),
          )
          probes += fetched.calls
          session.doc.probe.emby_episodes_shape = fetched.coverage.shape
          recordAttempt(session.doc, 'emby.episodes', fetched.query.paramsLabel(), 200, fetched.coverage.shape, now)
          session.doc.debug.emby_episodes = {
            status: 'ok', shape: fetched.coverage.shape, params_tried: [fetched.query.paramsLabel()], http_status: 200, sample: '', at: now,
          }
          coverageCache.set(key, fetched.coverage)
          coverage = fetched.coverage
        } catch (failure) {
          probes += failure.attempts
          failedKeys.add(key)
          const absent = failureIsAbsent(failure)
          if (absent) {
            counters.absent += 1
            bookUpdates.set(key, ['absent', 'unknown'])
          } else {
            counters.failed += 1
            counters.unknown_shape += 1
            bookUpdates.set(key, ['failed', 'unknown'])
          }
          recordFailure(session, 'job.emby.episodes', failure, 'emby')
          pushAlignItem(items, itemOf(intent, {
            action: ACTION_FAILED,
            from_total: intent.total_known,
            to_total: intent.total_known,
            have_max: -1,
            have_count: -1,
            gap_max: 0,
            reason: absent ? `Emby 未收录该剧/该季(非结构错误): ${failure.message}` : failure.message,
          }, now, targetUpperUnknown(absent ? 'Emby 未收录' : '覆盖探测失败')))
          continue
        }
      }
      counters.matched += 1

      // ⑥ 目标上限：该季 TMDB 集数，与 Emby 覆盖共用预算；取不到时诚实记"未知"。
      let stopAfter = false
      let targetState
      const targetKey = `${intent.tmdb_id}:${intent.season}`
      if (targetCache.has(targetKey)) {
        targetState = targetCache.get(targetKey)
        bookTarget = targetState.known ? 'ok' : 'unknown'
      } else {
        const remaining = Math.max(0, settings.emby_probe_budget - probes)
        if (remaining === 0) {
          // 预算见底只剩 Emby 那次：目标记未知，但不跳过该条 —— Emby 缺口本身仍是可信证据。
          pendingProbe += 1
          bookTarget = 'budget'
          targetState = targetUpperUnknown('TMDB 目标取数预算用尽')
        } else if (nowUnixSecs() > deadline) {
          budgetHit = true
          deferRest(position)
          stopAfter = true
          bookTarget = 'time'
          targetState = targetUpperUnknown('时间预算用尽')
        } else {
          const cachedTarget = tmdbTargetOf(session.doc, intent.tmdb_id, intent.season)
          if (cachedTarget && isFresh(cachedTarget.at, CACHE_FRESH_SECS)) {
            bookTarget = 'cached'
            targetState = targetUpperKnown(cachedTarget.episode_count)
          } else {
            const fetched = await fetchTargetUpper(session, intent.tmdb_id, intent.season)
            probes += fetched.attempts
            targetCalls += 1
            bookTarget = fetched.value.known ? 'ok' : 'unknown'
            if (fetched.value.known) {
              targetOk += 1
              rememberTmdbTarget(session.doc, intent.tmdb_id, intent.season, fetched.value.value, now)
            } else {
              forgetTmdbTarget(session.doc, intent.tmdb_id, intent.season)
            }
            targetState = fetched.value
          }
        }
      }
      targetCache.set(targetKey, targetState)
      if (stopAfter) break

      const evidence = Evidence.fromCoverage(intent.total_known, coverage, targetState.value)
      evidence.target_known = targetState.known
      evidence.target_note = targetState.note
      // 「探到了，但 Emby 该季一集都没有」单独计数；未收录行的判定跳过不重复计 skipped。
      const absentRow = coverageIsAbsent(evidence)
      if (absentRow) {
        counters.absent += 1
        bookEmby = 'absent'
      }
      bookUpdates.set(key, [bookEmby, bookTarget])

      const decision = decide(evidence, settings, settings.dry_run)
      counters.gap_total += Math.max(0, decision.gap_max)

      if (decision.action === ACTION_PATCHED) {
        if (!settings.auto_bump) {
          counters.skipped += 1
          pushAlignItem(items, itemOf(intent, {
            ...decision,
            action: ACTION_SKIPPED,
            reason: `自动补订已关闭(auto_bump=false): 本可补订到 ${decision.to_total} 集, 未写`,
          }, now, targetState))
        } else if (patches >= patchLimit) {
          counters.skipped += 1
          pushAlignItem(items, itemOf(intent, {
            ...decision,
            action: ACTION_SKIPPED,
            reason: `已达单轮补订上限 ${patchLimit} 条`,
          }, now, targetState))
        } else {
          patches += 1
          const outcome = await sendPatch(session, intent, decision, settings, session.runSeq)
          if (outcome.action === ACTION_PATCHED) {
            counters.patched += 1
            counters.aligned += 1
          } else {
            counters.failed += 1
          }
          pushAlignItem(items, itemOf(intent, outcome, now, targetState))
        }
      } else {
        if (!absentRow) counters.skipped += 1
        pushAlignItem(items, itemOf(intent, decision, now, targetState))
      }

      // ⑧ 减方向建议（只读；永不写）
      if (shouldSuggestTrim(intent.total_known, coverage, targetState.value, trimCandidate(intent))) {
        trims.push({
          intent_id: intent.id,
          tmdb_id: intent.tmdb_id,
          season: intent.season,
          title: intent.title,
          total_known: intent.total_known,
          emby_have_max: coverage.haveMax() ?? -1,
          target_upper: targetState.value,
          reason: trimReason(intent.total_known, targetState.value),
          at: now,
        })
      }
    }
  }

  // 跨轮探测记账合并：只对本轮真的写了 book_updates 的键刷新 at。
  {
    const merged = new Map(book)
    for (const [key, [embyStatus, targetStatus]] of bookUpdates) {
      merged.set(key, { key, at: now, emby: embyStatus, target: targetStatus })
    }
    const entries = [...merged.values()].sort((left, right) =>
      left.at < right.at ? -1 : left.at > right.at ? 1 : (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    if (entries.length > 200) entries.splice(0, entries.length - 200)
    session.doc.probe_book = entries
  }

  // 本轮 TMDB 目标全灭时给一条可见结论。
  if (targetCalls > 0 && targetOk === 0) {
    degraded = `本轮 TMDB 目标不可用: ${targetCalls} 次取数全部失败, 追更判定降级为仅 Emby 缺口(目标记未知)`
  }

  // 落账（计数 + 逐条结果）
  session.doc.align.last_run_at = now
  session.doc.align.pages = counters.pages
  session.doc.align.intents_seen = counters.intents_seen
  session.doc.align.matched = counters.matched
  session.doc.align.patched = counters.patched
  session.doc.align.skipped = counters.skipped
  session.doc.align.failed = counters.failed
  session.doc.align.absent = counters.absent
  session.doc.align.pending_probe = pendingProbe
  const firstError = items.find((item) => item.action === ACTION_FAILED)?.reason ?? alignmentBlocked ?? ''
  session.doc.align.last_error = firstError !== ''
    ? (degraded ? `${firstError}; ${degraded}` : firstError)
    : (degraded ?? '')
  session.doc.align.items = items
  session.doc.trim_suggestions = trims
  session.doc.stats.matched = counters.matched
  session.doc.stats.aligned = counters.aligned
  session.doc.stats.gap_total = counters.gap_total
  session.doc.stats.unknown_shape = counters.unknown_shape

  // ⑨⑩ 日报
  const report = await maybeSendDaily(session, settings, calendarToday, now)

  // ⑪ 落盘
  const message = `对齐完成: 订阅 ${counters.intents_seen} 条, 判定 ${counters.matched} 条, 补订 ${counters.patched} 条, 跳过 ${counters.skipped} 条, 失败 ${counters.failed} 条, 未收录 ${counters.absent} 条, 待探测 ${pendingProbe} 条${budgetHit ? ' (时间预算用尽)' : ''}`
  session.doc.status = 'accepted'
  session.doc.last_message = message
  log(session.doc, 'info', message, now)
  if (reusedRows > 0) {
    log(session.doc, 'info', `本轮复用 ${reusedRows} 条已核实无缺口的行(${NO_GAP_TTL_SECS / 3600} 小时窗口内不重复探测 Emby)`, now)
  }
  if (degraded) log(session.doc, 'warning', degraded, now)
  await session.persistQuietly()

  return {
    status: 'accepted',
    message,
    pages: counters.pages,
    intents_seen: counters.intents_seen,
    matched: counters.matched,
    patched: counters.patched,
    skipped: counters.skipped,
    failed: counters.failed,
    absent: counters.absent,
    pending_probe: pendingProbe,
    target_calls: targetCalls,
    reused: reusedRows,
    budget_hit: budgetHit,
    report,
  }
}

// ─────────────────────────── 立即对齐（job align-now） ───────────────────────────

/** 限量对齐：只用 1 页 intents + 缓存/最多 3 次 Emby 实测，PATCH ≤5。 */
export async function runAlignNow(ctx) {
  const deadline = nowUnixSecs() + ALIGN_NOW_BUDGET_SECS
  const loaded = await loadRuntimeState(ctx)
  const session = new Session(ctx, loaded)
  session.runSeq = session.revision + 1
  const settings = await session.settings()
  if (!settings.enabled) return { status: 'skipped', message: '插件已停用' }

  const now = session.now()
  const counters = emptyCounters()
  let budgetHit = false

  // ① 只读 1 页
  let fetched
  try {
    fetched = await fetchIntentsPage(session, ALIGN_NOW_PAGE_SIZE, 0)
  } catch (failure) {
    recordFailure(session, 'align-now.intents', failure, 'intents')
    await session.persistQuietly()
    return { status: 'failed', message: `订阅池读取失败: ${failure.message}` }
  }
  counters.pages = 1

  const cache = new Map(session.doc.align.items.map((item) => [
    `${item.intent_id}:${item.tmdb_id}:${item.season}`,
    item,
  ]))
  const patchLimit = Math.min(settings.max_patch_per_run, ALIGN_NOW_PATCH_LIMIT)
  let probeCalls = 0
  let patches = 0
  let planned = 0
  let pendingProbe = 0
  let selected
  const items = []

  for (const intent of fetched.items) {
    if (intent.media_type !== MEDIA_TYPE) continue
    counters.intents_seen += 1
    if (!actionable(intent)) {
      counters.skipped += 1
      continue
    }
    if (nowUnixSecs() > deadline) {
      budgetHit = true
      break
    }

    // 优先用 6 小时内新鲜的缓存判定（按 (intent_id, tmdb_id, season) 命中）。
    const cachedRow = cache.get(`${intent.id}:${intent.tmdb_id}:${intent.season}`)
    const cached = cachedRow && rowHasCoverage(cachedRow) && isFresh(cachedRow.at, CACHE_FRESH_SECS) ? cachedRow : null
    const verifiedAt = cached ? cached.at : null
    let targetState
    let evidence
    if (cached) {
      evidence = Evidence.fromCache(intent.total_known, cached.emby_have_max, cached.emby_have_count, cached.target_upper)
      evidence.target_known = cached.target_known || cached.target_upper > 0
      if (!evidence.target_known && evidence.target_note === '') {
        evidence.target_note = '缓存行没记到该季目标'
      }
      targetState = { value: evidence.target_upper, known: evidence.target_known, note: evidence.target_note }
    } else {
      const remaining = Math.max(0, ALIGN_NOW_PROBE_LIMIT - probeCalls)
      // 实例只解析一次：逐条解析会把同一条选择错误/直连记录刷满诊断列表。
      if (selected === undefined) selected = selectedInstance(session, settings)
      if (selected === null) {
        counters.skipped += 1
        continue
      }
      if (remaining === 0) {
        // 前台只有 3 次探测额度：没轮到的条目记成"下轮优先"。
        counters.skipped += 1
        pendingProbe += 1
        continue
      }
      if (nowUnixSecs() > deadline) {
        budgetHit = true
        break
      }
      try {
        const fetchedCoverage = await fetchCoverage(
          session, intent.tmdb_id, intent.season, selected.proxy_id,
          intent.total_known > 0 ? intent.total_known : null,
          session.doc.probe.emby_episodes_shape, Math.min(remaining, 3),
        )
        probeCalls += fetchedCoverage.calls
        session.doc.probe.emby_episodes_shape = fetchedCoverage.coverage.shape
        recordAttempt(session.doc, 'emby.episodes', fetchedCoverage.query.paramsLabel(), 200, fetchedCoverage.coverage.shape, now)
        session.doc.debug.emby_episodes = {
          status: 'ok', shape: fetchedCoverage.coverage.shape, params_tried: [fetchedCoverage.query.paramsLabel()], http_status: 200, sample: '', at: now,
        }
        // 实测条目也用状态里最近一次成功取到的该季目标（探测量全给 Emby）；没有就是未知。
        targetState = freshTmdbTarget(session, intent.tmdb_id, intent.season)
        evidence = Evidence.fromCoverage(intent.total_known, fetchedCoverage.coverage, targetState.value)
        evidence.target_known = targetState.known
        evidence.target_note = targetState.note
      } catch (failure) {
        probeCalls += failure.attempts
        const absent = failureIsAbsent(failure)
        if (absent) {
          // 「Emby 里没有该剧/该季」独立分类：行级 action 与整点 job 保持一致（都是 failed）。
          counters.absent += 1
          items.push(itemOf(intent, {
            action: ACTION_FAILED,
            from_total: intent.total_known,
            to_total: intent.total_known,
            have_max: -1,
            have_count: 0,
            gap_max: 0,
            reason: `Emby 未收录该剧/该季(非结构错误): ${failure.message}`,
          }, now, targetUpperUnknown('未收录')))
          continue
        }
        counters.failed += 1
        counters.unknown_shape += 1
        recordFailure(session, 'align-now.emby.episodes', failure, 'emby')
        items.push(itemOf(intent, {
          action: ACTION_FAILED,
          from_total: intent.total_known,
          to_total: intent.total_known,
          have_max: -1,
          have_count: -1,
          gap_max: 0,
          reason: failure.message,
        }, now, targetUpperUnknown('覆盖探测失败')))
        continue
      }
    }

    // absent 是独立计数桶：未收录行的判定跳过不再额外计一次 skipped。
    const absentRow = coverageIsAbsent(evidence)
    if (absentRow) counters.absent += 1
    const decision = decide(evidence, settings, settings.dry_run)
    counters.matched += 1
    counters.gap_total += Math.max(0, decision.gap_max)
    const rowAt = verifiedAt ?? now
    if (decision.action === ACTION_PATCHED) {
      if (patches >= patchLimit) {
        counters.skipped += 1
        items.push(itemOf(intent, {
          ...decision,
          action: ACTION_SKIPPED,
          reason: `已达单轮补订上限 ${patchLimit} 条`,
        }, rowAt, targetState))
        continue
      }
      if (nowUnixSecs() > deadline) {
        budgetHit = true
        break
      }
      patches += 1
      const outcome = await sendPatch(session, intent, decision, settings, session.runSeq)
      if (outcome.action === ACTION_PATCHED) {
        counters.patched += 1
        counters.aligned += 1
      } else {
        counters.failed += 1
      }
      planned += 1
      items.push(itemOf(intent, outcome, rowAt, targetState))
    } else if (decision.action === 'dry-run') {
      planned += 1
      counters.aligned += 1
      items.push(itemOf(intent, decision, rowAt, targetState))
    } else {
      if (!absentRow) counters.skipped += 1
      items.push(itemOf(intent, decision, rowAt, targetState))
    }
  }

  // v3 无常驻内存：把本轮结果落盘（旧版为省 host.call 预算只写内存，见 README 差异）。
  session.doc.align.last_run_at = now
  session.doc.align.pages = counters.pages
  session.doc.align.intents_seen = counters.intents_seen
  session.doc.align.matched = counters.matched
  session.doc.align.patched = counters.patched
  session.doc.align.skipped = counters.skipped
  session.doc.align.failed = counters.failed
  session.doc.align.absent = counters.absent
  session.doc.align.pending_probe = pendingProbe
  session.doc.align.items = items
  session.doc.stats.tv_intents = counters.intents_seen
  session.doc.stats.matched = counters.matched
  session.doc.stats.aligned = counters.aligned
  session.doc.stats.gap_total = counters.gap_total
  session.doc.stats.unknown_shape = counters.unknown_shape
  session.doc.status = 'accepted'
  session.doc.last_message = `立即对齐: 补订 ${counters.patched} 条, 跳过 ${counters.skipped} 条, 未收录 ${counters.absent} 条`
  session.doc.last_run = now
  await session.persistQuietly()

  return {
    status: 'accepted',
    planned,
    patched: counters.patched,
    skipped: counters.skipped,
    absent: counters.absent,
    intents_seen: counters.intents_seen,
    failed: counters.failed,
    budget_hit: budgetHit,
    message: session.doc.last_message,
  }
}

// ─────────────────────────── 只读刷新（job refresh） ───────────────────────────

/** 只读刷新：重读 state + 1 页 intents + 1 次日历。零 PATCH。 */
export async function runRefresh(ctx) {
  const startedAt = nowUnixSecs()
  const loaded = await loadRuntimeState(ctx)
  const session = new Session(ctx, loaded)
  const now = session.now()

  let message = ''
  let tvIntents = 0
  try {
    const fetched = await fetchIntentsPage(session, ALIGN_NOW_PAGE_SIZE, 0)
    tvIntents = fetched.items.filter((intent) => intent.media_type === MEDIA_TYPE).length
    session.doc.stats.tv_intents = tvIntents
    recordAttempt(session.doc, 'pool.intents', `limit=${ALIGN_NOW_PAGE_SIZE}&offset=0`, fetched.http_status, `items=${tvIntents}`, now)
  } catch (failure) {
    recordFailure(session, 'refresh.intents', failure, 'intents')
    message = `订阅池读取失败: ${failure.message}`
  }

  let calendarDays = 0
  try {
    const calendar = await fetchCalendar(session)
    const settings = await session.settings()
    session.doc.probe.air_calendar_shape = calendar.shape
    const today = localDateOf(settings.report.tz_offset_minutes)
    const window = calendar.window(today, settings.catch_up_days)
    calendarDays = window.length
    session.doc.calendar.days = window
    session.doc.calendar.fetched_at = now
    session.doc.debug.air_calendar = {
      status: 'ok', shape: calendar.shape, params_tried: ['(无参数)'], http_status: 200, sample: '', at: now,
    }
    recordAttempt(session.doc, 'subscribe.air-calendar', '(无参数)', 200, calendar.shape, now)
  } catch (failure) {
    recordFailure(session, 'refresh.air-calendar', failure, 'calendar')
    if (message === '') message = `日历读取失败: ${failure.message}`
  }

  // 只读刷新不重新判定：「已判定」沿用上一轮对齐的计数（不拿结果行数顶替，
  // 结果行含未参与判定的条目且上限 50 行）。
  const matched = session.doc.stats.matched
  const elapsedMs = Math.max(0, nowUnixSecs() - startedAt) * 1000
  if (message === '') message = `界面计数已刷新(${elapsedMs}ms)`
  log(session.doc, 'info', message, now)
  await session.persistQuietly()
  return {
    status: 'accepted',
    message,
    tv_intents: tvIntents,
    matched,
    calendar_days: calendarDays,
    checked_at: now,
  }
}

// ─────────────────────────── 探测诊断（job probe-dump） ───────────────────────────

/** 两个未知端点的参数/字段矩阵；结果写 state.debug（唯一会写 debug 的前台动作）。 */
export async function runProbeDump(ctx) {
  const loaded = await loadRuntimeState(ctx)
  const session = new Session(ctx, loaded)
  const now = session.now()

  // ① 实例列表（强类型，顺便刷新界面下拉）；原文样本落 state.debug ——
  // 真实宿主出现过「200 但解析为空」：字段没认出还是宿主没配实例，只有原文能分辨。
  let instancesSnapshot
  try {
    const detailed = await fetchInstancesDetailed(session)
    rememberInstances(session, detailed.instances, now)
    const shape = `instances=${detailed.instances.length}`
    recordAttempt(session.doc, 'emby.instances', '(无参数)', detailed.status, shape, now)
    instancesSnapshot = {
      status: 'ok', shape, params_tried: ['(无参数)'], http_status: detailed.status, sample: sampleText(detailed.raw, SAMPLE_MAX), at: now,
    }
  } catch (failure) {
    recordFailure(session, 'probe.emby.instances', failure, null)
    instancesSnapshot = {
      status: failure.kind(), shape: '(未识别)', params_tried: ['(无参数)'], http_status: failure.http_status, sample: failure.sample(), at: now,
    }
  }
  session.doc.debug.emby_instances = instancesSnapshot
  const settings = await session.settings()
  const selected = selectedInstance(session, settings)

  // ② 探测样本：优先用上一轮对齐的条目，否则拉 1 页订阅池。
  let sample = session.doc.align.items.find((item) => item.tmdb_id > 0)
  if (!sample) {
    try {
      const fetched = await fetchIntentsPage(session, 1, 0)
      sample = fetched.items.find((item) => item.tmdb_id > 0) ?? null
    } catch {
      sample = null
    }
  }

  let embyShape = ''
  let embyStatus = 'skipped'
  let embyHttp = 0
  let embySample = ''
  let paramsTried = ['(无参数)']

  if (selected && sample) {
    // 宿主明示 total_episodes 必填；total 未知时才省略（基本必 400，仅兜底）。
    const total = sample.total_known > 0 ? sample.total_known : null
    const tried = []
    let lastFailure = null
    let bestUnparsed = null
    let success = null
    for (const query of candidates(sample.tmdb_id, sample.season, selected.proxy_id, total)) {
      tried.push(query.paramsLabel())
      const result = await tryApi(session.ctx, 'GET', query.path())
      if (result.ok && result.status < 400) {
        try {
          const coverage = parseCoverage(result.data)
          const shape = `${query.shapePrefix()};${coverage.shape}`
          recordAttempt(session.doc, 'emby.episodes', query.paramsLabel(), result.status, shape, now)
          success = { shape, status: result.status, sample: sampleText(apiRawText(result), SAMPLE_MAX) }
          break
        } catch (error) {
          recordAttempt(session.doc, 'emby.episodes', query.paramsLabel(), result.status, 'unparsed', now)
          const failure = new Failure({ http_status: result.status, raw: apiRawText(result), message: error.message })
          // 「200 但结构未识别」的现场比后面的 400 更有排障价值：留着第一个。
          if (bestUnparsed === null) bestUnparsed = failure
          lastFailure = failure
        }
      } else if (result.ok) {
        recordAttempt(session.doc, 'emby.episodes', query.paramsLabel(), result.status, 'http_error', now)
        lastFailure = new Failure({
          http_status: result.status, raw: apiRawText(result), message: `Emby 覆盖 HTTP ${result.status}`,
        })
      } else {
        recordAttempt(session.doc, 'emby.episodes', query.paramsLabel(), 0, 'transport_error', now)
        lastFailure = new Failure({ message: `Emby 覆盖请求失败: ${result.message}` })
      }
    }
    if (success) {
      session.doc.probe.emby_episodes_shape = success.shape
      embyShape = success.shape
      embyStatus = 'ok'
      embyHttp = success.status
      embySample = success.sample
    } else {
      const failure = bestUnparsed ?? lastFailure ?? new Failure({ message: '没有可用的 Emby 探测参数' })
      embyStatus = failure.kind()
      embyHttp = failure.http_status
      embySample = failure.sample()
      recordFailure(session, 'probe.emby.episodes', failure, 'emby')
    }
    paramsTried = tried
  } else {
    embySample = '没有可用的 TMDB 剧集样本或 Emby 实例; 先让订阅池里有 tv 条目'
    recordError(session.doc, 'probe.emby.episodes', embySample, now)
  }
  session.doc.debug.emby_episodes = {
    status: embyStatus, shape: embyShape, params_tried: paramsTried, http_status: embyHttp, sample: embySample, at: now,
  }

  // ③ 追剧日历（无参数，一次调用）
  let calendarShape = ''
  let calendarStatus
  let calendarHttp = 0
  let calendarSample = ''
  try {
    const calendar = await fetchCalendar(session)
    calendarShape = calendar.shape
    calendarStatus = 'ok'
    calendarHttp = 200
    recordAttempt(session.doc, 'subscribe.air-calendar', '(无参数)', 200, calendar.shape, now)
    session.doc.probe.air_calendar_shape = calendar.shape
    const today = localDateOf(settings.report.tz_offset_minutes)
    session.doc.calendar.days = calendar.window(today, settings.catch_up_days)
    session.doc.calendar.fetched_at = now
  } catch (failure) {
    calendarStatus = failure.kind()
    calendarHttp = failure.http_status
    calendarSample = failure.sample()
    recordFailure(session, 'probe.air-calendar', failure, 'calendar')
  }
  session.doc.debug.air_calendar = {
    status: calendarStatus, shape: calendarShape, params_tried: ['(无参数)'], http_status: calendarHttp, sample: calendarSample, at: now,
  }

  // ④ TMDB 该季集数：走与 job 完全相同的路径（带 raw_episode_counts=true），让
  // "取不到"在诊断面板里可见，而不是界面上一个沉默的 0。
  let tmdbStatus = 'skipped'
  let tmdbShape = ''
  let tmdbHttp = 0
  let tmdbSample = ''
  if (sample) {
    const path = `/api/tmdb/tv/${sample.tmdb_id}?raw_episode_counts=true`
    const label = `id=${sample.tmdb_id}&season=${sample.season}&raw=1`
    const result = await tryApi(session.ctx, 'GET', path)
    const rawText = apiRawText(result)
    if (result.ok && result.status < 400) {
      try {
        const target = parseTargetUpper(result.data, sample.season)
        tmdbStatus = 'ok'
        tmdbShape = `season=${sample.season} episode_count=${target}`
        tmdbHttp = result.status
        tmdbSample = sampleText(rawText, SAMPLE_MAX)
        recordAttempt(session.doc, 'tmdb.tv', label, result.status, tmdbShape, now)
        rememberTmdbTarget(session.doc, sample.tmdb_id, sample.season, target, now)
      } catch (error) {
        tmdbStatus = 'unparsed'
        tmdbShape = `season=${sample.season} 取不到(见样本)`
        tmdbHttp = result.status
        tmdbSample = sampleText(rawText, SAMPLE_MAX)
        recordAttempt(session.doc, 'tmdb.tv', label, result.status, 'unparsed', now)
        recordFailure(session, 'probe.tmdb.tv', new Failure({ http_status: result.status, raw: rawText, message: error.message }), 'tmdb')
      }
    } else if (result.ok) {
      tmdbStatus = 'http_error'
      tmdbHttp = result.status
      tmdbSample = sampleText(rawText, SAMPLE_MAX)
      recordAttempt(session.doc, 'tmdb.tv', label, result.status, 'http_error', now)
      recordFailure(session, 'probe.tmdb.tv', new Failure({ http_status: result.status, raw: rawText, message: `TMDB HTTP ${result.status}` }), 'tmdb')
    } else {
      tmdbStatus = 'transport_error'
      recordAttempt(session.doc, 'tmdb.tv', label, 0, `transport_error: ${result.message}`, now)
      recordFailure(session, 'probe.tmdb.tv', new Failure({ message: `TMDB 请求失败: ${result.message}` }), 'tmdb')
    }
  } else {
    tmdbSample = '没有可用的 TMDB 剧集样本; 先让订阅池里有 tv 条目'
    recordError(session.doc, 'probe.tmdb.tv', tmdbSample, now)
  }
  session.doc.debug.tmdb_target = {
    status: tmdbStatus, shape: tmdbShape, params_tried: ['raw_episode_counts=true'], http_status: tmdbHttp, sample: tmdbSample, at: now,
  }
  session.doc.debug.updated_at = now

  const message = `探测完成: emby=${embyStatus}, calendar=${calendarStatus}, tmdb=${tmdbStatus}`
  session.doc.status = 'accepted'
  session.doc.last_message = message
  session.doc.last_run = now
  log(session.doc, 'info', message, now)
  await session.persistQuietly()

  return {
    status: 'accepted',
    message,
    emby: { shape: embyShape, http_status: embyHttp, sample_preview: truncateUtf8(embySample, 200), params_tried: paramsTried },
    calendar: { shape: calendarShape, http_status: calendarHttp, sample_preview: truncateUtf8(calendarSample, 200) },
    tmdb: { shape: tmdbShape, http_status: tmdbHttp, status: tmdbStatus, sample_preview: truncateUtf8(tmdbSample, 200) },
    state_version: `state-v${session.doc.revision}`,
  }
}

// ─────────────────────────── 小工具 ───────────────────────────

function emptyCounters() {
  return {
    pages: 0,
    intents_seen: 0,
    matched: 0,
    patched: 0,
    skipped: 0,
    failed: 0,
    absent: 0,
    gap_total: 0,
    aligned: 0,
    unknown_shape: 0,
  }
}

/** 状态值的中文占位（空状态在界面/日报里不能是空白）。 */
export function displayState(state) {
  return state === '' ? '未知' : state
}
