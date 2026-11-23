// X1080X 站点公共逻辑。
//
// 站点（1080xin.com）有 Cloudflare，过盾走 AVDB 的路线：FlareSolverr 真浏览器过一遍，
// 拿回 cf_clearance 等 Cookie 与 User-Agent；之后的列表、详情都用普通 HTTP 请求
// 复用这套 Cookie，不再让浏览器逐页跑。
//
// 游客身份就能看到「無碼BT」「有碼BT」两个板块的下载地址（实测 authenticated=false
// 时磁力链照常返回），所以插件不需要账号密码；「BT綜合區」这类帖子有 6 小时限时
// 免费窗口，过期后要会员权益，插件不绕过站点的会员限制。

export const HOSTS = ['https://1080xin.com', 'https://1080xin.vip']
export const HTTP_SESSION = 'x1080x'
export const DEFAULT_FLARESOLVERR = 'http://127.0.0.1:8191'
// FlareSolverr 会话名：固定一个，过盾 Cookie 留在同一个浏览器里复用。
export const FS_SESSION = 'avdb-lite'

const PLACEHOLDER_MARK = '請使用下面地址'
const CF_TITLES = ['Just a moment', '安全驗證', 'Checking your browser', 'Attention Required', 'One more step']
const CF_BODY_MARKS = [
  'challenge-platform', 'cf-challenge', 'cf_chl', '正在進行安全驗證', '安全服務防護',
  'Enable JavaScript and cookies to continue', 'Verification successful'
]
const MAGNET_RE = /magnet:\?xt=urn:btih:[A-Za-z0-9]+[^\s"'<>\\]*/gi
const ED2K_RE = /ed2k:\/\|file\|[^"'\s<>\\]+/gi

export function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const solver = String(value.flaresolverr_url || '').trim()
  return {
    flaresolverr_url: /^https?:\/\//i.test(solver) ? solver.replace(/\/+$/, '') : DEFAULT_FLARESOLVERR
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
 *  那个路径偶发 "unable to set cookie"；我们自建会话 + 重试更稳。
 *
 *  复用同一个 FS session 名，可以让过盾 Cookie 留在同一个浏览器里，
 *  之后几轮抓取不用每次都重新过 Cloudflare（挑战越多越容易被拦）。
 *  session 一旦状态不对（超时/仍是挑战页），就退回全新会话重试。 */
async function fsSolve(ctx, settings, url) {
  const endpoint = settings.flaresolverr_url.replace(/\/+$/, '')
  // 复用同一个 FS 会话：会话里还有放行 Cookie 时，1–2 秒就过；
  // 复用不了才开全新会话（全新会话必遇 Cloudflare 挑战，要 30–120 秒）。
  const attempts = [
    { cmd: 'request.get', url, maxTimeout: 180000, session: FS_SESSION, session_ttl_minutes: 30 },
    { cmd: 'request.get', url, maxTimeout: 180000 }
  ]
  let lastError = ''
  for (let index = 0; index < attempts.length; index++) {
    try {
      const res = await ctx.http.request({
        url: endpoint + '/v1',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(attempts[index]),
        proxy: 'direct',
        // 复用会话一般 2 秒内返回；全新会话要过 CF 挑战，给 150 秒。
        timeout_seconds: index === 0 ? 60 : 200,
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
    } catch (error) {
      lastError = error && error.message ? error.message : String(error)
      await log(ctx, `FlareSolverr 第 ${index + 1} 次失败：${lastError}`)
    }
  }
  throw new Error(lastError)
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
 * 优先自建 FlareSolverr 会话（每站最多 2 次、整体 4 分钟上限），
 * 退路用宿主 ctx.http.render。
 */
export async function solveChallenge(ctx, settings, path = '/') {
  let lastError = ''
  // 一次过盾要 1–2 分钟（CF 挑战 + 站点 JS），所以整体留 4 分钟，
  // 免得任务被拖到十几分钟还没结果。
  const deadline = Date.now() + 200000
  for (const host of HOSTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (Date.now() > deadline) break
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
        if (Date.now() > deadline) break
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
  let res = null
  let lastError = null
  // 连接偶尔会被对端直接掐断（拿不到 HTTP 状态码），重试两次。
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      res = await ctx.http.request({
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
      lastError = null
      break
    } catch (error) {
      lastError = error
      const text = String(error && error.message ? error.message : error)
      // 明确的业务错误不用重试
      if (/turnstile_required|browser_pass_required/.test(text)) throw error
      await log(ctx, `请求失败（第 ${attempt} 次）${path}：${text.slice(0, 120)}`)
      if (attempt >= 3) throw error
      await ctx.sleep(1500 * attempt)
    }
  }
  if (!res) throw lastError || new Error('请求失败')
  if (res.status !== 200) {
    const body = String(res.body || '').slice(0, 200)
    const code = (res.data && (res.data.error || res.data.code)) || ''
    // turnstile_required 是站点自己的「游客阅读上限」，不是 Cloudflare 拦截：
    // 过盾 Cookie 是好的，只是短时间内读太多主题被限速了。
    if (code === 'turnstile_required' || /turnstile_required/.test(body)) {
      throw new Error(`站点限制游客阅读（turnstile_required），不是 Cloudflare 拦截：${body.slice(0, 120)}`)
    }
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

/**
 * 刷新本插件送出去的磁力在 115 上的状态，结果写进插件 KV（avdb-115）。
 *
 * 宿主「查离线任务」接口会把账号下所有离线任务都拉一遍（115 的列表是加密的，
 * 一次调用要好几秒），所以这件事放到后台做，页面只读 KV。
 */
export async function syncOfflineState(ctx) {
  const sent = await ctx.storage.get('avdb-sent')
  const list = Array.isArray(sent) ? sent : []
  if (!list.length) {
    await ctx.storage.set('avdb-115', [])
    return []
  }
  const own = new Set(list.map(item => String(item.hash || '').toUpperCase()).filter(Boolean))
  let tasks = []
  try {
    const res = await ctx.api.get('/api/115/offline/tasks?page=1&page_size=50&status=all')
    tasks = Array.isArray(res?.items) ? res.items : (Array.isArray(res) ? res : [])
  } catch (error) {
    await log(ctx, '读 115 离线任务失败：' + (error && error.message ? error.message : error))
    tasks = []
  }
  const byHash = new Map()
  for (const task of tasks) {
    const hash = String(task.info_hash || '').toUpperCase()
    if (own.has(hash)) byHash.set(hash, task)
  }
  const now = new Date().toISOString()
  const state = list.slice(0, 100).map(item => {
    const task = byHash.get(String(item.hash || '').toUpperCase())
    return {
      hash: item.hash,
      title: item.title || (task && task.name) || '',
      sent_at: item.at || '',
      updated_at: now,
      found: Boolean(task),
      status: task ? String(task.status || '') : 'unknown',
      progress: task ? Number(task.progress || 0) : 0,
      rate: task ? Number(task.download_rate || 0) : 0,
      size: task ? Number(task.size || 0) : 0,
      error: task ? String(task.error || '') : ''
    }
  })
  await ctx.storage.set('avdb-115', state)
  return state
}

/** 站点限制游客阅读时的退避间隔（毫秒）。 */
const RATE_BACKOFF = [0, 20000, 45000]

/** 详情之间的间隔：随机化，避免固定节奏被当成机器人。 */
function detailDelay() {
  return 1200 + Math.floor(Math.random() * 3800)
}

/**
 * 取详情。站点对游客有阅读频率上限，超了会返回 turnstile_required；
 * 这时等一会儿重试（退避），仍然不行就抛出去，由调用方跳过这一条。
 */
export async function fetchDetail(ctx, settings, net, path) {
  let lastError = null
  for (const wait of RATE_BACKOFF) {
    if (wait) {
      await log(ctx, `站点限制游客阅读，等 ${Math.round(wait / 1000)} 秒后重试：${path}`)
      await ctx.sleep(wait)
    }
    try {
      return await fetchJSON(ctx, settings, net, path)
    } catch (error) {
      lastError = error
      if (!/turnstile_required/.test(String(error && error.message ? error.message : error))) throw error
    }
  }
  throw lastError
}
