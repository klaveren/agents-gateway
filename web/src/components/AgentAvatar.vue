<script setup lang="ts">
import { computed } from 'vue'
import { initials, providerColor } from '@/lib/format'

const props = withDefaults(defineProps<{ name: string; provider: string; size?: 'sm' | 'md' | 'lg' }>(), { size: 'md' })

const color = computed(() => providerColor(props.provider))
const dimensions = computed(() => ({ sm: 'h-8 w-8 text-xs', md: 'h-11 w-11 text-sm', lg: 'h-14 w-14 text-base' })[props.size])
</script>

<template>
  <div class="grid shrink-0 place-items-center rounded-full font-semibold text-white shadow-inner" :class="[color, dimensions]">{{ initials(name) }}</div>
</template>
