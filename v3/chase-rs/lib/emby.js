// Emby 侧：实例解析与已有/缺集读取 —— 对照 emby.rs。
//
// `instances` 是强类型 schema；`episodes` 的参数名与字段名都未知 —— 参数按 candidates
// 矩阵试、字段按多候选收。接受判定：能从候选路径产出「整数集集合」或「明确缺集列表」
// 之一 ⇒ ok；只有数值没有逐集信息 ⇒ unparsed（绝不凭一个 count 推断缺口并写 PATCH）。
//
// 真实宿主（2026-10-02 实测）的区间契约：`covered_episodes` 是 "1-24" 这样的区间串
// 而不是数组，`needed_episodes` 同构，空串 = 没有缺口。v3 OpenAPI
// （GetPluginHostEmbyEpisodesResponse）确认了同一契约，矩阵 V1 即官方参数，
// 但旧宿主版本差异仍按多候选防御。

import { arrayAt, descend, firstBool, firstI64, firstOf, firstString, looseI64 } from './loose.js'

/** 实例列表路径。 */
export const INSTANCES_PATH = '/api/plugin-host/emby/instances'
/** 缺集读取路径。 */
export const EPISODES_PATH = '/api/plugin-host/emby/episodes'

const LIST_KEYS = ['items', 'instances', 'data', 'list', 'result', 'rows']
const COVERAGE_KEYS = ['items', 'episodes', 'existing', 'existing_episodes', 'have', 'present', 'data', 'list', 'rows', 'episode_numbers']
const COVERAGE_DEEP_KEYS = ['items', 'episodes', 'existing', 'existing_episodes', 'list', 'episode_numbers']
const INDEX_KEYS = ['index_number', 'index', 'episode_number', 'episode', 'episode_index', 'number']
const MISSING_KEYS = ['missing', 'missing_episodes', 'absent', 'lack', 'gaps', 'missing_numbers']
// 数值兜底字段候选（仅当同时存在显式缺集列表时才认）。
const COUNT_KEYS = ['episode_count', 'existing_count', 'have_count', 'count']
// 区间式覆盖的字段候选（covered_episodes:"1-24" 实测形态）。
const RANGE_HAVE_KEYS = ['covered_episodes', 'episodes_covered', 'have_episodes']
const RANGE_MISSING_KEYS = ['needed_episodes', 'episodes_needed', 'required_episodes']
/** 单段区间与整个集合的膨胀上限（防畸形输入把内存打爆）。 */
const RANGE_SEGMENT_MAX = 2000
const RANGE_SET_MAX = 10_000

// ─────────────────────────── instances ───────────────────────────

/** 解析实例列表（强类型 PluginEmbyInstanceList，但字段名多候选）。 */
export function parseInstances(value) {
  const located = arrayAt(value, LIST_KEYS) ??
    (() => {
      const inner = descend(value, ['data'])
      return inner ? arrayAt(inner, LIST_KEYS) : null
    })()
  if (!located) throw new Error('实例列表结构未识别: 缺少 items 数组')
  const instances = []
  for (const element of located) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) continue
    const id = firstI64(element, ['id', 'proxy_id', 'instance_id', 'emby_id'])
    if (id === null || id < 0) continue
    instances.push({
      id,
      name: firstString(element, ['name', 'title', 'label']) ?? '',
      is_default: firstBool(element, ['is_default', 'default']),
      // 宿主原字段 api_key_configured 改名 key_ready：该键名命中凭据模式，
      // 落进状态文档会违反"全文档不得出现凭据键名"的硬约束。
      key_ready: firstBool(element, ['api_key_configured', 'has_key', 'configured', 'key_configured']),
    })
  }
  return instances
}

/**
 * 按配置选实例。
 * proxyId >= 1：必须找到该 id 且已配置密钥；==0：旧版单实例；==-1：优先 is_default。
 * 选不出时抛 Error（整段 Emby 跳过）。
 */
export function select(instances, proxyId) {
  if (instances.length === 0) throw new Error('宿主没有返回可用的 Emby 实例')
  if (proxyId >= 0) {
    const found = instances.find((instance) => instance.id === proxyId)
    if (!found) throw new Error(`配置的 Emby 实例 id=${proxyId} 不在可用列表中`)
    if (!found.key_ready) throw new Error(`Emby 实例 id=${found.id} 未配置密钥`)
    return selectionOf(found)
  }
  const chosen = instances.find((instance) => instance.is_default && instance.key_ready) ??
    instances.find((instance) => instance.key_ready)
  if (!chosen) throw new Error('所有 Emby 实例都没有配置密钥')
  return selectionOf(chosen)
}

function selectionOf(instance) {
  return {
    id: instance.id,
    name: instance.name,
    // id==0 是旧版单实例配置：调用时省略 proxy_id
    proxy_id: instance.id === 0 ? null : instance.id,
  }
}

/** 没有实例列表时，按用户显式配置的实例 id 直接构造选择（不猜默认实例）。 */
export function selectionFromSettings(proxyId) {
  if (proxyId === 0) return { id: 0, name: '', proxy_id: null }
  if (proxyId >= 1) return { id: proxyId, name: '', proxy_id: proxyId }
  return null
}

// ─────────────────────────── episodes ───────────────────────────

/** 解析区间串：`""`、`"5"`、`"1-24"`、`"1,3,5-7"`。非法段返回 null —— 整体视为未识别。 */
export function parseEpisodeRanges(text) {
  const set = new Set()
  const trimmed = String(text).trim()
  if (trimmed === '') return set
  for (const rawSegment of trimmed.split(',')) {
    const segment = rawSegment.trim()
    if (segment === '') continue
    let start
    let end
    if (segment.includes('-')) {
      const [left, right] = segment.split('-', 2)
      start = Number(left.trim())
      end = Number(right.trim())
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
    } else {
      start = Number(segment)
      end = start
      if (!Number.isSafeInteger(start)) return null
    }
    if (start < 0 || end < start || end - start > RANGE_SEGMENT_MAX) return null
    for (let episode = start; episode <= end; episode += 1) {
      set.add(episode)
      if (set.size > RANGE_SET_MAX) return null
    }
  }
  return set
}

/** 一个集集合的值：区间串、整数/数字串数组、或单个数字。 */
export function episodeSetOf(value) {
  if (typeof value === 'string') return parseEpisodeRanges(value)
  if (Array.isArray(value)) {
    const set = new Set()
    for (const element of value) {
      const number = looseI64(element)
      if (number === null) return null
      set.add(number)
    }
    return set
  }
  const single = looseI64(value)
  return single === null ? null : new Set([single])
}

/**
 * Emby 覆盖：已有集集合与/或明确缺集列表。
 * `have = null`：该响应里没有逐集信息；`have = 空集`：探到了但该季 0 集（已知事实）。
 */
export class Coverage {
  constructor({ have = null, missing = null, count_hint = null, shape = '' }) {
    this.have = have
    this.missing = missing
    this.count_hint = count_hint
    this.shape = shape
  }

  /** 已有集的最大集号（没有逐集信息时为 null）。 */
  haveMax() {
    if (!this.have || this.have.size === 0) return null
    let max = -Infinity
    for (const value of this.have) if (value > max) max = value
    return max
  }

  /** 已有集条数。 */
  haveCount() {
    return this.have ? this.have.size : null
  }

  /** 该季在 Emby 侧一集都没有（探到了空集）：未收录/未入库，不是"无缺口"。 */
  isAbsent() {
    return this.have !== null && this.have.size === 0
  }

  /** 覆盖未知时的可读原因（绝不返回空串：空串曾让判定层用假话顶上）。 */
  unknownNote() {
    if (this.have !== null) return '响应里的逐集覆盖是空集(该季 0 集), 没有更细的逐集明细'
    if (this.missing !== null) return '响应只有缺集列表, 没有逐集覆盖'
    return '响应里没有逐集覆盖字段'
  }

  /** 明示缺集的最大集号。 */
  missingMax() {
    if (!this.missing || this.missing.size === 0) return null
    let max = -Infinity
    for (const value of this.missing) if (value > max) max = value
    return max
  }

  /** 该季 [from, to] 是否全部已有（减方向建议的前置条件）。 */
  coversRange(from, to) {
    if (to < from) return true
    if (!this.have) return false
    for (let episode = from; episode <= to; episode += 1) {
      if (!this.have.has(episode)) return false
    }
    return true
  }

  /** 缺口上沿（缺口集号区间的最高集号；0 = 无缺口）。 */
  gapMax(totalKnown) {
    const haveMax = this.haveMax()
    if (haveMax !== null && haveMax > totalKnown) return haveMax
    if (this.missing) {
      const rest = [...this.missing].sort((a, b) => a - b)
      for (let index = rest.length - 1; index >= 0; index -= 1) {
        if (rest[index] > totalKnown) return rest[index]
      }
    }
    return 0
  }
}

function missingFrom(obj) {
  const value = firstOf(obj, MISSING_KEYS)
  if (value === null) return null
  let array
  if (Array.isArray(value)) array = value
  else if (value && typeof value === 'object') {
    const inner = firstOf(value, ['items', 'episodes', 'list'])
    if (!Array.isArray(inner)) return null
    array = inner
  } else {
    const single = looseI64(value)
    return single === null ? null : new Set([single])
  }
  const set = new Set()
  for (const element of array) {
    const number = episodeNumber(element)
    if (number !== null) set.add(number)
  }
  return set
}

/** 单个元素 → 集号（整数、数字字符串、或带序号的 object）。 */
function episodeNumber(element) {
  const direct = looseI64(element)
  if (direct !== null) return direct
  if (!element || typeof element !== 'object' || Array.isArray(element)) return null
  return firstI64(element, INDEX_KEYS)
}

/** 逐元素取集号，认不出的元素直接跳过。 */
function collectHave(items) {
  const set = new Set()
  for (const element of items) {
    const number = episodeNumber(element)
    if (number !== null) set.add(number)
  }
  return set
}

/** 定位集列表容器，返回 (元素数组, 命中的键名)；只在真的命中"集列表"字段时返回。 */
function locateContainer(value) {
  if (Array.isArray(value)) return [value, 'array']
  if (!value || typeof value !== 'object') return null
  for (const key of COVERAGE_KEYS) {
    const candidate = value[key]
    if (candidate === undefined || candidate === null) continue
    if (Array.isArray(candidate)) return [candidate, key]
    if (key === 'data' && candidate && typeof candidate === 'object') {
      for (const deep of COVERAGE_DEEP_KEYS) {
        const inner = candidate[deep]
        if (Array.isArray(inner)) return [inner, `data.${deep}`]
      }
    }
  }
  return null
}

function indexFieldName(value) {
  const located = locateContainer(value)
  if (!located) return null
  for (const element of located[0]) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) continue
    for (const key of INDEX_KEYS) {
      if (looseI64(element[key]) !== null) return key
    }
  }
  return null
}

function missingFieldName(value) {
  const objects = [value]
  const inner = descend(value, ['data'])
  if (inner) objects.push(inner)
  for (const candidate of objects) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    for (const key of MISSING_KEYS) {
      if (candidate[key] !== undefined) return key
    }
  }
  return null
}

/**
 * 解析 emby/episodes 响应。两条接受路径（或关系）：命中集列表（产出已有集集合）或
 * 命中显式缺集列表。两者都没有 ⇒ 抛 Error（绝不凭一个数字推断缺口）。
 */
export function parseCoverage(value) {
  // 区间式契约优先：`covered_episodes:"1-24"` / `needed_episodes:""`。
  // 空串 = 一集都没有（已知事实，记 Some(空集)），不是"没有逐集信息"。
  const roots = []
  if (value && typeof value === 'object' && !Array.isArray(value)) roots.push(value)
  const inner = descend(value, ['data'])
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) roots.push(inner)
  for (const obj of roots) {
    const haveValue = firstOf(obj, RANGE_HAVE_KEYS)
    const missingValue = firstOf(obj, RANGE_MISSING_KEYS)
    // 字段存在但解析不了（畸形区间）→ null，落回数组路径（与 Rust and_then 语义一致）。
    const rangeHave = haveValue !== null ? episodeSetOf(haveValue) : null
    const rangeMissing = missingValue !== null ? episodeSetOf(missingValue) : null
    if (rangeHave !== null || rangeMissing !== null) {
      const haveName = RANGE_HAVE_KEYS.find((key) => obj[key] !== undefined) ?? 'n/a'
      const missingName = RANGE_MISSING_KEYS.find((key) => obj[key] !== undefined) ?? 'n/a'
      return new Coverage({
        have: rangeHave,
        missing: rangeMissing,
        count_hint: null,
        shape: `list=${haveName};index=range;missing=${missingName}`,
      })
    }
  }

  const located = locateContainer(value)
  // locateContainer 只在真的命中"集列表"字段时才返回；空列表 = 该端点没有任何集。
  const have = located ? collectHave(located[0]) : null

  let missing = null
  if (value && typeof value === 'object' && !Array.isArray(value)) missing = missingFrom(value)
  if (missing === null && inner) missing = missingFrom(inner)

  if (have === null && missing === null) {
    throw new Error('既没有集列表也没有缺集列表')
  }

  const coverage = new Coverage({ have, missing, count_hint: null, shape: '' })
  // 数值兜底只在有显式缺集列表时才认（规则：不允许凭一个数字推断缺口）。
  if (coverage.missing !== null) {
    for (const source of [value, inner]) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue
      const count = firstI64(source, COUNT_KEYS)
      if (count !== null) {
        coverage.count_hint = count
        break
      }
    }
  }
  const listName = located ? located[1] : 'n/a'
  const indexName = indexFieldName(value) ?? 'n/a'
  const missingName = missingFieldName(value) ?? 'n/a'
  coverage.shape = `list=${listName};index=${indexName};missing=${missingName}`
  return coverage
}

// ─────────────────────────── 参数矩阵 ───────────────────────────

/** 候选矩阵的变体号（V4 POST 自 0.1.5 起移除：宿主权限闸门只批准 manifest 声明的 GET）。 */
export const CANDIDATE_VARIANTS = [1, 2, 3, 5]

function variantKeys(variant) {
  switch (variant) {
    case 2: return ['tmdb_id', 'season_number', 'total_episodes']
    case 3: return ['tmdbId', 'season', 'total_episodes']
    case 5: return ['tmdb_id', 'season', 'total']
    default: return ['tmdb_id', 'season', 'total_episodes']
  }
}

/** 一次 emby/episodes 请求的参数组合（全部 GET；total 未知时省略总数参数）。 */
export class EpisodeQuery {
  constructor({ proxy_id, tmdb_id, season, total, variant }) {
    this.proxy_id = proxy_id
    this.tmdb_id = tmdb_id
    this.season = season
    this.total = total
    this.variant = variant
  }

  /** GET 变体的请求路径（参数全是数字，无需转义）。 */
  path() {
    const [idKey, seasonKey, totalKey] = variantKeys(this.variant)
    let path = EPISODES_PATH + '?'
    if (this.proxy_id !== null && this.proxy_id !== undefined) path += `proxy_id=${this.proxy_id}&`
    path += `${idKey}=${this.tmdb_id}&${seasonKey}=${this.season}`
    if (this.total !== null && this.total !== undefined) path += `&${totalKey}=${this.total}`
    return path
  }

  /** 参数名列表（写进形状指纹与 debug.attempts[].params）。 */
  paramsLabel() {
    const [idKey, seasonKey, totalKey] = variantKeys(this.variant)
    if (this.proxy_id !== null && this.proxy_id !== undefined) {
      return `proxy_id,${idKey},${seasonKey},${totalKey}`
    }
    return `${idKey},${seasonKey},${totalKey}`
  }

  /** 完整指纹的 `params=` 段（带变体号，缓存命中时按它直接调用）。 */
  shapePrefix() {
    return `params=${this.paramsLabel()};v=${this.variant}`
  }
}

/** 参数矩阵：依可能性排序 V1 → V2 → V3 → V5，命中即停。 */
export function candidates(tmdbId, season, proxyId, total) {
  return CANDIDATE_VARIANTS.map(
    (variant) => new EpisodeQuery({ proxy_id: proxyId, tmdb_id: tmdbId, season, total, variant }),
  )
}

/** 从形状指纹里取出参数组合的变体号（v=4 是旧版必败指纹：当作没指纹从矩阵头重试）。 */
export function variantFromShape(shape) {
  const text = String(shape ?? '')
  for (const segment of text.split(';')) {
    if (segment.startsWith('v=')) {
      const variant = Number(segment.slice(2))
      if (CANDIDATE_VARIANTS.includes(variant)) return variant
      return null
    }
  }
  const params = text.split(';').find((segment) => segment.startsWith('params='))
  if (!params) return null
  const names = params.slice('params='.length).split(',')
  const tail = names.filter((name) => name !== 'proxy_id' && !name.startsWith('total'))
  const key = tail.join(',')
  if (key === 'tmdb_id,season') return 1
  if (key === 'tmdb_id,season_number') return 2
  if (key === 'tmdbId,season') return 3
  return null
}

/**
 * 「Emby 里没有这部剧/这一季」的独立分类（只读判定）。
 * HTTP 失败只有正文明确说"不存在/未收录"时才归这一类；空正文的 404 不算证据
 * （宿主路由/权限变更同样回空 404，误判会让整池被报成未收录）。
 */
export function failureIsAbsent(failure) {
  const status = failure.http_status ?? 0
  if (status !== 404 && status < 400) return false
  const raw = failure.raw ?? ''
  if (raw === '') return false
  const text = String(raw).toLowerCase()
  const markers = ['没有该剧', '该剧不存在', '不存在', '未收录', '未找到', 'not found', 'no such', 'not exist']
  return markers.some((marker) => text.includes(marker))
}
