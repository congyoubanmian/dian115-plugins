// 任务队列的核心常量与纯函数 —— 从 plugins/music-rs/src/tasks.rs 移植。
// （KV 分片读写在 lib/queue-store.js；pump 状态机在 lib/pump.js。）

import { trunc } from './encoding.js'

/** 旧版单键队列（KV tasks）。v3 全新安装没有旧键，仅为键名守卫保留。 */
export const TASKS_KEY = 'tasks'
/** 队列索引键（KV tasks.idx）：紧凑数组，UI 的唯一数据源。 */
export const TASKS_IDX_KEY = 'tasks.idx'
/** 单条完整任务记录的键前缀（KV task.<id>）。分隔符是 `.` 不是 `:`：
 *  宿主 storage 键有正则约束 `^[A-Za-z0-9](?:[A-Za-z0-9]|[._-](?=[A-Za-z0-9]))*$`。 */
export const TASK_KEY_PREFIX = 'task.'

/** 索引里 error 字段的字节上限（120B）：索引必须比完整记录小一个数量级。 */
export const IDX_ERROR_LIMIT = 120

/** state 响应里返回的任务条数上限（最近 200 条）。 */
export const STATE_TASKS_LIMIT = 200

/** 单次下载的最大尝试次数（失败重试 ≤3）。 */
export const MAX_ATTEMPTS = 3

/** 短 id 最大长度（Telegram callback_data 限 32 字节，`retry:<id>` 必须放得下）。 */
export const MAX_TASK_ID_LEN = 8

/** 重试按钮的 callback_data 前缀。 */
export const RETRY_PREFIX = 'retry:'

// 任务状态
export const STATUS_QUEUED = 'queued'
export const STATUS_DOWNLOADING = 'downloading'
export const STATUS_COPYING = 'copying'
export const STATUS_DONE = 'done'
export const STATUS_FAILED = 'failed'

/** 非法文件名字符（sidecar outPathFor 的正则 [\\/:*?"<>|]）。 */
const ILLEGAL_NAME_CHARS = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|'])

/** 一条任务记录的键。 */
export function taskKey(taskId) {
  return `${TASK_KEY_PREFIX}${taskId}`
}

/** 键名是否满足宿主的 storage 键正则（v3 未明说，沿用旧契约保守校验）。 */
export function keyIsHostSafe(key) {
  const text = String(key)
  if (!text || text.length > 160) return false
  const bytes = new TextEncoder().encode(text)
  if (bytes.length !== text.length) return false // 非 ASCII 直接判非法
  if (!/[A-Za-z0-9]/.test(text[0])) return false
  for (let i = 1; i < text.length; i++) {
    const ch = text[i]
    if (/[A-Za-z0-9]/.test(ch)) continue
    if (!'._-'.includes(ch)) return false
    const next = text[i + 1]
    if (!next || !/[A-Za-z0-9]/.test(next)) return false
  }
  return true
}

/** 是否占用下载并发槽（下载中 / 待复制）。 */
export function isSlot(status) {
  return status === STATUS_DOWNLOADING || status === STATUS_COPYING
}

/** 是否已终态。 */
export function isFinished(status) {
  return status === STATUS_DONE || status === STATUS_FAILED
}

/** 文件名主干（不含扩展名与去重后缀）的 UTF-8 字节上限：常见文件系统单个文件名 ≤255 字节，
 *  留出「 (99)」去重后缀与扩展名的余量。 */
export const NAME_STEM_BYTE_LIMIT = 200

/** 组件清洗：\/:*?"<>| 与控制字符 → _，再 trim。 */
export function sanitizeComponent(text) {
  let out = ''
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0)
    out += ILLEGAL_NAME_CHARS.has(ch) || code < 0x20 || code === 0x7f ? '_' : ch
  }
  return out.trim()
}

/** 按 UTF-8 字节截断（不切开多字节字符 / 代理对）。 */
export function truncateUtf8(text, limit) {
  const encoder = new TextEncoder()
  if (encoder.encode(text).length <= limit) return text
  let out = ''
  let bytes = 0
  for (const ch of text) {
    const size = encoder.encode(ch).length
    if (bytes + size > limit) break
    out += ch
    bytes += size
  }
  return out
}

/** 目标文件名 `"{singers} - {name}.{ext}"`（sidecar outPathFor 的简化形态）：
 *  歌手/歌名清洗后为空 → 未知；扩展名缺失 → flac。主干超长按字节截断；
 *  首尾的点和空格去掉（隐藏文件 / Windows·SMB 挂载不认结尾的点）。 */
export function outName(singers, name, ext) {
  const safeSingers = sanitizeComponent(singers) || '未知'
  const safeName = sanitizeComponent(name) || '未知'
  const safeExt = String(ext ?? '').trim().replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'flac'
  const stem = truncateUtf8(`${safeSingers} - ${safeName}`, NAME_STEM_BYTE_LIMIT).replace(/^[.\s]+|[.\s]+$/g, '') || '未知'
  return `${stem}.${safeExt}`
}

/** 同名去重：`a.flac` → `a (2).flac`（n ≤ 1 原样返回）。 */
export function withNameSuffix(fileName, n) {
  if (!(n > 1)) return fileName
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? `${fileName.slice(0, dot)} (${n})${fileName.slice(dot)}` : `${fileName} (${n})`
}

/** 展示名（标题/按钮文案用）：`"歌手 - 歌名"`，歌手缺失时只用歌名。 */
export function displayName(task) {
  return task?.singers ? `${task.singers} - ${task.name}` : String(task?.name ?? '')
}

/** 完整任务 → 索引条目投影（error 按字节截断到 IDX_ERROR_LIMIT）。 */
export function indexEntryOf(task) {
  return {
    id: task.id,
    status: task.status,
    source: task.source,
    song_id: task.song_id,
    name: task.name,
    singers: task.singers,
    quality: task.quality,
    error: trunc(task.error ?? '', IDX_ERROR_LIMIT),
    updated_ms: task.updated_ms,
  }
}

/** 索引按 updated_ms 倒序（同值按 id 倒序，保证顺序稳定）；就地排序不截断。 */
export function sortIndex(index) {
  index.sort((a, b) => (b.updated_ms - a.updated_ms) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  return index
}

/** state 视图里的任务列表：索引按 updated_ms 倒序，最近 STATE_TASKS_LIMIT 条。 */
export function stateView(index) {
  const copy = [...index]
  sortIndex(copy)
  return copy.slice(0, STATE_TASKS_LIMIT)
}

/** 把一条任务重置为排队态（重试的公共逻辑）：attempts 归零、retry_round 自增。
 *  返回是否真的重置了（非失败态 → false）。 */
export function requeueTask(task, now) {
  if (task.status !== STATUS_FAILED) return false
  task.status = STATUS_QUEUED
  task.attempts = 0
  task.retry_round = (task.retry_round ?? 0) + 1
  task.error = ''
  task.job_ref = ''
  task.cd2_ref = ''
  task.updated_ms = now()
  return true
}

/** 从 telegram/callback 事件的 data 里提取按钮回调值（tasks.rs extract_callback_data）：
 *  兼容 callback.data / callback_query.data / 顶层 data / callback_data 几种写法。 */
export function extractCallbackData(data) {
  const candidates = [
    data?.callback?.data,
    data?.callback_query?.data,
    data?.data,
    data?.callback_data,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string') return candidate
  }
  return null
}

/** 队列忙时的统一回答（不是失败：什么都没做，稍后再试即可）。 */
export function queueBusyValue(message) {
  return { skipped: 'queue_busy', message }
}
