// 追剧日历解析测试 —— 移植自 plugins/chase-rs/src/aircal.rs 的核心用例。
import test from 'node:test'
import assert from 'node:assert/strict'

import { parse } from '../lib/aircal.js'
import { CALENDAR_ITEMS_MAX } from '../lib/state.js'

test('解析扁平 / 分组 / 裸数组三种形态', () => {
  const flat = parse({
    items: [
      { tmdb_id: 1396, season: 5, episode: 1, title: '绝命毒师', air_date: '2026-10-01T12:00:00Z', air_time: '12:00' },
      { tmdb_id: 1396, season: 5, episode: 2, title: '绝命毒师', date: '2026-10-02', time: '12:00' },
    ],
  })
  assert.equal(flat.days.length, 2)
  assert.equal(flat.days[0].date, '2026-10-01')
  assert.equal(flat.days[0].items[0].episode, 1)
  assert.equal(flat.days[0].items[0].time, '12:00')
  assert.equal(flat.shape, 'root=items;grouped=no;date=air_date')

  const grouped = parse({
    data: {
      days: [
        { date: '2026-10-01', items: [{ tmdbId: '1399', season_number: 1, episode_number: 3, name: '权力的游戏' }] },
        { air_date: '2026-10-02', episodes: [{ id: 1399, season: 1, episode: 4, series_name: '权力的游戏' }] },
      ],
    },
  })
  assert.equal(grouped.days.length, 2)
  assert.equal(grouped.days[0].items[0].tmdb_id, 1399)
  assert.equal(grouped.days[1].date, '2026-10-02')
  assert.ok(grouped.shape.startsWith('root=data.days;grouped=yes;'))

  const bare = parse([
    { tmdb_id: 42, season: 2, episode: 9, title: '某剧', air_date: '2026/10/03' },
    { tmdb_id: 43, season: 1, episode: 1, title: '没有日期' },
    'not an object',
  ])
  assert.equal(bare.days.length, 1, '无日期的条目被丢弃')
  assert.equal(bare.days[0].date, '2026-10-03')
  assert.equal(bare.items_seen, 3)
  assert.equal(bare.shape, 'root=array;grouped=no;date=air_date')
})

test('解析失败的形态如实报错；空数组是合法空日历', () => {
  assert.throws(() => parse('<html>'), Error)
  assert.throws(() => parse({ nope: 1 }), /日历结构未识别/)
  assert.throws(() => parse(''), Error)
  const empty = parse([])
  assert.equal(empty.isEmpty(), true)
})

test('嵌套 data.items 与日期归一', () => {
  const calendar = parse({
    data: {
      items: [
        { tmdb_id: 7, season: 1, episode: 2, title: '某剧', date: '2026-10-03T21:30:00+08:00' },
        { tmdb_id: 7, season: 1, episode: 3, title: '某剧', date: '2026/10/04' },
        { tmdb_id: 7, season: 1, episode: 4, title: '没有日期' },
      ],
    },
  })
  assert.equal(calendar.days.length, 2)
  assert.equal(calendar.days[0].date, '2026-10-03')
  assert.equal(calendar.days[1].date, '2026-10-04')
  assert.equal(calendar.items_seen, 3, '丢弃前计数')
  assert.equal(calendar.shape, 'root=data.items;grouped=no;date=date')
})

test('分组日无可用日期被丢弃但仍计数', () => {
  const calendar = parse({
    days: [
      { date: 'oops', items: [{ tmdb_id: 1, episode: 1, title: 'x' }] },
      { date: '2026-10-05', items: [{ tmdb_id: 1, episode: 2, title: 'y' }] },
    ],
  })
  assert.equal(calendar.days.length, 1)
  assert.equal(calendar.days[0].date, '2026-10-05')
  assert.equal(calendar.items_seen, 2)
  assert.ok(calendar.shape.startsWith('root=days;grouped=yes;'))
})

test('窗口按本地日期筛选并封顶 8 天', () => {
  const days = Array.from({ length: 12 }, (_, offset) => ({
    date: datePlus('2026-10-01', offset),
    items: [{ episode: offset, season: 1, tmdb_id: 1, title: 'x', time: '' }],
  }))
  const calendar = parse({ items: days.map((day) => ({ ...day.items[0], date: day.date })) })
  const window = calendar.window('2026-10-01', 7)
  assert.equal(window.length, 8, '含今日共 8 天')
  assert.equal(window[0].date, '2026-10-01')
  assert.equal(window[7].date, '2026-10-08')
  assert.equal(calendar.window('2026-10-05', 2).length, 3, '过去的日子被排除')
  assert.equal(calendar.window('oops', 7).length, 0, '非法日期 → 空')
  assert.equal(calendar.itemsOn('2026-10-02').length, 1)
  assert.equal(calendar.itemsOn('2027-01-01').length, 0)
  assert.equal(calendar.window('2026-10-01', 0).length, 1, '0 天窗口只留今天')
  assert.equal(calendar.window('2026-10-01', -3).length, 1, '负数按 0 天处理')
})

test('条目按集号升序并封顶', () => {
  const items = Array.from({ length: 30 }, (_, index) => ({
    tmdb_id: 1, season: 1, episode: 30 - index, title: 'x', date: '2026-10-01',
  }))
  const calendar = parse({ items })
  assert.equal(calendar.days[0].items.length, CALENDAR_ITEMS_MAX)
  assert.equal(calendar.days[0].items[0].episode, 1, '按集号升序')
})

test('空日历与只有空分组的日历都算"空"', () => {
  const calendar = parse([])
  assert.equal(calendar.isEmpty(), true)
  assert.equal(calendar.itemsOn('2026-10-01').length, 0)
  assert.equal(calendar.window('2026-10-01', 7).length, 0)
  const blank = parse({ days: [{ date: '2026-10-01', items: [] }] })
  assert.equal(blank.isEmpty(), true)
  assert.equal(blank.days.length, 1)
})

function datePlus(date, delta) {
  const start = new Date(`${date}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() + delta)
  return start.toISOString().slice(0, 10)
}
