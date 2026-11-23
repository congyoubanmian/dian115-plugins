// X1080X 登录：真实站点 1080xin.com / 1080xin.vip（x1080x.com 只是占位跳转页）。
// 共享 Chromium 过 Cloudflare 安全验证后，按站点真实表单（#auth-username / #auth-password）登录。
// 站点自己的 JS 负责 Turnstile token 与登录请求提交，我们只填表单、点一次提交。

import {
  PROFILE, LOGIN_PATH,
  log, pageState, waitChallengePassed, resolveHost, waitLoginForm, dumpScreenshot
} from '../lib/site.js'

export async function run(ctx, input) {
  const raw = (await ctx.storage.get('avdb-settings')) || {}
  const username = String(raw.username || '').trim()
  const password = String(raw.password || '')
  const proxy_mode = ['system', 'direct', 'custom'].includes(raw.proxy_mode) ? raw.proxy_mode : 'system'
  const proxy_url = String(raw.proxy_url || '').trim()
  if (!username || !password) throw new Error('请先在设置里填写 X1080X 用户名和密码')

  await ctx.task.update({ stage: 'browser', message: '打开共享浏览器…' })
  const status = await ctx.browser.status()
  if (!status.available) throw new Error(status.error || `浏览器运行包未就绪（state=${status.state}）`)

  const openOptions = { profile: PROFILE, timeout_seconds: 30 }
  if (proxy_mode === 'direct') openOptions.proxy_mode = 'direct'
  else if (proxy_mode === 'custom' && proxy_url) {
    openOptions.proxy_mode = 'custom'
    openOptions.proxy_url = proxy_url
  } else openOptions.proxy_mode = 'system'

  const page = await ctx.browser.open(openOptions)
  const command = (method, params = {}) =>
    ctx.browser.command({ session: page.id, method, params, timeout_seconds: 30 })

  try {
    // 1. 选站点 + 过 Cloudflare 安全验证
    await ctx.task.update({ stage: 'cf', message: '等待 Cloudflare 安全验证…' })
    const base = await resolveHost(ctx, command)
    const home = await pageState(ctx, command)
    await log(ctx, `首页 title="${home.title}" path=${home.path} challenge=${home.challenge}`)

    // 2. 已登录？
    const already = await command('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('.user-menu, .member-info, [class*="logged"], [class*="avatar"]')
        return !!el || location.pathname.includes('member')
      })()`,
      returnByValue: true
    })
    if (already.result?.value === true) {
      await log(ctx, '已经登录，无需重新登录')
      return { already: true }
    }

    // 3. 登录页 + 等表单
    await ctx.task.update({ stage: 'login', message: '打开登录页…' })
    await command('Page.navigate', { url: base + LOGIN_PATH })
    const passed = await waitChallengePassed(ctx, command, 90000)
    if (!passed.ok) {
      const st = passed.state || {}
      const shot = await dumpScreenshot(ctx, command, 'login-challenge')
      throw new Error(
        `登录页未通过安全验证（${passed.reason}）：title="${st.title || passed.lastTitle || ''}" body="${st.body || ''}"` +
        (shot ? ` 截图=${shot}` : '')
      )
    }

    await ctx.task.update({ stage: 'wait-form', message: '等待登录表单…' })
    const form = await waitLoginForm(ctx, command, base, 60000)
    if (!form.ok) {
      const st = form.state || {}
      const shot = await dumpScreenshot(ctx, command, 'login-form-missing')
      throw new Error(
        `找不到登录表单（#auth-username / #auth-password）。` +
        `title="${st.title}" url=${base + LOGIN_PATH} body="${st.body}"` +
        (shot ? ` 截图=${shot}` : '')
      )
    }

    // 4. 填入凭据
    await ctx.task.update({ stage: 'fill', message: '填入凭据…' })
    const fill = await command('Runtime.evaluate', {
      expression: `(() => {
        const user = document.querySelector('#auth-username')
        const pass = document.querySelector('#auth-password')
        if (!user || !pass) return { ok: false }
        function setVal(el, val) {
          const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
          desc.set.call(el, val)
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
        }
        user.focus(); setVal(user, ${JSON.stringify(username)})
        pass.focus(); setVal(pass, ${JSON.stringify(password)})
        return { ok: true }
      })()`,
      returnByValue: true
    })
    if (!fill.result?.value?.ok) throw new Error('填写凭据失败')

    // 5. 提交一次（站点 JS 自己处理 Turnstile 与登录请求）
    await ctx.task.update({ stage: 'submit', message: '提交登录…' })
    await ctx.sleep(500)
    const submit = await command('Runtime.evaluate', {
      expression: `(() => {
        const btn = document.querySelector('button[type="submit"]')
        if (btn) { btn.click(); return 'button' }
        const form = document.querySelector('#auth-username')?.form
        if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return 'form' }
        return null
      })()`,
      returnByValue: true
    })
    if (!submit.result?.value) throw new Error('找不到提交按钮')
    await log(ctx, '已提交登录（方式 ' + submit.result.value + '）')

    // 6. 等待结果
    await ctx.task.update({ stage: 'result', message: '等待登录结果…' })
    let state = null
    let submittedTwice = false
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      await ctx.sleep(2000)
      const check = await command('Runtime.evaluate', {
        expression: `(() => {
          const b = (document.body?.textContent || '').replace(/\\s+/g, ' ')
          if (location.pathname.includes('member')) return 'ok'
          if (b.includes('密碼錯誤') || b.includes('密码错误') || b.includes('登入失敗') ||
              b.includes('登录失败') || b.includes('incorrect')) return 'failed'
          if (b.includes('驗證') || b.includes('验证')) return 'challenge'
          if (location.pathname.includes('login')) return 'still'
          return 'other:' + location.pathname
        })()`,
        returnByValue: true
      })
      state = check.result?.value
      if (state === 'ok' || state === 'failed') break
      if (state === 'challenge' && !submittedTwice) {
        submittedTwice = true
        await log(ctx, '站点要求再次验证，等待后重试提交一次…')
        await ctx.sleep(6000)
        await command('Runtime.evaluate', {
          expression: `(() => {
            const btn = document.querySelector('button[type="submit"]')
            if (btn) { btn.click(); return true }
            return false
          })()`,
          returnByValue: true
        })
      }
    }

    const st = await pageState(ctx, command)
    if (state === 'failed') {
      throw new Error(`登录失败：用户名或密码不正确。页面提示="${st.body}"`)
    }
    if (state !== 'ok') {
      await log(ctx, `登录结果不确定（state=${state}）：title="${st.title}" body="${st.body}"`)
    } else {
      await log(ctx, '登录成功，浏览器档案已保存')
    }
    return { ok: state === 'ok', state }
  } finally {
    await ctx.browser.close(page.id).catch(() => {})
  }
}
