// X1080X 登录：用共享浏览器打开登录页，自动填入用户名/密码并提交。
// 登录成功后 Cookie 持久保存在浏览器 profile 中，后续抓取自动带上。

const BASE = 'https://x1080x.com'
const PROFILE = 'x1080x'

function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  return {
    username: String(value.username || '').trim(),
    password: String(value.password || ''),
    proxy_mode: ['system', 'direct', 'custom'].includes(value.proxy_mode) ? value.proxy_mode : 'system',
    proxy_url: String(value.proxy_url || '').trim()
  }
}

async function log(ctx, text) {
  try { await ctx.task.log(String(text).slice(0, 4000)) } catch (_) {}
}

export async function run(ctx, input) {
  const settings = normalizeSettings(await ctx.storage.get('avdb-settings'))
  if (!settings.username || !settings.password) {
    throw new Error('请先在设置里填写 X1080X 用户名和密码')
  }

  await ctx.task.update({ stage: 'browser', message: '打开共享浏览器…' })

  const status = await ctx.browser.status()
  if (!status.available) {
    throw new Error(status.error || `浏览器运行包未就绪（state=${status.state}）`)
  }

  const openOptions = { profile: PROFILE, timeout_seconds: 30 }
  if (settings.proxy_mode === 'direct') openOptions.proxy_mode = 'direct'
  else if (settings.proxy_mode === 'custom' && settings.proxy_url) {
    openOptions.proxy_mode = 'custom'
    openOptions.proxy_url = settings.proxy_url
  } else openOptions.proxy_mode = 'system'

  const page = await ctx.browser.open(openOptions)
  const command = (method, params = {}) =>
    ctx.browser.command({ session: page.id, method, params, timeout_seconds: 30 })

  try {
    // 1. 先到首页等 Cloudflare 通过
    await ctx.task.update({ stage: 'cf', message: '等待 Cloudflare…' })
    const nav = await command('Page.navigate', { url: BASE + '/' })
    if (nav.errorText) throw new Error(`导航失败: ${nav.errorText}`)

    // 等 Cloudflare 或页面加载
    const deadline = Date.now() + 30000
    let ready = false
    while (Date.now() < deadline) {
      const r = await command('Runtime.evaluate', {
        expression: `(() => {
          const t = document.title || ''
          const h = document.documentElement?.innerHTML?.slice(0,500) || ''
          if (t.includes('Just a moment') || h.includes('challenge-platform')) return 'challenge'
          if (document.readyState === 'complete') return 'ready'
          return 'loading'
        })()`,
        returnByValue: true
      })
      if (r.result?.value === 'ready') { ready = true; break }
      await ctx.sleep(r.result?.value === 'challenge' ? 3000 : 500)
    }
    if (!ready) throw new Error('页面加载超时')

    // 2. 检查是否已登录
    await ctx.task.update({ stage: 'check', message: '检查登录状态…' })
    const loginCheck = await command('Runtime.evaluate', {
      expression: `(() => {
        // 如果页面有用户菜单/头像则已登录
        const el = document.querySelector('.user-menu, .member-info, [class*="logged"], [class*="avatar"]')
        return !!el
      })()`,
      returnByValue: true
    })
    if (loginCheck.result?.value === true) {
      await log(ctx, '已经登录，无需重新登录')
      return { already: true }
    }

    // 3. 导航到登录页
    await ctx.task.update({ stage: 'login', message: '打开登录页…' })
    const loginNav = await command('Page.navigate', { url: BASE + '/login?return=%2Fmember' })
    if (loginNav.errorText) throw new Error(`登录页导航失败: ${loginNav.errorText}`)
    await ctx.sleep(2000)

    // 4. 填入用户名和密码
    await ctx.task.update({ stage: 'fill', message: '填入凭据…' })
    const fill = await command('Runtime.evaluate', {
      expression: `(() => {
        const user = document.querySelector('input[name="username"], input[type="text"], input[name="account"]')
        const pass = document.querySelector('input[name="password"], input[type="password"], #auth-password')
        if (!user || !pass) return { ok: false, msg: '找不到登录表单输入框' }
        user.focus(); user.value = ${JSON.stringify(settings.username)}
        pass.focus(); pass.value = ${JSON.stringify(settings.password)}
        return { ok: true }
      })()`,
      returnByValue: true
    })
    const fillResult = fill.result?.value
    if (!fillResult || !fillResult.ok) {
      throw new Error(fillResult?.msg || '登录表单填写失败')
    }

    // 5. 提交表单
    await ctx.task.update({ stage: 'submit', message: '提交登录…' })
    const submit = await command('Runtime.evaluate', {
      expression: `(() => {
        const btn = document.querySelector('button[type="submit"], input[type="submit"], .login-btn')
        if (btn) { btn.click(); return true }
        const form = document.querySelector('form')
        if (form) { form.submit(); return true }
        return false
      })()`,
      returnByValue: true
    })
    if (!submit.result?.value) throw new Error('找不到提交按钮')

    // 6. 等待登录结果
    await ctx.sleep(5000)
    const check = await command('Runtime.evaluate', {
      expression: `(() => {
        const t = document.title || ''
        const h = document.documentElement?.innerHTML?.slice(0,1000) || ''
        // 登录失败特征
        if (t.includes('登入') || t.includes('登录') || h.includes('login-error') || h.includes('密码错误')) return 'failed'
        // 登录成功：跳转到 member 或首页
        if (location.pathname.includes('member') || location.pathname === '/') return 'ok'
        return 'unknown:' + location.pathname
      })()`,
      returnByValue: true
    })
    const loginState = check.result?.value
    if (loginState === 'failed') {
      throw new Error('登录失败：用户名或密码可能不正确')
    }
    if (loginState?.startsWith('unknown')) {
      await log(ctx, `登录后跳转到 ${loginState}，请手动验证`)
    }

    await log(ctx, '登录完成，浏览器档案已保存')
    return { ok: true, state: loginState }
  } finally {
    await ctx.browser.close(page.id).catch(() => {})
  }
}
