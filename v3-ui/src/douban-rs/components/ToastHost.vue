<script setup lang="ts">
// 右下角提示条（对应原生版的 .db-toasts）。
// 用页面自己的提示条而不是宿主通知：提示是页面操作反馈，走 ctx.notifications
// 会给用户发外部通知，语义不对。

import { useDoubanStore } from '../store'

const store = useDoubanStore()
const { toasts } = store
</script>

<template>
  <div class="db-toasts" role="status" aria-live="polite">
    <div v-for="item in toasts" :key="item.id" class="db-toast" :class="`db-toast--${item.kind}`">
      {{ item.message }}
    </div>
  </div>
</template>

<style scoped>
.db-toasts {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 80;
  display: grid;
  gap: 8px;
  max-width: min(420px, 84vw);
}

.db-toast {
  padding: 10px 14px;
  border-radius: 10px;
  color: #fff;
  font-size: 13px;
  box-shadow: 0 8px 26px rgb(0 0 0 / 20%);
  overflow-wrap: anywhere;
  animation: db-toast-in 0.16s ease-out;
}

.db-toast--success {
  background: var(--db-ok, #18a058);
}

.db-toast--error {
  background: var(--db-err, #d03050);
}

.db-toast--warning {
  background: var(--db-warn, #f0a020);
}

.db-toast--info {
  background: var(--db-accent, #2080f0);
}

@keyframes db-toast-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}
</style>
