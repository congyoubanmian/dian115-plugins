<script setup lang="ts">
// 页头（hero）薄包装：品牌 + 状态/日报/dry-run 胶囊 + 动作组（刷新 / 探测诊断 / 立即对齐 / 设置）。
//
// 结构、宽屏双列与紧凑单列（含 actions 换行、进度条）都交给 shared PageHeader；
// 本文件只保留 chase 的 store 状态、槽位内容与 .c-header 皮肤类名，
// 背景/边框/阴影/动画仍由 styles.css 的 .chase3 .c-header 提供。
//
// 动作全部走 ctx.tasks.run（见 use-chase.ts 的 runAction），页面不直接 fetch 宿主接口。

import { computed } from 'vue'
import { NButton, NTag } from 'naive-ui'
import { Radar, RefreshCw, Settings, Sparkles, Tv } from '@lucide/vue'
import { useChaseStore } from '../use-chase'
import SharedPageHeader from '../../shared/components/PageHeader.vue'

const store = useChaseStore()
const busy = computed(() => store.busy !== '')
</script>

<template>
  <SharedPageHeader
    title="追剧管家"
    subtitle="每小时对齐订阅池 · Emby 覆盖 / TMDB 目标 · 只增不减"
    :heading-level="2"
    :busy="busy"
    progress
    class="c-header"
  >
    <template #art>
      <svg class="c-hero-art" viewBox="0 0 200 200" aria-hidden="true">
        <circle cx="150" cy="50" r="70" />
        <circle cx="150" cy="50" r="48" />
        <circle cx="150" cy="50" r="26" />
      </svg>
    </template>

    <template #icon>
      <Tv :size="24" aria-hidden="true" />
    </template>

    <template #capsules>
      <NTag
        class="c-capsule"
        size="small"
        round
        :bordered="false"
        :type="store.healthCapsule.type"
        :title="store.healthCapsule.title"
      >
        <span class="c-dot" :class="`c-dot-${store.healthCapsule.type}`" aria-hidden="true" />
        {{ store.healthCapsule.label }}
      </NTag>
      <NTag
        class="c-capsule"
        size="small"
        round
        :bordered="false"
        :type="store.dailyCapsule.type"
        :title="store.dailyCapsule.title"
      >
        {{ store.dailyCapsule.label }}
      </NTag>
      <NTag v-if="store.dryRun" class="c-capsule" size="small" round :bordered="false" type="warning">
        dry-run · 只判定不写入
      </NTag>
    </template>

    <template #actions>
      <NButton size="small" secondary :disabled="busy" @click="store.runAction('refresh')">
        <template #icon><RefreshCw :size="14" aria-hidden="true" :class="{ 'c-spin': store.busy === 'refresh' }" /></template>
        刷新
      </NButton>
      <NButton size="small" secondary :disabled="busy" @click="store.openProbe()">
        <template #icon><Radar :size="14" aria-hidden="true" /></template>
        探测诊断
      </NButton>
      <NButton class="c-cta" size="small" type="primary" :disabled="busy" @click="store.runAction('align-now')">
        <template #icon><Sparkles :size="14" aria-hidden="true" /></template>
        立即对齐
      </NButton>
      <NButton
        class="c-icon-btn"
        size="small"
        quaternary
        circle
        :disabled="busy"
        aria-label="设置"
        title="设置"
        @click="store.openSettings()"
      >
        <template #icon><Settings :size="16" aria-hidden="true" /></template>
      </NButton>
    </template>
  </SharedPageHeader>
</template>
