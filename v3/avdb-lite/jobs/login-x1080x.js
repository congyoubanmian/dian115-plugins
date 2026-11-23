// X1080X 登录：下载地址需要登录后才可见。
// 先用 FlareSolverr 过 Cloudflare（渲染登录页拿 login 用途的通行凭据），
// 把过盾 Cookie 注入共享浏览器，再让站点自己的 JS 处理 Turnstile 与登录请求。
// 每一步都写进 avdb-diag，页面「复制诊断」可一键取走。

import {
  normalizeSettings,
  log, solveChallenge, openBrowser, isAuthenticated, browserLogin, sampleResourceId
} from '../lib/site.js'

export async function run(ctx, input) {
  const settings = normalizeSettings(await ctx.storage.get('avdb-settings'))
  if (!settings.username || !settings.password) {
    throw new Error('请先在设置里填写 X1080X 用户名和密码')
  }

  try {
    // 每次尝试都重置诊断：失败在进入浏览器之前时，也要能看到本次的现场。
    await ctx.storage.set('avdb-diag', {
      at: new Date().toISOString(),
      steps: ['开始登录：FlareSolverr 过盾 → 共享浏览器 → 提交']
    })

    // 登录要用 login 这一种 pass：站点的通行凭据按用途区分，
    // 渲染首页拿到的是列表用的 pass，提交登录会被拒（browser_pass_required）。
    await ctx.task.update({ stage: 'cf', message: 'FlareSolverr 过 Cloudflare（登录页）…' })
    const net = await solveChallenge(ctx, settings, '/login?return=%2Fmember')

    await ctx.task.update({ stage: 'login', message: '打开共享浏览器并登录…' })
    const browser = await openBrowser(ctx, net)
    try {
      const sample = await sampleResourceId(ctx, browser.command, net.base)
      if (await isAuthenticated(ctx, browser.command, net.base, sample)) {
        await log(ctx, '已经登录，无需重新登录')
        return { already: true }
      }
      const ok = await browserLogin(ctx, browser.command, net, settings, sample)
      if (!ok) {
        throw new Error('登录未成功：账号密码不正确、需要人工验证，或浏览器被 Cloudflare 拦截（点「复制诊断」把详情发我）')
      }
      await log(ctx, '登录成功，登录态已保存在浏览器档案')
      return { ok: true }
    } finally {
      await browser.close()
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    const diag = (await ctx.storage.get('avdb-diag')) || { at: new Date().toISOString(), steps: [] }
    if (!diag.error) diag.error = message
    diag.jobError = message
    await ctx.storage.set('avdb-diag', diag)
    throw error
  }
}
