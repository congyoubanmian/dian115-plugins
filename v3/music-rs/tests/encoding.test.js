// 编码原语向量测试 —— 向量来自 plugins/music-rs/tests/{netease,qq}.rs（不是从本实现反推）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  queryEscape, queryUnescape, queryEncode, formEncode, pathEscape, parseQuery,
  hash33, base36, shortId, allocateId, ipHeaders, trunc, truncateChars,
} from '../lib/encoding.js'
import { requestId } from '../lib/eapi.js'

test('queryEscape matches Go url.QueryEscape', () => {
  assert.equal(queryEscape(''), '')
  assert.equal(queryEscape('a b'), 'a+b')
  assert.equal(queryEscape('~-_.*+'), '~-_.%2A%2B')
  assert.equal(queryEscape('a&b=c'), 'a%26b%3Dc')
  assert.equal(queryEscape('晴天'), '%E6%99%B4%E5%A4%A9')
  assert.equal(queryEscape('周杰伦'), '%E5%91%A8%E6%9D%B0%E4%BC%A6')
  // Go 只放行 alnum 与 -_.~，其余（含 !*'()）按字节大写十六进制
  assert.equal(queryEscape('~-_.!*\'()'), '~-_.%21%2A%27%28%29')
})

test('queryUnescape mirrors QueryEscape', () => {
  assert.equal(queryUnescape('a+b'), 'a b')
  assert.equal(queryUnescape('%E6%99%B4%E5%A4%A9'), '晴天')
  assert.equal(queryUnescape('%2'), null, '非法转义')
  assert.equal(queryUnescape('%FF'), null, '非 UTF-8 字节')
})

test('queryEncode sorts keys bytewise', () => {
  assert.equal(queryEncode([['b', '2'], ['a', '1'], ['_', '0']]), '_=0&a=1&b=2')
  assert.equal(queryEncode([['k', '']]), 'k=')
  assert.equal(queryEncode([]), '')
  assert.equal(formEncode([['key', 'a b~c*d+e/f?g=h'], ['type', '3']]), 'key=a+b~c%2Ad%2Be%2Ff%3Fg%3Dh&type=3')
  assert.equal(
    formEncode([['s', '晴天 & 周杰伦'], ['type', '1'], ['limit', '30'], ['offset', '30']]),
    'limit=30&offset=30&s=%E6%99%B4%E5%A4%A9+%26+%E5%91%A8%E6%9D%B0%E4%BC%A6&type=1',
  )
})

test('pathEscape keeps Go url.PathEscape set', () => {
  // RFC 3986 §3.3：`;` `/` `,` `?` 留给段语义 → 转义；`$&+=:@` 与 unreserved 原样。
  assert.equal(pathEscape('abc-_.~$&+:;=@'), 'abc-_.~$&+:%3B=@')
  assert.equal(pathEscape('a/b?c'), 'a%2Fb%3Fc')
})

test('parseQuery keeps first value and skips broken segments', () => {
  const values = parseQuery('a=1&a=2&b=%2&c=1;2&d')
  assert.equal(values.get('a'), '1')
  assert.equal(values.has('b'), false, '转义失败跳过')
  assert.equal(values.has('c'), false, '含分号跳过')
  assert.equal(values.get('d'), '')
})

test('hash33 matches Go qqHash33 vectors', () => {
  assert.equal(hash33(''), 0)
  assert.equal(hash33('a'), 97)
  assert.equal(hash33('abc'), 108966)
  assert.equal(hash33('~'), 126)
  assert.equal(hash33('测试'), 959104)
  assert.equal(hash33('0123456789abcdef0123456789abcdef'), 935578372)
  assert.equal(hash33('qrsig_value_1234567890abc'), 1174617108)
  assert.equal(hash33('@abcd#1234'), 1201473783)
  assert.equal(hash33('AbCdEf123456'), 1510816170)
  assert.equal(hash33('a'.repeat(100)), 76785828)
})

test('shortId is base36 within 8 chars and allocateId avoids collisions', () => {
  const taken = [shortId('seed'), shortId('seed#1')]
  const id = allocateId(taken, 'seed')
  assert.ok(id.length <= 8, `id 超长: ${id}`)
  assert.ok(/^[0-9a-z]+$/.test(id))
  assert.notEqual(id, taken[0])
  assert.notEqual(id, taken[1])
  assert.ok(`retry:${id}`.length <= 32, 'callback_data 限 32 字节')
  assert.equal(base36(0), '0')
  assert.equal(base36(35), 'z')
  assert.equal(base36(36), '10')
})

test('ipHeaders follow sidecar CN prefixes and ranges', () => {
  const CN_PREFIXES = [[116, 255], [116, 228], [218, 192], [124, 0], [14, 132], [183, 14], [58, 14], [113, 116], [120, 230]]
  const seen = new Set()
  let seed = 42
  const rng = () => {
    seed = (seed * 1103515245 + 12345) % 0x7fffffff
    return seed / 0x7fffffff
  }
  for (let i = 0; i < 5; i++) {
    const headers = ipHeaders(rng)
    assert.deepEqual(Object.keys(headers).sort(), ['x-forwarded-for', 'x-real-ip'])
    assert.equal(headers['x-real-ip'], headers['x-forwarded-for'])
    const octets = headers['x-real-ip'].split('.').map(Number)
    assert.equal(octets.length, 4)
    assert.ok(CN_PREFIXES.some(([a, b]) => a === octets[0] && b === octets[1]), `前缀必须来自 sidecar 的表: ${headers['x-real-ip']}`)
    assert.ok(octets[2] >= 1 && octets[2] <= 254)
    assert.ok(octets[3] >= 1 && octets[3] <= 254)
    seen.add(headers['x-real-ip'])
  }
  assert.ok(seen.size > 0)
})

test('requestId keeps last eight digits of nanos', () => {
  assert.equal(requestId(0), 0)
  assert.equal(requestId(99_999_999), 99_999_999)
  assert.equal(requestId(100_000_001), 1)
  assert.equal(requestId(1_790_676_009_123_456_789n), 23_456_789)
})

test('trunc cuts by bytes with marker', () => {
  assert.equal(trunc('short', 200), 'short')
  const long = '晴'.repeat(200) // 600 bytes
  const out = trunc(long, 200)
  assert.ok(Buffer.byteLength(out) <= 200 + 3, `截断后 ${Buffer.byteLength(out)} 字节`)
  assert.ok(out.endsWith('...(truncated)'))
  assert.ok(out.startsWith('晴'))
})

test('truncateChars cuts by code points', () => {
  assert.equal(truncateChars('abcdef', 3), 'abc')
  assert.equal(truncateChars('晴天', 10), '晴天')
})
