<script setup lang="ts">
import RailMenu, { type IRailMenuItem } from './RailMenu.vue'

/**
 * O menu PROJETO (só admin): o que vale para as conversas do projeto em uso — o Ambiente (o que toda conversa recebe:
 * rules e specs inteiras, com o peso), as Rules (o cadastro, globais e do projeto, com o construtor) e os Agendamentos
 * (o que os agentes rodam sozinhos no projeto, pela próxima execução).
 */
defineProps<{ placement: 'side' | 'up'; active?: string }>()

const ITEMS: IRailMenuItem[] = [
  { to: '/environment', key: 'environment', label: 'Ambiente', hint: 'O que toda conversa do projeto recebe', icon: 'folder' },
  { to: '/rules', key: 'rules', label: 'Rules', hint: 'Regras que todo agente respeita', icon: 'rule' },
  { to: '/schedules', key: 'schedules', label: 'Agendamentos', hint: 'O que os agentes rodam sozinhos, e quando', icon: 'clock' },
]
</script>

<template>
  <RailMenu title="Projeto" icon="folder" :items="ITEMS" :placement="placement" :active="active" />
</template>
