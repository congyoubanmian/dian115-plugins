// 获取海报（action `get-poster` 的 v3 形态；镜像回退 + 128KiB 上限 + 插件文件缓存）。
// input: { poster_url: string }。
// 成功返回 {status:'succeeded', path, sha256, size, source_url}（path 为插件相对路径，
// 页面用 ctx.files.downloadURL 取图）；files 不可用时降级返回 dataURL。
// recover 固定 resume：同名同路径重写幂等，重跑不会产生副作用差异。
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
