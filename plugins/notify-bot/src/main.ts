import { createApp, defineComponent, h, reactive } from 'vue'
import { NConfigProvider, NDialogProvider, NMessageProvider, NNotificationProvider } from 'naive-ui'
import AppPage from './AppPage.vue'
import './preview.css'

const previewState = reactive({
  status: 'succeeded',
  last_message: '本地预览已就绪，配置不会真实发送（预览环境无宿主网络）。',
  revision: 1,
  settings: {
    webhooks: [
      { id: 'cfg-demo1', name: '企业微信 1', platform: 'wecom', webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo', secret: '', proxy: '', enabled: true },
      { id: 'cfg-demo2', name: '飞书 1', platform: 'feishu', webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/demo', secret: '', proxy: '', enabled: true },
    ],
    max_logs: 200,
  },
  history: [
    { at: new Date().toISOString(), platform: 'wecom', config: '企业微信 1', action: 'test', result: 'succeeded', message: '' },
  ],
  logs: [{ at: new Date().toISOString(), level: 'info', message: '[wecom/企业微信 1] 发送成功 (0.4s)' }],
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
            pluginId: 'notify.bot',
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
