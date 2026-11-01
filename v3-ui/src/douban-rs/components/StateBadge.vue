<script setup lang="ts">
// 状态徽标（对应原生版的 db-badge-*）。
// 配色档：muted / info / ok / warn / error，映射到 naive-ui 的 NTag 类型，
// 这样明暗两套主题下都跟着宿主走。

import { computed } from 'vue'
import { NTag } from 'naive-ui'

const props = withDefaults(defineProps<{ label: string; tone?: string }>(), { tone: 'muted' })

type TagType = 'default' | 'success' | 'info' | 'warning' | 'error'

const type = computed<TagType>(() => {
  switch (props.tone) {
    case 'ok':
      return 'success'
    case 'warn':
      return 'warning'
    case 'error':
      return 'error'
    case 'info':
      return 'info'
    default:
      return 'default'
  }
})
</script>

<template>
  <NTag size="small" :type="type" :bordered="false" round>{{ props.label }}</NTag>
</template>
