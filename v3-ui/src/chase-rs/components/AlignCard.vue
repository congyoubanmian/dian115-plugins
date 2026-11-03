<script setup lang="ts">
// 对齐结果卡：筛选 pill（全部 / 有缺口 / 异常）+ 结果表。
//
// 筛选是纯前端过滤（不改后端数据），徽章分类与原生版一致：
// 动作词 > 「Emby 未收录」> 失败 > 「该季 0 集」> 「覆盖未知」> 「目标未知」> 「无缺口」。
//
// 两种视图：卡片（默认，每个剧·季一枚双层进度环 + 海报/首字头像）与表格（原信息密度）。
// 两种视图信息完全一致，切换只影响展示。

import { computed, ref } from 'vue'
import { NButton } from 'naive-ui'
import { LayoutGrid, ListChecks, Table2 } from '@lucide/vue'
import { useChaseStore } from '../use-chase'
import { ABNORMAL_KINDS, actionCell, alignActionResultText, coverageSub, gapCell, hasGap, num, seasonPad, targetKnown, text } from '../format'
import { monogram, posterOf, ringOf, toneIndex } from '../visuals'
import ProgressRing from './ProgressRing.vue'

const store = useChaseStore()
const view = ref<'cards' | 'table'>('cards')
const views = [
  { key: 'cards' as const, label: '卡片', icon: LayoutGrid },
  { key: 'table' as const, label: '表格', icon: Table2 },
]

function rowKey(item: { intent_id?: number; season?: number; title?: string }): string {
  return `${item.intent_id ?? 0}-${item.season ?? 0}-${item.title ?? ''}`
}

const gapCount = computed(() => store.alignRows.filter((row) => hasGap(row.item)).length)
const abnormalCount = computed(
  () => store.alignRows.filter((row) => ABNORMAL_KINDS.has(row.badge.kind)).length,
)

const options = computed(() => [
  { key: 'all' as const, label: '全部', count: store.alignRows.length },
  { key: 'gap' as const, label: '有缺口', count: gapCount.value },
  { key: 'abnormal' as const, label: '异常', count: abnormalCount.value },
])

const filtered = computed(() =>
  store.alignRows
    .filter((row) => {
      if (store.filter === 'gap') return hasGap(row.item)
      if (store.filter === 'abnormal') return ABNORMAL_KINDS.has(row.badge.kind)
      return true
    })
    .map((row) => {
      const title = text(row.item.title, `intent #${num(row.item.intent_id, 0)}`)
      return {
        ...row,
        key: rowKey(row.item),
        title,
        ring: ringOf(row.item),
        poster: posterOf(row.item),
        initial: monogram(text(row.item.title, '#')),
        tone: toneIndex(title),
        gap: gapCell(row.item),
        action: actionCell(row.item, row.badge.kind),
      }
    }),
)
</script>

<template>
  <section class="card c-align">
    <div class="card-head">
      <div class="card-title">
        <span class="card-icon"><ListChecks :size="16" aria-hidden="true" /></span>
        <div>
          <h3>对齐结果</h3>
          <p class="card-sub">{{ store.alignSub }}</p>
        </div>
      </div>
      <div v-if="store.alignRows.length" class="c-head-tools">
        <div class="c-seg" role="group" aria-label="视图">
        <button
          v-for="option in views"
          :key="option.key"
          type="button"
          class="seg"
          :class="{ active: view === option.key }"
          :aria-pressed="view === option.key"
          :title="`${option.label}视图`"
          @click="view = option.key"
        >
          <component :is="option.icon" :size="14" aria-hidden="true" />
          <span>{{ option.label }}</span>
        </button>
      </div>
      <div class="c-pills" role="group" aria-label="筛选">
        <button
          v-for="option in options"
          :key="option.key"
          type="button"
          class="pill"
          :class="{ active: store.filter === option.key }"
          :aria-pressed="store.filter === option.key"
          @click="store.setFilter(option.key)"
        >
          {{ option.label }} <span class="pill-count">{{ option.count }}</span>
        </button>
      </div>
      </div>
    </div>

    <div v-if="store.pendingProbe > 0" class="alert alert-warning">
      有 {{ store.pendingProbe }} 条这轮没探到（探测预算/时间用尽），下一轮会优先补探；不是"没有缺口"。
    </div>

    <p v-if="store.alignRows.length && view === 'cards'" class="c-legend" aria-hidden="true">
      <span><i class="lg lg-have" />外环 Emby 已入库 / 目标</span>
      <span><i class="lg lg-sub" />内环 订阅集数 / 目标</span>
    </p>

    <div v-if="store.alignRows.length === 0" class="c-empty">
      <span>{{ store.alignEmptyReason }}</span>
      <NButton size="small" type="primary" :disabled="store.busy !== ''" @click="store.runAction('align-now')">
        立即对齐一次
      </NButton>
    </div>
    <p v-else-if="filtered.length === 0" class="muted-line">该筛选下没有条目。</p>
    <TransitionGroup v-else-if="view === 'cards'" tag="ul" name="c-list" class="c-shows">
      <li v-for="(row, index) in filtered" :key="row.key" class="show" :class="`show-${row.badge.kind}`" :style="{ '--i': Math.min(index, 12) }">
        <ProgressRing :ring="row.ring" :poster="row.poster" :initial="row.initial" :tone="row.tone" />
        <div class="show-body">
          <div class="show-head">
            <div class="show-title">{{ row.title }}</div>
            <span class="badge" :class="`badge-${row.badge.kind}`">{{ row.badge.label }}</span>
          </div>
          <div class="show-sub">{{ seasonPad(row.item.season) }} · {{ coverageSub(row.item) }}</div>
          <dl class="show-stats">
            <div><dt>订阅</dt><dd>{{ num(row.item.total_known, 0) }}</dd></div>
            <div>
              <dt>Emby</dt>
              <dd><span v-if="row.ring.have >= 0">{{ row.ring.have }}</span><span v-else class="muted">—</span></dd>
            </div>
            <div>
              <dt>TMDB</dt>
              <dd><span v-if="targetKnown(row.item)">{{ num(row.item.target_upper, 0) }}</span><span v-else class="muted">—</span></dd>
            </div>
            <div><dt>缺口</dt><dd :class="row.gap.cls">{{ row.gap.label }}</dd></div>
          </dl>
          <div class="show-foot">
            <span v-if="row.action.label !== '—'" class="show-action" :class="row.action.cls">{{ row.action.label }}</span>
            <span v-if="text(row.item.reason, '').includes('复用缓存')" class="badge badge-third">复用缓存</span>
            <span v-if="!targetKnown(row.item) && row.badge.kind !== 'target-unknown'" class="badge badge-info">目标未知</span>
          </div>
          <div class="reason-text">{{ text(row.item.reason, '') || alignActionResultText(row.item) }}</div>
        </div>
      </li>
    </TransitionGroup>
    <div v-else class="c-table-wrap">
      <table class="c-table">
        <thead>
          <tr>
            <th>剧集</th>
            <th class="num">订阅</th>
            <th class="num">Emby 已有</th>
            <th class="num">TMDB 目标</th>
            <th class="num">缺口</th>
            <th class="num">动作</th>
            <th>原因</th>
          </tr>
        </thead>
        <TransitionGroup tag="tbody" name="c-list">
          <tr v-for="row in filtered" :key="row.key">
            <td>
              <div class="show-title">{{ row.title }}</div>
              <div class="show-sub">{{ seasonPad(row.item.season) }} · {{ coverageSub(row.item) }}</div>
            </td>
            <td class="num">{{ num(row.item.total_known, 0) }}</td>
            <td class="num">
              <span v-if="num(row.item.emby_have_max, -1) >= 0">{{ num(row.item.emby_have_max, 0) }}</span>
              <span v-else class="muted">—</span>
            </td>
            <td class="num">
              <span v-if="targetKnown(row.item)">{{ num(row.item.target_upper, 0) }}</span>
              <span v-else class="muted">—</span>
            </td>
            <td class="num" :class="row.gap.cls">{{ row.gap.label }}</td>
            <td class="num" :class="row.action.cls">
              {{ row.action.label }}
            </td>
            <td>
              <div class="c-badges">
                <span class="badge" :class="`badge-${row.badge.kind}`">{{ row.badge.label }}</span>
                <span v-if="text(row.item.reason, '').includes('复用缓存')" class="badge badge-third">复用缓存</span>
                <span
                  v-if="!targetKnown(row.item) && row.badge.kind !== 'target-unknown'"
                  class="badge badge-info"
                >
                  目标未知
                </span>
              </div>
              <div class="reason-text">{{ text(row.item.reason, '') || alignActionResultText(row.item) }}</div>
            </td>
          </tr>
        </TransitionGroup>
      </table>
    </div>
  </section>
</template>
