<script setup lang="ts">
import RailMenu, { type IRailMenuItem } from './RailMenu.vue'

/**
 * O menu DOCS (só admin): o que os agentes consultam — as specs, as ADRs e o conhecimento (no índice, lidos com
 * `read_doc`). ⚖️ As rules moram no menu Projeto, junto do Ambiente.
 */
defineProps<{ placement: 'side' | 'up'; active?: string }>()

const ITEMS: IRailMenuItem[] = [
  { to: '/specs', key: 'specs', label: 'Specs', hint: 'Como algo deve ser', icon: 'doc' },
  { to: '/adrs', key: 'adrs', label: 'ADRs', hint: 'Decisões tomadas e o porquê', icon: 'doc' },
  { to: '/knowledge', key: 'knowledge', label: 'Conhecimento', hint: 'Estudos de um tema, com as fontes', icon: 'doc' },
]
</script>

<template>
  <RailMenu title="Docs" icon="doc" :items="ITEMS" :placement="placement" :active="active" />
</template>
