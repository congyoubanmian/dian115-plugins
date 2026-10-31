// 会话层 —— plugins/douban-rs/src/runtime.rs 的 Runtime + store.rs 的落盘语义。
//
// v3 与旧 WASM 运行时的结构性差异（对照 README「迁移差异」）：
// 1. 宿主无常驻 JS VM：每个 job 都是独立加载的一次性运行；旧版"内存态 + ensure_loaded
//    单次加载"改为 Session.open(ctx) 一次性读盘、persist() CAS 写回（expected_revision）。
// 2. 旧版 host.call 通道（信封/base64/ETag）由 v3 ctx.api 收敛；幂等键不再由插件携带
//    （ctx.api 不暴露自定义头），任务幂等由宿主任务队列 business_key 保底。
// 3. 通知 v3 可用（ctx.notify），旧版被宿主停用的 send-test / notify_on_subscribe 恢复实现。

import {
  newStateDoc,
  sanitizeState,
  sanitizeSettingsView,
  hasAccountFields,
  STATE_HISTORY_LIMIT,
  STATE_LOGS_LIMIT,
  LOG_MESSAGE_LIMIT,
  PERSIST_LOG_LIMIT,
} from '../lib/model.js'
import { normalizeFlat, applyFlatPatch, normalizeDocSettings } from '../lib/settings.js'
import { truncateUtf8Boundary } from '../lib/text.js'
import { nowRfc3339, nowUnixNanos, parseRfc3339, currentMonth } from '../lib/clock.js'
import { canSubscribe, FILTERED_QUEUE_STATE, NO_RESUB_REASON, NO_RESUB_CONFIRM_TEXT, NO_RESUB_SCAN_MIN_INTERVAL_NANOS, noResubGuardMessage, parseTmdbRef, historyEntryQualifies, intentIsCompleted } from '../lib/filter-core.js'
import { HOST_POOL_INTENTS_LIMIT, poolIntentsPath, parseIntentList } from '../lib/subscribe-core.js'
import { loadStateWithRetry, persistState, loadAccount, saveAccount, writeDiag, serializeStateBudgeted, tryApi } from './store.js'

/** 诊断面包屑 + 落盘 + 守卫 + 历史统计的一次性会话（runtime.rs `Runtime`）。 */
export class Session {
  constructor(ctx, loaded) {
    this.ctx = ctx
    this.ctxId = ctx.id ?? ctx.plugin?.id ?? ''
    // loaded.kind ∈ loaded | foreign | fresh | unavailable
    this.doc = loaded.kind === 'loaded' && loaded.doc ? loaded.doc : newStateDoc()
    // unavailable 时禁止落盘（默认值覆盖用户配置的事故路径）；foreign 同样禁止
    this.persistAllowed = loaded.kind === 'loaded' || loaded.kind === 'fresh'
    this.loadedKind = loaded.kind
    this.revision = loaded.revision ?? 0
    this.flat = null // 惰性：settings() 首次调用时取
    this.accountDirty = false
  }

  /** 一次性打开：读盘（三态）+ 账号键覆盖 + 榜单键补全 + 预载扁平设置 + load 面包屑。 */
  static async open(ctx) {
    const loaded = await loadStateWithRetry(ctx)
    const session = new Session(ctx, loaded)
    // 账号键覆盖是 load_all 的无条件步骤（读失败自然为空，不影响 fresh）
    const { account, bytes } = await loadAccount(ctx)
    let overlay = false
    if (account) {
      overlay = hasAccountFields(account)
      session.applyAccountOverlay(account)
    }
    session.doc.settings = normalizeDocSettings(session.doc.settings)
    if (!session.doc.stats.by_list) session.doc.stats.by_list = {}
    await session.settings()
    // 面包屑（runtime.rs load_all 的 trace_detail）：宿主若中途杀掉 worker，
    // 事后仍能从 diag 键看出最后成功执行到哪一步
    await session.trace('load', {
      state_result: loaded.kind,
      restored: loaded.kind === 'loaded',
      account_bytes: bytes,
      overlay,
    })
    return session
  }

  /** 账号键只覆盖非空字段（runtime.rs load_account_overlay）。 */
  applyAccountOverlay(account) {
    if (account.cookiecloud_url !== '') this.doc.settings.cookiecloud_url = account.cookiecloud_url
    if (account.cookiecloud_uuid !== '') this.doc.settings.cookiecloud_uuid = account.cookiecloud_uuid
    if (account.cookiecloud_key !== '') this.doc.settings.cookiecloud_key = account.cookiecloud_key
    if (account.manual_cookie !== '') this.doc.settings.manual_cookie = account.manual_cookie
    if (account.wish_sync_enabled === true) this.doc.settings.wish_sync_enabled = true
  }

  /** 读运行时设置：清单扁平设置（宿主默认值叠加）+ 状态文档内嵌配置。 */
  async settings() {
    let raw = {}
    try {
      raw = (await this.ctx.settings.get()) ?? {}
    } catch {
      raw = {}
    }
    this.flat = normalizeFlat(raw)
    // 状态文档里的账号字段（旧文档兼容）优先于空白的清单设置
    const docSettings = this.doc.settings
    if (docSettings.cookiecloud_url && !this.flat.cookiecloud_url) this.flat.cookiecloud_url = docSettings.cookiecloud_url
    if (docSettings.cookiecloud_uuid && !this.flat.cookiecloud_uuid) this.flat.cookiecloud_uuid = docSettings.cookiecloud_uuid
    if (docSettings.cookiecloud_key && !this.flat.cookiecloud_key) this.flat.cookiecloud_key = docSettings.cookiecloud_key
    if (docSettings.manual_cookie && !this.flat.manual_cookie) this.flat.manual_cookie = docSettings.manual_cookie
    if (docSettings.wish_sync_enabled && !this.flat.wish_sync_enabled) this.flat.wish_sync_enabled = true
    return this.flat
  }

  /** 已缓存的扁平设置（settings() 之后用；未加载时兜底默认值）。 */
  flatSync() {
    if (!this.flat) this.flat = normalizeFlat({})
    return this.flat
  }

  /** 写运行日志（runtime.rs log：400 字节截断 + max_logs 裁剪）。 */
  log(level, message) {
    const entry = { at: nowRfc3339(), level, message: truncateUtf8Boundary(message, LOG_MESSAGE_LIMIT) }
    if (!Array.isArray(this.doc.logs)) this.doc.logs = []
    this.doc.logs.push(entry)
    const max = this.doc.settings.max_logs
    if (max > 0 && this.doc.logs.length > max) {
      this.doc.logs.splice(0, this.doc.logs.length - max)
    }
  }

  /** 诊断面包屑（runtime.rs trace_detail：单键覆盖写，失败不影响业务）。 */
  async trace(step, extra = {}) {
    try {
      await writeDiag(this.ctx, step, extra)
    } catch {
      /* 面包屑失败不影响业务 */
    }
  }

  /** 状态提示位（runtime.rs bump；版本号由存储 revision 承担，见 stateView）。 */
  bump(status, message) {
    this.last_status = status
    this.last_message = message
  }

  /** 状态变更占位（旧 runtime.rs touch；v3 版本号由存储 revision 承担）。 */
  touch() { /* no-op */ }

  /** 状态响应（runtime.rs state_doc：裁剪 + 脱敏 + 绝对路径清洗）。 */
  stateView() {
    return sanitizeState({
      status: this.last_status ?? '',
      last_message: this.last_message ?? '',
      last_run: this.doc.last_run ?? '',
      revision: this.revision,
      snapshot: this.doc.snapshot,
      blacklist: this.doc.blackstate,
      observe_queue: { items: this.doc.queue.items },
      history: (this.doc.history ?? []).slice(0, STATE_HISTORY_LIMIT),
      logs: (this.doc.logs ?? []).slice(0, STATE_LOGS_LIMIT),
      stats: this.doc.stats,
      settings: sanitizeSettingsView(this.doc.settings),
      wish: this.doc.wish ?? [],
      wish_info: this.doc.wish_info,
      no_resub: this.doc.no_resub,
    })
  }

  /**
   * 落盘整份状态（runtime.rs persist_all：日志留尾 40、4MiB 预算、CAS 写回、
   * 失败写警告日志）。
   */
  async persist() {
    if (!this.persistAllowed) {
      if (!this.loadWarned && this.loadedKind === 'foreign') {
        this.loadWarned = true
        this.log('warning', '宿主存储内容无法识别, 本次改动暂不落盘(避免覆盖已有数据)')
      } else if (!this.loadWarned && this.loadedKind === 'unavailable') {
        this.loadWarned = true
        this.log('warning', '宿主存储持续不可读, 本次改动暂不落盘(避免覆盖已有配置)')
      }
      return { ok: true, skipped: true }
    }
    const persisted = { ...this.doc }
    if (Array.isArray(this.doc.logs) && this.doc.logs.length > PERSIST_LOG_LIMIT) {
      persisted.logs = this.doc.logs.slice(this.doc.logs.length - PERSIST_LOG_LIMIT)
    }
    const budget = serializeStateBudgeted(persisted)
    if (!budget.ok) {
      this.log('warning', budget.message)
      return { ok: false, message: budget.message }
    }
    const result = await persistState(this.ctx, budget.value, this.revision)
    if (result.ok) {
      this.revision = result.revision
      if (this.accountDirty) {
        this.accountDirty = false
        await saveAccount(this.ctx, this.accountFields())
      }
      return { ok: true }
    }
    const message = `持久化失败: ${result.message}`
    this.log('warning', message)
    return { ok: false, message }
  }

  /** 落盘并吞错（错误进日志）。 */
  async persistQuietly() {
    const outcome = await this.persist()
    if (outcome.ok === false && outcome.message) {
      this.log('warning', `状态落盘失败: ${outcome.message}`)
    }
    return outcome
  }

  /** 账号键的内容（runtime.rs save_account：只写账号字段）。 */
  accountFields() {
    const settings = this.doc.settings
    return {
      cookiecloud_url: settings.cookiecloud_url ?? '',
      cookiecloud_uuid: settings.cookiecloud_uuid ?? '',
      cookiecloud_key: settings.cookiecloud_key ?? '',
      manual_cookie: settings.manual_cookie ?? '',
      wish_sync_enabled: settings.wish_sync_enabled === true,
    }
  }

  markAccountDirty() {
    this.accountDirty = true
  }

  /** 按豆瓣 ref 找回条目链接（runtime.rs find_source_url：先快照后队列）。 */
  findSourceUrl(doubanRef) {
    const lists = this.doc.snapshot.lists ?? {}
    for (const key of Object.keys(lists).sort()) {
      const items = lists[key]
      if (!Array.isArray(items)) continue
      for (const item of items) {
        if (item.douban_ref === doubanRef) return item.url
      }
    }
    for (const item of this.doc.queue.items ?? []) {
      if (item.douban_ref === doubanRef) return item.url
    }
    return ''
  }

  // ─────────────────── 过滤器 / 墓碑守卫（filter.rs 的会话侧） ───────────────────

  /** can_subscribe：candidate 由 lib/filter-core 构造，flat 为运行时设置。 */
  canSubscribe(candidate, flat) {
    return canSubscribe(candidate, flat)
  }

  /** 自动路径的墓碑守卫：Some(message) = 已拦截。只看墓碑键，不读值、不回查历史。 */
  noResubGuard(candidate) {
    const map = this.doc.no_resub
    if (map && Object.prototype.hasOwnProperty.call(map, candidate.douban_ref)) {
      return noResubGuardMessage(candidate.title)
    }
    return null
  }

  /** 手动入口的墓碑确认：不拦，UI 二次确认。 */
  noResubConfirmation(doubanRef) {
    const map = this.doc.no_resub
    if (map && Object.prototype.hasOwnProperty.call(map, doubanRef)) {
      return NO_RESUB_CONFIRM_TEXT
    }
    return null
  }

  /** 把队列里的条目记成"被过滤"（找不到时退回榜单快照找标题）。 */
  markQueueItemFiltered(doubanRef, reason) {
    let title = ''
    for (const entry of this.doc.queue.items ?? []) {
      if (entry.douban_ref === doubanRef) {
        entry.state = FILTERED_QUEUE_STATE
        entry.last_error = reason
        if (title === '') title = entry.title
      }
    }
    if (title === '') {
      const lists = this.doc.snapshot.lists ?? {}
      for (const key of Object.keys(lists).sort()) {
        for (const item of lists[key] ?? []) {
          if (item.douban_ref === doubanRef) {
            title = item.title
            break
          }
        }
        if (title !== '') break
      }
    }
    const subject = title === '' ? doubanRef : title
    this.log('info', `已过滤自动订阅：${subject}（${reason}）`)
  }

  /** 写一条墓碑（已存在同 ref 时不覆盖；不主动落盘，由调用方统一 persist）。 */
  recordNoResub(entry, reason) {
    if (!entry.douban_ref) return false
    if (!this.doc.no_resub) this.doc.no_resub = {}
    if (Object.prototype.hasOwnProperty.call(this.doc.no_resub, entry.douban_ref)) return false
    this.doc.no_resub[entry.douban_ref] = {
      tmdb_ref: entry.tmdb_ref ?? '',
      intent_id: entry.intent_id ?? 0,
      at: nowRfc3339(),
      reason,
    }
    this.touch()
    return true
  }

  /** 墓碑扫描是否到期（距上次 >= 6 小时；从未扫过 → 到期）。 */
  noResubScanDue(nowNanos = nowUnixNanos()) {
    const scan = parseRfc3339(this.doc.no_resub_scan_at)
    if (scan === null) return true
    return Math.max(0, nowNanos - scan) >= NO_RESUB_SCAN_MIN_INTERVAL_NANOS
  }

  /**
   * 扫描历史，把"订阅成功过但宿主池已查不到"的条目写进墓碑集（判定流程本体）。
   * 宿主失败 / 池条数达到查询上限（可能被截断）→ 不写（宁可漏判不可误判）。
   */
  async resolveNoResubFromHistory() {
    const entries = await fetchPoolIntents(this.ctx)
    if (entries === null) {
      this.log('warning', '宿主订阅池查询失败，跳过「已删除不重订」判定')
      return 0
    }
    if (entries.length >= HOST_POOL_INTENTS_LIMIT) {
      this.log('warning', `宿主订阅池返回条数达查询上限（${entries.length} 条），可能被截断，跳过「已删除不重订」判定`)
      return 0
    }
    // 候选：历史最新在前，每个 ref 只收第一条合格记录
    const seen = new Set()
    const candidates = []
    for (const entry of this.doc.history ?? []) {
      if (!entry.douban_ref || !historyEntryQualifies(entry)) continue
      if (seen.has(entry.douban_ref)) continue
      seen.add(entry.douban_ref)
      candidates.push(entry)
    }
    let added = 0
    for (const entry of candidates) {
      const parsed = parseTmdbRef(entry.tmdb_ref)
      if (!parsed) continue
      const stillThere = entries.some((intent) => intent.tmdb_id === parsed.id && intent.media_type === parsed.mediaType)
      if (stillThere) continue
      const completed = entries.some((intent) => intent.tmdb_id === parsed.id && intentIsCompleted(intent.state))
      if (completed) continue
      if (this.recordNoResub(entry, NO_RESUB_REASON)) {
        added += 1
        this.log('info', `墓碑记录：${entry.title}（${entry.douban_ref}）的宿主订阅已消失，此后不再自动重订`)
      }
    }
    return added
  }

  /** 清空墓碑集（action no-resub-clear 的落地段）。 */
  pruneNoResub() {
    const count = this.doc.no_resub ? Object.keys(this.doc.no_resub).length : 0
    this.doc.no_resub = null
    return count
  }

  // ─────────────────── 历史 / 统计（subscribe.rs addHistory） ───────────────────

  /** 前插历史 + 截断 + 订阅统计（result=succeeded && action=subscribe 才计数）。 */
  addHistory(entry) {
    const record = { ...entry, created_at: nowRfc3339() }
    if (!Array.isArray(this.doc.history)) this.doc.history = []
    this.doc.history.unshift(record)
    const max = this.doc.settings.max_history
    if (max > 0 && this.doc.history.length > max) {
      this.doc.history.length = max
    }
    if (record.result === 'succeeded' && record.action === 'subscribe') {
      this.doc.stats.total += 1
      const month = currentMonth()
      if (this.doc.stats.month !== month) {
        this.doc.stats.month = month
        this.doc.stats.month_new = 0
      }
      this.doc.stats.month_new += 1
      if (!this.doc.stats.by_list) this.doc.stats.by_list = {}
      this.doc.stats.by_list[record.list] = (this.doc.stats.by_list[record.list] ?? 0) + 1
    }
    this.touch()
  }

  addHistoryAndLog(entry, logMessage) {
    this.addHistory(entry)
    this.log('info', logMessage)
  }
}

/** 宿主订阅池条目列表（filter.rs host_pool_intents：任何失败返回 null，不区分原因）。 */
export async function fetchPoolIntents(ctx) {
  const result = await tryApi(ctx, 'GET', poolIntentsPath())
  if (!result.ok) return null
  return parseIntentList(result.data)
}

/** action observe-remove：原地过滤，nil 队列保持 nil。 */
export function observeRemove(session, doubanRef) {
  const items = session.doc.queue.items
  if (Array.isArray(items)) {
    session.doc.queue.items = items.filter((item) => item.douban_ref !== doubanRef)
  }
  session.bump('succeeded', '已从观察队列移除')
  return { status: 'succeeded', message: '已从观察队列移除' }
}

/** action blacklist-add：空关键词报错；已存在不落盘不改状态。 */
export function blacklistAdd(session, keyword) {
  const keywordTrimmed = String(keyword ?? '').trim()
  if (keywordTrimmed === '') return { status: 'failed', message: '关键词不能为空' }
  if (!Array.isArray(session.doc.settings.blacklist)) session.doc.settings.blacklist = []
  if (session.doc.settings.blacklist.includes(keywordTrimmed)) {
    return { status: 'succeeded', message: '关键词已存在' }
  }
  session.doc.settings.blacklist.push(keywordTrimmed)
  session.bump('succeeded', `已添加黑名单关键词：${keywordTrimmed}`)
  return { status: 'succeeded', message: `已添加黑名单关键词：${keywordTrimmed}` }
}

/** action blacklist-remove：不校验空关键词（与 Go 一致）。 */
export function blacklistRemove(session, keyword) {
  const keywordTrimmed = String(keyword ?? '').trim()
  if (Array.isArray(session.doc.settings.blacklist)) {
    session.doc.settings.blacklist = session.doc.settings.blacklist.filter((item) => item !== keywordTrimmed)
  }
  session.bump('succeeded', `已移除黑名单关键词：${keywordTrimmed}`)
  return { status: 'succeeded', message: `已移除黑名单关键词：${keywordTrimmed}` }
}

/** action open-source。 */
export function openSource(session, doubanRef) {
  const url = session.findSourceUrl(doubanRef)
  if (url === '') return { status: 'failed', message: '未找到对应豆瓣条目' }
  return { status: 'succeeded', message: '豆瓣来源已生成', url }
}

/** action no-resub-clear：空墓碑集也返回 succeeded（幂等）。 */
export function noResubClear(session) {
  const count = session.pruneNoResub()
  const message = `已清除重订限制（${count} 条）`
  session.bump('succeeded', message)
  return { status: 'succeeded', message }
}

/**
 * settings-update：扁平键合并进 settings KV（CAS），lists/blacklist 合并进状态文档；
 * 账号字段变化作废解密缓存（runtime.rs settingsUpdate）。
 */
export async function settingsUpdate(session, patch) {
  const input = patch && typeof patch === 'object' ? patch : {}
  const flat = session.flatSync()
  // ① 状态文档节：lists 合并保存（空对象忽略）；blacklist/regions 整块替换（null 清空）
  if (input.lists && typeof input.lists === 'object' && !Array.isArray(input.lists)) {
    const lists = { ...(session.doc.settings.lists ?? {}) }
    for (const [key, config] of Object.entries(input.lists)) {
      if (config && typeof config === 'object') lists[key] = { ...lists[key], ...config }
    }
    if (Object.keys(input.lists).length > 0) session.doc.settings.lists = lists
  }
  if ('blacklist' in input) {
    session.doc.settings.blacklist = Array.isArray(input.blacklist)
      ? input.blacklist.map((item) => String(item))
      : null
  }
  // ② 账号字段：trim 后写入；任一变化作废解密缓存
  let accountChanged = false
  for (const key of ['cookiecloud_url', 'cookiecloud_uuid', 'cookiecloud_key', 'manual_cookie']) {
    if (typeof input[key] === 'string') {
      const trimmed = input[key].trim()
      if (trimmed !== session.doc.settings[key]) accountChanged = true
      session.doc.settings[key] = trimmed
      flat[key] = trimmed
    }
  }
  if (accountChanged) {
    session.doc.cookie = { header: '', uid: '', source: '', fetched_at: '' }
    session.markAccountDirty()
  }
  if (typeof input.wish_sync_enabled === 'boolean') {
    session.doc.settings.wish_sync_enabled = input.wish_sync_enabled
    flat.wish_sync_enabled = input.wish_sync_enabled
    if (input.wish_sync_enabled) session.markAccountDirty()
  }
  // ③ 过滤器三项（负数/越界当脏数据忽略 —— runtime.rs 的契约）
  if (typeof input.min_rating === 'number' && Number.isFinite(input.min_rating) && input.min_rating >= 0) {
    flat.min_rating = input.min_rating
  }
  if (typeof input.min_year === 'number' && Number.isFinite(input.min_year) && input.min_year >= 0 && input.min_year <= 2_147_483_647) {
    flat.min_year = Math.trunc(input.min_year)
  }
  if ('regions' in input) {
    const regions = Array.isArray(input.regions)
      ? input.regions.map((item) => String(item).trim()).filter((item) => item !== '')
      : null
    session.doc.settings.regions = regions
    flat.regions = regions ?? []
  }
  if ('subscribe_source_filter' in input) {
    const sources = Array.isArray(input.subscribe_source_filter)
      ? input.subscribe_source_filter.map((item) => String(item))
      : null
    session.doc.settings.subscribe_source_filter = sources
    flat.subscribe_source_filter = sources ?? []
  }
  if (typeof input.observe_period_hours === 'number' && Number.isFinite(input.observe_period_hours)) {
    flat.observe_period_hours = Math.trunc(input.observe_period_hours)
  }
  if (typeof input.auto_subscribe === 'boolean') flat.auto_subscribe = input.auto_subscribe
  if (typeof input.notify_on_subscribe === 'boolean') flat.notify_on_subscribe = input.notify_on_subscribe
  if (typeof input.max_history === 'number' && Number.isFinite(input.max_history)) flat.max_history = Math.trunc(input.max_history)
  if (typeof input.max_logs === 'number' && Number.isFinite(input.max_logs)) flat.max_logs = Math.trunc(input.max_logs)

  // ④ 保存扁平设置到 settings KV（CAS 读改写；失败不阻断状态文档落盘）
  const savedResult = await persistFlatSettings(session, flat)
  session.doc.settings = normalizeDocSettings(session.doc.settings)
  await session.persist()
  session.bump('succeeded', '设置已保存')
  return { status: 'succeeded', message: '设置已保存', settings_saved: savedResult.ok, settings_error: savedResult.message ?? null }
}

/** settings KV 的读改写（settings 键保存在插件 KV，ctx.settings.get() 会叠加清单默认值）。 */
export async function persistFlatSettings(session, flat) {
  const path = `/api/extensions/v3/${encodeURIComponent(session.ctxId)}/storage/settings`
  const current = await tryApi(session.ctx, 'GET', path)
  let saved = {}
  let expected = null
  if (current.ok) {
    saved = current.data?.value ?? {}
    expected = typeof current.data?.revision === 'number' ? current.data.revision : null
  } else if (current.status !== 404) {
    return { ok: false, message: current.message }
  }
  const next = applyFlatPatch(saved, {
    wish_sync_enabled: flat.wish_sync_enabled,
    manual_cookie: flat.manual_cookie,
    cookiecloud_url: flat.cookiecloud_url,
    cookiecloud_uuid: flat.cookiecloud_uuid,
    cookiecloud_key: flat.cookiecloud_key,
    observe_period_hours: flat.observe_period_hours,
    auto_subscribe: flat.auto_subscribe,
    notify_on_subscribe: flat.notify_on_subscribe,
    min_rating: flat.min_rating,
    min_year: flat.min_year,
    regions: (flat.regions ?? []).join(','),
    subscribe_source_filter: (flat.subscribe_source_filter ?? []).join(','),
    max_history: flat.max_history,
    max_logs: flat.max_logs,
  })
  const put = await tryApi(session.ctx, 'PUT', path, { value: next, expected_revision: expected ?? 0 })
  if (!put.ok && (put.status === 409 || put.status === 412)) {
    // 冲突：重读后按保存值优先重放一次
    const fresh = await tryApi(session.ctx, 'GET', path)
    if (fresh.ok) {
      const merged = { ...applyFlatPatch(fresh.data?.value ?? {}, {}) }
      Object.assign(merged, next)
      const retry = await tryApi(session.ctx, 'PUT', path, {
        value: merged,
        expected_revision: typeof fresh.data?.revision === 'number' ? fresh.data.revision : 0,
      })
      if (retry.ok) return { ok: true }
    }
  }
  if (!put.ok) return { ok: false, message: put.message }
  return { ok: true }
}

/** action archive：清历史/日志/黑名单命中，重置统计（明确不清 no_resub 墓碑集）。 */
export function archive(session) {
  session.doc.history = null
  session.doc.logs = null
  session.doc.blackstate = { keywords: session.doc.blackstate.keywords, hits: 0, recent: null }
  session.doc.stats = { total: 0, month_new: 0, month: '', by_list: {}, last_archive_at: nowRfc3339() }
  session.bump('succeeded', '已归档历史与日志')
  return { status: 'succeeded', message: '已归档历史与日志' }
}

/** action send-test：v3 通知通道可用，恢复实现（旧版宿主拒绝插件通知 payload）。 */
export async function sendTest(session, ctx) {
  try {
    const result = await ctx.notify({
      title: '豆瓣中心通知自检',
      body: '这是一条测试通知：如果你看到了它，说明通知渠道配置正常。',
      level: 'info',
      dedupe_key: 'douban.rs:send-test',
    })
    const accepted = result?.accepted === true
    const delivered = Array.isArray(result?.deliveries)
      ? result.deliveries.filter((delivery) => delivery?.status === 'sent').length
      : 0
    const message = accepted
      ? `测试通知已提交（送达 ${delivered} 个渠道${result?.deduplicated ? '，命中去重' : ''}）`
      : '通知未被宿主接受（可能未配置通知渠道）'
    return { status: accepted ? 'succeeded' : 'failed', message, notify: result ?? null }
  } catch (error) {
    const message = `通知发送失败: ${error?.message ?? String(error)}`
    session.log('warning', message)
    return { status: 'failed', message }
  }
}
