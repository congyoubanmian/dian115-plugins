<script setup lang="ts">
// 补订建议（只读）：减方向永远不自动执行，只提示，界面上明确写着。

import { Scissors } from '@lucide/vue'
import { num, seasonPad, text } from '../format'
import { useChaseStore } from '../use-chase'

const store = useChaseStore()
</script>

<template>
  <section class="card c-trim">
    <div class="card-head">
      <div class="card-title">
        <span class="card-icon"><Scissors :size="16" aria-hidden="true" /></span>
        <h3>补订建议</h3>
      </div>
      <span class="badge badge-unknown-coverage">只读 · 从不自动执行</span>
    </div>

    <div v-if="store.trims.length === 0" class="c-empty">
      没有需要提醒的条目: 订阅集数都不超过该季 TMDB 的集数。
    </div>
    <TransitionGroup v-else tag="ul" name="c-list" class="c-trim-list">
      <li v-for="trim in store.trims" :key="`${trim.intent_id ?? 0}-${trim.season ?? 0}`">
        <div class="trim-main">
          <div class="show-title">
            {{ text(trim.title, `intent #${num(trim.intent_id, 0)}`) }} {{ seasonPad(trim.season) }}
          </div>
          <div class="show-sub">
            订阅 {{ num(trim.total_known, 0) }} 集{{ num(trim.target_upper, 0) > 0 ? ', 高于 TMDB 官方目标' : '' }}
          </div>
          <div class="reason-text">{{ text(trim.reason, '') }}</div>
          <div class="trim-ids">
            intent_id {{ num(trim.intent_id, 0) }} · tmdb_id {{ num(trim.tmdb_id, 0) }} · {{ seasonPad(trim.season) }}
          </div>
        </div>
        <div class="trim-delta">
          <span>{{ num(trim.total_known, 0) }}</span>
          <span class="trim-arrow" aria-hidden="true">→</span>
          <span>{{ num(trim.target_upper, 0) }}</span>
        </div>
      </li>
    </TransitionGroup>
    <p v-if="store.trims.length" class="card-foot">
      共 {{ store.trims.length }} 条建议 · 仅提示, 需拿 intent_id 到订阅池手动调整
    </p>
  </section>
</template>
