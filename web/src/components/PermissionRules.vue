<script setup lang="ts">
  import { computed, onMounted, watch } from 'vue'
  import { useScopedResources } from '@/composables/useCatalogLists'
  import { BUILD_KINDS, builderAgentId, type TBuildKind } from '@/lib/builder'
  import { fixPattern, PERMISSION_SECTIONS, patternWarning } from '@/lib/permissions'
  import type { IPermissionRule, TPermissionCategory } from '@/lib/types'
  import { useAccountsStore } from '@/stores/accounts'
  import { useAgentsStore } from '@/stores/agents'
  import { useMcpStore } from '@/stores/mcp'
  import { useProjectsStore } from '@/stores/projects'

  /**
   * O editor de regras de permissão, por categoria. ⚖️ A ordem não importa: dentro da mesma lista, Negar vence Permitir.
   * Mora dentro de formulários: nada aqui submete com Enter.
   */
  const rules = defineModel<IPermissionRule[]>({ required: true })
  /** `only`: uma categoria só (a guia escolhida na tela de Permissões). */
  const props = defineProps<{ readonly?: boolean; only?: TPermissionCategory }>()

  const byCategory = computed(() =>
    PERMISSION_SECTIONS.filter((section) => !props.only || section.category === props.only).map((section) => ({ ...section, rules: rules.value.map((rule, index) => ({ rule, index })).filter(({ rule }) => rule.category === section.category) })),
  )

  /**
   * ⚖️ Na DELEGAÇÃO o padrão é um agente: escolhido numa lista (os agentes, os construtores do sistema e os curingas de
   * sempre), não digitado. O padrão gravado que não está na lista aparece como está, para não sumir.
   */
  const agents = useAgentsStore()
  onMounted(() => void agents.ensure().catch(() => undefined))
  const delegateGroups = computed(() => [
    {
      label: 'Curingas',
      options: [
        { value: '*', label: 'Todos os agentes (*)' },
        { value: 'builder-*', label: 'Todos os construtores do sistema (builder-*)' },
      ],
    },
    { label: 'Agentes', options: agents.list.map((agent) => ({ value: agent.id, label: `${agent.name} (${agent.id})` })) },
    {
      label: 'Do sistema',
      options: (Object.keys(BUILD_KINDS) as TBuildKind[]).map((kind) => ({ value: builderAgentId(kind), label: `${BUILD_KINDS[kind].builder} (${builderAgentId(kind)})` })),
    },
  ])

  /** ⚖️ Skills e MCP também se escolhem numa lista: as skills (globais e do projeto em uso) e os servidores com as ferramentas. */
  const projects = useProjectsStore()
  const resources = useScopedResources(() => projects.current ?? null)
  const skillGroups = computed(() => [
    { label: 'Curingas', options: [{ value: '*', label: 'Todas as skills (*)' }] },
    {
      label: 'Skills',
      options: resources.list.value.filter((item) => item.kind === 'skill').map((item) => ({ value: item.id, label: item.description ? `${item.id} — ${item.description}` : item.id })),
    },
  ])
  const mcp = useMcpStore()
  onMounted(() => void mcp.ensure().catch(() => undefined))
  const servers = computed(() => mcp.list.filter((server) => server.enabled))
  // As ferramentas de cada servidor ligado, para a lista (o servidor fora do ar fica só com o "todas").
  watch(
    () => servers.value.map((server) => server.key),
    (keys) => keys.forEach((key) => void mcp.loadTools(key).catch(() => undefined)),
    { immediate: true },
  )
  const mcpGroups = computed(() => [
    { label: 'Curingas', options: [{ value: '*', label: 'Todas as ferramentas de todos os MCPs (*)' }] },
    ...servers.value.map((server) => ({
      label: server.name,
      options: [
        { value: `${server.id}/*`, label: `Todas as ferramentas de ${server.name} (${server.id}/*)` },
        ...(mcp.tools[server.key] ?? []).map((tool) => ({ value: `${server.id}/${tool.name}`, label: `${server.id}/${tool.name}` })),
      ],
    })),
  ])
  /**
   * ⚖️ As CONTAS também se escolhem numa lista: as do projeto em uso (Projeto → Contas). O aviso de fim de turno não entra
   * (nunca vai ao terminal). Sem acesso às contas (quem não administra), a lista fica só com o curinga.
   */
  const accounts = useAccountsStore()
  watch(
    () => projects.current,
    (projectId) => void (projectId && accounts.lists.ensure(projectId).catch(() => undefined)),
    { immediate: true },
  )
  const accountGroups = computed(() => [
    { label: 'Curingas', options: [{ value: '*', label: 'Todas as contas do projeto (*)' }] },
    {
      label: 'Contas do projeto',
      options: (projects.current ? (accounts.lists.get(projects.current) ?? []) : [])
        .filter((account) => account.kind !== 'turn-callback')
        .map((account) => ({ value: account.id, label: account.label && account.label !== account.id ? `${account.label} (${account.id})` : account.id })),
    },
  ])
  /** A lista de cada categoria que se escolhe (as outras são padrões digitados). */
  const groupsOf = (category: TPermissionCategory) =>
    category === 'delegate'
      ? delegateGroups.value
      : category === 'skill'
        ? skillGroups.value
        : category === 'mcp'
          ? mcpGroups.value
          : category === 'account'
            ? accountGroups.value
            : undefined
  const choiceLabel: Partial<Record<TPermissionCategory, [string, string]>> = {
    delegate: ['Agente', 'Escolha o agente…'],
    skill: ['Skill', 'Escolha a skill…'],
    mcp: ['Ferramenta MCP', 'Escolha a ferramenta…'],
    account: ['Conta', 'Escolha a conta…'],
  }
  const known = (category: TPermissionCategory, pattern: string) => !pattern || !!groupsOf(category)?.some((group) => group.options.some((option) => option.value === pattern))

  function add(category: TPermissionCategory) {
    rules.value = [...rules.value, { category, pattern: '', decision: 'allow' }]
  }
  function remove(index: number) {
    rules.value = rules.value.filter((_, at) => at !== index)
  }
  function update(index: number, change: Partial<IPermissionRule>) {
    rules.value = rules.value.map((rule, at) => (at === index ? { ...rule, ...change } : rule))
  }
</script>

<template>
  <div class="flex flex-col gap-3">
    <section v-for="section in byCategory" :key="section.category" class="rounded-xl border border-zinc-800">
      <header class="flex items-baseline gap-2 border-b border-zinc-800 px-3 py-2">
        <h3 class="text-sm font-medium text-zinc-200">{{ section.label }}</h3>
        <span class="text-xs text-zinc-500">{{ section.rules.length || 'nenhuma regra' }}</span>
        <button v-if="!readonly" type="button" class="btn btn-sm btn-ghost ml-auto" @click="add(section.category)">+ Regra</button>
      </header>
      <p class="px-3 pt-2 text-xs text-zinc-500">{{ section.hint }}</p>
      <ul class="flex flex-col gap-1.5 p-3">
        <li v-for="{ rule, index } in section.rules" :key="index" class="flex flex-wrap items-center gap-2">
          <select
            v-if="groupsOf(section.category)"
            :value="rule.pattern"
            :disabled="readonly"
            :aria-label="choiceLabel[section.category]?.[0]"
            class="input min-w-0 flex-1 text-[13px]"
            @change="update(index, { pattern: ($event.target as HTMLSelectElement).value })"
          >
            <option value="" disabled>{{ choiceLabel[section.category]?.[1] }}</option>
            <option v-if="!known(section.category, rule.pattern)" :value="rule.pattern">{{ rule.pattern }}</option>
            <optgroup v-for="group in groupsOf(section.category)" :key="group.label" :label="group.label">
              <option v-for="option in group.options" :key="option.value" :value="option.value">{{ option.label }}</option>
            </optgroup>
          </select>
          <input
            v-else
            :value="rule.pattern"
            :readonly="readonly"
            :placeholder="section.example"
            class="input min-w-0 flex-1 font-mono text-[13px]"
            @input="update(index, { pattern: ($event.target as HTMLInputElement).value })"
            @keydown.enter.prevent
          />
          <div class="flex gap-1">
            <button type="button" class="chip" :class="{ on: rule.decision === 'allow' }" :disabled="readonly" @click="update(index, { decision: 'allow' })">Permitir</button>
            <button type="button" class="chip" :class="{ 'on-deny': rule.decision === 'deny' }" :disabled="readonly" @click="update(index, { decision: 'deny' })">Negar</button>
          </div>
          <input
            :value="rule.note ?? ''"
            :readonly="readonly"
            placeholder="nota (opcional)"
            class="input w-40 text-xs"
            @input="update(index, { note: ($event.target as HTMLInputElement).value || undefined })"
            @keydown.enter.prevent
          />
          <button v-if="!readonly" type="button" class="btn btn-sm btn-danger" title="Remover a regra" @click="remove(index)">Remover</button>
          <p v-if="patternWarning(rule)" class="flex w-full flex-wrap items-center gap-2 text-xs text-amber-300">
            ⚠ {{ patternWarning(rule) }}
            <button v-if="!readonly" type="button" class="btn btn-sm btn-ghost" @click="update(index, { pattern: fixPattern(rule.pattern) })">
              Trocar por {{ fixPattern(rule.pattern) }}
            </button>
          </p>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
  @reference '../style.css';

  .input {
    @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
  }
  .chip.on-deny {
    @apply border-rose-500/60 bg-rose-500/15 text-rose-200;
  }
</style>
