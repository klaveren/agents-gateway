<script setup lang="ts">
import { computed, ref } from 'vue'
import { useResource } from '@/composables/useResource'
import { useAgentCatalogStore } from '@/stores/agentCatalog'
import InitialContextEditor from './InitialContextEditor.vue'

/**
 * O CONTEXTO INICIAL de um agente: as specs que ELE carrega inteiras além das do projeto (o agente desenvolvedor e as
 * de arquitetura). ⛔ Agente global: só specs globais — ele roda em qualquer projeto. O do projeto vem da store (o
 * mesmo do Ambiente).
 */
const props = defineProps<{ agentId: string; projectId?: string; projectName?: string }>()
const catalog = useAgentCatalogStore()

/** Dentro do formulário do agente: o "Salvar agente" grava esta guia (repassa o `dirty` e o `commit` do editor). */
const editor = ref<{ dirty: boolean; commit: () => Promise<void> }>()
defineExpose({ dirty: computed(() => !!editor.value?.dirty), commit: () => editor.value?.commit() ?? Promise.resolve() })

const { data: project } = useResource(catalog.initialContexts, () => (props.projectId ? catalog.contextKey('projects', props.projectId) : undefined))
</script>

<template>
  <InitialContextEditor ref="editor" owner="agents" :owner-id="agentId" :project-id="projectId" :base-tokens="project?.totalTokens" embedded>
    <p class="text-sm text-zinc-400">
      As Specs marcadas são enviadas <strong class="text-zinc-200">inteiras</strong> a este agente, além das Rules
      <template v-if="projectId">
        e das {{ project?.docs.length ?? 0 }} Spec(s) do contexto inicial do projeto
        <RouterLink :to="`/projects/${projectId}`" class="text-emerald-400 underline underline-offset-2">{{ projectName ?? projectId }}</RouterLink>.
      </template>
      <template v-else>. Agente global: só Specs globais.</template>
      Só este agente as recebe. A ordem é a da lista.
    </p>
  </InitialContextEditor>
</template>
