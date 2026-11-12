import { computed, onMounted, watch } from 'vue'
import { useScopedResources } from '@/composables/useCatalogLists'
import { BUILD_KINDS, builderAgentId, type TBuildKind } from '@/lib/builder'
import type { TPermissionCategory } from '@/lib/types'
import { useAccountsStore } from '@/stores/accounts'
import { useAgentsStore } from '@/stores/agents'
import { useMcpStore } from '@/stores/mcp'
import { useProjectsStore } from '@/stores/projects'
import { useRepositoriesStore } from '@/stores/repositories'

/** Um grupo de opções da lista (um `<optgroup>`). */
export interface IChoiceGroup {
  label: string
  /** `wildcard`: o curinga — vale numa regra, não num teste (que pergunta por um valor de verdade). */
  wildcard?: boolean
  options: Array<{ value: string; label: string }>
}

/**
 * ⚖️ AS CATEGORIAS DE PERMISSÃO QUE SE ESCOLHEM NUMA LISTA, não digitadas: o padrão é um item que existe (um agente, uma
 * skill, uma ferramenta de MCP, uma conta, um repositório). Terminal, Leitura, Escrita e Rede são padrões de comando,
 * caminho e host: seguem digitados. As listas são do projeto em uso (o seletor do topo); o padrão gravado que não está na
 * lista aparece como está (quem mostra é o editor), para não sumir.
 */
export function usePermissionChoices() {
  const projects = useProjectsStore()

  // Delegação e Triggers: os agentes (e, na delegação, os construtores do sistema).
  const agents = useAgentsStore()
  onMounted(() => void agents.ensure().catch(() => undefined))
  const agentOptions = computed(() => agents.list.map((agent) => ({ value: agent.id, label: `${agent.name} (${agent.id})` })))
  const delegateGroups = computed<IChoiceGroup[]>(() => [
    {
      label: 'Curingas',
      wildcard: true,
      options: [
        { value: '*', label: 'Todos os agentes (*)' },
        { value: 'builder-*', label: 'Todos os construtores do sistema (builder-*)' },
      ],
    },
    { label: 'Agentes', options: agentOptions.value },
    {
      label: 'Do sistema',
      options: (Object.keys(BUILD_KINDS) as TBuildKind[]).map((kind) => ({ value: builderAgentId(kind), label: `${BUILD_KINDS[kind].builder} (${builderAgentId(kind)})` })),
    },
  ])
  const triggerGroups = computed<IChoiceGroup[]>(() => [
    { label: 'Curingas', wildcard: true, options: [{ value: '*', label: 'Todos os agentes (*)' }] },
    { label: 'Agentes', options: agentOptions.value },
  ])

  // Skills: as globais e as do projeto em uso.
  const resources = useScopedResources(() => projects.current ?? null)
  const skillGroups = computed<IChoiceGroup[]>(() => [
    { label: 'Curingas', wildcard: true, options: [{ value: '*', label: 'Todas as skills (*)' }] },
    {
      label: 'Skills',
      options: resources.list.value.filter((item) => item.kind === 'skill').map((item) => ({ value: item.id, label: item.description ? `${item.id} — ${item.description}` : item.id })),
    },
  ])

  // MCP: os servidores ligados, com as ferramentas (o servidor fora do ar fica só com o "todas").
  const mcp = useMcpStore()
  onMounted(() => void mcp.ensure().catch(() => undefined))
  const servers = computed(() => mcp.list.filter((server) => server.enabled))
  watch(
    () => servers.value.map((server) => server.key),
    (keys) => keys.forEach((key) => void mcp.loadTools(key).catch(() => undefined)),
    { immediate: true },
  )
  const mcpGroups = computed<IChoiceGroup[]>(() => [
    { label: 'Curingas', wildcard: true, options: [{ value: '*', label: 'Todas as ferramentas de todos os MCPs (*)' }] },
    ...servers.value.map((server) => ({
      label: server.name,
      options: [
        { value: `${server.id}/*`, label: `Todas as ferramentas de ${server.name} (${server.id}/*)` },
        ...(mcp.tools[server.key] ?? []).map((tool) => ({ value: `${server.id}/${tool.name}`, label: `${server.id}/${tool.name}` })),
      ],
    })),
  ])

  // Contas e Repositórios: os do projeto em uso (só quem o administra lê; sem acesso, fica o curinga).
  const accounts = useAccountsStore()
  const repositories = useRepositoriesStore()
  watch(
    () => projects.current,
    (projectId) => {
      if (!projectId) return
      void accounts.lists.ensure(projectId).catch(() => undefined)
      void repositories.lists.ensure(projectId).catch(() => undefined)
    },
    { immediate: true },
  )
  const accountGroups = computed<IChoiceGroup[]>(() => [
    { label: 'Curingas', wildcard: true, options: [{ value: '*', label: 'Todas as contas do projeto (*)' }] },
    {
      label: 'Contas do projeto',
      // O aviso de fim de turno nunca vai ao terminal: regra de conta não vale para ele.
      options: (projects.current ? (accounts.lists.get(projects.current) ?? []) : [])
        .filter((account) => account.kind !== 'turn-callback')
        .map((account) => ({ value: account.id, label: account.label && account.label !== account.id ? `${account.label} (${account.id})` : account.id })),
    },
  ])
  const repositoryGroups = computed<IChoiceGroup[]>(() => [
    { label: 'Curingas', wildcard: true, options: [{ value: '*', label: 'Todos os repositórios do projeto (*)' }] },
    {
      label: 'Repositórios do projeto',
      options: (projects.current ? (repositories.lists.get(projects.current) ?? []) : []).map((repository) => ({ value: repository.name, label: repository.name })),
    },
  ])

  const groups: Partial<Record<TPermissionCategory, () => IChoiceGroup[]>> = {
    delegate: () => delegateGroups.value,
    trigger: () => triggerGroups.value,
    skill: () => skillGroups.value,
    mcp: () => mcpGroups.value,
    account: () => accountGroups.value,
    repository: () => repositoryGroups.value,
  }
  /** A lista da categoria (`undefined` = padrão digitado). */
  const groupsOf = (category: TPermissionCategory): IChoiceGroup[] | undefined => groups[category]?.()

  /** O rótulo do campo e o texto de "escolha". */
  const choiceLabel: Partial<Record<TPermissionCategory, [string, string]>> = {
    delegate: ['Agente', 'Escolha o agente…'],
    trigger: ['Agente', 'Escolha o agente…'],
    skill: ['Skill', 'Escolha a skill…'],
    mcp: ['Ferramenta MCP', 'Escolha a ferramenta…'],
    account: ['Conta', 'Escolha a conta…'],
    repository: ['Repositório', 'Escolha o repositório…'],
  }

  return { groupsOf, choiceLabel }
}
