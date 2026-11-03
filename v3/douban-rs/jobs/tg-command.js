// Telegram 指令 —— 清单 events[] 里 {event:'message', commands:['refresh','wish'],
// channels:['telegram']} 的落地任务。channels 限 telegram（messaging.md：省略则全部
// 渠道都分发）：回执走 ctx.messaging.reply，需要来源渠道对应的权限（telegram.bot），
// 企业微信侧发 /refresh、/wish 只会静默无回执，不放开。
//
// 宿主把命中的消息投影投递给本任务（messaging.md 的任务输入）：
// {channel, chat_id, chat_type, user_id, username, message_id, text, date, trigger}。
// - /refresh → 复用 refresh-charts 编排（refreshNow deep=true：抓榜 → 黑名单入队 →
//   到期订阅 → 想看同步 → 落盘）；
// - /wish    → 复用 wish-sync 编排（runWishSyncJob：想看同步 → 到期订阅 → 墓碑判定 → 落盘）。
//
// 回执走 ctx.messaging.reply（来源渠道自动回复；需用户授权 telegram.bot——命令触发
// 本身不需要授权，但回复需要）。回复失败不影响业务结果，执行结论仍进任务记录。
// 成功/失败如实回执；回复与日志只带业务摘要，绝不含 Cookie 等凭据。
// 中断恢复与 refresh-charts / wish-sync 相同：recover 复用 recoverSubscribe(batch)，
// 先核对宿主订阅池的真实状态再决定 complete / resume / attention。

import { Session } from './runtime.js'
import { refreshNow } from './charts.js'
import { runWishSyncJob } from './wish.js'
import { recoverSubscribe } from './subscribe-engine.js'
import { taskCheckpoint, taskUpdate } from './task.js'

/** 本任务响应的指令集合（与清单 events[].commands 一致）。 */
const COMMANDS = new Set(['refresh', 'wish'])

/**
 * 解析消息文本里的指令：取首个空白分隔的 token，`/refresh`、`/refresh@some_bot`
 * 都认（Telegram 命令常带 bot 后缀），大小写不敏感；其余返回空串。
 */
export function parseCommand(text) {
  const first = String(text ?? '').trim().split(/\s+/)[0] ?? ''
  const match = /^\/([A-Za-z0-9_]+)(@[A-Za-z0-9_]+)?$/.exec(first)
  if (!match) return ''
  return match[1].toLowerCase()
}

/** Telegram 单条消息上限 4096 字；回执留余量截断。 */
const MAX_REPLY_CHARS = 4000

/** 回执文本按 Telegram 上限截断（超长时末尾补省略号）。 */
export function clipReply(text) {
  const body = String(text ?? '')
  return body.length > MAX_REPLY_CHARS ? `${body.slice(0, MAX_REPLY_CHARS - 1)}…` : body
}

/** messaging.reply 回执：吞错（未授权/渠道失败不影响业务结果）。 */
async function reply(session, ctx, input, text) {
  try {
    await ctx.messaging?.reply?.(input, { text: clipReply(text) })
  } catch (error) {
    session.log('warning', `TG 回执发送失败: ${error?.message ?? error}`)
  }
}

export async function run(ctx, input) {
  const message = input && typeof input === 'object' ? input : {}
  const session = await Session.open(ctx)
  const command = parseCommand(message.text)
  if (!COMMANDS.has(command)) {
    return { status: 'succeeded', handled: false, message: `未识别的指令：${command || '(空)'}` }
  }
  const invocationId = ctx.task?.id ?? `tg-${command}`
  const started =
    command === 'refresh'
      ? '开始刷新榜单（抓榜 + 到期订阅 + 想看同步），完成后回执'
      : '开始同步「我的想看」并处理到期条目，完成后回执'
  await taskUpdate(ctx, { title: `TG 指令 /${command}`, stage: 'running', message: started })
  await reply(session, ctx, message, started)
  try {
    if (command === 'refresh') {
      const result = await refreshNow(session, ctx, invocationId, { deep: true })
      await taskCheckpoint(ctx, { stage: 'completed', result })
      await taskUpdate(ctx, { stage: 'done', message: result.message, progress: 100 })
      await reply(session, ctx, message, result.message)
      return {
        status: 'succeeded',
        message: result.message,
        subscribed: result.subscribed,
        needs_review: result.needs_review,
      }
    }
    const result = await runWishSyncJob(session, ctx, invocationId)
    await taskCheckpoint(ctx, { stage: 'completed', result })
    // runWishSyncJob 总返回 accepted；想看是否真的同步成功要看 wish_info.last_status
    const info = session.doc.wish_info ?? {}
    let receipt = result.message
    if (info.last_status === 'succeeded') {
      receipt = `想看同步完成：共 ${info.last_count ?? 0} 条，新增 ${info.last_new ?? 0}；${result.message}`
    } else if (info.last_status === 'failed') {
      receipt = `想看同步失败：${info.last_error || '原因未知'}；${result.message}`
    }
    await taskUpdate(ctx, { stage: 'done', message: receipt, progress: 100 })
    await reply(session, ctx, message, receipt)
    return { status: 'succeeded', message: receipt, wish_status: info.last_status ?? '' }
  } catch (error) {
    const failed = `/${command} 执行失败: ${error?.message ?? error}`
    session.log('error', failed)
    await session.persist()
    await taskUpdate(ctx, { stage: 'failed', message: failed })
    await reply(session, ctx, message, failed)
    return { status: 'failed', message: failed }
  }
}

export async function recover(ctx, checkpoint) {
  return recoverSubscribe(ctx, checkpoint, { batch: true })
}
