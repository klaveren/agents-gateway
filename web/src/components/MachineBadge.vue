<script setup lang="ts">
  import { computed } from 'vue'
  import { useProjectsStore } from '@/stores/projects'

  /** 🖥️ O selo "de máquina": o agente roda fora do cerco do projeto NESTE projeto (a lista só vem com o sistema permitindo). */
  const props = defineProps<{ projectId?: string; agentId?: string }>()
  const projects = useProjectsStore()
  const on = computed(() => !!props.agentId && !!projects.list.find((project) => project.id === props.projectId)?.machineAgents?.includes(props.agentId))
</script>

<template>
  <span
    v-if="on"
    class="shrink-0 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-200"
    title="Agente de máquina: roda fora do cerco do projeto, com o que o usuário do gateway pode nesta máquina"
    data-test="machine-badge"
  >
    de máquina
  </span>
</template>
