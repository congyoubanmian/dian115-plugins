<script setup lang="ts">
// 搜索分页：来源切换 + 关键字 + 结果表（单曲入队入口）。
//
// 搜索走插件 lib/music-api.js 的网络层（ctx.http 发请求），网易云每页 30 条、QQ 每页 20 条；
// 「加载更多」按页续拉，结果追加在已有列表之后。

import { computed } from 'vue'
import { NButton, NInput } from 'naive-ui'
import { Search as SearchIcon } from '@lucide/vue'
import { SOURCES, useMusicStore } from '../store'
import SongTable from './SongTable.vue'

const store = useMusicStore()
const { source, query, searchResults, searchPage, searchTotal, busy } = store

/** 还有下一页吗（QQ 每页 20、网易云每页 30；网易云有 total 时按 total 判）。 */
const hasMore = computed(() => {
  const count = searchResults.value.length
  if (!count) return false
  const pageSize = source.value === 'qq' ? 20 : 30
  return searchTotal.value !== null ? count < searchTotal.value : count % pageSize === 0
})

const summary = computed(() => {
  const count = searchResults.value.length
  const total = searchTotal.value !== null ? ` / 共 ${searchTotal.value} 条` : ''
  return `已显示 ${count} 条${total} · 第 ${searchPage.value} 页`
})
</script>

<template>
  <div class="row">
    <h3 class="card-title">搜索</h3>
    <span class="seg">
      <button
        v-for="item in SOURCES"
        :key="item.id"
        type="button"
        :class="{ on: source === item.id }"
        @click="store.switchSource(item.id)"
      >
        {{ item.name }}
      </button>
    </span>
    <NInput
      v-model:value="query"
      class="grow"
      size="small"
      placeholder="歌名 歌手"
      @keyup.enter="store.runSearch(1)"
    />
    <NButton size="small" type="primary" :loading="busy === 'search'" @click="store.runSearch(1)">
      <template #icon><SearchIcon :size="14" /></template>
      搜索
    </NButton>
  </div>

  <SongTable v-if="searchResults.length" :songs="searchResults" @download="store.downloadSong" />
  <p v-else class="hint">输入歌名或「歌名 歌手」后回车/点搜索。</p>

  <div v-if="searchResults.length" class="row">
    <span class="hint-inline">{{ summary }}</span>
    <NButton v-if="hasMore" size="small" secondary :loading="busy === 'search'" @click="store.runSearch(searchPage + 1)">
      加载更多
    </NButton>
  </div>

  <p class="hint">
    点「下载」只是入队（去重按 来源+歌曲 id+音质）；真正的取链与下载由后台任务推进，进度看「任务」。
  </p>
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

.grow {
  flex: 1;
  min-width: 160px;
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
</style>
