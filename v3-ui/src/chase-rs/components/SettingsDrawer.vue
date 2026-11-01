<script setup lang="ts">
// 设置抽屉：12 项用户配置。
//
// 数据只有一份 —— ctx.settings（宿主插件 KV 的 `settings` 键）：页面读写的就是宿主
// 「管理」页那份表单的同一份数据，不另存一份，免得两处不一致。
// 保存只提交被改动的键（白名单逐键合并在插件 lib/settings.js 里做）。

import { computed, reactive, watch } from 'vue'
import { NButton } from 'naive-ui'
import { X } from '@lucide/vue'
import { useChaseStore } from '../use-chase'
import type { FlatSettings, FormField } from '../types'

const store = useChaseStore()

const FIELDS: FormField[] = [
  { key: 'enabled', label: '启用插件', kind: 'boolean', help: '关掉后整点任务与「立即对齐」都不写入。' },
  {
    key: 'auto_bump',
    label: '自动补订',
    kind: 'boolean',
    help: '关掉后整点任务只判定不补订（立即对齐不受限）；缺字段的旧值按开着处理。',
  },
  {
    key: 'emby_proxy_id',
    label: 'Emby 实例',
    kind: 'instance',
    help: '-1 = 跟随宿主默认实例；0 = 旧版单实例（调用不带 proxy_id）。',
  },
  { key: 'max_patch_per_run', label: '单轮最多补订（条）', kind: 'number', help: '后端硬上限 20。' },
  { key: 'max_raise_per_run', label: '单条最大抬升（集）', kind: 'number', help: '超出视为元数据异常，跳过。' },
  { key: 'dry_run', label: '只判定不写入', kind: 'boolean', help: 'dry-run: 结果表会标「待补订」。' },
  {
    key: 'write_episode_strings',
    label: '写回集数字符串',
    kind: 'boolean',
    help: '仅在原串能严格解析且逐字节往返一致时才追加。',
  },
  { key: 'report_enabled', label: '发送每日报告', kind: 'boolean', help: '' },
  { key: 'report_hour', label: '发送小时（本地）', kind: 'number', help: '到点后当天首次运行发送, 每天最多一条。' },
  { key: 'report_tz_offset_minutes', label: '时区偏移（分钟）', kind: 'number', help: '+08:00 = 480。' },
  { key: 'catch_up_days', label: '日历窗口（天）', kind: 'number', help: '' },
  {
    key: 'emby_probe_budget',
    label: 'Emby 探测预算（次/轮）',
    kind: 'number',
    help: 'Emby 覆盖与 TMDB 目标共用这份预算（整点任务）。',
  },
]

const form = reactive<FlatSettings>({ ...store.settings })
const baseline = reactive<FlatSettings>({ ...store.settings })

/** 把当前设置灌进表单（打开抽屉、或设置变化后）。 */
function syncForm(): void {
  Object.assign(form, store.settings)
  Object.assign(baseline, store.settings)
}

watch(
  () => store.drawerOpen,
  (open) => {
    if (open) syncForm()
  },
)

// 实例列表变了以后，保留仍然存在的选择；原来的实例没了就回到「跟随宿主默认」。
watch(
  () => store.instanceOptions.map((option) => option.value),
  (values) => {
    if (!values.includes(form.emby_proxy_id)) form.emby_proxy_id = -1
  },
)

/** 只提交被改动的键。 */
const changedKeys = computed(() => {
  const keys: (keyof FlatSettings)[] = []
  for (const field of FIELDS) {
    const next = form[field.key]
    const before = baseline[field.key]
    if (field.kind === 'number' ? Number(next) !== Number(before) : next !== before) {
      keys.push(field.key)
    }
  }
  return keys
})

async function save(): Promise<void> {
  if (changedKeys.value.length === 0) {
    store.toast('info', '没有改动')
    return
  }
  const payload: Partial<FlatSettings> = {}
  for (const key of changedKeys.value) {
    const value = form[key]
    payload[key] = (typeof value === 'number' ? Number(value) : value) as never
  }
  await store.saveSettings(payload)
}
</script>

<template>
  <div v-if="store.drawerOpen" class="c-overlay" @click.self="store.closeSettings()">
    <div class="c-drawer" role="dialog" aria-label="追剧管家设置">
      <div class="c-drawer-head">
        <h3>追剧管家设置</h3>
        <NButton class="c-icon-btn" quaternary circle aria-label="关闭" title="关闭" @click="store.closeSettings()">
          <template #icon><X :size="16" aria-hidden="true" /></template>
        </NButton>
      </div>

      <div class="c-drawer-body">
        <label v-for="field in FIELDS" :key="field.key" class="c-form-row">
          <span class="c-form-label">{{ field.label }}</span>
          <input
            v-if="field.kind === 'boolean'"
            type="checkbox"
            :id="`chase3-setting-${field.key}`"
            v-model="form[field.key]"
          />
          <input
            v-else-if="field.kind === 'number'"
            type="number"
            :id="`chase3-setting-${field.key}`"
            v-model.number="form[field.key]"
          />
          <select
            v-else
            :id="`chase3-setting-${field.key}`"
            v-model.number="form.emby_proxy_id"
          >
            <option
              v-for="option in store.instanceOptions"
              :key="option.value"
              :value="option.value"
              :disabled="option.disabled"
            >
              {{ option.label }}
            </option>
          </select>
          <span v-if="field.help" class="c-form-help">{{ field.help }}</span>
        </label>
      </div>

      <div class="c-drawer-foot">
        <div class="alert alert-info c-changed">
          {{
            changedKeys.length > 0
              ? `将提交改动: ${changedKeys.join(', ')}`
              : '没有改动: 保存只提交被改动的键, 其余保持原值。'
          }}
        </div>
        <div class="c-drawer-buttons">
          <NButton size="small" @click="store.closeSettings()">取消</NButton>
          <NButton size="small" type="primary" :disabled="changedKeys.length === 0" @click="save">保存</NButton>
        </div>
      </div>
    </div>
  </div>
</template>
