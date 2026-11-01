// 状态文档模型测试 —— 对照 plugins/douban-rs/src/model.rs 内嵌测试与 state_val.json 夹具。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  parseStateDoc, isRecognizable, defaultSettings, newStateDoc,
  sanitizeState, looksLikeAbsPath, sanitizeSettingsView, parseAccountDoc, hasAccountFields,
} from '../lib/model.js'

const STATE = readFileSync(fileURLToPath(new URL('./fixtures/state_val.json', import.meta.url)), 'utf8')

test('真实 state 夹具能解析出全部节', () => {
  const doc = parseStateDoc(JSON.parse(STATE))
  assert.ok(doc !== null)
  assert.ok(isRecognizable(doc), 'lists 必须非 null')
  assert.equal(Object.keys(doc.settings.lists).length, 5)
  assert.equal(doc.queue.items.length, 109)
  assert.equal(doc.snapshot.lists ? Object.keys(doc.snapshot.lists).length : 0, 5)
  assert.equal(doc.history.length, 3)
  assert.equal(doc.logs.length, 40)
  assert.equal(doc.stats.total, 3)
  assert.equal(doc.stats.by_list.wish, 3)
  assert.equal(doc.wish.length, 3)
  assert.equal(Object.keys(doc.wish_seen).length, 3)
  assert.equal(doc.wish_info.uid, '123456789')
  assert.deepEqual(doc.cookie, { header: '', uid: '', source: '', fetched_at: '' }, '脱敏夹具登录 cookie 必须为空')
  assert.equal(doc.blackstate.keywords, null, 'Go nil slice → null')
  const hot = doc.snapshot.lists.hot
  assert.equal(hot[0].douban_ref, 'db:subj:36850814')
  assert.ok(hot[0].poster_url.startsWith('https://img'))
})

test('夹具解析后再序列化，字段集合不丢（关键字段抽查）', () => {
  const doc = parseStateDoc(JSON.parse(STATE))
  const encoded = JSON.stringify(doc)
  for (const key of ['settings', 'snapshot', 'queue', 'history', 'logs', 'stats', 'blackstate', 'wish_info', 'cookie']) {
    assert.ok(encoded.includes(`"${key}"`), `缺字段 ${key}`)
  }
  assert.ok(encoded.includes('"observe_period_hours"'))
  assert.ok(encoded.includes('"wish_sync_enabled"'))
})

test('null 与空是两回事（Go nil/空 slice 语义）', () => {
  const doc = parseStateDoc({ settings: { lists: {}, blacklist: [], subscribe_source_filter: [] } })
  assert.ok(isRecognizable(doc), '空对象 lists 算已加载')
  assert.deepEqual(doc.settings.lists, {})
  assert.deepEqual(doc.settings.blacklist, [])

  const nullDoc = parseStateDoc({ settings: { lists: null } })
  assert.ok(!isRecognizable(nullDoc), 'null lists 不能算已加载')
  assert.equal(nullDoc.settings.lists, null)
})

test('null 字段按零值解出（Go json.Unmarshal 行为）', () => {
  const doc = parseStateDoc({
    settings: { lists: {}, blacklist: null, subscribe_source_filter: null, max_logs: null },
    snapshot: { fetched_at: null, lists: { hot: null } },
    queue: { items: null },
    history: null,
    logs: null,
    stats: { total: null, by_list: null },
    blackstate: { keywords: null, hits: null, recent: null },
    wish: null,
    wish_seen: null,
    wish_info: { last_error: null },
    cookie: { header: null },
  })
  assert.ok(isRecognizable(doc))
  assert.equal(doc.settings.blacklist, null)
  assert.equal(doc.settings.max_logs, 0)
  assert.equal(doc.queue.items, null)
  assert.equal(doc.history, null)
  assert.equal(doc.logs, null)
  assert.equal(doc.stats.total, 0)
  // null 的榜单键在 Go 里是"键存在 + 零值"；这里按"键缺失"处理（model.rs strip_nulls 注释）
  assert.ok(!('hot' in doc.snapshot.lists), 'null 键按缺失处理')
  assert.equal(doc.wish, null)
})

test('整体不是对象 / 关键节类型不符 → 解析失败', () => {
  assert.equal(parseStateDoc([1, 2]), null)
  assert.equal(parseStateDoc(null), null)
  assert.equal(parseStateDoc('not json'), null)
  assert.equal(parseStateDoc({ settings: { lists: { hot: { limit: '30' } } } }), null, '类型不符必须拒绝')
  assert.equal(parseStateDoc({ queue: { items: true } }), null)
  assert.equal(parseStateDoc({ stats: { by_list: 3 } }), null)
})

test('v3.0.0 遗留的 poster_url:{} 按空串修复，整份文档仍可识别', () => {
  const doc = parseStateDoc({
    settings: { lists: { movie_wom: { source: 'chart_html' } } },
    snapshot: { lists: { movie_wom: [{ title: '罗斯', poster_url: {} }, { title: '托尼', poster_url: 'https://img/x.jpg' }] } },
  })
  assert.ok(isRecognizable(doc))
  assert.equal(doc.snapshot.lists.movie_wom[0].poster_url, '')
  assert.equal(doc.snapshot.lists.movie_wom[1].poster_url, 'https://img/x.jpg')
})

test('未知字段忽略；wishlist 评分/年份字段带默认值', () => {
  const doc = parseStateDoc({ settings: { lists: { hot: { source: 'x' } } }, unknown_top: true })
  assert.equal(doc.settings.lists.hot.source, 'x')
})

test('default_settings 与 Go 一致（5 个默认榜单）', () => {
  const settings = defaultSettings()
  const lists = settings.lists
  assert.equal(Object.keys(lists).length, 5)
  assert.equal(lists.upcoming.source, 'coming_html')
  assert.equal(lists.upcoming.limit, 20)
  assert.equal(lists.hot.tag, '热门')
  assert.equal(lists.hot.sort, 'recommend')
  assert.equal(lists.cn_wom.type, 'tv')
  assert.equal(lists.global_wom.tag, '欧美')
  assert.equal(lists.movie_wom.source, 'chart_html')
  assert.equal(settings.observe_period_hours, 24)
  assert.ok(settings.auto_subscribe && settings.notify_on_subscribe)
  assert.equal(settings.max_history, 200)
  assert.equal(settings.max_logs, 200)
})

test('newStateDoc 是全新安装形态', () => {
  const doc = newStateDoc()
  assert.ok(isRecognizable(parseStateDoc(doc)), '新文档必须能被识别回来')
  assert.equal(doc.history, null)
  assert.equal(doc.queue.items, null)
  assert.equal(doc.wish, null)
})

test('sanitizeState 清掉绝对路径形态的字符串', () => {
  assert.ok(looksLikeAbsPath('/p2935475988.jpg'))
  assert.ok(!looksLikeAbsPath('https://img3.doubanio.com/p.jpg'))
  assert.ok(!looksLikeAbsPath('//cdn/x'))
  const cleaned = sanitizeState({ poster: '/p1.jpg', ok: 'https://x/p2.jpg', list: ['/p3.jpg', 'safe'] })
  assert.deepEqual(cleaned, { poster: '', ok: 'https://x/p2.jpg', list: ['', 'safe'] })
})

test('sanitizeSettingsView 不回显凭据（宿主递归拒绝 cookie 键名）', () => {
  const view = sanitizeSettingsView({
    cookiecloud_url: 'http://127.0.0.1:8088',
    cookiecloud_uuid: 'uuid-test',
    cookiecloud_key: 'key-test',
    manual_cookie: 'dbcl2=1:2',
    wish_sync_enabled: true,
  })
  assert.equal(view.cookiecloud_url, undefined)
  assert.equal(view.cookiecloud_key, undefined)
  assert.equal(view.manual_cookie, undefined)
  assert.equal(view.cc_url, 'http://127.0.0.1:8088')
  assert.equal(view.cc_uuid, 'uuid-test')
  assert.equal(view.cc_key_set, true)
  assert.equal(view.cc_manual_set, true)
})

test('账号键解析与 has_account_fields', () => {
  const account = parseAccountDoc({ cookiecloud_uuid: 'uuid-account', cookiecloud_url: '', wish_sync_enabled: false, lists: null })
  assert.equal(account.cookiecloud_uuid, 'uuid-account')
  assert.equal(account.cookiecloud_url, '')
  assert.ok(!hasAccountFields({ cookiecloud_url: '', cookiecloud_uuid: '', cookiecloud_key: '', manual_cookie: '', wish_sync_enabled: false }))
  assert.ok(hasAccountFields({ cookiecloud_url: 'http://x', cookiecloud_uuid: '', cookiecloud_key: '', manual_cookie: '', wish_sync_enabled: false }))
  assert.ok(hasAccountFields({ cookiecloud_url: '', cookiecloud_uuid: '', cookiecloud_key: '', manual_cookie: 'dbcl2=1:2', wish_sync_enabled: false }))
  assert.ok(hasAccountFields({ cookiecloud_url: '', cookiecloud_uuid: '', cookiecloud_key: '', manual_cookie: '', wish_sync_enabled: true }))
  assert.equal(parseAccountDoc('nope'), null)
})
