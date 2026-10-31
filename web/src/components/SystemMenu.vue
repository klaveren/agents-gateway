<script setup lang="ts">
  import RailMenu, { type IRailMenuItem } from './RailMenu.vue'

  /**
   * O menu do SISTEMA (só admin): Projetos, Usuários, Modelos, MCPs, Histórico do catálogo, Pacotes e Configuração num botão só, como o da conta.
   * ⚖️ O trilho fica com o que se usa todo dia (conversas, uso, agentes); o que se configura de vez em
   * quando mora aqui. Specs, ADRs e conhecimento moram no menu Docs; as rules e o ambiente, no menu Projeto.
   */
  defineProps<{ placement: 'side' | 'up'; active?: string }>()

  const ITEMS: IRailMenuItem[] = [
    { to: '/projects', key: 'projects', label: 'Projetos', hint: 'Pastas, membros e o que é de cada um', icon: 'agents' },
    { to: '/users', key: 'users', label: 'Usuários', hint: 'Contas, papéis e acessos', icon: 'users' },
    { to: '/models', key: 'providers', label: 'Modelos', hint: 'Provedores, chaves, assinaturas e modelos', icon: 'key' },
    { to: '/mcp', key: 'mcp', label: 'MCPs', hint: 'Servidores de ferramentas', icon: 'plug' },
    { to: '/catalog/history', key: 'catalog-history', label: 'Histórico do catálogo', hint: 'O que mudou, quem mudou, restaurar e reverter lote', icon: 'clock' },
    { to: '/packages', key: 'packages', label: 'Pacotes', hint: 'Ferramentas do servidor', icon: 'box' },
    { to: '/security/secrets', key: 'security', label: 'Segurança', hint: 'Segredos: o que a máscara esconde da saída das ferramentas', icon: 'key' },
    { to: '/settings', key: 'settings', label: 'Configuração', hint: 'Operação, limites e implantação', icon: 'settings' },
  ]
</script>

<template>
  <RailMenu title="Sistema" icon="settings" :items="ITEMS" :placement="placement" :active="active" />
</template>
