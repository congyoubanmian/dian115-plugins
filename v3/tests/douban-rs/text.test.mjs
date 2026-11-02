// 文本工具测试 —— 向量来自 plugins/douban-rs/src/{util.rs,charts.rs,subscribe.rs} 内嵌测试。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  trunc, goLossy, stringVal, normalizeTitle, safeKey, queryEscape, pathEscape,
  parseWant, sourceCost, sectionAfter, goQuote, collapseSpace, truncateUtf8Boundary,
} from '../../douban-rs/lib/text.js'

test('trunc 按 200 字节截断', () => {
  assert.equal(trunc(new TextEncoder().encode('abc')), 'abc')
  const long = new Uint8Array(400).fill(0x78)
  assert.equal(trunc(long).length, 200)
  assert.equal(trunc(new Uint8Array(0)), '')
})

test('goLossy 逐字节替换 U+FFFD（Go 语义）', () => {
  assert.equal(goLossy(new TextEncoder().encode('你好')), '你好')
  assert.equal(goLossy(new Uint8Array([0x61, 0xff, 0x62])), 'a\uFFFD b'.replace(' ', ''), '单坏字节')
  // "你" = E4 BD A0，砍掉最后一字节 → 两个 U+FFFD（Go 逐字节口径）
  assert.equal(goLossy(new Uint8Array([0xe4, 0xbd])), '\uFFFD\uFFFD')
  assert.equal(goLossy(new Uint8Array([0xe4, 0xbd, 0xa0, 0x41])), '你A')
  // E4 BD 41：非法序列只消费 1 字节 → FFFD(E4) FFFD(BD) A
  assert.equal(goLossy(new Uint8Array([0xe4, 0xbd, 0x41])), '\uFFFD\uFFFDA')
  assert.equal(goLossy(new Uint8Array(0)), '')
})

test('stringVal 与 Go stringVal 一致（标量按字面）', () => {
  assert.equal(stringVal(undefined), '')
  assert.equal(stringVal(null), '')
  assert.equal(stringVal('海报'), '海报')
  assert.equal(stringVal(true), 'true')
  assert.equal(stringVal(false), 'false')
  assert.equal(stringVal(3), '3')
  assert.equal(stringVal(''), '')
  assert.equal(stringVal({ a: 1 }), '{"a":1}')
})

test('normalizeTitle 折算全角标点', () => {
  assert.equal(normalizeTitle('  奥德赛 (2026)  '), '奥德赛 (2026)')
  assert.equal(normalizeTitle('奥德赛（2026）'), '奥德赛(2026)')
  assert.equal(normalizeTitle('人生路不熟·测试'), '人生路不熟 测试')
  assert.equal(normalizeTitle('A：B，C。D！E？'), 'a:b,cde')
  assert.equal(normalizeTitle('Oppenheimer'), 'oppenheimer')
  assert.equal(normalizeTitle('片名·'), '片名 ')
  assert.equal(normalizeTitle(''), '')
})

test('safeKey 过滤并兜底 unknown', () => {
  assert.equal(safeKey('inv_1'), 'inv_1')
  assert.equal(safeKey('inv 1!x'), 'inv1x')
  assert.equal(safeKey('a-b_c.d'), 'a-b_cd')
  assert.equal(safeKey(''), 'unknown')
  assert.equal(safeKey('中文'), 'unknown')
})

test('queryEscape 与 Go url.QueryEscape 一致', () => {
  assert.equal(queryEscape('热门'), '%E7%83%AD%E9%97%A8')
  assert.equal(queryEscape('国产剧'), '%E5%9B%BD%E4%BA%A7%E5%89%A7')
  assert.equal(queryEscape('movie'), 'movie')
  assert.equal(queryEscape('a b'), 'a+b')
  assert.equal(queryEscape('-_.~'), '-_.~')
  assert.equal(queryEscape('a/b&c=d'), 'a%2Fb%26c%3Dd')
  assert.equal(queryEscape(''), '')
})

test('pathEscape 与 Go url.PathEscape 一致（encodePathSegment）', () => {
  assert.equal(pathEscape('cc test/中文'), 'cc%20test%2F%E4%B8%AD%E6%96%87')
  assert.equal(pathEscape('a$b&c+d:e=f@g'), 'a$b&c+d:e=f@g')
  assert.equal(pathEscape('a;b,c?d'), 'a%3Bb%2Cc%3Fd')
})

test('parseWant 对拍 Go reWant 捕获组', () => {
  assert.equal(parseWant('<span class="">15177人想看</span>'), 15177)
  assert.equal(parseWant('1,234 人想看'), 1234)
  assert.equal(parseWant('已有 12,345 人 想看'), 12345)
  assert.equal(parseWant('12,345,678人想看'), 12345678)
  assert.equal(parseWant('人想看'), 0)
  assert.equal(parseWant(''), 0)
  assert.equal(parseWant('123人想 看'), 0)
  assert.equal(parseWant('7 10人想看'), 10)
  assert.equal(parseWant('3000000000人想看'), 3_000_000_000)
})

test('sourceCost 与 Go switch 一致', () => {
  assert.equal(sourceCost('subjects_json'), 1)
  assert.equal(sourceCost('chart_html'), 2)
  assert.equal(sourceCost('coming_html'), 3)
  assert.equal(sourceCost(''), 4)
  assert.equal(sourceCost('unknown'), 4)
})

test('sectionAfter 语义逐条（charts.rs section_after）', () => {
  const html = 'AAA id="x" bbb OPEN ccc CLOSE ddd'
  assert.equal(sectionAfter(html, 'id="y"', '', ''), html)
  assert.equal(sectionAfter(html, 'id="x"', '', ''), 'id="x" bbb OPEN ccc CLOSE ddd')
  assert.equal(sectionAfter(html, 'id="x"', 'OPEN', ''), 'OPEN ccc CLOSE ddd')
  assert.equal(sectionAfter(html, 'id="x"', 'NOPE', ''), 'id="x" bbb OPEN ccc CLOSE ddd')
  assert.equal(sectionAfter(html, 'id="x"', '', 'CLOSE'), 'id="x" bbb OPEN ccc ')
  assert.equal(sectionAfter(html, 'id="x"', 'NOPE', 'NOPE'), 'id="x" bbb OPEN ccc CLOSE ddd')
  assert.equal(sectionAfter(html, 'ddd', 'OPEN', 'CLOSE'), 'ddd')
  assert.equal(sectionAfter(html, 'CLOSE', '', 'CLOSE'), '')
  assert.equal(sectionAfter(html, '', '', ''), html)
})

test('goQuote 处理引号/反斜杠/控制字符', () => {
  assert.equal(goQuote('rss_xml'), '"rss_xml"')
  assert.equal(goQuote('a"b'), '"a\\"b"')
  assert.equal(goQuote('a\\b'), '"a\\\\b"')
  assert.equal(goQuote('a\nb'), '"a\\nb"')
})

test('collapseSpace 压连续空白（Go \s ASCII 类）', () => {
  assert.equal(collapseSpace('神探 之\t痕迹'), '神探 之 痕迹')
  assert.equal(collapseSpace('  罗斯 '), ' 罗斯 ')
})

test('truncateUtf8Boundary 按字节截断并追加省略号', () => {
  const text = '汉'.repeat(300)
  const out = truncateUtf8Boundary(text, 400)
  const bytes = new TextEncoder().encode(out)
  assert.ok(bytes.length <= 400 + new TextEncoder().encode('…(截断)').length)
  assert.ok(out.endsWith('…(截断)'))
  assert.ok(out.startsWith('汉'))
  assert.equal(truncateUtf8Boundary('short', 400), 'short')
})
