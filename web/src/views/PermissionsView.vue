<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import PermissionRules from '@/components/PermissionRules.vue'
import PermissionTester from '@/components/PermissionTester.vue'
import { api, ApiError } from '@/lib/api'
import { fullTime } from '@/lib/format'
import { LAYER_LABEL, PERMISSION_SECTIONS } from '@/lib/permissions'
import type { IPermissionDecision, IPermissionRule } from '@/lib/types'
import { useAgentsStore } from '@/stores/agents'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'

/**
 * As PERMISSÕES do projeto em uso (só admin): o que os agentes podem fazer — comandos, arquivos, rede, MCP, skills e
 * delegação. Sem regra, negado. Cada agente libera o que precisa na guia Permissões dele, por cima destas.
 */
const auth = useAuthStore()
const projects = useProjectsStore()
const agents = useAgentsStore()
const project = computed(() => projects.list.find((item) => item.id === projects.current))

const rules = ref<IPermissionRule[]>([])
const saved = ref<string>('[]')
const system = ref<IPermissionRule[]>([])
const meta = ref<{ updatedAt?: string; updatedBy?: string }>({})
const decisions = ref<IPermissionDecision[]>([])
const decisionAgent = ref('')
const error = ref<string>()
const notice = ref<string>()
const busy = ref(false)
const showSystem = ref(false)

const dirty = computed(() => JSON.stringify(rules.value) !== saved.value)
const label = (category: string) => PERMISSION_SECTIONS.find((section) => section.category === category)?.label ?? category

async function load() {
  if (!project.value) return
  error.value = undefined
  try {
    const result = await api<{ rules: IPermissionRule[]; system: IPermissionRule[]; updatedAt?: string; updatedBy?: string }>(`/projects/${encodeURIComponent(project.value.id)}/permissions`)
    rules.value = result.rules
    saved.value = JSON.stringify(result.rules)
    system.value = result.system
    meta.value = { updatedAt: result.updatedAt, updatedBy: result.updatedBy }
    await loadDecisions()
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  }
}

async function loadDecisions() {
  if (!project.value) return
  decisions.value = await api<IPermissionDecision[]>(`/projects/${encodeURIComponent(project.value.id)}/permissions/decisions`, {
    query: decisionAgent.value ? { agentId: decisionAgent.value } : {},
  }).catch(() => [])
}

async function save() {
  if (!project.value) return
  busy.value = true
  error.value = undefined
  notice.value = undefined
  try {
    const clean = rules.value.filter((rule) => rule.pattern.trim())
    const result = await api<{ rules: IPermissionRule[] }>(`/projects/${encodeURIComponent(project.value.id)}/permissions`, { method: 'PUT', body: { rules: clean } })
    rules.value = result.rules
    saved.value = JSON.stringify(result.rules)
    notice.value = 'Salvo. Vale na hora, para todos os agentes do projeto.'
  } catch (failure) {
    error.value = failure instanceof ApiError && failure.status === 422 ? 'Alguma regra está inválida: confira os padrões.' : failure instanceof Error ? failure.message : String(failure)
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  if (!auth.isAdmin) return
  await Promise.all([projects.loaded ? undefined : projects.load().catch(() => undefined), agents.loaded ? undefined : agents.load().catch(() => undefined)])
  await load()
})
watch(
  () => projects.current,
  () => auth.isAdmin && load(),
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
        <h1 class="text-xl font-semibold">Permissões{{ project ? ` — ${project.name}` : '' }}</h1>
        <p class="text-xs text-zinc-500">O que os agentes do projeto podem fazer. Cada agente libera o que precisa na guia Permissões dele.</p>
      </header>

      <p v-if="!project" class="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500">Escolha um projeto no seletor do topo.</p>
      <template v-else>
        <div class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          <strong class="font-medium">Sem regra, negado.</strong> Dentro de cada lista, Negar vence Permitir. A regra do agente vale antes da do projeto, e as do sistema
          (segredos e comandos que derrubam o servidor) valem sempre.
        </div>
        <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>

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
    </section>
  </div>
</template>

<style scoped>
@reference '../style.css';

.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
</style>
