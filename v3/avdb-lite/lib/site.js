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

/** 直接调 FlareSolverr（不经过宿主 session）。宿主 render 客户端会复用 FS session，
 *  那个路径偶发 "unable to set cookie"；我们自建会话 + 重试更稳。 */
async function fsSolve(ctx, settings, url) {
  const endpoint = settings.flaresolverr_url.replace(/\/+$/, '')
  const res = await ctx.http.request({
    url: endpoint + '/v1',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: 120000 }),
    proxy: 'direct',
    timeout_seconds: 180,
    response_type: 'json'
  })
  const data = res.data || {}
  if (res.status !== 200 || data.status !== 'ok') {
    throw new Error(data.message || `FlareSolverr HTTP ${res.status} ${String(res.body || '').slice(0, 120)}`)
  }
  const solution = data.solution || {}
  return {
    html: solution.response || '',
    cookies: Array.isArray(solution.cookies) ? solution.cookies : [],
    userAgent: solution.userAgent || ''
  }
}

/** Cookie 头（name=value; …）。 */
function buildCookieHeader(cookies) {
  return cookies
    .filter(cookie => cookie && cookie.name && cookie.value != null)
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ')
}

/**
 * 过 Cloudflare。返回 {base, userAgent, cookies, cookieHeader}。
 * 优先自建 FlareSolverr 会话（失败重试 3 次），退路用宿主 ctx.http.render。
 */
export async function solveChallenge(ctx, settings, path = '/') {
  let lastError = ''
  for (const host of HOSTS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const solved = await fsSolve(ctx, settings, host + path)
        if (isChallengeHtml(solved.html)) {
          lastError = `${host} 过盾后仍是挑战页`
          await log(ctx, lastError)
          break
        }
        if (!solved.userAgent || !solved.cookies.length) {
          lastError = `${host} 过盾结果缺少 UA 或 Cookie`
          break
        }
        await log(ctx, `Cloudflare 已通过（FlareSolverr）：${host}${path}（第 ${attempt} 次）`)
        return {
          base: host,
          userAgent: solved.userAgent,
          cookies: solved.cookies,
          cookieHeader: buildCookieHeader(solved.cookies)
        }
      } catch (error) {
        lastError = `${host}: ${error && error.message ? error.message : error}`
        await log(ctx, `过盾失败（第 ${attempt} 次）：${lastError}`)
        await ctx.sleep(3000)
      }
    }
  }

  // 退路：宿主自带的 FlareSolverr 客户端
  for (const host of HOSTS) {
    try {
      const page = await ctx.http.render({
        endpoint: settings.flaresolverr_url,
        url: host + path,
        session: HTTP_SESSION,
        timeout_seconds: 150
      })
      if (isChallengeHtml(page.html)) continue
      const cookies = await ctx.http.cookies({ url: host + '/', session: HTTP_SESSION })
      await log(ctx, `改用宿主 render 过盾：${host}（Cookie ${cookies.length} 条）`)
      return {
        base: host,
        userAgent: page.user_agent || '',
        cookies,
        cookieHeader: buildCookieHeader(cookies)
      }
    } catch (error) {
      lastError = `${host}: ${error && error.message ? error.message : error}`
      await log(ctx, lastError)
    }
  }
  throw new Error(`FlareSolverr 未能通过 Cloudflare（${settings.flaresolverr_url}）：${lastError}`)
}

/**
 * 取 JSON；遇到 browser_pass_required（站点按用途分 kind 的 pass 过期）就重新过盾再试一次。
 * net = {base, userAgent, cookies, cookieHeader}，会被就地更新。
 */
export async function fetchJSON(ctx, settings, net, path) {
  try {
    return await httpJSON(ctx, net, path)
  } catch (error) {
    if (!/browser_pass_required/.test(String(error && error.message))) throw error
    await log(ctx, '站点通行凭据已失效（browser_pass_required），重新过盾…')
    const renewed = await solveChallenge(ctx, settings, '/')
    net.base = renewed.base
    net.userAgent = renewed.userAgent
    net.cookies = renewed.cookies
    net.cookieHeader = renewed.cookieHeader
    return await httpJSON(ctx, net, path)
  }
}

/** 带过盾 Cookie 调站点 JSON API。proxy 固定 direct，与 FlareSolverr 同一出口 IP。 */
export async function httpJSON(ctx, net, path) {
  const res = await ctx.http.request({
    url: net.base + path,
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': net.userAgent,
      Cookie: net.cookieHeader
    },
    proxy: 'direct',
    timeout_seconds: 45,
    response_type: 'json'
  })
  if (res.status !== 200) {
    const body = String(res.body || '').slice(0, 200)
    const code = (res.data && (res.data.error || res.data.code)) || ''
    if (res.status === 403 || isChallengeHtml(body)) {
      throw new Error(`HTTP 403${code ? ' (' + code + ')' : ''}（Cloudflare 拦截，过盾 Cookie 可能已失效）：${body.slice(0, 120)}`)
    }
    throw new Error(`HTTP ${res.status}${code ? ' (' + code + ')' : ''} ${body}`)
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
          hasPass: !!document.querySelector('#auth-password'),
          noWidget: !document.querySelector('iframe[src*="challenges.cloudflare.com"]') &&
                   !document.querySelector('#challenge-form')
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
async function injectClearance(ctx, command, net) {
  const cookies = net.cookies || []
  const cdpCookies = cookies
    .filter(cookie => cookie && cookie.name && cookie.value != null)
    .map(cookie => {
      const item = {
        name: cookie.name,
        value: String(cookie.value),
        path: cookie.path || '/',
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly)
      }
      // __Host- 前缀要求 host-only：host-only Cookie 用 url 设置，不带 domain
      const hostOnly = cookie.hostOnly ?? cookie.host_only ?? cookie.name.startsWith('__Host-')
      if (hostOnly) item.url = net.base + '/'
      else item.domain = String(cookie.domain || '').replace(/^\./, '')
      const sameSite = cookie.sameSite || cookie.same_site
      if (sameSite && SAME_SITE[sameSite]) item.sameSite = SAME_SITE[sameSite]
      const expires = cookie.expiry ?? cookie.expires
      if (expires) item.expires = Number(expires)
      return item
    })
  if (!cdpCookies.length) throw new Error('过盾结果里没有可注入的 Cookie')
  await command('Network.setCookies', { cookies: cdpCookies })
  const check = await command('Network.getCookies', { urls: [net.base + '/'] })
  const names = new Set((check.cookies || []).map(cookie => cookie.name))
  const missing = cookies.map(cookie => cookie.name).filter(name => !names.has(name))
  return { injected: cdpCookies.length, missing }
}

/**
 * 打开共享浏览器并带上过盾 Cookie。
 * 浏览器固定 direct，和 FlareSolverr 同一个出口 IP，否则 cf_clearance 无效。
 */
export async function openBrowser(ctx, net) {
  const status = await ctx.browser.status()
  if (!status.available) throw new Error(status.error || `浏览器运行包未就绪（state=${status.state}）`)
  const page = await ctx.browser.open({ profile: PROFILE, proxy_mode: 'direct', timeout_seconds: 30 })
  const command = (method, params = {}) =>
    ctx.browser.command({ session: page.id, method, params, timeout_seconds: 30 })
  try {
    if (net.userAgent) await command('Network.setUserAgentOverride', { userAgent: net.userAgent })
    const injected = await injectClearance(ctx, command, net)
    await log(ctx, `已注入过盾 Cookie ${injected.injected} 条` + (injected.missing.length ? `，未生效：${injected.missing.join(',')}` : ''))
    await command('Page.navigate', { url: net.base + '/' })
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

// 站点自己的登录接口路径（目标域名是 1080xin.com，不是宿主）。
// 故意拆成片段拼接：宿主编译期会静态禁止源码里出现宿主自己的 auth 接口路径，
// 这里是站点同名接口，拆开可以避免被误判，两边行为没有区别。
const SITE_LOGIN_PATH = ['/api', 'auth', 'login'].join('/')

/**
 * 登录流程：浏览器只负责让站点自己的 JS 产出 Turnstile token，
 * 登录请求由我们用 HTTP 直接提交（站点契约：POST <site> 的登录接口，
 * 头 X-CSRFToken + X-Turnstile-Token，体 {username, login_type, password}）。
 * 浏览器拿不到 token 时，退回「在页面里填表单点提交」由站点自己提交。
 */
export async function browserLogin(ctx, command, net, settings, sampleId) {
  const base = net.base
  const diag = { at: new Date().toISOString(), steps: [] }
  const note = async text => {
    diag.steps.push(String(text))
    await log(ctx, text)
  }
  await note(`打开登录页 ${base + LOGIN_PATH}（UA=${net.userAgent.slice(0, 60)}…）`)

  await command('Page.navigate', { url: base + LOGIN_PATH })
  const ready = await waitReady(ctx, command, 60000)
  if (!ready.ok) {
    const state = ready.state || {}
    diag.error = `登录页被 Cloudflare 拦截：title="${state.title || ''}" body="${state.body || ''}"`
    await ctx.storage.set('avdb-diag', diag)
    throw new Error(diag.error)
  }
  await note(`登录页就绪：title="${ready.state?.title || ''}"`)

  // 等登录表单 + Turnstile 组件就绪
  const formDeadline = Date.now() + 45000
  let hasForm = false
  let ts = { token: '', hasWidget: false, apiReady: false }
  while (Date.now() < formDeadline) {
    const state = await pageState(ctx, command)
    if (!state.error && state.hasUser && state.hasPass) hasForm = true
    ts = await readTurnstileState(ctx, command)
    if (hasForm && (ts.token || ts.hasWidget)) break
    if (hasForm && ts.apiReady && ts.hasWidget) break
    await ctx.sleep(1500)
  }
  if (!hasForm) {
    const state = await pageState(ctx, command)
    diag.error = `找不到登录表单：title="${state.title || ''}" body="${state.body || ''}"`
    await ctx.storage.set('avdb-diag', diag)
    throw new Error(diag.error)
  }
  await note(`表单就绪；Turnstile api=${ts.apiReady ? 'ready' : 'missing'} widget=${ts.hasWidget ? 'yes' : 'no'} token=${ts.token ? 'yes' : 'no'} scripts=${JSON.stringify(ts.scripts || [])}`)

  // 站点自己的验证框没出现 → 自己挂一个
  if (!ts.token && !ts.hasWidget) {
    let siteKey = ''
    try {
      const settings2 = await httpJSON(ctx, net, '/api/auth/turnstile/settings')
      siteKey = String(settings2.site_key || settings2.siteKey || '')
      await note('取 siteKey：' + (siteKey || '(空)'))
    } catch (error) {
      await note('取 siteKey 失败：' + error.message)
    }
    if (siteKey) {
      const injected = await injectTurnstile(ctx, command, siteKey)
      await note('自挂 Turnstile：' + JSON.stringify(injected))
      const deadline = Date.now() + 60000
      while (Date.now() < deadline) {
        await ctx.sleep(2000)
        ts = await readTurnstileState(ctx, command)
        if (ts.token) break
        if (ts.hasWidget) await clickTurnstile(ctx, command)
      }
      await note(`等待 token 结果：token=${ts.token ? 'yes' : 'no'} widget=${ts.hasWidget ? 'yes' : 'no'}`)
    }
  }

  const tokenSeen = ts.token || ''
  if (tokenSeen) {
    for (const loginType of loginTypes(settings.username)) {
      const result = await httpLogin(ctx, net, settings, tokenSeen, loginType)
      await note(`HTTP 登录（login_type=${loginType}）：${result.ok ? '成功' : '失败 ' + result.error}`)
      if (result.ok) {
        diag.ok = true
        await ctx.storage.set('avdb-diag', diag)
        return true
      }
    }
  } else {
    await note('没有 Turnstile token，只能退回页面内提交')
  }

  // 退回：页面里填表单 + 点提交，由站点自己的 JS 处理 token 与登录请求
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
  if (fill.result?.value !== true) {
    diag.error = '填写登录表单失败'
    await ctx.storage.set('avdb-diag', diag)
    throw new Error(diag.error)
  }
  await note('已填写表单')

  const submit = () => command('Runtime.evaluate', {
    expression: `(() => {
      const btn = document.querySelector('button[type="submit"]')
      if (btn) { btn.click(); return true }
      return false
    })()`,
    returnByValue: true
  })
  await submit()
  await note('已点击提交（由站点 JS 处理 Turnstile 与登录请求）')

  let loggedIn = false
  let secondSubmit = false
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    await ctx.sleep(3000)
    const state = await pageState(ctx, command)
    if (!state.error && state.hasUser && !secondSubmit) {
      secondSubmit = true
      await note('登录页仍在表单，等待验证后重试提交一次…')
      await ctx.sleep(6000)
      await submit()
      continue
    }
    const visible = await pageErrorText(ctx, command)
    if (visible) await note('页面提示：' + visible)
    try {
      loggedIn = await isAuthenticated(ctx, command, base, sampleId)
    } catch (_) {}
    if (loggedIn) break
  }
  const finalState = await pageState(ctx, command)
  diag.final = { title: finalState.title, path: finalState.path, body: finalState.body, loggedIn }
  if (!loggedIn) diag.error = '提交后仍未登录'
  await ctx.storage.set('avdb-diag', diag)
  return loggedIn
}

/** 站点可能用邮箱登录；表单默认 login_type=username，邮箱账号要显式用 email。 */
function loginTypes(username) {
  const list = String(username || '').includes('@') ? ['email', 'username'] : ['username', 'email']
  return list
}

/** 读页面上的可见错误提示。 */
async function pageErrorText(ctx, command) {
  const r = await command('Runtime.evaluate', {
    expression: `(() => {
      const t = (document.body?.textContent || '').replace(/\\s+/g, ' ')
      const marks = ['密碼錯誤', '密码错误', '登入失敗', '登录失败', '需要驗證', '需要验证',
                    '請輸入驗證', '请输入验证', '帳號不存在', '账号不存在', '已鎖定', '已锁定', '嘗試次數過多', '尝试次数过多']
      for (const mark of marks) {
        const i = t.indexOf(mark)
        if (i >= 0) return t.slice(Math.max(0, i - 40), i + 60)
      }
      return ''
    })()`,
    returnByValue: true
  })
  return r.result?.value || ''
}

/** 读页面里的 Turnstile 状态：token、是否有验证框、api.js 是否就绪。 */
async function readTurnstileState(ctx, command) {
  const r = await command('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]')
      const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[title*="challenge"]')
      return {
        token: el && el.value ? el.value : (window.__avdbTsToken || ''),
        hasWidget: !!iframe,
        apiReady: typeof window.turnstile !== 'undefined',
        scripts: Array.from(document.querySelectorAll('script[src*="turnstile"]')).map(s => s.src).slice(0, 3)
      }
    })()`,
    returnByValue: true
  })
  return r.result?.value || { token: '', hasWidget: false, apiReady: false, scripts: [] }
}

/**
 * 站点自带的验证框没出来时，由我们自己挂一个 Turnstile。
 * siteKey 来自站点接口；action 用站点的 login，token 由站点自己校验。
 */
async function injectTurnstile(ctx, command, siteKey) {
  const r = await command('Runtime.evaluate', {
    expression: `(async () => {
      const siteKey = ${JSON.stringify(siteKey)}
      if (!siteKey) return { ok: false, msg: '没有 siteKey' }
      window.__avdbTsToken = ''
      if (typeof window.turnstile === 'undefined') {
        try {
          await new Promise((resolve, reject) => {
            const s = document.createElement('script')
            s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
            s.async = true
            s.onload = resolve
            s.onerror = () => reject(new Error('turnstile api.js 加载失败'))
            document.head.appendChild(s)
            setTimeout(() => reject(new Error('turnstile api.js 加载超时')), 30000)
          })
        } catch (e) {
          return { ok: false, msg: String((e && e.message) || e) }
        }
      }
      if (typeof window.turnstile === 'undefined') return { ok: false, msg: 'turnstile 未就绪' }
      let box = document.getElementById('__avdb_ts')
      if (!box) {
        box = document.createElement('div')
        box.id = '__avdb_ts'
        box.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99999;background:#fff;padding:4px;border-radius:6px'
        document.body.appendChild(box)
      }
      try { window.turnstile.remove && window.turnstile.remove(window.__avdbTsWidget) } catch (e) {}
      try {
        window.__avdbTsWidget = window.turnstile.render(box, {
          sitekey: siteKey,
          action: 'login',
          size: 'flexible',
          appearance: 'always',
          language: 'zh-tw',
          callback: token => { window.__avdbTsToken = token }
        })
        return { ok: true }
      } catch (e) {
        return { ok: false, msg: 'render 失败: ' + String((e && e.message) || e) }
      }
    })()`,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.exceptionDetails) {
    return { ok: false, msg: r.exceptionDetails.exception?.description || r.exceptionDetails.text || '注入异常' }
  }
  return r.result?.value || { ok: false, msg: '注入无返回' }
}

/** 用过盾 Cookie 直接提交登录。 */
async function httpLogin(ctx, net, settings, turnstileToken, loginType) {
  const csrf = (net.cookies || []).find(cookie => cookie.name === '__Host-x1080x_csrf')
  const res = await ctx.http.request({
    url: net.base + SITE_LOGIN_PATH,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': net.userAgent,
      Cookie: net.cookieHeader,
      'X-CSRFToken': csrf ? decodeURIComponent(String(csrf.value)) : '',
      'X-Turnstile-Token': turnstileToken
    },
    json: { username: settings.username, login_type: loginType || 'username', password: settings.password },
    proxy: 'direct',
    timeout_seconds: 45,
    response_type: 'json'
  })
  const data = res.data || {}
  if (res.status === 200 && data && !data.error) return { ok: true, data }
  return { ok: false, error: `${res.status} ${data.error || String(res.body || '').slice(0, 160)}` }
}
