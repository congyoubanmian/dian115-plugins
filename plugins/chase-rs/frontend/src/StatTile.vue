<script setup lang="ts">
// 指标瓦片(共享实现规范 §2.2): 白卡(surface + 1px border + radius-lg), padding 16px;
// 左上 label 13px secondary, 右上小图标 16px muted, 数字 28–32px / 600 / tabular-nums。
// 有语义色时只给数字着色, hover 不位移不放大; 颜色全部走 --dian-* 变量, 不写死色值。
import type { Component } from 'vue'

withDefaults(
  defineProps<{
    label: string
    value: string
    /** 右上角小图标(lucide 组件); 不传则不渲染图标位。 */
    icon?: Component
    /** 数字着色: default 用 text-primary, 其余用对应语义色。 */
    tone?: 'default' | 'primary' | 'success' | 'warning' | 'error'
  }>(),
  { icon: undefined, tone: 'default' },
)
</script>

<template>
  <div class="stat-tile" :class="`stat-tile-${tone}`">
    <div class="stat-tile-top">
      <span class="stat-tile-label">{{ label }}</span>
      <component :is="icon" v-if="icon" class="stat-tile-icon" />
    </div>
    <strong class="stat-tile-value">{{ value }}</strong>
  </div>
</template>

<style scoped>
.stat-tile {
  display: grid;
  gap: var(--dian-space-2, 8px);
  align-content: start;
  padding: var(--dian-space-4, 16px);
  border: 1px solid var(--dian-border, #e0e4ea);
  border-radius: var(--dian-radius-lg, 14px);
  background: var(--dian-surface, #ffffff);
  min-width: 0;
}

.stat-tile-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--dian-space-2, 8px);
}

.stat-tile-label {
  color: var(--dian-text-secondary, rgba(0, 0, 0, 0.72));
  font-size: 13px;
}

.stat-tile-icon {
  width: 16px;
  height: 16px;
  color: var(--dian-text-muted, rgba(0, 0, 0, 0.45));
  flex: none;
}

.stat-tile-value {
  font-size: 30px;
  line-height: 1.15;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--dian-text-primary, rgba(0, 0, 0, 0.88));
  overflow-wrap: anywhere;
}

.stat-tile-primary .stat-tile-value {
  color: var(--dian-primary, #2080f0);
}

.stat-tile-success .stat-tile-value {
  color: var(--dian-success, #18a058);
}

.stat-tile-warning .stat-tile-value {
  color: var(--dian-warning, #f0a020);
}

.stat-tile-error .stat-tile-value {
  color: var(--dian-error, #d03050);
}

/* 移动档(规范 §3): 瓦片 2 列等宽, 数字与标签尺寸固定, 不随视口缩放 */
@media (max-width: 640px) {
  .stat-tile-value {
    font-size: 28px;
  }
}
</style>
