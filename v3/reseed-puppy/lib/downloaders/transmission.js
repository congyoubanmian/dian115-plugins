// Transmission RPC 适配。
//
// 修复项：
// - 空 URL 不再误拼成 '/transmission/rpc' 导致 configured=true
// - Basic Auth 使用 UTF-8 安全的 ctx.codec.base64Encode（带 btoa 兜底）
// - 独立 session + 内网 proxy:'direct'
// - torrents() 归一化结构与 qBittorrent 一致，并带 trackers / labels
// - addTorrent() 支持 labels（标签）

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

function base64Utf8(ctx, text) {
  if (ctx?.codec && typeof ctx.codec.base64Encode === 'function') {
    if (typeof ctx.codec.utf8Encode === 'function') {
      return ctx.codec.base64Encode(ctx.codec.utf8Encode(text))
    }
    return ctx.codec.base64Encode(text)
  }
  if (typeof TextEncoder === 'function' && typeof btoa === 'function') {
    const bytes = new TextEncoder().encode(text)
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin)
  }
  if (typeof btoa === 'function') return btoa(text)
  return ''
}

const TR_STATE_MAP = {
  0: 'stopped',
  1: 'check_wait',
  2: 'checking',
  3: 'dl_wait',
  4: 'downloading',
  5: 'seed_wait',
  6: 'seeding'
}

export class Transmission {
  constructor({ id = 'tr', name = 'Transmission', url, username, password, timeout = 30, directProxy = true, tags = ['辅种'], paused = false }) {
    this.id = String(id || 'tr')
    this.name = String(name || 'Transmission')
    this.type = 'transmission'
    this.rawUrl = String(url || '').trim().replace(/\/+$/, '')
    let u = this.rawUrl
    if (u && !/\/transmission\/rpc/i.test(u)) {
      u = u + '/transmission/rpc'
    }
    this.url = u
    this.username = String(username || '')
    this.password = String(password || '')
    this.timeout = Number(timeout) || 30
    this.directProxy = directProxy !== false
    this.defaultTags = Array.isArray(tags) ? tags : ['辅种']
    this.defaultPaused = paused === true
    this.session = 'reseed-tr-' + this.id.replace(/[^a-z0-9_-]/gi, '')
    this.sessionId = ''
  }

  get configured() {
    return /^https?:\/\//i.test(this.rawUrl)
  }

  authHeader(ctx) {
    if (!this.username && !this.password) return {}
    return { Authorization: 'Basic ' + base64Utf8(ctx, this.username + ':' + this.password) }
  }

  async rpc(ctx, payload) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = {
        'Content-Type': 'application/json',
        ...this.authHeader(ctx)
      }
      if (this.sessionId) headers['X-Transmission-Session-Id'] = this.sessionId

      const opts = {
        url: this.url,
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        session: this.session,
        timeout_seconds: this.timeout
      }
      if (this.directProxy && isPrivateOrLocal(this.url)) {
        opts.proxy = 'direct'
      }

      const res = await ctx.http.request(opts)

      if (res.status === 409) {
        const sid = getHeaderCaseInsensitive(res.headers, 'x-transmission-session-id')
        const sid2 = Array.isArray(sid) ? sid[0] : sid
        if (sid2) {
          this.sessionId = String(sid2)
          continue
        }
        throw new Error(this.name + ' 返回 409 但未提供 Session ID')
      }

      if (res.status === 401) throw new Error(this.name + ' 认证失败（401），请检查用户名密码')
      if (res.status >= 400) {
        throw new Error(this.name + ' RPC 失败（HTTP ' + res.status + '）：' + String(res.body || '').slice(0, 120))
      }

      const parsed = typeof res.body === 'string' && res.body.trim()
        ? JSON.parse(res.body)
        : (res.data ?? res.body ?? {})
      if (parsed && parsed.result && parsed.result !== 'success') {
        throw new Error(this.name + ' 返回失败：' + parsed.result)
      }
      return parsed
    }
    throw new Error(this.name + ' 会话建立失败')
  }

  async version(ctx) {
    const r = await this.rpc(ctx, { method: 'session-get', arguments: { fields: ['version'] } })
    return String(r?.arguments?.version || '')
  }

  async torrents(ctx) {
    const r = await this.rpc(ctx, {
      method: 'torrent-get',
      arguments: {
        fields: ['hashString', 'name', 'downloadDir', 'percentDone', 'status', 'totalSize', 'trackers', 'labels']
      }
    })
    const list = r?.arguments?.torrents || []
    return list.map((t) => {
      const trackers = Array.isArray(t.trackers)
        ? t.trackers.map((tr) => String(tr?.announce || '')).filter(Boolean)
        : []
      return {
        hash: String(t.hashString || '').toLowerCase(),
        name: String(t.name || ''),
        savePath: String(t.downloadDir || ''),
        contentPath: '',
        state: TR_STATE_MAP[t.status] || String(t.status ?? ''),
        progress: Number(t.percentDone ?? 0),
        size: Number(t.totalSize ?? 0),
        tracker: trackers[0] || '',
        trackers,
        tags: Array.isArray(t.labels) ? t.labels.map(String) : [],
        category: '',
        downloaderId: this.id,
        downloaderName: this.name,
        downloaderType: this.type
      }
    })
  }

  async findTorrent(ctx, infoHash) {
    const h = String(infoHash || '').toLowerCase()
    if (!h) return null
    const r = await this.rpc(ctx, {
      method: 'torrent-get',
      arguments: {
        fields: ['hashString', 'name', 'downloadDir', 'percentDone', 'status', 'trackers'],
        ids: [h]
      }
    })
    const list = r?.arguments?.torrents || []
    if (!list.length) return null
    const t = list[0]
    return {
      hash: String(t.hashString || h).toLowerCase(),
      name: String(t.name || ''),
      savePath: String(t.downloadDir || ''),
      state: TR_STATE_MAP[t.status] || String(t.status ?? ''),
      progress: Number(t.percentDone ?? 0)
    }
  }

  async addTorrent(ctx, { contentBase64, savePath, paused, tags }) {
    const isPaused = paused !== undefined ? !!paused : this.defaultPaused
    const tagList = Array.isArray(tags) ? tags : this.defaultTags
    const args = {
      metainfo: contentBase64,
      paused: isPaused
    }
    if (savePath) args['download-dir'] = savePath
    if (tagList.length) args.labels = tagList

    const r = await this.rpc(ctx, { method: 'torrent-add', arguments: args })
    const added = r?.arguments?.['torrent-added']
    const dup = r?.arguments?.['torrent-duplicate']
    if (dup) return { alreadyExists: true, hash: dup.hashString }
    if (added) return { added: true, hash: added.hashString }
    return { added: true }
  }

  async probe(ctx) {
    const [ver, list] = await Promise.all([
      this.version(ctx).catch(() => ''),
      this.torrents(ctx)
    ])
    return { ok: true, version: ver, torrents: list.length }
  }
}
