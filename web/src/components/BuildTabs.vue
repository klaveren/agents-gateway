<script setup lang="ts">
import { BUILD_KINDS, type TBuildKind } from '@/lib/builder'
import { lite } from '@/lib/edition'

/** As guias de Rules, Specs, ADRs, Skills e Commands: a lista (o cadastro), o construtor e o protocolo. */
defineProps<{ kind: TBuildKind; active: 'list' | 'build' | 'protocol' }>()

const TABS = [
  { key: 'list', label: 'Lista', path: '' },
  { key: 'build', label: 'Construir', path: '/build' },
  { key: 'protocol', label: 'Protocolo', path: '/protocol' },
] as const
</script>

<template>
  <!-- A lite não tem o construtor nem o protocolo: sobrava só "Lista", e a guia some. -->
  <nav v-if="!lite" class="flex gap-1 text-sm" aria-label="Guias">
    <RouterLink
      v-for="tab in TABS"
      :key="tab.key"
      :to="`${BUILD_KINDS[kind].base}${tab.path}`"
      class="rounded-full px-3 py-1"
      :class="active === tab.key ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/60'"
      :aria-current="active === tab.key ? 'page' : undefined"
    >
      {{ tab.label }}
    </RouterLink>
  </nav>
</template>
