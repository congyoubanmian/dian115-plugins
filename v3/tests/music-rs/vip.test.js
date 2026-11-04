// 会员档位与歌曲付费标识的解析测试。
// 样本结构来自 vip/info 的真实响应（SVIP 7：redplus/associator/musicPackage 同时生效）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseNeteaseVip, vipLabel, vipExpireTitle, parseQqVip } from '../../music-rs/lib/vip.js'
import { songVipTag } from '../../music-rs/lib/vip-tag.js'

const NOW = Date.now()
const FUTURE = NOW + 365 * 86400_000

function sample() {
  return {
    code: 200,
    data: {
      redVipLevel: 7,
      redplus: { vipCode: 300, expireTime: FUTURE, vipLevel: 7, iconUrl: 'https://p5.music.126.net/svip.png' },
      associator: { vipCode: 100, expireTime: FUTURE, vipLevel: 7, iconUrl: 'https://p6.music.126.net/vip.png' },
      musicPackage: { vipCode: 220, expireTime: FUTURE, vipLevel: 7 },
      familyVip: { vipCode: 600, expireTime: 0 },
    },
  }
}

test('vip/info：redplus 生效 → SVIP，带等级/图标/到期与次级标签', () => {
  const info = parseNeteaseVip(sample(), NOW)
  assert.equal(info.tier, 'svip')
  assert.equal(info.level, 7)
  assert.equal(info.expire_ms, FUTURE)
  assert.equal(info.icon, 'https://p5.music.126.net/svip.png')
  assert.deepEqual(info.secondary, ['黑胶 VIP', '音乐包'])
  assert.equal(vipLabel(info), 'SVIP 7')
  assert.match(vipExpireTitle(info), /有效期至/)
})

test('vip/info：SVIP 到期、黑胶生效 → 黑胶 VIP', () => {
  const body = sample()
  body.data.redplus.expireTime = NOW - 1000
  body.data.musicPackage.expireTime = 0
  const info = parseNeteaseVip(body, NOW)
  assert.equal(info.tier, 'vip')
  assert.equal(vipLabel(info), '黑胶 VIP 7')
  assert.deepEqual(info.secondary, [])
})

test('vip/info：全部失效 → 免费；无 data → 免费', () => {
  const body = sample()
  for (const key of ['redplus', 'associator', 'musicPackage']) body.data[key].expireTime = 0
  assert.equal(vipLabel(parseNeteaseVip(body, NOW)), '免费')
  assert.equal(vipLabel(parseNeteaseVip({}, NOW)), '免费')
})

test('QQ：svip/svip_level 字段 → SVIP 等级；识别不到 → unknown', () => {
  const svip = parseQqVip({ req_1: { data: { svip: 1, svip_level: 7 } } })
  assert.equal(svip.tier, 'svip')
  assert.equal(svip.level, 7)
  assert.equal(vipLabel(svip), 'SVIP 7')
  assert.equal(parseQqVip({ req_1: { data: {} } }).tier, 'unknown')
  assert.equal(vipLabel(parseQqVip({})), '已登录')
})

test('QQ 到期时间支持秒与毫秒', () => {
  const sec = parseQqVip({ data: { vip: 1, vip_end_time: Math.floor(FUTURE / 1000) } })
  assert.equal(sec.expire_ms, FUTURE - (FUTURE % 1000))
  const ms = parseQqVip({ data: { vip: 1, vip_end_time: FUTURE } })
  assert.equal(ms.expire_ms, FUTURE)
})

test('歌曲标签：网易 fee 与 SVIP 档音质', () => {
  assert.equal(songVipTag({ fee: 1, maxLevel: 'lossless' }), 'vip')
  assert.equal(songVipTag({ fee: 1, maxLevel: 'jymaster' }), 'svip')
  assert.equal(songVipTag({ fee: 4 }), 'paid')
  assert.equal(songVipTag({ fee: 0 }), '')
})

test('歌曲标签：QQ pay 字段', () => {
  assert.equal(songVipTag({ pay: { pay_play: 1 } }), 'vip')
  assert.equal(songVipTag({ pay: { svip_down: 1 } }), 'svip')
  assert.equal(songVipTag({ pay: { price_onsale: 1, pay_play: 1 } }), 'paid')
  assert.equal(songVipTag({ pay: {} }), '')
})
