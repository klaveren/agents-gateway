<script setup lang="ts">
import RailMenu, { type IRailMenuItem } from './RailMenu.vue'

/**
 * O menu RECURSOS (só admin): o que os agentes usam para trabalhar — as skills (carregadas com `use_resource`) e os
 * commands (`/nome` na caixa de mensagem).
 */
defineProps<{ placement: 'side' | 'up'; active?: string }>()

const ITEMS: IRailMenuItem[] = [
  { to: '/skills', key: 'skills', label: 'Skills', hint: 'Modos de fazer que o agente carrega', icon: 'bolt' },
  { to: '/commands', key: 'commands', label: 'Commands', hint: 'Pedidos prontos com /nome', icon: 'slash' },
]
</script>

<template>
  <RailMenu title="Recursos" icon="bolt" :items="ITEMS" :placement="placement" :active="active" />
</template>
