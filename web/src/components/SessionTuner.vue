<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { levelsOf, resolveChoice, type IChoice } from '@/lib/agentChoice'
import { effortLabel } from '@/lib/format'
import type { IAgent, IAgentProvider, TMode } from '@/lib/types'
import { useProtocolsStore } from '@/stores/protocols'
import { useThreadStore } from '@/stores/thread'
import ModelPicker from './ModelPicker.vue'

/**
 * Provider, modelo e raciocínio da sessão VIVA, trocáveis entre uma mensagem e outra. Só o que o agente
 * oferece, e só os níveis que o modelo escolhido aceita. Outro provider recebe a transcrição dos turnos
 * (o estado interno do anterior — ids de tool, raciocínio cifrado, cache — não atravessa).
 */
const props = defineProps<{ agent: IAgent; mode?: TMode; fallback?: Partial<IChoice> }>()
const thread = useThreadStore()
const protocols = useProtocolsStore()

const saving = ref(false)
const failure = ref<string>()
const switched = ref<string>()

const current = computed<IChoice | undefined>(() => {
  const session = thread.session
  if (session?.model) return { provider: session.provider ?? props.fallback?.provider ?? props.agent.providers[0]?.id ?? '', model: session.model }
  return resolveChoice(props.agent, props.fallback)
})
const levels = computed(() => levelsOf(props.agent, current.value))
const busy = computed(() => thread.sending || saving.value)
// O aviso da troca de provider vale até a mensagem seguinte sair (é ela que leva a transcrição).
watch(
  () => thread.sending,
  (sending) => {
    if (sending) switched.value = undefined
  },
)

/** Provider que não roda a lane desta conversa (assinatura só tem a agent) não é escolha aqui. */
function blocked(provider: IAgentProvider): string | undefined {
  if (!props.mode || !provider.protocol) return undefined
  const lanes = protocols.get(provider.protocol)?.lanes
  return lanes && !lanes.includes(props.mode) ? `não funciona neste modo` : undefined
}

/** Falhou? O select já mostra a escolha nova (o DOM guarda o que o usuário clicou): volta ao valor real da sessão. */
async function apply(change: { provider?: string; model?: string; reasoning?: string | null }, select: HTMLSelectElement, restore: string) {
  saving.value = true
  failure.value = undefined
  try {
    await thread.reconfigure(change)
    switched.value = change.provider ? protocols.providerName(change.provider) : undefined
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
    select.value = restore
  } finally {
    saving.value = false
  }
}

function pickModel(next: IChoice, select: HTMLSelectElement) {
  const before = current.value
  const restore = before ? `${before.provider}|${before.model}` : ''
  const change: { provider?: string; model: string; reasoning?: null } = { model: next.model }
  if (next.provider !== before?.provider) change.provider = next.provider
  // O nível que o modelo novo não aceita volta ao padrão, na mesma troca.
  const reasoning = thread.session?.reasoning
  if (reasoning && !levelsOf(props.agent, next).includes(reasoning)) change.reasoning = null
  void apply(change, select, restore)
}

function pickReasoning(event: Event) {
  const select = event.target as HTMLSelectElement
  void apply({ reasoning: select.value || null }, select, thread.session?.reasoning ?? '')
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 border-t border-zinc-800/80 bg-zinc-900/40 px-4 py-1.5 text-xs text-zinc-400">
    <label class="flex items-center gap-1.5">
      Modelo
      <ModelPicker
        :agent="agent"
        :value="current"
        :disabled="busy"
        :blocked="blocked"
        select-class="rounded-md bg-zinc-800 px-1.5 py-0.5 font-mono text-zinc-100 disabled:opacity-60"
        @pick="pickModel"
      />
    </label>
    <label v-if="levels.length" class="flex items-center gap-1.5">
      Raciocínio
      <select :value="thread.session?.reasoning ?? ''" :disabled="busy" class="rounded-md bg-zinc-800 px-1.5 py-0.5 text-zinc-100 disabled:opacity-60" @change="pickReasoning">
        <option value="">Padrão</option>
        <option v-for="level in levels" :key="level" :value="level">{{ effortLabel(level) }}</option>
      </select>
    </label>
    <span v-if="saving" class="text-zinc-500">trocando…</span>
    <span v-else-if="failure" class="text-rose-300">{{ failure }}</span>
    <span v-else-if="switched" class="text-amber-300/90">agora em {{ switched }}; vale a partir da próxima mensagem</span>
    <span v-else class="hidden text-zinc-600 sm:inline">vale a partir da próxima mensagem</span>
  </div>
</template>
