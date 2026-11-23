// X1080X 登录：下载地址需要登录后才可见。
// 先用 FlareSolverr 过 Cloudflare，把过盾 Cookie 注入共享浏览器，再走站点真实登录表单。
// 登录态保存在浏览器 profile 里；之后的抓取会在页面里重取受登录限制的条目。

import {
  normalizeSettings,
  log, solveChallenge, openBrowser, isAuthenticated, browserLogin, sampleResourceId
} from '../lib/site.js'

export async function run(ctx, input) {
  const settings = normalizeSettings(await ctx.storage.get('avdb-settings'))
  if (!settings.username || !settings.password) {
    throw new Error('请先在设置里填写 X1080X 用户名和密码')
  }

  await ctx.task.update({ stage: 'cf', message: 'FlareSolverr 过 Cloudflare…' })
  const { base, userAgent } = await solveChallenge(ctx, settings)

  await ctx.task.update({ stage: 'login', message: '打开共享浏览器并登录…' })
  const browser = await openBrowser(ctx, base, userAgent)
  try {
    const sample = await sampleResourceId(ctx, browser.command, base)
    if (await isAuthenticated(ctx, browser.command, base, sample)) {
      await log(ctx, '已经登录，无需重新登录')
      return { already: true }
    }
    const ok = await browserLogin(ctx, browser.command, base, settings, sample)
    if (!ok) throw new Error('登录未成功：账号密码不正确、需要人工验证，或浏览器被 Cloudflare 拦截')
    await log(ctx, '登录成功，登录态已保存在浏览器档案')
    return { ok: true }
  } finally {
    await browser.close()
  }
}
