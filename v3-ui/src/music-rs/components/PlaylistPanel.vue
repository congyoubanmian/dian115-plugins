<script setup lang="ts">
// 我的歌单分页：网易云 / QQ 音乐歌单列表 → 歌单内曲目 → 整单入队。
//
// 列表与曲目都走插件 lib/music-api.js（ctx.http）。两个来源的差异都在 store 里分派：
// - 网易云：歌单列表 + 逐页曲目（v6 全量索引），「整单下载」由 lib/queue-pages.js
//   分批翻页（每批 5 页 = 500 首）入队，后端按 next_page 续跑；
// - QQ 音乐：歌单列表按 kind 分「我创建的 / 收藏的」，另有「每日推荐」「我喜欢」两个
//   特殊入口（走各自的后端接口）；曲目按 begin/num 游标取，整单入队同样走 queue-pages。
//
// 空态与错误态都如实呈现：未登录、缺账号标识（encryptUin）等提示直接落在页面上，
// 不把「读不到」显示成「没有歌单」。

import { computed, reactive } from 'vue'
import { NButton, NTag } from 'naive-ui'
import { SOURCES, qualitiesOfSource, useMusicStore } from '../store'
import type { PlaylistItem } from '../types'
import SongTable from './SongTable.vue'

const store = useMusicStore()
const {
  source,
  playlists,
  playlistView,
  playlistSongs,
  playlistTotal,
  playlistPage,
  playlistProgress,
  playlistQuality,
  playlistNotice,
  playlistError,
  playlistSongsError,
  playlistsLoaded,
  playlistCreated,
  playlistFavorites,
  specialPlaylists,
  busy,
} = store

/** 封面加载失败的歌单（原生版加载失败就把 <img> 摘掉）。 */
const coverFailed = reactive(new Set<string>())

/** 详情区的音质档位：按打开时那个歌单的来源取（别跟着搜索页的来源漂）。 */
const detailQualities = computed<string[]>(() => qualitiesOfSource(playlistView.value?.source ?? source.value))

/** 歌单分段：QQ 分「我创建的 / 收藏的」；网易云只有一张列表（不分段）。
 *  empty 是该分区的空态文案（空数组时显示；空串 = 不显示）。 */
const sections = computed<{ key: string; title: string; items: PlaylistItem[]; empty: string }[]>(() => {
  if (source.value !== 'qq') {
    return playlists.value.length ? [{ key: 'all', title: '', items: playlists.value, empty: '' }] : []
  }
  return [
    { key: 'created', title: '我创建的', items: playlistCreated.value, empty: emptyHint('created') },
    { key: 'fav', title: '收藏的', items: playlistFavorites.value, empty: emptyHint('fav') },
  ]
})

const moreLabel = computed(
  () => `加载更多（已载 ${playlistSongs.value.length}/${playlistTotal.value}）`,
)

/**
 * 分区的空态文案：分清「还没加载」与「加载过但确实是空的」。
 *
 * - 还没加载过：不能说「没有歌单」（那是在断言一件没验证的事）；
 * - 收藏区读不到（后端给了 notice）：也不说「没有收藏的歌单」——上方 notice 已经
 *   说明是「读不到」，两句话同时出现会自相矛盾。
 */
function emptyHint(sectionKey: string): string {
  if (!playlistsLoaded.value) {
    // 还没拉过：只在第一个分区提示一次（别把「没加载」说成「没有歌单」）。
    return sectionKey === 'created' ? '点「刷新」加载歌单。' : ''
  }
  if (sectionKey === 'fav' && playlistNotice.value) return '收藏的歌单读不到（见上方提示）。'
  return sectionKey === 'created' ? '还没有创建的歌单。' : '没有收藏的歌单。'
}

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

    <!-- 后端给的提示 / 真实错误：如实显示，不静默也不美化 -->
    <p v-if="playlistError" class="hint hint--error">{{ playlistError }}</p>
    <p v-if="playlistNotice" class="hint hint--warn">{{ playlistNotice }}</p>

    <!-- QQ 特殊入口：每日推荐 / 我喜欢（不是普通歌单，取曲目走各自的后端接口） -->
    <div v-if="specialPlaylists.length" class="entry-row">
      <button
        v-for="entry in specialPlaylists"
        :key="entry.id"
        type="button"
        class="pl-entry"
        @click="store.openPlaylist(entry)"
      >
        <span class="pl-entry__name">{{ entry.name }}</span>
        <span class="pl-entry__meta">{{ entry.count > 0 ? `${entry.count} 首` : '点开查看' }}</span>
      </button>
    </div>

    <!-- 分段列表 -->
    <section v-for="section in sections" :key="section.key" class="pl-section">
      <h4 v-if="section.title" class="seg-title">
        {{ section.title }}<span class="seg-count">{{ section.items.length }}</span>
      </h4>
      <div v-if="section.items.length" class="pl-grid">
        <button
          v-for="playlist in section.items"
          :key="playlist.id"
          type="button"
          class="pl-card"
          @click="store.openPlaylist(playlist)"
        >
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
          <div class="pl-meta">
            {{ playlist.count ?? 0 }} 首 · {{ playlist.creator || '' }}
            <NTag v-if="playlist.private" size="tiny" :bordered="false">私密</NTag>
          </div>
        </button>
      </div>
      <p v-else-if="!playlistError && section.empty" class="hint">{{ section.empty }}</p>
    </section>

    <p v-if="source === 'netease' && !playlists.length && !playlistError" class="hint">
      第一次进这个页签会拉取网易云「我的歌单」（需登录）。
    </p>
  </div>

  <!-- 歌单详情 -->
  <div v-else>
    <div class="row">
      <NButton size="small" secondary @click="store.closePlaylist()">← 返回歌单列表</NButton>
      <h3 class="card-title">{{ playlistView.name || '歌单' }}</h3>
      <span class="hint-inline">统一音质:</span>
      <select :value="playlistQuality" class="sel" @change="onQualityChange">
        <option v-for="value in detailQualities" :key="value" :value="value">{{ store.qualityLabel(value) }}</option>
      </select>
      <NButton size="small" type="primary" :loading="busy === 'pl-all'" @click="store.downloadPlaylistAll()">
        整单下载
      </NButton>
    </div>

    <SongTable v-if="playlistSongs.length" :songs="playlistSongs" @download="store.downloadSong" />
    <p v-else-if="playlistSongsError" class="hint hint--error">{{ playlistSongsError }}</p>
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

.hint--error {
  color: #d03050;
}

.hint--warn {
  color: #d97706;
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

/* QQ 特殊入口（每日推荐 / 我喜欢） */
.entry-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.pl-entry {
  display: grid;
  gap: 2px;
  text-align: left;
  padding: 10px 14px;
  border: 1px solid var(--app-border, #e0e4ea);
  border-radius: 10px;
  background: var(--app-bg, transparent);
  color: inherit;
  cursor: pointer;
}

.pl-entry:hover {
  border-color: var(--app-accent, #2080f0);
}

.pl-entry__name {
  font-size: 13px;
  font-weight: 500;
}

.pl-entry__meta {
  font-size: 11px;
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.45));
}

/* 分段 */
.pl-section {
  display: grid;
  gap: 8px;
}

.seg-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.6));
  display: flex;
  align-items: center;
  gap: 6px;
}

.seg-count {
  font-size: 11px;
  font-weight: 400;
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent, #2080f0) 12%, transparent);
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

/* 私密标记（QQ 自建歌单） */
.pl-meta :deep(.n-tag) {
  vertical-align: middle;
  margin-left: 4px;
}
</style>
