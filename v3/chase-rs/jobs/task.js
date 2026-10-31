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
