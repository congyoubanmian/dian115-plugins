<script setup lang="ts">
// 追剧日历：横向一周时间线 + 「今天」标记线。
//
// 四种展示模式（与原生版一致）：days（有数据）/ unrecognized（结构未识别）/
// never（还没抓过）/ empty（窗口里没有安排）。
// 时间线按天分列（窗口超过 7 天时横向滚动），每列按播出时间排序；
// 标记线按设置里的时区偏移落在「今天」那一列的当前时刻上，每分钟更新一次。

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton } from 'naive-ui'
import { CalendarClock } from '@lucide/vue'
import { episodeCompact, list, localDateOf, num, text, weekdayOf } from '../format'
import { useChaseStore } from '../use-chase'
import { minutesOf } from '../visuals'

const store = useChaseStore()
const PER_DAY = 5

const offset = computed(() => num(store.settings.report_tz_offset_minutes, 480))
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  ticker = setInterval(() => {
    now.value = Date.now()
  }, 60_000)
})
onBeforeUnmount(() => {
  if (ticker !== null) clearInterval(ticker)
  ticker = null
})

const today = computed(() => {
  void now.value
  return localDateOf(offset.value)
})

const columns = computed(() =>
  store.calendarDays.map((day) => {
    const date = text(day.date, '')
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    const items = list(day.items)
      .map((entry, index) => {
        const time = text(entry.time, '')
        return {
          key: `${date}-${index}`,
          title: text(entry.title, `tmdb ${num(entry.tmdb_id, 0)}`),
          episode: episodeCompact(entry.season, entry.episode),
          time: time || '时间待定',
          minutes: minutesOf(time),
        }
      })
      .sort((a, b) => (a.minutes < 0 || b.minutes < 0 ? Number(a.minutes < 0) - Number(b.minutes < 0) : a.minutes - b.minutes))
    return {
      date,
      isToday: date === today.value,
      isPast: date !== '' && date < today.value,
      label: date === today.value ? '今天' : weekdayOf(date) || date,
      sub: match ? `${Number(match[2])}/${Number(match[3])}` : date,
      items: items.slice(0, PER_DAY),
      more: Math.max(0, items.length - PER_DAY),
      total: items.length,
    }
  }),
)

const totalItems = computed(() => columns.value.reduce((sum, col) => sum + col.total, 0))
const hidden = computed(() => columns.value.reduce((sum, col) => sum + col.more, 0))

/** 标记线的横向位置（占整条时间线的百分比）；今天不在窗口里时不画。 */
const marker = computed(() => {
  const index = columns.value.findIndex((col) => col.isToday)
  if (index < 0 || columns.value.length === 0) return null
  const local = new Date(now.value + offset.value * 60_000)
  const frac = (local.getUTCHours() * 60 + local.getUTCMinutes()) / 1440
  const hh = String(local.getUTCHours()).padStart(2, '0')
  const mm = String(local.getUTCMinutes()).padStart(2, '0')
  return { left: `${((index + frac) / columns.value.length) * 100}%`, label: `${hh}:${mm}` }
})
</script>

<template>
  <section class="card c-cal">
    <div class="card-head">
      <div class="card-title">
        <span class="card-icon"><CalendarClock :size="16" aria-hidden="true" /></span>
        <h3>追剧日历</h3>
      </div>
      <span class="card-head-meta">
        抓取于 {{ store.calendarFetchedAt }} · 窗口 {{ store.calendarDays.length }} 天
        <template v-if="store.calendarMode === 'days'"> · {{ totalItems }} 条播出</template>
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
      <div class="tl-scroll" tabindex="0" aria-label="播出时间线（可横向滚动）">
        <div class="tl-track" :style="{ '--cols': columns.length }">
          <ol class="tl">
            <li
              v-for="col in columns"
              :key="col.date"
              class="tl-day"
              :class="{ today: col.isToday, past: col.isPast }"
              :aria-current="col.isToday ? 'date' : undefined"
            >
              <div class="tl-day-head">
                <span class="tl-day-label">{{ col.label }}</span>
                <span class="tl-day-date">{{ col.sub }}</span>
                <span v-if="col.total" class="tl-day-count">{{ col.total }}</span>
              </div>
              <ul v-if="col.items.length" class="tl-items">
                <li v-for="item in col.items" :key="item.key" class="tl-item">
                  <span class="tl-time">{{ item.time }}</span>
                  <span class="tl-title">{{ item.title }}</span>
                  <span v-if="item.episode" class="tl-ep">{{ item.episode }}</span>
                </li>
              </ul>
              <p v-else class="tl-none">—</p>
              <p v-if="col.more" class="tl-more">另 {{ col.more }} 条</p>
            </li>
          </ol>
          <div v-if="marker" class="tl-now" :style="{ left: marker.left }" aria-hidden="true">
            <span class="tl-now-tag">{{ marker.label }}</span>
          </div>
        </div>
      </div>
      <p v-if="totalItems === 0" class="muted-line">窗口里的这些天都没有播出安排。</p>
      <p v-if="hidden > 0" class="card-foot">
        另有 {{ hidden }} 条播出安排未列出 · 窗口 {{ store.calendarDays.length }} 天
      </p>
    </template>
  </section>
</template>
