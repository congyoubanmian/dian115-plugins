// 本地预览入口(仅 `vite dev` / 类型检查用; 签名包加载的是 vite.config.ts 里暴露的
// Federation 模块 `./AppPage`, **不会**执行这个文件)。
//
// 这里给出一份与宿主同形的 `props.api` 替身: getState / invokeAction / refresh 三个方法,
// 动作返回值与 wasm 侧 `runtime::action` 的包装一致(`{result:{status,data|message}}`),
// 状态文档的键也照 `runtime::state_doc` 抄。**不连接宿主, 不发任何网络请求**。
import { createApp, defineComponent, h, reactive } from 'vue'
import { NConfigProvider, NDialogProvider, NMessageProvider, NNotificationProvider } from 'naive-ui'
import AppPage from './AppPage.vue'

// 宿主会在 iframe 里注入 --dian-* 主题变量; 本地预览没有宿主, 这里补一份浅色兜底,
// 免得整页只剩默认字体色。构建产物里不包含这段(它是 main.ts 的运行时行为)。
const previewThemeVars = `
:root {
  --dian-color-scheme: light;
  --dian-background: #f5f6f8;
  --dian-surface: #ffffff;
  --dian-surface-raised: #ffffff;
  --dian-surface-soft: #f7faff;
  --dian-surface-hover: #eaf4fd;
  --dian-text-primary: rgba(0, 0, 0, 0.88);
  --dian-text-secondary: rgba(0, 0, 0, 0.72);
  --dian-text-muted: rgba(0, 0, 0, 0.45);
  --dian-border: #e0e4ea;
  --dian-border-strong: #c8d8ec;
  --dian-divider: #e0e4ea;
  --dian-primary: #2196f3;
  --dian-primary-hover: #1976d2;
  --dian-primary-contrast: #ffffff;
  --dian-success: #18a058;
  --dian-warning: #f0a020;
  --dian-error: #d03050;
  --dian-radius-sm: 8px;
  --dian-radius-md: 12px;
  --dian-radius-lg: 14px;
  --dian-radius-panel: 20px;
  --dian-space-1: 4px;
  --dian-space-2: 8px;
  --dian-space-3: 12px;
  --dian-space-4: 16px;
  --dian-font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
body { margin: 0; background: var(--dian-background); }
`
const themeStyle = document.createElement('style')
themeStyle.textContent = previewThemeVars
document.head.appendChild(themeStyle)

const previewState = reactive({
  status: 'succeeded',
  last_message: '本地预览: 数据是内置样例, 不会真的登录/搜索/下载',
  revision: 3,
  schema: 1,
  settings: {
    staging_dir: '/volume1/docker/music-staging',
    target_dir: '/CloudNAS/115open/音乐/音乐下载',
    quality: 'jymaster',
    max_active: 2,
    notify_on_fail: true,
  },
  tasks: [
    {
      id: 'k3f9d1',
      source: 'netease',
      song_id: '1901371647',
      name: '示例: 某首歌',
      singers: '示例歌手',
      album: '示例专辑',
      quality: 'lossless',
      out_name: '示例歌手 - 示例: 某首歌.flac',
      status: 'downloading',
      job_ref: 'job-8f2',
      attempts: 1,
      error: '',
      created_ms: Date.parse('2026-10-02T09:12:00Z'),
      updated_ms: Date.parse('2026-10-02T09:12:30Z'),
    },
    {
      id: 'm2c8a4',
      source: 'qq',
      song_id: '003aYrM41Z9KpX',
      name: '示例: 另一首歌',
      singers: '某歌手',
      album: '',
      quality: 'flac',
      out_name: '某歌手 - 示例: 另一首歌.flac',
      status: 'failed',
      job_ref: '',
      attempts: 3,
      error: '所有音质均未获取到链接（需要 SVIP 且歌曲有对应音源）',
      created_ms: Date.parse('2026-10-02T09:05:00Z'),
      updated_ms: Date.parse('2026-10-02T09:11:00Z'),
    },
  ],
  login: {
    netease: { logged_in: false, has_music_u: false },
    qq: { source: 'qq', logged_in: false, uin: '' },
  },
  roots: {
    ok: true,
    error: '',
    staging_dir: '/volume1/docker/music-staging',
    staging_dir_effective: '/volume1/docker/music-staging',
    target_dir: '/CloudNAS/115open/音乐/音乐下载',
    warnings: [],
    roots: [
      { path: '/volume1/docker/music-staging', name: 'music-staging', local: true, writable: true },
      { path: '/CloudNAS/115open/音乐', name: '115 音乐', local: false, writable: true },
    ],
  },
  logs: [
    { at: '2026-10-02T09:12:30Z', level: 'info', message: '本地预览: 队列有 1 条下载中' },
    { at: '2026-10-02T09:11:00Z', level: 'warning', message: '本地预览: 示例失败任务(重试按钮可用)' },
  ],
})

let previewPollCount = 0

/** 与 AppPage 里 RuntimeCallback 同形(这里显式写出来, 免得 status 被放宽成 string)。 */
interface PreviewCallback {
  result: {
    status: 'succeeded'
    message: string
    data?: Record<string, any>
  }
}

const previewBridge = {
  async getState() {
    return {
      state: previewState as Record<string, unknown>,
      state_version: `state-v${previewState.revision}`,
      etag: `"state-v${previewState.revision}"`,
    }
  },
  async invokeAction(action: string, input?: unknown): Promise<PreviewCallback> {
    previewState.revision += 1
    const message = `本地预览: 已调用 ${action}`
    previewState.last_message = message
    // 扫码链路给一份形状正确的返回值, 这样本地也能看到二维码与轮询文案。
    if (action === 'qr-create') {
      previewPollCount = 0
      return {
        result: {
          status: 'succeeded',
          data: {
            key: 'preview-unikey',
            qr_content: `https://music.163.com/login?codekey=${'0'.repeat(8)}preview`,
          },
          message,
        },
      }
    }
    if (action === 'qr-poll') {
      previewPollCount += 1
      const status = previewPollCount < 2 ? 'waiting' : previewPollCount < 4 ? 'scanned' : 'success'
      return {
        result: {
          status: 'succeeded',
          data: { status, message: '本地预览', code: status === 'success' ? 803 : 801 },
          message,
        },
      }
    }
    if (action === 'search') {
      return {
        result: {
          status: 'succeeded',
          data: {
            songs: [
              { id: 1901371647, name: '示例搜索结果', singers: '歌手 A/歌手 B', album: '示例专辑', source: 'netease' },
            ],
            total: 1,
            page: 1,
          },
          message,
        },
      }
    }
    return { result: { status: 'succeeded', data: { input: input ?? null }, message } }
  },
  async refresh() {
    return previewState as Record<string, unknown>
  },
}

const Preview = defineComponent({
  setup: () => () =>
    h(NConfigProvider, null, {
      default: () =>
        h(NMessageProvider, null, {
          default: () =>
            h(NNotificationProvider, null, {
              default: () =>
                h(NDialogProvider, null, {
                  default: () =>
                    h(AppPage, {
                      api: previewBridge,
                      hostApi: previewBridge,
                      installationId: 1,
                      pluginId: 'music.rs',
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
