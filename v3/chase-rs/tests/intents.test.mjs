// 订阅池解析测试 —— 移植自 plugins/chase-rs/src/intents.rs 的核心用例。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  actionable,
  listPath,
  LIMIT_MAX,
  MEDIA_TYPE,
  patchBody,
  patchIdempotencyKey,
  patchPath,
  parseIntent,
  parseList,
  PAGES_MAX,
  strictRoundtrip,
  trimCandidate,
} from '../lib/intents.js'

const STRONG = {
  code: 'ok',
  data: [
    {
      id: 41, tmdb_id: 1396, season: 5, media_type: 'tv',
      title: '绝命毒师', total_episodes_known: 13, state: 'partial',
      needed_episodes: '[11,12,13]', covered_episodes: '[1,2,3]',
    },
    {
      id: 42, tmdb_id: 1399, season: 1, media_type: 'tv',
      title: '权力的游戏', total_episodes_known: 10, state: 'landed',
      needed_episodes: '', covered_episodes: '',
    },
  ],
  counts: { partial: 1, landed: 1 },
}

const LOOSE = {
  data: {
    items: [
      { intent_id: '7', tmdbId: '1396', season: '5', media_type: 'tv', name: '绝命毒师', total_episodes: '13', state: 'caught_up' },
    ],
  },
}

test('解析强类型载荷', () => {
  const page = parseList(STRONG)
  assert.equal(page.items.length, 2)
  assert.equal(page.skipped, 0)
  const first = page.items[0]
  assert.equal(first.id, 41)
  assert.equal(first.tmdb_id, 1396)
  assert.equal(first.season, 5)
  assert.equal(first.title, '绝命毒师')
  assert.equal(first.total_known, 13)
  assert.equal(first.state, 'partial')
  assert.equal(actionable(first), true)
  assert.equal(first.needed_episodes, '[11,12,13]')
  assert.equal(trimCandidate(page.items[1]), true)
})

test('宽松形态与裸数组形态', () => {
  const loose = parseList(LOOSE)
  assert.equal(loose.items.length, 1)
  assert.equal(loose.items[0].id, 7)
  assert.equal(loose.items[0].tmdb_id, 1396)
  assert.equal(loose.items[0].total_known, 13)
  assert.equal(loose.items[0].media_type, 'tv', 'media_type 从载荷里读, 不是默认值')

  const bare = parseList([{ id: 9, tmdb_id: 99, season: 1, media_type: 'tv', total_episodes_known: 8, state: 'pending' }])
  assert.equal(bare.items.length, 1)
  assert.equal(bare.items[0].id, 9)
})

test('解析不出的形态如实报错，不填默认值', () => {
  assert.throws(() => parseList({ code: 'ok', data: { nope: 1 } }), /data 不是数组/)
  assert.throws(() => parseList({ code: 'ok' }), /缺少 data 数组/)
  assert.throws(() => parseList('<html>502</html>'))
  assert.throws(() => parseList(null))
  assert.throws(() => parseList(''), Error)
  assert.throws(() => parseList({ code: 'error', data: [] }), /code=error/)
  assert.throws(() => parseList([{ foo: 1 }, { bar: 2 }]), /全部缺少关键字段/)
})

test('畸形条目跳过而不造假零值', () => {
  const page = parseList({
    code: 'ok',
    data: [
      { id: 1, tmdb_id: 2, season: 1, media_type: 'tv', total_episodes_known: 3 },
      { id: 4, tmdb_id: 5, media_type: 'tv', total_episodes_known: 6 },
      { id: 7, tmdb_id: 8, season: 2, total_episodes_known: 9 },
      { id: 10, tmdb_id: 11, season: 3, media_type: 'tv' },
      'not an object',
    ],
  })
  assert.equal(page.items.length, 1, '只有完整的一条能被收下')
  assert.equal(page.skipped, 4, '缺 season / 缺 media_type / 缺 total / 非对象全跳过')
})

test('season / media_type 必填（缺失即跳过，不能拿 0 / "tv" 顶替）', () => {
  const base = { id: 1, tmdb_id: 2, season: 5, media_type: 'tv', total_episodes_known: 3 }
  assert.notEqual(parseIntent(base), null)
  const without = (key) => {
    const clone = { ...base }
    delete clone[key]
    return clone
  }
  assert.equal(parseIntent(without('season')), null, '缺 season 必须跳过')
  assert.equal(parseIntent(without('media_type')), null, '缺 media_type 必须跳过')
  assert.equal(parseIntent({ ...base, media_type: '' }), null, '空串等同于缺失')
  assert.equal(parseIntent({ ...base, media_type: 'movie' }).media_type, 'movie', '非 tv 条目照常收下（调用方过滤）')
})

test('空列表是合法空页', () => {
  const page = parseList({ code: 'ok', data: [], counts: {} })
  assert.equal(page.items.length, 0)
  assert.equal(page.skipped, 0)
  assert.equal(parseList({ code: 'ok', data: { items: [] } }).items.length, 0)
})

test('listPath 有界并过滤 tv', () => {
  assert.equal(listPath(500, 1000), '/api/subscribe/pool/intents?media_type=tv&limit=500&offset=1000')
  assert.ok(listPath(9999, 0).includes('limit=500'), 'limit 夹取到 schema 上限')
  assert.ok(listPath(50, 50).includes('limit=50'))
  assert.equal(LIMIT_MAX, 500)
  assert.equal(PAGES_MAX, 4)
  assert.equal(MEDIA_TYPE, 'tv')
})

test('patchBody 默认只写 total_episodes', () => {
  assert.deepEqual(patchBody(13, null, null), { total_episodes: 13 })
})

test('patchBody 只在严格往返一致时追加集数字符串', () => {
  assert.equal(strictRoundtrip('[11,12,13]'), '[11,12,13]')
  assert.deepEqual(
    patchBody(13, '[11,12,13]', '[1,2,3]'),
    { total_episodes: 13, needed_episodes: '[11,12,13]', covered_episodes: '[1,2,3]' },
  )
  assert.equal(strictRoundtrip('11,12,13'), null)
  assert.equal(strictRoundtrip('[11, 12]'), null, '空格不一致就不写')
  assert.equal(strictRoundtrip(''), null)
  assert.equal(strictRoundtrip('[1.50]'), null, '浮点规范化后不一致')
  assert.deepEqual(patchBody(13, '11,12,13', null), { total_episodes: 13 })
  // 两个字符串各自独立判定
  assert.deepEqual(patchBody(5, '[4,5]', '1,2'), { total_episodes: 5, needed_episodes: '[4,5]' })
})

test('幂等键的形状与可复现', () => {
  const key = patchIdempotencyKey(41, 10, 13, 7)
  assert.equal(key, 'chase-patch-41-10-13-7')
  assert.ok(key.length >= 16 && key.length <= 128, `长度 ${key.length}`)
  assert.ok(/^[\x21-\x7e]+$/.test(key), '全部是可打印 ASCII')
  assert.equal(key, patchIdempotencyKey(41, 10, 13, 7), '同业务重试必须复用同值')
  assert.notEqual(key, patchIdempotencyKey(41, 10, 12, 7))
})

test('patchPath 指向文档化路由', () => {
  assert.equal(patchPath(41), '/api/subscribe/pool/intents/41/episodes')
})

test('actionable / trimCandidate 的状态口径', () => {
  const withState = (state) => ({ state })
  assert.equal(actionable(withState('partial')), true)
  assert.equal(actionable(withState('')), true, '缺 state 的条目仍参与补订')
  assert.equal(actionable(withState('expired')), false, '到期只计数, 不写')
  assert.equal(actionable(withState('failed')), false)
  assert.equal(trimCandidate(withState('caught_up')), true)
  assert.equal(trimCandidate(withState('landed')), true)
  assert.equal(trimCandidate(withState('partial')), false)
  assert.equal(trimCandidate(withState('')), false)
})

test('负集数/负季号夹到 0，超长标题按 UTF-8 边界截断', () => {
  const intent = parseIntent({
    id: 3, tmdb_id: 4, season: -2, media_type: 'tv',
    total_episodes_known: -9, title: '剧'.repeat(200),
  })
  assert.equal(intent.total_known, 0)
  assert.equal(intent.season, 0)
  assert.ok(new TextEncoder().encode(intent.title).length <= 160)
})
