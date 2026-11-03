// TMDB 匹配核心测试 —— 向量来自 plugins/douban-rs/src/subscribe.rs 内嵌测试。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  matchTmdb, tmdbTitle, tmdbYear, buildIntentBody, parseIntentCreateResult,
  parseIntentList, parseTmdbSearchResult, poolIntentsPath, HOST_POOL_INTENTS_LIMIT, CONFIDENCE_THRESHOLD,
} from '../../douban-rs/lib/subscribe-core.js'
import { normalizeTitle } from '../../douban-rs/lib/text.js'

const tmdbItem = (id, title, mediaType, vote, extra = {}) => ({
  id, title, media_type: mediaType, vote_average: vote, name: '', original_title: '', original_name: '',
  release_date: '', first_air_date: '', poster_path: '', backdrop_path: '', ...extra,
})

test('normalize_title 折算全角标点', () => {
  assert.equal(normalizeTitle('  奥德赛 (2026)  '), '奥德赛 (2026)')
  assert.equal(normalizeTitle('奥德赛（2026）'), '奥德赛(2026)')
  assert.equal(normalizeTitle('人生路不熟·测试'), '人生路不熟 测试')
  assert.equal(normalizeTitle('A：B，C。D！E？'), 'a:b,cde')
})

test('match_tmdb 评分口径与 Go 一致', () => {
  const exact = tmdbItem(1, '奥德赛', 'movie', 7.5)
  const partial = tmdbItem(2, '奥德赛 (2026)', 'tv', 3.0)
  const unrelated = tmdbItem(3, '别的电影', 'movie', 9.0)
  const results = [partial, exact, unrelated]

  // 完全相同 + media_type 相符 + 评分 >= 6 → 1.0
  let out = matchTmdb(results, '奥德赛', 'movie')
  assert.equal(out.best.id, 1)
  assert.ok(Math.abs(out.score - 1.0) < 1e-9, `实际 ${out.score}`)

  // wantType 空串 → 没有 media_type 加分：0.7 + 0.05 = 0.75
  out = matchTmdb(results, '奥德赛', '')
  assert.equal(out.best.id, 1)
  assert.ok(Math.abs(out.score - 0.75) < 1e-9)

  // 互相包含 +0.4：media_type 不符且评分 < 6 → 只有 0.4
  out = matchTmdb([partial], '奥德赛', 'movie')
  assert.equal(out.best.id, 2)
  assert.ok(Math.abs(out.score - 0.4) < 1e-9)

  // 全角折算后视为相同：0.7 + 0.25 = 0.95
  out = matchTmdb([tmdbItem(4, '奥德赛(2026)', 'tv', 3.0)], '奥德赛（2026）', 'tv')
  assert.equal(out.best.id, 4)
  assert.ok(Math.abs(out.score - 0.95) < 1e-9)

  // 没有任何标题命中 → 第一个候选 + 0 分
  out = matchTmdb(results, '完全不存在的片名', 'movie')
  assert.equal(out.best.id, 2)
  assert.ok(Math.abs(out.score - 0.0) < 1e-9)

  // 空结果 → 零值 + 0
  out = matchTmdb([], 'x', 'movie')
  assert.equal(out.best.id, 0)
  assert.equal(out.score, 0)
})

test('阈值常量与旧实现一致', () => {
  assert.equal(CONFIDENCE_THRESHOLD, 0.5)
  assert.equal(HOST_POOL_INTENTS_LIMIT, 200)
  assert.equal(poolIntentsPath(), '/api/subscribe/pool/intents?limit=200')
})

test('tmdb_title / tmdb_year 与 Go 一致', () => {
  const item = tmdbItem(1, '奥德赛', 'movie', 0, { release_date: '2026-08-14' })
  assert.equal(tmdbTitle(item), '奥德赛')
  assert.equal(tmdbYear(item), '2026')

  const tv = tmdbItem(2, '', 'tv', 0, { name: '某剧', first_air_date: '2025-01-01' })
  assert.equal(tmdbTitle(tv), '某剧')
  assert.equal(tmdbYear(tv), '2025')

  assert.equal(tmdbTitle(tmdbItem(3, '', 'movie', 0)), '')
  assert.equal(tmdbYear(tmdbItem(4, 'x', 'movie', 0, { release_date: '20' })), '')
})

test('buildIntentBody：season 0/1、media_type 回落、空字段省略', () => {
  const body = buildIntentBody({
    item: tmdbItem(11, '奥德赛', 'movie', 7.5, { poster_path: '/p.jpg', backdrop_path: '/b.jpg' }),
    wantType: '',
    title: '奥德赛',
    year: '2026',
    enabledSources: ['wish'],
  })
  assert.deepEqual(body, {
    tmdb_id: 11,
    media_type: 'movie',
    season: 0,
    title: '奥德赛',
    episode_scope_mode: 'follow',
    year: '2026',
    poster_path: '/p.jpg',
    backdrop_path: '/b.jpg',
    enabled_sources: ['wish'],
  })

  const tv = buildIntentBody({
    item: tmdbItem(22, '', 'tv', 6.0, { name: '列奥纳多' }),
    wantType: 'tv',
    title: '列奥纳多',
    year: '',
    enabledSources: [],
  })
  assert.equal(tv.season, 1)
  assert.equal(tv.media_type, 'tv')
  assert.equal('year' in tv, false)
  assert.equal('enabled_sources' in tv, false)

  assert.throws(() => buildIntentBody({ item: tmdbItem(0, 'x', 'movie', 0), wantType: '', title: 'x', year: '', enabledSources: [] }), /TMDB 条目无效/)
})

test('parseIntentCreateResult：code 非 ok 报错（Go %q 文案）', () => {
  assert.equal(parseIntentCreateResult({ code: 'ok', data: { id: 171 } }), 171)
  assert.throws(() => parseIntentCreateResult({ code: 'bad', data: { id: 1 } }), /创建订阅返回异常 code="bad"/)
  assert.throws(() => parseIntentCreateResult({ code: 'ok' }), /创建订阅响应解析失败/)
})

test('parseIntentList / parseTmdbSearchResult 对脏数据收敛', () => {
  const entries = parseIntentList({ code: 'ok', data: [{ id: 7, tmdb_id: 11, media_type: 'movie', title: 'x', state: 'pending' }, { id: 'bad' }] })
  assert.equal(entries.length, 2)
  assert.equal(entries[1].tmdb_id, 0)
  assert.equal(parseIntentList({ code: 'ok' }), null)
  assert.equal(parseIntentList(null), null)

  const results = parseTmdbSearchResult({ results: [{ id: 1077295, title: '奥德赛', media_type: 'movie', vote_average: 7.4 }] })
  assert.equal(results.length, 1)
  assert.equal(results[0].id, 1077295)
  assert.equal(parseTmdbSearchResult(null).length, 0)
  assert.equal(parseTmdbSearchResult({ results: 'nope' }).length, 0)
})

test('match_tmdb 过滤 person 等非影视条目；preferType 只做同分决胜', () => {
  const person = tmdbItem(9, '奥德赛', 'person', 9.0)
  let out = matchTmdb([person], '奥德赛', '')
  assert.equal(out.best.id, 0, 'person 不能当订阅目标')
  assert.equal(out.score, 0)

  const movie = tmdbItem(1, '奥德赛', 'movie', 7.5)
  const tv = tmdbItem(2, '奥德赛', 'tv', 7.5)
  out = matchTmdb([person, tv, movie], '奥德赛', '')
  assert.equal(out.best.id, 2, '不传 preferType：同分取先出现的')
  out = matchTmdb([person, tv, movie], '奥德赛', '', 'movie')
  assert.equal(out.best.id, 1, '同分时偏向已知类型')
  assert.ok(Math.abs(out.score - 0.75) < 1e-9, 'preferType 不改置信度')
  out = matchTmdb([tmdbItem(3, '奥德赛 2', 'movie', 7.5), tv], '奥德赛', '', 'movie')
  assert.equal(out.best.id, 2, '分数更高的仍然胜出')
})

test('pool intents 分页路径带 media_type / offset', () => {
  assert.equal(poolIntentsPath({ mediaType: 'tv', offset: 400 }), '/api/subscribe/pool/intents?limit=200&media_type=tv&offset=400')
  assert.equal(poolIntentsPath({ mediaType: 'person', offset: 0 }), '/api/subscribe/pool/intents?limit=200')
})
