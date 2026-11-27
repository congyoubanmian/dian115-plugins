// qBittorrent WebUI API v2 适配。
//
// 修复项：
// - login 与所有后续请求共用同一独立 session（不再出现 login 没带 session、后续带 default 拿不到 Cookie）
// - 大小写不敏感读取 Set-Cookie，兼容 SID 与 qB 4.6+ 的 QBT_SID_<port>
// - 403 会话过期自动重登一次
// - addTorrent 同时传 paused 与 stopped，兼容 qB 4.x 与 qB 5.x
// - 内网/本机地址默认 proxy:'direct'，防止被宿主代理劫持

function isPrivateOrLocal(urlStr) {
  try {
    const h = new URL(urlStr).hostname.toLowerCase()
    return h === 'localhost' || h === '::1' ||
      h.startsWith('127.') || h.startsWith('10.') ||
      h.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  } catch {
    return false
  }
}

function getHeaderCaseInsensitive(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined
  const target = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v
  }
  return undefined
}

function concatBytes(parts) {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function encodeUtf8(ctx, str) {
  if (ctx?.codec && typeof ctx.codec.utf8Encode === 'function') return ctx.codec.utf8Encode(str)
  return new TextEncoder().encode(str)
}

function decodeB64(ctx, b64) {
  if (ctx?.codec && typeof ctx.codec.base64Decode === 'function') {
    const v = ctx.codec.base64Decode(b64)
    return v instanceof Uint8Array ? v : new Uint8Array(v)
  }
  throw new Error('缺少 ctx.codec.base64Decode')
}

function encodeB64(ctx, bytes) {
  if (ctx?.codec && typeof ctx.codec.base64Encode === 'function') {
    return ctx.codec.base64Encode(bytes)
  }
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

// 构造固定长度的 multipart/form-data 字节流（带精确 Content-Length）。
// 原因：宿主 ctx.http.request({ multipart }) 采用流式管道发送 Transfer-Encoding: chunked，
// 而 qBittorrent 的 Qt HTTP 解析器不支持 chunked POST（会把块长度行如 "72" 当成新请求行报 400）。
function buildMultipartPayload(ctx, fields, file) {
  const boundary = '----Dian115ReseedBoundary' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const parts = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(encodeUtf8(ctx,
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="' + k + '"\r\n\r\n' +
      String(v ?? '') + '\r\n'
    ))
  }
  const fileBytes = decodeB64(ctx, file.base64)
  parts.push(encodeUtf8(ctx,
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="' + file.field + '"; filename="' + file.filename + '"\r\n' +
    'Content-Type: ' + (file.content_type || 'application/x-bittorrent') + '\r\n\r\n'
  ))
  parts.push(fileBytes)
  parts.push(encodeUtf8(ctx, '\r\n--' + boundary + '--\r\n'))
  return {
    contentType: 'multipart/form-data; boundary=' + boundary,
    bodyBase64: encodeB64(ctx, concatBytes(parts))
  }
}

export class Qbittorrent {
  constructor({ id = 'qb', name = 'qBittorrent', url, username, password, timeout = 30, directProxy = true, tags = ['辅种'], paused = false, skipChecking = true }) {
    this.id = String(id || 'qb')
    this.name = String(name || 'qBittorrent')
    this.type = 'qbittorrent'
    this.url = String(url || '').trim().replace(/\/+$/, '')
    this.username = String(username || '')
    this.password = String(password || '')
    this.timeout = Number(timeout) || 30
    this.directProxy = directProxy !== false
    this.defaultTags = Array.isArray(tags) ? tags : ['辅种']
    this.defaultPaused = paused === true
    this.defaultSkipChecking = skipChecking !== false
    this.session = 'reseed-qb-' + this.id.replace(/[^a-z0-9_-]/gi, '')
    this.cookie = ''
    this.loggedIn = false
  }

  get configured() {
    return /^https?:\/\//i.test(this.url)
  }

  reqOpts(extra = {}) {
    const opts = {
      session: this.session,
      timeout_seconds: this.timeout,
      ...extra
    }
    if (this.directProxy && isPrivateOrLocal(this.url)) {
      opts.proxy = 'direct'
    }
    return opts
  }

  headers(extra = {}) {
    const h = { Referer: this.url, Origin: this.url, ...extra }
    if (this.cookie) h.Cookie = this.cookie
    return h
  }

  async login(ctx, force = false) {
    if (this.loggedIn && !force) return true
    this.cookie = ''
    this.loggedIn = false
    const res = await ctx.http.request(this.reqOpts({
      url: this.url + '/api/v2/auth/login',
      method: 'POST',
      headers: { Referer: this.url, Origin: this.url },
      form: { username: this.username, password: this.password }
    }))
    const body = String(res.body || '').trim()
    if (res.status !== 204 && !(res.status >= 200 && res.status < 300 && body === 'Ok.')) {
      throw new Error(this.name + ' 登录失败（HTTP ' + res.status + '）：' + (body || '请核对用户名密码').slice(0, 120))
    }
    const setCookie = getHeaderCaseInsensitive(res.headers, 'set-cookie')
    const list = Array.isArray(setCookie) ? setCookie : [setCookie].filter(Boolean)
    const jar = []
    for (const c of list) {
      const m = String(c).match(/(?:^|;\s*)([A-Za-z0-9_]*SID[A-Za-z0-9_]*)=([^;]+)/i)
      if (m) jar.push(m[1] + '=' + m[2])
    }
    if (jar.length) this.cookie = jar.join('; ')
    this.loggedIn = true
    return true
  }

  async authedRequest(ctx, opts) {
    if (!this.loggedIn) await this.login(ctx)
    let res = await ctx.http.request(this.reqOpts({
      ...opts,
      headers: this.headers(opts.headers || {})
    }))
    if (res.status === 403) {
      await this.login(ctx, true)
      res = await ctx.http.request(this.reqOpts({
        ...opts,
        headers: this.headers(opts.headers || {})
      }))
    }
    return res
  }

  async version(ctx) {
    const res = await this.authedRequest(ctx, {
      url: this.url + '/api/v2/app/version',
      method: 'GET'
    })
    return res.status >= 200 && res.status < 300 ? String(res.body || '').trim() : ''
  }

  // 拉取全部种子并归一化字段，避免逐种子查询产生 O(N) 次 HTTP 请求
  async torrents(ctx) {
    const res = await this.authedRequest(ctx, {
      url: this.url + '/api/v2/torrents/info',
      method: 'GET',
      response_type: 'json'
    })
    if (res.status >= 400) {
      throw new Error(this.name + ' 读取种子列表失败（HTTP ' + res.status + '）')
    }
    const list = Array.isArray(res.data)
      ? res.data
      : (typeof res.body === 'string' && res.body.trim() ? JSON.parse(res.body) : [])
    if (!Array.isArray(list)) return []
    return list.map((t) => ({
      hash: String(t.hash || t.infohash_v1 || '').toLowerCase(),
      name: String(t.name || ''),
      savePath: String(t.save_path || ''),
      contentPath: String(t.content_path || ''),
      state: String(t.state || ''),
      progress: Number(t.progress ?? 0),
      size: Number(t.total_size ?? t.size ?? 0),
      tracker: String(t.tracker || ''),
      trackers: t.tracker ? [String(t.tracker)] : [],
      tags: String(t.tags || '').split(',').map((s) => s.trim()).filter(Boolean),
      category: String(t.category || ''),
      downloaderId: this.id,
      downloaderName: this.name,
      downloaderType: this.type
    }))
  }

  async findTorrent(ctx, infoHash) {
    const h = String(infoHash || '').toLowerCase()
    if (!h) return null
    const res = await this.authedRequest(ctx, {
      url: this.url + '/api/v2/torrents/info?hashes=' + encodeURIComponent(h),
      method: 'GET',
      response_type: 'json'
    })
    const list = Array.isArray(res.data)
      ? res.data
      : (typeof res.body === 'string' && res.body.trim() ? JSON.parse(res.body) : [])
    if (!Array.isArray(list) || !list.length) return null
    const t = list[0]
    return {
      hash: String(t.hash || h).toLowerCase(),
      name: String(t.name || ''),
      savePath: String(t.save_path || ''),
      state: String(t.state || ''),
      progress: Number(t.progress ?? 0),
      tracker: String(t.tracker || '')
    }
  }

  async addTorrent(ctx, { contentBase64, savePath, paused, skipChecking, tags, category }) {
    const isPaused = paused !== undefined ? !!paused : this.defaultPaused
    const isSkip = skipChecking !== undefined ? !!skipChecking : this.defaultSkipChecking
    const tagList = Array.isArray(tags) ? tags : this.defaultTags
    const fields = {
      savepath: savePath || '',
      // 同时传 paused（qB 4.x）与 stopped（qB 5.x），确保暂停添加在两代版本都生效
      paused: isPaused ? 'true' : 'false',
      stopped: isPaused ? 'true' : 'false',
      skip_checking: isSkip ? 'true' : 'false',
      autoTMM: 'false'
    }
    if (tagList.length) fields.tags = tagList.join(',')
    if (category) fields.category = String(category)

    const mp = buildMultipartPayload(ctx, fields, {
      field: 'torrents',
      filename: 'reseed.torrent',
      base64: contentBase64,
      content_type: 'application/x-bittorrent'
    })

    const res = await this.authedRequest(ctx, {
      url: this.url + '/api/v2/torrents/add',
      method: 'POST',
      headers: { 'Content-Type': mp.contentType },
      body_base64: mp.bodyBase64
    })
    const body = String(res.body || '').trim()
    if (res.status === 409) return { alreadyExists: true }
    if (res.status >= 400) {
      throw new Error(this.name + ' 添加失败（HTTP ' + res.status + '）：' + body.slice(0, 120))
    }
    if (body.startsWith('{')) {
      let j = null
      try { j = JSON.parse(body) } catch { /* ignore */ }
      if (j && typeof j.failure_count === 'number' && j.failure_count > 0) {
        throw new Error(this.name + ' 拒绝种子（failure_count=' + j.failure_count + '）')
      }
      if (j && Array.isArray(j.added_torrent_ids)) {
        return { added: true, ids: j.added_torrent_ids }
      }
    }
    if (body && body !== 'Ok.') {
      throw new Error(this.name + ' 添加失败：' + body.slice(0, 120))
    }
    return { added: true }
  }

  async probe(ctx) {
    await this.login(ctx, true)
    const [ver, list] = await Promise.all([
      this.version(ctx).catch(() => ''),
      this.torrents(ctx)
    ])
    return { ok: true, version: ver, torrents: list.length }
  }
}
