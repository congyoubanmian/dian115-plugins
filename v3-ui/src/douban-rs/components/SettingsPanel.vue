<script setup lang="ts">
// 设置（对应原生版的 renderSettings + saveSettings）。
//
// 六块：运行状态（只读）、基础设置、登录态、榜单配置、
// 黑名单关键词、维护（墓碑）。底部保存栏把改动交给 settings-update job ——
// 它同时写宿主 settings KV 与状态文档（榜单 lists、账号字段、过滤器、保留条数）。
//
// 表单控件用原生 input/select（与原生 JS 版一致，浏览器行为与校验语义相同），
// 颜色走宿主 CSS 变量，明暗两套主题都可读；按钮与徽标用 naive-ui，跟宿主主题走。

import { computed, reactive, ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import { COOKIE_SOURCE_LABEL, SOURCE_LABEL, TYPE_LABEL, WISH_STATUS_LABEL } from '../constants'
import { formatTime, listTitle, num, sortListKeys, splitListValue, text } from '../format'
import { defaultSettings } from '../lib-bridge'
import { useDoubanStore } from '../store'
import BlockCard from './BlockCard.vue'

const store = useDoubanStore()
const { flat, docSettings, settingsView, stateDoc, rawState, tombstones, busy } = store

const locked = computed(() => busy.value !== '')

/** 榜单配置的一行（表单态）。 */
interface ListForm {
  enabled: boolean
  source: string
  type: string
  tag: string
  sort: string
  limit: string
}

const form = reactive({
  wish: false,
  auto: false,
  notify: false,
  observe: '0',
  rating: '0',
  year: '0',
  history: '0',
  logs: '0',
  regions: '',
  sources: '',
  manual: '',
  manualClear: false,
  lists: {} as Record<string, ListForm>,
})

const keyword = ref('')

const listKeys = computed(() => Object.keys(form.lists))

/** 数据重读后把表单刷回当前值（与原生版每次 render 重建表单一致）。 */
function resetForm(): void {
  const f = flat.value
  form.wish = f.wish_sync_enabled
  form.auto = f.auto_subscribe
  form.notify = f.notify_on_subscribe
  form.observe = String(f.observe_period_hours)
  form.rating = String(f.min_rating)
  form.year = String(f.min_year)
  form.history = String(f.max_history)
  form.logs = String(f.max_logs)
  form.regions = (f.regions ?? []).join(', ')
  form.sources = (f.subscribe_source_filter ?? []).join(', ')
  form.manual = ''
  form.manualClear = false

  const defaults = defaultSettings().lists ?? {}
  const docLists = docSettings.value.lists ?? {}
  const keys = sortListKeys([...new Set([...Object.keys(defaults), ...Object.keys(docLists)])])
  const lists: Record<string, ListForm> = {}
  for (const key of keys) {
    const config = { ...(defaults[key] ?? {}), ...(docLists[key] ?? {}) }
    lists[key] = {
      // 即将上映固定启用（后端 normalize_settings 强制）。
      enabled: key === 'upcoming' ? true : Boolean(config.enabled),
      source: config.source || 'subjects_json',
      type: config.type || 'movie',
      tag: config.tag ?? '',
      sort: config.sort ?? '',
      limit: String(num(config.limit, 20)),
    }
  }
  form.lists = lists
}

watch([() => flat.value, () => docSettings.value], resetForm, { immediate: true })

/** 数字字段读取与校验（错误文案与原生版一致）。 */
function readNumber(
  raw: string,
  label: string,
  options: { fallback?: number; integer?: boolean; min?: number; max?: number },
  errors: string[],
): number {
  const value = String(raw ?? '').trim()
  if (value === '') return options.fallback ?? 0
  const parsed = Number(value)
  const min = options.min ?? 0
  const max = options.max
  if (!Number.isFinite(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    errors.push(`${label} 需为 ${min}${max !== undefined ? `~${max}` : ' 以上'} 的数字`)
    return options.fallback ?? 0
  }
  return options.integer ? Math.trunc(parsed) : parsed
}

async function save(): Promise<void> {
  if (locked.value) return
  const errors: string[] = []
  const patch: Record<string, unknown> = {
    wish_sync_enabled: form.wish,
    auto_subscribe: form.auto,
    notify_on_subscribe: form.notify,
    observe_period_hours: readNumber(
      form.observe,
      '观察期',
      { fallback: flat.value.observe_period_hours, integer: true, min: 0, max: 8760 },
      errors,
    ),
    min_rating: readNumber(form.rating, '最低评分', { fallback: flat.value.min_rating, min: 0, max: 10 }, errors),
    min_year: readNumber(form.year, '最低年份', { fallback: flat.value.min_year, integer: true, min: 0, max: 3000 }, errors),
    max_history: readNumber(form.history, '历史保留条数', { fallback: flat.value.max_history, integer: true, min: 0 }, errors),
    max_logs: readNumber(form.logs, '日志保留条数', { fallback: flat.value.max_logs, integer: true, min: 0 }, errors),
    regions: splitListValue(form.regions),
    subscribe_source_filter: splitListValue(form.sources),
    lists: {},
  }

  const lists: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(form.lists)) {
    const fallbackLimit = num(docSettings.value.lists?.[key]?.limit, 20)
    lists[key] = {
      enabled: entry.enabled,
      source: entry.source,
      type: entry.type,
      tag: entry.tag.trim(),
      sort: entry.sort.trim(),
      limit: readNumber(entry.limit, `${listTitle(key)}条数`, { fallback: fallbackLimit, integer: true, min: 0, max: 200 }, errors),
    }
  }
  patch.lists = lists

  if (form.manual !== '') patch.manual_cookie = form.manual.trim()
  else if (form.manualClear) patch.manual_cookie = ''

  if (errors.length > 0) {
    store.toast('error', errors.join('；'))
    return
  }
  await store.saveSettings(patch)
}

function addKeyword(): void {
  const value = keyword.value.trim()
  if (value === '') {
    store.toast('warning', '关键词不能为空')
    return
  }
  void store.runAction('blacklist-add', { keyword: value }, { label: `添加黑名单「${value}」` })
}

function removeKeyword(word: string): void {
  void store.runAction('blacklist-remove', { keyword: word }, { label: `移除黑名单「${word}」` })
}

function clearTombstones(): void {
  void store.runAction('no-resub-clear', {}, {
    label: '清除重订限制',
    confirm: `将清除 ${tombstones.value.length} 条「已删除不重订」墓碑，之后自动订阅可能重新订阅这些条目。继续吗？`,
  })
}

/** 下拉里没有当前值时补一个「未知：x」，与原生版一致。 */
function sourceOptions(current: string): Array<[string, string]> {
  const options: Array<[string, string]> = [
    ['subjects_json', SOURCE_LABEL.subjects_json],
    ['coming_html', SOURCE_LABEL.coming_html],
    ['chart_html', SOURCE_LABEL.chart_html],
  ]
  if (!options.some(([value]) => value === current)) options.unshift([current, `未知：${current}`])
  return options
}

function typeOptions(current: string): Array<[string, string]> {
  const options: Array<[string, string]> = [
    ['movie', TYPE_LABEL.movie],
    ['tv', TYPE_LABEL.tv],
  ]
  if (!options.some(([value]) => value === current)) options.unshift([current, `未知：${current}`])
  return options
}

/**
 * 下拉框改值。
 *
 * 这里不用 v-model：v-model 会让 Vue 挂 vModelSelect 指令，它在挂载/更新时要读
 * `select.options`（真实浏览器有，最小 DOM 垫片没有），页面在垫片里会抛错。
 * 改成「:value 绑定 + @change 回写 + option 上标 selected」，浏览器里的表现一致。
 */
function onListFieldChange(key: string, field: 'source' | 'type', event: Event): void {
  const target = event.target as HTMLSelectElement | null
  const entry = form.lists[key]
  if (!entry || !target) return
  entry[field] = target.value ?? ''
}

/** 文本/数字输入框改值（同样不用 v-model，原因见 onListFieldChange）。 */
type TextField =
  | 'observe'
  | 'rating'
  | 'year'
  | 'history'
  | 'logs'
  | 'regions'
  | 'sources'
  | 'manual'

function onFieldInput(field: TextField, event: Event): void {
  const target = event.target as HTMLInputElement | null
  if (!target) return
  form[field] = target.value ?? ''
}

/** 榜单配置表格里的输入框（同样不用 v-model）。 */
function onListInput(key: string, field: 'tag' | 'sort' | 'limit', event: Event): void {
  const target = event.target as HTMLInputElement | null
  const entry = form.lists[key]
  if (!entry || !target) return
  entry[field] = target.value ?? ''
}

/** 黑名单关键词输入框。 */
function onKeywordInput(event: Event): void {
  const target = event.target as HTMLInputElement | null
  if (!target) return
  keyword.value = target.value ?? ''
}
</script>

<template>
  <div class="db-settings">
    <!-- 运行状态 -->
    <BlockCard title="运行状态" subtitle="只读：来自存储 state 键与宿主设置 KV；不显示 cookie 明文。">
      <div class="db-kv-grid">
        <div class="db-kv">
          <span class="db-kv__label">快照时间</span>
          <span class="db-kv__value">{{ formatTime(stateDoc?.snapshot?.fetched_at) || '尚未刷新' }}</span>
        </div>
        <div class="db-kv">
          <span class="db-kv__label">最后刷新</span>
          <span class="db-kv__value">{{ formatTime(rawState?.last_run) || '—' }}</span>
        </div>
        <div class="db-kv">
          <span class="db-kv__label">上次归档</span>
          <span class="db-kv__value">{{ formatTime(stateDoc?.stats?.last_archive_at) || '—' }}</span>
        </div>
        <div class="db-kv">
          <span class="db-kv__label">想看同步</span>
          <span class="db-kv__value">
            {{ stateDoc?.wish_info?.last_status ? `${WISH_STATUS_LABEL[stateDoc.wish_info.last_status] ?? stateDoc.wish_info.last_status} · ${formatTime(stateDoc.wish_info.last_sync) || '—'}` : '未同步' }}
          </span>
        </div>
        <div class="db-kv">
          <span class="db-kv__label">登录态缓存</span>
          <span class="db-kv__value">
            {{ stateDoc?.cookie?.source ? `${COOKIE_SOURCE_LABEL[stateDoc.cookie.source] ?? stateDoc.cookie.source} · uid=${text(stateDoc.cookie.uid) || '—'} · ${formatTime(stateDoc.cookie.fetched_at) || '—'}` : '无（下次刷新/同步时获取）' }}
          </span>
        </div>
        <div class="db-kv">
          <span class="db-kv__label">墓碑扫描</span>
          <span class="db-kv__value">{{ formatTime(stateDoc?.no_resub_scan_at) || '未扫描' }}</span>
        </div>
        <div class="db-kv">
          <span class="db-kv__label">状态文档</span>
          <span class="db-kv__value">
            {{ store.stateInvalid.value ? '无法识别' : stateDoc ? '已加载' : '空（全新安装）' }}
          </span>
        </div>
        <div class="db-kv">
          <span class="db-kv__label">存储 revision</span>
          <span class="db-kv__value">由宿主管理（页面按 value 读取）</span>
        </div>
      </div>
    </BlockCard>

    <!-- 基础设置 -->
    <BlockCard title="基础设置" subtitle="保存时经 settings-update job 同时写入宿主 settings KV 与状态文档。">
      <div class="db-form-grid">
        <label class="db-switch-row">
          <span class="db-switch-text">
            <span class="db-field-label">同步我的想看</span>
            <span class="db-field-help">从豆瓣拉取 kind=mark（电影 + 剧集）</span>
          </span>
          <span class="db-switch">
            <input v-model="form.wish" type="checkbox" aria-label="同步我的想看" />
            <span class="db-track" />
          </span>
        </label>
        <label class="db-switch-row">
          <span class="db-switch-text">
            <span class="db-field-label">想看新条目直接订阅</span>
            <span class="db-field-help">开：新加入的想看跳过观察期，由后台任务尽快订阅；关：先观察一段时间再订阅。榜单条目始终先观察</span>
          </span>
          <span class="db-switch">
            <input v-model="form.auto" type="checkbox" aria-label="想看新条目直接订阅" />
            <span class="db-track" />
          </span>
        </label>
        <label class="db-switch-row">
          <span class="db-switch-text">
            <span class="db-field-label">订阅成功发通知</span>
            <span class="db-field-help">经宿主通知渠道推送</span>
          </span>
          <span class="db-switch">
            <input v-model="form.notify" type="checkbox" aria-label="订阅成功发通知" />
            <span class="db-track" />
          </span>
        </label>

        <label class="db-field">
          <span class="db-field-label">观察期（小时）</span>
          <input :value="form.observe" @input="onFieldInput('observe', $event)" class="db-input" type="number" min="0" step="1" aria-label="观察期（小时）" />
          <span class="db-field-help">0 按榜单默认 24 小时；想看路径 0 表示立即到期</span>
        </label>
        <label class="db-field">
          <span class="db-field-label">最低豆瓣评分</span>
          <input :value="form.rating" @input="onFieldInput('rating', $event)" class="db-input" type="number" min="0" max="10" step="0.1" aria-label="最低豆瓣评分" />
          <span class="db-field-help">0 = 不限；无评分条目会被过滤</span>
        </label>
        <label class="db-field">
          <span class="db-field-label">最低年份</span>
          <input :value="form.year" @input="onFieldInput('year', $event)" class="db-input" type="number" min="0" step="1" aria-label="最低年份" />
          <span class="db-field-help">0 = 不限；口碑榜/即将上映多数没有年份</span>
        </label>
        <label class="db-field">
          <span class="db-field-label">历史保留条数</span>
          <input :value="form.history" @input="onFieldInput('history', $event)" class="db-input" type="number" min="0" step="1" aria-label="历史保留条数" />
          <span class="db-field-help">后端按此裁剪 history</span>
        </label>
        <label class="db-field">
          <span class="db-field-label">日志保留条数</span>
          <input :value="form.logs" @input="onFieldInput('logs', $event)" class="db-input" type="number" min="0" step="1" aria-label="日志保留条数" />
          <span class="db-field-help">后端按此裁剪 logs</span>
        </label>
        <label class="db-field">
          <span class="db-field-label">地区白名单</span>
          <input :value="form.regions" @input="onFieldInput('regions', $event)" class="db-input" type="text" placeholder="例如 中国大陆, 美国, 日本" aria-label="地区白名单" />
          <span class="db-field-help">逗号/顿号分隔；只在已取到豆瓣详情（countries）时生效</span>
        </label>
        <label class="db-field">
          <span class="db-field-label">订阅来源过滤</span>
          <input :value="form.sources" @input="onFieldInput('sources', $event)" class="db-input" type="text" placeholder="例如 115, mteam（留空 = 宿主默认）" aria-label="订阅来源过滤" />
          <span class="db-field-help">写入聚合订阅的 enabled_sources；留空 = 宿主默认来源</span>
        </label>
      </div>
    </BlockCard>

    <!-- 登录态：只保留手动 Cookie（宿主新规约禁止插件读 CookieCloud） -->
    <BlockCard title="登录态" subtitle="粘贴浏览器里的豆瓣 Cookie（需含 dbcl2）；插件不读取 CookieCloud。">
      <div class="db-form-grid">
        <div class="db-field">
          <span class="db-field-label">手动豆瓣 Cookie（可选）</span>
          <input
            :value="form.manual" @input="onFieldInput('manual', $event)"
            class="db-input"
            type="password"
            autocomplete="new-password"
            :placeholder="flat.manual_cookie !== '' || settingsView?.cc_manual_set ? '已配置，留空保持不变' : '未配置'"
            aria-label="手动豆瓣 Cookie（可选）"
          />
          <label class="db-clear">
            <input v-model="form.manualClear" type="checkbox" />
            清除已保存的值
          </label>
          <span class="db-field-help">整段 cookie 头或仅 dbcl2=xxx；</span>
        </div>
      </div>
      <p class="db-note">
        插件不读取 CookieCloud（宿主新规约），登录态只来自这里粘贴的内容；粘贴的 cookie 不会回显。
      </p>
    </BlockCard>

    <!-- Telegram 指令（清单 events[]：message / commands / channels:["telegram"]） -->
    <BlockCard title="Telegram 指令" subtitle="向宿主 Telegram 机器人发送指令即可触发；只响应 Telegram，企业微信不触发。">
      <div class="db-kv-grid">
        <div class="db-kv">
          <span class="db-kv__label"><code class="db-mono">/refresh</code></span>
          <span class="db-kv__value">刷新榜单：抓榜 → 黑名单入队 → 到期订阅 → 想看同步，完成后回执摘要</span>
        </div>
        <div class="db-kv">
          <span class="db-kv__label"><code class="db-mono">/wish</code></span>
          <span class="db-kv__value">同步「我的想看」并处理到期条目，回执同步条数与结果</span>
        </div>
        <div class="db-kv">
          <span class="db-kv__label">海报缓存</span>
          <span class="db-kv__value">插件文件 posters/（最多 64 张，按修改时间淘汰最旧；卸载即清空）</span>
        </div>
      </div>
      <p class="db-note">
        指令触发无需授权；回执需在插件卡片上开启「telegram.bot」权限，未开启时任务照常执行、结果见任务记录。
      </p>
    </BlockCard>

    <!-- 榜单配置 -->
    <BlockCard title="榜单配置" subtitle="嵌套配置留在状态文档；enabled=false 的榜单下一轮刷新会跳过。">
      <div class="db-scroll db-scroll--table">
        <table class="db-table db-table--form">
          <thead>
            <tr>
              <th>启用</th>
              <th>榜单</th>
              <th>来源</th>
              <th>类型</th>
              <th>标签</th>
              <th>排序</th>
              <th>条数</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="key in listKeys"
              :key="key"
              :class="{ 'db-row-locked': key === 'upcoming' }"
            >
              <td data-label="启用">
                <div class="db-cell-value">
                  <input
                    v-model="form.lists[key].enabled"
                    type="checkbox"
                    :aria-label="`启用 ${listTitle(key)}`"
                    :disabled="key === 'upcoming'"
                    :title="key === 'upcoming' ? '即将上映榜单固定启用（后端 normalize_settings 强制）' : undefined"
                  />
                </div>
              </td>
              <td data-label="榜单">
                <div class="db-cell-value">
                  <strong>{{ listTitle(key) }}</strong>
                  <div class="db-mono db-sub">{{ key }}</div>
                </div>
              </td>
              <td data-label="来源">
                <div class="db-cell-value">
                  <select
                    class="db-select"
                    :value="form.lists[key].source"
                    :aria-label="`${listTitle(key)}来源`"
                    :disabled="key === 'upcoming'"
                    @change="onListFieldChange(key, 'source', $event)"
                  >
                    <option
                      v-for="[value, label] in sourceOptions(form.lists[key].source)"
                      :key="value"
                      :value="value"
                      :selected="form.lists[key].source === value"
                    >
                      {{ label }}
                    </option>
                  </select>
                </div>
              </td>
              <td data-label="类型">
                <div class="db-cell-value">
                  <select
                    class="db-select"
                    :value="form.lists[key].type"
                    :aria-label="`${listTitle(key)}类型`"
                    :disabled="key === 'upcoming'"
                    @change="onListFieldChange(key, 'type', $event)"
                  >
                    <option
                      v-for="[value, label] in typeOptions(form.lists[key].type)"
                      :key="value"
                      :value="value"
                      :selected="form.lists[key].type === value"
                    >
                      {{ label }}
                    </option>
                  </select>
                </div>
              </td>
              <td data-label="标签">
                <div class="db-cell-value">
                  <input
                    :value="form.lists[key].tag" @input="onListInput(key, 'tag', $event)"
                    class="db-input"
                    type="text"
                    placeholder="热门 / 国产剧 / 欧美"
                    :aria-label="`${listTitle(key)}标签`"
                    :disabled="key === 'upcoming'"
                  />
                </div>
              </td>
              <td data-label="排序">
                <div class="db-cell-value">
                  <input
                    :value="form.lists[key].sort" @input="onListInput(key, 'sort', $event)"
                    class="db-input"
                    type="text"
                    placeholder="recommend"
                    :aria-label="`${listTitle(key)}排序`"
                    :disabled="key === 'upcoming'"
                  />
                </div>
              </td>
              <td data-label="条数">
                <div class="db-cell-value">
                  <input
                    :value="form.lists[key].limit" @input="onListInput(key, 'limit', $event)"
                    class="db-input"
                    type="number"
                    min="0"
                    max="200"
                    step="1"
                    :aria-label="`${listTitle(key)}条数`"
                  />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="db-note">即将上映固定 coming_html / movie / 启用；后端保存时会再次强制。</p>
    </BlockCard>

    <!-- 黑名单 -->
    <BlockCard title="黑名单关键词" subtitle="按标题子串匹配；添加/移除立即落盘（不随下面的保存按钮）。">
      <div class="db-chips">
        <span v-if="(docSettings.blacklist ?? []).length === 0" class="db-empty-note">还没有关键词。</span>
        <span v-for="word in docSettings.blacklist ?? []" :key="word" class="db-chip">
          {{ word }}
          <button
            type="button"
            class="db-chip-x"
            :title="`移除 ${word}`"
            :disabled="locked"
            data-busy-lock="1"
            :aria-label="`移除黑名单关键词 ${word}`"
            @click="removeKeyword(word)"
          >×</button>
        </span>
      </div>
      <div class="db-inline-form">
        <input
          :value="keyword" @input="onKeywordInput($event)"
          class="db-input"
          type="text"
          placeholder="输入关键词"
          aria-label="黑名单关键词"
          @keydown.enter.prevent="addKeyword"
        />
        <NButton size="small" type="primary" :disabled="locked" data-busy-lock="1" @click="addKeyword">
          添加
        </NButton>
      </div>
      <p class="db-note">
        累计命中 {{ num(stateDoc?.blackstate?.hits) }} 次；命中记录在「历史与日志」里查看。
      </p>
    </BlockCard>

    <!-- 维护 -->
    <BlockCard title="维护" subtitle="墓碑集是「已删除不重订」；归档不会清它，只能在这里显式清除。">
      <p class="db-note">
        重订墓碑 {{ tombstones.length }} 条；上次扫描：{{ formatTime(stateDoc?.no_resub_scan_at) || '未扫描' }}。
      </p>
      <div v-if="tombstones.length > 0" class="db-scroll db-tomb-scroll">
        <div class="db-tomb-list">
          <div v-for="[ref, entry] in tombstones.slice(0, 100)" :key="ref" class="db-tomb-row">
            <span class="db-mono">{{ ref }}</span>
            <span>{{ text(entry?.reason) || '宿主已无该 tmdb 订阅' }}</span>
            <span class="db-sub db-nowrap">{{ formatTime(entry?.at) || '—' }}</span>
          </div>
        </div>
      </div>
      <p v-if="tombstones.length > 100" class="db-note">只显示前 100 条（共 {{ tombstones.length }} 条）。</p>
      <div class="db-inline-actions">
        <NButton size="small" type="error" secondary :disabled="locked" data-busy-lock="1" @click="clearTombstones">
          清除重订限制
        </NButton>
        <NButton
          size="small"
          secondary
          :disabled="locked"
          data-busy-lock="1"
          @click="store.runAction('send-test', {})"
        >
          通知自检
        </NButton>
      </div>
    </BlockCard>

    <!-- 保存栏 -->
    <div class="db-savebar">
      <span class="db-save-hint">改完点保存；账号口令留空 = 保持原值，勾选「清除」才会删除。</span>
      <NButton size="small" quaternary :disabled="locked" data-busy-lock="1" @click="store.refreshUi()">
        重新读取
      </NButton>
      <NButton size="small" type="primary" :disabled="locked" data-busy-lock="1" @click="save">
        保存设置
      </NButton>
    </div>
  </div>
</template>

<style scoped>
.db-settings {
  display: grid;
  gap: 14px;
}

.db-kv-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 8px 14px;
}

.db-kv {
  display: grid;
  gap: 1px;
  min-width: 0;
}

.db-kv__label {
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 11px;
}

.db-kv__value {
  font-size: 12px;
  overflow-wrap: anywhere;
}

.db-form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
  gap: 12px 16px;
}

.db-field {
  display: grid;
  gap: 5px;
  min-width: 0;
  align-content: start;
}

.db-field-label {
  font-size: 12px;
  font-weight: 600;
}

.db-field-help {
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 11px;
  overflow-wrap: anywhere;
}

.db-input,
.db-select {
  width: 100%;
  min-height: 36px;
  padding: 7px 9px;
  border-radius: 9px;
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  background: var(--app-bg, #fff);
  color: var(--app-text, #1f2329);
  font: inherit;
  font-size: 13px;
}

.db-input:focus-visible,
.db-select:focus-visible {
  outline: 2px solid var(--db-accent, #2080f0);
  outline-offset: 1px;
  border-color: var(--db-accent, #2080f0);
}

.db-input:disabled,
.db-select:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}

.db-switch-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 11px;
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  border-radius: 10px;
  cursor: pointer;
}

.db-switch-text {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.db-switch {
  position: relative;
  width: 40px;
  height: 22px;
  flex: none;
  margin-top: 2px;
}

.db-switch input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  margin: 0;
  cursor: pointer;
  z-index: 1;
}

.db-track {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: var(--db-line, var(--app-border, #e3e6eb));
  transition: background-color 0.15s ease;
}

.db-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgb(0 0 0 / 20%);
  transition: transform 0.15s ease;
}

.db-switch input:checked + .db-track {
  background: var(--db-accent, #2080f0);
}

.db-switch input:checked + .db-track::after {
  transform: translateX(18px);
}

.db-switch input:focus-visible + .db-track {
  outline: 2px solid var(--db-accent, #2080f0);
  outline-offset: 2px;
}

.db-clear {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 11px;
}

.db-clear input {
  width: 14px;
  height: 14px;
}

.db-scroll {
  overflow: auto;
  max-width: 100%;
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  border-radius: 10px;
}

.db-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  min-width: 720px;
}

.db-table th,
.db-table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  vertical-align: top;
}

.db-table th {
  position: sticky;
  top: 0;
  background: var(--app-surface, #fff);
  font-weight: 600;
  white-space: nowrap;
  z-index: 1;
}

.db-table tr:last-child td {
  border-bottom: none;
}

.db-table--form td {
  padding: 6px 8px;
  vertical-align: middle;
}

.db-table--form .db-input,
.db-table--form .db-select {
  min-height: 30px;
  padding: 4px 7px;
  font-size: 12px;
  width: 100%;
  min-width: 92px;
}

.db-table--form td:first-child {
  width: 44px;
}

.db-row-locked {
  background: color-mix(in srgb, var(--db-warn, #f0a020) 5%, transparent);
}

.db-nowrap {
  white-space: nowrap;
}

.db-sub {
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 11px;
  margin-top: 2px;
  overflow-wrap: anywhere;
}

.db-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
}

.db-chips {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.db-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 4px 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  font-size: 12px;
  background: color-mix(in srgb, var(--app-bg, #f5f6f8) 40%, transparent);
}

.db-chip-x {
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.db-chip-x:hover:not(:disabled) {
  color: var(--db-err, #d03050);
  background: color-mix(in srgb, var(--db-err, #d03050) 10%, transparent);
}

.db-inline-form {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.db-inline-form .db-input {
  flex: 1 1 220px;
  width: auto;
}

.db-inline-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.db-note {
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 11px;
  overflow-wrap: anywhere;
  margin: 0;
}

.db-empty-note {
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 11px;
}

.db-tomb-scroll {
  max-height: 260px;
}

.db-tomb-list {
  display: grid;
  gap: 6px;
}

.db-tomb-row {
  display: grid;
  grid-template-columns: minmax(120px, 0.9fr) minmax(0, 1.4fr) auto;
  gap: 10px;
  padding: 7px 9px;
  border-bottom: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  font-size: 12px;
}

.db-tomb-row:last-child {
  border-bottom: none;
}

.db-savebar {
  position: sticky;
  bottom: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-surface, #fff) 92%, transparent);
  backdrop-filter: blur(10px);
}

.db-save-hint {
  margin-right: auto;
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 11px;
}

/* 窄容器：榜单配置表改成逐条卡片，输入控件不再按 92px 最小宽撑开。 */
@container page (max-width: 719.98px) {
  .db-scroll--table {
    overflow: visible;
    border: 0;
  }

  .db-table.db-table {
    display: block;
    min-width: 0;
  }

  .db-table.db-table thead {
    display: none;
  }

  .db-table.db-table tbody {
    display: block;
  }

  .db-table.db-table tr {
    display: block;
    padding: 8px 0;
    border-bottom: 1px solid var(--db-line, var(--ui-border, #e3e6eb));
  }

  .db-table.db-table tr:last-child {
    border-bottom: 0;
  }

  .db-table.db-table td {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr);
    column-gap: 8px;
    padding: 3px 0;
    border: 0;
  }

  .db-table.db-table td::before {
    content: attr(data-label);
    grid-column: 1;
    grid-row: 1;
    color: var(--db-muted, var(--ui-muted, #6b7280));
    font-size: 11px;
  }

  .db-table.db-table td > .db-cell-value {
    grid-column: 2;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .db-cell-value > * {
    overflow-wrap: anywhere;
  }

  .db-table--form td .db-input,
  .db-table--form td .db-select {
    width: 100%;
    min-width: 0;
  }

  .db-table--form td:first-child {
    width: auto;
  }

  .db-table--form td:first-child > .db-cell-value {
    display: flex;
    align-items: center;
  }
}
</style>
