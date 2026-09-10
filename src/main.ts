import { createApp, defineComponent, h, reactive } from 'vue'
import { NConfigProvider, NDialogProvider, NMessageProvider, NNotificationProvider } from 'naive-ui'
import AppPage from './AppPage.vue'
import './preview.css'

const previewState = reactive({
  status: 'ready',
  last_message: '本地预览已就绪，点击「刷新」体验榜单抓取流程（预览环境不真实抓取）。',
  last_run: '',
  revision: 1,
  snapshot: { fetched_at: '', lists: {} },
  blacklist: { keywords: ['低质量', '某某关键词'], hits: 2, recent: [{ title: '示例条目', keyword: '低质量', at: new Date().toISOString() }] },
  observe_queue: { items: [] },
  history: [],
  logs: [],
  stats: { total: 0, month_new: 0, by_list: {} },
  settings: {
    lists: {
      upcoming: { source: 'coming_html', type: 'movie', tag: '', sort: '', limit: 10, enabled: true },
      hot: { source: 'subjects_json', type: 'movie', tag: '热门', sort: 'recommend', limit: 10, enabled: true },
      cn_wom: { source: 'subjects_json', type: 'tv', tag: '华语', sort: 'recommend', limit: 10, enabled: true },
      global_wom: { source: 'subjects_json', type: 'movie', tag: '欧美', sort: 'recommend', limit: 10, enabled: true },
      movie_wom: { source: 'chart_html', type: 'movie', tag: '', sort: '', limit: 10, enabled: true },
    },
    observe_period_hours: 24,
    auto_subscribe: true,
    notify_on_subscribe: true,
    subscribe_source_filter: [],
  },
})

const previewBridge = {
  async getState() {
    return { state: previewState, state_version: 'preview-v1', etag: '"preview-v1"' }
  },
  async invokeAction(action: string) {
    previewState.revision += 1
    previewState.last_message = `本地预览已执行 ${action}`
    return { result: { status: 'succeeded' as const, message: previewState.last_message } }
  },
  async refresh() {
    return previewState
  },
}

// This entry is only for local preview and type checking. The signed package
// loads the exposed Federation module declared in manifest.template.json.
const Preview = defineComponent({
  setup: () => () => h(NConfigProvider, null, {
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
