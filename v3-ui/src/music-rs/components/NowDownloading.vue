<script setup lang="ts">
// 「正在下载」主视觉：进行中任务的封面（取得到时）+ 模糊背景、旋转唱片、波形进度。
//
// 任务索引不带封面；这里只在已加载的搜索结果 / 歌单曲目里按「来源 + 歌曲 id」找一张，
// 找不到就用强调色渐变占位，不另外发请求猜封面。进度条是不定进度（后台不回报百分比）。

import { computed } from 'vue'
import { Music as MusicIcon } from '@lucide/vue'
import { useMusicStore } from '../store'
import type { TaskEntry } from '../types'
import { hashOf, useCovers } from '../ui-kit'
import QualityTag from './QualityTag.vue'

const store = useMusicStore()
const { allTasks, searchResults, playlistSongs } = store
const covers = useCovers()

const active = computed<TaskEntry[]>(() =>
  allTasks.value
    .filter((task) => task.status === 'downloading' || task.status === 'copying')
    .sort((left, right) => Number(right.status === 'downloading') - Number(left.status === 'downloading')),
)
const current = computed<TaskEntry | undefined>(() => active.value[0])
const copying = computed(() => current.value?.status === 'copying')

const cover = computed<string>(() => {
  const task = current.value
  if (!task?.song_id) return ''
  const id = String(task.song_id)
  const match = [...searchResults.value, ...playlistSongs.value].find(
    (song) => String(song.id) === id && (!task.source || !song.source || song.source === task.source),
  )
  return match?.cover ? covers.get(match.cover) : ''
})

/** 波形柱高度：按任务 id 稳定生成，同一首歌每次看到的波形一样。 */
const bars = computed<number[]>(() => {
  let seed = hashOf(current.value?.id ?? 'music')
  return Array.from({ length: 40 }, (_, index) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    const envelope = 0.55 + 0.45 * Math.sin((index / 39) * Math.PI)
    return Math.round((0.25 + ((seed >>> 8) % 1000) / 1000 * 0.75) * envelope * 100) / 100
  })
})
</script>

<template>
  <Transition name="hero">
    <section v-if="current" class="hero" :class="{ 'hero--copying': copying }" aria-live="polite">
      <div class="hero__backdrop" aria-hidden="true">
        <img v-if="cover" :src="cover" alt="" />
      </div>

      <div class="hero__deck" aria-hidden="true">
        <div class="vinyl">
          <div class="vinyl__label">
            <img v-if="cover" :src="cover" alt="" />
            <MusicIcon v-else :size="18" />
          </div>
        </div>
        <div class="sleeve">
          <img v-if="cover" :src="cover" alt="" />
          <MusicIcon v-else :size="34" />
        </div>
      </div>

      <div class="hero__body">
        <span class="hero__eyebrow">
          <span class="hero__live" />
          {{ copying ? '正在入库' : '正在下载' }}
          <template v-if="active.length > 1"> · 另有 {{ active.length - 1 }} 首进行中</template>
        </span>
        <h2 class="hero__title" :title="current.name">{{ current.name || '—' }}</h2>
        <p class="hero__sub">{{ current.singers || '未知歌手' }}</p>
        <div class="hero__meta">
          <QualityTag :quality="current.quality" />
          <span class="hero__src">{{ store.sourceName(current.source ?? '') }}</span>
        </div>
        <div
          class="wave"
          role="progressbar"
          :aria-label="copying ? '入库进度' : '下载进度'"
          :aria-valuetext="copying ? '正在入库' : '正在下载'"
        >
          <span
            v-for="(height, index) in bars"
            :key="index"
            class="wave__bar"
            :style="{ '--h': height, '--i': index }"
          />
        </div>
      </div>
    </section>
  </Transition>
</template>

<style scoped>
.hero {
  --accent: var(--mx-accent, var(--app-accent, #2080f0));
  position: relative;
  isolation: isolate;
  overflow: hidden;
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 22px;
  padding: 20px 24px;
  border-radius: 18px;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--app-border, #e0e4ea));
  background:
    radial-gradient(120% 160% at 0% 50%, color-mix(in srgb, var(--accent) 26%, transparent), transparent 65%),
    color-mix(in srgb, var(--app-surface, #fff) 88%, var(--accent));
  box-shadow: var(--mx-glow, none);
}

@container music-page (max-width: 560px) {
  .hero {
    grid-template-columns: 1fr;
    justify-items: center;
    text-align: center;
  }

  .hero__meta {
    justify-content: center;
  }
}

.hero__backdrop {
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
}

.hero__backdrop img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  filter: blur(36px) saturate(1.4);
  transform: scale(1.3);
  opacity: 0.35;
}

.hero__backdrop::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--app-surface, #fff) 55%, transparent) 55%
  );
}

/* 唱片 + 封套：封套在前，唱片从后面露出一半 */
.hero__deck {
  position: relative;
  width: 168px;
  height: 120px;
  flex: none;
}

.sleeve {
  position: absolute;
  left: 0;
  top: 0;
  width: 120px;
  height: 120px;
  border-radius: 12px;
  overflow: hidden;
  display: grid;
  place-items: center;
  color: color-mix(in srgb, var(--accent) 70%, var(--app-surface, #fff));
  background: linear-gradient(
    145deg,
    color-mix(in srgb, var(--accent) 55%, var(--app-surface, #fff)),
    color-mix(in srgb, var(--accent) 85%, var(--app-text, #000))
  );
  box-shadow: 0 14px 30px -14px color-mix(in srgb, var(--app-text, #000) 60%, transparent);
}

.sleeve img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.vinyl {
  position: absolute;
  left: 52px;
  top: 4px;
  width: 112px;
  height: 112px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background:
    conic-gradient(
      from 30deg,
      transparent 0 12%,
      color-mix(in srgb, #fff 16%, transparent) 16% 20%,
      transparent 26% 62%,
      color-mix(in srgb, #fff 12%, transparent) 66% 70%,
      transparent 76%
    ),
    repeating-radial-gradient(
      circle,
      color-mix(in srgb, #000 88%, var(--accent)) 0 2px,
      color-mix(in srgb, #000 74%, var(--accent)) 2px 3px
    );
  box-shadow:
    0 0 0 1px color-mix(in srgb, #000 60%, transparent),
    0 10px 28px -10px color-mix(in srgb, #000 70%, transparent);
  animation: hero-spin 2.6s linear infinite;
}

.hero--copying .vinyl {
  animation-duration: 6s;
}

.vinyl__label {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  overflow: hidden;
  display: grid;
  place-items: center;
  position: relative;
  color: #fff;
  background: var(--accent);
}

.vinyl__label img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.vinyl__label::after {
  content: '';
  position: absolute;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: color-mix(in srgb, #000 80%, var(--accent));
}

.hero__body {
  min-width: 0;
  width: 100%;
  display: grid;
  gap: 4px;
}

.hero__eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--accent);
}

@container music-page (max-width: 560px) {
  .hero__eyebrow {
    justify-content: center;
  }
}

.hero__live {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 60%, transparent);
  animation: hero-live 1.6s ease-out infinite;
}

.hero__title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hero__sub {
  margin: 0;
  font-size: 13px;
  color: var(--app-text-secondary, #6b7280);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hero__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.hero__src {
  font-size: 12px;
  color: var(--app-text-secondary, #6b7280);
}

/* 波形进度：柱高固定（按 id 生成），一道亮光从左扫到右表示「仍在推进」 */
.wave {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 40px;
  margin-top: 10px;
}

.wave__bar {
  flex: 1;
  min-width: 2px;
  height: calc(var(--h) * 100%);
  border-radius: 3px;
  background: var(--accent);
  opacity: 0.28;
  transform-origin: center;
  animation: hero-wave 2.2s ease-in-out infinite;
  animation-delay: calc(var(--i) * 45ms);
}

.hero--copying .wave__bar {
  opacity: 0.75;
  animation-name: hero-breathe;
  animation-delay: calc(var(--i) * 20ms);
}

@keyframes hero-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes hero-live {
  70%,
  100% {
    box-shadow: 0 0 0 8px transparent;
  }
}

@keyframes hero-wave {
  0%,
  100% {
    opacity: 0.28;
    transform: scaleY(0.7);
  }
  18% {
    opacity: 1;
    transform: scaleY(1);
  }
  40% {
    opacity: 0.5;
    transform: scaleY(0.85);
  }
}

@keyframes hero-breathe {
  50% {
    opacity: 1;
    transform: scaleY(0.9);
  }
}

.hero-enter-active,
.hero-leave-active {
  transition:
    opacity 0.35s ease,
    transform 0.35s ease;
}

.hero-enter-from,
.hero-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.98);
}

@media (prefers-reduced-motion: reduce) {
  .vinyl,
  .hero__live,
  .wave__bar {
    animation: none;
  }

  .wave__bar {
    opacity: 0.7;
  }

  .hero-enter-active,
  .hero-leave-active {
    transition: none;
  }
}
</style>
