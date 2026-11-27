// 下载器统一入口：支持自定义添加多个 qBittorrent / Transmission 实例，
// 兼容旧版 settings 扁平配置（qbEnabled/trEnabled），并提供路径映射与批量索引能力。

import { Qbittorrent } from './qbittorrent.js'
import { Transmission } from './transmission.js'

function cleanPrefix(p) {
  const s = String(p || '').trim()
  if (!s) return ''
  return s === '/' ? '/' : s.replace(/\/+$/, '')
}

export function normalizePathMaps(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const from = cleanPrefix(row.from)
    const to = cleanPrefix(row.to)
    if (from && to) out.push({ from, to })
  }
  // 较长前缀优先匹配
  out.sort((a, b) => b.from.length - a.from.length)
  return out
}

// 把下载器视角路径映射为 DIAN115 宿主可读路径（未命中映射时返回 '' 表示宿主不可直接 stat）
export function mapToHostPath(downloaderPath, pathMaps) {
  const p = cleanPrefix(downloaderPath)
  if (!p) return ''
  const maps = normalizePathMaps(pathMaps)
  for (const m of maps) {
    if (p === m.from) return m.to
    if (m.from === '/') return m.to + p
    if (p.startsWith(m.from + '/')) return m.to + p.slice(m.from.length)
  }
  return ''
}

export function normalizeDownloaderConfig(raw, idx = 0) {
  const type = String(raw.type || '').toLowerCase() === 'transmission' ? 'transmission' : 'qbittorrent'
  const url = String(raw.url || '').trim().replace(/\/+$/, '')
  const id = String(raw.id || '').trim() || (type === 'transmission' ? 'tr-' : 'qb-') + (idx + 1)
  const name = String(raw.name || '').trim() || (type === 'transmission' ? 'Transmission' : 'qBittorrent')
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((s) => String(s || '').trim()).filter(Boolean)
    : String(raw.tags ?? '辅种').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
  const torrentDirs = Array.isArray(raw.torrentDirs)
    ? raw.torrentDirs.map((s) => String(s || '').trim()).filter(Boolean)
    : String(raw.torrentDirs || '').split('\n').map((s) => s.trim()).filter(Boolean)

  return {
    id,
    name,
    type,
    url,
    username: String(raw.username || ''),
    password: String(raw.password || ''),
    enabled: raw.enabled !== false,
    paused: raw.paused === true,
    skipChecking: raw.skipChecking !== false,
    tags,
    torrentDirs,
    pathMaps: normalizePathMaps(raw.pathMaps)
  }
}

// 从 storage.downloaders 读取，若尚未初始化则自动兼容旧版 settings 里的 qb*/tr* 字段
export function resolveDownloaderConfigs(stored, legacySettings = {}) {
  if (Array.isArray(stored) && stored.length) {
    return stored.map((item, idx) => normalizeDownloaderConfig(item, idx))
  }
  const migrated = []
  if (legacySettings.qbUrl || legacySettings.qbEnabled) {
    migrated.push(normalizeDownloaderConfig({
      id: 'qb-main',
      name: 'qBittorrent',
      type: 'qbittorrent',
      url: legacySettings.qbUrl || '',
      username: legacySettings.qbUsername || '',
      password: legacySettings.qbPassword || '',
      enabled: !!legacySettings.qbEnabled
    }, 0))
  }
  if (legacySettings.trUrl || legacySettings.trEnabled) {
    migrated.push(normalizeDownloaderConfig({
      id: 'tr-main',
      name: 'Transmission',
      type: 'transmission',
      url: legacySettings.trUrl || '',
      username: legacySettings.trUsername || '',
      password: legacySettings.trPassword || '',
      enabled: !!legacySettings.trEnabled
    }, 1))
  }
  return migrated
}

export function createDownloader(config) {
  const cfg = normalizeDownloaderConfig(config)
  const client = cfg.type === 'transmission'
    ? new Transmission(cfg)
    : new Qbittorrent(cfg)
  client.config = cfg
  return client
}

export function buildDownloaders(configsOrSettings, legacySettings = null) {
  const configs = Array.isArray(configsOrSettings)
    ? configsOrSettings.map((c, i) => normalizeDownloaderConfig(c, i))
    : resolveDownloaderConfigs(null, configsOrSettings || legacySettings || {})
  return configs
    .filter((c) => c.enabled && /^https?:\/\//i.test(c.url))
    .map((c) => createDownloader(c))
}

// 批量拉取所有启用下载器的种子清单，建立 infoHash -> 记录数组 映射
export async function fetchAllDownloaderTorrents(ctx, downloaders) {
  const byHash = new Map() // infoHash -> Array<normalizedTorrent & { downloader }>
  const statuses = []

  for (const dl of downloaders) {
    const st = {
      id: dl.id,
      name: dl.name,
      type: dl.type,
      url: dl.url,
      ok: false,
      version: '',
      torrentCount: 0,
      error: ''
    }
    try {
      if (dl.type === 'qbittorrent') await dl.login(ctx)
      const [ver, list] = await Promise.all([
        dl.version(ctx).catch(() => ''),
        dl.torrents(ctx)
      ])
      st.ok = true
      st.version = ver
      st.torrentCount = list.length
      for (const item of list) {
        if (!item.hash) continue
        const rec = {
          ...item,
          hostPath: mapToHostPath(item.savePath, dl.config?.pathMaps || []),
          downloader: dl
        }
        let arr = byHash.get(item.hash)
        if (!arr) {
          arr = []
          byHash.set(item.hash, arr)
        }
        arr.push(rec)
      }
    } catch (err) {
      st.error = err?.message || String(err)
    }
    statuses.push(st)
  }

  return { byHash, statuses }
}

// 兼容旧导出：按 info_hash 查单个下载器
export async function locateTorrent(ctx, downloaders, infoHash) {
  for (const d of downloaders) {
    try {
      if (d.type === 'qbittorrent' && !d.loggedIn) await d.login(ctx)
      const found = await d.findTorrent(ctx, infoHash)
      if (found) return { downloader: d, ...found }
    } catch {
      /* 尝试下一个下载器 */
    }
  }
  return null
}

export async function probeDownloaders(ctx, downloaders) {
  const out = []
  for (const d of downloaders) {
    try {
      const r = await d.probe(ctx)
      out.push({ id: d.id, name: d.name, type: d.type, ok: true, version: r.version, torrents: r.torrents, error: '' })
    } catch (err) {
      out.push({ id: d.id, name: d.name, type: d.type, ok: false, version: '', torrents: 0, error: err?.message || String(err) })
    }
  }
  return out
}
