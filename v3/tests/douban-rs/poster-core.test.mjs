// 海报核心测试 —— 向量来自 plugins/douban-rs/src/poster.rs 内嵌测试。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  sniffImage, mirrorCandidates, withMirrorHost, downscaleUrl, POSTER_CACHE_LIMIT, MAX_POSTER_BYTES,
  POSTER_DIR, posterExtOf, posterPathOf,
} from '../../douban-rs/lib/poster-core.js'

test('sniff_image 对拍 Go sniffImage 的四个分支', () => {
  assert.equal(sniffImage(new Uint8Array(0)), '')
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8])), '', '长度不足 3')
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff])), 'image/jpeg')
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), 'image/jpeg')
  // Go 只看 data[1..4]，不校验 0x89
  assert.equal(sniffImage(new TextEncoder().encode('\x00PNG\r\n')), 'image/png')
  // 0x89 不是合法 ASCII，必须直接给字节（TextEncoder 会把 U+0089 编成两个字节）
  assert.equal(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png')
  assert.equal(sniffImage(new TextEncoder().encode('PNG')), '')
  assert.equal(sniffImage(new TextEncoder().encode('GIF89a')), 'image/gif')
  assert.equal(sniffImage(new TextEncoder().encode('GIF')), 'image/gif')
  assert.equal(sniffImage(new TextEncoder().encode('RIFF????WEBPVP8 ')), 'image/webp')
  assert.equal(sniffImage(new TextEncoder().encode('RIFF????WEB')), '', '长度不足 12')
  assert.equal(sniffImage(new TextEncoder().encode('RIFF????WEBx')), '')
  assert.equal(sniffImage(new TextEncoder().encode('WEBP????RIFF')), '')
  assert.equal(sniffImage(new TextEncoder().encode("<html>418 I'm a teapot</html>")), '')
  // jpeg 分支优先
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0x50, 0x4e, 0x47])), 'image/jpeg')
})

test('镜像域名候选顺序：原域名 → img3 → img1 → img2 → img4..img9（去重）', () => {
  assert.deepEqual(
    mirrorCandidates('https://img9.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg'),
    ['', 'img3', 'img1', 'img2', 'img4', 'img5', 'img6', 'img7', 'img8'],
  )
  // 已出现的 img3 不重复
  assert.deepEqual(
    mirrorCandidates('https://img3.doubanio.com/x.jpg')[1],
    'img1',
  )
  // 非 doubanio 镜像域 → 只有原地址
  assert.deepEqual(mirrorCandidates('https://img.doubanio.com/x.jpg'), [''])
  assert.deepEqual(mirrorCandidates('ftp://img3.doubanio.com/x.jpg'), [''], '非 http(s) 不匹配')
  assert.deepEqual(mirrorCandidates(''), [''])
})

test('withMirrorHost / downscaleUrl', () => {
  assert.equal(
    withMirrorHost('https://img9.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg', 'img3'),
    'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg',
  )
  assert.equal(
    downscaleUrl('https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2.jpg'),
    'https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2.jpg',
  )
  assert.equal(downscaleUrl('https://img3.doubanio.com/view/photo/l_ratio_poster/p.jpg'), 'https://img3.doubanio.com/view/photo/l_ratio_poster/p.jpg')
})

test('预算常量与旧实现一致', () => {
  assert.equal(POSTER_CACHE_LIMIT, 64)
  assert.equal(MAX_POSTER_BYTES, 128 << 10)
})

test('posterExtOf：sniffImage 的 mime 映射到文件扩展名', () => {
  assert.equal(posterExtOf('image/jpeg'), 'jpg')
  assert.equal(posterExtOf('image/png'), 'png')
  assert.equal(posterExtOf('image/gif'), 'gif')
  assert.equal(posterExtOf('image/webp'), 'webp')
  assert.equal(posterExtOf(''), '')
  assert.equal(posterExtOf('text/html'), '')
})

test('posterPathOf：posters/<sha256(poster_url) hex>.<ext>；缺哈希或缺扩展名返回空串', () => {
  const hash = 'a'.repeat(64)
  assert.equal(posterPathOf('https://img1.doubanio.com/p.jpg', 'image/jpeg', hash), `posters/${hash}.jpg`)
  assert.equal(posterPathOf('https://img1.doubanio.com/p.png', 'image/png', hash), `posters/${hash}.png`)
  assert.equal(posterPathOf('https://img1.doubanio.com/p', 'image/webp', hash), `posters/${hash}.webp`)
  assert.equal(posterPathOf('x', 'image/jpeg', ''), '', '没有哈希不落路径')
  assert.equal(posterPathOf('x', 'text/html', hash), '', '未知 mime 不落路径')
  assert.ok(posterPathOf('x', 'image/jpeg', hash).startsWith(`${POSTER_DIR}/`))
})
