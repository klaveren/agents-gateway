<script setup lang="ts">
import ConnectedReadOnly from '@/components/ConnectedReadOnly.vue'
import { useConnectionsStore } from '@/stores/connections'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import HistoryPanel from '@/components/HistoryPanel.vue'
import ListPager from '@/components/ListPager.vue'
import PermissionCategoryTabs from '@/components/PermissionCategoryTabs.vue'
import SaveFooter from '@/components/SaveFooter.vue'
import PermissionRules from '@/components/PermissionRules.vue'
import PermissionRequests from '@/components/PermissionRequests.vue'
import PermissionRequestsBadge from '@/components/PermissionRequestsBadge.vue'
import { pendingCount, requestsKey } from '@/lib/permissionRequests'
import { usePermissionRequestsStore } from '@/stores/permissionRequests'
import PermissionTester from '@/components/PermissionTester.vue'
import { ApiError } from '@/lib/api'
import { fullTime } from '@/lib/format'
import { LAYER_LABEL, PERMISSION_SECTIONS } from '@/lib/permissions'
import type { IPermissionDecision, IPermissionRule, TPermissionCategory } from '@/lib/types'
import { usePaged } from '@/composables/usePaged'
import { useResource } from '@/composables/useResource'
import { useAgentsStore } from '@/stores/agents'
import { usePermissionsStore } from '@/stores/permissions'
import { useProjectsStore } from '@/stores/projects'

/**
 * As PERMISSÕES do projeto em uso (só admin): o que os agentes podem fazer — comandos, arquivos, rede, MCP, skills e
 * delegação. Sem regra, negado. Cada agente libera o que precisa na guia Permissões dele, por cima destas. As regras
 * moram na store (as Contas somam a elas); as decisões são lidas na hora.
 */
const route = useRoute()
const projects = useProjectsStore()
const connections = useConnectionsStore()
const agents = useAgentsStore()
const project = computed(() => projects.list.find((item) => item.id === projects.current))
/** 🔌 As permissões do projeto conectado vêm da origem: só leitura (os pedidos dos agentes também se decidem lá). */
const connectedOrigin = computed(() => connections.originOf(project.value?.id))

const permissions = usePermissionsStore()
const permissionRequests = usePermissionRequestsStore()
/** Os pedidos abertos para as regras do projeto (o selo do título; a lista é o `PermissionRequests`). */
const pendingRequests = computed(() => (project.value ? pendingCount(permissionRequests.lists.get(requestsKey({ projectId: project.value.id })), { projectId: project.value.id }) : 0))

/** Um pedido aprovado: as regras do projeto são as que o servidor gravou (o rascunho segue a store). */
function requestApproved(_request: unknown, approved: IPermissionRule[] | undefined) {
  if (project.value && approved) permissions.projects.update(project.value.id, (current) => ({ ...current, rules: approved }))
}
/** Lê quando a tela abre (só admin, depois de acertar o projeto do link). */
const ready = ref(false)
const stored = useResource(permissions.projects, () => (ready.value && project.value ? project.value.id : undefined))
/** O rascunho das regras (o que a pessoa edita); o salvo é o da store. */
const rules = ref<IPermissionRule[]>([])
const saved = computed(() => JSON.stringify(stored.data.value?.rules ?? []))
const system = computed(() => stored.data.value?.system ?? [])
const meta = computed(() => ({ updatedAt: stored.data.value?.updatedAt, updatedBy: stored.data.value?.updatedBy }))
const decisions = ref<IPermissionDecision[]>([])
const decisionPage = usePaged(decisions)
const decisionAgent = ref('')
const actionError = ref<string>()
const error = computed(() => actionError.value ?? (stored.error.value === undefined ? undefined : stored.error.value instanceof Error ? stored.error.value.message : String(stored.error.value)))
const notice = ref<string>()
const busy = ref(false)
/** A guia: as regras (por categoria), as do sistema ou o histórico (`#historico` no endereço abre nele). */
const tab = ref<'edit' | 'system' | 'history'>(route.hash === '#historico' ? 'history' : 'edit')
/** A categoria aberta: uma guia por categoria, como no agente. */
const section = ref<TPermissionCategory>('terminal')

const dirty = computed(() => JSON.stringify(rules.value) !== saved.value)
const label = (category: string) => PERMISSION_SECTIONS.find((section) => section.category === category)?.label ?? category

// O salvo chegou (ou mudou: outro projeto, a gravação, o histórico): o rascunho volta a ele.
watch(
  () => stored.data.value,
  (value) => (rules.value = value ? (JSON.parse(JSON.stringify(value.rules)) as IPermissionRule[]) : []),
  { immediate: true },
)

/** As decisões da guia aberta: cada categoria mostra as últimas DELA (a guia de rede não se perde atrás do terminal). */
let decisionsAsked = 0
async function loadDecisions() {
  if (!project.value) return
  const turn = ++decisionsAsked
  const listed = await permissions.decisions(project.value.id, { category: section.value, ...(decisionAgent.value ? { agentId: decisionAgent.value } : {}) }).catch(() => [])
  // Só a última pedida vale: a guia (ou o agente) pode ter mudado enquanto a resposta vinha.
  if (turn === decisionsAsked) decisions.value = listed
}

async function save() {
  if (!project.value) return
  busy.value = true
  actionError.value = undefined
  notice.value = undefined
  try {
    await permissions.save(project.value.id, rules.value.filter((rule) => rule.pattern.trim()))
    notice.value = 'Salvo. Vale na hora, para todos os agentes do projeto.'
  } catch (failure) {
    actionError.value = failure instanceof ApiError && failure.status === 422 ? 'Alguma regra está inválida: confira os padrões.' : failure instanceof Error ? failure.message : String(failure)
  } finally {
    busy.value = false
  }
}

/** Restaurou uma versão: relê as regras do projeto (o rascunho segue a store). */
function restored() {
  if (project.value) void permissions.projects.refresh(project.value.id).catch(() => undefined)
}

onMounted(async () => {
  if (!projects.loaded) await projects.load().catch(() => undefined)
  if (!projects.manages) return
  if (!agents.loaded) await agents.load().catch(() => undefined)
  // O link do histórico (`?projeto=`) abre no projeto do item: troca o projeto em uso, como o seletor do topo.
  const linked = route.query.projeto
  if (typeof linked === 'string' && linked !== projects.current && projects.list.some((item) => item.id === linked)) await projects.select(linked).catch(() => undefined)
  ready.value = true
})
// Outro projeto: as decisões dele (as regras vêm da store, pela chave).
watch(
  () => [ready.value, projects.current] as const,
  () => {
    actionError.value = undefined
    if (ready.value) void loadDecisions()
  },
)
// Outra guia ou outro agente: a lista é outra (e a de antes sai da tela enquanto a nova não chega).
watch([decisionAgent, section], () => {
  decisions.value = []
  void loadDecisions()
})
</script>

<template>
  <div v-if="!projects.manages" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra este projeto vê as permissões.</p>
  </div>

  <div v-else class="h-full overflow-y-auto px-4 py-5">
    <section class="mx-auto flex max-w-3xl flex-col gap-4">
      <header>
        <h1 class="flex items-center gap-2 text-xl font-semibold">
          Permissões{{ project ? ` — ${project.name}` : '' }} <PermissionRequestsBadge :count="pendingRequests" />
        </h1>
        <p class="text-xs text-zinc-500">O que os agentes do projeto podem fazer. Cada agente libera o que precisa na guia Permissões dele.</p>
      </header>

      <p v-if="!project" class="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500">Escolha um projeto no seletor do topo.</p>
      <template v-else>
        <div class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          <strong class="font-medium">Sem regra, negado.</strong> Dentro de cada lista, Negar vence Permitir. A regra do agente vale antes da do projeto, e as do sistema
          (segredos e comandos que derrubam o servidor) valem sempre.
        </div>
        <PermissionCategoryTabs v-model="section" :rules="rules" :active="tab === 'edit'" @pick="tab = 'edit'">
          <!-- As regras do sistema valem para todas as categorias: têm a guia delas. -->
          <button
            type="button"
            role="tab"
            :aria-selected="tab === 'system'"
            data-test="tab-system"
            class="flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap"
            :class="tab === 'system' ? 'border-emerald-500 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'"
            @click="tab = 'system'"
          >
            Sistema
            <span v-if="system.length" class="rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-400">{{ system.length }}</span>
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="tab === 'history'"
            data-test="tab-history"
            class="shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap"
            :class="tab === 'history' ? 'border-emerald-500 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'"
            @click="tab = 'history'"
          >
            Histórico
          </button>
        </PermissionCategoryTabs>
        <HistoryPanel v-if="tab === 'history'" kind="project-permissions" :id="project.id" @restored="restored" />
        <section v-else-if="tab === 'system'" class="flex flex-col gap-2" data-test="system-rules">
          <p class="text-xs text-zinc-500">Regras do sistema: valem sempre, sem exceção, antes das do agente e das do projeto. Não se editam.</p>
          <ul class="divide-y divide-zinc-800 rounded-xl border border-zinc-800 text-xs">
            <li v-for="(rule, index) in system" :key="index" class="flex items-baseline gap-3 px-3 py-1.5">
              <span class="w-28 shrink-0 text-zinc-500">{{ label(rule.category) }}</span>
              <code class="min-w-0 flex-1 truncate text-zinc-200" :title="rule.pattern">{{ rule.pattern }}</code>
              <span class="shrink-0 text-zinc-500">{{ rule.note }}</span>
            </li>
          </ul>
        </section>
        <template v-else>
          <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
          <ConnectedReadOnly v-if="connectedOrigin" :origin="connectedOrigin" />

          <PermissionRequests v-if="!connectedOrigin" :project-id="project.id" @approved="requestApproved" />
          <fieldset :disabled="!!connectedOrigin" class="contents">
            <PermissionRules v-model="rules" :only="section" />
          </fieldset>
          <p v-if="notice" class="text-xs text-emerald-300">{{ notice }}</p>
          <p v-else-if="meta.updatedBy" class="text-xs text-zinc-500">Alterado por {{ meta.updatedBy }} em {{ fullTime(meta.updatedAt) }}</p>

          <PermissionTester :project-id="project.id" :initial="section" />

          <section class="flex flex-col gap-2">
            <div class="flex items-center gap-2">
              <h2 class="text-sm font-medium text-zinc-200">Últimas decisões · {{ label(section) }}</h2>
              <select v-model="decisionAgent" class="input ml-auto w-48 text-sm" aria-label="Agente">
                <option value="">Todos os agentes</option>
                <option v-for="agent in agents.list" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
              </select>
              <button type="button" class="btn btn-sm btn-ghost" @click="loadDecisions">Atualizar</button>
            </div>
            <ul v-if="decisions.length" class="divide-y divide-zinc-800 rounded-xl border border-zinc-800 text-xs">
              <li v-for="(entry, index) in decisionPage.items.value" :key="index" class="flex items-baseline gap-3 px-3 py-1.5" data-test="decision">
                <span class="w-32 shrink-0 text-zinc-500">{{ fullTime(entry.at) }}</span>
                <span class="w-12 shrink-0" :class="entry.allowed ? 'text-emerald-300' : 'text-rose-300'">{{ entry.allowed ? 'permitiu' : 'negou' }}</span>
                <span class="w-24 shrink-0 truncate text-zinc-400">{{ agents.byId.get(entry.agentId ?? '')?.name ?? entry.agentId ?? '—' }}</span>
                <code class="min-w-0 flex-1 truncate text-zinc-200" :title="entry.subject">{{ entry.subject }}</code>
                <span class="shrink-0 text-zinc-500">{{ entry.pattern ? `"${entry.pattern}"` : '' }} · {{ LAYER_LABEL[entry.layer] }}</span>
              </li>
            </ul>
            <p v-else class="text-xs text-zinc-500" data-test="no-decisions">Nenhuma decisão de {{ label(section) }} registrada ainda.</p>
            <ListPager v-model="decisionPage.page.value" :pages="decisionPage.pages.value" :total="decisionPage.total.value" :size="decisionPage.size" />
          </section>
          <SaveFooter v-if="!connectedOrigin" label="Salvar permissões" :busy="busy" :disabled="!dirty" :pending="dirty" @save="save" />
        </template>
      </template>
    </section>
  </div>
</template>

<style scoped>
@reference '../style.css';

.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
</style>
