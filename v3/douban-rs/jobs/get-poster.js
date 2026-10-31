// 获取海报（action `get-poster` 的 v3 形态；镜像回退 + 128KiB 上限 + dataURL 缓存）。
// input: { poster_url: string }。
import { Session } from './runtime.js'
import { getPoster } from './poster.js'

export async function run(ctx, input) {
  const session = await Session.open(ctx)
  const result = await getPoster(session, ctx, input ?? {})
  return result
}

export async function recover(ctx, checkpoint) {
  void ctx
  void checkpoint
  return { action: 'resume' }
}
