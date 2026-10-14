<script setup lang="ts">
import type { Component } from 'vue'
import { NIcon } from 'naive-ui'

// 指标瓦片(共享规范 §2.2): 白卡 + 1px border + radius-lg, padding 16px;
// 左上 label 13px secondary, 右上小图标 16px muted, 数字 28–32px/600 等宽数字。
// 有语义色彩时数字着色(总订阅蓝 / 观察队列 >0 琥珀), 无着色用 text-primary; hover 不位移不放大。
withDefaults(
  defineProps<{
    label: string
    value: number | string
    icon: Component
    tone?: 'default' | 'primary' | 'warning'
  }>(),
  { tone: 'default' },
)
</script>

<template>
  <div class="dc-tile" :class="'dc-tile-' + tone">
    <span class="dc-tile-label">{{ label }}</span>
    <NIcon class="dc-tile-icon" :component="icon" :size="16" />
    <div class="dc-tile-value">{{ value }}</div>
  </div>
</template>

<style scoped>
.dc-tile {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    'label icon'
    'value value';
  align-items: start;
  gap: 2px var(--dian-space-2, 8px);
  padding: var(--dian-space-4, 16px);
  border: 1px solid var(--dian-border, #e0e4ea);
  border-radius: var(--dian-radius-lg, 12px);
  background: var(--dian-surface-raised, #ffffff);
  box-shadow: var(--dian-shadow-sm, 0 6px 18px rgba(35, 52, 84, 0.08));
  min-width: 0;
}

.dc-tile-label {
  grid-area: label;
  font-size: 13px;
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dc-tile-icon {
  grid-area: icon;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
}

.dc-tile-value {
  grid-area: value;
  margin-top: var(--dian-space-1, 4px);
  font-size: 30px;
  line-height: 1.15;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
}

.dc-tile-primary .dc-tile-value {
  color: var(--dian-primary, #2080f0);
}

.dc-tile-warning .dc-tile-value {
  color: var(--dian-warning, #f0a020);
}

@media (max-width: 640px) {
  /* 移动档: 数字与标签尺寸固定, 不随视口缩放(规范 §3) */
  .dc-tile {
    padding: var(--dian-space-3, 12px);
  }

  .dc-tile-value {
    font-size: 26px;
  }
}
</style>
