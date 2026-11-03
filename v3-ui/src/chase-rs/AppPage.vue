<script setup lang="ts">
// 追剧管家（chase.rs）页面 —— Vue 3 版。
//
// 结构（功能与原生 JS 版页面 v3-ui/legacy/chase-rs/page.native.js 一一对应）：
// hero 页头（状态/日报胶囊 + 动作组）→ 告警条 → 需要核对（中断任务，有才显示）→ bento 网格：
// 8 块指标瓦片 · 日报预览（手机通知样式）· 追剧日历（横向周时间线）· 对齐结果（进度环卡片/表格）
// · 补订建议 · 最近动作 · 探测诊断折叠条 → 页脚；
// 首次读取时显示骨架屏；状态不可用时只显示「状态不可用」卡；另有设置抽屉与顶部提示条。
// 布局用容器查询（.c-shell 声明 container: page），跟随插件区域宽度而不是视口宽度。
// 页头 / 指标卡 / 提示条来自 shared 组件，颜色令牌由 shared/tokens.css 提供。
//
// 数据只走 ctx（共享底座 provide 进来的宿主上下文）：
// 状态文档 ctx.storage.get('state')、设置 ctx.settings.get()/set()、
// 动作 ctx.tasks.run() + ctx.tasks.get() 轮询、通知由后台任务负责。

import { computed, onBeforeUnmount, onMounted } from 'vue'
import { NButton } from 'naive-ui'
import { useCtx } from '../shared/use-ctx'
import { useHostTheme } from '../shared/theme'
import { BUSY_LABELS, createChaseStore, provideChaseStore } from './use-chase'
import { num } from './format'
import { logSeries } from './visuals'
import PageHeader from './components/PageHeader.vue'
import StatTile from '../shared/components/StatTile.vue'
import ToastHost from '../shared/components/ToastHost.vue'
import AlertBox from './components/AlertBox.vue'
import AlignCard from './components/AlignCard.vue'
import TrimCard from './components/TrimCard.vue'
import CalendarCard from './components/CalendarCard.vue'
import ProbeCard from './components/ProbeCard.vue'
import LogCard from './components/LogCard.vue'
import ReportCard from './components/ReportCard.vue'
import RecoverCard from './components/RecoverCard.vue'
import SkeletonPage from './components/SkeletonPage.vue'
import SettingsDrawer from './components/SettingsDrawer.vue'
import '../shared/tokens.css'
import './styles.css'

const ctx = useCtx()
const store = createChaseStore(ctx)
provideChaseStore(store)

const theme = useHostTheme()
const themeMode = computed(() => theme.mode.value)

// 瓦片上的迷你折线 / 占比环：只用状态文档里真有的数据（最近 7 个本地日的日志分桶）。
const offset = computed(() => num(store.settings.report_tz_offset_minutes, 480))
const patchSeries = computed(() =>
  logSeries(store.logs, offset.value, (entry) => String(entry.message ?? '').startsWith('补订 ')),
)
const issueSeries = computed(() =>
  logSeries(store.logs, offset.value, (entry) => entry.level === 'warning' || entry.level === 'error'),
)
interface TileExtras {
  share?: { part: number; whole: number; label: string }
  series?: number[]
  seriesLabel?: string
}

function tileExtras(key: string): TileExtras {
  if (key === 'tv_intents') {
    const whole = num(store.state?.stats?.tv_intents, 0)
    return { share: { part: num(store.state?.stats?.matched, 0), whole, label: '已判定' } }
  }
  if (key === 'patched') return { series: patchSeries.value, seriesLabel: '近 7 天补订日志条数' }
  if (key === 'failed') return { series: issueSeries.value, seriesLabel: '近 7 天告警日志条数' }
  return {}
}

onMounted(() => {
  void store.loadData()
})

onBeforeUnmount(() => {
  // 停定时器、解绑 abort 监听。
  store.dispose()
})
</script>

<template>
  <main class="chase3 v3-ui" :data-theme="themeMode">
    <div class="c-shell">
      <PageHeader />

      <Transition name="c-fade">
        <p v-if="store.busy" class="c-progress" role="status">
          <span class="c-spinner" />
          <span>{{ BUSY_LABELS[store.busy] }}</span>
        </p>
      </Transition>

      <Transition name="c-fade">
        <div
          v-if="store.result"
          class="c-result"
          :class="store.result.ok ? 'c-result-ok' : 'c-result-err'"
          role="status"
        >
          <span>{{ store.result.ok ? '✓' : '⚠' }}</span>
          <span>{{ store.result.text }}</span>
        </div>
      </Transition>

      <SkeletonPage v-if="store.loading" />

      <section v-else-if="!store.state" class="card c-nostate">
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
        <div class="c-alerts">
          <AlertBox
            kind="warning"
            :text="store.stateError ? `重新读取状态失败（${store.stateError}），下面显示的是上一次读到的数据。` : ''"
          />
          <AlertBox kind="warning" :text="store.instanceAlert" />
          <AlertBox kind="error" :text="store.storageAlert" />
          <AlertBox kind="warning" :text="store.probeAlert" />
        </div>

        <Transition name="c-fade">
          <RecoverCard v-if="store.attentionRuns.length" />
        </Transition>

        <div class="c-bento">
          <section class="card c-stats" aria-label="本轮指标">
            <div class="c-tiles">
              <StatTile
                v-for="(tile, index) in store.tiles"
                :key="tile.key"
                variant="bento"
                :label="tile.label"
                :value="tile.value"
                :tone="tile.tone"
                :tile-key="tile.key"
                :index="index"
                v-bind="tileExtras(tile.key)"
              />
            </div>
          </section>
          <ReportCard />
          <CalendarCard />
          <AlignCard />
          <TrimCard />
          <LogCard />
          <ProbeCard />
        </div>

        <footer class="c-foot">
          状态文档来自插件存储（ctx.storage）· 布局跟随插件区域宽度（容器查询）自动在三栏 / 双栏 / 单栏间切换 · 表格与时间线在窄屏可横向滚动
        </footer>
      </div>
    </div>

    <SettingsDrawer />
    <ToastHost :items="store.toasts" position="top-right" :z-index="70" />
  </main>
</template>
