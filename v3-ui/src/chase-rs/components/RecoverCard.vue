<script setup lang="ts">
// 需要核对：被宿主重启打断的任务（attention_required）。
// 不重叠的任务在核对前不会再运行（整点对齐也一样），所以这里给出 ctx.tasks.retry 入口：
// 宿主调用后台 recover，先查订阅池真实集数，再决定完成 / 继续 / 仍需核对。

import { NButton } from 'naive-ui'
import { ShieldAlert } from '@lucide/vue'
import { formatAt } from '../format'
import { useChaseStore } from '../use-chase'

const store = useChaseStore()
</script>

<template>
  <section class="card c-recover" aria-label="需要核对的中断任务">
    <div class="card-head">
      <div class="card-title">
        <span class="card-icon c-recover-icon"><ShieldAlert :size="16" aria-hidden="true" /></span>
        <h3>需要核对</h3>
      </div>
      <span class="badge badge-warning">{{ store.attentionRuns.length }} 条中断任务</span>
    </div>
    <p class="c-recover-lead">
      任务被宿主重启打断，可能已经写过订阅池。核对前同名任务不会再运行；点「核对并恢复」会先查订阅池里的真实集数，绝不重复写。
    </p>
    <TransitionGroup tag="ul" name="c-list" class="c-recover-list">
      <li v-for="run in store.attentionRuns" :key="run.id" class="c-recover-item" :data-stage="run.stage || 'none'">
        <div class="c-recover-main">
          <div class="show-title">
            {{ run.jobLabel }}
            <span class="c-recover-when">{{ formatAt(run.updatedAt) }}</span>
          </div>
          <div class="reason-text">{{ run.detail }}</div>
          <div v-if="run.message" class="c-recover-msg">{{ run.message }}</div>
          <div class="trim-ids">task {{ run.id }}</div>
        </div>
        <NButton
          size="small"
          type="warning"
          secondary
          :disabled="store.busy !== ''"
          :loading="store.retryingId === run.id"
          :aria-label="`核对并恢复：${run.jobLabel}（task ${run.id}）`"
          @click="store.retryRun(run.id)"
        >
          核对并恢复
        </NButton>
      </li>
    </TransitionGroup>
  </section>
</template>
