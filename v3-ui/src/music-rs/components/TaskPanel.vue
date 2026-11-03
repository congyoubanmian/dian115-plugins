<script setup lang="ts">
// 下载任务分页：队列状态、逐条重试、清空已完成、索引对账、推进队列。
//
// 任务数据来自插件 KV 的索引（tasks.idx），页面实时读；「推进队列」把 queue-pump 提交到
// 宿主统一任务队列并轮询到终态（ctx.tasks.run + ctx.tasks.get）。

import { computed, ref } from 'vue'
import { NAlert, NButton, NEmpty, NInput, NTag } from 'naive-ui'
import {
  CircleCheck as DoneIcon,
  CircleX as FailIcon,
  Clock3 as QueueIcon,
  Inbox as InboxIcon,
  Music as MusicIcon,
  RefreshCw as RefreshIcon,
  RotateCcw as RetryIcon,
  Trash2 as TrashIcon,
} from '@lucide/vue'
import { useMusicStore } from '../store'
import type { TaskEntry } from '../types'
import { useReady } from '../ui-kit'
import QualityTag from './QualityTag.vue'
import Skeleton from './Skeleton.vue'

const store = useMusicStore()
const { tasks, allTasks, attentionRun, pendingTasks, failedTasks, busy, settings, queueBusyNotice } = store

const ready = useReady()
const adoptId = ref('')

function isActive(task: TaskEntry): boolean {
  return task.status === 'downloading' || task.status === 'copying'
}

function iconOf(task: TaskEntry) {
  if (task.status === 'queued') return QueueIcon
  if (task.status === 'done') return DoneIcon
  if (task.status === 'failed') return FailIcon
  return MusicIcon
}

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
    <NTag size="small" round :bordered="false" :type="pendingTasks.length ? 'success' : 'default'">
      {{ pendingTasks.length ? '队列自动推进中' : '队列空闲' }}
    </NTag>
    <NTag size="small" round :bordered="false" type="default">共 {{ allTasks.length }} 条</NTag>
    <NTag v-if="failedTasks.length" size="small" round :bordered="false" type="error">失败 {{ failedTasks.length }}</NTag>
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

  <Skeleton v-if="!ready && !tasks.length" :count="3" />
  <TransitionGroup v-else-if="tasks.length" tag="div" name="task" class="task-list">
    <div v-for="task in tasks" :key="task.id" class="task-row" :class="`task-row--${task.status}`">
      <div class="task-tile" :class="tileClass(task)">
        <span v-if="isActive(task)" class="task-disc" aria-hidden="true" />
        <component :is="iconOf(task)" v-else :size="17" aria-hidden="true" />
      </div>
      <div class="task-main">
        <div class="task-title">{{ task.name || '—' }}{{ task.singers ? ` · ${task.singers}` : '' }}</div>
        <div class="task-sub" :title="task.error || undefined">
          <QualityTag :quality="task.quality" />
          <span class="task-src">{{ store.sourceName(task.source ?? '') }}</span>
          <span v-if="task.error" class="task-err">{{ task.error }}</span>
        </div>
      </div>
      <div v-if="isActive(task)" class="task-progress" aria-hidden="true">
        <span v-for="bar in 5" :key="bar" class="task-eq" />
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
      <span class="status-pill" :class="`status-pill--${statusOf(task).type}`">{{ statusOf(task).label }}</span>
    </div>
  </TransitionGroup>
  <p v-if="allTasks.length > tasks.length" class="hint">
    仅显示最近 {{ tasks.length }} 条（共 {{ allTasks.length }} 条）；点「清空已结束」可收起已完成/失败的任务。
  </p>
  <NEmpty v-else-if="!tasks.length && ready" class="task-empty" description="暂无任务。去「搜索」页选一首歌点下载。">
    <template #icon><InboxIcon :size="30" /></template>
  </NEmpty>

  <p class="hint">
    任务由后台定时任务（每 5 分钟）推进，每轮最多新开「设置」里的下载数；想立刻推一轮点「推进队列」（同一入口）。
    失败任务最多自动重试 3 次（每轮一次），用尽后可在这行点重试、点「重试全部失败」，或从 Telegram 失败通知的「重试」按钮重试。若重启后任务「消失」（分片还在、索引丢了），
    把它的 id 填进输入框点「索引对账」挂回。
  </p>
  <p class="hint">
    下载目录: {{ settings.target_dir }} · 命名: {歌手} - {歌名}.{格式}（目录里已有同名文件时任务直接失败，不覆盖也不改名）· 鼠标悬停可看完整错误
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
  font-size: 17px;
  font-weight: 700;
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
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-bg, transparent) 50%, transparent);
}

.task-list {
  position: relative;
  display: grid;
  gap: 8px;
  max-height: 480px;
  overflow: auto;
  padding: 2px;
}

.task-row {
  --tone: var(--app-text-secondary, #8a919c);
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px 10px 14px;
  border: 1px solid var(--app-border, #e0e4ea);
  border-radius: 12px;
  background: var(--app-surface, #fff);
  overflow: hidden;
  transition:
    border-color 0.2s ease,
    background-color 0.2s ease;
}

.task-row::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--tone);
}

.task-row:hover {
  border-color: color-mix(in srgb, var(--tone) 45%, var(--app-border, #e0e4ea));
}

.task-row--downloading,
.task-row--copying {
  --tone: var(--mx-accent, #2080f0);
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--tone) 9%, var(--app-surface, #fff)),
    var(--app-surface, #fff) 70%
  );
}

.task-row--queued {
  --tone: color-mix(in srgb, var(--mx-accent, #2080f0) 50%, var(--app-text-secondary, #8a919c));
}

.task-row--done {
  --tone: var(--mx-ok, #18a058);
}

.task-row--failed {
  --tone: var(--mx-err, #d03050);
}

.task-tile {
  width: 38px;
  height: 38px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
}

.tile-primary {
  background: color-mix(in srgb, var(--mx-accent, #2080f0) 14%, transparent);
}

.tile-info {
  background: color-mix(in srgb, var(--mx-accent, #2080f0) 12%, transparent);
  color: var(--mx-accent, #2080f0);
}

.tile-success {
  background: color-mix(in srgb, var(--mx-ok, #18a058) 14%, transparent);
  color: var(--mx-ok, #18a058);
}

.tile-error {
  background: color-mix(in srgb, var(--mx-err, #d03050) 14%, transparent);
  color: var(--mx-err, #d03050);
}

.tile-muted {
  background: color-mix(in srgb, var(--app-text-secondary, #8a919c) 14%, transparent);
  color: var(--app-text-secondary, #8a919c);
}

/* 迷你唱片：进行中的任务在转 */
.task-disc {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background:
    radial-gradient(circle, var(--mx-accent, #2080f0) 0 22%, transparent 23%),
    repeating-radial-gradient(
      circle,
      color-mix(in srgb, #000 86%, var(--mx-accent, #2080f0)) 0 1.5px,
      color-mix(in srgb, #000 70%, var(--mx-accent, #2080f0)) 1.5px 2.5px
    );
  animation: task-spin 2.4s linear infinite;
}

.task-main {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 4px;
}

.task-title {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 11px;
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.45));
  white-space: nowrap;
}

.task-src {
  flex: none;
}

.task-err {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--mx-err, #d03050);
}

.task-progress {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 18px;
  flex: none;
}

.task-eq {
  width: 3px;
  height: 100%;
  border-radius: 2px;
  background: var(--mx-accent, #2080f0);
  transform-origin: bottom;
  animation: task-eq 0.9s ease-in-out infinite;
}

.task-eq:nth-child(2) {
  animation-delay: -0.3s;
}

.task-eq:nth-child(3) {
  animation-delay: -0.6s;
}

.task-eq:nth-child(4) {
  animation-delay: -0.15s;
}

.task-eq:nth-child(5) {
  animation-delay: -0.45s;
}

.status-pill {
  --tone: var(--app-text-secondary, #8a919c);
  flex: none;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  color: var(--tone);
  background: color-mix(in srgb, var(--tone) 12%, transparent);
}

.status-pill--info {
  --tone: color-mix(in srgb, var(--mx-accent, #2080f0) 70%, var(--app-text, #333));
}

.status-pill--primary {
  --tone: var(--mx-accent, #2080f0);
}

.status-pill--success {
  --tone: var(--mx-ok, #18a058);
}

.status-pill--error {
  --tone: var(--mx-err, #d03050);
}

@container music-page (max-width: 520px) {
  .task-progress {
    display: none;
  }

  .task-row {
    flex-wrap: wrap;
  }

  .task-main {
    flex-basis: calc(100% - 60px);
  }
}

/* 列表变化：新任务滑入、移除淡出、其余平滑挪位 */
.task-enter-active,
.task-leave-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}

.task-enter-from {
  opacity: 0;
  transform: translateY(-8px) scale(0.98);
}

.task-leave-to {
  opacity: 0;
  transform: translateX(16px);
}

.task-move {
  transition: transform 0.35s ease;
}

@keyframes task-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes task-eq {
  0%,
  100% {
    transform: scaleY(0.3);
  }
  50% {
    transform: scaleY(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .task-disc,
  .task-eq {
    animation: none;
  }

  .task-eq {
    transform: scaleY(0.6);
  }

  .task-row,
  .task-enter-active,
  .task-leave-active,
  .task-move {
    transition: none;
  }
}
</style>
