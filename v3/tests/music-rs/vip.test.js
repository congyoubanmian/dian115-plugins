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

test('QQ vip_login_base：identity.level 与 HugeVip 绿钻标志', () => {
  const svip = parseQqVip({ req_1: { data: { svip: 1, identity: { level: 7 } } } })
  assert.equal(svip.tier, 'svip')
  assert.equal(svip.level, 7)
  const vip = parseQqVip({ req_1: { data: { identity: { HugeVip: 1 }, userinfo: { music_level: 5 } } } })
  assert.equal(vip.tier, 'vip')
  assert.equal(vip.level, 5)
  assert.equal(vipLabel(vip, 'qq'), '绿钻 5')
})

test('QQ vip_login_base：YAQMC 真实样本（req_0 + identity/userinfo.expire）', () => {
  // 样本取自 YAQMC entitlement.rs 的 VIP_OK 夹具。
  const green = parseQqVip({
    code: 0,
    req_0: { code: 0, data: { svip: 0, star: 0, ystar: 0, identity: { vip: 1, HugeVip: 0, yearflag: 1, GroupVipFlag: 1 }, userinfo: { expire: 4102444800 } } },
  })
  assert.equal(green.tier, 'vip')
  assert.equal(vipLabel(green, 'qq'), '绿钻')
  assert.equal(green.expire_ms, 4102444800000)
  const svip = parseQqVip({ req_0: { data: { svip: 1, identity: { level: 7 }, userinfo: { expire: 4102444800 } } } })
  assert.equal(svip.tier, 'svip')
  assert.equal(vipLabel(svip, 'qq'), 'SVIP 7')
})

test('QQ 到期时间支持秒与毫秒', () => {  const sec = parseQqVip({ data: { vip: 1, vip_end_time: Math.floor(FUTURE / 1000) } })
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
