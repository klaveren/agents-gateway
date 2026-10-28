<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AgentAvatar from '@/components/AgentAvatar.vue'
import AgentForm from '@/components/AgentForm.vue'
import BuildTabs from '@/components/BuildTabs.vue'
import Icon from '@/components/Icon.vue'
import MasterDetail from '@/components/MasterDetail.vue'
import { pendingDraft } from '@/lib/builder'
import type { IAgent, IAgentDetail, TMode, TSandboxLevel } from '@/lib/types'
import { useAgentsStore } from '@/stores/agents'
import { useAuthStore } from '@/stores/auth'
import { useProvidersStore } from '@/stores/providers'
import { useProtocolsStore } from '@/stores/protocols'

const props = defineProps<{ id?: string }>()

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const agents = useAgentsStore()
const providers = useProvidersStore()
const protocols = useProtocolsStore()

/** "Claude · claude-opus-5 +2": o padrão com o modelo dele, e quantos providers mais o agente tem. */
function providersLine(agent: IAgent): string {
  const [first, ...rest] = agent.providers
  if (!first) return 'sem provedor'
  return `${protocols.providerName(first.id)} · ${first.models[0] ?? 'sem modelo'}${rest.length ? ` +${rest.length}` : ''}`
}

const detail = ref<IAgentDetail>()
const template = ref<IAgentDetail>()
const error = ref<string>()
/** O formulário veio do construtor ("Abrir no editor"): avisa, até a próxima troca de agente. */
const draftNote = ref<string>()

/** O registro do rascunho (como o `save_agent` recebe) no formato que o formulário lê. */
function fromDraft(agent: Record<string, unknown>, base?: IAgentDetail): IAgentDetail {
  const text = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback)
  const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : [])
  const providers = Array.isArray(agent.providers) ? (agent.providers as Array<Record<string, unknown>>) : []
  return {
    ...(base ?? {}),
    id: text(agent.id, base?.id),
    name: text(agent.name, base?.name),
    soul: text(agent.soul, base?.soul),
    systemPrompt: text(agent.systemPrompt, base?.systemPrompt),
    providers: providers.map((target) => ({
      id: text(target.provider),
      name: text(target.provider),
      models: list(target.models),
      pricing: {},
      ...(typeof target.sandbox === 'string' ? { sandbox: target.sandbox as TSandboxLevel } : {}),
      ...(target.network === true ? { network: true } : {}),
    })),
    reasoningEfforts: list(agent.reasoningEfforts),
    modes: list(agent.modes) as TMode[],
    allowedTools: list(agent.allowedTools),
    ...(agent.role === 'subagent' ? { role: 'subagent' as const } : { role: undefined }),
    adminOnly: agent.adminOnly === true,
    ...(typeof agent.projectId === 'string' && agent.projectId ? { projectId: agent.projectId } : { projectId: undefined }),
  }
}

/**
 * O rascunho do construtor ("Abrir no editor"): o agente novo nasce com ele; o que já existe abre com ele por cima —
 * SEM salvar, e consumido. O contexto inicial e os recursos do rascunho ficam para as guias do agente, depois de salvar.
 */
function takeDraft(id?: string): IAgentDetail | undefined {
  const pending = pendingDraft.value
  if (pending?.kind !== 'agent' || !pending.agent || (id && pending.id !== id)) return undefined
  pendingDraft.value = undefined
  const extras = [pending.initialContext.length ? `contexto inicial (${pending.initialContext.join(', ')})` : '', pending.resources ? 'recursos' : ''].filter(Boolean)
  draftNote.value = `Rascunho aplicado. Revise e salve.${extras.length ? ` ${extras.join(' e ')} ficam para depois de salvar.` : ''}`
  return fromDraft(pending.agent, id ? detail.value : undefined)
}

const creating = computed(() => route.name === 'agent-new')
const created = computed(() => agents.list.filter((agent) => agent.role !== 'subagent'))
const subagents = computed(() => agents.list.filter((agent) => agent.role === 'subagent'))

onMounted(() => {
  void agents.loadTools().catch(() => undefined)
  // Os providers configurados, para o formulário escolher entre eles.
  void providers.load().catch(() => undefined)
  // A lista traz `unavailable` (só para admin) e muda por fora: relê ao abrir a tela.
  void agents.load().catch(() => undefined)
})

/** ⚠️ Cada leitura vale uma geração: a resposta de uma seleção anterior chega depois e não pode sobrescrever a atual. */
let generation = 0
async function loadDetail(id: string, keepCurrent = false) {
  const token = ++generation
  try {
    const fresh = await agents.detail(id)
    if (token !== generation) return
    detail.value = fresh
    const drafted = takeDraft(id)
    if (drafted) detail.value = drafted
  } catch (failure) {
    if (token !== generation) return
    if (!keepCurrent) detail.value = undefined
    error.value = failure instanceof Error ? failure.message : String(failure)
  }
}

watch(
  () => [props.id, creating.value] as const,
  async ([id, isNew]) => {
    error.value = undefined
    detail.value = undefined
    draftNote.value = undefined
    generation++
    if (isNew) {
      const drafted = takeDraft()
      if (drafted) template.value = drafted
    }
    if (!id) return
    await loadDetail(id)
  },
  { immediate: true },
)

/** A cópia nasce sem id e com "(cópia)" no nome: o id é escolhido de novo, e não colide com o original. */
function duplicate(source: IAgentDetail) {
  template.value = { ...source, id: '', name: `${source.name.replace(/\s*\(.*?\)\s*/g, ' ').trim()} (cópia)` }
  void router.push('/agents/new')
}

watch(creating, (value) => {
  if (!value) template.value = undefined
})
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <div>
      <p class="font-medium text-zinc-200">Só quem administra cria e edita agentes.</p>
      <RouterLink v-if="!auth.signedIn && auth.localAccounts" :to="{ path: '/login', query: { next: '/agents' } }" class="mt-3 inline-block rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950">Entrar</RouterLink>
    </div>
  </div>

  <MasterDetail v-else :open="!!id || creating" back-to="/agents" back-label="Agentes" :title="creating ? (template ? 'Duplicar agente' : 'Novo agente') : detail?.name">
    <template #list>
      <header class="flex items-center gap-2 px-4 pt-4 pb-3">
        <h1 class="text-xl font-semibold">Agentes</h1>
        <RouterLink to="/agents/new" class="ml-auto grid h-9 w-9 place-items-center rounded-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400" title="Novo agente" @click="template = undefined"><Icon name="plus" class="h-5 w-5" /></RouterLink>
      </header>
      <BuildTabs kind="agent" active="list" class="px-3 pb-2" />
      <template v-for="group in [{ label: 'Agentes', items: created }, { label: 'Subagentes', items: subagents }]" :key="group.label">
        <h2 v-if="group.items.length" class="px-4 pt-3 pb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{{ group.label }}</h2>
        <RouterLink
          v-for="agent in group.items"
          :key="agent.id"
          :to="`/agents/${agent.id}`"
          class="mx-2 flex items-center gap-3 rounded-xl px-3 py-2"
          :class="agent.id === id ? 'bg-emerald-500/15' : 'hover:bg-zinc-800/60'"
        >
          <AgentAvatar :name="agent.name" :provider="agent.providers[0]?.id ?? ''" size="sm" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{{ agent.name }}</span>
            <span class="block truncate text-xs text-zinc-500">{{ providersLine(agent) }}</span>
          </span>
          <span v-if="agent.unavailable" class="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-300" :title="`Indisponível agora: ${agent.unavailable.label}`">{{ agent.unavailable.label }}</span>
          <span v-if="agent.adminOnly" class="shrink-0 rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-300" title="Só administradores conversam com este agente">só administradores</span>
          <span v-if="!agent.projectId" class="shrink-0 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] text-sky-300" title="Aparece em todos os projetos">global</span>
        </RouterLink>
      </template>
      <p v-if="!created.length && !subagents.length" class="px-4 py-2 text-sm text-zinc-500">Nenhum agente criado ainda.</p>
    </template>

    <template #detail>
      <template v-if="creating">
        <h2 class="mx-auto mb-4 max-w-3xl text-lg font-semibold">{{ template ? (draftNote ? 'Novo agente (do construtor)' : 'Duplicar agente') : 'Novo agente' }}</h2>
        <p v-if="draftNote" class="mx-auto mb-4 max-w-3xl text-sm text-emerald-300">{{ draftNote }}</p>
        <AgentForm :agent="template" creating @saved="(saved) => router.push(`/agents/${saved}`)" />
      </template>
      <template v-else-if="detail">
        <div class="mx-auto mb-4 flex max-w-3xl items-center gap-3">
          <AgentAvatar :name="detail.name" :provider="detail.providers[0]?.id ?? ''" size="lg" />
          <div class="min-w-0">
            <h2 class="truncate text-lg font-semibold">{{ detail.name }}</h2>
            <p class="truncate font-mono text-xs text-zinc-500">{{ detail.id }}</p>
          </div>
          <span v-if="agents.byId.get(detail.id)?.unavailable" class="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-300">{{ agents.byId.get(detail.id)?.unavailable?.label }}</span>
          <RouterLink v-if="detail.role !== 'subagent'" :to="{ path: '/new', query: { agent: detail.id } }" class="ml-auto shrink-0 rounded-full bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700">Conversar</RouterLink>
        </div>
        <p v-if="draftNote" class="mx-auto mb-4 max-w-3xl text-sm text-emerald-300">{{ draftNote }}</p>
        <AgentForm :agent="detail" :creating="false" @saved="(saved) => loadDetail(saved, true)" @duplicate="duplicate" @removed="router.push('/agents')" />
      </template>
      <p v-else-if="error" class="text-sm text-rose-300">{{ error }}</p>
      <div v-else class="grid h-full place-items-center text-zinc-500">Escolha um agente ou crie um novo.</div>
    </template>
  </MasterDetail>
</template>
