<script setup lang="ts">
  import RailMenu, { type IRailMenuItem } from './RailMenu.vue'

  /**
   * O menu do SISTEMA (só admin): Projetos, Usuários, Modelos, Grupos de modelos, MCPs, os Logs (API, Erros, Catálogo), Pacotes e Configuração num botão só, como o da conta.
   * ⚖️ O trilho fica com o que se usa todo dia (conversas, uso, agentes); o que se configura de vez em
   * quando mora aqui. Specs, ADRs e conhecimento moram no menu Docs; as rules e o ambiente, no menu Projeto.
   */
  defineProps<{ placement: 'side' | 'up'; active?: string }>()

  const ITEMS: IRailMenuItem[] = [
    { to: '/projects', key: 'projects', label: 'Projetos', hint: 'Pastas, membros e o que é de cada um', icon: 'agents' },
    { to: '/users', key: 'users', label: 'Usuários', hint: 'Contas, papéis e acessos', icon: 'users' },
    { to: '/models', key: 'providers', label: 'Modelos', hint: 'Provedores, chaves, assinaturas e modelos', icon: 'key' },
    { to: '/model-groups', key: 'model-groups', label: 'Troca automática de modelo', hint: 'Quando um modelo falha, segue no próximo', icon: 'key' },
    { to: '/mcp', key: 'mcp', label: 'MCPs', hint: 'Servidores de ferramentas', icon: 'plug' },
    {
      key: 'logs',
      label: 'Logs',
      hint: 'API, erros e catálogo',
      icon: 'shield',
      children: [
        { to: '/audit', key: 'audit', label: 'API', hint: 'Quem fez o quê, quando e de onde', icon: 'shield' },
        { to: '/errors', key: 'errors', label: 'Erros', hint: 'Ferramentas e turnos que falharam', icon: 'warn' },
        { to: '/catalog/history', key: 'catalog-history', label: 'Catálogo', hint: 'O que mudou, quem mudou, restaurar', icon: 'clock' },
      ],
    },
    { to: '/packages', key: 'packages', label: 'Pacotes', hint: 'Ferramentas do servidor', icon: 'box' },
    { to: '/security/secrets', key: 'security', label: 'Segurança', hint: 'Segredos: o que a máscara esconde da saída das ferramentas', icon: 'key' },
    { to: '/settings', key: 'settings', label: 'Configuração', hint: 'Operação, limites e implantação', icon: 'settings' },
  ]
</script>

<template>
  <RailMenu title="Sistema" icon="settings" :items="ITEMS" :placement="placement" :active="active" />
</template>
