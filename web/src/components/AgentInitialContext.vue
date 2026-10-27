<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '@/lib/api'
import type { IInitialContext } from '@/lib/types'
import InitialContextEditor from './InitialContextEditor.vue'

/**
 * O CONTEXTO INICIAL de um agente: as specs que ELE carrega inteiras além das do projeto (o agente desenvolvedor e as
 * de arquitetura). ⛔ Agente global: só specs globais — ele roda em qualquer projeto.
 */
const props = defineProps<{ agentId: string; projectId?: string; projectName?: string }>()

const project = ref<IInitialContext>()
onMounted(async () => {
  if (props.projectId) project.value = await api<IInitialContext>(`/projects/${encodeURIComponent(props.projectId)}/initial-context`).catch(() => undefined)
})
</script>

<template>
  <InitialContextEditor :endpoint="`/agents/${encodeURIComponent(agentId)}/initial-context`" :project-id="projectId" :base-tokens="project?.totalTokens">
    <p class="text-sm text-zinc-400">
      As specs marcadas aqui vão <strong class="text-zinc-200">inteiras</strong> no prompt deste agente, além das rules
      <template v-if="projectId">
        e das {{ project?.docs.length ?? 0 }} spec(s) do contexto inicial do projeto
        <RouterLink :to="`/projects/${projectId}`" class="text-emerald-400 underline underline-offset-2">{{ projectName ?? projectId }}</RouterLink>.
      </template>
      <template v-else>. Agente global: só specs globais, porque ele roda em qualquer projeto.</template>
      Os outros agentes não as recebem. A ordem das marcadas é a ordem no prompt.
    </p>
  </InitialContextEditor>
</template>
