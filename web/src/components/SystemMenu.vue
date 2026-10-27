<script setup lang="ts">
import RailMenu, { type IRailMenuItem } from './RailMenu.vue'

/**
 * O menu do SISTEMA (só admin): Projetos, Usuários, Modelos, MCPs, Pacotes e Configuração num botão só, como o da conta.
 * ⚖️ O trilho fica com o que se usa todo dia (conversas, uso, agentes); o que se configura de vez em
 * quando mora aqui. Rules, specs e ADRs moram no menu Docs.
 */
defineProps<{ placement: 'side' | 'up'; active?: string }>()

const ITEMS: IRailMenuItem[] = [
  { to: '/projects', key: 'projects', label: 'Projetos', hint: 'Pastas, membros e o que é de cada um', icon: 'agents' },
  { to: '/users', key: 'users', label: 'Usuários', hint: 'Contas, papéis e acessos', icon: 'users' },
  { to: '/models', key: 'providers', label: 'Modelos', hint: 'Provedores, chaves, assinaturas e modelos', icon: 'key' },
  { to: '/mcp', key: 'mcp', label: 'MCPs', hint: 'Servidores de ferramentas', icon: 'plug' },
  { to: '/packages', key: 'packages', label: 'Pacotes', hint: 'Ferramentas do servidor', icon: 'box' },
  { to: '/settings', key: 'settings', label: 'Configuração', hint: 'Operação, limites e implantação', icon: 'settings' },
]
</script>

<template>
  <RailMenu title="Sistema" icon="settings" :items="ITEMS" :placement="placement" :active="active" />
</template>
