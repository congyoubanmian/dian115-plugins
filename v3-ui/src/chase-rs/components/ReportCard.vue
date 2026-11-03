<script setup lang="ts">
// 日报预览：手机通知样式的卡片。
//
// 文案用 lib/notify.js 的 compose() 按当前状态现算（与后台发送同一份逻辑），
// 只是预览；真正发出的内容以发送那一刻的状态为准。下方列出账本：累计次数、最近结果与渠道。

import { computed } from 'vue'
import { BellRing, Tv } from '@lucide/vue'
import { formatAt, list, localDateOf, num, text } from '../format'
import { useChaseStore } from '../use-chase'
import { reportPreview } from '../visuals'

const store = useChaseStore()

const offset = computed(() => num(store.settings.report_tz_offset_minutes, 480))
const today = computed(() => localDateOf(offset.value))
const preview = computed(() => reportPreview(store.state, today.value))
const hour = computed(() => `${String(num(store.settings.report_hour, 9)).padStart(2, '0')}:00`)
const enabled = computed(() => store.settings.report_enabled === true)
const daily = computed(() => store.state?.daily ?? {})

const RESULT_LABELS: Record<string, string> = {
  accepted: '宿主已接收',
  deduplicated: '宿主已去重（当日已有）',
  suppressed: '未送达（无可投递渠道）',
  failed: '发送失败',
}
const lastResult = computed(() => {
  const key = text(daily.value.last_result, '')
  return key ? (RESULT_LABELS[key] ?? key) : '还没有发送记录'
})
const channels = computed(() =>
  list(daily.value.notify_channels as unknown[] | undefined)
    .map((c) => (typeof c === 'string' ? c : text((c as { channel?: unknown } | null)?.channel, '')))
    .filter((c) => c !== ''),
)
</script>

<template>
  <section class="card c-report">
    <div class="card-head">
      <div class="card-title">
        <span class="card-icon"><BellRing :size="16" aria-hidden="true" /></span>
        <h3>日报预览</h3>
      </div>
      <span class="card-head-meta">{{ store.dailyCapsule.label }}</span>
    </div>

    <div class="phone" :class="{ off: !enabled }">
      <div class="phone-status" aria-hidden="true">
        <span>{{ hour }}</span>
        <span class="phone-notch" />
        <span class="phone-bars"><i /><i /><i /></span>
      </div>
      <article class="notif" aria-label="日报通知预览">
        <header class="notif-head">
          <span class="notif-app"><Tv :size="12" aria-hidden="true" /></span>
          <span class="notif-name">追剧管家</span>
          <span class="notif-time">{{ enabled ? `本地 ${hour} 后` : '已关闭' }}</span>
        </header>
        <strong class="notif-title">{{ preview.title }}</strong>
        <pre class="notif-body">{{ preview.body }}</pre>
      </article>
    </div>

    <p class="card-foot">
      {{ enabled ? '按当前状态生成的预览，实际内容以发送时为准' : '日报未开启（设置里打开「发送每日报告」）；以下为按当前状态生成的预览' }}
    </p>
    <dl class="c-report-meta">
      <div><dt>累计发送</dt><dd>{{ num(daily.sent_total, 0) }} 次</dd></div>
      <div><dt>最近结果</dt><dd>{{ lastResult }}</dd></div>
      <div><dt>最近时间</dt><dd>{{ formatAt(daily.last_at) }}</dd></div>
      <div v-if="channels.length"><dt>渠道</dt><dd>{{ channels.join(' · ') }}</dd></div>
      <div v-if="text(daily.last_error, '')" class="c-report-err"><dt>错误</dt><dd>{{ daily.last_error }}</dd></div>
    </dl>
  </section>
</template>
