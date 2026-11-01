<script setup lang="ts">
// 设置分页：与宿主「管理」页同一份设置（ctx.settings.get/set），页面改的就是那一份。
//
// 用户没在编辑时，表单跟随读回来的设置；一旦改过就不再被刷新覆盖（原生版 dirtySettings 同语义）。
// 撤销改动 = 把表单恢复成当前生效值。

import { computed, ref, watch } from 'vue'
import { NButton, NInput, NSwitch } from 'naive-ui'
import { Send as SendIcon } from '@lucide/vue'
import { ALL_QUALITIES, useMusicStore } from '../store'
import { MAX_ACTIVE_CAP } from '../plugin-api'

const store = useMusicStore()
const { settings, busy, notifyResult } = store

// 长文案放脚本常量：一整段连续静态元素会被 Vue 编译成 static vnode，走
// insertStaticContent（需要 DOM 的 template.content），离线冒烟用的最小 DOM 垫片没有它。
// 用插值渲染就没有这个问题（文本仍由同一份常量提供）。
const COOKIE_CLOUD_HINT =
  'v3 用宿主统一配置的 CookieCloud 服务（不再在插件里填地址/UUID/口令）；点登录卡「CookieCloud 同步」拉取网易云与 ' +
  'QQ 域的登录 Cookie。115 相关域名按宿主策略不可读写。'
const STORAGE_HINT =
  '下载先落插件自有暂存目录 downloads/<短id>.part（宿主流式写盘），定名后由宿主 move 进目标目录——「本地暂存目录 ' +
  'staging_dir」与「CD2 直送」设置项随 v3 文件模型移除。'
const NOTIFY_TEST_HINT =
  '主动发一条 info 通知；v3 宿主支持 callback_data 按钮，失败通知的「重试」按钮直达 Telegram 回调。'

const targetDir = ref('')
const quality = ref('')
/** 原生 number 输入框的值是字符串，比较/保存时再转数字（同原生页面语义）。 */
const maxActive = ref('2')
const notifyOnFail = ref(true)
/** 用户是否动过表单：只有用户改动才停止跟随刷新，初始值填充不算改动。 */
const edited = ref(false)

const dirty = computed(
  () =>
    targetDir.value.trim() !== settings.value.target_dir ||
    quality.value !== settings.value.quality ||
    Number(maxActive.value) !== settings.value.max_active ||
    notifyOnFail.value !== settings.value.notify_on_fail,
)

function markEdited(): void {
  edited.value = true
}

// 设置读回来后，没在编辑就同步进表单。
watch(
  settings,
  (next) => {
    if (edited.value) return
    targetDir.value = next.target_dir
    quality.value = next.quality
    maxActive.value = String(next.max_active)
    notifyOnFail.value = next.notify_on_fail
  },
  { immediate: true, deep: true },
)

function revert(): void {
  targetDir.value = settings.value.target_dir
  quality.value = settings.value.quality
  maxActive.value = String(settings.value.max_active)
  notifyOnFail.value = settings.value.notify_on_fail
  edited.value = false
}

/** 原生 <select>：用 :value + @change，不走 v-model 的 select 指令（垫片 DOM 没有 el.options）。 */
function onQualityChange(event: Event): void {
  quality.value = (event.target as HTMLSelectElement).value
  markEdited()
}

/** 原生 <input type="number">：同样用 :value + @input。 */
function onMaxActiveInput(event: Event): void {
  maxActive.value = (event.target as HTMLInputElement).value
  markEdited()
}

async function save(): Promise<void> {
  await store.saveSettings({
    target_dir: targetDir.value.trim(),
    quality: quality.value,
    max_active: Number(maxActive.value),
    notify_on_fail: notifyOnFail.value,
  })
}
</script>

<template>
  <div class="row">
    <h3 class="card-title">设置</h3>
    <span class="spacer" />
    <NButton size="small" secondary :disabled="!dirty" @click="revert">撤销改动</NButton>
    <NButton size="small" type="primary" :loading="busy === 'settings'" :disabled="!dirty" @click="save">保存</NButton>
  </div>

  <div class="grid">
    <label class="field">
      <span class="label">目标目录（target_dir）</span>
      <NInput
        v-model:value="targetDir"
        size="small"
        placeholder="/CloudNAS/115open/音乐/音乐下载"
        @update:value="markEdited"
      />
      <span class="hint">
        最终落点（宿主绝对路径或 cd2:/网盘路径）；宿主按 CD2 挂载前缀自动分流并报告字节进度。
      </span>
    </label>

    <label class="field">
      <span class="label">默认音质（quality）</span>
      <select :value="quality" class="sel" @change="onQualityChange">
        <option v-for="value in ALL_QUALITIES" :key="value" :value="value">{{ store.qualityLabel(value) }}</option>
      </select>
      <span class="hint">网易云的档位名（默认 jymaster）；搜索页每首歌还能单独选。QQ 取链与这里无关。</span>
    </label>

    <label class="field">
      <span class="label">单轮新开下载数（max_active）</span>
      <input
        class="input"
        type="number"
        min="1"
        :max="String(MAX_ACTIVE_CAP)"
        :value="maxActive"
        @input="onMaxActiveInput"
      />
      <span class="hint">每轮任务最多推进几个下载，1-{{ MAX_ACTIVE_CAP }}（超出回默认 2）。</span>
    </label>

    <div class="field">
      <span class="label">失败时发通知</span>
      <NSwitch v-model:value="notifyOnFail" @update:value="markEdited" />
      <span class="hint">
        尝试次数用尽时推送错误通知，通知里带「重试」按钮（callback_data retry:&lt;短id&gt;，仅 Telegram）。
      </span>
    </div>
  </div>

  <div class="divider" />
  <h4 class="sub">通知自检（notify-test）</h4>
  <div class="row">
    <NButton size="small" secondary :loading="busy === 'notify'" @click="store.testNotify()">
      <template #icon><SendIcon :size="13" /></template>
      发测试通知
    </NButton>
    <span class="hint">{{ NOTIFY_TEST_HINT }}</span>
  </div>
  <p v-if="notifyResult" class="hint">{{ notifyResult }}</p>

  <div class="divider" />
  <h4 class="sub">CookieCloud（宿主内置）</h4>
  <p class="hint">{{ COOKIE_CLOUD_HINT }}</p>

  <div class="divider" />
  <h4 class="sub">目录与入库（v3）</h4>
  <p class="hint">{{ STORAGE_HINT }}</p>
</template>

<style scoped>
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.spacer {
  flex: 1;
}

.card-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.sub {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 14px;
}

.field {
  display: grid;
  gap: 5px;
  align-content: start;
}

.label {
  font-size: 12px;
  font-weight: 600;
}

.hint {
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.45));
  font-size: 12px;
  margin: 0;
  line-height: 1.6;
}

.sel {
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid var(--app-border, #e0e4ea);
  background: var(--app-bg, transparent);
  color: inherit;
  font-size: 12px;
}

.input {
  padding: 7px 12px;
  border-radius: 9px;
  border: 1px solid var(--app-border, #e0e4ea);
  background: var(--app-bg, transparent);
  color: inherit;
  font-size: 13px;
  min-width: 0;
}

.divider {
  border-top: 1px solid var(--app-border, #e0e4ea);
}
</style>
