// TG 命令与每日日报测试 —— 假 ctx 覆盖：
// - 命令解析（/music 队列、/queue、/status、未知子命令、非命令文本）；
// - ctx.messaging.reply 按来源渠道回复（input 原样透传），未授权抛错时回退 ctx.notify
//   （dedupe_key = chat_id + message_id 两个事件自带的不变事实）；
// - 只读约束：不发 HTTP、不改任务索引；
// - daily-report：索引统计（done/failed/queued、今日完成/失败）、稳定 dedupe_key、
//   写操作前后检查点。
import test from 'node:test'
import assert from 'node:assert/strict'
import { run as runTgCommand, parseCommand } from '../../music-rs/jobs/tg-command.js'
import { run as runDailyReport, dailyReportKey } from '../../music-rs/jobs/daily-report.js'

// ─────────────────────────── 假宿主 ───────────────────────────

function makeHost({ replyError = null, notifyError = null } = {}) {
  const kvStore = new Map()
  const calls = { reply: [], notify: [], http: [], checkpoints: [] }

  const storage = {
    async get(key) {
      const hit = kvStore.get(key)
      if (!hit) throw Object.assign(new Error('not found'), { status: 404 })
      return JSON.parse(JSON.stringify(hit.value))
    },
    async set(key, value) {
      kvStore.set(key, { value: JSON.parse(JSON.stringify(value)), revision: (kvStore.get(key)?.revision ?? 0) + 1 })
      return { revision: kvStore.get(key).revision }
    },
    async remove(key) {
      if (!kvStore.has(key)) throw Object.assign(new Error('not found'), { status: 404 })
      kvStore.delete(key)
    },
    async list() { return [] },
  }

  const ctx = {
    id: 'music.rs',
    plugin: { id: 'music.rs', name: '音乐下载', version: '1.2.2', generation: 'g', revision: 'r', host_api: '3.9' },
    storage,
    api: {
      async get(path) {
        const key = decodeURIComponent(path.replace(/^\/api\/extensions\/v3\/music\.rs\/storage\//, ''))
        const hit = kvStore.get(key)
        if (!hit) throw Object.assign(new Error('not found'), { status: 404 })
        return { value: JSON.parse(JSON.stringify(hit.value)), revision: hit.revision }
      },
    },
    settings: {
      async get() {
        const hit = kvStore.get('settings')
        return hit ? JSON.parse(JSON.stringify(hit.value)) : {}
      },
    },
    http: {
      async request(options) {
        calls.http.push(options)
        throw new Error('TG 命令是只读的, 不应该发 HTTP 请求')
      },
    },
    messaging: {
      async reply(input, options) {
        calls.reply.push({ input, options })
        if (replyError) throw new Error(replyError)
        return { ok: true }
      },
    },
    notify: async (options) => {
      calls.notify.push(options)
      if (notifyError) throw new Error(notifyError)
      return { accepted: true, deliveries: [{ channel: 'telegram', status: 'sent' }] }
    },
    task: {
      async update() {},
      async log() {},
      async checkpoint(value) { calls.checkpoints.push(value) },
      id: 'task-daily',
    },
  }
  return { ctx, kvStore, calls }
}

/** 种一条索引条目（tg-command / daily-report 只读 tasks.idx，不需要 task.<id> 分片）。 */
function seedEntry({ id, status, name = '晴天', singers = '周杰伦', quality = 'jymaster', error = '', updatedMsAgo = 0 }, now) {
  return {
    id, status, source: 'netease', song_id: id, name, singers, quality, error,
    updated_ms: updatedMsAgo === 0 ? now.getTime() : now.getTime() - updatedMsAgo,
  }
}

function messageInput(text, { chatId = 123456789, messageId = 42 } = {}) {
  return {
    channel: 'telegram',
    chat_id: chatId,
    chat_type: 'private',
    chat_title: '',
    user_id: chatId,
    username: 'alice',
    message_id: messageId,
    message_thread_id: 0,
    text,
    date: Math.floor(Date.now() / 1000),
    trigger: { type: 'command', value: text.split(/\s+/)[0] },
  }
}

// ─────────────────────────── 命令解析 ───────────────────────────

test('parseCommand: 入口命令 + 子命令 / 直连命令 / 未知与噪声都落到帮助', () => {
  assert.deepEqual(parseCommand('/music 队列'), { action: 'music', sub: 'queue' })
  assert.deepEqual(parseCommand('/music status'), { action: 'music', sub: 'status' })
  assert.deepEqual(parseCommand('/music 帮助'), { action: 'music', sub: 'help' })
  assert.deepEqual(parseCommand('/音乐 状态'), { action: 'music', sub: 'status' })
  assert.deepEqual(parseCommand('/music'), { action: 'music', sub: 'help' }, '裸 /music 给帮助')
  assert.deepEqual(parseCommand('/music 搜索 周杰伦'), { action: 'music', sub: 'help' }, '未知子命令不给写操作, 落帮助')
  assert.deepEqual(parseCommand('/queue'), { action: 'queue', sub: '' })
  assert.deepEqual(parseCommand('/status'), { action: 'status', sub: '' })
  assert.deepEqual(parseCommand('/队列'), { action: 'queue', sub: '' })
  assert.deepEqual(parseCommand('/别的东西'), { action: 'help', sub: '' })
  assert.deepEqual(parseCommand('早上好'), { action: 'help', sub: '' }, '非命令文本不解析')
})

// ─────────────────────────── 回复与只读 ───────────────────────────

test('/music 队列: messaging.reply 按来源渠道回复, input 原样透传', async () => {
  const host = makeHost()
  const now = new Date()
  await host.ctx.storage.set('tasks.idx', [
    seedEntry({ id: 'aaaa11', status: 'queued', name: '晴天' }, now),
    seedEntry({ id: 'bbbb22', status: 'downloading', name: '修炼爱情', singers: '林俊杰' }, now),
    seedEntry({ id: 'cccc33', status: 'failed', name: '红豆', singers: '王菲', error: '下载失败: HTTP 403' }, now),
    seedEntry({ id: 'dddd44', status: 'done', name: '旧歌' }, now),
  ])
  const snapshot = JSON.stringify(await host.ctx.storage.get('tasks.idx'))
  const input = messageInput('/music 队列')
  const outcome = await runTgCommand(host.ctx, input)
  assert.equal(outcome.handled, true)
  assert.equal(outcome.replied, true)
  assert.equal(outcome.via, 'messaging')
  assert.equal(host.calls.reply.length, 1)
  assert.equal(host.calls.reply[0].input, input, 'input 直接透传（reply 按来源渠道路由）')
  const text = host.calls.reply[0].options.text
  assert.match(text, /排队 1 · 进行中 1 · 完成 1 · 失败 1/)
  assert.match(text, /周杰伦 - 晴天/)
  assert.match(text, /林俊杰 - 修炼爱情/)
  assert.match(text, /王菲 - 红豆/)
  assert.match(text, /HTTP 403/)
  assert.equal(host.calls.notify.length, 0, '回复成功时不发普通通知')
  // 只读：索引原样，没有发任何 HTTP 请求。
  assert.equal(JSON.stringify(await host.ctx.storage.get('tasks.idx')), snapshot)
  assert.equal(host.calls.http.length, 0)
})

test('/status: 统计 + 今日口径 + 设置摘要 + 上次推进', async () => {
  const host = makeHost()
  const now = new Date()
  await host.ctx.storage.set('tasks.idx', [
    seedEntry({ id: 'aaaa11', status: 'done', name: '今日完成' }, now),
    seedEntry({ id: 'bbbb22', status: 'done', name: '三天前完成', updatedMsAgo: 3 * 86400_000 }, now),
    seedEntry({ id: 'cccc33', status: 'queued', name: '排队中' }, now),
  ])
  await host.ctx.storage.set('state', { last_pump: { queued: 1, active: 0, at: '2026-11-03T00:05:00Z' } })
  const outcome = await runTgCommand(host.ctx, messageInput('/status'))
  assert.equal(outcome.action, 'status')
  const text = host.calls.reply[0].options.text
  assert.match(text, /排队 1 · 下载中 0 · 入库中 0 · 完成 2 · 失败 0/)
  assert.match(text, /今日: 完成 1 · 失败 0/, '今日口径只数今天收尾的任务')
  assert.match(text, /目标目录 /)
  assert.match(text, /上次推进: 2026-11-03T00:05:00Z/)
})

test('裸 /queue 等价 /music 队列; 未注册的中文别名也按解析结果回复', async () => {
  const host = makeHost()
  const outcome = await runTgCommand(host.ctx, messageInput('/queue'))
  assert.equal(outcome.action, 'queue')
  assert.match(host.calls.reply[0].options.text, /队列空闲/)
})

test('/music 裸命令与未知子命令 → 帮助文本', async () => {
  const host = makeHost()
  await runTgCommand(host.ctx, messageInput('/music'))
  assert.match(host.calls.reply[0].options.text, /\/music 队列/)
  assert.match(host.calls.reply[0].options.text, /只读查询/)
  await runTgCommand(host.ctx, messageInput('/music 搜索 周杰伦', { messageId: 43 }))
  assert.match(host.calls.reply[1].options.text, /\/music 队列/)
})

test('messaging.reply 未授权抛错 → 回退 ctx.notify, dedupe_key 用事件自带的不变事实', async () => {
  const host = makeHost({ replyError: 'permission telegram.bot is not granted' })
  const input = messageInput('/music 队列', { chatId: 42, messageId: 7 })
  const outcome = await runTgCommand(host.ctx, input)
  assert.equal(outcome.via, 'notify')
  assert.equal(outcome.replied, true)
  assert.equal(host.calls.reply.length, 1)
  assert.equal(host.calls.notify.length, 1)
  const notification = host.calls.notify[0]
  assert.equal(notification.level, 'info')
  assert.equal(notification.dedupe_key, 'music:tg-reply:42:7', 'chat_id + message_id：同一条消息重投同键同内容直接去重')
  assert.match(notification.body, /队列/)
})

test('reply 与 notify 都失败 → 不抛错, 如实返回 replied=false', async () => {
  const host = makeHost({ replyError: 'not granted', notifyError: 'telegram not configured' })
  const outcome = await runTgCommand(host.ctx, messageInput('/status'))
  assert.equal(outcome.via, 'none')
  assert.equal(outcome.replied, false)
  assert.match(outcome.reply_error, /not granted/)
  assert.match(outcome.notify_error, /not configured/)
})

// ─────────────────────────── 每日日报 ───────────────────────────

test('daily-report: 统计任务索引并发 TG 日报, dedupe_key 按天稳定', async () => {
  const host = makeHost()
  const now = new Date()
  await host.ctx.storage.set('tasks.idx', [
    seedEntry({ id: 'aaaa11', status: 'done', name: '晴天' }, now),
    seedEntry({ id: 'bbbb22', status: 'done', name: '修炼爱情', singers: '林俊杰' }, now),
    seedEntry({ id: 'cccc33', status: 'done', name: '三天前的旧账', updatedMsAgo: 3 * 86400_000 }, now),
    seedEntry({ id: 'dddd44', status: 'failed', name: '红豆', singers: '王菲', error: '下载失败: HTTP 403' }, now),
    seedEntry({ id: 'eeee55', status: 'queued', name: '排队中' }, now),
  ])
  const outcome = await runDailyReport(host.ctx)
  // 统计口径：done 3（今日 2）、failed 1（今日 1）、queued 1、active 0。
  assert.deepEqual(outcome.stats, {
    total: 5, done: 3, failed: 1, queued: 1, active: 0,
    done_today: ['周杰伦 - 晴天', '林俊杰 - 修炼爱情'],
    failed_today: ['王菲 - 红豆'],
  })
  assert.equal(outcome.accepted, true)
  assert.equal(host.calls.notify.length, 1)
  const notification = host.calls.notify[0]
  assert.equal(notification.level, 'info')
  assert.deepEqual(notification.channels, ['telegram'], '日报只发 TG')
  assert.equal(notification.dedupe_key, dailyReportKey())
  assert.match(notification.dedupe_key, /^music:daily-report:\d{4}-\d{2}-\d{2}$/)
  assert.match(notification.title, new RegExp(notification.dedupe_key.split(':')[2]))
  assert.match(notification.body, /完成 3 · 失败 1 · 排队 1 · 进行中 0/)
  assert.match(notification.body, /今日: 完成 2 · 失败 1/)
  assert.match(notification.body, /周杰伦 - 晴天、林俊杰 - 修炼爱情/)
  assert.match(notification.body, /王菲 - 红豆/)
  assert.doesNotMatch(notification.body, /三天前的旧账/, '旧账不进今日清单')
  // 外部写（notify）前后各一个检查点，dedupe_key 留档可核对。
  const stages = host.calls.checkpoints.map((c) => c.stage)
  assert.deepEqual(stages, ['before-report', 'after-report'])
  assert.equal(host.calls.checkpoints[0].dedupe_key, notification.dedupe_key)
  assert.equal(host.calls.checkpoints[1].accepted, true)
})

test('daily-report: 同一天重跑 dedupe_key 不变（同键同内容去重, 不会重复打扰）', async () => {
  const host = makeHost()
  await host.ctx.storage.set('tasks.idx', [])
  const first = await runDailyReport(host.ctx)
  const second = await runDailyReport(host.ctx)
  assert.equal(first.dedupe_key, second.dedupe_key)
  assert.equal(first.dedupe_key, dailyReportKey())
  assert.match(host.calls.notify[1].body, /暂无下载任务/, '空索引也有日报（全部为 0）')
  assert.equal(host.calls.notify.length, 2)
  assert.equal(host.calls.notify[0].dedupe_key, host.calls.notify[1].dedupe_key)
})

test('daily-report: notify 抛错不拖垮任务, notify_error 记进检查点与返回值', async () => {
  const host = makeHost({ notifyError: '所有渠道都发送失败: Telegram 拒绝消息（400）' })
  await host.ctx.storage.set('tasks.idx', [])
  const outcome = await runDailyReport(host.ctx)
  assert.equal(outcome.accepted, false)
  assert.equal(outcome.deduplicated, false)
  assert.equal(outcome.suppressed, false)
  assert.match(outcome.notify_error, /所有渠道都发送失败/)
  const after = host.calls.checkpoints.find((c) => c.stage === 'after-report')
  assert.ok(after, '写后检查点仍要落盘')
  assert.equal(after.accepted, false)
  assert.match(after.notify_error, /所有渠道都发送失败/)
})
