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
        <p class="text-xs text-zinc-500">Regras</p>
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
      <div class="flex items-baseline gap-2">
        <h3 class="text-sm font-semibold text-zinc-200">Regras <span class="text-xs font-normal text-zinc-500">— valem em toda conversa do projeto</span></h3>
        <RouterLink to="/rules" class="ml-auto shrink-0 text-xs text-emerald-400 underline underline-offset-2">Editar em Rules</RouterLink>
      </div>
      <RulesEditor :scope="projectId" show-globals readonly @weight="(tokens) => (rulesWeight = tokens)" />
    </div>

    <div class="flex flex-col gap-2">
      <h3 class="text-sm font-semibold text-zinc-200">Specs sempre presentes</h3>
      <InitialContextEditor :endpoint="`/projects/${encodeURIComponent(projectId)}/initial-context`" :project-id="projectId" @weight="(tokens) => (specsWeight = tokens)">
        <p class="text-sm text-zinc-400">
          As specs marcadas ficam sempre na memória de todo agente do projeto. As demais o agente consulta quando precisa.
        </p>
      </InitialContextEditor>
    </div>

    <p class="rounded-xl bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400">Cada agente soma o que tem de próprio; veja o total na guia Tamanho do agente.</p>
  </section>
</template>
