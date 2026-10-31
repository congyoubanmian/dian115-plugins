// 榜单解析测试 —— 期望值来自 plugins/douban-rs/tests/charts_parse.rs 对拍过的真实页面夹具。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  parseSubjectsJson, parseChartHtml, parseComingHtml, subjectsJsonUrl,
  orderedEnabledKeys, filterAndEnqueue, checkItemDecision, parseRateOrZero,
} from '../lib/charts-parse.js'
import { sectionAfter } from '../lib/text.js'
import { defaultSettings, newStateDoc, newQueueItem } from '../lib/model.js'

const CHART_HTML = readFileSync(fileURLToPath(new URL('./fixtures/chart_listcont2.html', import.meta.url)), 'utf8')
const COMING_HTML = readFileSync(fileURLToPath(new URL('./fixtures/coming_showing_soon.html', import.meta.url)), 'utf8')
const SUBJECTS_JSON = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/search_subjects.json', import.meta.url)), 'utf8'))
const STATE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/state_val.json', import.meta.url)), 'utf8'))

test('subjects_json 真实响应解析', () => {
  const items = parseSubjectsJson(SUBJECTS_JSON, 30)
  assert.equal(items.length, 6)
  assert.equal(items[0].douban_ref, 'db:subj:36850814')
  assert.equal(items[0].title, '年会不能停！2')
  assert.equal(items[0].rate, '6.6')
  assert.equal(items[0].poster_url, 'https://img9.doubanio.com/view/photo/s_ratio_poster/public/p2934583425.jpg')
  assert.equal(items[0].url, 'https://movie.douban.com/subject/36850814/')
  assert.equal(items[0].rank, '')
  assert.equal(items[0].year, '')
  assert.equal(items[0].hotness, 0)
  assert.equal(items[5].douban_ref, 'db:subj:35322132')
  assert.equal(items[5].title, '罗斯')
})

test('subjects_json 跳过空白标题并容忍 null', () => {
  const body = {
    subjects: [
      { id: '1', title: '   ', rate: '8.8', cover: 'c', url: 'u' },
      { id: '2', title: '  空 白 外 侧  ', rate: '', cover: '', url: '' },
    ],
    extra: null,
  }
  const items = parseSubjectsJson(body, 30)
  assert.equal(items.length, 1)
  assert.equal(items[0].douban_ref, 'db:subj:2')
  assert.equal(items[0].title, '空 白 外 侧')
  assert.deepEqual(parseSubjectsJson({ subjects: null }, 30), [])
})

test('coming_html 真实页面解析（含 U+200E 保留）', () => {
  const items = parseComingHtml(COMING_HTML, 20)
  assert.equal(items.length, 6)
  assert.equal(items[0].douban_ref, 'db:subj:36828393')
  assert.equal(items[0].title, '野兽之心')
  assert.equal(items[0].hotness, 15177)
  assert.equal(items[0].poster_url, 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2935475988.jpg')
  assert.equal(items[0].rate, '')
  assert.equal(items[0].rank, '')
  // 标题里的 U+200E 不是空白：原样保留
  assert.equal(items[1].douban_ref, 'db:subj:37247814')
  assert.equal(items[1].title, '神探之痕迹\u{200e}')
  assert.equal(items[1].hotness, 6352)
  assert.equal(items[5].title, '小猪佩奇·完美假期')
  assert.equal(items[5].hotness, 520)
  assert.equal(items[5].douban_ref, 'db:subj:36964833')
})

test('coming_html 尊重 limit 与去重', () => {
  assert.equal(parseComingHtml(COMING_HTML, 2).length, 2)
  // Go 是 append 后再比 len >= limit：limit=0/负数也收第一条
  assert.equal(parseComingHtml(COMING_HTML, 0).length, 1)
  assert.equal(parseComingHtml(COMING_HTML, -1).length, 1)

  const duplicated = `<html><body><div id="showing-soon">
    <div class="item mod "><h3><a href="https://movie.douban.com/subject/111/" class="">甲</a></h3>
      <span class="">7人想看</span></div></div>
    <div class="item mod odd"><h3><a href="https://movie.douban.com/subject/111/" class="">甲(重复)</a></h3></div></div>
    <div class="item mod "><h3><a href="https://movie.douban.com/subject/222/" class="">乙</a></h3></div></div>
  </div></body></html>`
  const items = parseComingHtml(duplicated, 20)
  assert.equal(items.length, 2)
  assert.equal(items[0].douban_ref, 'db:subj:111')
  assert.equal(items[0].hotness, 7)
  assert.equal(items[1].douban_ref, 'db:subj:222')
})

test('coming_html 无锚点时整页找 item（Go sectionAfter 原样返回）', () => {
  const page = `<html><body>
    <div class="item mod "><h3><a href="https://movie.douban.com/subject/333/">丙</a></h3>
      <img src="https://img3.doubanio.com/x.jpg" /></div></div>
  </body></html>`
  const items = parseComingHtml(page, 20)
  assert.equal(items.length, 1)
  assert.equal(items[0].douban_ref, 'db:subj:333')
  assert.equal(items[0].poster_url, 'https://img3.doubanio.com/x.jpg')
  assert.equal(items[0].hotness, 0)
})

test('chart_html 真实页面解析（无海报查询）', () => {
  const items = parseChartHtml(CHART_HTML, 20, {})
  assert.equal(items.length, 10)
  assert.equal(items[0].douban_ref, 'db:subj:35322132')
  assert.equal(items[0].title, '罗斯')
  assert.equal(items[0].rank, '1')
  assert.equal(items[0].rate, '')
  assert.equal(items[0].hotness, 0, '口碑榜 HTML 里没有「想看」字样')
  assert.equal(items[0].poster_url, '')
  assert.equal(items[0].url, 'https://movie.douban.com/subject/35322132/')
  assert.equal(items[9].rank, '10')
  assert.equal(items[9].title, '托尼')
  assert.equal(items[9].douban_ref, 'db:subj:37002986')
})

test('chart_html deep_refresh 时对前 8 条调海报回调（校验 id）', () => {
  const calls = []
  const items = parseChartHtml(CHART_HTML, 20, {
    deep: true,
    posterLookupLimit: 8,
    lookupPoster: (title, id) => {
      calls.push([title, id])
      return id === '35322132' ? 'https://img3.doubanio.com/right.jpg' : ''
    },
  })
  assert.equal(calls.length, 8, '只问前 POSTER_LOOKUP_LIMIT 条')
  assert.equal(calls[0][0], '罗斯')
  assert.equal(calls[0][1], '35322132')
  assert.equal(items[0].poster_url, 'https://img3.doubanio.com/right.jpg')
  assert.equal(items[1].poster_url, '')
})

test('section_after 在真实 chart 页从锚点截到 </ul>', () => {
  const segment = sectionAfter(CHART_HTML, 'id="listCont2"', '', '</ul>')
  assert.ok(segment.startsWith('id="listCont2">'))
  assert.equal(segment.includes('</ul>'), false)
  assert.equal(segment.split('<li class="clearfix">').length - 1, 10)
})

test('subjectsJsonUrl 的 QueryEscape 与 Go 一致', () => {
  const url = subjectsJsonUrl({ type: 'movie', tag: '热门', sort: 'recommend', limit: 30 })
  assert.equal(url, 'https://movie.douban.com/j/search_subjects?type=movie&tag=%E7%83%AD%E9%97%A8&sort=recommend&page_limit=30&page_start=0')
})

test('orderedEnabledKeys 按成本排序、平手按键序、跳过禁用', () => {
  const settings = defaultSettings()
  settings.lists.off = { source: 'subjects_json', type: 'tv', tag: '国产剧', sort: 'recommend', limit: 30, enabled: false }
  const keys = orderedEnabledKeys(settings)
  // 成本：cn_wom/global_wom/hot = subjects_json(1)，movie_wom = chart_html(2)，upcoming = coming_html(3)
  // 同成本平手按 BTreeMap 键字典序（Rust 决定论口径）
  assert.deepEqual(keys, ['cn_wom', 'global_wom', 'hot', 'movie_wom', 'upcoming'])
})

test('checkItemDecision：黑名单优先于已订阅/已在队列；空关键词不命中', () => {
  const item = { douban_ref: 'db:subj:1', title: '疯狂动物城2' }
  assert.equal(checkItemDecision(item, 'hot', ['', '动物'], [], []).hit, '动物')
  assert.equal(checkItemDecision(item, 'hot', [], [], []).hit, null)
  assert.equal(
    checkItemDecision(item, 'hot', [], [{ douban_ref: 'db:subj:1', action: 'subscribe', result: 'succeeded' }], []).skip,
    'subscribed',
  )
  assert.equal(checkItemDecision(item, 'hot', [], [], [{ douban_ref: 'db:subj:1' }]).skip, 'queued')
})

test('filterAndEnqueue 在真实 state 上只统计黑名单命中、不重复入队', () => {
  const doc = parseState(STATE)
  const queueBefore = doc.queue.items.length
  const settings = { ...doc.settings, blacklist: ['兽'] }
  const outcome = filterAndEnqueue({
    snapshot: doc.snapshot,
    docSettings: settings,
    queueItems: doc.queue.items,
    blackState: doc.blackstate,
    history: doc.history,
    nowNanos: 1_790_676_009_000_000_000,
    nowRfc3339: '2026-09-29T10:00:09Z',
    observePeriodHours: 24,
    mediaTypeOf: (list) => settings.lists[list]?.type ?? '',
  })
  assert.equal(outcome.blackState.hits, 1, '快照里只有《野兽之心》命中')
  assert.equal(outcome.blackState.recent.length, 1)
  assert.equal(outcome.blackState.recent[0].title, '野兽之心')
  assert.equal(outcome.blackState.recent[0].keyword, '兽')
  assert.equal(outcome.queueItems.length, queueBefore, '队列里的 ref 一个都不该重复入队')
})

test('filterAndEnqueue 入队形态：due = now + 观察期，media_type 取榜单 kind', () => {
  const doc = parseState(STATE)
  const settings = { ...doc.settings, blacklist: ['兽'], observe_period_hours: 24 }
  const snapshot = { fetched_at: '2026-09-29T10:00:09Z', lists: { upcoming: doc.snapshot.lists.upcoming } }
  const outcome = filterAndEnqueue({
    snapshot,
    docSettings: settings,
    queueItems: null,
    blackState: { keywords: null, hits: 0, recent: null },
    history: [{ douban_ref: doc.snapshot.lists.upcoming[1].douban_ref, action: 'subscribe', result: 'succeeded' }],
    nowNanos: 1_790_676_009_000_000_000,
    nowRfc3339: '2026-09-29T10:00:09Z',
    observePeriodHours: 24,
    mediaTypeOf: (list) => settings.lists[list]?.type ?? '',
  })
  const queued = outcome.queueItems
  assert.equal(queued.length, doc.snapshot.lists.upcoming.length - 2, '去掉黑名单命中与已订阅各 1 条')
  assert.ok(queued.every((item) => item.state === 'observing'))
  assert.ok(queued.every((item) => item.list === 'upcoming'))
  assert.ok(queued.every((item) => item.due_at === '2026-09-30T10:00:09Z'), 'due = now + 24h')
  assert.ok(queued.every((item) => item.entered_at === '2026-09-29T10:00:09Z'))
  assert.ok(queued.every((item) => item.attempt === 0))
  assert.ok(!queued.some((item) => item.douban_ref === 'db:subj:36828393'), '黑名单命中的不入队')
})

test('filterAndEnqueue 的 recent 只留 20 条、hits 按命中条数累加', () => {
  const items = Array.from({ length: 25 }, (_, index) => ({
    douban_ref: `db:subj:${index}`,
    title: `黑片${String(index).padStart(2, '0')}`,
    rate: '',
    year: '',
    url: '',
    poster_url: '',
    hotness: 0,
    rank: '',
  }))
  const outcome = filterAndEnqueue({
    snapshot: { fetched_at: '2026-09-29T10:00:09Z', lists: { hot: items } },
    docSettings: { lists: {}, blacklist: ['黑片'], observe_period_hours: 24 },
    queueItems: null,
    blackState: { keywords: null, hits: 0, recent: null },
    history: null,
    nowNanos: 1_790_676_009_000_000_000,
    nowRfc3339: '2026-09-29T10:00:09Z',
    observePeriodHours: 24,
    mediaTypeOf: () => 'movie',
  })
  assert.equal(outcome.blackState.hits, 25)
  assert.equal(outcome.blackState.recent.length, 20)
  assert.equal(outcome.queueItems, null, '全部命中黑名单 → 一条都不入队，nil 队列保持 nil')
})

test('parseRateOrZero：空串/脏值 → 0（未知）', () => {
  assert.equal(parseRateOrZero('8.0'), 8)
  assert.equal(parseRateOrZero(''), 0)
  assert.equal(parseRateOrZero('暂无评分'), 0)
})

// ── 夹具小工具：直接复用 lib/model 解析（避免测试里再写一份解析器） ──
import { parseStateDoc } from '../lib/model.js'
function parseState(raw) {
  return parseStateDoc(raw)
}

// 队列条目形态回归：入队字段集合与旧 QueueItem 一致
test('入队条目字段集合与旧 QueueItem 对齐', () => {
  const base = newQueueItem()
  assert.deepEqual(
    Object.keys(base).sort(),
    ['attempt', 'douban_ref', 'due_at', 'entered_at', 'last_error', 'list', 'media_type', 'poster_path', 'poster_url', 'rating', 'state', 'title', 'tmdb_ref', 'url', 'year'].sort(),
  )
  const doc = newStateDoc()
  assert.equal(doc.queue.items, null)
})
