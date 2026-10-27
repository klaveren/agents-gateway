<script setup lang="ts">
import RailMenu, { type IRailMenuItem } from './RailMenu.vue'

/**
 * O menu DOCS (só admin): o que os agentes recebem e consultam — as rules (no prompt), as specs e as ADRs (no
 * índice, lidas com `read_doc`).
 */
defineProps<{ placement: 'side' | 'up'; active?: string }>()

const ITEMS: IRailMenuItem[] = [
  { to: '/rules', key: 'rules', label: 'Rules', hint: 'Regras que todo agente respeita', icon: 'rule' },
  { to: '/specs', key: 'specs', label: 'Specs', hint: 'Como algo deve ser', icon: 'doc' },
  { to: '/adrs', key: 'adrs', label: 'ADRs', hint: 'Decisões tomadas e o porquê', icon: 'doc' },
]
</script>

<template>
  <RailMenu title="Docs" icon="doc" :items="ITEMS" :placement="placement" :active="active" />
</template>
