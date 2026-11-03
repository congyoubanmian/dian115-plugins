<script setup lang="ts">
// 对齐结果卡：筛选 pill（全部 / 有缺口 / 异常）+ 结果表。
//
// 筛选是纯前端过滤（不改后端数据），徽章分类与原生版一致：
// 动作词 > 「Emby 未收录」> 失败 > 「该季 0 集」> 「覆盖未知」> 「目标未知」> 「无缺口」。

import { computed } from 'vue'
import { NButton } from 'naive-ui'
import { useChaseStore } from '../use-chase'
import { ABNORMAL_KINDS, actionCell, alignActionResultText, coverageSub, gapCell, hasGap, num, seasonPad, targetKnown, text } from '../format'

const store = useChaseStore()

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
  store.alignRows.filter((row) => {
    if (store.filter === 'gap') return hasGap(row.item)
    if (store.filter === 'abnormal') return ABNORMAL_KINDS.has(row.badge.kind)
    return true
  }),
)
</script>

<template>
  <section class="card">
    <div class="card-head">
      <div>
        <h3>对齐结果</h3>
        <p class="card-sub">{{ store.alignSub }}</p>
      </div>
      <div v-if="store.alignRows.length" class="c-pills">
        <button
          v-for="option in options"
          :key="option.key"
          type="button"
          class="pill"
          :class="{ active: store.filter === option.key }"
          :aria-pressed="store.filter === option.key"
          @click="store.setFilter(option.key)"
        >
          {{ option.label }} {{ option.count }}
        </button>
      </div>
    </div>

    <div v-if="store.pendingProbe > 0" class="alert alert-warning">
      有 {{ store.pendingProbe }} 条这轮没探到（探测预算/时间用尽），下一轮会优先补探；不是"没有缺口"。
    </div>

    <div v-if="store.alignRows.length === 0" class="c-empty">
      <span>{{ store.alignEmptyReason }}</span>
      <NButton size="small" type="primary" :disabled="store.busy !== ''" @click="store.runAction('align-now')">
        立即对齐一次
      </NButton>
    </div>
    <p v-else-if="filtered.length === 0" class="muted-line">该筛选下没有条目。</p>
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
        <tbody>
          <tr v-for="row in filtered" :key="`${row.item.intent_id ?? 0}-${row.item.season ?? 0}-${row.item.title ?? ''}`">
            <td>
              <div class="show-title">{{ text(row.item.title, `intent #${num(row.item.intent_id, 0)}`) }}</div>
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
            <td class="num" :class="gapCell(row.item).cls">{{ gapCell(row.item).label }}</td>
            <td class="num" :class="actionCell(row.item, row.badge.kind).cls">
              {{ actionCell(row.item, row.badge.kind).label }}
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
        </tbody>
      </table>
    </div>
  </section>
</template>
