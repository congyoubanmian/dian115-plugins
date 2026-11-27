// PT 站点定义、方言推断、Tracker 域名归属识别与 pieces-hash 协议适配。
//
// 支持四类方言：
//   - nexusphp（标准上游）：POST {url}/api/pieces-hash   body {passkey, pieces_hash}
//                           GET  {url}/download.php?id={id}&passkey={passkey}
//   - nexusapi（憨憨等）  ：POST {url}/nexusapi/pieces-hash
//                           GET  {url}/download.php?id={id}&passkey={passkey}
//   - flux（FluxTorrent） ：POST {url}/api/v1/crossseed/lookup  Header Authorization: Token <fxo_...>
//                           body {pieces_sha1}  resp {data:{results:[{query,torrent_id}]}}
//                           GET  {url}/api/v1/crossseed/dl/{id}  Header Authorization: Token <fxo_...>
//   - custom（完全自定义）：自定义查询接口 + 可选下载模板（支持 {id} / {passkey} 占位符）

const FLUX_TOKEN_PREFIX = 'fxo_'

// 仅当凭据是 fxo_ 开头或显式选 FluxTorrent 方言时才走 Flux；
// AGSVPT / 麒麟 / 聆音 / UBits / 青蛙 等站实测支持标准 /api/pieces-hash，不能按名字强判 Flux。
const FLUX_SITE_NAMES = new Set([])
const NEXUS_API_NAMES = new Set(['憨憨', '憨憨 HHanClub', 'hhanclub'])

// 内置常见 PT 站点预设（2026-11 实测校准，用户可自由增删改、添加任意自定义站点）
export const BUILTIN_SITES = [
  { id: 'soulvoice', name: '聆音 SoulVoice', url: 'https://pt.soulvoice.club', api: 'https://pt.soulvoice.club/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['pt.soulvoice.club', 'soulvoice.club'] },
  { id: 'hhanclub', name: '憨憨 HHanClub', url: 'https://hhanclub.net', api: 'https://hhanclub.net/nexusapi/pieces-hash', dialect: 'nexusapi', trackerDomains: ['hhanclub.net', 'hhan.club', 'tracker.hhan.club', 'hhanclub.top'] },
  { id: 'agsvpt', name: 'AGSVPT', url: 'https://www.agsvpt.com', api: 'https://www.agsvpt.com/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['agsvpt.com', 'www.agsvpt.com', 'agsvpt.trackers.work', 'agsvpt.work', 'agsvpt.cn', 'tracker.agsvpt.cn'] },
  { id: 'carpt', name: '车站 CarPT', url: 'https://carpt.net', api: 'https://carpt.net/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['carpt.net', 'tracker.carpt.net'] },
  { id: 'hdkylin', name: '麒麟 HDKylin', url: 'https://www.hdkyl.in', api: 'https://www.hdkyl.in/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['hdkyl.in', 'www.hdkyl.in', 'tracker.hdkyl.in', 'hdkylin.top', 'www.hdkylin.top'] },
  { id: 'zmpt', name: '织梦 ZMPT', url: 'https://zmpt.cc', api: 'https://zmpt.cc/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['zmpt.cc'] },
  { id: 'hdfans', name: 'HDFans', url: 'https://hdfans.org', api: 'https://hdfans.org/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['hdfans.org'] },
  { id: 'wintersakura', name: '冬樱 WinterSakura', url: 'https://wintersakura.net', api: 'https://wintersakura.net/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['wintersakura.net', 'tracker.wintersakura.net'] },
  { id: 'crabpt', name: '蟹黄堡 CrabPT', url: 'https://crabpt.vip', api: 'https://crabpt.vip/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['crabpt.vip'] },
  { id: 'gamegamept', name: 'GGPT 游戏', url: 'https://www.gamegamept.com', api: 'https://www.gamegamept.com/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['gamegamept.com', 'www.gamegamept.com'] },
  { id: 'qingwa', name: '青蛙 QingWa', url: 'https://www.qingwapt.org', api: 'https://www.qingwapt.org/api/pieces-hash', dialect: 'auto', trackerDomains: ['qingwapt.org', 'www.qingwapt.org', 'qingwapt.com', 'newqingwa.com'] },
  { id: 'ubits', name: 'UBits', url: 'https://ubits.club', api: 'https://ubits.club/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['ubits.club'] },
  { id: 'hdhome', name: '家园 HDHome', url: 'https://hdhome.org', api: 'https://hdhome.org/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['hdhome.org'] },
  { id: 'hdtime', name: 'HDTime', url: 'https://hdtime.org', api: 'https://hdtime.org/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['hdtime.org'] },
  { id: 'cyanbug', name: '大青虫 CyanBug', url: 'https://cyanbug.net', api: 'https://cyanbug.net/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['cyanbug.net'] },
  { id: 'ptcafe', name: 'PTCafe 咖啡', url: 'https://ptcafe.club', api: 'https://ptcafe.club/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['ptcafe.club'] },
  { id: 'kufei', name: '库非 KuFei', url: 'https://kufei.org', api: 'https://kufei.org/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['kufei.org'] },
  { id: 'oshen', name: '奥申 Oshen', url: 'https://www.oshen.win', api: 'https://www.oshen.win/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['oshen.win', 'www.oshen.win'] },
  { id: 'ultrahd', name: 'UltraHD', url: 'https://ultrahd.net', api: 'https://ultrahd.net/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['ultrahd.net'] },
  { id: 'leaves', name: '红叶 Leaves', url: 'https://leaves.red', api: '', dialect: 'auto', trackerDomains: ['leaves.red'] },
  { id: 'piggo', name: '猪猪 PigGo', url: 'https://piggo.me', api: 'https://api.piggo.me/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['piggo.me', 'api.piggo.me'] },
  { id: 'keepfrds', name: '月月 KeepFRDS', url: 'https://pt.keepfrds.com', api: 'https://pt.keepfrds.com/api/torrents/pieces-hash', dialect: 'nexusphp', trackerDomains: ['pt.keepfrds.com', 'keepfrds.com'] },
  { id: 'ptlsp', name: 'PTLSP', url: 'https://www.ptlsp.com', api: '', dialect: 'auto', trackerDomains: ['ptlsp.com', 'www.ptlsp.com', 'tracker.ptlsp.com', 'x.ptlsp.com'] },
  { id: '1ptba', name: '1PTBA', url: 'https://1ptba.com', api: '', dialect: 'auto', trackerDomains: ['1ptba.com'] },
  { id: 'rousi', name: '肉丝 RouSi', url: 'https://rousi.pro', api: '', dialect: 'auto', trackerDomains: ['rousi.pro', 'rousi.zip'] },
  { id: 'hdpt', name: '明教 HDPT', url: 'https://hdpt.xyz', api: '', dialect: 'auto', trackerDomains: ['hdpt.xyz'] },
  { id: '2xfree', name: '2xFree', url: 'https://pt.2xfree.org', api: '', dialect: 'auto', trackerDomains: ['2xfree.org', 'pt.2xfree.org'] },
  { id: '3wmg', name: '3WMG 芒果', url: 'https://3wmg.com', api: '', dialect: 'auto', trackerDomains: ['3wmg.com', 'www.3wmg.com'] }
]

// 仅用于识别本地种子的来源站点（含未开放 pieces-hash 或已关站站点，便于友好展示来源站名与同站排重）
export const TRACKER_ALIASES = [
  { name: '馒头 M-Team', domains: ['m-team.cc', 'm-team.io', 'tra1.m-team.cc', 'tra1.m-team.io', 'tracker.m-team.cc'] },
  { name: '学校 BTSchool', domains: ['btschool.club', 'pt.btschool.club'] },
  { name: '海胆 HaiDan', domains: ['haidan.video', 'announce.haidan.video'] },
  { name: '柠檬 LemonHD', domains: ['leaguehd.com', 'announce.leaguehd.com', 'lemonhd.org', 'ilovelemonhd.me'] },
  { name: '飞丝猫 FSM', domains: ['fsm.name', 'connects.icu', 'fsm-us.eu.org'] },
  { name: '观众 Audiences', domains: ['audiences.me'] },
  { name: '彩虹岛 CHDBits', domains: ['chdbits.co', 'ptchdbits.co'] },
  { name: '天空 HDSky', domains: ['hdsky.me'] },
  { name: '猫站 PterClub', domains: ['pterclub.com', 'pterclub.net'] },
  { name: '春天 SSD', domains: ['springsunday.net'] },
  { name: '瓷器 HDChina', domains: ['hdchina.org'] },
  { name: '高清杜比 HDdolby', domains: ['uhddolby.com', 'hddolby.com'] },
  { name: '我堡 OurBits', domains: ['ourbits.club'] },
  { name: '吐司 TTG', domains: ['totheglory.im'] },
  { name: '北邮人 BYR', domains: ['byr.pt'] },
  { name: '鲨鱼 SharkPT', domains: ['sharkpt.net', 'tracker.sharkpt.net'] },
  { name: 'NextPT', domains: ['nextpt.net'] },
  { name: '冰淇淋 ICC2022', domains: ['icc2022.com', 'icc2022.xyz', 'icc2022.de', 'czhch.com'] },
  { name: '阿童木 HDAtmos', domains: ['hdatmos.club'] }
]

const BUILTIN_BY_ID = new Map(BUILTIN_SITES.map((s) => [s.id, s]))

export function extractHostname(urlOrHost) {
  const s = String(urlOrHost || '').trim()
  if (!s) return ''
  try {
    if (/^https?:\/\//i.test(s)) return new URL(s).hostname.toLowerCase()
    return s.replace(/\/.*$/, '').replace(/:\d+$/, '').toLowerCase()
  } catch {
    return ''
  }
}

export function rootDomain(host) {
  const h = extractHostname(host)
  if (!h) return ''
  const parts = h.split('.').filter(Boolean)
  if (parts.length <= 2) return h
  // 常见双后缀处理
  const last2 = parts.slice(-2).join('.')
  if (['co.uk', 'com.cn', 'org.cn', 'net.cn', 'com.hk', 'com.tw'].includes(last2) && parts.length >= 3) {
    return parts.slice(-3).join('.')
  }
  return last2
}

export function isFluxSite(name, token, apiUrl = '', dialect = 'auto') {
  if (dialect === 'flux') return true
  if (dialect === 'nexusphp' || dialect === 'nexusapi') return false
  const n = String(name || '').trim()
  const tk = String(token || '').trim()
  const api = String(apiUrl || '').trim()
  if (tk.startsWith(FLUX_TOKEN_PREFIX)) return true
  if (/\/crossseed\//i.test(api)) return true
  // 若用户已填标准 32 位 passkey（非 fxo_），一律不按站点名强判 Flux
  if (tk && !tk.startsWith(FLUX_TOKEN_PREFIX)) return false
  if (n && FLUX_SITE_NAMES.has(n)) return true
  return false
}

export function resolveDialect(raw) {
  const explicit = String(raw.dialect || 'auto').trim().toLowerCase()
  if (['nexusphp', 'nexusapi', 'flux', 'custom'].includes(explicit)) return explicit
  const name = String(raw.name || '').trim()
  const passkey = String(raw.passkey || '').trim()
  const api = String(raw.api || raw.apiUrl || '').trim()
  if (isFluxSite(name, passkey, api, 'auto')) return 'flux'
  if (/\/nexusapi\//i.test(api) || NEXUS_API_NAMES.has(name)) return 'nexusapi'
  return 'nexusphp'
}

export function lookupUrl(site) {
  const api = String(site.api || site.apiUrl || '').trim()
  if (api) return api
  const base = String(site.siteUrl || site.url || '').trim().replace(/\/+$/, '')
  if (!base) return ''
  const d = site.dialect || resolveDialect(site)
  if (d === 'flux') return base + '/api/v1/crossseed/lookup'
  if (d === 'nexusapi') return base + '/nexusapi/pieces-hash'
  return base + '/api/pieces-hash'
}

export function downloadUrl(site, torrentId) {
  const tpl = String(site.downloadTemplate || '').trim()
  if (tpl) {
    return tpl
      .replace(/\{id\}/g, encodeURIComponent(String(torrentId)))
      .replace(/\{passkey\}/g, encodeURIComponent(String(site.passkey || '')))
  }
  const base = String(site.siteUrl || site.url || '').trim().replace(/\/+$/, '')
  if (site.flux || site.dialect === 'flux') {
    return base + '/api/v1/crossseed/dl/' + encodeURIComponent(String(torrentId))
  }
  return base + '/download.php?id=' + encodeURIComponent(String(torrentId)) +
    '&passkey=' + encodeURIComponent(String(site.passkey || ''))
}

export function normalizeSite(raw, idx = 0) {
  const url = String(raw.url || raw.siteUrl || '').trim().replace(/\/+$/, '')
  const name = String(raw.name || '').trim() || extractHostname(url) || ('站点-' + (idx + 1))
  const passkey = String(raw.passkey || '').trim()
  const api = String(raw.api || raw.apiUrl || '').trim()
  const dialect = resolveDialect({ ...raw, name, passkey, api })
  const flux = dialect === 'flux'
  const host = extractHostname(url)
  const rawTrackers = Array.isArray(raw.trackerDomains)
    ? raw.trackerDomains
    : String(raw.trackerDomains || '').split(/[\s,;，]+/)
  const trackerSet = new Set()
  if (host) trackerSet.add(host)
  for (const t of rawTrackers) {
    const h = extractHostname(t)
    if (h) trackerSet.add(h)
  }
  const apiHost = extractHostname(api)
  if (apiHost) trackerSet.add(apiHost)
  const id = String(raw.id || '').trim() ||
    (host ? host.replace(/[^a-z0-9.-]/g, '') : 'site-' + idx)
  // 自动合并同 id 内置站点的最新 trackerDomains（确保旧配置也能准确识别独立 tracker 域名）
  const builtin = BUILTIN_BY_ID.get(id)
  if (builtin && Array.isArray(builtin.trackerDomains)) {
    for (const t of builtin.trackerDomains) {
      const h = extractHostname(t)
      if (h) trackerSet.add(h)
    }
  }
  const site = {
    id,
    name,
    url,
    siteUrl: url,
    api,
    dialect,
    flux,
    passkey,
    downloadTemplate: String(raw.downloadTemplate || '').trim(),
    trackerDomains: [...trackerSet],
    enabled: !!raw.enabled,
    custom: !!raw.custom
  }
  site.apiUrl = lookupUrl(site)
  return site
}

// 构造查询请求头与请求体
export function lookupRequest(site, fingerprints) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'DIAN115-ReseedPuppy/0.6'
  }
  if (site.flux || site.dialect === 'flux') {
    headers.Authorization = 'Token ' + site.passkey
    return { headers, body: JSON.stringify({ pieces_sha1: fingerprints }) }
  }
  return { headers, body: JSON.stringify({ passkey: site.passkey, pieces_hash: fingerprints }) }
}

// 构造种子下载请求头（修复 FluxTorrent 缺少 Authorization 头导致 401 的问题）
export function downloadHeaders(site) {
  const headers = {
    'User-Agent': 'DIAN115-ReseedPuppy/0.6',
    Accept: 'application/x-bittorrent, application/octet-stream, */*'
  }
  if (site.flux || site.dialect === 'flux') {
    headers.Authorization = 'Token ' + site.passkey
  }
  return headers
}

// 解析查询响应（带 HTTP 状态与 HTML 200 错页防护）
export function parseLookupHttpResponse(site, res) {
  const status = Number(res?.status || 0)
  const rawBody = typeof res?.body === 'string' ? res.body : ''
  if (status >= 400) {
    throw new Error('HTTP ' + status + (rawBody ? '：' + rawBody.replace(/<[^>]+>/g, ' ').trim().slice(0, 120) : ''))
  }
  let parsed = res?.data ?? res?.json ?? null
  if (!parsed && rawBody) {
    const trimmed = rawBody.trim()
    if (trimmed.startsWith('<')) {
      const titleMatch = trimmed.match(/<title[^>]*>([^<]{1,80})/i)
      const hint = titleMatch ? titleMatch[1].trim() : 'HTML 页面'
      throw new Error('接口返回了网页而非 JSON（' + hint + '），请核对查询接口路径或过盾状态')
    }
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new Error('接口响应不是有效 JSON：' + trimmed.slice(0, 100))
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('接口返回空响应')
  }
  // 部分站点返回 { ret: 400 / success: false / code != 0, msg / message }
  if (parsed.success === false || (typeof parsed.ret === 'number' && parsed.ret !== 0 && parsed.ret !== 200)) {
    const msg = parsed.msg || parsed.message || parsed.error || ('code=' + (parsed.ret ?? parsed.code))
    throw new Error('站点拒绝查询：' + String(msg).slice(0, 120))
  }
  if (site.flux && typeof parsed.code === 'number' && parsed.code !== 0) {
    throw new Error('Flux 接口错误：' + String(parsed.message || parsed.msg || ('code=' + parsed.code)).slice(0, 120))
  }
  return parseLookupResponse(site, parsed)
}

export function parseLookupResponse(site, parsed) {
  const data = parsed?.data
  if (!data) return []

  if (site.flux || site.dialect === 'flux') {
    const results = data.results
    if (!Array.isArray(results)) return []
    const out = []
    for (const row of results) {
      if (!row || typeof row !== 'object') continue
      const tid = row.torrent_id ?? row.id
      if (tid === undefined || tid === null || tid === '') continue
      const piecesHash = String(row.query || '').trim().toLowerCase()
      if (!piecesHash) continue
      out.push({ piecesHash, torrentId: String(tid) })
    }
    return out
  }

  // 上游方言：data 为 { sha1: torrent_id }；部分站无命中时返回 []
  if (typeof data !== 'object' || Array.isArray(data)) return []
  const out = []
  for (const [k, v] of Object.entries(data)) {
    if (k === 'passkey' || k === 'pieces_hash' || k === 'results') continue
    if (v === undefined || v === null || v === '') continue
    out.push({ piecesHash: String(k).trim().toLowerCase(), torrentId: String(v) })
  }
  return out
}

// 判断某站点是否和一组本地 tracker 域名属于同一站点
export function isSameSite(site, announceHosts) {
  if (!Array.isArray(announceHosts) || !announceHosts.length) return false
  const siteRoots = new Set()
  const siteHosts = new Set()
  const push = (h) => {
    const norm = extractHostname(h)
    if (!norm) return
    siteHosts.add(norm)
    const rd = rootDomain(norm)
    if (rd) siteRoots.add(rd)
  }
  push(site.siteUrl || site.url)
  for (const td of site.trackerDomains || []) push(td)

  for (const raw of announceHosts) {
    const h = extractHostname(raw)
    if (!h) continue
    if (siteHosts.has(h)) return true
    const rd = rootDomain(h)
    if (rd && siteRoots.has(rd)) return true
  }
  return false
}

// 根据 tracker 域名猜测可读的站点名（优先匹配用户已配置站点，其次内置库和常见别名）
export function identifyTrackerSite(announceHosts, configuredSites = []) {
  const hosts = (Array.isArray(announceHosts) ? announceHosts : [announceHosts])
    .map(extractHostname)
    .filter(Boolean)
  if (!hosts.length) return ''

  for (const s of configuredSites) {
    if (isSameSite(s, hosts)) return s.name
  }
  for (const s of BUILTIN_SITES) {
    if (isSameSite(s, hosts)) return s.name
  }
  for (const alias of TRACKER_ALIASES) {
    const aliasRoots = new Set(alias.domains.map(rootDomain))
    for (const h of hosts) {
      if (alias.domains.includes(h) || aliasRoots.has(rootDomain(h))) return alias.name
    }
  }
  return hosts[0]
}
