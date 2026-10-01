<script setup lang="ts">
// 诊断面板里的一个端点探针: http 状态 / 命中形状 / 尝试过的参数 /
// ≤2KB 原文片段(只读文本域, 可整段选中复制) / 探测时刻。
//
// 纯展示组件: 数据一律由 AppPage 从 `props.runtimeState.debug` 传下来,
// 这里不取数、不猜测(空样本显示「(空)」而不是编一句解释)。
import { computed } from 'vue'
import { NButton, NInput, NTag } from 'naive-ui'
import { Copy as CopyIcon } from '@lucide/vue'
import { formatAt, num, probeStatusLabel, probeStatusType, text, type ProbeSnapshot } from './chase-state'

const props = defineProps<{
  /** 端点名, 例如 `emby/episodes`。 */
  endpoint: string
  /** 这个槽位是从哪来的(用于说明扩展槽)。 */
  hint?: string
  probe?: ProbeSnapshot
}>()

const snapshot = computed<ProbeSnapshot>(() => props.probe || {})
const status = computed(() => snapshot.value.status || 'never')
const sample = computed(() => text(snapshot.value.sample, ''))
const paramsTried = computed(() => (snapshot.value.params_tried || []).filter((item) => item !== ''))
const shape = computed(() => text(snapshot.value.shape, ''))

async function copySample() {
  try {
    await navigator.clipboard.writeText(sample.value)
  } catch {
    // 剪贴板被浏览器拒绝时不做任何假提示: 文本域本身可直接选中复制
  }
}
</script>

<template>
  <div class="chase-probe">
    <div class="chase-probe-head">
      <span class="chase-probe-name">{{ endpoint }}</span>
      <n-tag :type="probeStatusType(status)" size="small" :bordered="false">{{ probeStatusLabel(status) }}</n-tag>
      <span class="chase-probe-meta">
        http {{ num(snapshot.http_status, 0) }} · 形状 {{ shape || '(未识别)' }} ·
        {{ formatAt(snapshot.at) }}
      </span>
    </div>
    <p v-if="hint" class="chase-probe-hint">{{ hint }}</p>
    <div class="chase-probe-params">
      <span class="chase-probe-label">尝试过的参数</span>
      <span v-if="paramsTried.length === 0" class="chase-probe-meta">(无)</span>
      <span v-for="(param, index) in paramsTried" :key="index" class="chase-probe-chip">{{ param }}</span>
    </div>
    <div class="chase-probe-sample">
      <div class="chase-probe-sample-head">
        <span class="chase-probe-label">原文片段(≤2KB, 已脱敏)</span>
        <n-button size="tiny" secondary :disabled="!sample" @click="copySample">
          <template #icon><copy-icon /></template>
          复制
        </n-button>
      </div>
      <n-input
        :value="sample"
        type="textarea"
        readonly
        :autosize="{ minRows: 4, maxRows: 12 }"
        placeholder="(空: 这个槽位还没有原文样本)"
      />
    </div>
  </div>
</template>

<style scoped>
.chase-probe {
  display: grid;
  gap: var(--dian-space-2);
  padding: var(--dian-space-3);
  border: 1px solid var(--dian-border);
  border-radius: var(--dian-radius-md);
  background: var(--dian-surface-soft, var(--dian-surface));
  min-width: 0;
}

.chase-probe-head {
  display: flex;
  align-items: center;
  gap: var(--dian-space-2);
  flex-wrap: wrap;
}

.chase-probe-name {
  font-weight: 600;
  font-family: var(--dian-font-mono, monospace);
}

.chase-probe-meta,
.chase-probe-hint,
.chase-probe-label {
  color: var(--dian-text-muted);
  font-size: 12px;
}

.chase-probe-hint {
  margin: 0;
  overflow-wrap: anywhere;
}

.chase-probe-params {
  display: flex;
  align-items: center;
  gap: var(--dian-space-2);
  flex-wrap: wrap;
}

.chase-probe-chip {
  padding: 0 var(--dian-space-2);
  border: 1px solid var(--dian-border-strong);
  border-radius: var(--dian-radius-pill);
  background: var(--dian-surface);
  font-family: var(--dian-font-mono, monospace);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.chase-probe-sample {
  display: grid;
  gap: var(--dian-space-1);
  min-width: 0;
}

.chase-probe-sample-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--dian-space-2);
  flex-wrap: wrap;
}
</style>
