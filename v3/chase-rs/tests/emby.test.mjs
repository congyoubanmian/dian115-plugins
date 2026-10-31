// Emby 解析层测试 —— 移植自 plugins/chase-rs/src/emby.rs 的核心用例。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  candidates,
  CANDIDATE_VARIANTS,
  EpisodeQuery,
  episodeSetOf,
  failureIsAbsent,
  parseCoverage,
  parseEpisodeRanges,
  parseInstances,
  select,
  selectionFromSettings,
  variantFromShape,
} from '../lib/emby.js'

test('解析区间串的各种形态', () => {
  assert.deepEqual([...parseEpisodeRanges('')], [])
  assert.deepEqual([...parseEpisodeRanges('5')], [5])
  assert.deepEqual([...parseEpisodeRanges('1-24')], Array.from({ length: 24 }, (_, index) => index + 1))
  assert.deepEqual([...parseEpisodeRanges('1,3,5-7')], [1, 3, 5, 6, 7])
  assert.equal(parseEpisodeRanges('abc'), null)
  assert.equal(parseEpisodeRanges('5-2'), null, '倒序不认')
  assert.equal(parseEpisodeRanges('1-99999'), null, '超上限不认')
})

test('episodeSetOf 接受区间串/数组/单个数字', () => {
  assert.deepEqual([...episodeSetOf('2-3')], [2, 3])
  assert.deepEqual([...episodeSetOf([1, '2'])], [1, 2])
  assert.deepEqual([...episodeSetOf(9)], [9])
  assert.equal(episodeSetOf('nope'), null)
  assert.equal(episodeSetOf([1, 'x']), null)
})

test('解析强类型实例列表并按配置选择', () => {
  const instances = parseInstances({
    items: [
      { id: 3, name: '客厅', is_default: true, api_key_configured: true },
      { id: 4, name: '卧室', is_default: false, api_key_configured: false },
    ],
  })
  assert.equal(instances.length, 2)
  assert.equal(instances[0].key_ready, true)
  // 宿主原字段 api_key_configured 改名 key_ready：凭据键名不得进状态文档
  assert.equal('api_key_configured' in instances[0], false)

  assert.deepEqual(select(instances, 3), { id: 3, name: '客厅', proxy_id: 3 })
  assert.throws(() => select(instances, 4), /未配置密钥/)
  assert.throws(() => select(instances, 99), /不在可用列表/)
  assert.deepEqual(select(instances, -1), { id: 3, name: '客厅', proxy_id: 3 }, '跟随默认')
  assert.throws(() => select([], -1), /没有返回可用/)
})

test('旧版单实例省略 proxy_id', () => {
  const instances = parseInstances({ items: [{ id: 0, name: '旧版', is_default: true, api_key_configured: true }] })
  assert.deepEqual(select(instances, 0), { id: 0, name: '旧版', proxy_id: null })
  assert.deepEqual(select(instances, -1), { id: 0, name: '旧版', proxy_id: null })
})

test('selectionFromSettings 只认显式配置（-1 不猜默认实例）', () => {
  assert.deepEqual(selectionFromSettings(0), { id: 0, name: '', proxy_id: null })
  assert.deepEqual(selectionFromSettings(7), { id: 7, name: '', proxy_id: 7 })
  assert.equal(selectionFromSettings(-1), null)
})

test('逐集列表形态的覆盖解析', () => {
  const coverage = parseCoverage({
    items: [{ index_number: 1 }, { index_number: 2 }, { index_number: 12 }],
    missing: [11],
    episode_count: 3,
  })
  assert.deepEqual([...coverage.have], [1, 2, 12])
  assert.deepEqual([...coverage.missing], [11])
  assert.equal(coverage.haveMax(), 12)
  assert.equal(coverage.haveCount(), 3)
  assert.equal(coverage.gapMax(5), 12)
  // 缺集列表只找 > total_known 的缺口（缺集 11 不高于订阅 12 → 无缺口上沿）
  assert.equal(coverage.gapMax(12), 0)
  assert.equal(coverage.gapMax(20), 0)
  assert.equal(coverage.gapMax(8), 12, 'have_max 高于订阅时用 have_max')
  assert.equal(coverage.shape, 'list=items;index=index_number;missing=missing')
})

test('区间式契约（真实宿主 2026-10-02 实测）', () => {
  const coverage = parseCoverage({ complete: true, covered_episodes: '1-12', needed_episodes: '' })
  assert.equal(coverage.haveMax(), 12)
  assert.equal(coverage.haveCount(), 12)
  assert.equal(coverage.isAbsent(), false)
  assert.equal(coverage.shape, 'list=covered_episodes;index=range;missing=needed_episodes')

  // 空覆盖串 = 该季 0 集（已知事实），同时带缺集列表也不影响
  const absent = parseCoverage({ complete: false, covered_episodes: '', needed_episodes: '1-24' })
  assert.equal(absent.isAbsent(), true)
  assert.equal(absent.haveCount(), 0)
  assert.equal(absent.missingMax(), 24)
  assert.equal(absent.unknownNote(), '响应里的逐集覆盖是空集(该季 0 集), 没有更细的逐集明细')
})

test('data 信封里的覆盖', () => {
  const coverage = parseCoverage({ data: { items: [{ episode: 4 }] } })
  assert.deepEqual([...coverage.have], [4])
  assert.equal(coverage.shape, 'list=data.items;index=episode;missing=n/a')
})

test('只有缺集列表：覆盖未知但有缺口', () => {
  const coverage = parseCoverage({ missing_episodes: [12] })
  assert.equal(coverage.have, null)
  assert.deepEqual([...coverage.missing], [12])
  assert.equal(coverage.gapMax(10), 12)
  assert.equal(coverage.unknownNote(), '响应只有缺集列表, 没有逐集覆盖')
})

test('count 只在有显式缺集列表时才认（不凭数字推断缺口）', () => {
  const withMissing = parseCoverage({ missing: [12], episode_count: 3 })
  assert.equal(withMissing.count_hint, 3)
  assert.throws(() => parseCoverage({ episode_count: 3 }), /既没有集列表也没有缺集列表/)
})

test('解析失败与空集的区分', () => {
  assert.throws(() => parseCoverage({ nope: 1 }), /既没有集列表也没有缺集列表/)
  assert.throws(() => parseCoverage('not json'), Error)
  const empty = parseCoverage({ items: [] })
  assert.equal(empty.isAbsent(), true, '空列表 = 该端点没有任何集')
  assert.deepEqual([...empty.have], [])
})

test('coversRange 的全量核对', () => {
  const full = parseCoverage({ items: [{ index_number: 1 }, { index_number: 2 }, { index_number: 3 }] })
  assert.equal(full.coversRange(1, 3), true)
  assert.equal(full.coversRange(1, 4), false)
  const holed = parseCoverage({ items: [{ index_number: 1 }, { index_number: 3 }] })
  assert.equal(holed.coversRange(1, 3), false)
  assert.equal(holed.coversRange(2, 2), false, '第 2 集缺失，区间不全')
  const noList = parseCoverage({ missing: [9] })
  assert.equal(noList.coversRange(1, 1), false, '没有逐集覆盖就不给减方向建议')
})

test('参数矩阵顺序与路径构造', () => {
  const queries = candidates(1396, 5, 3, 16)
  assert.deepEqual(queries.map((query) => query.variant), [1, 2, 3, 5])
  assert.deepEqual(CANDIDATE_VARIANTS, [1, 2, 3, 5])
  assert.equal(
    queries[0].path(),
    '/api/plugin-host/emby/episodes?proxy_id=3&tmdb_id=1396&season=5&total_episodes=16',
  )
  assert.equal(
    queries[1].path(),
    '/api/plugin-host/emby/episodes?proxy_id=3&tmdb_id=1396&season_number=5&total_episodes=16',
  )
  // 旧版单实例省略 proxy_id；total 未知时省略总数参数
  const legacy = new EpisodeQuery({ proxy_id: null, tmdb_id: 1, season: 1, total: null, variant: 1 })
  assert.equal(legacy.path(), '/api/plugin-host/emby/episodes?tmdb_id=1&season=1')
  assert.equal(queries[0].shapePrefix(), 'params=proxy_id,tmdb_id,season,total_episodes;v=1')
})

test('variantFromShape 认 v= 段并兼容旧指纹', () => {
  assert.equal(variantFromShape('params=proxy_id,tmdb_id,season,total_episodes;v=5'), 5)
  assert.equal(variantFromShape('params=proxy_id,tmdb_id,season,total_episodes;v=4'), null, '旧 POST 指纹当没指纹')
  assert.equal(variantFromShape('params=tmdb_id,season;list=items'), 1)
  assert.equal(variantFromShape('params=tmdb_id,season_number;list=items'), 2)
  assert.equal(variantFromShape('params=tmdbId,season;list=items'), 3)
  assert.equal(variantFromShape(''), null)
})

test('failureIsAbsent 只认带正文的 4x/404', () => {
  assert.equal(failureIsAbsent({ http_status: 404, raw: '{"error":"没有该剧"}' }), true)
  assert.equal(failureIsAbsent({ http_status: 400, raw: 'series not found' }), true)
  assert.equal(failureIsAbsent({ http_status: 404, raw: '' }), false, '空正文 404 不算证据')
  assert.equal(failureIsAbsent({ http_status: 400, raw: '{"error":"tmdb_id required"}' }), false, '参数错误不是未收录')
  assert.equal(failureIsAbsent({ http_status: 500, raw: 'boom' }), false)
  assert.equal(failureIsAbsent({ http_status: 0, raw: 'not found' }), false, '传输失败没有状态证据')
})
