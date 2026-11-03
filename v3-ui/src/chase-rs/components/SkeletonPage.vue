<script setup lang="ts">
// 首次读状态时的骨架屏：与正式 bento 布局同形，带流光动画（减少动效时静止）。
// 读状态的提示文字保留在骨架上方，屏幕阅读器同样能读到。
//
// 占位块用 shared SkeletonBlock（统一微光动效），.tile / .sk-tile 的基础布局
// 仍由 styles.css 提供，保证骨架与正式瓦片同宽同高。

import SkeletonBlock from '../../shared/components/SkeletonBlock.vue'
</script>

<template>
  <div class="c-bento" aria-busy="true">
    <section class="card c-loading-note">
      <div class="alert alert-info">
        <strong>正在读取状态…</strong>
        <p>正在从宿主存储读取追剧管家的状态文档，请稍候。</p>
      </div>
    </section>
    <section class="card c-stats" aria-hidden="true">
      <div class="c-tiles">
        <div v-for="n in 8" :key="n" class="tile sk-tile" :class="n === 1 ? 'tile-k-tv_intents' : n === 3 ? 'tile-k-patched' : ''">
          <SkeletonBlock width="40%" height="12px" radius="8px" />
          <SkeletonBlock width="55%" height="28px" radius="8px" />
        </div>
      </div>
    </section>
    <section class="card c-report" aria-hidden="true">
      <SkeletonBlock width="50%" height="12px" radius="8px" />
      <SkeletonBlock height="240px" radius="30px" />
    </section>
    <section class="card c-cal" aria-hidden="true">
      <SkeletonBlock width="30%" height="12px" radius="8px" />
      <div class="sk-cols">
        <SkeletonBlock v-for="n in 7" :key="n" height="140px" radius="8px" />
      </div>
    </section>
    <section class="card c-align" aria-hidden="true">
      <SkeletonBlock width="30%" height="12px" radius="8px" />
      <div class="sk-shows">
        <div v-for="n in 4" :key="n" class="sk-show">
          <SkeletonBlock class="sk-ring" width="56px" height="56px" radius="50%" />
          <div class="sk-show-lines">
            <SkeletonBlock width="70%" height="12px" radius="8px" />
            <SkeletonBlock width="40%" height="12px" radius="8px" />
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
