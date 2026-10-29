<script setup lang="ts">
import { computed, onMounted } from 'vue'
import ProjectEnvironment from '@/components/ProjectEnvironment.vue'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'

/**
 * O AMBIENTE do projeto em uso (só admin): tudo o que toda conversa dele recebe antes de qualquer coisa do agente — as
 * rules (só para ler; edita-se em Rules) e as specs carregadas inteiras —, com o peso por conversa. Trocar de projeto
 * no seletor do topo troca o ambiente.
 */
const auth = useAuthStore()
const projects = useProjectsStore()
const project = computed(() => projects.list.find((item) => item.id === projects.current))

onMounted(async () => {
  if (auth.isAdmin && !projects.loaded) await projects.load().catch(() => undefined)
})
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra vê o ambiente do projeto.</p>
  </div>

  <div v-else class="scroll-thin h-full overflow-y-auto px-4 py-5">
    <section class="mx-auto flex max-w-3xl flex-col gap-4">
      <header>
        <h1 class="text-xl font-semibold">Ambiente{{ project ? ` — ${project.name}` : '' }}</h1>
        <p class="text-xs text-zinc-500">O que todo agente do projeto sabe desde o início.</p>
      </header>
      <ProjectEnvironment v-if="project" :key="project.id" :project-id="project.id" />
      <p v-else class="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500">Escolha um projeto no seletor do topo para ver o ambiente dele.</p>
    </section>
  </div>
</template>
