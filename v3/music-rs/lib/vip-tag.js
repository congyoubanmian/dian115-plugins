// 歌曲付费/会员标识（纯函数，不依赖网络与 Cookie）。
// 归一为 '' | 'vip' | 'svip' | 'paid'，界面据此显示 VIP / SVIP / 付费专辑标签。

/** 网易 SVIP 档音质：VIP 歌曲里最高音质是这些档位时进一步标 SVIP。 */
export const NETEASE_SVIP_QUALITY = ['jymaster', 'sky', 'jyeffect']

export function pickNumber(source, keys) {
  for (const key of keys) {
    const value = Number(source?.[key])
    if (Number.isFinite(value) && value !== 0) return value
  }
  return 0
}

/**
 * 网易：fee=4 → 付费专辑；fee=1 → VIP（最高音质为 SVIP 档时标 SVIP）。
 * QQ：pay.price_onsale=1 → 付费专辑；pay.svip_* → SVIP；pay.pay_play/pay_down → VIP。
 */
export function songVipTag({ fee = 0, maxLevel = '', pay = null }) {
  if (pay && typeof pay === 'object') {
    if (pickNumber(pay, ['price_onsale', 'priceOnsale']) === 1) return 'paid'
    if (pickNumber(pay, ['svip_play', 'svip_down', 'svip', 'svipPlay'])) return 'svip'
    if (pickNumber(pay, ['pay_play', 'pay_down', 'payPlay', 'payDown'])) return 'vip'
    return ''
  }
  const feeNum = Number(fee) || 0
  if (feeNum === 4) return 'paid'
  if (feeNum === 1) return NETEASE_SVIP_QUALITY.includes(maxLevel) ? 'svip' : 'vip'
  return ''
}
