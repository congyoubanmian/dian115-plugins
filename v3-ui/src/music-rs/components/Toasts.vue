<script setup lang="ts">
// 右下角提示（原生版 toast 的等价物：自绘，不依赖 naive-ui 的 message provider）。
// 提示由 store 维护，4.8 秒后自动消失；页面卸载时 store 会清掉这些定时器。

import { useMusicStore } from '../store'

const store = useMusicStore()
const { toasts } = store
</script>

<template>
  <div class="music-toasts">
    <div v-for="item in toasts" :key="item.id" class="music-toast" :class="`music-toast--${item.kind}`">
      {{ item.message }}
    </div>
  </div>
</template>

<style scoped>
.music-toasts {
  position: fixed;
  right: 18px;
  bottom: 18px;
  display: grid;
  gap: 8px;
  z-index: 50;
  max-width: min(420px, 80vw);
  pointer-events: none;
}

.music-toast {
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 13px;
  color: #fff;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
  animation: music-toast-in 0.18s ease-out;
  overflow-wrap: anywhere;
}

.music-toast--success {
  background: #18a058;
}

.music-toast--error {
  background: #d03050;
}

.music-toast--warning {
  background: #f0a020;
}

.music-toast--info {
  background: var(--app-accent, #2080f0);
}

@keyframes music-toast-in {
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
