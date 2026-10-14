// 本地预览入口(仅 `vite dev` / 类型检查用; 签名包加载的是 vite.config.ts 里暴露的
// Federation 模块 `./AppPage`, **不会**执行这个文件)。
//
// 这里给出一份与宿主同形的 `props.api` 替身: getState / invokeAction / refresh 三个方法,
// 动作返回值与 wasm 侧 `runtime::action` 的包装一致(`{result:{status,data|message}}`),
// 状态文档的键也照 `runtime::state_doc` 抄。**不连接宿主, 不发任何网络请求**。
//
// 2026-10 视觉重画配套: previewState 扩充到能直接展示设计图的各状态 ——
//   · 5 条任务(下载中 / 排队第 1 位 / 排队第 2 位 / 下载完成 / 下载失败),
//     字段严格按 tasks.rs `state_view` 的 9 个键(没有进度字节字段, 故没有百分比);
//   · 6 条最近动作(state.logs 的 at/level/message);
//   · 点「获取二维码」走 qr-create → qr.ts 把预览串编码成真 QR + 四步 stepper 点亮
//     (qr-poll 依次回 waiting → scanned → success);
//   · 点「推进队列」回 skipped(后端 download.rs `queue_busy_value` 的原文),
//     「下载任务」卡顶部出现互斥警告条, 「知道了」前端 dismiss。
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
  --dian-info: #2080f0;
  --dian-warning: #f0a020;
  --dian-error: #d03050;
  --dian-radius-sm: 8px;
  --dian-radius-md: 12px;
  --dian-radius-lg: 14px;
  --dian-radius-panel: 20px;
  --dian-radius-pill: 999px;
  --dian-shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.06);
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
  last_message: '本地预览: 数据是内置样例, 不会真的登录/搜索/下载; 点「获取二维码」看等待扫码态, 点「推进队列」看互斥警告条',
  revision: 3,
  schema: 1,
  settings: {
    // state 里的路径已经被后端 display_path 去掉开头 "/"(download.rs `settings_view`)。
    staging_dir: 'volume1/docker/music-staging',
    target_dir: 'CloudNAS/115open/音乐/音乐下载',
    quality: 'lossless',
    max_active: 2,
    notify_on_fail: true,
  },
  // 字段 = tasks.rs `state_view` 的索引投影 9 键, 顺序按 updated_ms 倒序(与后端一致)。
  tasks: [
    {
      id: 'k3f9d1',
      source: 'netease',
      song_id: '1901371647',
      name: '晴天',
      singers: '周杰伦',
      quality: 'lossless',
      status: 'downloading',
      error: '',
      updated_ms: Date.parse('2026-10-14T12:14:00Z'),
    },
    {
      id: 'm2c8a4',
      source: 'netease',
      song_id: '347230',
      name: '明明就',
      singers: '周杰伦',
      quality: 'lossless',
      status: 'queued',
      error: '',
      updated_ms: Date.parse('2026-10-14T12:13:47Z'),
    },
    {
      id: 'p7e2b9',
      source: 'netease',
      song_id: '347231',
      name: '珊瑚海',
      singers: '周杰伦/梁心颐',
      quality: 'exhigh',
      status: 'queued',
      error: '',
      updated_ms: Date.parse('2026-10-14T12:13:00Z'),
    },
    {
      id: 'd5a1c6',
      source: 'netease',
      song_id: '186016',
      name: '一路向北',
      singers: '周杰伦',
      quality: 'lossless',
      status: 'done',
      error: '',
      updated_ms: Date.parse('2026-10-14T12:10:00Z'),
    },
    {
      id: 'f9b3e2',
      source: 'netease',
      song_id: '185924',
      name: '半岛铁盒',
      singers: '周杰伦',
      quality: 'lossless',
      status: 'failed',
      error: '网络超时: 宿主代下载 job 未在时限内完成',
      updated_ms: Date.parse('2026-10-14T12:08:00Z'),
    },
  ],
  login: {
    netease: { logged_in: false, has_music_u: false },
    qq: { source: 'qq', logged_in: false, uin: '' },
  },
  roots: {
    ok: true,
    error: '',
    staging_dir: 'volume1/docker/music-staging',
    staging_dir_effective: 'volume1/docker/music-staging',
    target_dir: 'CloudNAS/115open/音乐/音乐下载',
    warnings: [],
    roots: [
      { path: 'volume1/docker/music-staging', name: 'music-staging', local: true, writable: true },
      { path: 'CloudNAS/115open/音乐', name: '115 音乐', local: false, writable: true },
    ],
  },
  logs: [
    { at: '2026-10-14T12:14:02Z', level: 'info', message: '「晴天」下载完成 → CloudNAS/115open/音乐/音乐下载/周杰伦 - 晴天.flac' },
    { at: '2026-10-14T12:13:47Z', level: 'info', message: '「明明就」入队 · 无损 · 队列第 1 位' },
    { at: '2026-10-14T12:11:20Z', level: 'warning', message: '上一轮队列推进仍在进行, 本次跳过, 请稍后再试' },
    { at: '2026-10-14T12:08:56Z', level: 'info', message: 'CookieCloud 同步完成 —— 网易云: 保存 12 条, 未登录; QQ: 保存 0 条, 未登录' },
    { at: '2026-10-14T12:05:13Z', level: 'info', message: '二维码已过期, 请重新获取' },
    { at: '2026-10-14T12:02:48Z', level: 'info', message: '搜索「晴天」 · 来源网易云 · 返回 30 条' },
  ],
})

let previewPollCount = 0

/** 与 AppPage 里 RuntimeCallback 同形(这里显式写出来, 免得 status 被放宽成 string)。 */
interface PreviewCallback {
  result: {
    status: 'succeeded' | 'skipped'
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
    // 「推进队列」在预览里回互斥 skipped(文案是后端 download.rs `queue_busy_value` 的原文),
    // 让「下载任务」卡的黄色警告条可在预览里演示(「知道了」是前端 dismiss)。
    if (action === 'pump') {
      return {
        result: {
          status: 'skipped',
          message: '上一轮队列推进仍在进行, 本次跳过, 请稍后再试',
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
