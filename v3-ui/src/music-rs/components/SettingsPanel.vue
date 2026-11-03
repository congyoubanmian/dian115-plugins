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
const STORAGE_HINT =
  '宿主支持直写（新版宿主）时直接流式写进目标目录；否则先落插件自有暂存目录 downloads/<短id>.part，定名后由宿主 ' +
  'move 进目标目录（不覆盖）。入库前做同名预检：目标目录已有同名文件时任务直接终态失败，不覆盖、不改名、' +
  '不进重试循环；下载失败也绝不删除目录里原有的文件。下载与入库前后都落任务检查点，中断后先核对目标目录里的真实文件再续跑。'
const NOTIFY_TEST_HINT =
  '主动发一条 info 通知；v3 宿主支持 callback_data 按钮，失败通知的「重试」按钮直达 Telegram 回调。'

/** Telegram 只读命令（清单 triggers → tg-command job）。 */
const TG_COMMANDS: ReadonlyArray<{ cmd: string; desc: string }> = [
  { cmd: '/music 队列', desc: '排队 / 下载中 / 最近失败' },
  { cmd: '/music 状态', desc: '统计、今日完成 / 失败与设置摘要' },
  { cmd: '/music 帮助', desc: '命令列表' },
  { cmd: '/queue · /status', desc: '直达队列 / 状态' },
]
const TG_HINT =
  '只读查询，不触发下载与删除。回复走消息来源渠道（需要授权 telegram.bot）；未授权时回退为普通通知。'
const REPORT_HINT =
  '每天 08:30 发一条 TG 日报：完成 / 失败 / 排队 / 进行中，以及今日完成与失败清单。当天送达后不再重复发送；' +
  '发送失败会换新的去重键重试；可在宿主「任务」页调整计划。'

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
  const ok = await store.saveSettings({
    target_dir: targetDir.value.trim(),
    quality: quality.value,
    max_active: Number(maxActive.value),
    notify_on_fail: notifyOnFail.value,
  })
  // 保存成功：表单回到「跟随生效值」（目录去尾斜杠等规范化后的值也同步回来）。
  if (ok) revert()
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
        最终落点，必须是以 / 开头的宿主绝对路径（可以是 CD2 挂载目录，如 /CloudNAS/…）；宿主按挂载前缀自动分流。
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
      <span class="hint">每轮（定时每 5 分钟或手动推进）最多新开几首下载，1-{{ MAX_ACTIVE_CAP }} 的整数；逐首顺序下载。</span>
    </label>

    <div class="field">
      <span class="label">失败时发通知</span>
      <NSwitch v-model:value="notifyOnFail" aria-label="失败时发通知" @update:value="markEdited" />
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
  <h4 class="sub">Telegram 与日报</h4>
  <div class="grid">
    <div class="field">
      <span class="label">机器人命令（tg-command）</span>
      <ul class="cmds">
        <li v-for="item in TG_COMMANDS" :key="item.cmd" class="cmd">
          <code class="cmd-code">{{ item.cmd }}</code>
          <span class="cmd-desc">{{ item.desc }}</span>
        </li>
      </ul>
      <span class="hint">{{ TG_HINT }}</span>
    </div>
    <div class="field">
      <span class="label">每日日报（daily-report）</span>
      <div class="report">
        <span class="report-time">08:30</span>
        <span class="report-tag">每天 · 仅 Telegram</span>
      </div>
      <span class="hint">{{ REPORT_HINT }}</span>
    </div>
  </div>

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
  font-size: 17px;
  font-weight: 700;
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
  gap: 6px;
  align-content: start;
  padding: 14px;
  border-radius: var(--ui-radius, 14px);
  border: 1px solid color-mix(in srgb, var(--app-border, #e0e4ea) 80%, transparent);
  background: color-mix(in srgb, var(--app-bg, transparent) 45%, transparent);
  transition: border-color 0.2s ease;
}

.field:focus-within {
  border-color: color-mix(in srgb, var(--mx-accent, #2080f0) 55%, var(--app-border, #e0e4ea));
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

.sel:focus-visible,
.input:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--mx-accent, #2080f0) 60%, transparent);
  outline-offset: 1px;
}

.sel {
  padding: 6px 8px;
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
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--app-border, #e0e4ea) 15%,
    var(--app-border, #e0e4ea) 85%,
    transparent
  );
}

.cmds {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}

.cmd {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}

.cmd-code {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--mx-accent, #2080f0);
  background: color-mix(in srgb, var(--mx-accent, #2080f0) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--mx-accent, #2080f0) 28%, transparent);
}

.cmd-desc {
  font-size: 12px;
  color: var(--app-text, inherit);
}

.report {
  display: flex;
  gap: 10px;
  align-items: baseline;
}

.report-time {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--app-text, inherit);
}

.report-tag {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.45));
  background: color-mix(in srgb, var(--app-border, #e0e4ea) 45%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .field {
    transition: none;
  }
}
</style>
