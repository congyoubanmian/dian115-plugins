// 辅种主流程（v0.6.0）：
//   阶段 1：连接所有已启用的 BT 下载器（qBittorrent / Transmission），一次性拉取全量种子建立 info_hash 索引
//   阶段 2：扫描 .torrent 目录，纯 Uint8Array 解析元数据，按 pieces 指纹聚合（保留多站/多下载器关联）并校验数据完整性
//   阶段 3：逐站按方言批量查询 pieces-hash（带重试与限速），精准区分同站已做种 / 跨站可辅种 / 已缓存
//   阶段 4：演练模式只输出完整矩阵写入 reseed:state；实盘模式或定向 apply 模式校验合法 .torrent 后推送到对应 BT 下载器

import { parseTorrentMeta, isValidTorrentBytes, readTorrentPieces } from '../lib/bencode.js'
import {
  BUILTIN_SITES,
  normalizeSite,
  lookupRequest,
  downloadUrl,
  downloadHeaders,
  parseLookupHttpResponse,
  isSameSite,
  identifyTrackerSite
} from '../lib/sites.js'
import {
  resolveDownloaderConfigs,
  buildDownloaders,
  createDownloader,
  fetchAllDownloaderTorrents
} from '../lib/downloaders/index.js'

const CACHE_KEY = 'reseed:done'
const STATE_KEY = 'reseed:state'
const CACHE_LIMIT = 50000
const MAX_STATE_ITEMS = 1500
const MAX_DIRS_PER_TORRENT = 200

function toBytes(value) {
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (Array.isArray(value)) return new Uint8Array(value)
  const s = String(value ?? '')
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

function toHex(buf) {
  const bytes = toBytes(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0')
  }
  return s
}

function decodeBase64(ctx, b64) {
  if (ctx?.codec && typeof ctx.codec.base64Decode === 'function') {
    return toBytes(ctx.codec.base64Decode(b64))
  }
  throw new Error('运行时缺少 ctx.codec.base64Decode 能力')
}

function sha1Hex(ctx, bytes) {
  return toHex(ctx.crypto.sha1(bytes)).toLowerCase()
}

function itemsOf(res) {
  if (Array.isArray(res)) return res
  if (Array.isArray(res?.items)) return res.items
  if (Array.isArray(res?.result)) return res.result
  if (Array.isArray(res?.result?.items)) return res.result.items
  if (Array.isArray(res?.entries)) return res.entries
  if (Array.isArray(res?.files)) return res.files
  if (Array.isArray(res?.data)) return res.data
  if (Array.isArray(res?.data?.items)) return res.data.items
  return []
}

function splitLines(raw) {
  return String(raw || '').split('\n').map((s) => s.trim()).filter(Boolean)
}

function parseTrackerHostsFromUrls(urls) {
  const set = new Set()
  for (const u of urls || []) {
    try {
      const h = new URL(String(u)).hostname.toLowerCase()
      if (h) set.add(h)
    } catch { /* ignore */ }
  }
  return [...set]
}

async function sleepSafe(ctx, ms) {
  if (!ms || ms <= 0) return
  if (typeof ctx.sleep === 'function') {
    await ctx.sleep(ms)
  } else {
    await new Promise((r) => setTimeout(r, ms))
  }
}

async function listTorrents(ctx, dirs, addLog) {
  const seen = new Set()
  const found = []
  for (const dir of dirs) {
    const cleanDir = dir.replace(/\/+$/, '') || '/'
    try {
      const res = await ctx.files.call({ operation: 'list', path: cleanDir, limit: 100000 })
      let count = 0
      for (const item of itemsOf(res)) {
        if (item.is_dir) continue
        const name = item.name || item.path || ''
        if (!/\.torrent$/i.test(name)) continue
        const full = item.path || (cleanDir === '/' ? '/' + name : cleanDir + '/' + name)
        if (!seen.has(full)) {
          seen.add(full)
          found.push(full)
          count++
        }
      }
      await addLog('info', '目录 ' + cleanDir + ' 发现 ' + count + ' 个 .torrent')
    } catch (err) {
      await addLog('warning', '种子目录不可读，跳过：' + cleanDir + '（' + (err?.message || err) + '）')
    }
  }
  return found
}

async function readTorrentFile(ctx, path) {
  const res = await ctx.files.call({ operation: 'read', path, encoding: 'base64', length: 16 * 1024 * 1024 })
  const b64 = typeof res === 'string'
    ? res
    : (res?.content ?? res?.data ?? res?.result?.content ?? res?.result ?? '')
  if (!b64) return null
  const buf = typeof b64 === 'string' ? decodeBase64(ctx, b64) : toBytes(b64)
  const meta = parseTorrentMeta(buf)
  if (!meta) return null
  const fingerprint = sha1Hex(ctx, meta.pieces)
  const infoHash = sha1Hex(ctx, buf.subarray(meta.infoRange[0], meta.infoRange[1]))
  return {
    path,
    fingerprint,
    infoHash,
    name: meta.name,
    files: meta.files,
    totalSize: meta.totalSize,
    isMultiFile: meta.isMultiFile,
    announceHosts: meta.announceHosts
  }
}

// 按目录列举校验数据完整性（按相对路径精确比对字节大小，避免同名文件误判）
async function verifyDirIntegrity(ctx, rootDir, files, listCache) {
  const root = String(rootDir || '').replace(/\/+$/, '')
  if (!root || !files.length) {
    return { verdict: 'missing', present: 0, matched: 0, total: files.length }
  }

  const dirs = new Set()
  for (const f of files) {
    const p = String(f.path || '')
    const idx = p.lastIndexOf('/')
    dirs.add(idx > 0 ? p.slice(0, idx) : '')
  }
  if (dirs.size > MAX_DIRS_PER_TORRENT) {
    return { verdict: 'partial', present: 0, matched: 0, total: files.length, detail: '目录数超限(' + dirs.size + ')' }
  }

  const listing = new Map()
  for (const relDir of dirs) {
    const abs = relDir ? root + '/' + relDir : root
    if (!listCache.has(abs)) {
      try {
        const res = await ctx.files.call({ operation: 'list', path: abs, limit: 100000 })
        const map = new Map()
        for (const it of itemsOf(res)) {
          if (it.is_dir) continue
          const base = String(it.name || '').split('/').pop()
          if (base) map.set(base, typeof it.size === 'number' ? it.size : -1)
        }
        listCache.set(abs, map)
      } catch {
        listCache.set(abs, null)
      }
    }
    listing.set(relDir, listCache.get(abs))
  }

  let present = 0
  let matched = 0
  for (const f of files) {
    const p = String(f.path || '')
    const idx = p.lastIndexOf('/')
    const relDir = idx > 0 ? p.slice(0, idx) : ''
    const name = idx > 0 ? p.slice(idx + 1) : p
    const map = listing.get(relDir)
    if (!map || !map.has(name)) continue
    present++
    if (map.get(name) === f.length) matched++
  }

  const total = files.length
  if (present === 0) return { verdict: 'missing', present, matched, total, detail: '文件未找到' }
  if (matched === total) return { verdict: 'complete', present, matched, total, detail: '本地 ' + matched + '/' + total + ' 文件精确校验通过' }
  if (present === total && matched < total) {
    return { verdict: 'size_mismatch', present, matched, total, detail: '大小不符（匹配 ' + matched + '/' + total + '）' }
  }
  return { verdict: 'partial', present, matched, total, detail: '部分缺失（存在 ' + present + '/' + total + '，大小一致 ' + matched + '）' }
}

// 解析单条资源的完整性状态：
//   1. 优先对已配置路径映射的 hostPath 做真实文件系统校验
//   2. 若无映射但已关联在线下载器，回退依据下载器进度（>= 99.99% 判为 downloader_complete）
//   3. 未关联下载器的孤立种子标为 unlinked
async function evaluateResourceIntegrity(ctx, group, skipIncomplete, listCache) {
  if (!skipIncomplete) {
    return { integrity: 'unchecked', detail: '已关闭完整性校验', eligible: group.clients.length > 0 }
  }

  const hostRoots = []
  const seenRoots = new Set()
  for (const c of group.clients) {
    if (c.hostPath && !seenRoots.has(c.hostPath)) {
      seenRoots.add(c.hostPath)
      hostRoots.push(c.hostPath)
    }
  }

  // 有宿主可读映射路径时，做真实磁盘逐文件大小校验
  if (hostRoots.length) {
    let best = null
    for (const root of hostRoots) {
      const r = await verifyDirIntegrity(ctx, root, group.files, listCache)
      if (r.verdict === 'complete') {
        return { integrity: 'complete', detail: r.detail + '（' + root + '）', eligible: true }
      }
      if (!best || r.matched > best.matched || r.present > best.present) best = { ...r, root }
    }
    return {
      integrity: best.verdict,
      detail: best.detail + '（' + best.root + '）',
      eligible: false
    }
  }

  // 无宿主映射路径（例如远程 NAS 下载器），按下载器汇报进度判定
  if (group.clients.length) {
    const completeClient = group.clients.find((c) => Number(c.progress) >= 0.9999)
    if (completeClient) {
      return {
        integrity: 'downloader_complete',
        detail: completeClient.downloaderName + ' 进度 100%（未配本地路径映射）',
        eligible: true
      }
    }
    const maxPct = Math.round(Math.max(...group.clients.map((c) => Number(c.progress) || 0)) * 100)
    return {
      integrity: 'partial',
      detail: '下载器进度仅 ' + maxPct + '%',
      eligible: false
    }
  }

  return {
    integrity: 'unlinked',
    detail: '未在已启用下载器中找到对应种子',
    eligible: false
  }
}

// 带指数退避重试的站点批次查询
async function querySiteBatchWithRetry(ctx, site, batch) {
  const { headers, body } = lookupRequest(site, batch)
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await ctx.http.request({
        url: site.apiUrl,
        method: 'POST',
        headers,
        body,
        timeout_seconds: 25
      })
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        lastErr = new Error('HTTP ' + res.status)
        await sleepSafe(ctx, 1500 * (attempt + 1))
        continue
      }
      return parseLookupHttpResponse(site, res)
    } catch (err) {
      lastErr = err
      // 明确是 JSON 格式/站点业务拒绝错误时不再重试
      const msg = String(err?.message || err)
      if (/站点拒绝|接口返回了网页|不是有效 JSON|Flux 接口错误/.test(msg)) throw err
      if (attempt < 2) await sleepSafe(ctx, 1500 * (attempt + 1))
    }
  }
  throw lastErr || new Error('站点请求失败')
}

// 下载目标站 .torrent 并验证 bencode 与 pieces 指纹一致性
async function fetchAndVerifyTargetTorrent(ctx, site, torrentId, expectedFingerprint) {
  const url = downloadUrl(site, torrentId)
  const headers = downloadHeaders(site)
  const dl = await ctx.http.request({
    url,
    method: 'GET',
    headers,
    response_type: 'base64',
    timeout_seconds: 30,
    follow_redirects: true
  })
  if (dl.status >= 400) {
    throw new Error('下载种子失败（HTTP ' + dl.status + '）')
  }
  const b64 = dl.body_base64 || ''
  if (!b64) throw new Error('下载种子返回空内容')
  const bytes = decodeBase64(ctx, b64)
  if (!isValidTorrentBytes(bytes)) {
    throw new Error('下载内容不是合法 .torrent（可能返回了登录页或 Cloudflare 盾页）')
  }
  if (expectedFingerprint) {
    const p = readTorrentPieces(bytes)
    if (p && p.pieces.length) {
      const gotFp = sha1Hex(ctx, p.pieces)
      if (gotFp !== expectedFingerprint.toLowerCase()) {
        throw new Error('下载种子 pieces 指纹不匹配，已拦截以防做空种')
      }
    }
  }
  return b64
}

async function loadRuntimeConfig(ctx) {
  const settings = (await ctx.settings.get()) || {}
  const storedSites = await ctx.storage.get('sites')
  const rawSites = Array.isArray(storedSites) && storedSites.length
    ? storedSites
    : BUILTIN_SITES.map((s) => ({ ...s, passkey: '', enabled: false }))
  const allSites = rawSites.map((s, idx) => normalizeSite(s, idx))
  const enabledSites = allSites.filter((s) => s.enabled && s.passkey && /^https?:\/\//i.test(s.siteUrl))

  const storedDownloaders = await ctx.storage.get('downloaders')
  const dlConfigs = resolveDownloaderConfigs(storedDownloaders, settings)
  const downloaders = buildDownloaders(dlConfigs)

  // 汇总全局种子目录 + 各下载器专属种子目录
  const dirSet = new Set(splitLines(settings.torrentDirs))
  for (const c of dlConfigs) {
    if (!c.enabled) continue
    for (const d of c.torrentDirs || []) dirSet.add(d)
  }

  return {
    settings,
    allSites,
    enabledSites,
    dlConfigs,
    downloaders,
    torrentDirs: [...dirSet],
    dryRun: settings.dryRun !== false,
    autoEnabled: settings.autoEnabled === true,
    autoMode: settings.autoMode === 'reseed' ? 'reseed' : 'scan',
    skipIncomplete: settings.skipIncomplete !== false,
    batchSize: Math.max(1, Math.min(500, Number(settings.batchSize) || 100)),
    rateLimitMs: Math.max(0, Math.min(10000, Number(settings.rateLimitMs) || 300)),
    defaultTags: String(settings.defaultTags || '辅种').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
    defaultPaused: settings.defaultPaused !== false,
    defaultSkipChecking: settings.defaultSkipChecking !== false
  }
}

function summarizeItems(items, totalTorrents) {
  const summary = {
    totalTorrents,
    uniqueResources: items.length,
    completeCount: 0,
    incompleteCount: 0,
    downloaderLinked: 0,
    unlinkedCount: 0,
    totalHits: 0,
    crossSeedAvailable: 0,
    sameSiteSeeding: 0,
    addedCount: 0,
    alreadyExistedCount: 0,
    cachedCount: 0,
    failedCount: 0
  }
  for (const it of items) {
    if (it.integrity === 'complete' || it.integrity === 'downloader_complete' || it.integrity === 'unchecked') {
      summary.completeCount++
    } else if (it.integrity === 'unlinked') {
      summary.unlinkedCount++
    } else {
      summary.incompleteCount++
    }
    if (it.clients && it.clients.length) summary.downloaderLinked++
    for (const m of it.matches || []) {
      summary.totalHits++
      if (m.status === 'candidate') summary.crossSeedAvailable++
      else if (m.status === 'seeding') summary.sameSiteSeeding++
      else if (m.status === 'added') summary.addedCount++
      else if (m.status === 'already_existed') summary.alreadyExistedCount++
      else if (m.status === 'cached') summary.cachedCount++
      else if (m.status === 'failed') summary.failedCount++
    }
  }
  return summary
}

function sortItemsForDisplay(items) {
  const rank = (it) => {
    const ms = it.matches || []
    if (ms.some((m) => m.status === 'candidate')) return 0
    if (ms.some((m) => m.status === 'failed')) return 1
    if (ms.some((m) => m.status === 'added')) return 2
    if (ms.some((m) => m.status === 'already_existed' || m.status === 'cached')) return 3
    if (ms.some((m) => m.status === 'seeding')) return 4
    if (it.clients && it.clients.length) return 5
    return 6
  }
  return items.sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    return (b.matches?.length || 0) - (a.matches?.length || 0) || String(a.name).localeCompare(String(b.name))
  })
}

export async function run(ctx, input = {}) {
  const startedAt = Date.now()
  const cfg = await loadRuntimeConfig(ctx)
  const isManual = input?.mode === 'scan' || input?.mode === 'reseed'
  // 定时触发（未显式传 mode）受 autoEnabled 开关控制；手动点击「扫描预览 / 一键辅种」随时可执行
  if (!isManual && !cfg.autoEnabled) {
    const msg = '定时自动扫描/辅种未开启，已跳过本次计划任务（可在插件「策略设置」中开启）'
    try { await ctx.task.log('[INFO] ' + msg) } catch { /* ignore */ }
    await ctx.task.update({ stage: '跳过', progress: 100, message: msg })
    return { skipped: true, reason: 'auto_disabled' }
  }
  const mode = isManual
    ? input.mode
    : (cfg.autoMode === 'reseed' && !cfg.dryRun ? 'reseed' : (cfg.autoMode === 'reseed' ? 'reseed' : 'scan'))
  const dryRun = mode === 'scan'

  if (!cfg.torrentDirs.length) {
    throw new Error('未配置种子目录，请先在「BT 下载器 & 目录」中填写至少一个 .torrent 目录')
  }
  if (!cfg.enabledSites.length) {
    throw new Error('没有启用的站点，请先在「站点管理」中启用站点并填写 Passkey / Token')
  }
  if (!dryRun && !cfg.downloaders.length) {
    throw new Error('实盘辅种需要至少启用一个 BT 下载器（qBittorrent 或 Transmission）')
  }

  const logs = []
  const addLog = async (level, message) => {
    logs.push({ time: new Date().toISOString(), level, message: String(message) })
    if (logs.length > 200) logs.shift()
    try { await ctx.task.log('[' + level.toUpperCase() + '] ' + message) } catch { /* ignore */ }
  }

  // ── 阶段 1：连接下载器并一次性拉取种子索引 ──
  await ctx.task.update({ stage: '连接下载器', progress: 5, message: '正在同步 BT 下载器种子列表…' })
  const { byHash: dlByHash, statuses: downloaderStatuses } = await fetchAllDownloaderTorrents(ctx, cfg.downloaders)
  for (const st of downloaderStatuses) {
    if (st.ok) {
      await addLog('info', '下载器 ' + st.name + '（' + st.type + (st.version ? ' ' + st.version : '') + '）连接成功，在线种子 ' + st.torrentCount + ' 个')
    } else {
      await addLog('error', '下载器 ' + st.name + ' 连接失败：' + st.error)
    }
  }
  if (!dryRun && !downloaderStatuses.some((s) => s.ok)) {
    throw new Error('所有已启用的下载器均连接失败，已中止实盘辅种')
  }

  // ── 阶段 2：扫描 .torrent 并按 pieces 指纹聚合 ──
  await ctx.task.update({ stage: '扫描种子库', progress: 15, message: '正在读取种子目录…' })
  const torrentFiles = await listTorrents(ctx, cfg.torrentDirs, addLog)
  if (!torrentFiles.length) {
    await addLog('warning', '所配置的种子目录中未发现任何 .torrent 文件')
  }

  const doneCache = new Set((await ctx.storage.get(CACHE_KEY)) || [])
  const groups = new Map() // fingerprint -> resourceGroup
  let parseFailed = 0

  for (let i = 0; i < torrentFiles.length; i++) {
    const filePath = torrentFiles[i]
    if ((i + 1) % 50 === 0 || i + 1 === torrentFiles.length) {
      const pct = 15 + Math.round(((i + 1) / Math.max(1, torrentFiles.length)) * 30)
      await ctx.task.update({
        stage: '解析与聚合种子',
        progress: pct,
        message: '已解析 ' + (i + 1) + '/' + torrentFiles.length + '，聚合资源 ' + groups.size + ' 份',
        total: torrentFiles.length,
        done: i + 1
      })
    }

    let tInfo
    try {
      tInfo = await readTorrentFile(ctx, filePath)
    } catch (err) {
      parseFailed++
      if (parseFailed <= 10) await addLog('warning', '解析失败：' + filePath + '（' + (err?.message || err) + '）')
      continue
    }
    if (!tInfo) {
      parseFailed++
      continue
    }

    let group = groups.get(tInfo.fingerprint)
    if (!group) {
      group = {
        fingerprint: tInfo.fingerprint,
        name: tInfo.name || filePath.split('/').pop(),
        totalSize: tInfo.totalSize,
        fileCount: tInfo.files.length,
        files: tInfo.files,
        announceHostsSet: new Set(),
        sourceSitesSet: new Set(),
        clientsMap: new Map(), // downloaderId -> clientSummary
        infoHashes: new Set(),
        matches: []
      }
      groups.set(tInfo.fingerprint, group)
    }

    group.infoHashes.add(tInfo.infoHash)
    for (const h of tInfo.announceHosts) group.announceHostsSet.add(h)
    const guessedSite = identifyTrackerSite(tInfo.announceHosts, cfg.allSites)
    if (guessedSite) group.sourceSitesSet.add(guessedSite)

    // 关联在线 BT 下载器记录
    const dlRecords = dlByHash.get(tInfo.infoHash) || []
    for (const rec of dlRecords) {
      const trHosts = parseTrackerHostsFromUrls(rec.trackers)
      for (const h of trHosts) group.announceHostsSet.add(h)
      const dlSite = identifyTrackerSite(trHosts.length ? trHosts : tInfo.announceHosts, cfg.allSites)
      if (dlSite) group.sourceSitesSet.add(dlSite)

      let cli = group.clientsMap.get(rec.downloaderId)
      if (!cli) {
        cli = {
          downloaderId: rec.downloaderId,
          downloaderName: rec.downloaderName,
          downloaderType: rec.downloaderType,
          savePath: rec.savePath,
          hostPath: rec.hostPath || '',
          progress: rec.progress,
          state: rec.state,
          infoHashes: [],
          sourceSites: []
        }
        group.clientsMap.set(rec.downloaderId, cli)
      } else {
        if (rec.progress > cli.progress) {
          cli.progress = rec.progress
          cli.state = rec.state
        }
        if (!cli.savePath && rec.savePath) cli.savePath = rec.savePath
        if (!cli.hostPath && rec.hostPath) cli.hostPath = rec.hostPath
      }
      if (!cli.infoHashes.includes(tInfo.infoHash)) cli.infoHashes.push(tInfo.infoHash)
      if (dlSite && !cli.sourceSites.includes(dlSite)) cli.sourceSites.push(dlSite)
    }
  }

  await addLog('info', '扫描完成：' + torrentFiles.length + ' 个种子聚合为 ' + groups.size + ' 份唯一资源' + (parseFailed ? '（解析失败 ' + parseFailed + '）' : ''))

  // ── 阶段 2.5：数据完整性校验 ──
  const listCache = new Map()
  const eligibleFps = []
  let idxCheck = 0
  for (const group of groups.values()) {
    idxCheck++
    group.clients = [...group.clientsMap.values()]
    group.announceHosts = [...group.announceHostsSet]
    group.sourceSites = [...group.sourceSitesSet]
    const ev = await evaluateResourceIntegrity(ctx, group, cfg.skipIncomplete, listCache)
    group.integrity = ev.integrity
    group.integrityDetail = ev.detail
    group.eligible = ev.eligible
    if (ev.eligible) eligibleFps.push(group.fingerprint)
    if (idxCheck % 100 === 0 || idxCheck === groups.size) {
      const pct = 45 + Math.round((idxCheck / Math.max(1, groups.size)) * 15)
      await ctx.task.update({
        stage: '校验数据完整性',
        progress: pct,
        message: '已核验 ' + idxCheck + '/' + groups.size + '，符合辅种条件 ' + eligibleFps.length + ' 份'
      })
    }
  }
  await addLog('info', '完整性核验完成：符合辅种条件 ' + eligibleFps.length + ' / ' + groups.size + ' 份')

  // ── 阶段 3 & 4：逐站查询并（按模式）提交辅种 ──
  const dlMap = new Map(cfg.downloaders.map((d) => [d.id, d]))
  const siteStats = []

  // 若演练模式下没有连下载器，但想探测站点能命中多少：当 skipIncomplete 关掉或允许查全部指纹时也能查
  const queryFps = eligibleFps.length
    ? eligibleFps
    : (dryRun && !cfg.downloaders.length ? [...groups.keys()] : [])

  if (dryRun && !cfg.downloaders.length && groups.size) {
    await addLog('warning', '当前未启用任何 BT 下载器，演练模式将对全部 ' + queryFps.length + ' 份种子指纹查询站点命中情况（实盘辅种前请先配置下载器）')
  }

  for (let si = 0; si < cfg.enabledSites.length; si++) {
    const site = cfg.enabledSites[si]
    const siteT0 = Date.now()
    const st = {
      id: site.id,
      name: site.name,
      dialect: site.dialect,
      apiUrl: site.apiUrl,
      ok: true,
      queried: queryFps.length,
      totalHits: 0,
      crossHits: 0,
      sameHits: 0,
      added: 0,
      failed: 0,
      error: '',
      elapsedMs: 0
    }

    await ctx.task.update({
      stage: '查询站点 (' + (si + 1) + '/' + cfg.enabledSites.length + ')',
      progress: 60 + Math.round((si / Math.max(1, cfg.enabledSites.length)) * 35),
      message: '正在查询 ' + site.name + '（' + queryFps.length + ' 个指纹）…'
    })

    for (let offset = 0; offset < queryFps.length; offset += cfg.batchSize) {
      const batch = queryFps.slice(offset, offset + cfg.batchSize)
      let hits = []
      try {
        hits = await querySiteBatchWithRetry(ctx, site, batch)
      } catch (err) {
        st.ok = false
        st.error = err?.message || String(err)
        await addLog('error', '站点 ' + site.name + ' 查询失败：' + st.error)
        break
      }

      for (const { piecesHash, torrentId } of hits) {
        const group = groups.get(piecesHash)
        if (!group) continue
        st.totalHits++

        // 判断该资源是否已在本站点做种
        if (isSameSite(site, group.announceHosts)) {
          st.sameHits++
          group.matches.push({
            siteId: site.id,
            siteName: site.name,
            torrentId,
            dialect: site.dialect,
            status: 'seeding',
            downloaderId: group.clients[0]?.downloaderId || '',
            downloaderName: group.clients[0]?.downloaderName || '',
            downloaderType: group.clients[0]?.downloaderType || '',
            savePath: group.clients[0]?.savePath || '',
            reason: '本地已有该站种子做种',
            updatedAt: new Date().toISOString()
          })
          continue
        }

        // 选择目标下载器（优先进度 100% 且有 savePath 的下载器）
        const primaryClient = group.clients.find((c) => c.savePath && Number(c.progress) >= 0.9999)
          || group.clients.find((c) => c.savePath)
          || null
        const targetDlId = primaryClient?.downloaderId || ''
        const cacheKey = piecesHash + ':' + site.id + (targetDlId ? ':' + targetDlId : '')

        if (doneCache.has(cacheKey) || doneCache.has(piecesHash + ':' + site.name)) {
          group.matches.push({
            siteId: site.id,
            siteName: site.name,
            torrentId,
            dialect: site.dialect,
            status: 'cached',
            downloaderId: targetDlId,
            downloaderName: primaryClient?.downloaderName || '',
            downloaderType: primaryClient?.downloaderType || '',
            savePath: primaryClient?.savePath || '',
            reason: '历史已辅种（命中缓存）',
            updatedAt: new Date().toISOString()
          })
          continue
        }

        st.crossHits++
        if (dryRun) {
          group.matches.push({
            siteId: site.id,
            siteName: site.name,
            torrentId,
            dialect: site.dialect,
            status: 'candidate',
            downloaderId: targetDlId,
            downloaderName: primaryClient?.downloaderName || '',
            downloaderType: primaryClient?.downloaderType || '',
            savePath: primaryClient?.savePath || '',
            reason: primaryClient ? '可跨站辅种' : '可跨站辅种（需关联下载器后提交）',
            updatedAt: new Date().toISOString()
          })
          continue
        }

        // 实盘提交到对应下载器
        const dlClient = primaryClient ? dlMap.get(primaryClient.downloaderId) : null
        if (!dlClient || !primaryClient?.savePath) {
          st.failed++
          group.matches.push({
            siteId: site.id,
            siteName: site.name,
            torrentId,
            dialect: site.dialect,
            status: 'failed',
            downloaderId: targetDlId,
            downloaderName: primaryClient?.downloaderName || '',
            downloaderType: primaryClient?.downloaderType || '',
            savePath: primaryClient?.savePath || '',
            reason: '未找到在线下载器或保存目录',
            updatedAt: new Date().toISOString()
          })
          continue
        }

        try {
          const b64 = await fetchAndVerifyTargetTorrent(ctx, site, torrentId, piecesHash)
          const r = await dlClient.addTorrent(ctx, {
            contentBase64: b64,
            savePath: primaryClient.savePath,
            paused: dlClient.config?.paused ?? cfg.defaultPaused,
            skipChecking: dlClient.config?.skipChecking ?? cfg.defaultSkipChecking,
            tags: dlClient.config?.tags?.length ? dlClient.config.tags : cfg.defaultTags
          })
          const already = !!(r && r.alreadyExists)
          if (!already) st.added++
          doneCache.add(cacheKey)
          group.matches.push({
            siteId: site.id,
            siteName: site.name,
            torrentId,
            dialect: site.dialect,
            status: already ? 'already_existed' : 'added',
            downloaderId: dlClient.id,
            downloaderName: dlClient.name,
            downloaderType: dlClient.type,
            savePath: primaryClient.savePath,
            reason: already ? '下载器中已存在该种子' : '已推送辅种',
            updatedAt: new Date().toISOString()
          })
        } catch (err) {
          st.failed++
          group.matches.push({
            siteId: site.id,
            siteName: site.name,
            torrentId,
            dialect: site.dialect,
            status: 'failed',
            downloaderId: dlClient.id,
            downloaderName: dlClient.name,
            downloaderType: dlClient.type,
            savePath: primaryClient.savePath,
            reason: err?.message || String(err),
            updatedAt: new Date().toISOString()
          })
        }
      }

      if (offset + cfg.batchSize < queryFps.length && cfg.rateLimitMs > 0) {
        await sleepSafe(ctx, cfg.rateLimitMs)
      }
    }

    st.elapsedMs = Date.now() - siteT0
    siteStats.push(st)
    if (st.ok) {
      await addLog('info', '站点 ' + site.name + '：总命中 ' + st.totalHits + '（跨站 ' + st.crossHits + ' / 同站 ' + st.sameHits + (dryRun ? '' : ' / 新增 ' + st.added + ' / 失败 ' + st.failed) + '）')
    }
  }

  // ── 汇总与持久化状态 ──
  const allCompactItems = []
  for (const g of groups.values()) {
    allCompactItems.push({
      fingerprint: g.fingerprint,
      name: g.name,
      totalSize: g.totalSize,
      fileCount: g.fileCount,
      integrity: g.integrity,
      integrityDetail: g.integrityDetail,
      clients: g.clients,
      sourceSites: g.sourceSites,
      matches: g.matches
    })
  }
  sortItemsForDisplay(allCompactItems)
  const summary = summarizeItems(allCompactItems, torrentFiles.length)
  const durationMs = Date.now() - startedAt

  const stateDoc = {
    version: 2,
    updatedAt: new Date().toISOString(),
    mode,
    dryRun,
    durationMs,
    summary,
    downloaders: downloaderStatuses,
    siteStats,
    items: allCompactItems.slice(0, MAX_STATE_ITEMS),
    truncated: allCompactItems.length > MAX_STATE_ITEMS,
    logs: logs.slice(-120)
  }

  await ctx.storage.set(STATE_KEY, stateDoc)
  await ctx.storage.set(CACHE_KEY, [...doneCache].slice(-CACHE_LIMIT))

  const summaryText = dryRun
    ? '扫描预览完成：' + summary.uniqueResources + ' 份资源，发现可跨站辅种 ' + summary.crossSeedAvailable + ' 项，同站已做种 ' + summary.sameSiteSeeding + ' 项'
    : '辅种完成：新增 ' + summary.addedCount + ' 项，已存在 ' + summary.alreadyExistedCount + ' 项，失败 ' + summary.failedCount + ' 项'

  await addLog('info', summaryText)
  await ctx.task.update({ stage: '完成', progress: 100, message: summaryText })
  await ctx.notify({
    title: '辅种助手',
    body: summaryText,
    level: summary.failedCount > 0 ? 'warning' : 'success',
    dedupe_key: ctx.task.id
  })

  return {
    mode,
    dryRun,
    durationMs,
    summary
  }
}

// 定向辅种（前端勾选单条或批量提交选定的跨站命中）
export async function apply(ctx, input = {}) {
  const targets = Array.isArray(input?.targets) ? input.targets : []
  if (!targets.length) throw new Error('没有选择要辅种的条目')

  const cfg = await loadRuntimeConfig(ctx)
  if (!cfg.downloaders.length) {
    throw new Error('请先在「BT 下载器 & 目录」中启用至少一个下载器')
  }

  const stateDoc = await ctx.storage.get(STATE_KEY)
  if (!stateDoc || !Array.isArray(stateDoc.items)) {
    throw new Error('找不到上次扫描结果，请先执行一次「扫描预览」')
  }

  const doneCache = new Set((await ctx.storage.get(CACHE_KEY)) || [])
  const siteById = new Map(cfg.allSites.map((s) => [s.id, s]))
  const dlById = new Map(cfg.downloaders.map((d) => [d.id, d]))
  const itemByFp = new Map(stateDoc.items.map((it) => [it.fingerprint, it]))

  let added = 0
  let alreadyExisted = 0
  let failed = 0
  const logs = Array.isArray(stateDoc.logs) ? stateDoc.logs : []
  const pushLog = async (level, msg) => {
    logs.push({ time: new Date().toISOString(), level, message: msg })
    if (logs.length > 200) logs.shift()
    try { await ctx.task.log('[' + level.toUpperCase() + '] ' + msg) } catch { /* ignore */ }
  }

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    await ctx.task.update({
      stage: '推送辅种',
      progress: Math.round(((i + 1) / targets.length) * 100),
      message: '正在处理 ' + (i + 1) + '/' + targets.length,
      total: targets.length,
      done: i + 1,
      failed
    })

    const item = itemByFp.get(t.fingerprint)
    if (!item) { failed++; continue }
    const match = (item.matches || []).find((m) => m.siteId === t.siteId)
    if (!match) { failed++; continue }
    const site = siteById.get(t.siteId)
    if (!site || !site.passkey) {
      match.status = 'failed'
      match.reason = '站点未配置或缺少 Passkey'
      failed++
      continue
    }

    const dlId = t.downloaderId || match.downloaderId || item.clients?.[0]?.downloaderId
    const dlClient = dlById.get(dlId)
    const clientMeta = (item.clients || []).find((c) => c.downloaderId === dlId) || item.clients?.[0]
    const savePath = t.savePath || match.savePath || clientMeta?.savePath || ''

    if (!dlClient) {
      match.status = 'failed'
      match.reason = '目标下载器未启用或不存在'
      failed++
      continue
    }
    if (!savePath) {
      match.status = 'failed'
      match.reason = '缺少原种子保存目录（save_path）'
      failed++
      continue
    }

    try {
      const b64 = await fetchAndVerifyTargetTorrent(ctx, site, match.torrentId, item.fingerprint)
      const r = await dlClient.addTorrent(ctx, {
        contentBase64: b64,
        savePath,
        paused: dlClient.config?.paused ?? cfg.defaultPaused,
        skipChecking: dlClient.config?.skipChecking ?? cfg.defaultSkipChecking,
        tags: dlClient.config?.tags?.length ? dlClient.config.tags : cfg.defaultTags
      })
      const dup = !!(r && r.alreadyExists)
      if (dup) alreadyExisted++
      else added++

      doneCache.add(item.fingerprint + ':' + site.id + ':' + dlClient.id)
      match.status = dup ? 'already_existed' : 'added'
      match.downloaderId = dlClient.id
      match.downloaderName = dlClient.name
      match.downloaderType = dlClient.type
      match.savePath = savePath
      match.reason = dup ? '下载器中已存在该种子' : '已手动推送辅种'
      match.updatedAt = new Date().toISOString()
      await pushLog('info', (dup ? '已存在：' : '已辅种：') + item.name + ' → ' + site.name + '（' + dlClient.name + '）')
    } catch (err) {
      failed++
      match.status = 'failed'
      match.reason = err?.message || String(err)
      match.updatedAt = new Date().toISOString()
      await pushLog('error', '辅种失败：' + item.name + ' → ' + site.name + '：' + match.reason)
    }
  }

  stateDoc.updatedAt = new Date().toISOString()
  stateDoc.summary = summarizeItems(stateDoc.items, stateDoc.summary?.totalTorrents || stateDoc.items.length)
  stateDoc.logs = logs.slice(-120)

  await ctx.storage.set(STATE_KEY, stateDoc)
  await ctx.storage.set(CACHE_KEY, [...doneCache].slice(-CACHE_LIMIT))

  const msg = '定向辅种结束：新增 ' + added + '，已存在 ' + alreadyExisted + '，失败 ' + failed
  await ctx.task.update({ stage: '完成', progress: 100, message: msg })
  return { added, alreadyExisted, failed }
}

// 快速探测单个下载器或站点连通性（供前端「测试连接 / 测试接口」调用，queue:false 不占任务队列）
export async function probe(ctx, input = {}) {
  const kind = String(input?.kind || '')
  if (kind === 'downloader') {
    const raw = input?.downloader
    if (!raw || !raw.url) throw new Error('下载器地址为空')
    const client = createDownloader(raw)
    const r = await client.probe(ctx)
    return { kind: 'downloader', id: client.id, ok: true, version: r.version, torrents: r.torrents }
  }
  if (kind === 'site') {
    const raw = input?.site
    if (!raw || !raw.url) throw new Error('站点地址为空')
    const site = normalizeSite(raw, 0)
    if (!site.passkey) throw new Error('请先填写 Passkey / Token')
    const sampleFp = '0000000000000000000000000000000000000000'
    const { headers, body } = lookupRequest(site, [sampleFp])
    const res = await ctx.http.request({
      url: site.apiUrl,
      method: 'POST',
      headers,
      body,
      timeout_seconds: 15
    })
    parseLookupHttpResponse(site, res)
    return {
      kind: 'site',
      id: site.id,
      ok: true,
      status: res.status,
      dialect: site.dialect,
      apiUrl: site.apiUrl
    }
  }
  throw new Error('未知探测类型：' + kind)
}

export async function recover(ctx, checkpoint) {
  return { action: 'resume' }
}
