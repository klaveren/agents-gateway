<script setup lang="ts">
import { onMounted } from 'vue'
import BuildTabs from '@/components/BuildTabs.vue'
import RulesEditor from '@/components/RulesEditor.vue'
import { GLOBAL_SCOPE } from '@/lib/guidance'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'

/**
 * As RULES GLOBAIS (só admin, em Sistema): as regras que todo agente respeita em todos os projetos. ⚖️ As de um projeto
 * moram na guia Ambiente dele, junto com o contexto inicial — é lá que se vê tudo o que uma conversa do projeto recebe.
 */
const auth = useAuthStore()
const projects = useProjectsStore()

onMounted(async () => {
  if (auth.isAdmin && !projects.loaded) await projects.load().catch(() => undefined)
})
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra cadastra as rules.</p>
  </div>

  <div v-else class="scroll-thin h-full overflow-y-auto px-4 py-5">
    <section class="mx-auto flex max-w-3xl flex-col gap-4">
      <header class="flex flex-wrap items-center gap-3">
        <h1 class="text-xl font-semibold">Rules globais</h1>
        <BuildTabs kind="rule" active="list" />
      </header>
      <p class="text-xs text-zinc-500">
        As regras que todo agente respeita, em todos os projetos. Entram no system prompt de cada conversa nova, antes das do projeto. As de um projeto ficam na guia
        <strong class="text-zinc-300">Ambiente</strong> dele<template v-if="projects.current">
          — <RouterLink :to="`/projects/${projects.current}?tab=ambiente`" class="text-emerald-400 underline underline-offset-2">abrir a do projeto atual</RouterLink></template
        >. Editar vale para as próximas conversas.
      </p>
      <RulesEditor :scope="GLOBAL_SCOPE" />
    </section>
  </div>
</template>
