// 状态文档三方合并：CAS 冲突时把"本次会话的改动"叠加到"别的任务刚写入的新版本"上。
//
// 同一插件的多个任务（定时榜单刷新、想看同步、前台动作）可能同时读写 state 键；
// 旧逻辑冲突后直接拿新版本号重写自己的整份文档，会把对方刚落盘的改动整体覆盖掉
// （例如前台刚删除的队列条目被后台任务写回、刚清空的历史复活）。
//
// 规则（base = 本会话读盘时的文档，ours = 本会话要写的文档，theirs = 存储里的新文档）：
// - 只有一方改过的字段取改过的一方；两方都改了的对象按键递归合并；
// - 元素带 douban_ref 的数组（队列、想看）按 douban_ref 合并，双方的增删都保留；
// - history / logs 视为只追加：在对方版本后面补上本会话新增的条目；
// - 其余两方都改过的标量 / 数组以本会话为准。
// 纯函数、无宿主依赖。

const APPEND_ONLY = new Set(['history', 'logs'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function same(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function isKeyedArray(...arrays) {
  const present = arrays.filter((items) => Array.isArray(items) && items.length > 0)
  return present.length > 0 && present.every((items) => items.every((item) => isPlainObject(item) && typeof item.douban_ref === 'string' && item.douban_ref !== ''))
}

function mergeKeyedArray(base, ours, theirs) {
  const index = (items) => new Map((Array.isArray(items) ? items : []).map((item) => [item.douban_ref, item]))
  const baseMap = index(base)
  const oursMap = index(ours)
  const out = []
  const emitted = new Set()
  for (const item of Array.isArray(theirs) ? theirs : []) {
    const ref = item.douban_ref
    emitted.add(ref)
    const mine = oursMap.get(ref)
    if (mine === undefined) {
      // 本会话删掉了（读盘时还在）→ 删除；本会话从没见过 → 对方新增，保留
      if (baseMap.has(ref) && same(baseMap.get(ref), item)) continue
      out.push(item)
      continue
    }
    out.push(baseMap.has(ref) && same(baseMap.get(ref), mine) ? item : mine)
  }
  for (const item of Array.isArray(ours) ? ours : []) {
    const ref = item.douban_ref
    if (emitted.has(ref)) continue
    // 对方删掉了且本会话没动过 → 尊重删除；本会话新增或改过 → 保留
    if (baseMap.has(ref) && same(baseMap.get(ref), item)) continue
    out.push(item)
  }
  return out
}

function mergeAppendOnly(base, ours, theirs) {
  const seen = new Set((Array.isArray(base) ? base : []).map((item) => JSON.stringify(item)))
  const out = Array.isArray(theirs) ? [...theirs] : []
  const present = new Set(out.map((item) => JSON.stringify(item)))
  for (const item of Array.isArray(ours) ? ours : []) {
    const key = JSON.stringify(item)
    if (seen.has(key) || present.has(key)) continue
    present.add(key)
    out.push(item)
  }
  return out
}

/** 三方合并任意值（key 为当前字段名，用于识别只追加数组）。 */
export function merge3(base, ours, theirs, key = '') {
  if (same(ours, base)) return theirs
  if (same(theirs, base) || same(ours, theirs)) return ours
  const objectish = [base, ours, theirs].every((value) => value === null || value === undefined || isPlainObject(value))
  if (objectish && (isPlainObject(ours) || isPlainObject(theirs))) {
    const b = isPlainObject(base) ? base : {}
    const o = isPlainObject(ours) ? ours : {}
    const t = isPlainObject(theirs) ? theirs : {}
    const out = {}
    for (const name of new Set([...Object.keys(t), ...Object.keys(o)])) {
      const merged = merge3(b[name], o[name], t[name], name)
      if (merged !== undefined) out[name] = merged
    }
    return out
  }
  const arrayish = [base, ours, theirs].every((value) => value === null || value === undefined || Array.isArray(value))
  if (arrayish) {
    if (APPEND_ONLY.has(key)) return mergeAppendOnly(base, ours, theirs)
    if (isKeyedArray(base, ours, theirs)) return mergeKeyedArray(base, ours, theirs)
  }
  return ours
}

/** 合并整份状态文档（顶层按字段三方合并）。 */
export function mergeStateDocs(base, ours, theirs) {
  if (!isPlainObject(base) || !isPlainObject(theirs)) return ours
  return merge3(base, ours, theirs)
}
