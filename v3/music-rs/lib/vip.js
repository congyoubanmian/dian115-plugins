// 会员档位（网易 / QQ）与歌曲付费标识。
//
// 网易：GET https://music.163.com/api/music-vip-membership/front/vip/info 带 Cookie 即可，
//   data.redplus=SVIP、associator=黑胶 VIP、musicPackage=音乐包，各包用 expireTime 判生效；
//   redVipLevel / 包内 vipLevel 是等级。account/profile 的 vipType 只能区分非会员/音乐包/会员，
//   区分不了 VIP 与 SVIP，所以档位一律以 vip/info 为准。
// QQ：musicu.fcg 的 UserInfo.UserInfoServer.GetUserInfo，字段以实测为准；
//   识别不到会员字段时返回 tier='unknown'，界面只显示「已登录」，不编造档位。

import { CHROME_UA } from './eapi.js'
import { neteaseCookieHeader, qqCookieHeader } from './cookies.js'
import { loadCookies, httpRequest } from './music-api.js'
import { pickNumber } from './vip-tag.js'

export { songVipTag, NETEASE_SVIP_QUALITY } from './vip-tag.js'

export const NETEASE_VIP_INFO_URL = 'https://music.163.com/api/music-vip-membership/front/vip/info'
export const QQ_USER_INFO_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'

function asObject(value) {
  return value && typeof value === 'object' ? value : null
}

/** 会员包是否生效：到期时间（毫秒）晚于现在。 */
function packageActive(pkg, nowMs) {
  const obj = asObject(pkg)
  return obj !== null && Number(obj.expireTime ?? 0) > nowMs
}

/** vip/info → {tier, level, expire_ms, icon, secondary[]}。 */
export function parseNeteaseVip(body, nowMs = Date.now()) {
  const data = asObject(body?.data)
  if (!data) return { tier: 'none', level: 0, expire_ms: 0, icon: '', secondary: [] }
  const redplus = packageActive(data.redplus, nowMs)
  const associator = packageActive(data.associator, nowMs)
  const musicPackage = packageActive(data.musicPackage, nowMs)
  const tier = redplus ? 'svip' : associator ? 'vip' : musicPackage ? 'music_package' : 'none'
  const primary = redplus ? asObject(data.redplus) : associator ? asObject(data.associator) : asObject(data.musicPackage)
  const secondary = []
  if (redplus && associator) secondary.push('黑胶 VIP')
  if ((redplus || associator) && musicPackage) secondary.push('音乐包')
  return {
    tier,
    level: Number(data.redVipLevel ?? primary?.vipLevel ?? 0) || 0,
    expire_ms: Number(primary?.expireTime ?? 0) || 0,
    icon: String(primary?.iconUrl ?? ''),
    secondary,
  }
}

/** 档位文案：SVIP 7 / 黑胶 VIP 7 / 音乐包 / 免费 / 已登录。 */
export function vipLabel(info) {
  if (!info) return ''
  const level = Number(info.level ?? 0) || 0
  if (info.tier === 'svip') return `SVIP${level ? ` ${level}` : ''}`
  if (info.tier === 'vip') return `黑胶 VIP${level ? ` ${level}` : ''}`
  if (info.tier === 'music_package') return '音乐包'
  if (info.tier === 'none') return '免费'
  return '已登录'
}

/** 到期时间的悬停文案；无到期时间返回空串。 */
export function vipExpireTitle(info) {
  const ms = Number(info?.expire_ms ?? 0)
  if (!ms) return ''
  return `有效期至 ${new Date(ms).toLocaleDateString('zh-CN')}`
}

/** 拉取网易会员信息；未登录（无 Cookie）返回 null。 */
export async function fetchNeteaseVip(deps) {
  const jar = await loadCookies(deps.kv, 'netease')
  const cookie = neteaseCookieHeader(jar)
  if (!cookie) return null
  const response = await httpRequest(deps, {
    url: NETEASE_VIP_INFO_URL,
    headers: { cookie, 'user-agent': CHROME_UA, referer: 'https://music.163.com/' },
    timeoutSeconds: 20,
  })
  if (response.status !== 200) throw new Error(`vip/info HTTP ${response.status}`)
  const body = JSON.parse(response.text || '{}')
  if (Number(body?.code) !== 200) throw new Error(`vip/info code=${body?.code ?? '未知'}`)
  return parseNeteaseVip(body)
}

/** QQ 用户信息 → 会员档位。字段名以实际响应为准，识别不到就是 unknown。 */
export function parseQqVip(body) {
  const data = asObject(body?.req_1?.data) ?? asObject(body?.data) ?? asObject(body)
  if (!data) return { tier: 'unknown', level: 0, expire_ms: 0, icon: '', secondary: [] }
  const svip = pickNumber(data, ['svip', 'is_svip', 'isSvip', 'svipFlag', 'super_vip', 'superVip'])
  const vip = pickNumber(data, ['vip', 'isvip', 'is_vip', 'vip_status', 'vipStatus', 'green_vip', 'greenVip'])
  const level = pickNumber(data, ['svip_level', 'svipLevel', 'vip_level', 'vipLevel', 'level', 'lv'])
  // 到期时间可能是秒或毫秒，统一成毫秒。
  let expire = pickNumber(data, ['svip_end_time', 'vip_end_time', 'vipEndTime', 'end_time', 'endTime', 'expireTime'])
  if (expire > 0 && expire < 10_000_000_000) expire *= 1000
  const tier = svip ? 'svip' : vip ? 'vip' : 'unknown'
  return { tier, level, expire_ms: expire, icon: '', secondary: [] }
}

/** 拉取 QQ 会员信息；未登录返回 null。 */
export async function fetchQqVip(deps) {
  const jar = await loadCookies(deps.kv, 'qq')
  const cookie = qqCookieHeader(jar)
  if (!cookie) return null
  const body = JSON.stringify({
    comm: { ct: 24, cv: 0, format: 'json', inCharset: 'utf-8', outCharset: 'utf-8' },
    req_1: { module: 'UserInfo.UserInfoServer', method: 'GetUserInfo', param: {} },
  })
  const response = await httpRequest(deps, {
    method: 'POST',
    url: QQ_USER_INFO_URL,
    headers: {
      cookie,
      'user-agent': CHROME_UA,
      referer: 'https://y.qq.com/',
      'content-type': 'application/json',
    },
    body,
    timeoutSeconds: 20,
  })
  if (response.status !== 200) throw new Error(`QQ 用户信息 HTTP ${response.status}`)
  return parseQqVip(JSON.parse(response.text || '{}'))
}
