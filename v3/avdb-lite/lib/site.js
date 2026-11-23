// X1080X 站点公共逻辑。
//
// 过盾走 AVDB 的路线：FlareSolverr（宿主 ctx.http.render）真浏览器过 Cloudflare，
// 拿回 cf_clearance 等 Cookie 与 User-Agent，存进插件 HTTP session；之后的列表/详情
// 都用普通 HTTP 请求复用这套 Cookie，不再让浏览器逐页跑。
//
// 下载地址需要登录后才可见（游客正文里是「加入 VIP」提示）。登录走共享浏览器：
// 把过盾 Cookie 注入浏览器会话后打开站点真实登录表单，由站点自己的 JS 提交。

export const HOSTS = ['https://1080xin.com', 'https://1080xin.vip']
export const PROFILE = 'x1080x'
export const HTTP_SESSION = 'x1080x'
export const LOGIN_PATH = '/login?return=%2Fmember'
export const DEFAULT_FLARESOLVERR = 'http://127.0.0.1:8191'
export const SAMPLE_BOARD = '7RHPO2w4jFUYiDhDsxz0wE'

const PLACEHOLDER_MARK = '請使用下面地址'
const CF_TITLES = ['Just a moment', '安全驗證', 'Checking your browser', 'Attention Required', 'One more step']
const CF_BODY_MARKS = [
  'challenge-platform', 'cf-challenge', 'cf_chl', '正在進行安全驗證', '安全服務防護',
  'Enable JavaScript and cookies to continue', 'Verification successful'
]
const MAGNET_RE = /magnet:\?xt=urn:btih:[A-Za-z0-9]+[^\s"'<>\\]*/gi
const ED2K_RE = /ed2k:\/\/\|file\|[^"'\s<>\\]+/gi

export function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const solver = String(value.flaresolverr_url || '').trim()
  return {
    flaresolverr_url: /^https?:\/\//i.test(solver) ? solver.replace(/\/+$/, '') : DEFAULT_FLARESOLVERR,
    username: String(value.username || '').trim(),
    password: String(value.password || '')
  }
}

export async function log(ctx, text) {
  try { await ctx.task.log(String(text).slice(0, 4000)) } catch (_) {}
}

export function isChallengeHtml(html) {
  const text = String(html || '')
  const title = (text.match(/<title[^>]*>([^<]*)/i) || [, ''])[1]
  if (CF_TITLES.some(mark => title.includes(mark))) return true
  const head = text.slice(0, 6000)
  return CF_BODY_MARKS.some(mark => head.includes(mark)) || head.includes(PLACEHOLDER_MARK)
}

/** 用 FlareSolverr 过 Cloudflare，Cookie 与 UA 回存到插件 HTTP session。 */
export async function solveChallenge(ctx, settings) {
  let lastError = ''
  for (const host of HOSTS) {
    try {
      const page = await ctx.http.render({
        endpoint: settings.flaresolverr_url,
        url: host + '/',
        session: HTTP_SESSION,
        timeout_seconds: 150
      })
      if (isChallengeHtml(page.html)) {
        lastError = `${host} 过盾后仍是挑战页`
        await log(ctx, lastError)
        continue
      }
      if (!page.user_agent) {
        lastError = `${host} 过盾结果缺少 User-Agent`
        continue
      }
      await log(ctx, `Cloudflare 已通过（FlareSolverr）：${host}`)
      return { base: host, userAgent: page.user_agent }
    } catch (error) {
      lastError = `${host}: ${error && error.message ? error.message : error}`
      await log(ctx, lastError)
    }
  }
  throw new Error(`FlareSolverr 未能通过 Cloudflare（${settings.flaresolverr_url}）：${lastError}`)
}

/** 复用 session 里的 Cookie 调站点 JSON API。proxy 固定 direct，与 FlareSolverr 同一出口 IP。 */
export async function httpJSON(ctx, base, userAgent, path) {
  const res = await ctx.http.request({
    url: base + path,
    method: 'GET',
    session: HTTP_SESSION,
    headers: { Accept: 'application/json', 'User-Agent': userAgent },
    proxy: 'direct',
    timeout_seconds: 45,
    response_type: 'json'
  })
  if (res.status !== 200) {
    const body = String(res.body || '').slice(0, 200)
    if (res.status === 403 || isChallengeHtml(body)) {
      throw new Error(`HTTP 403（Cloudflare 拦截，过盾 Cookie 可能已失效）：${body.slice(0, 80)}`)
    }
    throw new Error(`HTTP ${res.status} ${body}`)
  }
  let data = res.data
  if (!data && res.body) {
    try { data = JSON.parse(res.body) } catch (_) { throw new Error('返回的不是 JSON') }
  }
  if (!data || typeof data !== 'object') throw new Error('响应结构异常')
  if (data.error) throw new Error(`接口错误：${data.error}`)
  return data
}

/** 解析详情接口 read.body 的节点树。 */
export function parseState(state) {
  const out = { allowed: false, gated: false, magnets: [], edk: [], images: [], hrefs: [], text: '' }
  const read = state && state.read
  if (!read || typeof read !== 'object') return out
  out.allowed = read.allowed === true
  const body = read.body
  const nodes = Array.isArray(body && body.nodes) ? body.nodes : []
  const texts = []
  const walk = list => {
    for (const node of Array.isArray(list) ? list : []) {
      if (!node || typeof node !== 'object') continue
      if (node.type === 'timeqx_notice') out.gated = true
      if (typeof node.text === 'string') texts.push(node.text)
      if (typeof node.href === 'string') out.hrefs.push(node.href)
      if (typeof node.src === 'string') out.hrefs.push(node.src)
      if (node.type === 'external_image' || node.type === 'image') {
        const image = node.src || node.href
        if (typeof image === 'string' && /^https?:\/\//i.test(image)) out.images.push(image)
      }
      if (Array.isArray(node.children)) walk(node.children)
    }
  }
  walk(nodes)
  out.text = texts.join('\n')
  if (out.text.includes('加入 VIP 查看內容')) out.gated = true

  // 磁力/ED2K 以整份响应为准，不依赖节点类型。
  const raw = JSON.stringify(state)
  out.magnets = [...new Set(raw.match(MAGNET_RE) || [])].slice(0, 20)
  out.edk = [...new Set(raw.match(ED2K_RE) || [])].slice(0, 20)
  out.images = [...new Set(out.images)].slice(0, 8)
  out.hrefs = [...new Set(out.hrefs)].slice(0, 40)

  const size = out.text.match(/(\d+(?:\.\d+)?)\s*(TB|GB|MB|G|M)/i)
  out.size = size ? size[1] + size[2].toUpperCase() : ''
  return out
}

// ───────────────────── 共享浏览器：登录桥接 ─────────────────────

async function pageState(ctx, command) {
  try {
    const r = await command('Runtime.evaluate', {
      expression: `(() => {
        const t = document.title || ''
        const b = (document.body?.textContent || '').replace(/\\s+/g, ' ')
        return {
          title: t, body: b.slice(0, 300), path: location.pathname,
          challenge: ${JSON.stringify(CF_TITLES)}.some(x => t.includes(x)) ||
                     ${JSON.stringify(CF_BODY_MARKS.slice(0, 6))}.some(x => b.includes(x)),
          hasUser: !!document.querySelector('#auth-username'),
          hasPass: !!document.querySelector('#auth-password')
        }
      })()`,
      returnByValue: true
    })
    if (r.exceptionDetails || !r.result || typeof r.result.value !== 'object') return { error: true }
    return r.result.value
  } catch (_) {
    return { error: true }
  }
}

async function clickTurnstile(ctx, command) {
  try {
    const doc = await command('DOM.getDocument', { depth: -1 })
    const nodes = await command('DOM.querySelectorAll', {
      nodeId: doc.root?.nodeId,
      selector: 'iframe[src*="challenges.cloudflare.com"], iframe[title*="challenge"], #challenge-form'
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

async function waitReady(ctx, command, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  let clicked = false
  while (Date.now() < deadline) {
    const state = await pageState(ctx, command)
    if (state.error) { await ctx.sleep(1000); continue }
    if (!state.challenge) return { ok: true, state }
    if (!clicked) { clicked = true; await clickTurnstile(ctx, command) }
    await ctx.sleep(2000)
  }
  return { ok: false, reason: 'challenge', state: await pageState(ctx, command) }
}

const SAME_SITE = { lax: 'Lax', strict: 'Strict', none: 'None' }

/** 把过盾 Cookie 注入浏览器会话，并把 UA 对齐成过盾时用的那个（cf_clearance 绑定 IP + UA）。 */
async function injectClearance(ctx, command, base) {
  const cookies = await ctx.http.cookies({ url: base + '/', session: HTTP_SESSION })
  const cdpCookies = cookies
    .filter(cookie => cookie && cookie.name && cookie.value != null)
    .map(cookie => {
      const item = {
        name: cookie.name,
        value: String(cookie.value),
        path: cookie.path || '/',
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.http_only)
      }
      // __Host- 前缀要求 host-only：host-only Cookie 用 url 设置，不带 domain
      if (cookie.host_only || cookie.name.startsWith('__Host-')) item.url = base + '/'
      else item.domain = String(cookie.domain || '').replace(/^\./, '')
      if (cookie.same_site && SAME_SITE[cookie.same_site]) item.sameSite = SAME_SITE[cookie.same_site]
      if (cookie.expires_at) item.expires = Number(cookie.expires_at)
      return item
    })
  if (!cdpCookies.length) throw new Error('过盾 session 里没有可注入的 Cookie')
  await command('Network.setCookies', { cookies: cdpCookies })
  const check = await command('Network.getCookies', { urls: [base + '/'] })
  const names = new Set((check.cookies || []).map(cookie => cookie.name))
  const missing = cookies.map(cookie => cookie.name).filter(name => !names.has(name))
  return { injected: cdpCookies.length, missing }
}

/**
 * 打开共享浏览器并带上过盾 Cookie。
 * 浏览器固定 direct，和 FlareSolverr 同一个出口 IP，否则 cf_clearance 无效。
 */
export async function openBrowser(ctx, base, userAgent) {
  const status = await ctx.browser.status()
  if (!status.available) throw new Error(status.error || `浏览器运行包未就绪（state=${status.state}）`)
  const page = await ctx.browser.open({ profile: PROFILE, proxy_mode: 'direct', timeout_seconds: 30 })
  const command = (method, params = {}) =>
    ctx.browser.command({ session: page.id, method, params, timeout_seconds: 30 })
  try {
    await command('Network.setUserAgentOverride', { userAgent })
    const injected = await injectClearance(ctx, command, base)
    await log(ctx, `已注入过盾 Cookie ${injected.injected} 条` + (injected.missing.length ? `，未生效：${injected.missing.join(',')}` : ''))
    await command('Page.navigate', { url: base + '/' })
    const ready = await waitReady(ctx, command)
    if (!ready.ok) {
      const state = ready.state || {}
      throw new Error(`注入过盾 Cookie 后浏览器仍被 Cloudflare 拦截：title="${state.title || ''}" body="${state.body || ''}"`)
    }
    return { command, close: () => ctx.browser.close(page.id).catch(() => {}) }
  } catch (error) {
    await ctx.browser.close(page.id).catch(() => {})
    throw error
  }
}

/** 在页面里 fetch 站点 JSON API（带浏览器上下文的 Cookie 与登录态）。 */
export async function browserFetchJSON(ctx, command, base, path) {
  const expression = `fetch('${base}${path}', { headers: { 'Accept': 'application/json' }, credentials: 'include' })
    .then(async r => { const text = await r.text(); let data = null; try { data = JSON.parse(text) } catch (e) {} ; return { status: r.status, data, text: text.slice(0, 300) } })`
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

/** 取一个资源 id，用于查询登录态。 */
export async function sampleResourceId(ctx, command, base) {
  const list = await browserFetchJSON(ctx, command, base,
    '/api/catalog/resources?board_id=' + encodeURIComponent(SAMPLE_BOARD) + '&page=1')
  const item = (list.items || []).find(entry => entry && entry.id)
  if (!item) throw new Error('取不到用于查询登录态的资源')
  return String(item.id)
}

/** 用详情接口的 authenticated 字段判断登录态（Cookie 存在不算登录）。 */
export async function isAuthenticated(ctx, command, base, sampleId) {
  const state = await browserFetchJSON(ctx, command, base, '/api/resources/' + encodeURIComponent(sampleId) + '/state')
  return state && state.authenticated === true
}

/** 走站点真实登录表单。Turnstile 与登录请求由站点自己的 JS 完成，这里只填表单、点一次提交。 */
export async function browserLogin(ctx, command, base, settings, sampleId) {
  await command('Page.navigate', { url: base + LOGIN_PATH })
  const ready = await waitReady(ctx, command)
  if (!ready.ok) {
    const state = ready.state || {}
    throw new Error(`登录页被 Cloudflare 拦截：title="${state.title || ''}" body="${state.body || ''}"`)
  }
  let hasForm = false
  const formDeadline = Date.now() + 20000
  while (Date.now() < formDeadline) {
    const state = await pageState(ctx, command)
    if (!state.error && state.hasUser && state.hasPass) { hasForm = true; break }
    await ctx.sleep(1000)
  }
  if (!hasForm) {
    const state = await pageState(ctx, command)
    throw new Error(`找不到登录表单（#auth-username / #auth-password）：title="${state.title || ''}" body="${state.body || ''}"`)
  }

  const fill = await command('Runtime.evaluate', {
    expression: `(() => {
      const user = document.querySelector('#auth-username')
      const pass = document.querySelector('#auth-password')
      if (!user || !pass) return false
      const setVal = (el, val) => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, val)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }
      user.focus(); setVal(user, ${JSON.stringify(settings.username)})
      pass.focus(); setVal(pass, ${JSON.stringify(settings.password)})
      return true
    })()`,
    returnByValue: true
  })
  if (fill.result?.value !== true) throw new Error('填写登录表单失败')

  const submit = () => command('Runtime.evaluate', {
    expression: `(() => {
      const btn = document.querySelector('button[type="submit"]')
      if (btn) { btn.click(); return true }
      return false
    })()`,
    returnByValue: true
  })
  await submit()

  let loggedIn = false
  let secondSubmit = false
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    await ctx.sleep(3000)
    const state = await pageState(ctx, command)
    if (!state.error && state.hasUser && !secondSubmit) {
      // 站点动态模式：首次普通提交被要求验证时，等它的组件拿到 token 后再提交一次
      secondSubmit = true
      await log(ctx, '登录页仍在表单，等待验证后重试提交一次…')
      await ctx.sleep(6000)
      await submit()
      continue
    }
    try {
      loggedIn = await isAuthenticated(ctx, command, base, sampleId)
    } catch (_) {}
    if (loggedIn) break
  }
  return loggedIn
}
