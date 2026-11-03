<script setup lang="ts">
// 歌曲卡片列表（搜索页与歌单页共用）：封面 / 歌名 / 歌手 · 专辑 / 音质 / 下载。
//
// 「下载」只是入队（去重按 来源+歌曲 id+音质），真正的取链与下载由后台任务推进。
// 每首歌可以单独选音质（选中值存在 store 的 songQuality 里，与原生版同语义）。
// withCovers：搜索结果按需经 ctx.http 取封面缩略图；歌单曲目可能上千首，用渐变占位。

import { NButton } from 'naive-ui'
import { Download as DownloadIcon } from '@lucide/vue'
import { useMusicStore } from '../store'
import type { Song } from '../types'
import { hashOf, useCovers } from '../ui-kit'
import QualityTag from './QualityTag.vue'

const props = defineProps<{ songs: Song[]; withCovers?: boolean }>()
const emit = defineEmits<{ (event: 'download', song: Song): void }>()

const store = useMusicStore()
const { busy } = store
const covers = useCovers()

function coverOf(song: Song): string {
  return props.withCovers ? covers.get(song.cover) : ''
}

function artAngle(song: Song): string {
  return `${hashOf(`${song.id}${song.name}`) % 360}deg`
}

function initialOf(song: Song): string {
  return Array.from(String(song.name || '♪').trim())[0] ?? '♪'
}
</script>

<template>
  <ul class="songs" role="list">
    <li v-for="(song, index) in songs" :key="`${song.source ?? ''}-${song.id}`" class="song">
      <span class="song__idx" aria-hidden="true">{{ index + 1 }}</span>
      <span class="song__art" :style="{ '--angle': artAngle(song) }" aria-hidden="true">
        <img v-if="coverOf(song)" :src="coverOf(song)" alt="" />
        <span v-else>{{ initialOf(song) }}</span>
      </span>
      <span class="song__main">
        <span class="song__name" :title="song.name">{{ song.name || '—' }}</span>
        <span class="song__by">
          {{ song.singers || '—' }}<template v-if="song.album"> · {{ song.album }}</template>
        </span>
      </span>
      <span class="song__actions">
        <QualityTag class="song__tier" :quality="store.qualityOf(song)" />
        <select
          class="sel"
          :aria-label="`${song.name || '歌曲'} 的音质`"
          :value="store.qualityOf(song)"
          @change="store.setSongQuality(song, ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="value in store.qualitiesFor(song)" :key="value" :value="value">
            {{ store.qualityLabel(value) }}
          </option>
        </select>
        <NButton
          size="small"
          type="primary"
          round
          :disabled="!!busy"
          :aria-label="`下载 ${song.name || '歌曲'}`"
          @click="emit('download', song)"
        >
          <template #icon><DownloadIcon :size="14" /></template>
          下载
        </NButton>
      </span>
    </li>
  </ul>
</template>

<style scoped>
.songs {
  list-style: none;
  margin: 0;
  padding: 2px;
  display: grid;
  gap: 8px;
  max-height: 520px;
  overflow: auto;
}

.song {
  display: grid;
  grid-template-columns: 24px 44px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: var(--ui-radius, 14px);
  border: 1px solid color-mix(in srgb, var(--app-border, #e0e4ea) 80%, transparent);
  background: var(--app-surface, #fff);
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    transform 0.2s ease;
}

.song:hover {
  border-color: color-mix(in srgb, var(--mx-accent, #2080f0) 40%, var(--app-border, #e0e4ea));
  box-shadow: 0 8px 22px -16px color-mix(in srgb, var(--mx-accent, #2080f0) 80%, transparent);
  transform: translateY(-1px);
}

.song__idx {
  font-size: 12px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.45));
}

.song__art {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  overflow: hidden;
  display: grid;
  place-items: center;
  font-size: 18px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(
    var(--angle, 135deg),
    var(--mx-accent, #2080f0),
    color-mix(in srgb, var(--mx-accent, #2080f0) 45%, var(--app-text, #000))
  );
}

.song__art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.song__main {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.song__name {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.song__by {
  font-size: 12px;
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.45));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.song__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sel {
  padding: 5px 8px;
  border-radius: 999px;
  border: 1px solid var(--app-border, #e0e4ea);
  background: var(--app-bg, transparent);
  color: inherit;
  font-size: 12px;
}

@container page (max-width: 640px) {
  .song {
    grid-template-columns: 44px minmax(0, 1fr);
  }

  .song__idx,
  .song__tier {
    display: none;
  }

  .song__actions {
    grid-column: 1 / -1;
    justify-content: flex-end;
  }
}

@media (prefers-reduced-motion: reduce) {
  .song {
    transition: none;
  }

  .song:hover {
    transform: none;
  }
}
</style>
