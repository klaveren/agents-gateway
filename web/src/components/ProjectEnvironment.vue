<script setup lang="ts">
import { computed, ref } from 'vue'
import InitialContextEditor from './InitialContextEditor.vue'
import SaveFooter from './SaveFooter.vue'
import RulesEditor from './RulesEditor.vue'

/**
 * O AMBIENTE do projeto: tudo o que TODA conversa dele recebe antes de qualquer coisa do agente — as rules (as globais,
 * só para ler, e as do projeto) e as specs carregadas inteiras (o contexto inicial) —, com o peso por conversa.
 * ⚖️ Juntos porque são a mesma pergunta: "o que entra sempre, e quanto custa". Em guias, como no agente: as duas ficam
 * montadas (`v-show`), para o peso de cada uma chegar ao total sem abrir a guia.
 */
defineProps<{ projectId: string }>()

type TTab = 'regras' | 'contexto'
const tab = ref<TTab>('regras')

/** O contexto inicial é o que se grava aqui (as regras só se leem): pelo rodapé, como em toda tela. */
const editor = ref<{ dirty: boolean; commit: () => Promise<void> }>()
const busy = ref(false)
const note = ref<string>()
const failure = ref<string>()
async function saveContext() {
  busy.value = true
  note.value = failure.value = undefined
  try {
    await editor.value?.commit()
    note.value = 'Contexto inicial salvo. Vale para as próximas conversas.'
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
  } finally {
    busy.value = false
  }
}
const tabs: { id: TTab; label: string }[] = [
  { id: 'regras', label: 'Regras' },
  { id: 'contexto', label: 'Contexto inicial' },
]

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

    <nav class="flex gap-1 border-b border-zinc-800" role="tablist">
      <button
        v-for="item in tabs"
        :key="item.id"
        type="button"
        role="tab"
        :aria-selected="tab === item.id"
        class="shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap"
        :class="tab === item.id ? 'border-emerald-500 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'"
        @click="tab = item.id"
      >
        {{ item.label }}
        <span v-if="item.id === 'contexto' && editor?.dirty" class="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-400" title="Mudança não salva" />
      </button>
    </nav>

    <div v-show="tab === 'regras'" class="flex flex-col gap-2" role="tabpanel">
      <div class="flex items-baseline gap-2">
        <p class="text-xs text-zinc-500">Valem em toda conversa do projeto.</p>
        <RouterLink to="/rules" class="ml-auto shrink-0 text-xs text-emerald-400 underline underline-offset-2">Editar em Rules</RouterLink>
      </div>
      <RulesEditor :scope="projectId" show-globals readonly @weight="(tokens) => (rulesWeight = tokens)" />
    </div>

    <div v-show="tab === 'contexto'" class="flex flex-col gap-2" role="tabpanel">
      <InitialContextEditor ref="editor" owner="projects" :owner-id="projectId" :project-id="projectId" embedded @weight="(tokens) => (specsWeight = tokens)">
        <p class="text-sm text-zinc-400">
          As specs marcadas ficam sempre na memória de todo agente do projeto. As demais o agente consulta quando precisa.
        </p>
      </InitialContextEditor>
    </div>

    <p class="rounded-xl bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400">Cada agente soma o que tem de próprio; veja o total na guia Tamanho do agente.</p>
    <p v-if="note" class="text-sm text-emerald-300">{{ note }}</p>
    <p v-if="failure" class="text-sm text-rose-300">{{ failure }}</p>
    <SaveFooter v-show="tab === 'contexto'" label="Salvar contexto inicial" :busy="busy" :disabled="!editor?.dirty" :pending="!!editor?.dirty" @save="saveContext" />
  </section>
</template>
