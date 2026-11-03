<script setup lang="ts">
// 首次读状态时的骨架屏：与正式 bento 布局同形，带流光动画（减少动效时静止）。
// 读状态的提示文字保留在骨架上方，屏幕阅读器同样能读到。
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
          <span class="sk sk-line w40" />
          <span class="sk sk-num" />
        </div>
      </div>
    </section>
    <section class="card c-report" aria-hidden="true">
      <span class="sk sk-line w50" />
      <span class="sk sk-phone" />
    </section>
    <section class="card c-cal" aria-hidden="true">
      <span class="sk sk-line w30" />
      <div class="sk-cols"><span v-for="n in 7" :key="n" class="sk sk-col" /></div>
    </section>
    <section class="card c-align" aria-hidden="true">
      <span class="sk sk-line w30" />
      <div class="sk-shows">
        <div v-for="n in 4" :key="n" class="sk-show">
          <span class="sk sk-ring" />
          <div class="sk-show-lines"><span class="sk sk-line w70" /><span class="sk sk-line w40" /></div>
        </div>
      </div>
    </section>
  </div>
</template>
