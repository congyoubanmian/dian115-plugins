<script setup lang="ts">
// 指标瓦片（对应原生版的 db-tile）。

defineProps<{
  label: string
  value: string
  hint?: string
}>()
</script>

<template>
  <div class="db-tile">
    <span class="db-tile__label">{{ label }}</span>
    <strong class="db-tile__value">{{ value }}</strong>
    <span class="db-tile__hint">{{ hint }}</span>
  </div>
</template>

<style scoped>
.db-tile {
  display: grid;
  gap: 2px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--app-surface, #fff);
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  min-width: 0;
}

.db-tile__label {
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 12px;
}

.db-tile__value {
  font-size: 24px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  color: var(--app-text, #1f2329);
}

.db-tile__hint {
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 11px;
  overflow-wrap: anywhere;
}
</style>
