// 运行日志 —— 旧 runtime.rs LogEntry/state.logs 的 v3 形态。
//
// 旧版把日志嵌在状态文档里随 state 响应下发；v3 的状态由页面直接读 KV 组装，
// 日志独立放 KV `logs`（数组，尾部截断）。后台 job 与页面的入队/重试动作都追加。

import { nowRfc3339 } from './encoding.js'

/** 持久化时只保留最近多少条日志（runtime.rs PERSIST_LOG_LIMIT）。 */
export const LOG_LIMIT = 40
/** 单条日志长度上限（字节；runtime.rs LOG_MESSAGE_LIMIT）。 */
export const LOG_MESSAGE_LIMIT = 400

export const LOGS_KEY = 'logs'

/** 写一条日志到内存数组（长度按 LOG_MESSAGE_LIMIT 截断，尾部截断到 LOG_LIMIT）。 */
export function appendEntry(logs, level, message, at = nowRfc3339()) {
  const list = Array.isArray(logs) ? [...logs] : []
  const trimmed = String(message ?? '')
  list.push({ at, level, message: trimmed.length > LOG_MESSAGE_LIMIT ? `${trimmed.slice(0, LOG_MESSAGE_LIMIT)}...(truncated)` : trimmed })
  const overflow = list.length - LOG_LIMIT
  if (overflow > 0) list.splice(0, overflow)
  return list
}

/** 读 KV 日志（缺失/损坏 → 空数组）。 */
export async function loadLogs(kv) {
  const value = await kv.get(LOGS_KEY)
  return Array.isArray(value) ? value : []
}

/** 追加一条日志并落盘（kv 由 lib/kv.js 提供）。 */
export async function addLog(kv, level, message) {
  const logs = appendEntry(await loadLogs(kv), level, message)
  await kv.set(LOGS_KEY, logs)
  return logs
}
