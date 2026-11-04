// KV 任务队列（分片：tasks.idx + task.<id>）—— 从 plugins/music-rs/src/tasks.rs 移植。
//
// 旧版的 ETag 乐观锁 + 幂等键（store.rs PutIds）换成 v3 的 `ctx.storage` CAS
// （expected_revision）：读改写统一走 `casWrite`，冲突时重读重试（有限次）。
// 分片动机（单曲加载-处理-释放、索引是 UI 唯一数据源）在 v3 依旧成立，原样保留。

import {
  TASKS_IDX_KEY, taskKey, STATUS_QUEUED, STATUS_DOWNLOADING, STATUS_COPYING,
  indexEntryOf, sortIndex, requeueTask, outName, displayName,
} from './tasks-core.js'
import { allocateId, nowMs } from './encoding.js'
import { casWrite } from './kv.js'

/** CAS 读改写由 lib/kv.js 提供（expected_revision 乐观锁 + 有限重试）。 */
export { casWrite }

/** 读任务索引（KV tasks.idx）。键不存在 → 空索引。 */
export async function loadIndex(kv) {
  const value = await kv.get(TASKS_IDX_KEY)
  return Array.isArray(value) ? value : []
}

/** 写任务索引（无读改写时直接覆盖）。 */
export async function saveIndex(kv, index) {
  await kv.set(TASKS_IDX_KEY, index)
  return index
}

/** 读一条任务的完整记录（KV task.<id>）；不存在返回 null。 */
export async function loadTask(kv, taskId) {
  const value = await kv.get(taskKey(taskId))
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/** 就地把 task 的最新状态写回 task.<id> 与 tasks.idx（索引条目就地替换，找不到才追加）。 */
export async function persistTask(kv, task) {
  await kv.set(taskKey(task.id), task)
  await casWrite(kv, TASKS_IDX_KEY, (currentIndex) => {
    const list = Array.isArray(currentIndex) ? [...currentIndex] : []
    const entry = indexEntryOf(task)
    const at = list.findIndex((slot) => slot.id === task.id)
    if (at >= 0) list[at] = entry
    else {
      list.push(entry)
      sortIndex(list)
    }
    return { next: list, result: null }
  })
}

/** 删一条任务的完整记录。 */
export async function deleteTask(kv, taskId) {
  await kv.remove(taskKey(taskId))
}

/**
 * 入队（去重：同 source+song_id+quality 的 queued/downloading/copying 任务直接复用）。
 * 去重走索引（索引带 source/song_id/quality），存储调用数与队列长度无关。
 * 返回 `{task, deduped}`。
 *
 * 写入顺序：先分片 task.<id>、后索引。两步之间被宿主中断时留下的是「有分片、
 * 索引里没有」的孤儿分片 —— 「索引对账」(adopt) 能把它找回；反过来（先索引后分片）
 * 留下的是「索引指向缺失分片」，pump 读到只能停下报错（lib/pump.js 的一致性检查），
 * 是不可自愈的形态。分片先写即使 index CAS 最终失败，孤儿也不影响泵推进。
 */
export async function enqueue(kv, request) {
  if (!String(request.source ?? '').trim()) throw new Error('缺少音乐来源')
  if (!String(request.song_id ?? '').trim()) throw new Error('缺少歌曲标识')
  if (!String(request.quality ?? '').trim()) throw new Error('缺少音质')
  const millis = nowMs()
  const seed = `${request.source}|${request.song_id}|${request.quality}|${millis}`

  // ① 先按当前索引去重（命中就结束，不产生任何写）。
  const current = await loadIndex(kv)
  const existing = current.find((entry) =>
    (entry.status === STATUS_QUEUED || entry.status === STATUS_DOWNLOADING || entry.status === STATUS_COPYING) &&
    entry.source === request.source &&
    entry.song_id === request.song_id &&
    entry.quality === request.quality)
  if (existing) {
    const task = await loadTask(kv, existing.id)
    if (!task) throw new Error(`去重命中但分片缺失: ${existing.id}`)
    return { task, deduped: true }
  }

  // ② 新任务 id 避开全队列已有的 id（不只进行中的），暂存文件名靠它唯一。
  //    真实扩展名要等取链才知道；这里先按 flac 兜底，pump 取链后用真实扩展名更新。
  const id = allocateId(current.map((entry) => entry.id), seed)
  const task = {
    id,
    source: request.source,
    song_id: request.song_id,
    name: request.name ?? '',
    singers: request.singers ?? '',
    album: request.album ?? '',
    quality: request.quality,
    out_name: outName(request.singers ?? '', request.name ?? '', 'flac'),
    staged_path: '',
    status: STATUS_QUEUED,
    job_ref: '',
    cd2_ref: '',
    attempts: 0,
    retry_round: 0,
    error: '',
    created_ms: millis,
    updated_ms: millis,
  }

  // ③ 先落分片，再 CAS 挂索引；CAS 期间别人抢建了同 key 的进行中任务 →
  //    复用对方任务（本分片成为孤儿，等「索引对账」或过期清理）。
  await kv.set(taskKey(task.id), task)
  const { hit } = await casWrite(kv, TASKS_IDX_KEY, (currentIndex) => {
    const index = Array.isArray(currentIndex) ? [...currentIndex] : []
    const dup = index.find((entry) =>
      (entry.status === STATUS_QUEUED || entry.status === STATUS_DOWNLOADING || entry.status === STATUS_COPYING) &&
      entry.source === request.source &&
      entry.song_id === request.song_id &&
      entry.quality === request.quality)
    if (dup) return { next: index, result: { hit: dup } }
    index.push(indexEntryOf(task))
    sortIndex(index)
    return { next: index, result: { hit: null } }
  })
  if (hit) {
    const winner = await loadTask(kv, hit.id)
    if (!winner) throw new Error(`去重命中但分片缺失: ${hit.id}`)
    return { task: winner, deduped: true }
  }
  return { task, deduped: false }
}

/** 失败任务重新排队（Telegram retry:<id> 与页面 task-retry 共用）。
 *  只读 task.<id> 一条完整记录。 */
export async function retry(kv, taskId) {
  const id = String(taskId ?? '').trim()
  if (!id) throw new Error('缺少任务 id')
  const task = await loadTask(kv, id)
  if (!task) throw new Error(`任务不存在: ${id}`)
  if (!requeueTask(task, nowMs)) {
    return { task_id: id, status: task.status, message: '任务不在失败态, 无需重试' }
  }
  const status = task.status
  await persistTask(kv, task)
  return { task_id: id, status, message: '已重新排队' }
}

/** 索引对账（action task-adopt）：把孤儿分片 task.<id> 重新挂回 tasks.idx。幂等。 */
export async function adopt(kv, taskId) {
  const id = String(taskId ?? '').trim()
  if (!id) throw new Error('缺少任务 id')
  const task = await loadTask(kv, id)
  if (!task) throw new Error(`分片不存在: task.${id}`)
  // casWrite 已带 CAS 落盘；不能再无条件 saveIndex 覆盖一次（会冲掉期间 pump 写入的索引）。
  const { adopted } = await casWrite(kv, TASKS_IDX_KEY, (currentIndex) => {
    const list = Array.isArray(currentIndex) ? [...currentIndex] : []
    if (list.some((entry) => entry.id === task.id)) return { next: list, result: { adopted: false } }
    list.push(indexEntryOf(task))
    sortIndex(list)
    return { next: list, result: { adopted: true } }
  })
  if (!adopted) {
    return { task_id: task.id, status: task.status, adopted: false, message: '已在索引里, 无需对账' }
  }
  return {
    task_id: task.id,
    status: task.status,
    name: displayName(task),
    adopted: true,
    message: '已挂回索引, 下轮泵会继续推进(在途会按原状态轮询)',
  }
}

/** 清掉已终态（done/failed）的任务，返回清理条数。
 *  单条删除失败只记账不中断：该条目保留在索引里（下次 clear 再试），不会被
 *  同轮成功删除的其它条目连带从索引里抹掉 —— 否则分片会变成永久孤儿。 */
export async function clearFinished(kv) {
  const index = await loadIndex(kv)
  const removedIds = new Set()
  let removed = 0
  const errors = []
  for (const entry of index) {
    if (entry.status === 'done' || entry.status === 'failed') {
      try {
        // 快照之后被重试回队的任务（分片已不是终态）不删。
        const shard = await loadTask(kv, entry.id)
        if (shard && shard.status !== 'done' && shard.status !== 'failed') continue
        await deleteTask(kv, entry.id)
        removedIds.add(entry.id)
        removed += 1
      } catch (error) {
        errors.push(`${entry.id}: ${error?.message ?? error}`)
      }
    }
  }
  // 只从「当前」索引里摘掉本轮删掉分片的条目（CAS 读改写）：不能把开头读到的快照整份写回，
  // 否则清理期间 pump / 入队写进索引的变更会被旧快照覆盖（任务「消失」或状态回退）。
  if (removedIds.size > 0) {
    await casWrite(kv, TASKS_IDX_KEY, (currentIndex) => {
      const list = Array.isArray(currentIndex) ? currentIndex : []
      return { next: list.filter((entry) => !removedIds.has(entry.id)), result: null }
    })
  }
  if (errors.length > 0) throw new Error(`清理失败 ${errors.length} 条: ${errors.join('; ')}`)
  return removed
}

/** 全部失败任务重新排队（页面「重试全部失败」）。逐条走 retry（CAS 落盘），
 *  单条出错不中断其余条目，返回 {retried, errors}。 */
export async function retryAllFailed(kv) {
  const index = await loadIndex(kv)
  let retried = 0
  const errors = []
  for (const entry of index) {
    if (entry.status !== 'failed') continue
    try {
      const outcome = await retry(kv, entry.id)
      if (outcome.status === 'queued') retried += 1
    } catch (error) {
      errors.push(`${entry.id}: ${error?.message ?? error}`)
    }
  }
  return { retried, errors }
}
