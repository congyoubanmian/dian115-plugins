import { createApp, defineComponent, h, reactive } from 'vue'
import { darkTheme, NConfigProvider, NDialogProvider, NMessageProvider, NNotificationProvider } from 'naive-ui'
import AppPage from './AppPage.vue'
import './preview.css'

// ---- 预览 mock: 字段形状严格按 AppState 真实契约(见 AppPage.vue 顶部 interface) ----

// 相对当前时间生成 ISO 串, 让相对时间/时间戳展示贴近真实
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString()
const isoAhead = (ms: number) => new Date(Date.now() + ms).toISOString()
const MIN = 60 * 1000
const HOUR = 3600 * 1000
const DAY = 86400 * 1000

const poster = (id: string) => `https://img1.doubanio.com/view/photo/s_ratio_poster/public/${id}.jpg`

// 榜单快照: 实时热门 6 张海报(验证宽屏一排 5–6 张), 其余榜各给若干条
const chartItem = (ref: string, title: string, rate: string, hotness: number, year: string) => ({
  douban_ref: ref,
  title,
  rate,
  hotness,
  poster_url: poster(ref),
  url: `https://movie.douban.com/subject/${ref}/`,
  year,
})

const previewState = reactive({
  status: 'ready',
  last_message: '',
  last_run: isoAgo(2 * HOUR),
  revision: 1,
  snapshot: {
    fetched_at: isoAgo(2 * MIN),
    lists: {
      hot: [
        chartItem('hot-1', '飞行家', '8.7', 321000, '2025'),
        chartItem('hot-2', '奥德赛', '8.2', 284000, '2026'),
        chartItem('hot-3', '南京照相馆', '8.9', 417000, '2025'),
        chartItem('hot-4', '年会不能停！2', '7.6', 259000, '2026'),
        chartItem('hot-5', '人生路不熟', '7.1', 182000, '2025'),
        chartItem('hot-6', '深空信号', '8.4', 156000, '2026'),
      ],
      upcoming: [
        chartItem('up-1', '三国第一部：争洛阳', '', 98000, '2026'),
        chartItem('up-2', '巴黎绽放的星辰', '', 64000, '2026'),
        chartItem('up-3', '午夜修理铺', '', 31000, '2026'),
      ],
      cn_wom: [
        chartItem('cn-1', '家弑服务', '8.1', 88000, '2025'),
        chartItem('cn-2', '赛博环线', '6.2', 45000, '2026'),
      ],
      global_wom: [
        chartItem('gb-1', '害群之马', '7.9', 72000, '2025'),
        chartItem('gb-2', '潮间带', '8.3', 53000, '2025'),
      ],
      movie_wom: [chartItem('mv-1', '铁道英雄榜', '8.0', 41000, '2024')],
    },
  },
  blacklist: {
    keywords: ['综艺', '真人秀', '演唱会', '粉丝向', '路透', '短片', '广告', '低质量'],
    hits: 12,
    recent: [
      { title: '示例综艺条目', keyword: '综艺', at: isoAgo(3 * HOUR) },
      { title: '某演唱会纪录', keyword: '演唱会', at: isoAgo(9 * HOUR) },
    ],
  },
  // 观察队列 3 行: 2 条待确认 + 1 条已过滤终态(last_error 为后端口径文案)
  observe_queue: {
    items: [
      {
        douban_ref: 'hot-6',
        title: '深空信号',
        list: 'hot',
        poster_url: poster('hot-6'),
        url: 'https://movie.douban.com/subject/hot-6/',
        entered_at: isoAgo(26 * HOUR),
        due_at: isoAhead(22 * HOUR),
        state: 'observing',
      },
      {
        douban_ref: 'up-3',
        title: '午夜修理铺',
        list: 'upcoming',
        poster_url: poster('up-3'),
        url: 'https://movie.douban.com/subject/up-3/',
        entered_at: isoAgo(50 * HOUR),
        due_at: isoAhead(6 * HOUR),
        state: 'observing',
      },
      {
        douban_ref: 'cn-2',
        title: '赛博环线',
        list: 'cn_wom',
        poster_url: poster('cn-2'),
        url: 'https://movie.douban.com/subject/cn-2/',
        entered_at: isoAgo(3 * DAY),
        state: 'filtered',
        last_error: '评分 6.2 < 阈值 7.0 · 被过滤器拦下 · 终态只读',
      },
    ],
  },
  // 订阅历史 4 行(含 1 失败)
  history: [
    { douban_ref: 'up-1', title: '三国第一部：争洛阳', list: 'upcoming', action: 'subscribe', result: 'succeeded', message: '', intent_id: 101, created_at: isoAgo(21 * MIN) },
    { douban_ref: 'up-2', title: '巴黎绽放的星辰', list: 'hot', action: 'subscribe', result: 'succeeded', message: '', intent_id: 100, created_at: isoAgo(5 * DAY) },
    { douban_ref: 'cn-1', title: '家弑服务', list: 'global_wom', action: 'subscribe', result: 'succeeded', message: '', intent_id: 99, created_at: isoAgo(5 * DAY) },
    { douban_ref: 'gb-1', title: '害群之马', list: 'global_wom', action: 'subscribe', result: 'failed', message: '115 接口超时', intent_id: 98, created_at: isoAgo(5 * DAY) },
  ],
  // 观察日志 6 行(等宽时间戳)
  logs: [
    { at: isoAgo(2 * MIN), level: 'info', message: '抓取「实时热门」50 条' },
    { at: isoAgo(2 * MIN + 1000), level: 'info', message: '过滤：评分 < 7.0 ×11 · 年份 < 2024 ×3' },
    { at: isoAgo(2 * MIN + 2000), level: 'warning', message: '命中黑名单「综艺」×2 → 已过滤' },
    { at: isoAgo(2 * MIN + 3000), level: 'info', message: '「深空信号」进入观察队列 · 榜单：实时热门' },
    { at: isoAgo(2 * MIN + 4000), level: 'info', message: '自动订阅「三国第一部：争洛阳」成功' },
    { at: isoAgo(2 * HOUR), level: 'info', message: '同步我的想看：新增 2 · 移除 0' },
  ],
  stats: {
    total: 147,
    month_new: 39,
    by_list: { upcoming: 20, hot: 45, cn_wom: 30, global_wom: 32, movie_wom: 20 },
    last_archive_at: isoAgo(12 * DAY),
  },
  settings: {
    lists: {
      upcoming: { source: 'coming_html', type: 'movie', tag: '', sort: '', limit: 10, enabled: true },
      hot: { source: 'subjects_json', type: 'movie', tag: '热门', sort: 'recommend', limit: 10, enabled: true },
      cn_wom: { source: 'subjects_json', type: 'tv', tag: '华语', sort: 'recommend', limit: 10, enabled: true },
      global_wom: { source: 'subjects_json', type: 'movie', tag: '欧美', sort: 'recommend', limit: 10, enabled: true },
      movie_wom: { source: 'chart_html', type: 'movie', tag: '', sort: '', limit: 10, enabled: true },
    },
    blacklist: ['综艺', '真人秀', '演唱会', '粉丝向', '路透', '短片', '广告', '低质量'],
    observe_period_hours: 24,
    auto_subscribe: true,
    notify_on_subscribe: true,
    subscribe_source_filter: [],
    cc_url: 'http://127.0.0.1:8088',
    cc_uuid: 'preview-uuid',
    cc_key: '',
    cc_manual: '',
    cc_key_set: true,
    cc_manual_set: false,
    wish_sync_enabled: true,
    min_rating: 7,
    min_year: 0,
    regions: [],
  },
  // 我的想看 4 行
  wish: [
    { douban_ref: 'hot-1', title: '飞行家', year: '2025', type: 'movie', poster_url: poster('hot-1') },
    { douban_ref: 'hot-4', title: '年会不能停！2', year: '2026', type: 'movie', poster_url: poster('hot-4') },
    { douban_ref: 'hot-2', title: '奥德赛', year: '2026', type: 'movie', poster_url: poster('hot-2') },
    { douban_ref: 'hot-3', title: '南京照相馆', year: '2025', type: 'movie', poster_url: poster('hot-3') },
  ],
  wish_info: {
    enabled: true,
    last_sync: isoAgo(2 * HOUR),
    last_count: 5,
    last_new: 2,
    last_status: 'succeeded',
    uid: '112358',
    source: 'cookiecloud',
  },
  // 不再订阅名单(已删除不重订墓碑集) 19 条
  no_resub: Object.fromEntries(
    Array.from({ length: 19 }, (_, i) => [
      `nr-${i + 1}`,
      { intent_id: 60 + i, at: isoAgo((i + 1) * DAY), reason: '用户删除' },
    ]),
  ),
})

// 预览环境生成确定性的 SVG 海报占位(dataURL), 不真实抓豆瓣图
function mockPoster(url: string): string {
  let h = 0
  for (const c of url) h = (h * 31 + c.charCodeAt(0)) >>> 0
  const hue = h % 360
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='200' height='300'>
  <defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
    <stop offset='0' stop-color='hsl(${hue},55%,42%)'/><stop offset='1' stop-color='hsl(${(hue + 40) % 360},60%,26%)'/>
  </linearGradient></defs>
  <rect width='200' height='300' fill='url(#g)'/>
  <circle cx='100' cy='128' r='34' fill='none' stroke='rgba(255,255,255,0.85)' stroke-width='5'/>
  <path d='M94 112 L122 128 L94 144 Z' fill='rgba(255,255,255,0.85)'/>
  <text x='100' y='210' text-anchor='middle' font-size='15' fill='rgba(255,255,255,0.75)' font-family='sans-serif'>豆瓣海报</text>
</svg>`
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

const previewBridge = {
  async getState() {
    return { state: previewState, state_version: 'preview-v1', etag: '"preview-v1"' }
  },
  async invokeAction(action: string, input?: unknown) {
    // PosterImg 的 get-poster 走真实 invokeAction 通道, 预览里回 dataURL 占位图
    if (action === 'get-poster') {
      const url = String((input as { poster_url?: string })?.poster_url || '')
      return { result: { status: 'succeeded' as const, url: mockPoster(url) } }
    }
    if (action === 'open-source') {
      return { result: { status: 'succeeded' as const, url: 'https://movie.douban.com/' } }
    }
    previewState.revision += 1
    previewState.last_message = `本地预览已执行 ${action}`
    return { result: { status: 'succeeded' as const, message: previewState.last_message } }
  },
  async refresh() {
    return previewState
  },
}

// 深色预览: 预览地址加 ?theme=dark, 切换 preview.css 里的深色宿主变量 + naive 深色主题
const previewDark = new URLSearchParams(window.location.search).get('theme') === 'dark'
document.documentElement.dataset.dianTheme = previewDark ? 'dark' : 'light'

// 预览环境把 naive 语义色对齐到 --dian-* 浅色值; 生产由宿主的 NConfigProvider 接管
const previewThemeOverrides = {
  common: {
    primaryColor: '#2080F0',
    primaryColorHover: '#4C9AF5',
    primaryColorPressed: '#1B6FD6',
    primaryColorSuppl: '#2080F0',
    successColor: '#18A058',
    warningColor: '#F0A020',
    errorColor: '#D03050',
  },
}

// This entry is only for local preview and type checking. The signed package
// loads the exposed Federation module declared in manifest.template.json.
const Preview = defineComponent({
  setup: () => () => h(NConfigProvider, { theme: previewDark ? darkTheme : null, themeOverrides: previewThemeOverrides }, {
    default: () => h(NMessageProvider, null, {
      default: () => h(NNotificationProvider, null, {
        default: () => h(NDialogProvider, null, {
          default: () => h(AppPage, {
            api: previewBridge,
            hostApi: previewBridge,
            installationId: 1,
            pluginId: 'douban.center',
            runtime: { health_status: 'healthy', process_state: 'running' },
            runtimeState: previewState,
            navKey: 'main',
            themeContract: 'dian115-theme-v1',
          }),
        }),
      }),
    }),
  }),
})

createApp(Preview).mount('#app')
