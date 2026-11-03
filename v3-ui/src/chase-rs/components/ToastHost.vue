<script setup lang="ts">
// 顶部提示条（成功 / 失败 / 警告 / 提示）。
// 提示的自动消失由 store 里的定时器负责，页面卸载时统一清掉。

import { useChaseStore } from '../use-chase'

const store = useChaseStore()
</script>

<template>
  <TransitionGroup tag="div" name="c-toast" class="c-toasts" aria-live="polite">
    <div v-for="toast in store.toasts" :key="toast.id" class="toast" :class="`toast-${toast.kind}`" role="status">
      {{ toast.message }}
    </div>
  </TransitionGroup>
</template>
