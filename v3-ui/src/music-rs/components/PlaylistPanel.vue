<script setup lang="ts">
// 我的歌单分页：网易云歌单列表 → 歌单内曲目 → 整单入队。
//
// 列表与曲目都走插件 lib/music-api.js（ctx.http）。「整单下载」不依赖已加载条数：
// 由 lib/queue-pages.js 分批翻页（每批 5 页 = 500 首）入队，后端按 next_page 续跑。

import { computed, reactive } from 'vue'
import { NButton, NTag } from 'naive-ui'
import { SOURCES, useMusicStore } from '../store'
import { LEVELS } from '../plugin-api'
import SongTable from './SongTable.vue'

const store = useMusicStore()
const { source, playlists, playlistView, playlistSongs, playlistTotal, playlistPage, playlistProgress, playlistQuality, busy } =
  store

/** 封面加载失败的歌单（原生版加载失败就把 <img> 摘掉）。 */
const coverFailed = reactive(new Set<string>())

const batchQualities = LEVELS as string[]

const moreLabel = computed(
  () => `加载更多（已载 ${playlistSongs.value.length}/${playlistTotal.value}）`,
)

function onCoverError(id: string): void {
  coverFailed.add(id)
}

/** 统一音质选择（原生 <select>：用 :value + @change，不走 v-model 的 select 指令）。 */
function onQualityChange(event: Event): void {
  store.setPlaylistQuality((event.target as HTMLSelectElement).value)
}
</script>

<template>
  <!-- 歌单列表 -->
  <div v-if="!playlistView">
    <div class="row">
      <h3 class="card-title">我的歌单</h3>
      <span class="seg">
        <button
          v-for="item in SOURCES"
          :key="item.id"
          type="button"
          :class="{ on: source === item.id }"
          @click="store.switchPlaylistSource(item.id)"
        >
          {{ item.name }}
        </button>
      </span>
      <NButton size="small" secondary :loading="busy === 'playlists'" @click="store.loadPlaylists()">刷新</NButton>
    </div>

    <div v-if="playlists.length" class="pl-grid">
      <button v-for="playlist in playlists" :key="playlist.id" type="button" class="pl-card" @click="store.openPlaylist(playlist)">
        <div class="pl-cover">
          <img
            v-if="store.coverFor(playlist.id) && !coverFailed.has(playlist.id)"
            :src="store.coverFor(playlist.id)"
            alt=""
            loading="lazy"
            @error="onCoverError(playlist.id)"
          />
        </div>
        <div class="pl-name">{{ playlist.name || '—' }}</div>
        <div class="pl-meta">{{ playlist.count ?? 0 }} 首 · {{ playlist.creator || '' }}</div>
      </button>
    </div>
    <p v-else class="hint">第一次进这个页签会拉取网易云「我的歌单」（需登录）。</p>
  </div>

  <!-- 歌单详情 -->
  <div v-else>
    <div class="row">
      <NButton size="small" secondary @click="store.closePlaylist()">← 返回歌单列表</NButton>
      <h3 class="card-title">{{ playlistView.name || '歌单' }}</h3>
      <span class="hint-inline">统一音质:</span>
      <select :value="playlistQuality" class="sel" @change="onQualityChange">
        <option v-for="value in batchQualities" :key="value" :value="value">{{ store.qualityLabel(value) }}</option>
      </select>
      <NButton size="small" type="primary" :loading="busy === 'pl-all'" @click="store.downloadPlaylistAll()">
        整单下载
      </NButton>
    </div>

    <SongTable v-if="playlistSongs.length" :songs="playlistSongs" @download="store.downloadSong" />
    <p v-else class="hint">这个歌单还没有取到曲目（可能需要登录或歌单为空）。</p>

    <div v-if="playlistSongs.length" class="row">
      <NButton
        v-if="playlistSongs.length < playlistTotal"
        size="small"
        secondary
        :loading="busy === 'pl-songs'"
        @click="store.fetchPlaylistSongs(playlistPage + 1)"
      >
        {{ moreLabel }}
      </NButton>
      <NTag v-else size="small" :bordered="false" type="info">已载入全部 {{ playlistTotal }} 首</NTag>
    </div>

    <p v-if="playlistProgress" class="hint">{{ playlistProgress }}</p>

    <p class="hint">
      「整单下载」按右上角选的统一音质，让后台分批翻页把整张歌单入队（每批 500 首）——不依赖已加载的条数。
    </p>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.card-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.seg {
  display: inline-flex;
  border: 1px solid var(--app-border, #e0e4ea);
  border-radius: 9px;
  overflow: hidden;
}

.seg button {
  border: none;
  background: transparent;
  color: inherit;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
}

.seg button.on {
  background: var(--app-accent, #2080f0);
  color: #fff;
}

.hint {
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.45));
  font-size: 12px;
  margin: 0;
  line-height: 1.6;
}

.hint-inline {
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.45));
  font-size: 12px;
}

.sel {
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid var(--app-border, #e0e4ea);
  background: var(--app-bg, transparent);
  color: inherit;
  font-size: 12px;
}

.pl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px;
}

.pl-card {
  display: grid;
  gap: 6px;
  text-align: left;
  padding: 10px;
  border: 1px solid var(--app-border, #e0e4ea);
  border-radius: 10px;
  background: var(--app-bg, transparent);
  color: inherit;
  cursor: pointer;
}

.pl-card:hover {
  border-color: var(--app-accent, #2080f0);
}

.pl-cover {
  aspect-ratio: 1;
  border-radius: 8px;
  overflow: hidden;
  background: color-mix(in srgb, var(--app-accent, #2080f0) 10%, transparent);
}

.pl-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.pl-name {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pl-meta {
  font-size: 11px;
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.45));
}
</style>
