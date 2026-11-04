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
        <!-- 地面投影（随车身起伏呼吸） -->
        <ellipse class="shadow" cx="58" cy="85.5" rx="33" ry="3.5" fill="currentColor" opacity="0.12" />

        <!-- 速度线：只有 active 时才出现 -->
        <g class="dash" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M4 62 h10" />
          <path d="M8 70 h12" />
          <path d="M4 78 h8" />
        </g>

        <!-- 音符拖尾：音乐插件的私货，从车尾飘出去 -->
        <g class="notes" fill="#f59e0b" font-size="11">
          <text class="note note--a" x="14" y="36">♪</text>
          <text class="note note--b" x="6" y="24">♫</text>
          <text class="note note--c" x="20" y="16">♪</text>
        </g>

        <!-- 自行车：车架 + 两个带辐条的轮子 + 牙盘 -->
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
        <g class="crank">
          <circle cx="64" cy="70" r="5" fill="none" stroke="currentColor" stroke-width="2" />
          <path d="M64 65 V75" stroke="currentColor" stroke-width="1.4" />
        </g>

        <!-- 鹈鹕：身体、翅膀、长颈与大喉囊 -->
        <g class="bird">
          <ellipse cx="52" cy="30" rx="19" ry="12" fill="currentColor" opacity="0.92" />
          <g class="wing">
            <path d="M52 30 Q66 17 76 24 Q68 34 54 32 Z" fill="currentColor" opacity="0.72" />
          </g>
          <path d="M40 32 Q30 44 52 42 Q66 40 62 30" fill="currentColor" opacity="0.55" />
          <path d="M66 26 Q70 12 80 12" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" />
          <!-- 红领巾：和喙同色，向后飘 -->
          <g class="scarf">
            <path d="M68 22 Q57 19 46 23 Q55 28 67 26 Z" fill="#f59e0b" />
            <path d="M46 23 Q42 22 38 25" fill="none" stroke="#f59e0b" stroke-width="2.2" stroke-linecap="round" />
          </g>
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
  overflow: hidden;
}

/* 有真实百分比时填充条上扫一道光（free 模式的呼吸已经够花，不叠加） */
.rider:not(.rider--free) .rider__fill {
  position: relative;
}
.rider:not(.rider--free) .rider__fill::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(100deg, transparent 20%, rgba(255, 255, 255, 0.55) 50%, transparent 80%);
  transform: translateX(-100%);
  animation: rider-sheen 2.2s ease-in-out infinite;
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
  /* 往返骑行：位置与朝向用两条同周期动画——translateX(-50%) 必须写进每一条
     flip 帧里，否则翻转时会丢掉居中。 */
  animation:
    rider-free 7s ease-in-out infinite,
    rider-flip 7s linear infinite;
}

.rider--active .wheel {
  transform-box: fill-box;
  transform-origin: center;
  animation: rider-spin 1.1s linear infinite;
}

.rider--active .crank {
  transform-box: fill-box;
  transform-origin: center;
  animation: rider-spin 0.9s linear infinite;
}

.rider--active .bird {
  animation: rider-bob 0.9s ease-in-out infinite;
}

/* 翅膀：大部分时间滑翔，每隔一段扑两下（鹈鹕的飞法）。transform-box: fill-box
   后 origin 是自身包围盒，写 left bottom 让翼根钉住。 */
.rider--active .wing {
  transform-box: fill-box;
  transform-origin: left bottom;
  animation: rider-flap 2.6s ease-in-out infinite;
}

.rider--active .scarf {
  transform-box: fill-box;
  transform-origin: right center;
  animation: rider-scarf 1.4s ease-in-out infinite;
}

.rider--active .shadow {
  transform-box: fill-box;
  transform-origin: center;
  animation: rider-shadow 0.9s ease-in-out infinite;
}

/* 速度线与音符只在骑行时出现 */
.dash,
.notes {
  opacity: 0;
  transition: opacity 0.4s ease;
}

.rider--active .dash,
.rider--active .notes {
  opacity: 1;
}

.rider--active .dash path {
  animation: rider-dash 0.7s linear infinite;
}
.rider--active .dash path:nth-child(2) {
  animation-delay: -0.23s;
}
.rider--active .dash path:nth-child(3) {
  animation-delay: -0.46s;
}

.note {
  transform-box: fill-box;
  transform-origin: center;
}
.rider--active .note {
  animation: rider-note 2.8s ease-out infinite;
}
.rider--active .note--b {
  animation-delay: -0.9s;
}
.rider--active .note--c {
  animation-delay: -1.8s;
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

/* 不定进度的往返：去程朝右，回程整只翻转朝左（不是倒着滑）。
   周期与 rider-free 相同；48%/52% 两个近帧让掉头发生在端点附近、看起来是转身。 */
@keyframes rider-flip {
  0%,
  48% {
    transform: translateX(-50%) scaleX(1);
  }
  52%,
  100% {
    transform: translateX(-50%) scaleX(-1);
  }
}

@keyframes rider-flap {
  0%,
  58%,
  100% {
    transform: rotate(0deg);
  }
  64% {
    transform: rotate(-16deg);
  }
  70% {
    transform: rotate(6deg);
  }
  76% {
    transform: rotate(-12deg);
  }
  84% {
    transform: rotate(0deg);
  }
}

@keyframes rider-scarf {
  0%,
  100% {
    transform: rotate(0deg) translateX(0);
  }
  50% {
    transform: rotate(5deg) translateX(-1.6px);
  }
}

@keyframes rider-shadow {
  50% {
    transform: scaleX(0.92);
    opacity: 0.08;
  }
}

@keyframes rider-dash {
  0% {
    transform: translateX(8px);
    opacity: 0;
  }
  30% {
    opacity: 0.65;
  }
  100% {
    transform: translateX(-12px);
    opacity: 0;
  }
}

@keyframes rider-note {
  0% {
    transform: translate(0, 0) rotate(0deg) scale(0.7);
    opacity: 0;
  }
  18% {
    opacity: 0.85;
  }
  100% {
    transform: translate(-24px, -16px) rotate(-16deg) scale(1);
    opacity: 0;
  }
}

@keyframes rider-sheen {
  0% {
    transform: translateX(-100%);
  }
  60%,
  100% {
    transform: translateX(100%);
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
  .rider--active .crank,
  .rider--active .bird,
  .rider--active .wing,
  .rider--active .scarf,
  .rider--active .shadow,
  .rider--active .dash path,
  .rider--active .note,
  .rider:not(.rider--free) .rider__fill::after,
  .rider--free .rider__bird,
  .rider--free .rider__fill {
    animation: none;
  }
}
</style>
