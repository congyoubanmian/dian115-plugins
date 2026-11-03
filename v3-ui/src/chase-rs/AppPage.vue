<script setup lang="ts">
// 追剧管家（chase.rs）页面 —— Vue 3 版。
//
// 结构（与原生 JS 版页面 v3-ui/legacy/chase-rs/page.native.js 一一对应）：
// 页头（状态/日报胶囊 + 动作组）→ 8 块指标瓦片 → 告警条 → 对齐结果卡（筛选 pill）
// → 双栏（补订建议 + 追剧日历）→ 探测诊断折叠条 → 最近动作 → 页脚；
// 状态不可用时只显示「状态不可用」卡；另有设置抽屉与顶部提示条。
//
// 数据只走 ctx（共享底座 provide 进来的宿主上下文）：
// 状态文档 ctx.storage.get('state')、设置 ctx.settings.get()/set()、
// 动作 ctx.tasks.run() + ctx.tasks.get() 轮询、通知由后台任务负责。

import { onBeforeUnmount, onMounted } from 'vue'
import { NButton } from 'naive-ui'
import { useCtx } from '../shared/use-ctx'
import { BUSY_LABELS, createChaseStore, provideChaseStore } from './use-chase'
import PageHeader from './components/PageHeader.vue'
import StatTile from './components/StatTile.vue'
import AlertBox from './components/AlertBox.vue'
import AlignCard from './components/AlignCard.vue'
import TrimCard from './components/TrimCard.vue'
import CalendarCard from './components/CalendarCard.vue'
import ProbeCard from './components/ProbeCard.vue'
import LogCard from './components/LogCard.vue'
import SettingsDrawer from './components/SettingsDrawer.vue'
import ToastHost from './components/ToastHost.vue'
import './styles.css'

const ctx = useCtx()
const store = createChaseStore(ctx)
provideChaseStore(store)

onMounted(() => {
  void store.loadData()
})

onBeforeUnmount(() => {
  // 停定时器、解绑 abort 监听。
  store.dispose()
})
</script>

<template>
  <main class="chase3">
    <PageHeader />

    <p v-if="store.busy" class="c-progress">
      <span class="c-spinner" />
      <span>{{ BUSY_LABELS[store.busy] }}</span>
    </p>

    <div
      v-if="store.result"
      class="c-result"
      :class="store.result.ok ? 'c-result-ok' : 'c-result-err'"
    >
      <span>{{ store.result.ok ? '✓' : '⚠' }}</span>
      <span>{{ store.result.text }}</span>
    </div>

    <section v-if="store.loading" class="card">
      <div class="alert alert-info">
        <strong>正在读取状态…</strong>
        <p>正在从宿主存储读取追剧管家的状态文档，请稍候。</p>
      </div>
    </section>

    <section v-else-if="!store.state" class="card">
      <div v-if="store.stateError" class="alert alert-error">
        <strong>状态不可用</strong>
        <p>
          读取本插件的状态文档失败（{{ store.stateError }}）：插件存储暂不可读。
        </p>
      </div>
      <div v-else class="alert alert-info">
        <strong>还没有状态</strong>
        <p>
          插件刚安装、还没有跑过任何任务，所以存储里没有状态文档；跑完一轮后这里会显示指标与对齐结果。
        </p>
      </div>
      <p class="next-line">
        下一步：点「立即对齐」或「刷新」先跑一轮；仍然失败就把宿主机上插件的运行日志贴给作者。
      </p>
      <div class="c-inline-actions">
        <NButton size="small" :disabled="store.busy !== ''" @click="store.loadData()">重新读取状态</NButton>
        <NButton size="small" type="primary" :disabled="store.busy !== ''" @click="store.runAction('align-now')">
          立即对齐
        </NButton>
      </div>
    </section>

    <div v-else class="c-content">
      <section class="c-tiles">
        <StatTile v-for="tile in store.tiles" :key="tile.key" :tile="tile" />
      </section>

      <AlertBox
        kind="warning"
        :text="store.stateError ? `重新读取状态失败（${store.stateError}），下面显示的是上一次读到的数据。` : ''"
      />
      <AlertBox kind="warning" :text="store.instanceAlert" />
      <AlertBox kind="error" :text="store.storageAlert" />
      <AlertBox kind="warning" :text="store.probeAlert" />

      <AlignCard />

      <div class="c-duo">
        <TrimCard />
        <CalendarCard />
      </div>

      <ProbeCard />
      <LogCard />

      <footer class="c-foot">
        状态文档来自插件存储（ctx.storage）· 页面宽度跟随宿主可用宽度，双栏在 ≤1000px 回落单栏 · 表格在窄屏可横向滚动
      </footer>
    </div>

    <SettingsDrawer />
    <ToastHost />
  </main>
</template>
