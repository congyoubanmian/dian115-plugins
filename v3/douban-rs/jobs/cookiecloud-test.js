// CookieCloud 连接测试（action `cookiecloud-test` 的 v3 形态；成功顺便预热解密缓存）。
import { Session } from './runtime.js'
import { actionCookieCloudTest } from './cookiecloud.js'

export async function run(ctx) {
  const session = await Session.open(ctx)
  return actionCookieCloudTest(session, ctx)
}

export async function recover(ctx, checkpoint) {
  void ctx
  void checkpoint
  return { action: 'resume' }
}
