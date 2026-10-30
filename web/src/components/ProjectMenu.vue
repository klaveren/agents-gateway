<script setup lang="ts">
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import RailMenu, { type IRailMenuItem } from './RailMenu.vue'

/**
 * O menu PROJETO: o que vale para as conversas do projeto em uso — o Ambiente (o que toda conversa recebe:
 * rules e specs inteiras, com o peso), as Rules (o cadastro, globais e do projeto, com o construtor) e os Agendamentos
 * (o que os agentes rodam sozinhos no projeto, pela próxima execução), as Permissões e as Contas (as credenciais do
 * terminal do projeto). E o Importador: o que um repositório do projeto tem de recurso agêntico, só para ler.
 * O MEMBRO (não admin) vê só o que a API lhe abre do projeto: os MCPs dele, só leitura.
 */
defineProps<{ placement: 'side' | 'up'; active?: string }>()

const ITEMS: IRailMenuItem[] = [
  { to: '/environment', key: 'environment', label: 'Ambiente', hint: 'O que toda conversa do projeto recebe', icon: 'folder' },
  { to: '/rules', key: 'rules', label: 'Rules', hint: 'Regras que todo agente respeita', icon: 'rule' },
  { to: '/permissions', key: 'permissions', label: 'Permissões', hint: 'O que os agentes podem fazer: comandos, arquivos, MCP', icon: 'key' },
  { to: '/accounts', key: 'accounts', label: 'Contas', hint: 'As credenciais que o terminal do projeto recebe: GitHub, variáveis', icon: 'key' },
  { to: '/schedules', key: 'schedules', label: 'Agendamentos', hint: 'O que os agentes rodam sozinhos, e quando', icon: 'clock' },
  { to: '/import', key: 'import', label: 'Importador', hint: 'O que um repositório tem de agentes, skills e docs', icon: 'box' },
]
const MEMBER_ITEMS: IRailMenuItem[] = [{ to: '/mcp', key: 'mcp', label: 'MCPs', hint: 'Os servidores de ferramentas do projeto (só leitura)', icon: 'plug' }]

const auth = useAuthStore()
const items = computed(() => (auth.isAdmin ? ITEMS : MEMBER_ITEMS))
</script>

<template>
  <RailMenu title="Projeto" icon="folder" :items="items" :placement="placement" :active="active" />
</template>
