// X1080X 站点公共逻辑：真实站点 1080xin.com / 1080xin.vip（x1080x.com 只是占位跳转页）。
// Cloudflare 安全验证的判定、点击验证框、等待通过，以及在页面里 fetch JSON API。

export const HOSTS = ['https://1080xin.com', 'https://1080xin.vip']
export const PROFILE = 'x1080x'
export const LOGIN_PATH = '/login?return=%2Fmember'

const PLACEHOLDER_MARK = '請使用下面地址'
const CF_TITLES = ['Just a moment', '安全驗證', 'Checking your browser', 'Attention Required']
const CF_BODY_MARKS = [
  'challenge-platform', 'cf-challenge', 'cf_chl', 'Turnstile', '安全驗證',
  '正在進行安全驗證', 'Verification successful', '安全服務防護', 'Enable JavaScript and cookies'
]

export async function log(ctx, text) {
  try { await ctx.task.log(String(text).slice(0, 4000)) } catch (_) {}
}

/** 页面当前状态 */
export async function pageState(ctx, command) {
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
        hasPass: !!document.querySelector('#auth-password'),
        hasLoginForm: !!document.querySelector('#auth-username')?.form
      }
    })()`,
    returnByValue: true
  })
  return r.result?.value || {}
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

/**
 * 等 Cloudflare 安全验证通过。
 * - 出现验证框时点一次（最多一次）。
 * - 出现「Verification successful / 正在等待站点响应」时不点，等它自己跳转。
 * - 超过 20 秒仍在验证页且已验证成功，reload 一次促跳转。
 */
export async function waitChallengePassed(ctx, command, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  let clicked = false
  let reloaded = false
  while (Date.now() < deadline) {
    const state = await pageState(ctx, command)
    if (state.placeholder) return { ok: false, reason: 'placeholder', state }
    if (!state.challenge) return { ok: true, state }

    if (!state.verified && !clicked) {
      clicked = true
      await log(ctx, '检测到 Cloudflare 验证框，尝试点击…')
      await clickTurnstile(ctx, command)
    }
    if (state.verified && !reloaded && Date.now() > deadline - (timeoutMs - 20000)) {
      reloaded = true
      await log(ctx, '验证已通过但页面未跳转，reload 一次…')
      try { await command('Page.reload', { ignoreCache: false }) } catch (_) {}
    }
    await ctx.sleep(2000)
  }
  const state = await pageState(ctx, command)
  return { ok: false, reason: state.challenge ? 'challenge' : 'timeout', state }
}

/** 挑一个能用的站点地址 */
export async function resolveHost(ctx, command) {
  for (const host of HOSTS) {
    await command('Page.navigate', { url: host + '/' })
    const r = await waitChallengePassed(ctx, command, 45000)
    if (r.ok) {
      await log(ctx, `使用站点 ${host}`)
      return host
    }
    await log(ctx, `站点 ${host} 不可用（${r.reason}）：${r.state?.title || ''}`)
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
export async function waitLoginForm(ctx, command, base, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  let navigated = false
  while (Date.now() < deadline) {
    const state = await pageState(ctx, command)
    if (state.hasUser && state.hasPass) return { ok: true, state }
    // 验证通过后被跳回首页：再导航一次登录页
    if (!state.challenge && !navigated && state.path !== '/login') {
      navigated = true
      await log(ctx, `当前路径 ${state.path}，重新导航登录页…`)
      await command('Page.navigate', { url: base + LOGIN_PATH })
    }
    await ctx.sleep(2000)
  }
  return { ok: false, state: await pageState(ctx, command) }
}
