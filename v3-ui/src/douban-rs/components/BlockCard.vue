<script setup lang="ts">
// 通用卡片块：标题 + 副标题 + 右上角动作区 + 内容区。
// 对应原生版的 cardBlock()。

defineProps<{
  title: string
  subtitle?: string
}>()
</script>

<template>
  <section class="db-card">
    <header class="db-card__head">
      <div class="db-card__text">
        <h2 class="db-card__title">{{ title }}</h2>
        <p v-if="subtitle" class="db-card__sub">{{ subtitle }}</p>
      </div>
      <div class="db-card__actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="db-card__body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.db-card {
  background: var(--app-surface, #fff);
  border: 1px solid var(--db-line, var(--app-border, #e3e6eb));
  border-radius: var(--db-radius, 14px);
  padding: 14px 16px;
  min-width: 0;
}

.db-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.db-card__text {
  min-width: 0;
}

.db-card__title {
  font-size: 16px;
  font-weight: 650;
  margin: 0;
}

.db-card__sub {
  color: var(--db-muted, var(--app-text-secondary, #6b7280));
  font-size: 12px;
  margin: 3px 0 0;
  overflow-wrap: anywhere;
}

.db-card__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.db-card__body {
  display: grid;
  gap: 12px;
  min-width: 0;
}
</style>
