// 本地预览入口(仅本地 `npm run dev` / 类型检查用)。
//
// 签名包加载的是 manifest.template.json 里声明的 Federation 模块 `./AppPage`,
// **不会**执行这个文件 —— 这里只是给出一份与宿主同形的 `props.api` 替身,
// 让页面在没有宿主时也能跑起来看样式(空状态、错误态都是真状态, 不造假数据)。
//
// previewState 的字段形状严格按 src/chase-state.ts 的真实契约(逐键对应运行时
// `plugins/chase-rs/src/model.rs` 的 StateDoc): 对齐行覆盖 已补订 / 无缺口 /
// 无缺口+复用缓存 / 目标未知 / Emby 无此剧 / 失败 / 待探测 全部徽标, 复用行
// reason 带运行时固定措辞「本轮复用缓存」(runtime.rs:1535), 计数口径与界面一致。
import { createApp, defineComponent, h, reactive } from 'vue'
import { NConfigProvider, NDialogProvider, NMessageProvider, NNotificationProvider } from 'naive-ui'
import AppPage from './AppPage.vue'
import './preview.css'

/** 预览用的"今天/明天"(+08:00 本地日, 与运行时 clock::local_date 同义)—— 让「今天」chip 永远高亮。 */
const previewDay = (offsetDays: number): string =>
  new Date(Date.now() + 480 * 60_000 + offsetDays * 86_400_000).toISOString().slice(0, 10)

const today = previewDay(0)
const yesterday = previewDay(-1)

const previewState = reactive({
  schema_version: 1,
  revision: 42,
  status: 'accepted',
  last_message: '对齐完成: 订阅 7 条, 判定 7 条, 补订 1 条, 跳过 4 条, 失败 1 条, 未收录 1 条, 待探测 1 条',
  last_run: `${today}T04:00:00Z`,
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
    probe: { emby_episodes_shape: 'series.stats-map', air_calendar_shape: 'array day-groups' },
  },
  align: {
    last_run_at: `${today}T04:00:00Z`,
    pages: 1,
    intents_seen: 7,
    matched: 7,
    patched: 1,
    skipped: 4,
    failed: 1,
    absent: 1,
    pending_probe: 1,
    last_error: '',
    items: [
      // 已补订(绿): Emby 已有 16 集、订阅从 10 抬到 16, 补订后缺口归零
      {
        intent_id: 41,
        tmdb_id: 1396,
        season: 1,
        title: '流浪地球编年史',
        total_known: 16,
        emby_have_max: 16,
        emby_have_count: 16,
        gap_max: 0,
        target_upper: 16,
        target_known: true,
        from_total: 10,
        to_total: 16,
        action: 'patched',
        reason: '抬升 10 → 16 集(TMDB 目标 16 集)',
        at: `${today}T04:00:31Z`,
      },
      // 无缺口(灰) + 复用缓存(紫): 复用行的 reason 以原「无缺口」开头、固定带「本轮复用缓存」
      {
        intent_id: 42,
        tmdb_id: 1399,
        season: 1,
        title: '漫长的季节',
        total_known: 12,
        emby_have_max: 12,
        emby_have_count: 12,
        gap_max: 0,
        target_upper: 12,
        target_known: true,
        from_total: 12,
        to_total: 12,
        action: 'skipped',
        reason: '无缺口: 订阅 12 集, Emby 已有 12 集, TMDB 目标 12 集(5 小时窗口内已核实, 本轮复用缓存, 不重复探测 Emby)',
        at: `${yesterday}T23:00:02Z`,
      },
      // 无缺口(灰): 本轮真探过的一行
      {
        intent_id: 43,
        tmdb_id: 1400,
        season: 1,
        title: '三体',
        total_known: 30,
        emby_have_max: 30,
        emby_have_count: 30,
        gap_max: 0,
        target_upper: 30,
        target_known: true,
        from_total: 30,
        to_total: 30,
        action: 'skipped',
        reason: '无缺口: 订阅 30 集, Emby 已有 30 集, TMDB 目标 30 集',
        at: `${today}T04:00:11Z`,
      },
      // 目标未知(蓝): 覆盖已核实但 TMDB 该季集数没取到 —— 不是无缺口
      {
        intent_id: 44,
        tmdb_id: 1401,
        season: 1,
        title: '深海回响',
        total_known: 20,
        emby_have_max: 9,
        emby_have_count: 9,
        gap_max: 0,
        target_upper: 0,
        target_known: false,
        from_total: 20,
        to_total: 20,
        action: 'skipped',
        reason: '覆盖已核实但目标未知: 订阅 20 集, Emby 已有 9 集, TMDB 目标 未知(该季取数失败), 未参与判定',
        at: `${today}T04:00:14Z`,
      },
      // Emby 无此剧(琥珀): 后端单独归类(failure_is_absent), 行级 action 记 failed 但徽章看措辞
      {
        intent_id: 45,
        tmdb_id: 1402,
        season: 2,
        title: '长安旧事',
        total_known: 20,
        emby_have_max: -1,
        emby_have_count: -1,
        gap_max: 0,
        target_upper: 0,
        target_known: false,
        from_total: 20,
        to_total: 20,
        action: 'failed',
        reason: 'Emby 未收录该剧/该季(非结构错误): 剧集不在实例库中',
        at: `${today}T04:00:17Z`,
      },
      // 失败(红): PATCH 超时, 缺口仍在, 下轮自动重试
      {
        intent_id: 46,
        tmdb_id: 1403,
        season: 2,
        title: '白夜之间',
        total_known: 9,
        emby_have_max: 16,
        emby_have_count: 16,
        gap_max: 7,
        target_upper: 16,
        target_known: true,
        from_total: 9,
        to_total: 9,
        action: 'failed',
        reason: 'PATCH 超时: 宿主接口 6 秒内未返回, 下轮自动重试',
        at: `${today}T04:00:20Z`,
      },
      // 待探测(缺口列蓝字「待探测」): 探测预算用尽, 本轮跳过、下轮优先
      {
        intent_id: 47,
        tmdb_id: 1404,
        season: 1,
        title: '峡谷回声',
        total_known: 6,
        emby_have_max: -1,
        emby_have_count: -1,
        gap_max: 0,
        target_upper: 0,
        target_known: false,
        from_total: 6,
        to_total: 6,
        action: 'skipped',
        reason: 'Emby 探测预算用尽(120 次 host.call): 本轮跳过, 下轮优先',
        at: `${today}T04:00:22Z`,
      },
    ],
  },
  trim_suggestions: [
    {
      intent_id: 48,
      tmdb_id: 1500,
      season: 2,
      title: '庆余年',
      total_known: 45,
      emby_have_max: 42,
      target_upper: 42,
      reason: '订阅 45 集已全部入库, 该季 TMDB 只有 42 集, 建议裁剪到 42',
      at: `${today}T04:00:31Z`,
    },
    {
      intent_id: 49,
      tmdb_id: 1501,
      season: 1,
      title: '大河之水',
      total_known: 38,
      emby_have_max: 36,
      target_upper: 36,
      reason: '订阅 38 集已全部入库, 该季 TMDB 只有 36 集, 建议裁剪到 36',
      at: `${today}T04:00:31Z`,
    },
    {
      intent_id: 50,
      tmdb_id: 1502,
      season: 1,
      title: '棋士',
      total_known: 24,
      emby_have_max: 22,
      target_upper: 22,
      reason: '订阅 24 集已全部入库, 该季 TMDB 只有 22 集, 建议裁剪到 22',
      at: `${today}T04:00:31Z`,
    },
  ],
  calendar: {
    fetched_at: `${today}T04:00:00Z`,
    days: [
      {
        date: today,
        items: [{ tmdb_id: 1400, season: 1, episode: 13, title: '三体', time: '20:00' }],
      },
      {
        date: previewDay(1),
        items: [{ tmdb_id: 1396, season: 1, episode: 9, title: '流浪地球编年史', time: '21:00' }],
      },
    ],
  },
  daily: {
    last_sent_date: today,
    last_at: `${today}T01:14:47Z`,
    last_result: 'accepted',
    last_error: '',
    sent_total: 6,
  },
  debug: {
    updated_at: `${today}T04:00:00Z`,
    emby_instances: {
      status: 'ok',
      shape: 'array instance-objects',
      params_tried: ['(无参数)'],
      http_status: 200,
      sample: '[{"id":3,"name":"客厅 (预览)","is_default":true}]',
      at: `${today}T04:00:00Z`,
    },
    emby_episodes: {
      status: 'ok',
      shape: 'series.stats-map',
      params_tried: ['include=episodeStats', 'fields=EpisodeStats'],
      http_status: 200,
      sample: '{"SeriesId":"1396","EpisodeStats":[{"EpisodeNumber":1,"HasFile":true}]}',
      at: `${today}T04:00:05Z`,
    },
    air_calendar: {
      status: 'ok',
      shape: 'array day-groups',
      params_tried: ['days=7'],
      http_status: 200,
      sample: `[{"date":"${today}","items":[{"title":"三体","episode":13,"time":"20:00"}]}]`,
      at: `${today}T04:00:06Z`,
    },
    pool_intents: {
      status: 'ok',
      shape: 'object.items-array',
      params_tried: ['page=1'],
      http_status: 200,
      sample: '{"items":[{"id":41,"title":"流浪地球编年史","total_episodes_known":16}]}',
      at: `${today}T04:00:04Z`,
    },
    tmdb_target: {
      status: 'ok',
      shape: 'object.seasons-array',
      params_tried: ['raw_episode_counts=true'],
      http_status: 200,
      sample: '{"seasons":[{"season_number":1,"episode_count":30}]}',
      at: `${today}T04:00:08Z`,
    },
    attempts: [
      { endpoint: 'emby/episodes', params: 'series=1396 include=episodeStats', http_status: 200, shape: 'series.stats-map', at: `${today}T04:00:05Z` },
      { endpoint: 'subscribe/air-calendar', params: 'days=7', http_status: 200, shape: 'array day-groups', at: `${today}T04:00:06Z` },
      { endpoint: 'tmdb/tv', params: 'id=1400 raw_episode_counts=true', http_status: 200, shape: 'object.seasons-array', at: `${today}T04:00:08Z` },
    ],
    last_errors: [
      { step: 'job.emby.episodes', message: '宿主接口超时 (HTTP 502)', at: `${yesterday}T22:00:12Z` },
    ],
  },
  stats: { tv_intents: 7, matched: 7, aligned: 1, gap_total: 7, unknown_shape: 0 },
  logs: [
    { at: `${yesterday}T22:00:12Z`, level: 'warning', message: 'job.emby.episodes: 宿主接口超时 (HTTP 502)' },
    { at: `${today}T03:00:02Z`, level: 'info', message: '对齐完成: 订阅 7 条, 判定 7 条, 补订 0 条, 跳过 6 条, 失败 0 条, 未收录 1 条, 待探测 0 条' },
    { at: `${today}T04:00:31Z`, level: 'info', message: '对齐完成: 订阅 7 条, 判定 7 条, 补订 1 条, 跳过 4 条, 失败 1 条, 未收录 1 条, 待探测 1 条' },
    { at: `${today}T04:00:31Z`, level: 'info', message: '本轮复用 1 条已核实无缺口的行(5 小时窗口内不重复探测 Emby)' },
  ],
  emby_instances: [
    { id: 3, name: '客厅 (预览)', is_default: true, key_ready: true, at: `${today}T04:00:00Z` },
  ],
})

const previewBridge = {
  async getState() {
    return { state: previewState, state_version: `state-v${previewState.revision}`, etag: `"state-v${previewState.revision}"` }
  },
  async invokeAction(action: string, input?: unknown) {
    previewState.last_message = `本地预览: 已调用 ${action} ${JSON.stringify(input ?? {})}`
    if (action === 'align-now') {
      // 与真实 align-now 返回同形(runtime.rs:2033): 让完成结果条在预览里可见
      return {
        result: {
          status: 'succeeded' as const,
          message: previewState.last_message,
          patched: 1,
          skipped: 4,
          failed: 1,
          absent: 1,
          reused: 1,
          budget_hit: false,
        },
      }
    }
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
