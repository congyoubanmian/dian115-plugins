// 页面的常量表 —— 与原生 JS 版（v3-ui/legacy/douban-rs/page.native.js）逐字对齐。
//
// 这些文案是业务口径（榜单名、队列状态、动作名、忙碌提示），改写时不能自行润色。

import { FILTERED_QUEUE_STATE, NO_RESUB_QUEUE_STATE } from './lib-bridge'

/** 任务轮询间隔（宿主任务队列是异步的）。 */
export const POLL_INTERVAL_MS = 900
/** 页面等待任务终态的上限；超过则提示去宿主任务记录看，页面不假装失败。 */
export const POLL_TIMEOUT_MS = 150_000
/** 海报并发（页面 ctx.http 请求，不占宿主任务队列）。 */
export const POSTER_CONCURRENCY = 4
/** 页面内存海报缓存条数（条目只存 URL 字符串：downloadURL 或 data:，不再是 base64 大块头）。
 *  榜单+队列+想看很容易超过 160，过小会把已加载好的海报淘汰掉、回看时闪回占位并重取。 */
export const POSTER_CACHE_LIMIT = 480
/** 取图失败的冷却窗口：冷却内按 error 展示不刷屏；过后允许重试（网络抖动会自愈）。 */
export const POSTER_FAILURE_RETRY_MS = 120_000
/** 页面直连海报的 base64 上限挪到了 poster-chain.js（取图链路 own 它，node 测试同源）。 */
/** 批量「订阅全部到期条目」单次最多处理多少条（避免一次刷屏提交上百个任务）。 */
export const BATCH_SUBSCRIBE_LIMIT = 20

/** 榜单顺序（与旧实现一致）。 */
export const LIST_ORDER = ['upcoming', 'hot', 'cn_wom', 'global_wom', 'movie_wom']

/** 榜单名称与来源提示。 */
export const LIST_META: Record<string, { name: string; hint: string }> = {
  upcoming: { name: '即将上映', hint: 'coming_html · movie' },
  hot: { name: '热门电影', hint: 'subjects_json · movie / 热门' },
  cn_wom: { name: '国产剧口碑', hint: 'subjects_json · tv / 国产剧' },
  global_wom: { name: '欧美口碑', hint: 'subjects_json · movie / 欧美' },
  movie_wom: { name: '一周口碑榜', hint: 'chart_html · movie' },
}

/** 条目类型标签。 */
export const TYPE_LABEL: Record<string, string> = { movie: '电影', tv: '剧集' }

/** 榜单来源标签。 */
export const SOURCE_LABEL: Record<string, string> = {
  subjects_json: 'JSON 榜单',
  coming_html: '即将上映 HTML',
  chart_html: '一周口碑榜 HTML',
}

/** 队列状态标签与配色档（muted / ok / warn / error）。 */
export const QUEUE_STATE_META: Record<string, { label: string; cls: string }> = {
  observing: { label: '观察中', cls: 'warn' },
  subscribed: { label: '已订阅', cls: 'ok' },
  needs_review: { label: '待人工确认', cls: 'error' },
  [FILTERED_QUEUE_STATE]: { label: '已过滤', cls: 'muted' },
  [NO_RESUB_QUEUE_STATE]: { label: '墓碑拦截', cls: 'muted' },
}

/** 想看同步结果（wish_info.last_status）→ 中文。 */
export const WISH_STATUS_LABEL: Record<string, string> = {
  succeeded: '成功',
  partial: '部分成功',
  failed: '失败',
}

/** 登录态来源（wish_info.source / cookie.source）→ 中文。 */
export const COOKIE_SOURCE_LABEL: Record<string, string> = {
  manual: '手动粘贴的 Cookie',
}

/** 动作名 → 按钮/提示文案。 */
export const ACTION_LABELS: Record<string, string> = {
  refresh: '刷新榜单',
  'wish-sync-now': '同步想看',
  subscribe: '订阅条目',
  'subscribe-now': '立即订阅',
  'observe-remove': '移出观察队列',
  'blacklist-add': '添加黑名单',
  'blacklist-remove': '移除黑名单',
  archive: '归档历史与日志',
  'no-resub-clear': '清除重订限制',
  'send-test': '通知自检',
  'settings-update': '保存设置',
}

/** 动作名 → 忙碌提示文案。 */
export const BUSY_TEXT: Record<string, string> = {
  refresh: '正在抓取豆瓣榜单（前台预算约 6.5 秒，订阅交给后台）…',
  'wish-sync-now': '正在拉取「我的想看」并入队…',
  subscribe: '正在 TMDB 匹配并创建聚合订阅…',
  'subscribe-now': '正在为队列条目匹配并订阅…',
  'observe-remove': '正在移出观察队列…',
  'blacklist-add': '正在保存黑名单关键词…',
  'blacklist-remove': '正在移除黑名单关键词…',
  archive: '正在归档历史与日志…',
  'no-resub-clear': '正在清除重订限制…',
  'send-test': '正在发送测试通知…',
  'settings-update': '正在保存设置（状态文档 + 宿主设置 KV）…',
}
