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
// 下载/入库前的同名预检（files.exists）：目标目录已有同名文件 → 直接终态失败
// （错误写明路径，failFinal），不进「move overwrite:false 撞墙 → copyFailure 重试
// 到 MAX_ATTEMPTS」的循环；exists 读不到则按未确认处理，沿用原流程兜底。
// save_to 响应里的 size/sha256（宿主对落盘文件算好的值）记进 task.done 可追溯；
// 索引条目不投影这两个字段（indexEntryOf 只挑 6+3 个字段，索引保持紧凑）。
//
// 状态机语义与旧版一致：queued → downloading → copying → done / failed；
// MAX_ATTEMPTS=3；失败回 queued（attempts<3）或终态 failed + 通知。
// 与旧版的差异（如实记录）：
// - save_to 是同步的，单轮 pump 按顺序推进到 max_active 首（旧版每轮最多新开 1 首）；
// - 「downloading」状态在 pump 开始时出现即视为上一轮被宿主中断的残留（不允许重叠），
//   按 fail_task 语义计数并回队。

import { STATUS_QUEUED, STATUS_DOWNLOADING, STATUS_COPYING, STATUS_DONE, STATUS_FAILED, MAX_ATTEMPTS, TASKS_IDX_KEY, indexEntryOf, sortIndex } from './tasks-core.js'
import { loadIndex, loadTask, persistTask, retry, adopt, clearFinished } from './queue-store.js'
import { createKv } from './kv.js'
import { normalizeSettings } from './settings.js'
import { resolveSongUrl } from './music-api.js'
import { nowMs, nowRfc3339 } from './encoding.js'
import { taskCheckpoint } from './task.js'

/** 暂存目录（插件自有文件，相对路径）。 */
export const STAGING_SUBDIR = 'downloads'
/** 每个直链下载的超时（秒）。 */
export const DOWNLOAD_TIMEOUT_SECONDS = 600

/** 任务引用：写进检查点，把检查点与某次运行绑定。 */
function taskRefOf(ctx) {
  return typeof ctx?.task?.id === 'string' ? ctx.task.id : ''
}

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

/** 宿主上报的插件 API 版本是否 ≥ 指定版本（host_api 形如 "3.9"；读不到按不支持处理）。 */
function hostApiAtLeast(hostApi, major, minor) {
  const parts = String(hostApi ?? '').split('.')
  const maj = Number.parseInt(parts[0] ?? '', 10)
  const min = Number.parseInt(parts[1] ?? '', 10)
  if (!Number.isFinite(maj)) return false
  if (maj > major) return true
  return maj === major && (Number.isFinite(min) ? min : 0) >= minor
}

/** 直写目标目录失败时清掉半截文件（尽力而为；清不掉也不该挡住任务失败语义）。 */
async function removePartial(ctx, path) {
  if (!path) return
  try {
    await ctx.files.call({ operation: 'remove', paths: [path] })
  } catch {
    /* 半截文件残留由用户处理，不影响任务失败语义 */
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

/** 终态失败（不走重试）：目标同名已存在这类「重试也不会变」的失败直接落 failed。
 *  attempts 不再累加 —— 重试改变不了结果，计数只会制造重复通知。 */
async function failFinal(deps, task, error, report) {
  task.error = error
  task.updated_ms = nowMs()
  task.job_ref = ''
  task.cd2_ref = ''
  task.status = STATUS_FAILED
  report.failed.push(task.id)
  await notifyFailure(deps, task, error, report)
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
      // dedupe_key 只含任务 id（不可变事实）：同一任务的失败固定一个键，10 分钟窗口
      // 内的重发直接去重，也避免旧键（带 retry_round/attempts）每轮失败都换新键、
      // 去重永不生效的问题。重试入口是用户主动点按钮，不靠换键解锁。
      dedupe_key: `dl-fail-${task.id}`,
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
  const directPath = `${deps.settings.target_dir}/${task.out_name}`
  // 同名预检（files.exists）：目标目录里已有同名文件 → 终态失败（错误写明路径），
  // 不下载也不重试 —— 这类失败重试不会变（move overwrite:false 只会反复撞墙）。
  // exists 读不到（能力缺失/调用失败）按「未确认」处理，沿用原下载流程兜底。
  const occupied = await fileExists(ctx, directPath)
  if (occupied.ok && occupied.exists) {
    await failFinal(deps, task, `目标已存在, 未下载: ${directPath}（同名文件已在目标目录, 请先处理后再重试）`, report)
    await persistTask(deps.kv, task)
    return
  }
  // 写前检查点：超时 / 重启 / 调用失败都不能证明这次下载没发生 —— 落一条
  // 「准备把哪首歌写到哪里」，恢复时拿它去核对目标目录里的真实文件。
  await taskCheckpoint(ctx, {
    stage: 'before-download',
    task_ref: taskRefOf(ctx),
    song_id: task.id,
    out_name: task.out_name,
    target_dir: deps.settings.target_dir,
    target_path: directPath,
    staging_path: `${STAGING_SUBDIR}/${partName}`,
    updated_at: nowRfc3339(),
  })
  // API 3.9（requires.api=3.9）：save_to 可直写宿主/CD2 目标目录 —— 省一次跨盘拷贝。
  // 能力判断以宿主上报的 host_api 为准；真失败时只有「像是能力没开放」才回落
  // 「暂存 → 定名 → move」，其余按下载失败处理（避免把网络错误当成能力缺失重下一遍）。
  const directSupported = hostApiAtLeast(ctx.plugin?.host_api, 3, 9)
  let download
  let direct = false
  if (directSupported) {
    try {
      download = await deps.http.request({
        url: song.url,
        method: 'GET',
        save_to: directPath,
        timeout_seconds: DOWNLOAD_TIMEOUT_SECONDS,
      })
      direct = true
    } catch (error) {
      const message = error?.message ?? String(error)
      if (!/3\.9|不支持|未开放|requires|api/i.test(message)) {
        await failTask(deps, task, `下载失败: ${message}`, report)
        await persistTask(deps.kv, task)
        return
      }
      download = null
    }
  }
  if (download) {
    if (download.status >= 400) {
      await removePartial(ctx, directPath)
      await failTask(deps, task, `下载失败: HTTP ${download.status} ${truncateChars(download.body ?? '', 200)}`, report)
      await persistTask(deps.kv, task)
      return
    }
    // 直写成功：文件已在目标目录，不需要定名与 move。
    // 宿主对 save_to 响应算好的完整性字段记进任务（done 任务可追溯；索引条目不投影这两项）。
    task.staged_path = directPath
    task.size = Number(download.size ?? 0)
    task.sha256 = String(download.sha256 ?? '')
    task.status = STATUS_DONE
    task.job_ref = ''
    task.cd2_ref = ''
    task.error = ''
    task.updated_ms = nowMs()
    await persistTask(deps.kv, task)
    // 写后检查点：文件已确认落在目标目录（直写分支没有 move 段）。
    await taskCheckpoint(ctx, {
      stage: 'after-download',
      task_ref: taskRefOf(ctx),
      song_id: task.id,
      out_name: task.out_name,
      target_dir: deps.settings.target_dir,
      target_path: directPath,
      staging_path: '',
      direct: true,
      path: typeof download.path === 'string' && download.path ? download.path : directPath,
      size: Number(download.size ?? 0),
      sha256: String(download.sha256 ?? ''),
      updated_at: nowRfc3339(),
    })
    report.completed.push(task.id)
    report.messages.push(`任务 ${task.id} 完成: ${task.out_name}`)
    return
  }
  // 回落路径：暂存 → 定名 → move（老宿主或目标目录不可直写时走这里）。
  let stagedDownload
  try {
    stagedDownload = await deps.http.request({
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
  if (stagedDownload.status >= 400) {
    await failTask(deps, task, `下载失败: HTTP ${stagedDownload.status} ${truncateChars(stagedDownload.body ?? '', 200)}`, report)
    await persistTask(deps.kv, task)
    return
  }
  const staged = typeof stagedDownload.path === 'string' && stagedDownload.path ? stagedDownload.path : `${STAGING_SUBDIR}/${partName}`
  task.staged_path = staged
  task.status = STATUS_COPYING
  task.updated_ms = nowMs()
  await persistTask(deps.kv, task)
  // 写后检查点：文件已确认落盘（还在暂存目录，等着入库）。
  await taskCheckpoint(ctx, {
    stage: 'after-download',
    task_ref: taskRefOf(ctx),
    song_id: task.id,
    out_name: task.out_name,
    target_dir: deps.settings.target_dir,
    target_path: `${deps.settings.target_dir}/${task.out_name}`,
    staging_path: staged,
    direct: false,
    path: staged,
    size: Number(stagedDownload.size ?? 0),
    sha256: String(stagedDownload.sha256 ?? ''),
    updated_at: nowRfc3339(),
  })

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
    // 定名后立即把 staged_path 对齐到真实文件：入库失败重试（copying 残留恢复）
    // 按 task.staged_path 重做 move，路径停在改名前会让重试永远失败。
    task.staged_path = finalPath
    task.updated_ms = nowMs()
    await persistTask(deps.kv, task)
  }

  // 入库前检查点：目标目录与文件名，恢复时据此核对文件是否已经在目标目录。
  // move 前的同名预检：下载耗时里目标可能被其它任务/用户占用，重查一次，
  // 已存在则终态失败（不进 overwrite:false 的撞墙-重试循环）。
  const moveTarget = `${deps.settings.target_dir}/${task.out_name}`
  const occupiedBeforeMove = await fileExists(ctx, moveTarget)
  if (occupiedBeforeMove.ok && occupiedBeforeMove.exists) {
    await failFinal(deps, task, `目标已存在, 未入库: ${moveTarget}（同名文件已在目标目录, 请先处理后再重试）`, report)
    await persistTask(deps.kv, task)
    return
  }
  await taskCheckpoint(ctx, {
    stage: 'before-move',
    task_ref: taskRefOf(ctx),
    song_id: task.id,
    out_name: task.out_name,
    target_dir: deps.settings.target_dir,
    target_path: `${deps.settings.target_dir}/${task.out_name}`,
    staging_path: finalPath,
    updated_at: nowRfc3339(),
  })
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

  // 入库后检查点：文件已确认在目标目录。
  await taskCheckpoint(ctx, {
    stage: 'after-move',
    task_ref: taskRefOf(ctx),
    song_id: task.id,
    out_name: task.out_name,
    target_dir: deps.settings.target_dir,
    target_path: `${deps.settings.target_dir}/${task.out_name}`,
    staging_path: finalPath,
    size: Number(stagedDownload.size ?? 0),
    sha256: String(stagedDownload.sha256 ?? ''),
    updated_at: nowRfc3339(),
  })

  // 完成：done + 记账（文件已 move 出暂存目录，无需清理；入库失败重试路径的残留
  // 会在下轮 copyFailure 重试或终态后由用户处理）。
  // move 不改内容：完整性字段沿用下载响应里宿主算好的值（CD2 目标无法重算 hash）。
  task.size = Number(stagedDownload.size ?? 0)
  task.sha256 = String(stagedDownload.sha256 ?? '')
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
    // 入库前同名预检：目标已有同名文件 → 终态失败（不再走 overwrite:false 的重试循环）。
    const residueTarget = `${settings.target_dir}/${task.out_name}`
    const residueOccupied = await fileExists(ctx, residueTarget)
    if (residueOccupied.ok && residueOccupied.exists) {
      await failFinal(deps, task, `目标已存在, 未入库: ${residueTarget}（同名文件已在目标目录, 请先处理后再重试）`, report)
      await persistTask(deps.kv, task)
      continue
    }
    try {
      await taskCheckpoint(ctx, {
        stage: 'before-move',
        task_ref: taskRefOf(ctx),
        song_id: task.id,
        out_name: task.out_name,
        target_dir: settings.target_dir,
        target_path: `${settings.target_dir}/${task.out_name}`,
        staging_path: task.staged_path,
        updated_at: nowRfc3339(),
      })
      await ctx.files.call({
        operation: 'move',
        path: task.staged_path,
        destination_dir: settings.target_dir,
        overwrite: false,
      })
      task.status = STATUS_DONE
      task.error = ''
      task.updated_ms = nowMs()
      await taskCheckpoint(ctx, {
        stage: 'after-move',
        task_ref: taskRefOf(ctx),
        song_id: task.id,
        out_name: task.out_name,
        target_dir: settings.target_dir,
        target_path: `${settings.target_dir}/${task.out_name}`,
        staging_path: task.staged_path,
        updated_at: nowRfc3339(),
      })
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

// ─────────────────────────── 中断恢复（recover） ───────────────────────────

/** 目标路径上是否有文件（exists 调用失败一律按「读不到」处理，不能猜）。 */
async function fileExists(ctx, path) {
  if (typeof path !== 'string' || path === '') return { ok: false, exists: false }
  try {
    const exists = await ctx.files.call({ operation: 'exists', path })
    return { ok: true, exists: exists === true }
  } catch {
    return { ok: false, exists: false }
  }
}

/** 读文件大小（stat 失败时拿不到，size 比对只能跳过）。 */
async function fileSize(ctx, path) {
  try {
    const info = await ctx.files.call({ operation: 'stat', path })
    return { ok: true, size: Number(info?.size ?? 0) }
  } catch {
    return { ok: false, size: 0 }
  }
}

/**
 * recover 判 complete 后，把 KV 队列里对应的在途任务收敛为 done。
 *
 * 直写 save_to 返回与 persistTask(done) 之间、after-move 检查点与 persistTask(done)
 * 之间被中断（或存储抖动）时，KV 还停在 downloading/copying，而文件已经落在目标
 * 目录：不回写的话下一轮 pump 会把残留当中断重排，同名预检看到的目标文件正是本
 * 任务刚落盘的 → 终态失败「目标已存在, 未下载」并误发失败通知。这里按检查点的
 * song_id（= 队列任务 id，runTask 写检查点时用 task.id 填的）把 task.<id> 与
 * tasks.idx 一并置 done，下一轮 pump 就不会再碰它。
 *
 * 只动在途状态（queued/downloading/copying）：done 不必重写；failed 不擅自翻案
 * （失败通知已发出，用户可能已按提示处理过目标文件）。记账失败吞掉不改判 ——
 * 文件已在目标目录是既成事实，complete 判定不因回写失败而变成 attention/resume。
 */
async function settleTaskDone(ctx, checkpoint) {
  const taskId = typeof checkpoint?.song_id === 'string' ? checkpoint.song_id.trim() : ''
  if (!taskId) return
  try {
    const kv = createKv(ctx)
    const task = await loadTask(kv, taskId)
    if (!task || task.status === STATUS_DONE || task.status === STATUS_FAILED) return
    task.status = STATUS_DONE
    task.error = ''
    task.job_ref = ''
    task.cd2_ref = ''
    // 文件的真实去向（直写分支与 runTask 的 done 落盘一致；回落分支原 staged_path
    // 指向的暂存文件已被 move 走，目标路径才是文件所在地）。
    if (typeof checkpoint?.target_path === 'string' && checkpoint.target_path) task.staged_path = checkpoint.target_path
    const size = Number(checkpoint?.size ?? 0)
    if (Number.isFinite(size) && size > 0) task.size = size
    if (typeof checkpoint?.sha256 === 'string' && checkpoint.sha256) task.sha256 = checkpoint.sha256
    task.updated_ms = nowMs()
    await persistTask(kv, task)
  } catch {
    /* KV 回写失败：保持 complete 判定，KV 残留交给下轮 pump 的既有兜底 */
  }
}

/**
 * 下载队列任务的中断恢复：先核对目标目录里的真实文件，再决定 complete / resume / attention。
 *
 * 判定口径（外部写 = 下载落盘 + 定名 + 入库 move）：
 * - stage=completed / done   → 整轮已跑完，complete（带摘要）。
 * - stage=after-move         → 目标文件在（且大小对得上）→ complete；不在 → resume。
 * - stage=before-move        → 目标在 → complete；暂存文件在 → resume（只重做定名+入库，
 *                              不重下，pump 的 copying 残留路径接管）；都不在 → attention。
 * - stage=after-download     → 直写分支：目标在 → complete，不在 → resume（可安全重下）；
 *                              暂存分支：目标在 → complete，暂存在 → resume（继续入库），
 *                              都不在 → attention（文件丢了，无法确认）。
 * - stage=before-download    → 目标最终名在 → complete（写已落地）；不在 → resume（可安全重下）。
 * - 无检查点                → 读 KV 队列：有 downloading/copying 在途 → resume；
 *                              没有 → complete（本轮没有外部写可核对）；读失败 → attention。
 * - 其它未知阶段（旧词表）  → resume（沿用「重跑一轮、幂等残留恢复」的既有语义）。
 *
 * 判 complete 的同时把 KV 队列任务收敛为 done（settleTaskDone）：run 级 completed
 * 检查点除外 —— 它由 queue-pump 在 pump 全部落盘之后才写，KV 本就已收敛。
 */
export async function recoverPump(ctx, checkpoint) {
  const stage = typeof checkpoint?.stage === 'string' ? checkpoint.stage : ''
  if (stage === 'completed' || stage === 'done') {
    return { action: 'complete', result: checkpoint.result ?? null }
  }
  const targetPath = typeof checkpoint?.target_path === 'string' ? checkpoint.target_path : ''
  const stagingPath = typeof checkpoint?.staging_path === 'string' ? checkpoint.staging_path : ''
  const result = {
    status: 'succeeded',
    song_id: checkpoint?.song_id ?? '',
    out_name: checkpoint?.out_name ?? '',
    path: targetPath,
  }
  switch (stage) {
    case 'after-move': {
      if (targetPath === '') return { action: 'attention' }
      const target = await fileExists(ctx, targetPath)
      if (!target.ok) return { action: 'attention' }
      if (!target.exists) return { action: 'resume' }
      const recorded = Number(checkpoint?.size ?? 0)
      if (recorded > 0) {
        const size = await fileSize(ctx, targetPath)
        if (size.ok && size.size !== recorded) return { action: 'attention' }
      }
      await settleTaskDone(ctx, checkpoint)
      return { action: 'complete', result }
    }
    case 'before-move': {
      if (targetPath === '') return { action: 'attention' }
      const target = await fileExists(ctx, targetPath)
      if (!target.ok) return { action: 'attention' }
      if (target.exists) {
        await settleTaskDone(ctx, checkpoint)
        return { action: 'complete', result }
      }
      const staged = await fileExists(ctx, stagingPath)
      if (!staged.ok) return { action: 'attention' }
      if (staged.exists) return { action: 'resume' }
      return { action: 'attention' }
    }
    case 'after-download': {
      if (checkpoint?.direct === true) {
        if (targetPath === '') return { action: 'attention' }
        const target = await fileExists(ctx, targetPath)
        if (!target.ok) return { action: 'attention' }
        if (!target.exists) return { action: 'resume' }
        await settleTaskDone(ctx, checkpoint)
        return { action: 'complete', result }
      }
      const target = targetPath === '' ? { ok: true, exists: false } : await fileExists(ctx, targetPath)
      if (!target.ok) return { action: 'attention' }
      if (target.exists) {
        await settleTaskDone(ctx, checkpoint)
        return { action: 'complete', result }
      }
      const staged = stagingPath === '' ? { ok: true, exists: false } : await fileExists(ctx, stagingPath)
      if (!staged.ok) return { action: 'attention' }
      if (staged.exists) return { action: 'resume' }
      return { action: 'attention' }
    }
    case 'before-download': {
      if (targetPath === '') return { action: 'attention' }
      const target = await fileExists(ctx, targetPath)
      if (!target.ok) return { action: 'attention' }
      if (!target.exists) return { action: 'resume' }
      await settleTaskDone(ctx, checkpoint)
      return { action: 'complete', result }
    }
    default:
      break
  }
  if (stage !== '') return { action: 'resume' }
  try {
    const index = await loadIndex(createKv(ctx))
    const inflight = index.some((entry) => entry.status === STATUS_DOWNLOADING || entry.status === STATUS_COPYING)
    return inflight ? { action: 'resume' } : { action: 'complete', result: null }
  } catch {
    return { action: 'attention' }
  }
}

// 供 jobs 复用的队列操作（re-export，保持 jobs 的导入面窄）。
export { retry, adopt, clearFinished, loadIndex, loadTask, persistTask, indexEntryOf, sortIndex, TASKS_IDX_KEY }
