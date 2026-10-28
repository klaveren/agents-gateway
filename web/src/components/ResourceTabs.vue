<script setup lang="ts">
import type { TResourceKind } from '@/lib/types'

/** As guias de Skills e de Commands: a lista (o cadastro), o construtor e o protocolo. */
defineProps<{ kind: TResourceKind; active: 'list' | 'build' | 'protocol' }>()

const TABS = [
  { key: 'list', label: 'Lista', path: '' },
  { key: 'build', label: 'Construir', path: '/build' },
  { key: 'protocol', label: 'Protocolo', path: '/protocol' },
] as const
</script>

<template>
  <nav class="flex gap-1 text-sm" aria-label="Guias">
    <RouterLink
      v-for="tab in TABS"
      :key="tab.key"
      :to="`/${kind === 'skill' ? 'skills' : 'commands'}${tab.path}`"
      class="rounded-full px-3 py-1"
      :class="active === tab.key ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/60'"
      :aria-current="active === tab.key ? 'page' : undefined"
    >
      {{ tab.label }}
    </RouterLink>
  </nav>
</template>
