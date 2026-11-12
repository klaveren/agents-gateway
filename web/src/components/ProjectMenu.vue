<script setup lang="ts">
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import RailMenu, { type IRailMenuItem } from './RailMenu.vue'

/**
 * O menu PROJETO: o que vale para as conversas do projeto em uso — o Ambiente (o que toda conversa recebe:
 * rules e specs inteiras, com o peso), as Rules (o cadastro, globais e do projeto, com o construtor) e os Agendamentos
 * (o que os agentes rodam sozinhos no projeto, pela próxima execução), as Permissões, as Contas (as credenciais do
 * terminal do projeto) e os Repositórios (onde as conversas abrem). E o Importador: o que um repositório do projeto tem de recurso agêntico, só para ler.
 * Só quem administra o projeto atual vê os itens de cima (o admin do gateway sem papel no projeto não). O MEMBRO vê só o que a API lhe abre do projeto: os MCPs dele, só leitura.
 * ⚖️ Os MCPs são UMA tela só, com o seletor de projeto dentro: quem tem o menu Sistema (o admin do gateway) acha o item lá, e aqui ele não se repete.
 */
defineProps<{ placement: 'side' | 'up'; active?: string }>()

const ITEMS: IRailMenuItem[] = [
  { to: '/environment', key: 'environment', label: 'Ambiente', hint: 'O que toda conversa do projeto recebe', icon: 'folder' },
  { to: '/rules', key: 'rules', label: 'Rules', hint: 'Regras que todo agente respeita', icon: 'rule' },
  { to: '/permissions', key: 'permissions', label: 'Permissões', hint: 'O que os agentes podem fazer: comandos, arquivos, MCP', icon: 'key' },
  { to: '/accounts', key: 'accounts', label: 'Contas', hint: 'As credenciais que o terminal do projeto recebe: GitHub, variáveis', icon: 'key' },
  { to: '/repositories', key: 'repositories', label: 'Repositórios', hint: 'Clonar, criar um git local, remover; as regras do git', icon: 'git' },
  { to: '/schedules', key: 'schedules', label: 'Agendamentos', hint: 'O que os agentes rodam sozinhos, e quando', icon: 'clock' },
  { to: '/import', key: 'import', label: 'Importador', hint: 'O que um repositório tem de agentes, skills e docs', icon: 'box' },
  { to: '/mcp', key: 'mcp', label: 'MCPs', hint: 'Os servidores de ferramentas do projeto', icon: 'plug' },
  { to: '/catalog/history', key: 'catalog-history', label: 'Histórico do catálogo', hint: 'O que mudou no projeto, quem mudou, restaurar e reverter lote', icon: 'clock' },
]
const MEMBER_ITEMS: IRailMenuItem[] = [{ to: '/mcp', key: 'mcp', label: 'MCPs', hint: 'Os servidores de ferramentas do projeto (só leitura)', icon: 'plug' }]

const auth = useAuthStore()
const projects = useProjectsStore()
const items = computed(() => (projects.manages ? ITEMS : MEMBER_ITEMS).filter((item) => item.key !== 'mcp' || !auth.isAdmin))
</script>

<template>
  <RailMenu title="Projeto" icon="folder" :items="items" :placement="placement" :active="active" />
</template>
