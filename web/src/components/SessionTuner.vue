<script setup lang="ts">
import { computed, ref } from 'vue'
import type { IAgent } from '@/lib/types'
import { useThreadStore } from '@/stores/thread'

/**
 * Modelo e raciocínio da sessão VIVA, trocáveis entre uma mensagem e outra. Só os modelos do agente
 * (mesmo provider: outro provider é conversa nova) e só os níveis que o modelo escolhido aceita.
 */
const props = defineProps<{ agent: IAgent; fallbackModel?: string }>()
const thread = useThreadStore()

const saving = ref(false)
const failure = ref<string>()

const model = computed(() => thread.session?.model ?? props.fallbackModel ?? props.agent.models[0] ?? '')
const levelsOf = (id: string) => props.agent.modelReasoning?.[id] ?? props.agent.reasoningEfforts ?? []
const levels = computed(() => levelsOf(model.value))
/**
 * Os modelos do select. ⚠️ O da sessão pode ter saído do agente (desativado no meio da conversa): sem ele
 * na lista o select mostraria OUTRO modelo, e a tela mentiria sobre o que a sessão está usando.
 */
const options = computed(() => {
  const active = props.agent.models
  return model.value && !active.includes(model.value) ? [model.value, ...active] : active
})
const busy = computed(() => thread.sending || saving.value)

/** Falhou? O select já mostra a escolha nova (o DOM guarda o que o usuário clicou): volta ao valor real da sessão. */
async function apply(change: { model?: string; reasoning?: string | null }, select: HTMLSelectElement) {
  saving.value = true
  failure.value = undefined
  try {
    await thread.reconfigure(change)
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
    select.value = change.model !== undefined ? model.value : (thread.session?.reasoning ?? '')
  } finally {
    saving.value = false
  }
}

function pickModel(event: Event) {
  const select = event.target as HTMLSelectElement
  const next = select.value
  // O nível que o modelo novo não aceita volta ao padrão, na mesma troca.
  const current = thread.session?.reasoning
  void apply(current && !levelsOf(next).includes(current) ? { model: next, reasoning: null } : { model: next }, select)
}

function pickReasoning(event: Event) {
  const select = event.target as HTMLSelectElement
  void apply({ reasoning: select.value || null }, select)
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 border-t border-zinc-800/80 bg-zinc-900/40 px-4 py-1.5 text-xs text-zinc-400">
    <label class="flex items-center gap-1.5">
      Modelo
      <select :value="model" :disabled="busy || options.length < 2" class="rounded-md bg-zinc-800 px-1.5 py-0.5 font-mono text-zinc-100 disabled:opacity-60" @change="pickModel">
        <option v-for="id in options" :key="id" :value="id" :disabled="!agent.models.includes(id)">{{ id }}{{ agent.models.includes(id) ? (agent.pricing[id] ? ` — $${agent.pricing[id].output}/1M saída` : '') : ' (desativado)' }}</option>
      </select>
    </label>
    <label v-if="levels.length" class="flex items-center gap-1.5">
      Raciocínio
      <select :value="thread.session?.reasoning ?? ''" :disabled="busy" class="rounded-md bg-zinc-800 px-1.5 py-0.5 font-mono text-zinc-100 disabled:opacity-60" @change="pickReasoning">
        <option value="">padrão</option>
        <option v-for="level in levels" :key="level" :value="level">{{ level }}</option>
      </select>
    </label>
    <span v-if="saving" class="text-zinc-500">trocando…</span>
    <span v-else-if="failure" class="text-rose-300">{{ failure }}</span>
    <span v-else class="hidden text-zinc-600 sm:inline">vale a partir da próxima mensagem</span>
  </div>
</template>
