<script setup lang="ts">
// 概览条里的一格: 标签 / 数值 / 脚注。颜色全部走主题变量, 不写死色值。
withDefaults(
  defineProps<{
    label: string
    value: string
    note?: string
    tone?: 'default' | 'success' | 'warning' | 'error'
  }>(),
  { note: '', tone: 'default' },
)
</script>

<template>
  <div class="chase-stat" :class="`chase-stat-${tone}`">
    <span class="chase-stat-label">{{ label }}</span>
    <strong class="chase-stat-value">{{ value }}</strong>
    <span v-if="note" class="chase-stat-note">{{ note }}</span>
  </div>
</template>

<style scoped>
.chase-stat {
  display: grid;
  gap: 2px;
  align-content: start;
  padding: var(--dian-space-3);
  border: 1px solid var(--dian-border);
  border-radius: var(--dian-radius-md);
  background: var(--dian-surface);
  min-width: 0;
}

.chase-stat-label {
  color: var(--dian-text-muted);
  font-size: 12px;
}

.chase-stat-value {
  font-size: 18px;
  font-variant-numeric: tabular-nums;
  color: var(--dian-text-primary);
  overflow-wrap: anywhere;
}

.chase-stat-note {
  color: var(--dian-text-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.chase-stat-success {
  border-color: var(--dian-success);
}

.chase-stat-warning {
  border-color: var(--dian-warning);
}

.chase-stat-error {
  border-color: var(--dian-error);
}
</style>
