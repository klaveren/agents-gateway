<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import BuildTabs from '@/components/BuildTabs.vue'
import RulesEditor from '@/components/RulesEditor.vue'
import { pendingDraft } from '@/lib/builder'
import { GLOBAL_SCOPE, scopeLabel } from '@/lib/guidance'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'

/**
 * As RULES (só admin): as regras do ambiente que todo agente respeita, uma por registro ("Rule 1", "Rule 2"…).
 * ⚖️ Globais valem em todos os projetos; as de um projeto, só nele — e, num projeto, as globais aparecem antes, só para
 * ler, porque é a ordem em que a conversa as recebe.
 */
const auth = useAuthStore()
const projects = useProjectsStore()

// O rascunho do construtor ("Abrir no editor") abre no escopo dele.
const scope = ref<string>(pendingDraft.value?.kind === 'rule' ? (pendingDraft.value.projectId ?? GLOBAL_SCOPE) : (projects.current ?? GLOBAL_SCOPE))
const scopes = computed(() => [{ id: GLOBAL_SCOPE, name: 'Global — todos os projetos' }, ...projects.list.map((project) => ({ id: project.id, name: project.name }))])
const label = computed(() => scopeLabel(scope.value, projects.list))

onMounted(async () => {
  if (auth.isAdmin && !projects.loaded) await projects.load().catch(() => undefined)
})
// Trocou o projeto no seletor do topo: a página acompanha.
watch(
  () => projects.current,
  (current) => {
    if (current) scope.value = current
  },
)
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra cadastra as rules.</p>
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
        As regras do ambiente que todo agente respeita. Entram no system prompt de cada conversa nova: as globais e depois as do projeto dela. Editar vale para as
        próximas conversas. Mostrando: <strong class="text-zinc-300">{{ label }}</strong>.
      </p>
      <RulesEditor :key="scope" :scope="scope" :show-globals="scope !== GLOBAL_SCOPE" />
    </section>
  </div>
</template>

<style scoped>
@reference '../style.css';

.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
</style>
