<script setup lang="ts">
// VIP/付费歌曲入队确认弹窗。
// 单首：提示这首歌可能需要会员/付费，仍可强行入队。
// 整单：只要有一首命中就弹一次；点「仍然加入全部」后，本单所有歌（含会员/付费）照常入队。

import { computed } from 'vue'
import { NButton, NModal } from 'naive-ui'
import { useMusicStore } from '../store'
import VipBadge from './VipBadge.vue'

const store = useMusicStore()
const gate = store.vipGate
const first = computed(() => gate.value.items[0] ?? null)
const batch = computed(() => gate.value.mode === 'batch')
</script>

<template>
  <NModal
    :show="gate.open"
    :mask-closable="false"
    @update:show="(value: boolean) => { if (!value) store.resolveVipGate(false) }"
  >
    <div class="vip-gate" role="dialog" aria-modal="true" aria-label="会员歌曲确认">
      <h3 class="vip-gate__title">
        {{ batch ? '整单入队：包含会员/付费歌曲' : '这首歌可能需要会员或付费' }}
      </h3>
      <p class="vip-gate__lead">
        <template v-if="first">
          《{{ first.name }}》<VipBadge :tag="first.vip" />
        </template>
        <template v-if="batch">
          等歌曲可能需要 VIP / SVIP 或购买专辑。点「仍然加入全部」后，<strong>本单所有歌曲</strong>（含会员/付费）都会入队，后续同类不再提示。
        </template>
        <template v-else>可能需要 VIP / SVIP 或购买专辑，下载可能失败。仍可强行加入队列。</template>
      </p>
      <div class="vip-gate__actions">
        <NButton size="small" @click="store.resolveVipGate(false)">取消</NButton>
        <NButton size="small" type="primary" @click="store.resolveVipGate(true)">
          {{ batch ? '仍然加入全部' : '仍然加入队列' }}
        </NButton>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.vip-gate {
  width: min(420px, 92vw);
  padding: 20px 22px;
  border-radius: 16px;
  border: 1px solid var(--app-border, #e0e4ea);
  background: var(--app-surface, #fff);
  color: var(--app-text, #222);
  box-shadow: 0 18px 48px -18px rgba(0, 0, 0, 0.35);
}

.vip-gate__title {
  margin: 0 0 10px;
  font-size: 16px;
  font-weight: 700;
}

.vip-gate__lead {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--app-text-secondary, #6b7280);
}

.vip-gate__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
