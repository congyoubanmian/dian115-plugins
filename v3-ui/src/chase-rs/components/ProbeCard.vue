<script setup lang="ts">
// 探测诊断：默认折叠的排障区。
//
// 展开后是 5 个端点的解析现场（状态 / http_status / 形状指纹 / 参数矩阵 / ≤2KB 原文样本）、
// last_errors、host.call 尝试记录，以及一整段可复制的诊断文本。

import { computed, onBeforeUnmount, ref } from 'vue'
import { NButton } from 'naive-ui'
import { ChevronDown, Copy, Radar } from '@lucide/vue'
import { formatAt, list, num, text } from '../format'
import { useChaseStore } from '../use-chase'

const store = useChaseStore()
const copied = ref(false)
/** 「已复制」回显的定时器；卸载时必须清掉，不能让它继续持有组件状态。 */
let copiedTimer: ReturnType<typeof setTimeout> | null = null

const STATUS_MAP: Record<string, [string, string]> = {
  ok: ['已识别', 'badge-success'],
  unparsed: ['结构未识别', 'badge-warning'],
  http_error: ['HTTP 错误', 'badge-error'],
  transport_error: ['请求失败', 'badge-error'],
  skipped: ['本轮跳过', 'badge-neutral'],
  never: ['从未探测', 'badge-neutral'],
}

function statusOf(status: unknown): [string, string] {
  const key = text(status, 'never')
  return STATUS_MAP[key] ?? [key, 'badge-neutral']
}

const chevronClass = computed(() => (store.probeOpen ? 'c-chevron open' : 'c-chevron'))

async function copyDiagnostics(): Promise<void> {
  try {
    await navigator.clipboard.writeText(store.diagnosticsText)
    copied.value = true
    store.toast('success', '诊断信息已复制')
    if (copiedTimer !== null) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      copiedTimer = null
      copied.value = false
    }, 2000)
  } catch {
    store.toast('warning', '浏览器不允许复制, 请在文本域里手动选中')
  }
}

onBeforeUnmount(() => {
  if (copiedTimer !== null) {
    clearTimeout(copiedTimer)
    copiedTimer = null
  }
})
</script>

<template>
  <section class="card c-probe">
    <button
      type="button"
      class="c-probe-head"
      :aria-expanded="store.probeOpen"
      @click="store.toggleProbe()"
    >
      <span class="card-icon"><Radar :size="16" aria-hidden="true" /></span>
      <span class="c-probe-title">探测诊断</span>
      <span class="c-probe-sub">端点参数矩阵 · 形状指纹 · HTTP 状态 · 2KB 原文样本 —— 默认折叠，排障时展开</span>
      <ChevronDown class="c-chevron" :class="chevronClass" :size="16" aria-hidden="true" />
    </button>

    <Transition name="c-fade">
    <div v-if="store.probeOpen" class="c-probe-body">
      <div class="c-probe-grid">
        <div v-for="panel in store.probePanels" :key="panel.name" class="c-probe-panel">
          <div class="c-probe-panel-head">
            <h5>{{ panel.name }}</h5>
            <span class="badge" :class="statusOf(panel.snapshot.status)[1]">
              {{ statusOf(panel.snapshot.status)[0] }}
            </span>
          </div>
          <div class="muted-line">
            http_status: {{ num(panel.snapshot.http_status, 0) }} · at: {{ formatAt(panel.snapshot.at) }}
          </div>
          <div class="mono c-probe-shape">shape: {{ text(panel.snapshot.shape, '(未识别)') }}</div>
          <div class="muted-line">
            params_tried: {{ list(panel.snapshot.params_tried).join(' | ') || '(无)' }}
          </div>
          <div class="c-probe-hint">{{ panel.hint }}</div>
          <pre class="c-probe-sample">{{ text(panel.snapshot.sample, '(空)') }}</pre>
        </div>
      </div>

      <h4>last_errors</h4>
      <p v-if="store.lastErrors.length === 0" class="muted-line">没有错误记录。</p>
      <ul v-else class="c-diag-list">
        <li v-for="(error, index) in store.lastErrors" :key="`${error.at ?? ''}-${index}`">
          <span class="muted">{{ formatAt(error.at) }}</span>
          <span class="mono"> [{{ text(error.step) }}] </span>
          <span>{{ text(error.message) }}</span>
        </li>
      </ul>

      <h4>host.call 尝试</h4>
      <p v-if="store.attempts.length === 0" class="muted-line">还没有调用记录。</p>
      <ul v-else class="c-diag-list">
        <li v-for="(attempt, index) in store.attempts" :key="`${attempt.at ?? ''}-${index}`">
          <span class="muted">{{ formatAt(attempt.at) }}</span>
          <span class="mono"> {{ text(attempt.endpoint) }} {{ text(attempt.params) }} </span>
          <span class="muted">→ http {{ num(attempt.http_status, 0) }} · {{ text(attempt.shape) }}</span>
        </li>
      </ul>

      <div>
        <div class="c-diag-head">
          <span class="muted">完整诊断文本（整段复制给作者），内容与上面一致并附带最近日志。</span>
          <NButton size="small" @click="copyDiagnostics">
            <template #icon><Copy :size="14" aria-hidden="true" /></template>
            {{ copied ? '已复制' : '复制' }}
          </NButton>
        </div>
        <textarea
          class="c-diag-text"
          readonly
          rows="10"
          aria-label="完整诊断文本"
          :value="store.diagnosticsText"
        />
      </div>
    </div>
    </Transition>
  </section>
</template>
