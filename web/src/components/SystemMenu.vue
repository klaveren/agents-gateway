<script setup lang="ts">
  import RailMenu, { type IRailMenuItem } from './RailMenu.vue'

  /**
   * O menu do SISTEMA (só admin): Projetos, Usuários, Modelos (Provedores, Fallback), MCPs, Pacotes, Configuração e, por último, os Logs (API, Erros, Catálogo) num botão só, como o da conta.
   * ⚖️ O trilho fica com o que se usa todo dia (conversas, uso, agentes); o que se configura de vez em
   * quando mora aqui. Specs, ADRs e conhecimento moram no menu Docs; as rules e o ambiente, no menu Projeto.
   */
  defineProps<{ placement: 'side' | 'up'; active?: string }>()

  const ITEMS: IRailMenuItem[] = [
    { to: '/projects', key: 'projects', label: 'Projetos', hint: 'Pastas, membros e o que é de cada um', icon: 'folder' },
    { to: '/users', key: 'users', label: 'Usuários', hint: 'Contas, papéis e acessos', icon: 'users' },
    {
      key: 'models',
      label: 'Modelos',
      hint: 'Provedores e fallback',
      icon: 'tokens',
      children: [
        { to: '/models', key: 'providers', label: 'Provedores', hint: 'Chaves, assinaturas e modelos', icon: 'key' },
        { to: '/model-groups', key: 'model-groups', label: 'Fallback', hint: 'Quando um modelo falha, segue no próximo', icon: 'refresh' },
      ],
    },
    { to: '/mcp', key: 'mcp', label: 'MCPs', hint: 'Servidores de ferramentas', icon: 'plug' },
    { to: '/packages', key: 'packages', label: 'Pacotes', hint: 'Ferramentas do servidor', icon: 'box' },
    { to: '/security/secrets', key: 'security', label: 'Segurança', hint: 'Segredos: o que a máscara esconde da saída das ferramentas', icon: 'shield' },
    { to: '/settings', key: 'settings', label: 'Configuração', hint: 'Operação, limites e implantação', icon: 'settings' },
    {
      key: 'logs',
      label: 'Logs',
      hint: 'API, erros e catálogo',
      icon: 'list',
      children: [
        { to: '/audit', key: 'audit', label: 'API', hint: 'Quem fez o quê, quando e de onde', icon: 'globe' },
        { to: '/errors', key: 'errors', label: 'Erros', hint: 'Ferramentas e turnos que falharam', icon: 'warn' },
        { to: '/catalog/history', key: 'catalog-history', label: 'Catálogo', hint: 'O que mudou, quem mudou, restaurar', icon: 'clock' },
      ],
    },
  ]
</script>

<template>
  <RailMenu title="Sistema" icon="settings" :items="ITEMS" :placement="placement" :active="active" />
</template>
