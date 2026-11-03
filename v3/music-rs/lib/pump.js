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

import { STATUS_QUEUED, STATUS_DOWNLOADING, STATUS_COPYING, STATUS_DONE, STATUS_FAILED, MAX_ATTEMPTS, TASKS_IDX_KEY, indexEntryOf, sortIndex, outName, withNameSuffix, displayName } from './tasks-core.js'
import { loadIndex, loadTask, persistTask, retry, adopt, clearFinished } from './queue-store.js'
import { normalizeSettings } from './settings.js'
import { resolveSongUrl } from './music-api.js'
import { nowMs } from './encoding.js'
import { channelSummary } from './notify-summary.js'

export { channelSummary }

/** 暂存目录（插件自有文件，相对路径）。 */
export const STAGING_SUBDIR = 'downloads'
/** 每个直链下载的超时（秒）。 */
export const DOWNLOAD_TIMEOUT_SECONDS = 600
/** 单轮 pump 新开下载的时间预算（毫秒）：清单 timeout_seconds=1800，留出一个完整下载
 *  超时（600 秒）加收尾余量，超过预算就把剩下的排队任务留给下一轮，避免整轮被宿主超时打断。 */
export const PUMP_START_BUDGET_MS = (1800 - DOWNLOAD_TIMEOUT_SECONDS - 120) * 1000
/** 同名去重最多试到「 (N)」。 */
export const NAME_SUFFIX_LIMIT = 50

/** 扩展名兜底（取链没给 type 时按 flac，与 sidecar 默认一致）。 */
export function normalizeExt(ext) {
  const cleaned = String(ext ?? '').trim().replace(/^\./, '').toLowerCase()
  return cleaned || 'flac'
}

/** 目标文件名（真实扩展名到手后定名；清洗规则见 tasks-core.outName）。 */
export function targetName(task, ext) {
  return outName(task.singers ?? '', task.name ?? '', normalizeExt(ext))
}

/** 目录 + 文件名（目录结尾的 / 不重复）。 */
export function joinPath(dir, name) {
  const base = String(dir ?? '').replace(/\/+$/, '')
  return `${base}/${name}`
}

/** files.exists 的容错包装：宿主报错时返回 null（未知），由调用方决定保守分支。 */
async function existsSafe(ctx, path) {
  try {
    return (await ctx.files.call({ operation: 'exists', path })) === true
  } catch {
    return null
  }
}

/** 在目标目录里挑一个不与已有文件重名的文件名（`a.flac` → `a (2).flac` …）。
 *  直写会覆盖同名文件、move 遇同名会失败，两种都不是想要的：不同歌曲同名（翻唱、
 *  现场版）时都保留。宿主读不到存在性时按原名继续（move 仍是 overwrite:false 兜底）。 */
export async function uniqueTargetName(ctx, dir, fileName) {
  for (let n = 1; n <= NAME_SUFFIX_LIMIT; n++) {
    const candidate = withNameSuffix(fileName, n)
    const exists = await existsSafe(ctx, joinPath(dir, candidate))
    if (exists !== true) return candidate
  }
  throw new Error(`目标目录里同名文件过多（${fileName} 已到 (${NAME_SUFFIX_LIMIT})）`)
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

/** 删掉本任务自己写出的无效文件（空文件；文件名已经过 uniqueTargetName，不会是用户原有文件）。
 *  非 2xx / 抛错时宿主不落文件（临时文件由宿主清理，network.md），不需要也不应该去删目标路径。 */
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
  // API 3.9（requires.api=3.9）：save_to 可直写宿主/CD2 目标目录 —— 省一次跨盘拷贝。
  // 能力判断以宿主上报的 host_api 为准；真失败时只有「像是能力没开放」才回落
  // 「暂存 → 定名 → move」，其余按下载失败处理（避免把网络错误当成能力缺失重下一遍）。
  const directSupported = hostApiAtLeast(ctx.plugin?.host_api, 3, 9)
  if (directSupported) {
    // 直写会覆盖目标目录里的同名文件：先挑一个不重名的文件名。
    let directName
    try {
      directName = await uniqueTargetName(ctx, deps.settings.target_dir, task.out_name)
    } catch (error) {
      await failTask(deps, task, error?.message ?? String(error), report)
      await persistTask(deps.kv, task)
      return
    }
    const directPath = joinPath(deps.settings.target_dir, directName)
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
        if (download.size === 0) await removePartial(ctx, directPath)
        await failTask(deps, task, `下载失败: ${failure}`, report)
        await persistTask(deps.kv, task)
        return
      }
      // 直写成功：文件已在目标目录，不需要定名与 move。
      task.out_name = directName
      task.staged_path = typeof download.path === 'string' && download.path ? download.path : directPath
      task.status = STATUS_DONE
      task.job_ref = ''
      task.cd2_ref = ''
      task.error = ''
      task.updated_ms = nowMs()
      await persistTask(deps.kv, task)
      report.completed.push(task.id)
      report.messages.push(`任务 ${task.id} 完成: ${task.out_name}`)
      return
    }
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
  const stagedFailure = downloadFailure(stagedDownload)
  if (stagedFailure) {
    if (stagedDownload.size === 0) await cleanupStaged(ctx, task.id)
    await failTask(deps, task, `下载失败: ${stagedFailure}`, report)
    await persistTask(deps.kv, task)
    return
  }
  task.staged_path = typeof stagedDownload.path === 'string' && stagedDownload.path ? stagedDownload.path : `${STAGING_SUBDIR}/${partName}`
  task.status = STATUS_COPYING
  task.updated_ms = nowMs()
  await persistTask(deps.kv, task)
  await finishStaged(ctx, deps, task, report)
}

/**
 * 暂存文件入库：（必要时）定名成目标目录里不重名的文件名 → move 进目标目录 → done。
 * 新下载与 copying 残留共用：残留可能停在 .part（定名前被打断）或已定名（move 前被打断）。
 * 定名后立刻把新路径落盘 —— 否则下轮重试还拿着旧的 .part 路径去 move，必然「文件不存在」。
 */
async function finishStaged(ctx, deps, task, report) {
  const targetDir = deps.settings.target_dir
  const stagedName = String(task.staged_path).split('/').pop()

  // 暂存文件已不在：可能上一轮 move 其实成功了、只是没来得及落盘。
  const stagedExists = await existsSafe(ctx, task.staged_path)
  if (stagedExists === false) {
    if (task.out_name && stagedName === task.out_name && (await existsSafe(ctx, joinPath(targetDir, task.out_name))) === true) {
      markDone(task, report)
      await persistTask(deps.kv, task)
      return
    }
    // 真丢了：回队重新下载（attempts 已在启动时计过）。
    task.staged_path = ''
    await failTask(deps, task, '暂存文件不见了, 重新下载', report)
    await persistTask(deps.kv, task)
    return
  }

  let finalName
  try {
    finalName = await uniqueTargetName(ctx, targetDir, task.out_name || stagedName)
  } catch (error) {
    await copyFailure(deps, task, error?.message ?? String(error), report)
    await persistTask(deps.kv, task)
    return
  }
  if (stagedName !== finalName) {
    try {
      const renamed = await ctx.files.call({ operation: 'rename', path: task.staged_path, name: finalName })
      const dir = String(task.staged_path).split('/').slice(0, -1).join('/') || STAGING_SUBDIR
      task.staged_path = renamed?.path ? renamed.path : `${dir}/${finalName}`
      task.out_name = finalName
      task.updated_ms = nowMs()
      await persistTask(deps.kv, task)
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
      path: task.staged_path,
      destination_dir: targetDir,
      overwrite: false,
    })
  } catch (error) {
    await copyFailure(deps, task, `入库失败: ${error?.message ?? error}`, report)
    await persistTask(deps.kv, task)
    return
  }
  markDone(task, report)
  await persistTask(deps.kv, task)
}

/** 置 done（文件已 move 出暂存目录，无需清理）。 */
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
  if (typeof ctx?.task?.update !== 'function') return
  const total = Math.max(report.planned, report.handled)
  const done = Math.min(report.completed.length, report.handled)
  try {
    await ctx.task.update({ stage: 'pump', message: truncateChars(message, 200), total, done, failed: report.handled - done })
  } catch {
    // 进度只是展示用。
  }
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
  //    不在同一轮里连烧 3 次尝试）；超出时间预算就停，剩下的留给下一轮。
  //    迭代上限 = 索引长度 + 2：索引与分片不一致（状态损坏）时宁可停下报错，绝不自旋。
  const cap = Math.max(1, settings.max_active)
  const startedAt = nowMs()
  const tried = new Set()
  let startedCount = 0
  let cursor = await loadIndex(deps.kv)
  const maxIterations = cursor.length + 2
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const pending = cursor.filter((entry) => entry.status === STATUS_QUEUED && !tried.has(entry.id))
    if (startedCount >= cap || (startedCount > 0 && nowMs() - startedAt > PUMP_START_BUDGET_MS)) {
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

// 供 jobs 复用的队列操作（re-export，保持 jobs 的导入面窄）。
export { retry, adopt, clearFinished, loadIndex, loadTask, persistTask, indexEntryOf, sortIndex, TASKS_IDX_KEY }
