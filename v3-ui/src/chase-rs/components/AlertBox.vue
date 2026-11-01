<script setup lang="ts">
// 告警条：实例缺失 / 存储不可用 / 探测异常（文案由 use-chase.ts 生成）。

defineProps<{ kind: 'warning' | 'error' | 'info'; text: string }>()
</script>

<template>
  <div v-if="text" class="alert" :class="`alert-${kind}`">{{ text }}</div>
</template>
