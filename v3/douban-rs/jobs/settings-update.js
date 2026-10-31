// 保存设置（action `settings-update` 的 v3 形态）。
// input: 设置补丁（扁平键 + lists/blacklist/regions/subscribe_source_filter 等文档节）。
import { Session, settingsUpdate } from './runtime.js'

export async function run(ctx, input) {
  const session = await Session.open(ctx)
  return settingsUpdate(session, input ?? {})
}

export async function recover(ctx, checkpoint) {
  void ctx
  void checkpoint
  return { action: 'resume' }
}
