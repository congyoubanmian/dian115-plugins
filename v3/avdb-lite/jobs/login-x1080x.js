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

/** 等 Cloudflare 通过 + 页面就绪 */
async function waitReady(ctx, command, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await command('Runtime.evaluate', {
      expression: `(() => {
        const t = document.title || ''
        const h = document.documentElement?.innerHTML?.slice(0, 500) || ''
        if (t.includes('Just a moment') || h.includes('challenge-platform') || h.includes('cf-challenge')) return 'challenge'
        if (document.readyState === 'complete') return 'ready'
        return 'loading'
      })()`,
      returnByValue: true
    })
    const state = r.result?.value
    if (state === 'ready') return true
    await ctx.sleep(state === 'challenge' ? 3000 : 500)
  }
  return false
}

/** 等表单出现（登录页可能是 SPA，DOM 渲染有延迟） */
async function waitForForm(ctx, command, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await command('Runtime.evaluate', {
      expression: `(() => {
        // 多组选择器覆盖：原生 form + React/Vue SPA 渲染的表单
        const user = document.querySelector('#auth-username, input[name="username"], input[name="account"], input[name="email"], input[placeholder*="用户"], input[placeholder*="账号"], input[placeholder*="user"], form input[type="text"]:not([type="hidden"])')
        const pass = document.querySelector('#auth-password, input[name="password"], input[type="password"]')
        return { hasUser: !!user, hasPass: !!pass, userFound: user ? (user.id || user.name || user.placeholder || user.type) : null }
      })()`,
      returnByValue: true
    })
    const v = r.result?.value
    if (v && v.hasUser && v.hasPass) return v
    await ctx.sleep(1000)
  }
  return null
}

/** 诊断：页面标题、URL、HTML 片段 */
async function diagnose(ctx, command, label) {
  const r = await command('Runtime.evaluate', {
    expression: `(() => ({
      title: document.title || '(空)',
      url: location.href,
      forms: document.querySelectorAll('form').length,
      inputs: document.querySelectorAll('input').length,
      bodyStart: (document.body?.textContent || '').replace(/\\s+/g, ' ').slice(0, 300)
    }))()`,
    returnByValue: true
  })
  const d = r.result?.value || {}
  await log(ctx, `[${label}] title="${d.title}" url=${d.url} forms=${d.forms} inputs=${d.inputs} body="${d.bodyStart}"`)
  return d
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
    // 1. 首页：等 Cloudflare 通过
    await ctx.task.update({ stage: 'cf', message: '等待 Cloudflare…' })
    await command('Page.navigate', { url: BASE + '/' })
    if (!(await waitReady(ctx, command, 30000))) {
      await diagnose(ctx, command, '首页超时')
      throw new Error('首页加载超时（Cloudflare 可能未通过）')
    }
    await log(ctx, 'Cloudflare 已通过（或无挑战）')
    await diagnose(ctx, command, '首页')

    // 2. 检查是否已登录
    const loginCheck = await command('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('.user-menu, .member-info, [class*="logged"], [class*="avatar"]')
        return !!el
      })()`,
      returnByValue: true
    })
    if (loginCheck.result?.value === true) {
      await log(ctx, '已经登录，无需重新登录')
      return { already: true }
    }

    // 3. 登录页：导航 + 等 CF + 等表单渲染
    await ctx.task.update({ stage: 'login', message: '打开登录页…' })
    await command('Page.navigate', { url: BASE + '/login?return=%2Fmember' })
    if (!(await waitReady(ctx, command, 20000))) {
      await diagnose(ctx, command, '登录页超时')
      throw new Error('登录页加载超时（可能仍在 Cloudflare 挑战中）')
    }
    await diagnose(ctx, command, '登录页')

    await ctx.task.update({ stage: 'wait-form', message: '等待登录表单渲染…' })
    const formCheck = await waitForForm(ctx, command, 15000)
    if (!formCheck) {
      const d = await diagnose(ctx, command, '表单未找到')
      throw new Error(
        `找不到登录表单输入框。页面 title="${d.title}"，有 ${d.forms} 个 form、${d.inputs} 个 input。` +
        '可能是登录页结构不同或需要验证码。请把任务日志发给我调试。'
      )
    }
    await log(ctx, `表单已就绪（user字段: ${formCheck.userFound}）`)

    // 4. 填入用户名和密码（用 focus + Input 事件模拟真实输入）
    await ctx.task.update({ stage: 'fill', message: '填入凭据…' })
    const fill = await command('Runtime.evaluate', {
      expression: `(() => {
        const user = document.querySelector('#auth-username, input[name="username"], input[name="account"], input[name="email"], input[placeholder*="用户"], input[placeholder*="账号"], input[placeholder*="user"], form input[type="text"]:not([type="hidden"])')
        const pass = document.querySelector('#auth-password, input[name="password"], input[type="password"]')
        if (!user || !pass) return { ok: false, msg: '输入框消失了' }

        // React/Vue 需要触发 input 事件才能更新状态
        function setVal(el, val) {
          const proto = Object.getPrototypeOf(el)
          const desc = Object.getOwnPropertyDescriptor(proto, 'value')
          desc.set.call(el, val)
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
        }
        user.focus(); setVal(user, ${JSON.stringify(settings.username)})
        pass.focus(); setVal(pass, ${JSON.stringify(settings.password)})
        return { ok: true }
      })()`,
      returnByValue: true
    })
    if (!fill.result?.value?.ok) {
      throw new Error(fill.result?.value?.msg || '填入凭据失败')
    }

    // 5. 提交
    await ctx.task.update({ stage: 'submit', message: '提交登录…' })
    await ctx.sleep(500)
    const submit = await command('Runtime.evaluate', {
      expression: `(() => {
        const btn = document.querySelector('button[type="submit"], input[type="submit"], .login-btn, button:not([type="cancel"])')
        if (btn) { btn.click(); return 'button' }
        const form = document.querySelector('form')
        if (form) { form.submit(); return 'form' }
        return null
      })()`,
      returnByValue: true
    })
    const submitVia = submit.result?.value
    if (!submitVia) throw new Error('找不到提交按钮')
    await log(ctx, `提交方式: ${submitVia}`)

    // 6. 等登录结果（最多 15 秒）
    await ctx.task.update({ stage: 'result', message: '等待登录结果…' })
    let loginState = null
    const resultDeadline = Date.now() + 15000
    while (Date.now() < resultDeadline) {
      await ctx.sleep(2000)
      const check = await command('Runtime.evaluate', {
        expression: `(() => {
          const t = document.title || ''
          const h = document.documentElement?.innerHTML?.slice(0, 1000) || ''
          const path = location.pathname
          // 成功：跳转到 member 或首页
          if (path.includes('member') || path === '/') return 'ok'
          // 失败特征
          if (h.includes('login-error') || h.includes('密码错误') || h.includes('incorrect') || h.includes('failed')) return 'failed'
          // 还在登录页
          if (path.includes('login')) return 'still'
          return 'other:' + path
        })()`,
        returnByValue: true
      })
      loginState = check.result?.value
      if (loginState === 'ok' || loginState === 'failed') break
    }

    if (loginState === 'failed') {
      await diagnose(ctx, command, '登录失败')
      throw new Error('登录失败：用户名或密码可能不正确')
    }
    if (!loginState || loginState === 'still') {
      await diagnose(ctx, command, '登录超时')
      await log(ctx, '登录结果不确定——可能需要验证码或二次确认，请下次抓取时检查')
    } else {
      await log(ctx, `登录完成（state=${loginState}），浏览器档案已保存`)
    }
    return { ok: true, state: loginState }
  } finally {
    await ctx.browser.close(page.id).catch(() => {})
  }
}
