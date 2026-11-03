// 通知结果摘要 —— 后台失败通知与页面「通知自检」共用（页面打包时只内联这个小模块）。

/** 把通知结果拼成一行人话：优先逐渠道 deliveries（notifications.md「返回结果」），
 *  没有时退回 channels 能力上报；都没有 → null。 */
export function channelSummary(outcome) {
  const deliveries = outcome?.deliveries
  if (Array.isArray(deliveries) && deliveries.length > 0) {
    return deliveries
      .map((item) => {
        const status = String(item?.status ?? '')
        const detail = status === 'sent' ? '已送达' : status === 'skipped' ? `跳过${item?.reason ? `:${item.reason}` : ''}` : `失败${item?.error ? `:${item.error}` : ''}`
        const dropped = Array.isArray(item?.dropped) && item.dropped.length ? `(丢:${item.dropped.join('/')})` : ''
        return `${item?.channel}${dropped} ${detail}`
      })
      .join(' · ')
  }
  if (outcome?.suppressed) return `无(${outcome.suppression_reason || 'suppressed'})`
  const channels = outcome?.channels
  if (!Array.isArray(channels) || channels.length === 0) return null
  return channels
    .map((item) => {
      const dropped = Array.isArray(item?.dropped) ? item.dropped : []
      return dropped.length === 0 ? String(item.channel) : `${item.channel}(丢:${dropped.join('/')})`
    })
    .join(' · ')
}
