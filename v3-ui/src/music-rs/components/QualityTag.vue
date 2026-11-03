<script setup lang="ts">
// 音质标签：按档位配色（Hi-Res/母带金色 · 无损强调色 · 其余低调）。

import { computed } from 'vue'
import { qualityLabel } from '../store'
import { qualityTier } from '../ui-kit'

const props = defineProps<{ quality?: string; selected?: boolean }>()

const tier = computed(() => qualityTier(props.quality))
</script>

<template>
  <span class="q-tag" :class="[`q-tag--${tier}`, { 'q-tag--on': selected }]">
    <span v-if="tier !== 'standard'" class="q-tag__gem" aria-hidden="true" />
    {{ qualityLabel(quality) }}
  </span>
</template>

<style scoped>
.q-tag {
  --q: var(--app-text-secondary, #6b7280);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.6;
  white-space: nowrap;
  color: var(--q);
  background: color-mix(in srgb, var(--q) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--q) 26%, transparent);
}

.q-tag--lossless {
  --q: var(--mx-accent, var(--app-accent, #2080f0));
}

.q-tag--gold {
  --q: var(--mx-gold, #b8860b);
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--q) 22%, transparent),
    color-mix(in srgb, var(--q) 6%, transparent)
  );
}

.q-tag__gem {
  width: 6px;
  height: 6px;
  transform: rotate(45deg);
  border-radius: 1px;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
}

.q-tag--on {
  color: var(--app-surface, #fff);
  background: var(--q);
  border-color: var(--q);
}

.q-tag--on .q-tag__gem {
  box-shadow: none;
}
</style>
