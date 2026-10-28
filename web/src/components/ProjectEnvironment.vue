<script setup lang="ts">
import { computed, ref } from 'vue'
import InitialContextEditor from './InitialContextEditor.vue'
import RulesEditor from './RulesEditor.vue'

/**
 * O AMBIENTE do projeto: tudo o que TODA conversa dele recebe antes de qualquer coisa do agente — as rules (as globais,
 * só para ler, e as do projeto) e as specs carregadas inteiras (o contexto inicial) —, com o peso por conversa.
 * ⚖️ Juntos porque são a mesma pergunta: "o que entra sempre, e quanto custa".
 */
defineProps<{ projectId: string }>()

const rulesWeight = ref(0)
const specsWeight = ref(0)
const total = computed(() => rulesWeight.value + specsWeight.value)
const format = (value: number) => value.toLocaleString('pt-BR')
</script>

<template>
  <section class="flex flex-col gap-5">
    <div class="grid grid-cols-3 gap-2">
      <div class="rounded-xl bg-zinc-900 px-3 py-2">
        <p class="text-xs text-zinc-500">Rules</p>
        <p class="text-lg font-semibold tabular-nums">≈ {{ format(rulesWeight) }} tok</p>
      </div>
      <div class="rounded-xl bg-zinc-900 px-3 py-2">
        <p class="text-xs text-zinc-500">Specs inteiras</p>
        <p class="text-lg font-semibold tabular-nums">≈ {{ format(specsWeight) }} tok</p>
      </div>
      <div class="rounded-xl bg-zinc-900 px-3 py-2">
        <p class="text-xs text-zinc-500">Toda conversa leva</p>
        <p class="text-lg font-semibold tabular-nums">≈ {{ format(total) }} tok</p>
      </div>
    </div>

    <div class="flex flex-col gap-2">
      <h3 class="text-sm font-semibold text-zinc-200">Rules <span class="text-xs font-normal text-zinc-500">— no prompt de toda conversa, nesta ordem: as globais e depois as do projeto</span></h3>
      <RulesEditor :scope="projectId" show-globals @weight="(tokens) => (rulesWeight = tokens)" />
    </div>

    <div class="flex flex-col gap-2">
      <h3 class="text-sm font-semibold text-zinc-200">Specs carregadas inteiras</h3>
      <InitialContextEditor :endpoint="`/projects/${encodeURIComponent(projectId)}/initial-context`" :project-id="projectId" @weight="(tokens) => (specsWeight = tokens)">
        <p class="text-sm text-zinc-400">
          As specs marcadas vão <strong class="text-zinc-200">inteiras</strong> no prompt de todo agente deste projeto, depois das rules. As demais ficam no índice, e o agente lê quando
          precisa. Cada agente ainda pode carregar as suas, na guia Contexto inicial dele. A ordem das marcadas é a ordem no prompt.
        </p>
      </InitialContextEditor>
    </div>

    <p class="rounded-xl bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400">Cada agente soma a isso a soul, o prompt, as specs dele e os índices — a guia Tamanho do agente mostra o total.</p>
  </section>
</template>
