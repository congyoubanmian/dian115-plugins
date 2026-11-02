// 松散取数与脱敏测试 —— 对照 plugins/chase-rs/src/raw.rs。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  arrayAt,
  containsForbiddenKey,
  decodeJson,
  descend,
  firstBool,
  firstI64,
  firstOf,
  firstString,
  isForbiddenKey,
  looseI64,
  looseString,
  looseU64,
  sampleText,
  sanitize,
  truncateUtf8,
} from '../../chase-rs/lib/loose.js'

test('looseU64：数字/数字串/布尔，负数与小数不认', () => {
  assert.equal(looseU64(13), 13)
  assert.equal(looseU64('13'), 13)
  assert.equal(looseU64('0013'), 13)
  assert.equal(looseU64(true), 1)
  assert.equal(looseU64(false), 0)
  assert.equal(looseU64(-3), null)
  assert.equal(looseU64(1.5), null)
  assert.equal(looseU64('1.5'), null)
  assert.equal(looseU64(''), null)
  assert.equal(looseU64('nope'), null)
  assert.equal(looseU64(null), null)
  assert.equal(looseU64({}), null)
})

test('looseI64：允许负号；非整数字符串不认', () => {
  assert.equal(looseI64(-1), -1)
  assert.equal(looseI64('-1'), -1)
  assert.equal(looseI64('+3'), 3)
  assert.equal(looseI64(0), 0)
  assert.equal(looseI64('3.5'), null)
  assert.equal(looseI64(''), null)
  assert.equal(looseI64('nope'), null)
  assert.equal(looseI64(null), null)
})

test('looseString：字符串原样，数字/布尔转文本，其余不认', () => {
  assert.equal(looseString('x'), 'x')
  assert.equal(looseString(13), '13')
  assert.equal(looseString(true), 'true')
  assert.equal(looseString(null), null)
  assert.equal(looseString({}), null)
})

test('firstOf / firstI64 / firstString / firstBool 的候选顺序与 null 语义', () => {
  const obj = { a: null, b: 0, c: 'x' }
  assert.equal(firstOf(obj, ['missing', 'a', 'b']), 0, 'null 视为缺失继续找')
  assert.equal(firstI64(obj, ['a', 'b']), 0, '0 是合法值')
  assert.equal(firstI64(obj, ['a']), null)
  assert.equal(firstString(obj, ['c', 'b']), 'x')
  assert.equal(firstString(obj, ['a']), null)
  assert.equal(firstBool({ flag: true, other: true }, ['missing', 'flag']), true)
  assert.equal(firstBool({ flag: false }, ['flag']), false)
})

test('descend / arrayAt', () => {
  assert.deepEqual(descend({ data: { deep: 1 } }, ['missing', 'data']), { deep: 1 })
  assert.equal(descend({ data: { deep: 1 } }, ['missing']), null)
  // arrayAt 只在"同一层的候选键命中的是数组"时才认（与 raw.rs array_at 同语义）；
  // data 信封要先 descend 一层再 arrayAt（parse_instances 的两步走）。
  const value = { data: { items: [1, 2] } }
  assert.equal(arrayAt(value, ['items']), null)
  assert.deepEqual(arrayAt(value.data, ['items']), [1, 2])
  assert.deepEqual(arrayAt({ items: [5] }, ['items']), [5])
  assert.deepEqual(arrayAt([3], ['items']), [3], '本身是数组直接返回')
  assert.equal(arrayAt({ a: 1 }, ['a']), null)
  assert.equal(descend([1], ['a']), null)
})

test('decodeJson：字符串解析、对象透传、空与非法报错', () => {
  assert.deepEqual(decodeJson('{"a":1}'), { a: 1 })
  assert.deepEqual(decodeJson({ a: 1 }), { a: 1 })
  assert.throws(() => decodeJson(''), Error)
  assert.throws(() => decodeJson('nope'), Error)
  assert.throws(() => decodeJson(null), Error)
})

test('凭据键模式的判定与递归脱敏', () => {
  for (const key of ['api_key', 'apiKey', 'API-KEY', 'token', 'secret', 'password', 'cookie', 'authorization']) {
    assert.equal(isForbiddenKey(key), true, key)
  }
  assert.equal(isForbiddenKey('key_ready'), false)
  assert.equal(isForbiddenKey('emby_proxy_id'), false)

  const value = { ok: 1, api_key: 'leak', nested: { token: 'x', deeper: [{ secret: 'y' }] } }
  assert.equal(containsForbiddenKey(value), 'api_key')
  sanitize(value)
  assert.equal(containsForbiddenKey(value), null)
  assert.deepEqual(value, { ok: 1, nested: { deeper: [{}] } })
})

test('sampleText：JSON 脱敏后序列化，非 JSON 原样截断', () => {
  const sample = sampleText({ api_key: 'leak', items: [{ index_number: 1 }] }, 2048)
  assert.ok(!sample.includes('leak'))
  assert.ok(sample.includes('index_number'))
  const raw = sampleText('<html>502</html>', 2048)
  assert.equal(raw, '<html>502</html>')
  assert.equal(sampleText('x'.repeat(3000), 2048).length <= 2048, true)
})
