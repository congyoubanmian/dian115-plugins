// Telegram 查询命令（清单 event=message → job tg-command）。
//
// 命令面（只读 —— 不入队、不重试、不删除、不发任何下载请求）：
//   /music 队列 | /queue   查看下载队列（进行中 / 排队 / 最近失败）
//   /music 状态 | /status  查看队列统计、今日完成与设置摘要
//   /music 帮助  （默认）   显示可用命令
//
// 回复用 ctx.messaging.reply(input, …)：按消息来源渠道自动路由（messaging.md §回复）。
// commands 触发不需要 telegram.bot 授权，但回复需要 —— 未授权（或其它原因）抛错时
// 回退 ctx.notify 发普通通知；回退通知的 dedupe_key 取「chat_id + message_id」这两
// 个事件自带的不变事实，同一条消息重复投递会命中同键同内容直接去重，不引入时间戳。
//
// 回复文本只包含任务名/歌手/状态/设置等用户自己的业务数据，不包含 Cookie、
// 登录凭据或渠道配置（本 job 也不读 lib/cookies.js 的任何内容）。

import { buildDeps, readSettings } from './runtime.js'
import { loadIndex } from '../lib/queue-store.js'
import { displayName, STATUS_QUEUED, STATUS_DOWNLOADING, STATUS_COPYING, STATUS_DONE, STATUS_FAILED } from '../lib/tasks-core.js'
import { addLog } from '../lib/logs.js'
import { nowRfc3339, startOfLocalDay } from '../lib/encoding.js'

/** 回复文本上限（Telegram 单条 ≤4096 字，留出余量）。 */
const REPLY_TEXT_LIMIT = 3800
/** 队列视图里每段最多列出的条数。 */
const QUEUE_SECTION_LIMIT = 8
/** 失败条目里错误摘要的长度。 */
const ERROR_SNIPPET_LIMIT = 80

/** 触发词 → 动作：music/音乐 是带子命令的入口，其余直接映射。 */
const COMMAND_ALIASES = new Map([
  ['music', 'music'],
  ['音乐', 'music'],
  ['queue', 'queue'],
  ['队列', 'queue'],
  ['status', 'status'],
  ['状态', 'status'],
])

/** 子命令 → 动作（/music 之后的第一个词；缺省为帮助）。 */
const SUBCOMMAND_ALIASES = new Map([
  ['queue', 'queue'],
  ['队列', 'queue'],
  ['status', 'status'],
  ['状态', 'status'],
  ['help', 'help'],
  ['帮助', 'help'],
])

const STATUS_LABELS = {
  [STATUS_QUEUED]: '排队',
  [STATUS_DOWNLOADING]: '下载中',
  [STATUS_COPYING]: '入库中',
  [STATUS_DONE]: '完成',
  [STATUS_FAILED]: '失败',
}

/**
 * 解析消息文本为动作。返回 `{action, sub}`：
 * - entry（music/音乐）→ action='music'，sub 为队列/状态/帮助（未知子命令也归为帮助）；
 * - 直连命令（queue/队列/status/状态）→ action 同名，sub='';
 * - 解析不出来 → action='help'（宁可多解释，不静默）。
 */
export function parseCommand(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed.startsWith('/')) return { action: 'help', sub: '' }
  const tokens = trimmed.slice(1).trim().split(/\s+/).filter(Boolean)
  // 群聊里 Telegram 会把命令写成 `/music@机器人名`：去掉 @ 后缀再匹配。
  const head = (tokens.shift() ?? '').replace(/@[\w.-]*$/, '')
  const action = COMMAND_ALIASES.get(head) ?? COMMAND_ALIASES.get(head.toLowerCase())
  if (!action) return { action: 'help', sub: '' }
  if (action !== 'music') return { action, sub: '' }
  const subRaw = (tokens.shift() ?? '').toLowerCase()
  return { action: 'music', sub: SUBCOMMAND_ALIASES.get(subRaw) ?? 'help' }
}

/** 「今日 0 点」（lib/encoding.js 的共享口径，TG 状态与每日日报一致）。 */
const startOfToday = startOfLocalDay

/** 截断到指定字符数（按码点，避免截半个 emoji）。 */
function truncate(text, limit) {
  const chars = [...String(text ?? '')]
  return chars.length <= limit ? chars.join('') : `${chars.slice(0, limit).join('')}…`
}

/** 索引条目的一行展示：`歌手 - 歌名`（缺歌手时只用歌名）。 */
function lineOf(entry, extra = '') {
  const label = displayName(entry) || entry.id
  return extra ? `• ${label}（${extra}）` : `• ${label}`
}

/** 队列视图：进行中 / 排队 / 最近失败三段 + 计数头。 */
function queueText(index) {
  const active = index.filter((entry) => entry.status === STATUS_DOWNLOADING || entry.status === STATUS_COPYING)
  const queued = index.filter((entry) => entry.status === STATUS_QUEUED)
  const failed = index.filter((entry) => entry.status === STATUS_FAILED)
  const done = index.filter((entry) => entry.status === STATUS_DONE)
  const lines = [
    `🎵 音乐下载队列（排队 ${queued.length} · 进行中 ${active.length} · 完成 ${done.length} · 失败 ${failed.length}）`,
  ]
  if (active.length > 0) {
    lines.push('🚿 进行中:')
    for (const entry of active.slice(0, QUEUE_SECTION_LIMIT)) {
      lines.push(lineOf(entry, `${STATUS_LABELS[entry.status] ?? entry.status} · ${entry.quality}`))
    }
  }
  if (queued.length > 0) {
    lines.push('⏳ 排队:')
    for (const entry of queued.slice(0, QUEUE_SECTION_LIMIT)) {
      lines.push(lineOf(entry, `${entry.quality}`))
    }
    if (queued.length > QUEUE_SECTION_LIMIT) lines.push(`… 还有 ${queued.length - QUEUE_SECTION_LIMIT} 首`)
  }
  if (failed.length > 0) {
    lines.push('❌ 最近失败（点失败通知里的「重试」按钮可重新排队）:')
    for (const entry of failed.slice(0, QUEUE_SECTION_LIMIT)) {
      lines.push(lineOf(entry, truncate(entry.error, ERROR_SNIPPET_LIMIT)))
    }
    if (failed.length > QUEUE_SECTION_LIMIT) lines.push(`… 还有 ${failed.length - QUEUE_SECTION_LIMIT} 条`)
  }
  if (active.length + queued.length === 0) lines.push('队列空闲，没有进行中或排队的任务。')
  return lines.join('\n')
}

/** 状态视图：状态计数 + 今日完成/失败 + 设置摘要 + 上次推进。 */
async function statusText(deps, index) {
  const count = (status) => index.filter((entry) => entry.status === status).length
  const todayStart = startOfToday()
  const doneToday = index.filter((entry) => entry.status === STATUS_DONE && Number(entry.updated_ms ?? 0) >= todayStart)
  const failedToday = index.filter((entry) => entry.status === STATUS_FAILED && Number(entry.updated_ms ?? 0) >= todayStart)
  const settings = await readSettings(deps.ctx)
  const lines = [
    '📊 音乐下载状态',
    `队列: 排队 ${count(STATUS_QUEUED)} · 下载中 ${count(STATUS_DOWNLOADING)} · 入库中 ${count(STATUS_COPYING)} · 完成 ${count(STATUS_DONE)} · 失败 ${count(STATUS_FAILED)}`,
    `今日: 完成 ${doneToday.length} · 失败 ${failedToday.length}`,
    `设置: 目标目录 ${settings.target_dir} · 音质 ${settings.quality} · 单轮并发 ${settings.max_active}`,
  ]
  // 上次推进摘要（queue-pump 落盘的 KV state.last_pump；读不到就跳过这段）。
  try {
    const state = await deps.kv.get('state')
    const lastPump = state && typeof state === 'object' ? state.last_pump : null
    if (lastPump && typeof lastPump === 'object') {
      lines.push(`上次推进: ${String(lastPump.at ?? '?')}（排队 ${Number(lastPump.queued ?? 0)} · 进行中 ${Number(lastPump.active ?? 0)}）`)
    }
  } catch {
    /* state 读不到不影响状态回复 */
  }
  return lines.join('\n')
}

/** 帮助视图。 */
function helpText() {
  return [
    '🎵 音乐下载命令（只读查询）:',
    '/music 队列 — 查看下载队列',
    '/music 状态 — 查看统计、今日完成与设置',
    '/music 帮助 — 显示本帮助',
    '/queue、/status 分别等价于 /music 队列、/music 状态',
    '入队与重试在插件页面或失败通知的「重试」按钮里操作。',
  ].join('\n')
}

/** 事件里的 id 字段（字符串或数字）→ 字符串；缺失/空 → ''。 */
function idOf(value) {
  return (typeof value === 'string' || typeof value === 'number') && String(value) !== '' ? String(value) : ''
}

/** 回退通知的 dedupe_key：同一条消息（chat_id + message_id）重投同键。
 *  事件缺 id 时不能退化成共享的常量键（不同消息、不同正文撞同键会被宿主判冲突），
 *  改用本次任务 id，保证一条消息一个键。 */
export function replyDedupeKey(input, taskId = '') {
  const chatId = idOf(input?.chat_id)
  const messageId = idOf(input?.message_id)
  if (chatId && messageId) return `music:tg-reply:${chatId}:${messageId}`
  return `music:tg-reply:task:${idOf(taskId) || Date.now()}`
}

/** 发回复：先走来源渠道（messaging.reply），失败回退普通通知。 */
async function replyOutcome(deps, input, text) {
  const body = truncate(text, REPLY_TEXT_LIMIT)
  try {
    if (typeof deps.messaging?.reply !== 'function') throw new Error('宿主未提供 ctx.messaging（需要 API 3.6）')
    await deps.messaging.reply(input, { text: body })
    return { via: 'messaging' }
  } catch (error) {
    // 未授权 / 限流 / 渠道异常 → 回退 ctx.notify（dedupe_key 用事件自带的不变事实）。
    try {
      await deps.notify({
        level: 'info',
        title: '音乐下载命令回复',
        body,
        dedupe_key: replyDedupeKey(input, deps.ctx?.task?.id),
      })
      return { via: 'notify', reply_error: String(error?.message ?? error) }
    } catch (notifyError) {
      return { via: 'none', reply_error: String(error?.message ?? error), notify_error: String(notifyError?.message ?? notifyError) }
    }
  }
}

/** 消息事件入口（清单 event=message, job=tg-command）。 */
export async function run(ctx, input) {
  const deps = buildDeps(ctx)
  const message = input && typeof input === 'object' ? input : {}
  const { action, sub } = parseCommand(message.text)
  // 入口命令（music/音乐）用子命令，直连命令用动作本身。
  const effective = action === 'music' ? sub : action
  const index = await loadIndex(deps.kv)
  let text
  if (effective === 'queue') text = queueText(index)
  else if (effective === 'status') text = await statusText(deps, index)
  else text = helpText()

  const outcome = await replyOutcome(deps, message, text)
  // 回复已发出：日志写失败（KV 冲突/限流）不能让任务失败，否则宿主重跑会重复回复。
  try {
    await addLog(deps.kv, 'info', `TG 命令 ${effective} · 回复渠道: ${outcome.via}`)
  } catch {
    /* 日志只是留档 */
  }
  return {
    handled: true,
    action: effective,
    replied: outcome.via !== 'none',
    via: outcome.via,
    at: nowRfc3339(),
    ...(outcome.reply_error ? { reply_error: outcome.reply_error } : {}),
    ...(outcome.notify_error ? { notify_error: outcome.notify_error } : {}),
  }
}
