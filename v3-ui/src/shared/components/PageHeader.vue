<script setup lang="ts">
// 共享页头外壳：品牌 + 状态胶囊 + 动作组 + 可选默认插槽（音乐页的统计卡）。
//
// 合并 chase-rs/components/PageHeader.vue 与 douban-rs/components/AppHeader.vue 的结构：
// - 品牌：默认渲染 icon / title / subtitle；需要整块替换时用 #brand（music）；
// - #icon、#brand-extra、#capsules、#actions、#art、#default 各司其职；
// - 只负责网格 / sticky / compact 行为，背景、边框、阴影、动画仍由插件的
//   .c-header / .db-head / .music-head class 提供。
//
// 间距由插件用 CSS 变量控制，避免两边同时写 display/padding 互相覆盖：
// --ui-head-padding / --ui-head-padding-compact / --ui-head-radius / --ui-head-margin-bottom。
//
// 响应式统一用容器查询：@container page (min-width:720px) 宽屏双列，
// (max-width:719.98px) 单列且 actions 占满一行、sticky 变 static。

import { computed } from 'vue'
import type { Component } from 'vue'

const props = withDefaults(
  defineProps<{
    title?: string
    subtitle?: string
    icon?: Component
    headingLevel?: 1 | 2 | 3
    busy?: boolean
    sticky?: boolean
    hideCapsulesOnCompact?: boolean
    /** busy 时在底边显示不定进度条（chase 使用）。 */
    progress?: boolean
  }>(),
  {
    title: '',
    subtitle: '',
    headingLevel: 1,
    busy: false,
    sticky: false,
    hideCapsulesOnCompact: false,
    progress: false,
  },
)

const headingTag = computed(() => `h${props.headingLevel}`)
</script>

<template>
  <header
    class="ui-head"
    :class="{
      'ui-head--sticky': sticky,
      'ui-head--hide-caps-compact': hideCapsulesOnCompact,
      'is-busy': busy,
    }"
    :aria-busy="busy || undefined"
  >
    <slot name="art" />

    <div class="ui-head__brand">
      <slot name="brand">
        <span v-if="icon || $slots.icon" class="ui-head__icon">
          <slot name="icon">
            <component :is="icon" :size="24" aria-hidden="true" />
          </slot>
        </span>
        <div class="ui-head__text">
          <component :is="headingTag" v-if="title" class="ui-head__title">{{ title }}</component>
          <p v-if="subtitle" class="ui-head__sub">{{ subtitle }}</p>
        </div>
      </slot>
      <slot name="brand-extra" />
    </div>

    <div v-if="$slots.capsules" class="ui-head__capsules">
      <slot name="capsules" />
    </div>

    <div v-if="$slots.actions" class="ui-head__actions">
      <slot name="actions" />
    </div>

    <div v-if="$slots.default" class="ui-head__body">
      <slot />
    </div>

    <span v-if="busy && progress" class="ui-head__bar" aria-hidden="true" />
  </header>
</template>

<style scoped>
.ui-head {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas:
    'brand'
    'caps'
    'actions';
  gap: var(--ui-head-gap, 12px 20px);
  padding: var(--ui-head-padding, 14px 16px);
  border-radius: var(--ui-head-radius, 18px);
  margin-bottom: var(--ui-head-margin-bottom, 0);
  min-width: 0;
  box-sizing: border-box;
}

.ui-head--sticky {
  position: sticky;
  top: 8px;
  z-index: 20;
}

.ui-head__brand {
  grid-area: brand;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.ui-head__icon {
  width: 48px;
  height: 48px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 14px;
  color: var(--ui-surface, #fff);
  background: linear-gradient(
    135deg,
    var(--ui-accent, #2080f0),
    var(--ui-accent-2, var(--ui-accent, #2080f0))
  );
  box-shadow:
    0 8px 22px -6px color-mix(
      in srgb,
      var(--ui-accent, #2080f0) 60%,
      transparent
    ),
    inset 0 1px 0 color-mix(in srgb, var(--ui-surface, #fff) 35%, transparent);
}

.ui-head__text {
  min-width: 0;
}

.ui-head__title {
  margin: 0;
  font-size: 22px;
  font-weight: 750;
  line-height: 1.2;
  letter-spacing: -0.01em;
  color: var(--ui-text, #1f2329);
}

@supports ((-webkit-background-clip: text) or (background-clip: text)) {
  .ui-head__title {
    background: linear-gradient(
      90deg,
      var(--ui-text, #1f2329),
      color-mix(
        in srgb,
        var(--ui-accent, #2080f0) 70%,
        var(--ui-text, #1f2329)
      )
    );
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
}

.ui-head__sub {
  margin: 2px 0 0;
  font-size: 13px;
  color: var(--ui-muted, #6b7280);
}

.ui-head__capsules {
  grid-area: caps;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  min-width: 0;
}

.ui-head__actions {
  grid-area: actions;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

.ui-head__body {
  grid-column: 1 / -1;
  min-width: 0;
}

/* 宽屏：品牌在左，动作组占右列两行；胶囊在品牌下方（chase 现有布局）。 */
@container page (min-width: 720px) {
  .ui-head {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'brand actions'
      'caps actions';
  }

  .ui-head__actions {
    justify-content: flex-end;
    align-self: center;
  }
}

/* 紧凑：单列，actions 占满一行；sticky 失效；可选的胶囊隐藏。 */
@container page (max-width: 719.98px) {
  .ui-head {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      'brand'
      'caps'
      'actions';
    padding: var(--ui-head-padding-compact, var(--ui-head-padding, 14px 16px));
  }

  .ui-head--sticky {
    position: static;
  }

  .ui-head__actions {
    grid-column: 1 / -1;
    width: 100%;
    justify-content: flex-start;
  }

  .ui-head--hide-caps-compact .ui-head__capsules {
    display: none;
  }
}

.ui-head__bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  overflow: hidden;
  background: color-mix(in srgb, var(--ui-accent, #2080f0) 14%, transparent);
}

.ui-head__bar::after {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 40%;
  border-radius: 3px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--ui-accent, #2080f0),
    transparent
  );
  animation: ui-head-indeterminate 1.3s cubic-bezier(0.2, 0.8, 0.2, 1) infinite;
}

@keyframes ui-head-indeterminate {
  from {
    transform: translateX(-100%);
  }

  to {
    transform: translateX(260%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ui-head__bar::after {
    animation: none;
  }
}
</style>
