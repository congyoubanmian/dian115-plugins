<script setup lang="ts">
// 下载任务分页：队列状态、逐条重试、清空已完成、索引对账、推进队列。
//
// 任务数据来自插件 KV 的索引（tasks.idx），页面实时读；「推进队列」把 queue-pump 提交到
// 宿主统一任务队列并轮询到终态（ctx.tasks.run + ctx.tasks.get）。

import { computed, ref } from 'vue'
import { NAlert, NButton, NEmpty, NInput, NTag } from 'naive-ui'
import { Inbox as InboxIcon, Music as MusicIcon, RefreshCw as RefreshIcon, RotateCcw as RetryIcon, Trash2 as TrashIcon } from '@lucide/vue'
import { useMusicStore } from '../store'
import type { TaskEntry } from '../types'

const store = useMusicStore()
const { tasks, allTasks, attentionRun, pendingTasks, failedTasks, busy, settings, queueBusyNotice } = store

const adoptId = ref('')

/** 状态 → 文案与配色（原生版 STATUS_META 同表）。 */
const STATUS_META: Record<string, { label: string; type: 'default' | 'info' | 'success' | 'error' | 'primary' }> = {
  queued: { label: '排队中', type: 'info' },
  downloading: { label: '下载中', type: 'primary' },
  copying: { label: '入库中', type: 'primary' },
  done: { label: '下载完成', type: 'success' },
  failed: { label: '下载失败', type: 'error' },
}

/** 排队位置（第几位）：按完整索引算，不受列表展示上限影响。 */
const queuePosition = computed(() => {
  const map = new Map<string, number>()
  allTasks.value
    .filter((task) => task.status === 'queued')
    .forEach((task, index) => map.set(task.id, index + 1))
  return map
})

function statusOf(task: TaskEntry): { label: string; type: 'default' | 'info' | 'success' | 'error' | 'primary' } {
  const meta = STATUS_META[task.status] ?? { label: task.status || '未知', type: 'default' as const }
  if (task.status === 'queued') {
    const position = queuePosition.value.get(task.id)
    return { label: position ? `排队中 · 第 ${position} 位` : '排队中', type: meta.type }
  }
  return meta
}

function tileClass(task: TaskEntry): string {
  if (task.status === 'downloading' || task.status === 'copying') return 'tile-primary'
  if (task.status === 'queued') return 'tile-info'
  if (task.status === 'done') return 'tile-success'
  if (task.status === 'failed') return 'tile-error'
  return 'tile-muted'
}

async function adopt(): Promise<void> {
  await store.adoptTask(adoptId.value)
  adoptId.value = ''
}
</script>

<template>
  <div class="row">
    <h3 class="card-title">下载任务</h3>
    <NTag size="small" :bordered="false" :type="pendingTasks.length ? 'success' : 'default'">
      {{ pendingTasks.length ? '队列自动推进中' : '队列空闲' }}
    </NTag>
    <NTag size="small" :bordered="false" type="default">共 {{ allTasks.length }} 条</NTag>
    <NTag v-if="failedTasks.length" size="small" :bordered="false" type="error">失败 {{ failedTasks.length }}</NTag>
    <span class="spacer" />
    <NButton size="small" secondary :loading="busy === 'pump'" :disabled="!!busy && busy !== 'pump'" @click="store.pumpQueue()">
      <template #icon><RefreshIcon :size="13" /></template>
      推进队列
    </NButton>
    <NButton
      v-if="failedTasks.length"
      size="small"
      secondary
      type="error"
      :loading="busy === 'retry-all'"
      :disabled="!!busy && busy !== 'retry-all'"
      @click="store.retryAllFailed()"
    >
      <template #icon><RetryIcon :size="13" /></template>
      重试全部失败
    </NButton>
    <NButton size="small" secondary :loading="busy === 'clear'" :disabled="!!busy && busy !== 'clear'" @click="store.clearAllFinished()">
      <template #icon><TrashIcon :size="13" /></template>
      清空已结束
    </NButton>
  </div>

  <NAlert v-if="attentionRun" type="warning" :show-icon="false">
    <div class="bar">
      <p>
        上一轮「推进下载队列」被宿主重启打断，需要核对；核对前定时推进不会再运行。{{ attentionRun.message ? `（${attentionRun.message}）` : '' }}
      </p>
      <NButton size="tiny" type="warning" secondary :loading="busy === 'attention'" :disabled="!!busy && busy !== 'attention'" @click="store.retryAttentionRun()">
        核对并继续
      </NButton>
    </div>
  </NAlert>

  <NAlert v-if="queueBusyNotice" type="warning" :show-icon="false">
    <div class="bar">
      <p>{{ queueBusyNotice }}</p>
      <NButton size="tiny" secondary @click="store.clearQueueBusyNotice()">知道了</NButton>
    </div>
  </NAlert>

  <div class="row adopt-row">
    <NInput
      v-model:value="adoptId"
      size="small"
      class="grow"
      placeholder="任务 id（如 2gexs25y）"
      :input-props="{ 'aria-label': '要对账的任务 id' }"
      @keyup.enter="adopt"
    />
    <NButton size="small" secondary :loading="busy === 'adopt'" :disabled="!!busy && busy !== 'adopt'" @click="adopt">
      <template #icon><RetryIcon :size="13" /></template>
      索引对账
    </NButton>
  </div>

  <div v-if="tasks.length" class="task-list">
    <div v-for="task in tasks" :key="task.id" class="task-row">
      <div class="task-tile" :class="tileClass(task)">
        <MusicIcon :size="17" aria-hidden="true" />
      </div>
      <div class="task-main">
        <div class="task-title">{{ task.name || '—' }}{{ task.singers ? ` · ${task.singers}` : '' }}</div>
        <div class="task-sub" :title="task.error || undefined">
          {{ store.qualityLabel(task.quality) }} · {{ store.sourceName(task.source ?? '') }}{{ task.error ? ` · ${task.error}` : '' }}
        </div>
      </div>
      <div v-if="task.status === 'downloading' || task.status === 'copying'" class="task-progress">
        <div class="indet" />
      </div>
      <NButton
        v-if="task.status === 'failed'"
        size="tiny"
        quaternary
        circle
        type="error"
        title="重新排队重试"
        aria-label="重新排队重试"
        :disabled="!!busy"
        @click="store.retryTask(task)"
      >
        <template #icon><RetryIcon :size="14" /></template>
      </NButton>
      <NTag size="small" :bordered="false" :type="statusOf(task).type">{{ statusOf(task).label }}</NTag>
    </div>
  </div>
  <p v-if="allTasks.length > tasks.length" class="hint">
    仅显示最近 {{ tasks.length }} 条（共 {{ allTasks.length }} 条）；点「清空已结束」可收起已完成/失败的任务。
  </p>
  <NEmpty v-else-if="!tasks.length" description="暂无任务。去「搜索」页选一首歌点下载。">
    <template #icon><InboxIcon :size="30" /></template>
  </NEmpty>

  <p class="hint">
    任务由后台定时任务（每 5 分钟）推进，每轮最多新开「设置」里的下载数；想立刻推一轮点「推进队列」（同一入口）。
    失败任务最多自动重试 3 次（每轮一次），用尽后可在这行点重试、点「重试全部失败」，或从 Telegram 失败通知的「重试」按钮重试。若重启后任务「消失」（分片还在、索引丢了），
    把它的 id 填进输入框点「索引对账」挂回。
  </p>
  <p class="hint">
    下载目录: {{ settings.target_dir }} · 命名: {歌手} - {歌名}.{格式}（目录里已有同名文件时加「 (2)」等后缀，不覆盖）· 鼠标悬停可看完整错误
  </p>
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

.grow {
  flex: 1;
  min-width: 160px;
}

.card-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.hint {
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.45));
  font-size: 12px;
  margin: 0;
  line-height: 1.6;
}

.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.bar p {
  margin: 0;
}

.adopt-row {
  padding: 8px 10px;
  border: 1px dashed var(--app-border, #e0e4ea);
  border-radius: 10px;
}

.task-list {
  display: grid;
  gap: 8px;
  max-height: 480px;
  overflow: auto;
}

.task-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--app-border, #e0e4ea);
  border-radius: 10px;
}

.task-tile {
  width: 36px;
  height: 36px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
}

.tile-primary {
  background: var(--app-accent, #2080f0);
  color: #fff;
}

.tile-info {
  background: color-mix(in srgb, var(--app-accent, #2080f0) 14%, transparent);
  color: var(--app-accent, #2080f0);
}

.tile-success {
  background: color-mix(in srgb, #18a058 14%, transparent);
  color: #18a058;
}

.tile-error {
  background: color-mix(in srgb, #d03050 14%, transparent);
  color: #d03050;
}

.tile-muted {
  background: color-mix(in srgb, var(--app-text-secondary, #8a919c) 14%, transparent);
  color: var(--app-text-secondary, #8a919c);
}

.task-main {
  flex: 1;
  min-width: 0;
}

.task-title {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-sub {
  font-size: 11px;
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.45));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-progress {
  width: 90px;
  flex: none;
}

.indet {
  height: 4px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--app-accent, #2080f0) 25%, transparent);
  position: relative;
  overflow: hidden;
}

.indet::after {
  content: '';
  position: absolute;
  inset: 0;
  width: 40%;
  background: var(--app-accent, #2080f0);
  animation: music-slide 1.2s ease-in-out infinite;
}

@keyframes music-slide {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(350%);
  }
}
</style>
