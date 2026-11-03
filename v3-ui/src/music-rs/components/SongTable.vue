<script setup lang="ts">
// 歌曲表（搜索页与歌单页共用）：歌曲 / 歌手 / 专辑 / 音质 / 下载。
//
// 「下载」只是入队（去重按 来源+歌曲 id+音质），真正的取链与下载由后台任务推进。
// 每首歌可以单独选音质（选中值存在 store 的 songQuality 里，与原生版同语义）。

import { NButton } from 'naive-ui'
import { useMusicStore } from '../store'
import type { Song } from '../types'

defineProps<{ songs: Song[] }>()
const emit = defineEmits<{ (event: 'download', song: Song): void }>()

const store = useMusicStore()
const { busy } = store
</script>

<template>
  <div class="tbl-wrap">
    <table class="tbl">
      <thead>
        <tr>
          <th>歌曲</th>
          <th>歌手</th>
          <th>专辑</th>
          <th>音质</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="song in songs" :key="`${song.source ?? ''}-${song.id}`">
          <td>{{ song.name || '—' }}</td>
          <td>{{ song.singers || '—' }}</td>
          <td class="dim">{{ song.album || '—' }}</td>
          <td>
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
          </td>
          <td>
            <NButton size="tiny" type="primary" :disabled="!!busy" @click="emit('download', song)">下载</NButton>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.tbl-wrap {
  overflow: auto;
  border: 1px solid var(--app-border, #e0e4ea);
  border-radius: 10px;
  max-height: 420px;
}

.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.tbl th,
.tbl td {
  text-align: left;
  padding: 9px 12px;
  border-bottom: 1px solid var(--app-border, #e0e4ea);
  white-space: nowrap;
}

.tbl th {
  position: sticky;
  top: 0;
  background: var(--app-surface, #fff);
  font-weight: 600;
  z-index: 1;
}

.tbl td.dim {
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.45));
}

.sel {
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid var(--app-border, #e0e4ea);
  background: var(--app-bg, transparent);
  color: inherit;
  font-size: 12px;
}
</style>
