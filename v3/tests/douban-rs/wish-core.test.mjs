// 想看解析测试 —— 夹具即 plugins/douban-rs/tests/{wish_parse.rs} 用的脱敏真实响应。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { wishItemsFromInterests, flexId, parseInterestsResponse, wishInterestsUrl, WISH_PAGE_SIZE, WISH_MAX_PAGES, WISH_USER_AGENT } from '../../douban-rs/lib/wish-core.js'

const WISH_MOVIE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/wish_movie.json', import.meta.url)), 'utf8'))
const WISH_TV = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/wish_tv.json', import.meta.url)), 'utf8'))

test('movie 夹具：3 条全是 movie，评分补提取 8.6/8.7/5.8', () => {
  assert.equal(WISH_MOVIE.total, 3)
  const items = wishItemsFromInterests(WISH_MOVIE.interests)
  assert.equal(items.length, 3)
  assert.deepEqual(items.map((item) => item.douban_ref), ['36808876', '36809864', '35653205'])
  assert.equal(items[0].title, '奥德赛')
  assert.equal(items[0].year, '2026')
  assert.equal(items[0].type, 'movie')
  assert.ok(items[0].poster_url.startsWith('https://img'))
  assert.equal(items[0].added_at, '', 'added_at 由调用方补时间戳')
  // 功能 2 评分补提取（实抓响应复核）
  assert.deepEqual(items.map((item) => item.rating), [8.6, 8.7, 5.8])
})

test('tv 夹具：4 条里混 1 条 book（year 键缺失），书目被滤掉', () => {
  assert.equal(WISH_TV.total, 4)
  assert.equal(WISH_TV.interests.length, 4)
  const items = wishItemsFromInterests(WISH_TV.interests)
  assert.equal(items.length, 3, 'book 必须被滤掉')
  assert.ok(items.every((item) => item.type === 'movie' || item.type === 'tv'))
  assert.ok(!items.some((item) => item.douban_ref === '26968034'), '书目不得进列表')
})

test('flexId 收字符串/数字/null', () => {
  assert.equal(flexId('36808876'), '36808876')
  assert.equal(flexId(12345), '12345', '数字 id 要收成不带引号的原文')
  assert.equal(flexId(4935623109), '4935623109')
  assert.equal(flexId(null), '')
  assert.equal(flexId(undefined), '')
})

test('数字型 id 在完整条目里映射到 douban_ref；空白 id 跳过', () => {
  const items = wishItemsFromInterests([
    { subject: { id: 12345, title: '某剧集', year: '2026', type: 'tv', pic: {} } },
    { subject: { id: '  ', title: 'x', type: 'movie' } },
  ])
  assert.equal(items.length, 1)
  assert.equal(items[0].douban_ref, '12345')
  assert.equal(items[0].type, 'tv')
})

test('parseInterestsResponse 容忍缺失 total；interests 类型不符报 null', () => {
  assert.deepEqual(parseInterestsResponse({ interests: [], total: 'x' }), { interests: [], total: 0 })
  assert.deepEqual(parseInterestsResponse({ interests: [{ subject: { id: '1', type: 'movie' } }] }), { interests: [{ subject: { id: '1', type: 'movie' } }], total: 0 })
  assert.equal(parseInterestsResponse({ interests: 'nope' }), null)
  assert.equal(parseInterestsResponse(null), null)
  assert.equal(parseInterestsResponse([1]), null)
})

test('想看接口 URL/分页常量与旧实现一致', () => {
  assert.equal(WISH_PAGE_SIZE, 50)
  assert.equal(WISH_MAX_PAGES, 4)
  assert.equal(
    wishInterestsUrl('123456789', 'movie', 50),
    'https://m.douban.com/rexxar/api/v2/user/123456789/interests?kind=mark&type=movie&start=50&limit=50',
  )
  assert.ok(WISH_USER_AGENT.includes('iPhone'), '移动 UA')
})
