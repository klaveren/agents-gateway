<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import HistoryPanel from '@/components/HistoryPanel.vue'
import HistoryTabs from '@/components/HistoryTabs.vue'
import PermissionRules from '@/components/PermissionRules.vue'
import PermissionRequests from '@/components/PermissionRequests.vue'
import PermissionRequestsBadge from '@/components/PermissionRequestsBadge.vue'
import { pendingCount, requestsKey } from '@/lib/permissionRequests'
import { usePermissionRequestsStore } from '@/stores/permissionRequests'
import PermissionTester from '@/components/PermissionTester.vue'
import { ApiError } from '@/lib/api'
import { fullTime } from '@/lib/format'
import { LAYER_LABEL, PERMISSION_SECTIONS } from '@/lib/permissions'
import type { IPermissionDecision, IPermissionRule } from '@/lib/types'
import { useResource } from '@/composables/useResource'
import { useAgentsStore } from '@/stores/agents'
import { useAuthStore } from '@/stores/auth'
import { usePermissionsStore } from '@/stores/permissions'
import { useProjectsStore } from '@/stores/projects'

/**
 * As PERMISSÕES do projeto em uso (só admin): o que os agentes podem fazer — comandos, arquivos, rede, MCP, skills e
 * delegação. Sem regra, negado. Cada agente libera o que precisa na guia Permissões dele, por cima destas. As regras
 * moram na store (as Contas somam a elas); as decisões são lidas na hora.
 */
const route = useRoute()
const auth = useAuthStore()
const projects = useProjectsStore()
const agents = useAgentsStore()
const project = computed(() => projects.list.find((item) => item.id === projects.current))

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
const decisionAgent = ref('')
const actionError = ref<string>()
const error = computed(() => actionError.value ?? (stored.error.value === undefined ? undefined : stored.error.value instanceof Error ? stored.error.value.message : String(stored.error.value)))
const notice = ref<string>()
const busy = ref(false)
const showSystem = ref(false)
/** A guia: as regras ou o histórico delas (`#historico` no endereço abre nele). */
const tab = ref<'edit' | 'history'>(route.hash === '#historico' ? 'history' : 'edit')

const dirty = computed(() => JSON.stringify(rules.value) !== saved.value)
const label = (category: string) => PERMISSION_SECTIONS.find((section) => section.category === category)?.label ?? category

// O salvo chegou (ou mudou: outro projeto, a gravação, o histórico): o rascunho volta a ele.
watch(
  () => stored.data.value,
  (value) => (rules.value = value ? (JSON.parse(JSON.stringify(value.rules)) as IPermissionRule[]) : []),
  { immediate: true },
)

async function loadDecisions() {
  if (!project.value) return
  decisions.value = await permissions.decisions(project.value.id, decisionAgent.value || undefined).catch(() => [])
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
  if (!auth.isAdmin) return
  await Promise.all([projects.loaded ? undefined : projects.load().catch(() => undefined), agents.loaded ? undefined : agents.load().catch(() => undefined)])
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
watch(decisionAgent, () => void loadDecisions())
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra vê as permissões.</p>
  </div>

  <div v-else class="scroll-thin h-full overflow-y-auto px-4 py-5">
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
        <HistoryTabs v-model="tab" edit-label="Regras" />
        <HistoryPanel v-if="tab === 'history'" kind="project-permissions" :id="project.id" @restored="restored" />
        <template v-else>
          <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>

          <PermissionRequests :project-id="project.id" @approved="requestApproved" />
          <PermissionRules v-model="rules" />
          <div class="flex flex-wrap items-center gap-3">
            <button type="button" class="btn btn-primary" :disabled="busy || !dirty" @click="save">Salvar</button>
            <span v-if="notice" class="text-xs text-emerald-300">{{ notice }}</span>
            <span v-else-if="meta.updatedBy" class="text-xs text-zinc-500">Alterado por {{ meta.updatedBy }} em {{ fullTime(meta.updatedAt) }}</span>
          </div>

          <section class="rounded-xl border border-zinc-800">
            <button type="button" class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-300" @click="showSystem = !showSystem">
              Regras do sistema <span class="text-xs text-zinc-500">{{ system.length }} · valem sempre, sem exceção</span>
              <span class="ml-auto text-xs text-zinc-500">{{ showSystem ? '▴' : '▾' }}</span>
            </button>
            <ul v-if="showSystem" class="flex flex-col gap-0.5 border-t border-zinc-800 px-3 py-2 text-xs">
              <li v-for="(rule, index) in system" :key="index" class="flex gap-2">
                <span class="w-28 shrink-0 text-zinc-500">{{ label(rule.category) }}</span>
                <code class="min-w-0 flex-1 truncate text-zinc-300">{{ rule.pattern }}</code>
                <span class="shrink-0 text-zinc-500">{{ rule.note }}</span>
              </li>
            </ul>
          </section>

          <PermissionTester :project-id="project.id" />

          <section class="flex flex-col gap-2">
            <div class="flex items-center gap-2">
              <h2 class="text-sm font-medium text-zinc-200">Últimas decisões</h2>
              <select v-model="decisionAgent" class="input ml-auto w-48 text-sm" aria-label="Agente">
                <option value="">Todos os agentes</option>
                <option v-for="agent in agents.list" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
              </select>
              <button type="button" class="btn btn-sm btn-ghost" @click="loadDecisions">Atualizar</button>
            </div>
            <ul v-if="decisions.length" class="divide-y divide-zinc-800 rounded-xl border border-zinc-800 text-xs">
              <li v-for="(entry, index) in decisions" :key="index" class="flex items-baseline gap-3 px-3 py-1.5">
                <span class="w-32 shrink-0 text-zinc-500">{{ fullTime(entry.at) }}</span>
                <span class="w-12 shrink-0" :class="entry.allowed ? 'text-emerald-300' : 'text-rose-300'">{{ entry.allowed ? 'permitiu' : 'negou' }}</span>
                <span class="w-24 shrink-0 truncate text-zinc-400">{{ agents.byId.get(entry.agentId ?? '')?.name ?? entry.agentId ?? '—' }}</span>
                <code class="min-w-0 flex-1 truncate text-zinc-200" :title="entry.subject">{{ label(entry.category) }}: {{ entry.subject }}</code>
                <span class="shrink-0 text-zinc-500">{{ entry.pattern ? `"${entry.pattern}"` : '' }} · {{ LAYER_LABEL[entry.layer] }}</span>
              </li>
            </ul>
            <p v-else class="text-xs text-zinc-500">Nenhuma decisão registrada ainda.</p>
          </section>
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
