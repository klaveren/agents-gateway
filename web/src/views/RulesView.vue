<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import BuildTabs from '@/components/BuildTabs.vue'
import HistoryPanel from '@/components/HistoryPanel.vue'
import HistoryTabs from '@/components/HistoryTabs.vue'
import RulesEditor from '@/components/RulesEditor.vue'
import { pendingDraft } from '@/lib/builder'
import { api } from '@/lib/api'
import { scopeHistory } from '@/lib/catalogHistory'
import { GLOBAL_SCOPE, scopeLabel } from '@/lib/guidance'
import type { IRule } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'

/**
 * As RULES (só admin): as regras do ambiente que todo agente respeita, uma por registro ("Rule 1", "Rule 2"…).
 * ⚖️ Globais valem em todos os projetos; as de um projeto, só nele — e, num projeto, as globais aparecem antes, só para
 * ler, porque é a ordem em que a conversa as recebe.
 */
const route = useRoute()
const auth = useAuthStore()
const projects = useProjectsStore()

// O rascunho do construtor ("Abrir no editor") abre no escopo dele; o link do histórico (`?escopo=&rule=#historico`), no da rule.
const linked = typeof route.query.escopo === 'string' ? route.query.escopo : undefined
const scope = ref<string>(linked ?? (pendingDraft.value?.kind === 'rule' ? (pendingDraft.value.projectId ?? GLOBAL_SCOPE) : (projects.current ?? GLOBAL_SCOPE)))
const scopes = computed(() => [{ id: GLOBAL_SCOPE, name: 'Global — todos os projetos' }, ...projects.list.map((project) => ({ id: project.id, name: project.name }))])
const label = computed(() => scopeLabel(scope.value, projects.list))

/**
 * O HISTÓRICO das rules do escopo, uma por vez: as de hoje e as apagadas que aparecem nas revisões recentes do escopo
 * (para poder trazer uma de volta).
 */
const tab = ref<'edit' | 'history'>(route.hash === '#historico' ? 'history' : 'edit')
const historyRule = ref<string>(typeof route.query.rule === 'string' ? route.query.rule : '')
const ruleOptions = ref<Array<{ id: string; label: string }>>([])

async function loadRuleOptions() {
  const [current, recent] = await Promise.all([
    api<IRule[]>('/rules', { query: { project: scope.value } }).catch(() => []),
    scopeHistory(scope.value, 1, 100).catch(() => undefined),
  ])
  const options = current.map((rule) => ({ id: rule.id, label: rule.title }))
  const known = new Set(options.map((option) => option.id))
  for (const revision of recent?.revisions ?? []) {
    if (revision.kind !== 'rule' || known.has(revision.itemId)) continue
    known.add(revision.itemId)
    options.push({ id: revision.itemId, label: `${revision.itemId} (${revision.op === 'delete' ? 'apagada' : 'fora da lista'})` })
  }
  ruleOptions.value = options
  if (!options.some((option) => option.id === historyRule.value)) historyRule.value = options[0]?.id ?? ''
}
watch(
  () => [tab.value, scope.value] as const,
  ([current]) => {
    if (current === 'history') void loadRuleOptions()
  },
  { immediate: true },
)

onMounted(async () => {
  if (auth.isAdmin && !projects.loaded) await projects.load().catch(() => undefined)
})
// Trocou o projeto no seletor do topo: a página acompanha.
watch(
  () => projects.current,
  (current) => {
    if (current) scope.value = current
    historyRule.value = ''
  },
)
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra pode gerenciar as regras.</p>
  </div>

  <div v-else class="scroll-thin h-full overflow-y-auto px-4 py-5">
    <section class="mx-auto flex max-w-3xl flex-col gap-4">
      <header class="flex flex-wrap items-center gap-3">
        <h1 class="text-xl font-semibold">Rules</h1>
        <BuildTabs kind="rule" active="list" />
        <select v-model="scope" class="input ml-auto w-auto py-1.5 text-sm" aria-label="Escopo">
          <option v-for="item in scopes" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
      </header>
      <p class="text-xs text-zinc-500">
        Regras que todo agente respeita. Editar vale para as próximas conversas. Mostrando: <strong class="text-zinc-300">{{ label }}</strong>.
      </p>
      <HistoryTabs v-model="tab" edit-label="Regras" />
      <RulesEditor v-if="tab === 'edit'" :key="scope" :scope="scope" :show-globals="scope !== GLOBAL_SCOPE" />
      <template v-else>
        <p v-if="!ruleOptions.length" class="text-sm text-zinc-500">Nenhuma rule em {{ label }} ainda.</p>
        <template v-else>
          <label class="flex items-center gap-2 text-sm text-zinc-300">
            Rule
            <select v-model="historyRule" class="input w-auto py-1.5 text-sm" aria-label="Rule">
              <option v-for="option in ruleOptions" :key="option.id" :value="option.id">{{ option.label }}</option>
            </select>
          </label>
          <HistoryPanel v-if="historyRule" kind="rule" :id="historyRule" @restored="loadRuleOptions" />
        </template>
      </template>
    </section>
  </div>
</template>

<style scoped>
@reference '../style.css';

.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
</style>
