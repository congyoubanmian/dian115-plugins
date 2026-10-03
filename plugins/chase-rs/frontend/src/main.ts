// 本地预览入口(仅本地 `npm run dev` / 类型检查用)。
//
// 签名包加载的是 manifest.template.json 里声明的 Federation 模块 `./AppPage`,
// **不会**执行这个文件 —— 这里只是给出一份与宿主同形的 `props.api` 替身,
// 让页面在没有宿主时也能跑起来看样式(空状态、错误态都是真状态, 不造假数据)。
import { createApp, defineComponent, h, reactive } from 'vue'
import { NConfigProvider, NDialogProvider, NMessageProvider, NNotificationProvider } from 'naive-ui'
import AppPage from './AppPage.vue'
import './preview.css'

const previewState = reactive({
  schema_version: 1,
  revision: 3,
  status: 'accepted',
  last_message: '本地预览: 数据来自内置样例',
  last_run: '2026-10-01T09:00:00Z',
  settings: {
    enabled: true,
    emby_proxy_id: -1,
    max_patch_per_run: 5,
    max_raise_per_run: 20,
    catch_up_days: 7,
    emby_probe_budget: 120,
    dry_run: false,
    write_episode_strings: false,
    report: { enabled: true, hour: 9, tz_offset_minutes: 480 },
    probe: { emby_episodes_shape: '', air_calendar_shape: '' },
  },
  align: {
    last_run_at: '2026-10-01T09:00:00Z',
    pages: 1,
    intents_seen: 2,
    matched: 2,
    patched: 1,
    skipped: 1,
    failed: 0,
    last_error: '',
    items: [
      {
        intent_id: 41,
        tmdb_id: 1396,
        season: 5,
        title: '绝命毒师',
        total_known: 10,
        emby_have_max: 12,
        emby_have_count: 12,
        gap_max: 2,
        from_total: 10,
        to_total: 16,
        action: 'patched',
        reason: '抬升 10 → 16 集',
        at: '2026-10-01T09:00:00Z',
      },
      {
        intent_id: 42,
        tmdb_id: 1399,
        season: 1,
        title: '权力的游戏',
        total_known: 5,
        emby_have_max: 5,
        emby_have_count: 5,
        gap_max: 0,
        from_total: 5,
        to_total: 5,
        // 「无缺口」要求目标也取到: 目标未知的行后端文案是「覆盖已核实但目标未知」,
        // 预览数据也得同形, 免得演示里出现"无缺口 + 目标未知"的自相矛盾。
        target_upper: 5,
        target_known: true,
        action: 'skipped',
        reason: '无缺口: 订阅 5 集, Emby 已有 5 集, TMDB 目标 5 集',
        at: '2026-10-01T09:00:00Z',
      },
    ],
  },
  trim_suggestions: [
    {
      intent_id: 43,
      tmdb_id: 100,
      season: 2,
      title: '某部改过元数据的剧',
      total_known: 16,
      emby_have_max: 16,
      target_upper: 10,
      reason: '订阅 16 集已全部入库, 该季 TMDB 只有 10 集, 建议裁剪到 10',
      at: '2026-10-01T09:00:00Z',
    },
  ],
  calendar: {
    fetched_at: '2026-10-01T09:00:00Z',
    days: [
      {
        date: '2026-10-01',
        items: [{ tmdb_id: 1396, season: 5, episode: 4, title: '绝命毒师', time: '12:00' }],
      },
      {
        date: '2026-10-02',
        items: [{ tmdb_id: 1399, season: 1, episode: 9, title: '权力的游戏', time: '' }],
      },
    ],
  },
  daily: {
    last_sent_date: '2026-10-01',
    last_at: '2026-10-01T09:00:05Z',
    last_result: 'accepted',
    last_error: '',
    sent_total: 1,
  },
  debug: {
    updated_at: '2026-10-01T09:00:00Z',
    emby_episodes: {
      status: 'never',
      shape: '',
      params_tried: [],
      http_status: 0,
      sample: '',
      at: '',
    },
    air_calendar: { status: 'never', shape: '', params_tried: [], http_status: 0, sample: '', at: '' },
    pool_intents: { status: 'never', shape: '', params_tried: [], http_status: 0, sample: '', at: '' },
    attempts: [],
    last_errors: [{ step: '预览', message: '本地预览不连接宿主, 诊断面板是空的', at: '2026-10-01T09:00:00Z' }],
  },
  stats: { tv_intents: 2, matched: 2, aligned: 1, gap_total: 2, unknown_shape: 0 },
  logs: [{ at: '2026-10-01T09:00:00Z', level: 'info', message: '本地预览已就绪' }],
  emby_instances: [
    { id: 3, name: '客厅 (预览)', is_default: true, key_ready: true, at: '2026-10-01T09:00:00Z' },
  ],
})

const previewBridge = {
  async getState() {
    return { state: previewState, state_version: `state-v${previewState.revision}`, etag: `"state-v${previewState.revision}"` }
  },
  async invokeAction(action: string, input?: unknown) {
    previewState.last_message = `本地预览: 已调用 ${action} ${JSON.stringify(input ?? {})}`
    return { result: { status: 'succeeded' as const, message: previewState.last_message } }
  },
  async refresh() {
    return previewState
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
                      pluginId: 'chase.rs',
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
