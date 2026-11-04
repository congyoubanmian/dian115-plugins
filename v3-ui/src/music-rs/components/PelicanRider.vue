<script setup lang="ts">
// 鹈鹕骑车：进度轨道的装饰与指示。
//
// - 有真实百分比时，鹈鹕位置 = 进度（入库字节 / 本轮计数），轨道填充同步；
// - 拿不到百分比时（单首下载没有字节回调），鹈鹕往返骑行表示「仍在推进」，不编假数字；
// - 减少动效（prefers-reduced-motion）时车轮与车身都静止，只做位置指示。

import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 0–100；null 表示不定进度。 */
    percent: number | null
    /** 是否有进行中的任务（控制车轮转动）。 */
    active?: boolean
  }>(),
  { active: true },
)

const clamped = computed(() =>
  props.percent === null ? null : Math.max(0, Math.min(100, props.percent)),
)
const trackStyle = computed(() => ({
  '--pct': clamped.value === null ? 0 : clamped.value / 100,
}))
</script>

<template>
  <div
    class="rider"
    :class="{ 'rider--active': active, 'rider--free': clamped === null }"
    :style="trackStyle"
    role="img"
    :aria-label="clamped === null ? '正在下载' : `进度 ${Math.round(clamped)}%`"
  >
    <div class="rider__track" aria-hidden="true">
      <div class="rider__fill" />
    </div>

    <div class="rider__bird" aria-hidden="true">
      <svg viewBox="0 0 120 92" width="76" height="58">
        <!-- 自行车：车架 + 两个带辐条的轮子 -->
        <g class="bike" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
          <path d="M30 70 L52 46 L86 70 M52 46 L64 70 M30 70 L64 70 M86 70 L78 42 L70 42" />
          <path d="M52 46 L46 40 L38 40" />
        </g>
        <g class="wheel" style="--cx: 30px; --cy: 70px">
          <circle cx="30" cy="70" r="13" fill="none" stroke="currentColor" stroke-width="2.6" />
          <path d="M30 57 V83 M17 70 H43 M21 61 L39 79 M39 61 L21 79" stroke="currentColor" stroke-width="1.2" />
        </g>
        <g class="wheel" style="--cx: 86px; --cy: 70px">
          <circle cx="86" cy="70" r="13" fill="none" stroke="currentColor" stroke-width="2.6" />
          <path d="M86 57 V83 M73 70 H99 M77 61 L95 79 M95 61 L77 79" stroke="currentColor" stroke-width="1.2" />
        </g>

        <!-- 鹈鹕：身体、翅膀、长颈与大喉囊 -->
        <g class="bird">
          <ellipse cx="52" cy="30" rx="19" ry="12" fill="currentColor" opacity="0.92" />
          <path d="M40 32 Q30 44 52 42 Q66 40 62 30" fill="currentColor" opacity="0.55" />
          <path d="M66 26 Q70 12 80 12" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" />
          <circle cx="82" cy="12" r="8" fill="currentColor" />
          <circle cx="84.5" cy="10" r="1.5" fill="var(--app-surface, #fff)" />
          <path d="M89 10 L112 16 L89 20 Q96 26 88 24 L86 18 Z" fill="#f59e0b" />
          <!-- 腿踩踏板 -->
          <path d="M52 40 L56 52 L64 56" fill="none" stroke="#f59e0b" stroke-width="3" stroke-linecap="round" />
        </g>
      </svg>
    </div>
  </div>
</template>

<style scoped>
.rider {
  position: relative;
  margin-top: 12px;
  /* 车顶上方要预留车身高度，否则绝对定位的鹈鹕会盖住上方的阶段胶囊。 */
  padding-top: 56px;
  color: var(--mx-accent, var(--app-accent, #2080f0));
}

.rider__track {
  height: 6px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 16%, transparent);
  overflow: hidden;
}

.rider__fill {
  height: 100%;
  width: calc(var(--pct) * 100%);
  border-radius: inherit;
  background: currentColor;
  transition: width 0.6s ease;
}

.rider--free .rider__fill {
  width: 32%;
  opacity: 0.6;
  animation: rider-fill 2.4s ease-in-out infinite;
}

.rider__bird {
  position: absolute;
  bottom: 2px;
  /* 有进度时跟随进度；0% 也露出完整车身。 */
  left: clamp(30px, calc(var(--pct) * 100%), calc(100% - 30px));
  transform: translateX(-50%);
  transition: left 0.6s ease;
}

.rider--free .rider__bird {
  animation: rider-free 7s ease-in-out infinite;
}

.rider--active .wheel {
  transform-box: fill-box;
  transform-origin: center;
  animation: rider-spin 1.1s linear infinite;
}

.rider--active .bird {
  animation: rider-bob 0.9s ease-in-out infinite;
}

@keyframes rider-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes rider-bob {
  50% {
    transform: translateY(-1.6px);
  }
}

@keyframes rider-free {
  0%,
  100% {
    left: 12%;
  }
  50% {
    left: 88%;
  }
}

@keyframes rider-fill {
  0%,
  100% {
    transform: translateX(0);
  }
  50% {
    transform: translateX(210%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .rider--active .wheel,
  .rider--active .bird,
  .rider--free .rider__bird,
  .rider--free .rider__fill {
    animation: none;
  }
}
</style>
