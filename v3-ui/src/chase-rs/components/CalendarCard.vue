<script setup lang="ts">
// 追剧日历：日期胶囊 + 播出安排。
//
// 四种展示模式（与原生版一致）：days（有数据）/ unrecognized（结构未识别）/
// never（还没抓过）/ empty（窗口里没有安排）。

import { NButton } from 'naive-ui'
import { useChaseStore } from '../use-chase'

const store = useChaseStore()
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h3>追剧日历</h3>
      <span class="card-head-meta">
        抓取于 {{ store.calendarFetchedAt }} · 窗口 {{ store.calendarDays.length }} 天
      </span>
    </div>

    <div v-if="store.calendarMode === 'unrecognized'" class="alert alert-warning">
      日历结构未识别, 见诊断 —— air-calendar 的字段指纹不在已知形状里, 日报会缺「今日播出」段;
      对齐不受影响。点「探测诊断」看参数矩阵与原文样本。
    </div>

    <div v-else-if="store.calendarMode === 'never'" class="c-empty">
      <span>还没有抓过追剧日历: 点「刷新」拉一次, 或等下一个整点的对齐任务。</span>
      <NButton size="small" :disabled="store.busy !== ''" @click="store.runAction('refresh')">
        刷新一次
      </NButton>
    </div>

    <div v-else-if="store.calendarMode === 'empty'" class="c-empty">
      窗口里没有播出安排(订阅池里可能没有在播剧集)。
    </div>

    <template v-else>
      <div class="c-day-chips">
        <div v-for="chip in store.calendarChips" :key="chip.date" class="day-chip" :class="{ today: chip.today }">
          <span class="day-chip-label">{{ chip.label }}</span>
          <span class="day-chip-date">{{ chip.sub }}</span>
        </div>
      </div>

      <p v-if="store.calendarEntries.length === 0" class="muted-line">窗口里的这些天都没有播出安排。</p>
      <ul v-else class="c-air-list">
        <li v-for="entry in store.calendarEntries.slice(0, 8)" :key="entry.key">
          <span class="air-dot" :class="{ today: entry.isToday }" />
          <span class="air-title">
            {{ entry.dayLabel }} · {{ entry.title }}{{ entry.episode ? ` ${entry.episode}` : '' }}
          </span>
          <span class="air-time">{{ entry.time }}</span>
        </li>
      </ul>
      <p v-if="store.calendarOverflow > 0" class="card-foot">
        另有 {{ store.calendarOverflow }} 条播出安排未列出 · 窗口 {{ store.calendarDays.length }} 天
      </p>
    </template>
  </section>
</template>
