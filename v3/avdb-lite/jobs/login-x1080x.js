// X1080X 登录：下载地址需要登录后才可见。
//
// 站点登录接口强制要 Turnstile token，token 只有在登录表单被填写之后才渲染，
// 而且必须由能过 Cloudflare 的真实浏览器签发——宿主那个共享无头浏览器解不动。
// 所以第一选择是本机的「登录助手」服务（同机跑一个真实浏览器把登录做完，
// 把登录后的 Cookie 与 UA 交回来）；失败再退回共享浏览器那条老路。
// 每一步都写进 avdb-diag，页面「复制诊断」可一键取走。

import {
  normalizeSettings,
  log, solveChallenge, openBrowser, isAuthenticated, browserLogin, sampleResourceId,
  serviceLogin
} from '../lib/site.js'

export async function run(ctx, input) {
  const settings = normalizeSettings(await ctx.storage.get('avdb-settings'))
  if (!settings.username || !settings.password) {
    throw new Error('请先在设置里填写 X1080X 用户名和密码')
  }

  const diag = { at: new Date().toISOString(), steps: [] }
  const note = async text => {
    diag.steps.push(String(text))
    await log(ctx, text)
  }

  try {
    // 每次尝试都重置诊断：失败在进入浏览器之前时，也要能看到本次的现场。
    await ctx.storage.set('avdb-diag', diag)

    // 登录要用 login 这一种 pass：站点的通行凭据按用途区分，
    // 渲染首页拿到的是列表用的 pass，提交登录会被拒（browser_pass_required）。
    await note('开始登录：登录助手 → 站点登录接口')
    await ctx.task.update({ stage: 'login', message: '登录助手里登录中…' })

    try {
      const session = await serviceLogin(ctx, settings)
      for (const step of session.steps) await note('助手：' + step)
      await ctx.storage.set('avdb-session', {
        cookieHeader: session.cookieHeader,
        userAgent: session.userAgent,
        at: new Date().toISOString()
      })
      await note('登录成功（登录助手）')
      await ctx.storage.set('avdb-diag', diag)
      return { ok: true, via: 'service' }
    } catch (error) {
      await note('登录助手失败：' + (error && error.message ? error.message : error))
    }

    // 退路：共享浏览器里走站点真实登录表单
    await ctx.task.update({ stage: 'cf', message: 'FlareSolverr 过 Cloudflare（登录页）…' })
    const net = await solveChallenge(ctx, settings, '/login?return=%2Fmember')
    await ctx.task.update({ stage: 'login', message: '打开共享浏览器并登录…' })
    const browser = await openBrowser(ctx, net)
    try {
      const sample = await sampleResourceId(ctx, browser.command, net.base)
      if (await isAuthenticated(ctx, browser.command, net.base, sample)) {
        await note('已经登录，无需重新登录')
        await ctx.storage.set('avdb-diag', diag)
        return { already: true }
      }
      const ok = await browserLogin(ctx, browser.command, net, settings, sample)
      if (!ok) {
        throw new Error('登录未成功：账号密码不正确、需要人工验证，或浏览器被 Cloudflare 拦截（点「复制诊断」把详情发我）')
      }
      await note('登录成功，登录态已保存在浏览器档案')
      await ctx.storage.set('avdb-diag', diag)
      return { ok: true, via: 'browser' }
    } finally {
      await browser.close()
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    const stored = (await ctx.storage.get('avdb-diag')) || diag
    if (!stored.error) stored.error = message
    stored.jobError = message
    await ctx.storage.set('avdb-diag', stored)
    throw error
  }
}
