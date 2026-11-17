<script setup lang="ts">
import { onMounted } from 'vue'
import ProjectSettings from '@/components/ProjectSettings.vue'
import { useProjectsStore } from '@/stores/projects'

/**
 * Projeto → Configurações: a configuração do projeto EM USO (só quem o administra). Outro projeto se abre em
 * Sistema → Projetos; aqui não há seletor.
 */
const projects = useProjectsStore()

onMounted(async () => {
  if (!projects.loaded) await projects.load().catch(() => undefined)
})
</script>

<template>
  <div v-if="!projects.manages" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra este projeto vê as configurações dele.</p>
  </div>

  <div v-else class="h-full overflow-y-auto px-4 py-5">
    <ProjectSettings v-if="projects.current" :key="projects.current" :project-id="projects.current" />
  </div>
</template>
