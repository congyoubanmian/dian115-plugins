// 任务进度工具：task.* 的调用一律吞错（进度上报失败不能拖垮业务结果）。
export async function taskUpdate(ctx, payload) {
  try {
    await ctx.task?.update?.(payload)
  } catch {
    /* 进度上报失败不影响任务本身 */
  }
}

export async function taskCheckpoint(ctx, value) {
  try {
    await ctx.task?.checkpoint?.(value)
  } catch {
    /* 检查点失败不影响任务本身 */
  }
}

export async function taskLog(ctx, message) {
  try {
    await ctx.task?.log?.(message)
  } catch {
    /* 日志失败不影响任务本身 */
  }
}

/**
 * 外部写之前的检查点：落不下就不能写。recover 靠它判定「有没有开始写」——
 * 吞错继续写的话，中断后看到的是空检查点，会误判成「什么都没写」。
 * 宿主没有 ctx.task.checkpoint（非任务上下文）时视为成功：本来就没有恢复流程。
 */
export async function taskCheckpointRequired(ctx, value) {
  if (typeof ctx?.task?.checkpoint !== 'function') return { ok: true }
  try {
    await ctx.task.checkpoint(value)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error?.message || String(error) }
  }
}
