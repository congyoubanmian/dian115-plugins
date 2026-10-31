// 下载管线（pump 状态机）—— 从 plugins/music-rs/src/download.rs 移植。
//
// 旧版两段式「宿主代下载 job + 轮询 + 跨边界复制」在 v3 收敛成一条同步管线
// （developer-guide §文件与 CD2 的官方推荐形态）：
//
//   1. 取链接   netease eapi 阶梯 / QQ 阶梯（lib/music-api.js resolveSongUrl）；
//   2. 暂存     ctx.http.request({save_to:'downloads/<短id>.part'}) —— 2xx 流式写盘
//               并返回 {path,size,sha256}，不受 64 MiB 限制；
//   3. 定名     ctx.files.call({operation:'rename'}) → "{singers} - {name}.{ext}"；
//   4. 入库     ctx.files.call({operation:'move', destination_dir: target_dir}) ——
//               宿主按 CD2 挂载前缀自动分流（CD2 gRPC 或系统命令），带字节进度；
//   5. 通知     尝试次数用尽 → ctx.notify（level=error，buttons 带 retry:<短id>）。
//
// 状态机语义与旧版一致：queued → downloading → copying → done / failed；
// MAX_ATTEMPTS=3；失败回 queued（attempts<3）或终态 failed + 通知。
// 与旧版的差异（如实记录）：
// - save_to 是同步的，单轮 pump 按顺序推进到 max_active 首（旧版每轮最多新开 1 首）；
// - 「downloading」状态在 pump 开始时出现即视为上一轮被宿主中断的残留（不允许重叠），
//   按 fail_task 语义计数并回队。

import { STATUS_QUEUED, STATUS_DOWNLOADING, STATUS_COPYING, STATUS_DONE, STATUS_FAILED, MAX_ATTEMPTS, TASKS_IDX_KEY, indexEntryOf, sortIndex } from './tasks-core.js'
import { loadIndex, loadTask, persistTask, retry, adopt, clearFinished } from './queue-store.js'
import { normalizeSettings } from './settings.js'
import { resolveSongUrl } from './music-api.js'
import { nowMs } from './encoding.js'

/** 暂存目录（插件自有文件，相对路径）。 */
export const STAGING_SUBDIR = 'downloads'
/** 每个直链下载的超时（秒）。 */
export const DOWNLOAD_TIMEOUT_SECONDS = 600

/** 扩展名兜底（取链没给 type 时按 flac，与 sidecar 默认一致）。 */
export function normalizeExt(ext) {
  const cleaned = String(ext ?? '').trim().replace(/^\./, '').toLowerCase()
  return cleaned || 'flac'
}

/** 目标文件名（真实扩展名到手后定名）。 */
export function targetName(task, ext) {
  const singers = task.singers ?? ''
  const name = task.name ?? ''
  const safe = (text) => {
    let out = ''
    for (const ch of String(text)) out += '\\/:*?"<>|'.includes(ch) ? '_' : ch
    return out.trim()
  }
  const s = safe(singers) || '未知'
  const n = safe(name) || '未知'
  return `${s} - ${n}.${normalizeExt(ext)}`
}

/** 列出暂存目录里以 prefix 开头的文件（宿主去重后缀 "xxx (1).part" 一并算）。 */
async function listStaged(ctx, prefix) {
  let entries
  try {
    entries = await ctx.files.call({ operation: 'list', path: STAGING_SUBDIR })
  } catch {
    return []
  }
  if (!Array.isArray(entries)) return []
  return entries.filter((entry) => !entry.is_dir && String(entry.name ?? '').startsWith(prefix))
}

/** 删除一个任务留在暂存目录的全部残留（.part 与去重变体，尽力而为）。 */
async function cleanupStaged(ctx, taskId) {
  const stale = await listStaged(ctx, taskId)
  if (!stale.length) return 0
  try {
    await ctx.files.call({ operation: 'remove', paths: stale.map((entry) => entry.path) })
    return stale.length
  } catch {
    return 0
  }
}

/** 失败处理：尝试次数用尽 → 置 failed 并发通知；否则回 queued 等下轮重试。 */
async function failTask(deps, task, error, report) {
  task.error = error
  task.updated_ms = nowMs()
  task.job_ref = ''
  if (task.attempts >= MAX_ATTEMPTS) {
    task.status = STATUS_FAILED
    report.failed.push(task.id)
    await notifyFailure(deps, task, error, report)
  } else {
    task.status = STATUS_QUEUED
    report.messages.push(`任务 ${task.id} 第 ${task.attempts} 次尝试失败, 将重试: ${error}`)
  }
}

/** 复制/入库失败：只重试入库（暂存文件已定名），不重新下载；次数计入总尝试。 */
async function copyFailure(deps, task, error, report) {
  task.attempts = (task.attempts ?? 0) + 1
  task.error = error
  task.updated_ms = nowMs()
  task.job_ref = ''
  task.cd2_ref = ''
  if (task.attempts >= MAX_ATTEMPTS) {
    task.status = STATUS_FAILED
    report.failed.push(task.id)
    await notifyFailure(deps, task, error, report)
  } else {
    task.status = STATUS_COPYING
    report.messages.push(`任务 ${task.id} 入库失败, 将重试: ${error}`)
  }
}

/** 终态失败的通知发送 + 过程可见化。 */
async function notifyFailure(deps, task, error, report) {
  if (!deps.settings.notify_on_fail) return
  const title = `下载失败: ${truncateChars(task.name, 100)}`
  const bodyText = truncateChars(
    `${task.singers} - ${task.name}\n来源: ${task.source} / 音质: ${task.quality}\n${error}\n(在插件「下载任务」里可一键重试)`,
    1800,
  )
  try {
    const outcome = await deps.notify({
      level: 'error',
      title,
      body: bodyText,
      dedupe_key: `dl-fail-${task.id}-r${task.retry_round ?? 0}-a${task.attempts}`,
      // v3 通知支持 callback_data 按钮（仅 Telegram）：用户点击触发清单 event=callback 的任务。
      buttons: [[{ text: '重试', callback_data: `retry:${task.id}` }]],
    })
    const channels = channelSummary(outcome)
    if (channels) report.messages.push(`任务 ${task.id} 失败通知已发出 · 通道: ${channels}`)
  } catch (err) {
    report.messages.push(`任务 ${task.id} 失败通知发送失败: ${err?.message ?? err}`)
  }
}

/** 把通知结果里的通道能力上报拼成一行人话；没有 channels 字段 → null。 */
function channelSummary(outcome) {
  const channels = outcome?.channels
  if (!Array.isArray(channels) || channels.length === 0) return null
  return channels
    .map((item) => {
      const dropped = Array.isArray(item?.dropped) ? item.dropped : []
      return dropped.length === 0 ? String(item.channel) : `${item.channel}(丢:${dropped.join('/')})`
    })
    .join(' · ')
}

function truncateChars(text, limit) {
  const chars = [...String(text ?? '')]
  return chars.length <= limit ? chars.join('') : chars.slice(0, limit).join('')
}

/**
 * 启动一个排队任务：取链接 → 下载到暂存 → 定名 → 入库（一条龙，状态逐段落盘）。
 * 单任务作用域：处理完立即 persist，异常不逃逸（返回后由 pump 继续下一首）。
 */
async function runTask(ctx, deps, task, report) {
  task.attempts = (task.attempts ?? 0) + 1
  task.updated_ms = nowMs()
  let song
  try {
    song = await resolveSongUrl(deps, task.source, task.song_id, task.quality)
  } catch (error) {
    await failTask(deps, task, error?.message ?? String(error), report)
    await persistTask(deps.kv, task)
    return
  }
  if (!song?.url || !String(song.url).startsWith('http')) {
    await failTask(deps, task, '取链结果缺少直链', report)
    await persistTask(deps.kv, task)
    return
  }
  // 真实扩展名到手后再定名（入队时按 flac 兜底）。
  task.out_name = targetName(task, song.ext)
  task.status = STATUS_DOWNLOADING
  task.error = ''
  await persistTask(deps.kv, task)
  report.messages.push(`任务 ${task.id} 已提交下载(${task.source} ${song.level})`)
  report.started.push(task.id)

  // 暂存：清掉旧残留 → save_to 流式写盘。
  await cleanupStaged(ctx, task.id)
  const partName = `${task.id}.part`
  let download
  try {
    download = await deps.http.request({
      url: song.url,
      method: 'GET',
      save_to: `${STAGING_SUBDIR}/${partName}`,
      timeout_seconds: DOWNLOAD_TIMEOUT_SECONDS,
    })
  } catch (error) {
    await failTask(deps, task, `下载失败: ${error?.message ?? error}`, report)
    await persistTask(deps.kv, task)
    return
  }
  if (download.status >= 400) {
    await failTask(deps, task, `下载失败: HTTP ${download.status} ${truncateChars(download.body ?? '', 200)}`, report)
    await persistTask(deps.kv, task)
    return
  }
  const staged = typeof download.path === 'string' && download.path ? download.path : `${STAGING_SUBDIR}/${partName}`
  task.staged_path = staged
  task.status = STATUS_COPYING
  task.updated_ms = nowMs()
  await persistTask(deps.kv, task)

  // 定名（同目录改名；save_to 的去重变体已由 cleanupStaged 清掉，目标名应唯一）。
  let finalPath = staged
  if (!String(staged).endsWith(`/${task.out_name}`)) {
    try {
      const renamed = await ctx.files.call({ operation: 'rename', path: staged, name: task.out_name })
      if (renamed?.path) finalPath = renamed.path
      else finalPath = `${STAGING_SUBDIR}/${task.out_name}`
    } catch (error) {
      await copyFailure(deps, task, `定名失败: ${error?.message ?? error}`, report)
      await persistTask(deps.kv, task)
      return
    }
  }

  // 入库：交给宿主 move 到目标目录（CD2 挂载自动分流；目标已存在默认失败不覆盖）。
  try {
    await ctx.files.call({
      operation: 'move',
      path: finalPath,
      destination_dir: deps.settings.target_dir,
      overwrite: false,
    })
  } catch (error) {
    await copyFailure(deps, task, `入库失败: ${error?.message ?? error}`, report)
    await persistTask(deps.kv, task)
    return
  }

  // 完成：done + 记账（文件已 move 出暂存目录，无需清理；入库失败重试路径的残留
  // 会在下轮 copyFailure 重试或终态后由用户处理）。
  task.status = STATUS_DONE
  task.job_ref = ''
  task.cd2_ref = ''
  task.error = ''
  task.updated_ms = nowMs()
  await persistTask(deps.kv, task)
  report.completed.push(task.id)
  report.messages.push(`任务 ${task.id} 完成: ${task.out_name}`)
}

/**
 * 推进 KV 任务队列（旧 download.rs pump 的 v3 形态）。
 *
 * 顺序：恢复中断的 downloading 残留 → 按队列序逐首推进 queued（单轮最多新开
 * max_active 首）→ 落盘摘要。每类工作都在独立作用域里处理单条任务。
 *
 * 返回摘要 {queued, active, started, completed, failed, messages}。
 */
export async function pump(ctx, deps) {
  const report = { messages: [], started: [], completed: [], failed: [] }
  const settings = deps.settings
  const index = await loadIndex(deps.kv)

  // ① 恢复中断的 downloading 残留：save_to 同步执行且任务不允许重叠，
  //    pump 开始时还挂在 downloading 的任务 = 上一轮被宿主中断的残留。
  const downloading = index.filter((entry) => entry.status === STATUS_DOWNLOADING).map((entry) => entry.id)
  for (const taskId of downloading) {
    const task = await loadTask(deps.kv, taskId)
    if (!task || task.status !== STATUS_DOWNLOADING) continue
    task.attempts = (task.attempts ?? 0) + 1
    task.error = '上一轮被中断(宿主重启或超时), 本轮重新排队'
    task.updated_ms = nowMs()
    if (task.attempts >= MAX_ATTEMPTS) {
      task.status = STATUS_FAILED
      report.failed.push(task.id)
      await notifyFailure(deps, task, task.error, report)
    } else {
      task.status = STATUS_QUEUED
      report.messages.push(`任务 ${task.id} 第 ${task.attempts} 次尝试失败, 将重试: ${task.error}`)
    }
    await persistTask(deps.kv, task)
  }

  // ② 推进 copying 残留（定名后入库被打断）：重试入库不重新下载。
  const copying = index.filter((entry) => entry.status === STATUS_COPYING).map((entry) => entry.id)
  for (const taskId of copying) {
    const task = await loadTask(deps.kv, taskId)
    if (!task || task.status !== STATUS_COPYING) continue
    if (!task.staged_path || !task.out_name) {
      await failTask(deps, task, '缺少暂存文件路径或目标文件名, 无法复制', report)
      await persistTask(deps.kv, task)
      continue
    }
    try {
      await ctx.files.call({
        operation: 'move',
        path: task.staged_path,
        destination_dir: settings.target_dir,
        overwrite: false,
      })
      task.status = STATUS_DONE
      task.error = ''
      task.updated_ms = nowMs()
      report.completed.push(task.id)
      report.messages.push(`任务 ${task.id} 完成: ${task.out_name}`)
    } catch (error) {
      await copyFailure(deps, task, `入库失败: ${error?.message ?? error}`, report)
    }
    await persistTask(deps.kv, task)
  }

  // ③ 新开下载：按队列序（索引 updated_ms 倒序 = pump 从头取 queued）逐首推进。
  //    迭代上限 = 索引长度 + 2：索引与分片不一致（状态损坏）时宁可停下报错，绝不自旋。
  const cap = Math.max(1, settings.max_active)
  let startedCount = 0
  let cursor = await loadIndex(deps.kv)
  const maxIterations = cursor.length + 2
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (startedCount >= cap) {
      const queuedLeft = cursor.filter((entry) => entry.status === STATUS_QUEUED).length
      if (queuedLeft > 0) {
        report.messages.push(`${queuedLeft} 个排队任务等待下一轮(本轮已新开 ${startedCount}/${cap})`)
      }
      break
    }
    const nextId = cursor.find((entry) => entry.status === STATUS_QUEUED)?.id
    if (!nextId) break
    const task = await loadTask(deps.kv, nextId)
    if (!task || task.status !== STATUS_QUEUED) {
      // 索引与分片不一致（分片缺失或状态漂移）：停止本轮，提示人工对账（task-adopt）。
      report.messages.push(`任务 ${nextId} 的索引条目与分片状态不一致, 本轮停止推进(可尝试「索引对账」)`)
      break
    }
    await runTask(ctx, deps, task, report)
    startedCount += 1
    cursor = await loadIndex(deps.kv)
    // 一次 pump 最多收尾 1 首（旧版门禁保留）：避免单轮跑过长、重复失败风暴。
    if (report.completed.length + report.failed.length > 0) break
  }

  // 摘要计数从索引重算。
  const finalIndex = await loadIndex(deps.kv)
  const queued = finalIndex.filter((e) => e.status === STATUS_QUEUED).length
  const active = finalIndex.filter((e) => e.status === STATUS_DOWNLOADING || e.status === STATUS_COPYING).length
  return {
    queued,
    active,
    started: report.started,
    completed: report.completed,
    failed: report.failed,
    messages: report.messages,
  }
}

// 供 jobs 复用的队列操作（re-export，保持 jobs 的导入面窄）。
export { retry, adopt, clearFinished, loadIndex, loadTask, persistTask, indexEntryOf, sortIndex, TASKS_IDX_KEY }
