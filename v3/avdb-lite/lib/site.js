// X1080X 站点公共逻辑：真实站点 1080xin.com / 1080xin.vip（x1080x.com 只是占位跳转页）。
// Cloudflare 安全验证的判定、点击验证框、等待通过，以及在页面里 fetch JSON API。

export const HOSTS = ['https://1080xin.com', 'https://1080xin.vip']
export const PROFILE = 'x1080x'
export const LOGIN_PATH = '/login?return=%2Fmember'

const PLACEHOLDER_MARK = '請使用下面地址'
const CF_TITLES = ['Just a moment', '安全驗證', 'Checking your browser', 'Attention Required', 'One more step']
const CF_BODY_MARKS = [
  'challenge-platform', 'cf-challenge', 'cf_chl', 'Turnstile', '安全驗證',
  '正在進行安全驗證', 'Verification successful', '安全服務防護',
  'Enable JavaScript and cookies to continue', 'Waiting for '
]

export async function log(ctx, text) {
  try { await ctx.task.log(String(text).slice(0, 4000)) } catch (_) {}
}

/** 页面当前状态；执行上下文被销毁时返回 error=true（绝不能当成"验证已通过"） */
export async function pageState(ctx, command) {
  try {
    const r = await command('Runtime.evaluate', {
      expression: `(() => {
        const t = document.title || ''
        const b = (document.body?.textContent || '').replace(/\\s+/g, ' ')
        return {
          title: t,
          body: b.slice(0, 400),
          path: location.pathname,
          placeholder: b.includes('${PLACEHOLDER_MARK}') || b.includes('歡迎訪問'),
          challenge: ${JSON.stringify(CF_TITLES)}.some(x => t.includes(x)) ||
                     ${JSON.stringify(CF_BODY_MARKS)}.some(x => b.includes(x)),
          verified: b.includes('Verification successful') || b.includes('驗證成功'),
          hasUser: !!document.querySelector('#auth-username'),
          hasPass: !!document.querySelector('#auth-password')
        }
      })()`,
      returnByValue: true
    })
    if (r.exceptionDetails) return { error: true, title: '(evaluate failed)' }
    const value = r.result?.value
    if (!value || typeof value !== 'object') return { error: true, title: '(no value)' }
    return value
  } catch (error) {
    return { error: true, title: '(exception: ' + (error && error.message ? error.message : error) + ')' }
  }
}

/** 点一次 CF 验证框（页面级 iframe 中心点） */
export async function clickTurnstile(ctx, command) {
  try {
    const doc = await command('DOM.getDocument', { depth: -1 })
    const nodes = await command('DOM.querySelectorAll', {
      nodeId: doc.root?.nodeId,
      selector: 'iframe[src*="challenges.cloudflare.com"], iframe[title*="challenge"], #challenge-form, #cf-challenge-running'
    })
    for (const nodeId of nodes.nodeIds || []) {
      const box = await command('DOM.getBoxModel', { nodeId })
      const quad = box.model?.content
      if (!quad || quad.length < 8) continue
      const x = (quad[0] + quad[2]) / 2
      const y = (quad[1] + quad[3]) / 2
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      return true
    }
  } catch (_) {}
  return false
}

/** 截图落盘，便于事后看浏览器到底看到了什么 */
export async function dumpScreenshot(ctx, command, tag) {
  try {
    const shot = await command('Page.captureScreenshot', { format: 'png' })
    const data = shot?.data
    if (!data) return ''
    const path = 'diag/' + tag + '-' + Date.now() + '.png'
    try { await ctx.files.call({ operation: 'mkdir', path: 'diag' }) } catch (_) {}
    await ctx.files.call({ operation: 'write', path, content: data, encoding: 'base64' })
    await log(ctx, '已保存截图：' + path)
    return path
  } catch (error) {
    await log(ctx, '截图失败：' + (error && error.message ? error.message : error))
    return ''
  }
}

/**
 * 等 Cloudflare 安全验证通过。
 * 判定要点：执行上下文被销毁（evaluate 失败）不等于通过，必须继续等。
 */
export async function waitChallengePassed(ctx, command, timeoutMs = 90000) {
  const started = Date.now()
  const deadline = started + timeoutMs
  let clicked = false
  let reloads = 0
  let lastTitle = ''
  while (Date.now() < deadline) {
    const state = await pageState(ctx, command)
    if (state.title) lastTitle = state.title
    if (state.error) {
      // 页面正在跳转/上下文重建，继续等
      await ctx.sleep(1000)
      continue
    }
    if (state.placeholder) return { ok: false, reason: 'placeholder', state }
    if (!state.challenge) return { ok: true, state }

    // 还在验证页：没验证过就点一次验证框；已显示"验证成功"就等它自己跳转
    if (!state.verified && !clicked) {
      clicked = true
      await log(ctx, '检测到 Cloudflare 验证框，尝试点击…')
      await clickTurnstile(ctx, command)
    }
    // 验证显示成功却卡住：强制 reload 促跳转（最多 2 次）
    if (state.verified && reloads < 2 && Date.now() - started > 15000 + reloads * 10000) {
      reloads++
      await log(ctx, '验证已通过但页面未跳转，reload 第 ' + reloads + ' 次…')
      try { await command('Page.reload', { ignoreCache: false }) } catch (_) {}
    }
    await ctx.sleep(2000)
  }
  const state = await pageState(ctx, command)
  return { ok: false, reason: state.challenge ? 'challenge' : 'timeout', state, lastTitle }
}

/** 挑一个能用的站点地址 */
export async function resolveHost(ctx, command) {
  for (const host of HOSTS) {
    await command('Page.navigate', { url: host + '/' })
    const r = await waitChallengePassed(ctx, command, 60000)
    if (r.ok) {
      await log(ctx, `使用站点 ${host}`)
      return host
    }
    await log(ctx, `站点 ${host} 不可用（${r.reason}）：${r.state?.title || r.lastTitle || ''}`)
  }
  throw new Error('候选站点都过不了安全验证：' + HOSTS.join(' / '))
}

/** 在页面里 fetch 站点 JSON API（自带 CF Cookie 与登录态） */
export async function browserFetchJSON(ctx, command, base, path) {
  const expression = `fetch('${base}${path}', {
    headers: { 'Accept': 'application/json' },
    credentials: 'include'
  }).then(async r => {
    const text = await r.text()
    let data = null
    try { data = JSON.parse(text) } catch (e) { data = null }
    return { status: r.status, data, text: text.slice(0, 300) }
  })`
  const r = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) {
    const detail = r.exceptionDetails.exception?.description || r.exceptionDetails.text || '未知异常'
    throw new Error(`API 调用失败: ${detail}`)
  }
  const out = r.result?.value
  if (!out) throw new Error('API 无返回')
  if (out.status !== 200) {
    const code = out.data?.error || out.data?.code || ''
    throw new Error(`API HTTP ${out.status}${code ? ' (' + code + ')' : ''} ${out.text || ''}`)
  }
  return out.data
}

/** 等登录表单出现；必要时重新导航一次登录页 */
export async function waitLoginForm(ctx, command, base, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  let navigated = false
  while (Date.now() < deadline) {
    const state = await pageState(ctx, command)
    if (state.error) {
      await ctx.sleep(1000)
      continue
    }
    if (state.hasUser && state.hasPass) return { ok: true, state }
    if (state.challenge) {
      // 还在安全验证页，继续等它过去
      await ctx.sleep(2000)
      continue
    }
    // 验证通过后被跳回首页：再导航一次登录页
    if (!navigated && state.path && !state.path.includes('login')) {
      navigated = true
      await log(ctx, `当前路径 ${state.path}，重新导航登录页…`)
      await command('Page.navigate', { url: base + LOGIN_PATH })
    }
    await ctx.sleep(2000)
  }
  return { ok: false, state: await pageState(ctx, command) }
}
