<script setup lang="ts">
import InitialContextEditor from './InitialContextEditor.vue'

/**
 * O CONTEXTO INICIAL de um projeto: as specs que vão INTEIRAS no prompt de toda conversa dele, junto com as rules.
 * ⚖️ É do projeto, não do agente (cada agente ainda pode carregar as suas, na guia dele). As demais specs continuam no
 * índice (o agente lê com `read_doc` quando precisa). Vale marcar as globais e as do projeto.
 */
defineProps<{ projectId: string }>()
</script>

<template>
  <InitialContextEditor :endpoint="`/projects/${encodeURIComponent(projectId)}/initial-context`" :project-id="projectId">
    <p class="text-sm text-zinc-400">
      As specs marcadas aqui vão <strong class="text-zinc-200">inteiras</strong> no prompt de todo agente deste projeto, junto com as <RouterLink to="/rules" class="text-emerald-400 underline underline-offset-2">rules</RouterLink>, quando a conversa
      começa. Cada agente ainda pode carregar as suas, na guia Contexto inicial dele. As demais continuam no índice, e o agente lê quando precisa. A ordem das marcadas é a ordem no prompt.
    </p>
  </InitialContextEditor>
</template>
