// 下载管线（pump 状态机）—— 从 plugins/music-rs/src/download.rs 移植。
//
// 旧版两段式「宿主代下载 job + 轮询 + 跨边界复制」在 v3 收敛成一条同步管线
// （developer-guide §文件与 CD2 的官方推荐形态）：
//
//   1. 取链接   netease eapi 阶梯 / QQ 阶梯（lib/music-api.js resolveSongUrl）；
//   2. 下载     API 3.9 起 save_to 直写目标目录（宿主先写临时文件、成功后改名）；
//               宿主不开放直写（403/405/501 或明确「不支持」）时回落：
//               save_to:'downloads/<短id>.part' 暂存 → 定名 → move；
//   3. 定名     ctx.files.call({operation:'rename'}) → "{singers} - {name}.{ext}"；
//   4. 入库     ctx.files.call({operation:'move', destination_dir: target_dir, overwrite:false}) ——
//               宿主按 CD2 挂载前缀自动分流（CD2 gRPC 或系统命令），带字节进度；
//   5. 通知     尝试次数用尽 / 终态失败 → ctx.notify（level=error，buttons 带 retry:<短id>）。
//
// 下载/入库前的同名预检（files.exists）：目标目录已有同名文件 → 直接终态失败
// （错误写明路径，failFinal），不进「move overwrite:false 撞墙 → copyFailure 重试
// 到 MAX_ATTEMPTS」的循环。exists 读不到（能力缺失/调用失败）时不直写（直写成功会
// 覆盖同名文件），改走「暂存 → move overwrite:false」，由宿主兜底不覆盖。
// 失败的下载绝不删除目标路径上的文件：非 2xx 宿主本就不落文件；只有 2xx 空文件、
// 且预检确认目标原本不存在时，才删掉本任务刚写出的空文件。
// save_to 响应里的 size/sha256（宿主对落盘文件算好的值）记进任务可追溯；
// 索引条目不投影这两个字段（indexEntryOf 只挑固定字段，索引保持紧凑）。
//
// 状态机语义与旧版一致：queued → downloading → copying → done / failed；
// MAX_ATTEMPTS=3；失败回 queued（attempts<3）或终态 failed + 通知。
// 与旧版的差异（如实记录）：
// - save_to 是同步的，单轮 pump 按顺序推进到 max_active 首（旧版每轮最多新开 1 首），
//   同一轮里每个任务最多尝试一次（失败回队的等下一轮），并受单轮时间预算约束；
// - 「downloading」状态在 pump 开始时出现即视为上一轮被宿主中断的残留（不允许重叠），
//   按 fail_task 语义计数并回队。

import { STATUS_QUEUED, STATUS_DOWNLOADING, STATUS_COPYING, STATUS_DONE, STATUS_FAILED, MAX_ATTEMPTS, TASKS_IDX_KEY, indexEntryOf, sortIndex, outName, displayName } from './tasks-core.js'
import { loadIndex, loadTask, persistTask, retry, adopt, clearFinished } from './queue-store.js'
import { createKv } from './kv.js'
import { resolveSongUrl } from './music-api.js'
import { nowMs, nowRfc3339 } from './encoding.js'
import { taskCheckpoint, taskUpdate } from './task.js'
import { channelSummary } from './notify-summary.js'

export { channelSummary }

/** 暂存目录（插件自有文件，相对路径）。 */
export const STAGING_SUBDIR = 'downloads'
/** 每个直链下载的超时（秒）。 */
export const DOWNLOAD_TIMEOUT_SECONDS = 600
/** 单轮 pump 新开下载的时间预算（毫秒）：清单 timeout_seconds=1800，留出一个完整下载
 *  超时（600 秒）加收尾余量，超过预算就把剩下的排队任务留给下一轮，避免整轮被宿主超时打断。 */
export const PUMP_START_BUDGET_MS = (1800 - DOWNLOAD_TIMEOUT_SECONDS - 120) * 1000

/** 任务引用：写进检查点，把检查点与某次运行绑定。 */
function taskRefOf(ctx) {
  return typeof ctx?.task?.id === 'string' ? ctx.task.id : ''
}

/** 扩展名兜底（取链没给 type 时按 flac，与 sidecar 默认一致）。 */
export function normalizeExt(ext) {
  const cleaned = String(ext ?? '').trim().replace(/^\./, '').toLowerCase()
  return cleaned || 'flac'
}

/** 目标文件名（真实扩展名到手后定名；清洗与 200 字节截断规则见 tasks-core.outName）。 */
export function targetName(task, ext) {
  return outName(task.singers ?? '', task.name ?? '', normalizeExt(ext))
}

/** 目录 + 文件名（目录结尾的 / 不重复）。 */
export function joinPath(dir, name) {
  const base = String(dir ?? '').replace(/\/+$/, '')
  return `${base}/${name}`
}

/** save_to 直写失败是否像「宿主没开放直写能力 / 路径不允许直写」（这时才回落暂存 → move）。
 *  连接失败、超时等网络错误不算：回落只会把同一个下载再跑一遍。 */
export function looksLikeDirectWriteUnsupported(error) {
  const status = Number(error?.status)
  if (status === 403 || status === 405 || status === 501) return true
  const message = String(error?.message ?? error ?? '')
  return /api\s*3\.9|requires\.api|不支持|未开放|不允许|受保护|unsupported|not supported|not allowed|protected path/i.test(message)
}

/** save_to 的结果是否是失败（非 2xx 宿主不写文件、作为 status 返回）。 */
function downloadFailure(result) {
  const status = Number(result?.status)
  if (Number.isFinite(status) && status !== 0 && (status < 200 || status >= 300)) {
    return `HTTP ${status} ${truncateChars(result?.body ?? '', 200)}`.trim()
  }
  if (result?.size === 0) return '下载结果是空文件(直链可能已失效)'
  return ''
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

/** 删掉本任务自己写出的空文件（调用方保证预检已确认目标原本不存在，不会是用户原有文件）。 */
async function removeOwnEmptyFile(ctx, path) {
  if (!path) return
  try {
    await ctx.files.call({ operation: 'remove', paths: [path] })
  } catch {
    /* 空文件残留由用户处理，不影响任务失败语义 */
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

/** 失败通知的去重键：每次「终态失败」是一个独立事件。
 *  notifications.md：相同键 + 不同内容返回冲突、相同键 + 相同内容直接返回上次结果，
 *  所以只用任务 id 当键会让用户点「重试」后的第二次失败发不出去（错误文本不同 → 冲突；
 *  相同 → 静默复用旧结果）。键里带 retry_round（用户每次重试 +1）与 attempts：同一次
 *  终态失败的重放（job 中断后 resume 重跑）仍命中同键、不重复打扰。 */
export function failureDedupeKey(task) {
  return `dl-fail-${task.id}-r${task.retry_round ?? 0}-a${task.attempts ?? 0}`
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
      dedupe_key: failureDedupeKey(task),
      // v3 通知支持 callback_data 按钮（仅 Telegram）：用户点击触发清单 event=callback 的任务。
      buttons: [[{ text: '重试', callback_data: `retry:${task.id}` }]],
    })
    const channels = channelSummary(outcome)
    const verb = outcome?.suppressed ? '失败通知未发送' : outcome?.deduplicated ? '失败通知已去重' : '失败通知已提交'
    if (channels) report.messages.push(`任务 ${task.id} ${verb} · 通道: ${channels}`)
  } catch (err) {
    report.messages.push(`任务 ${task.id} 失败通知发送失败: ${err?.message ?? err}`)
  }
}

function truncateChars(text, limit) {
  const chars = [...String(text ?? '')]
  return chars.length <= limit ? chars.join('') : chars.slice(0, limit).join('')
}

/** 同名预检用的存在性查询（exists 调用失败一律按「读不到」处理，不能猜）。 */
async function fileExists(ctx, path) {
  if (typeof path !== 'string' || path === '') return { ok: false, exists: false }
  try {
    const exists = await ctx.files.call({ operation: 'exists', path })
    return { ok: true, exists: exists === true }
  } catch {
    return { ok: false, exists: false }
  }
}

/** 同名预检的终态失败文案（错误写明路径）。 */
function occupiedError(verb, path) {
  return `目标已存在, ${verb}: ${path}（同名文件已在目标目录, 请先处理后再重试）`
}

/**
 * 启动一个排队任务：取链接 → 下载（直写或暂存）→ 定名 → 入库（一条龙，状态逐段落盘）。
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
  const targetDir = deps.settings.target_dir
  const directPath = joinPath(targetDir, task.out_name)
  // 同名预检（files.exists）：目标目录里已有同名文件 → 终态失败（错误写明路径），
  // 不下载也不重试 —— 这类失败重试不会变（move overwrite:false 只会反复撞墙）。
  const occupied = await fileExists(ctx, directPath)
  if (occupied.ok && occupied.exists) {
    await failFinal(deps, task, occupiedError('未下载', directPath), report)
    await persistTask(deps.kv, task)
    return
  }
  // 写前检查点：超时 / 重启 / 调用失败都不能证明这次下载没发生 —— 落一条
  // 「准备把哪首歌写到哪里」，恢复时拿它去核对目标目录里的真实文件。
  // target_checked=false：预检没读到目标目录，恢复时目标在也不能断定是本任务写的。
  await taskCheckpoint(ctx, {
    stage: 'before-download',
    task_ref: taskRefOf(ctx),
    song_id: task.id,
    out_name: task.out_name,
    target_dir: targetDir,
    target_path: directPath,
    staging_path: `${STAGING_SUBDIR}/${partName}`,
    target_checked: occupied.ok,
    updated_at: nowRfc3339(),
  })
  // API 3.9（requires.api=3.9）：save_to 可直写宿主/CD2 目标目录 —— 省一次跨盘拷贝。
  // 能力判断以宿主上报的 host_api 为准；真失败时只有「像是能力没开放」才回落
  // 「暂存 → 定名 → move」，其余按下载失败处理（避免把网络错误当成能力缺失重下一遍）。
  // 预检读不到目标目录时不直写：直写成功会覆盖同名文件，回落的 move overwrite:false 不会。
  const directSupported = hostApiAtLeast(ctx.plugin?.host_api, 3, 9) && occupied.ok
  if (directSupported) {
    let download = null
    try {
      download = await deps.http.request({
        url: song.url,
        method: 'GET',
        save_to: directPath,
        timeout_seconds: DOWNLOAD_TIMEOUT_SECONDS,
      })
    } catch (error) {
      if (!looksLikeDirectWriteUnsupported(error)) {
        await failTask(deps, task, `下载失败: ${error?.message ?? error}`, report)
        await persistTask(deps.kv, task)
        return
      }
      report.messages.push(`任务 ${task.id} 目标目录不能直写(${truncateChars(error?.message ?? error, 120)}), 改走暂存 → move`)
    }
    if (download) {
      const failure = downloadFailure(download)
      if (failure) {
        // 非 2xx：宿主不落文件，目标路径上的东西都不是本任务写的，绝不删除。
        // 2xx 空文件：预检已确认目标原本不存在，这个空文件是本任务刚写的，删掉。
        if (download.size === 0) await removeOwnEmptyFile(ctx, directPath)
        await failTask(deps, task, `下载失败: ${failure}`, report)
        await persistTask(deps.kv, task)
        return
      }
      // 直写成功：文件已在目标目录，不需要定名与 move。
      // 宿主对 save_to 响应算好的完整性字段记进任务（done 任务可追溯；索引条目不投影这两项）。
      const landed = typeof download.path === 'string' && download.path ? download.path : directPath
      task.staged_path = landed
      task.size = Number(download.size ?? 0)
      task.sha256 = String(download.sha256 ?? '')
      markDone(task, report)
      await persistTask(deps.kv, task)
      // 写后检查点：文件已确认落在目标目录（直写分支没有 move 段）。
      await taskCheckpoint(ctx, {
        stage: 'after-download',
        task_ref: taskRefOf(ctx),
        song_id: task.id,
        out_name: task.out_name,
        target_dir: targetDir,
        target_path: directPath,
        staging_path: '',
        direct: true,
        path: landed,
        size: task.size,
        sha256: task.sha256,
        updated_at: nowRfc3339(),
      })
      return
    }
  }
  // 回落路径：暂存 → 定名 → move（老宿主、目标目录不可直写或预检读不到时走这里）。
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
  const stagedFailure = downloadFailure(stagedDownload)
  if (stagedFailure) {
    if (stagedDownload.size === 0) await cleanupStaged(ctx, task.id)
    await failTask(deps, task, `下载失败: ${stagedFailure}`, report)
    await persistTask(deps.kv, task)
    return
  }
  const staged = typeof stagedDownload.path === 'string' && stagedDownload.path ? stagedDownload.path : `${STAGING_SUBDIR}/${partName}`
  task.staged_path = staged
  // move 不改内容：完整性字段沿用下载响应里宿主算好的值（CD2 目标无法重算 hash）。
  task.size = Number(stagedDownload.size ?? 0)
  task.sha256 = String(stagedDownload.sha256 ?? '')
  task.status = STATUS_COPYING
  task.updated_ms = nowMs()
  await persistTask(deps.kv, task)
  // 写后检查点：文件已确认落盘（还在暂存目录，等着入库）。
  await taskCheckpoint(ctx, {
    stage: 'after-download',
    task_ref: taskRefOf(ctx),
    song_id: task.id,
    out_name: task.out_name,
    target_dir: targetDir,
    target_path: directPath,
    staging_path: staged,
    direct: false,
    path: staged,
    size: task.size,
    sha256: task.sha256,
    updated_at: nowRfc3339(),
  })
  await finishStaged(ctx, deps, task, report)
}

/**
 * 暂存文件入库：（必要时）定名 → 同名预检 → move 进目标目录 → done。
 * 新下载与 copying 残留共用：残留可能停在 .part（定名前被打断）或已定名（move 前被打断）。
 * 定名后立刻把新路径落盘 —— 否则下轮重试还拿着旧的 .part 路径去 move，必然「文件不存在」。
 */
async function finishStaged(ctx, deps, task, report) {
  const targetDir = deps.settings.target_dir
  const stagedName = String(task.staged_path).split('/').pop()
  const outFile = task.out_name || stagedName
  const moveTarget = joinPath(targetDir, outFile)

  // 暂存文件已不在：可能上一轮 move 其实成功了、只是没来得及落盘。
  // 只有定名已完成（暂存名 = 目标名）且目标在时才认；否则回队重新下载。
  const stagedState = await fileExists(ctx, task.staged_path)
  if (stagedState.ok && !stagedState.exists) {
    if (stagedName === outFile && (await fileExists(ctx, moveTarget)).exists) {
      task.staged_path = moveTarget
      markDone(task, report)
      await persistTask(deps.kv, task)
      return
    }
    task.staged_path = ''
    await failTask(deps, task, '暂存文件不见了, 重新下载', report)
    await persistTask(deps.kv, task)
    return
  }

  if (stagedName !== outFile) {
    try {
      const renamed = await ctx.files.call({ operation: 'rename', path: task.staged_path, name: outFile })
      const dir = String(task.staged_path).split('/').slice(0, -1).join('/') || STAGING_SUBDIR
      task.staged_path = renamed?.path ? renamed.path : `${dir}/${outFile}`
      task.out_name = outFile
      task.updated_ms = nowMs()
      await persistTask(deps.kv, task)
    } catch (error) {
      await copyFailure(deps, task, `定名失败: ${error?.message ?? error}`, report)
      await persistTask(deps.kv, task)
      return
    }
  }

  // move 前的同名预检：下载耗时里目标可能被其它任务/用户占用，重查一次，
  // 已存在则终态失败（不进 overwrite:false 的撞墙-重试循环；暂存文件保留给用户处理）。
  const occupied = await fileExists(ctx, moveTarget)
  if (occupied.ok && occupied.exists) {
    await failFinal(deps, task, occupiedError('未入库', moveTarget), report)
    await persistTask(deps.kv, task)
    return
  }
  // 入库前检查点：目标目录与文件名，恢复时据此核对文件是否已经在目标目录。
  await taskCheckpoint(ctx, {
    stage: 'before-move',
    task_ref: taskRefOf(ctx),
    song_id: task.id,
    out_name: outFile,
    target_dir: targetDir,
    target_path: moveTarget,
    staging_path: task.staged_path,
    updated_at: nowRfc3339(),
  })
  // 入库：交给宿主 move 到目标目录（CD2 挂载自动分流；目标已存在默认失败不覆盖）。
  try {
    await ctx.files.call({
      operation: 'move',
      path: task.staged_path,
      destination_dir: targetDir,
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
    out_name: outFile,
    target_dir: targetDir,
    target_path: moveTarget,
    staging_path: task.staged_path,
    size: Number(task.size ?? 0),
    sha256: String(task.sha256 ?? ''),
    updated_at: nowRfc3339(),
  })
  task.staged_path = moveTarget
  markDone(task, report)
  await persistTask(deps.kv, task)
}

/** 置 done（文件已在目标目录，无需清理）。 */
function markDone(task, report) {
  task.status = STATUS_DONE
  task.job_ref = ''
  task.cd2_ref = ''
  task.error = ''
  task.updated_ms = nowMs()
  report.completed.push(task.id)
  report.messages.push(`任务 ${task.id} 完成: ${task.out_name}`)
}

/** 上报任务级进度（developer-guide「任务队列与进度」：total/done/failed，宿主按计数算进度）。
 *  failed = 本轮处理过但没完成的（含回队待重试）。上报失败不影响下载本身。 */
async function progress(ctx, message, report) {
  const total = Math.max(report.planned, report.handled)
  const done = Math.min(report.completed.length, report.handled)
  await taskUpdate(ctx, { stage: 'pump', message: truncateChars(message, 200), total, done, failed: report.handled - done })
}

/** 宿主是否已要求停止（停用 / 卸载 / 超时取消）：停止新开下载，把剩下的留给下一轮。 */
function aborted(ctx) {
  return ctx?.signal?.aborted === true
}

/**
 * 推进 KV 任务队列（旧 download.rs pump 的 v3 形态）。
 *
 * 顺序：恢复中断的 downloading 残留 → 推进 copying 残留 → 按队列序逐首推进 queued
 * （单轮最多新开 max_active 首、每首最多试一次、受时间预算约束）→ 返回摘要。
 * 每类工作都在独立作用域里处理单条任务。
 *
 * 返回摘要 {queued, active, started, completed, failed, messages}。
 */
export async function pump(ctx, deps) {
  const report = { messages: [], started: [], completed: [], failed: [], planned: 0, handled: 0 }
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

  // ② 推进 copying 残留（定名/入库被打断或失败）：重试入库不重新下载。
  const copying = index.filter((entry) => entry.status === STATUS_COPYING).map((entry) => entry.id)
  const queuedAtStart = (await loadIndex(deps.kv)).filter((entry) => entry.status === STATUS_QUEUED).length
  report.planned = copying.length + Math.min(queuedAtStart, Math.max(1, settings.max_active))
  for (const taskId of copying) {
    if (aborted(ctx)) break
    const task = await loadTask(deps.kv, taskId)
    if (!task || task.status !== STATUS_COPYING) continue
    if (!task.staged_path) {
      await failTask(deps, task, '缺少暂存文件路径, 重新下载', report)
      await persistTask(deps.kv, task)
      continue
    }
    await progress(ctx, `入库 ${displayName(task)}`, report)
    await finishStaged(ctx, deps, task, report)
    report.handled += 1
  }

  // ③ 新开下载：按队列序（索引 updated_ms 倒序 = pump 从头取 queued）逐首推进，
  //    单轮最多新开 max_active 首。本轮已经试过的任务不再挑（失败回队的任务等下一轮重试，
  //    不在同一轮里连烧 3 次尝试）；超出时间预算或宿主要求停止就停，剩下的留给下一轮。
  //    迭代上限 = 索引长度 + 2：索引与分片不一致（状态损坏）时宁可停下报错，绝不自旋。
  const cap = Math.max(1, settings.max_active)
  const startedAt = nowMs()
  const tried = new Set()
  let startedCount = 0
  let cursor = await loadIndex(deps.kv)
  const maxIterations = cursor.length + 2
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const pending = cursor.filter((entry) => entry.status === STATUS_QUEUED && !tried.has(entry.id))
    if (aborted(ctx) || startedCount >= cap || (startedCount > 0 && nowMs() - startedAt > PUMP_START_BUDGET_MS)) {
      if (pending.length > 0) {
        report.messages.push(`${pending.length} 个排队任务等待下一轮(本轮已新开 ${startedCount}/${cap})`)
      }
      break
    }
    const nextId = pending[0]?.id
    if (!nextId) break
    tried.add(nextId)
    const task = await loadTask(deps.kv, nextId)
    if (!task || task.status !== STATUS_QUEUED) {
      // 索引与分片不一致（分片缺失或状态漂移）：停止本轮，提示人工对账（task-adopt）。
      report.messages.push(`任务 ${nextId} 的索引条目与分片状态不一致, 本轮停止推进(可尝试「索引对账」)`)
      break
    }
    startedCount += 1
    await progress(ctx, `下载 ${displayName(task)}`, report)
    await runTask(ctx, deps, task, report)
    report.handled += 1
    cursor = await loadIndex(deps.kv)
  }
  if (report.planned > 0) await progress(ctx, '本轮推进结束', report)

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
 * - stage=before-download    → 目标最终名在 → complete（写已落地；预检未读到目标目录时
 *                              target_checked=false → attention，可能是用户原有文件）；
 *                              不在 → resume（可安全重下）。
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
      // 写前预检没读到目标目录（target_checked=false）：目标上的文件可能是用户原有的，
      // 不能当成本任务的写已落地。
      if (checkpoint?.target_checked === false) return { action: 'attention' }
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
