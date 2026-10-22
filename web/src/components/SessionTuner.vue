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
const busy = computed(() => thread.sending || saving.value)

async function apply(change: { model?: string; reasoning?: string | null }) {
  saving.value = true
  failure.value = undefined
  try {
    await thread.reconfigure(change)
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
}

function pickModel(next: string) {
  // O nível que o modelo novo não aceita volta ao padrão, na mesma troca.
  const current = thread.session?.reasoning
  void apply(current && !levelsOf(next).includes(current) ? { model: next, reasoning: null } : { model: next })
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 border-t border-zinc-800/80 bg-zinc-900/40 px-4 py-1.5 text-xs text-zinc-400">
    <label class="flex items-center gap-1.5">
      Modelo
      <select :value="model" :disabled="busy || agent.models.length < 2" class="rounded-md bg-zinc-800 px-1.5 py-0.5 font-mono text-zinc-100 disabled:opacity-60" @change="pickModel(($event.target as HTMLSelectElement).value)">
        <option v-for="id in agent.models" :key="id" :value="id">{{ id }}{{ agent.pricing[id] ? ` — $${agent.pricing[id].output}/1M saída` : '' }}</option>
      </select>
    </label>
    <label v-if="levels.length" class="flex items-center gap-1.5">
      Raciocínio
      <select :value="thread.session?.reasoning ?? ''" :disabled="busy" class="rounded-md bg-zinc-800 px-1.5 py-0.5 font-mono text-zinc-100 disabled:opacity-60" @change="apply({ reasoning: ($event.target as HTMLSelectElement).value || null })">
        <option value="">padrão</option>
        <option v-for="level in levels" :key="level" :value="level">{{ level }}</option>
      </select>
    </label>
    <span v-if="saving" class="text-zinc-500">trocando…</span>
    <span v-else-if="failure" class="text-rose-300">{{ failure }}</span>
    <span v-else class="hidden text-zinc-600 sm:inline">vale a partir da próxima mensagem</span>
  </div>
</template>
