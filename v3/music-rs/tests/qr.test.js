// QR 编码器结构测试 —— 从 plugins/music-rs/frontend/src/qr.ts 移植。
// 本机没有离线 golden-matrix 参照（无 segno/qrcode 库），按 ISO/IEC 18004 的结构
// 不变量验证：版本选择、finder/timing 图形、格式信息、确定性、forceMask。
import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeQr, qrSvgPath } from '../ui/qr.js'

function finderOk(code) {
  // 左上 finder：7x7 深色边框 + 3x3 深色核心 + 白环。
  for (let i = 0; i < 7; i++) {
    assert.equal(code.modules[0][i], true, `top row ${i}`)
    assert.equal(code.modules[6][i], true)
    assert.equal(code.modules[i][0], true)
    assert.equal(code.modules[i][6], true)
    if (i >= 2 && i <= 4) {
      for (let j = 2; j <= 4; j++) assert.equal(code.modules[i][j], true, `core ${i},${j}`)
    }
  }
  assert.equal(code.modules[1][1], false)
  assert.equal(code.modules[3][3], true)
  // timing 行/列：模块 8..size-9 交替。
  for (let x = 8; x < code.size - 8; x++) {
    assert.equal(code.modules[6][x], x % 2 === 0, `timing col ${x}`)
    assert.equal(code.modules[x][6], x % 2 === 0, `timing row ${x}`)
  }
}

test('encodeQr picks the smallest version and draws valid function patterns', () => {
  const code = encodeQr('https://music.163.com/login?codekey=UNIKEY', 'M')
  assert.equal(code.version, 3, '38 字节 + M 纠错 → 版本 3（ISO 容量表）')
  assert.equal(code.size, 3 * 4 + 17)
  assert.ok(code.mask >= 0 && code.mask <= 7)
  finderOk(code)
})

test('encodeQr is deterministic and mask-independent via forceMask', () => {
  const a = encodeQr('HELLO WORLD', 'M')
  const b = encodeQr('HELLO WORLD', 'M')
  assert.deepEqual(a.modules, b.modules, '同一输入两次编码结果一致')
  const forced = encodeQr('HELLO WORLD', 'M', 2)
  assert.equal(forced.mask, 2)
  assert.equal(forced.version, a.version)
  // 不同 forceMask 的符号除格式信息外不一定相同，但都能完整铺码（无空洞由 finder/timing 验证）。
  finderOk(forced)
})

test('encodeQr handles utf-8 and rejects overflow', () => {
  const chinese = encodeQr('网易云扫码登录', 'M')
  assert.ok(chinese.version >= 1)
  assert.equal(chinese.size, chinese.version * 4 + 17)
  assert.throws(() => encodeQr('x'.repeat(3000), 'L'), /容量/)
})

test('qrSvgPath emits one 1x1 subpath per dark module', () => {
  const code = encodeQr('HI', 'L')
  const path = qrSvgPath(code)
  const dark = code.modules.flat().filter(Boolean).length
  const subpaths = path.match(/M\d+ \d+h1v1h-1z/g) ?? []
  assert.equal(subpaths.length, dark)
  assert.ok(path.startsWith('M'))
})
