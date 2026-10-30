<script setup lang="ts">
import { computed, ref } from 'vue'
import type { IFallbackStep } from '@/lib/types'
import { useProtocolsStore } from '@/stores/protocols'

/**
 * A CADEIA da troca de provedor: na ordem, para onde o turno vai quando a cota de um acaba. Serve à cadeia global
 * (Configuração) e à do agente. `options` = os pares que podem entrar (os do agente, ou os prontos no gateway).
 */
const props = defineProps<{ options: IFallbackStep[] }>()
const chain = defineModel<IFallbackStep[]>({ required: true })
const protocols = useProtocolsStore()
const adding = ref('')

const key = (step: IFallbackStep) => `${step.provider}::${step.model}`
const free = computed(() => props.options.filter((option) => !chain.value.some((step) => key(step) === key(option))))

function add() {
  const option = props.options.find((item) => key(item) === adding.value)
  if (option) chain.value = [...chain.value, { ...option }]
  adding.value = ''
}

function move(index: number, by: -1 | 1) {
  const next = [...chain.value]
  const [step] = next.splice(index, 1)
  next.splice(index + by, 0, step)
  chain.value = next
}

function remove(index: number) {
  chain.value = chain.value.filter((_, at) => at !== index)
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <ol v-if="chain.length" class="divide-y divide-zinc-800 rounded-xl border border-zinc-800 text-sm">
      <li v-for="(step, index) in chain" :key="key(step)" class="flex items-center gap-2 px-3 py-1.5">
        <span class="w-5 text-xs text-zinc-500 tabular-nums">{{ index + 1 }}.</span>
        <span class="min-w-0 flex-1 truncate">{{ protocols.providerName(step.provider) }} · <span class="text-zinc-400">{{ step.model }}</span></span>
        <span v-if="!options.some((option) => key(option) === key(step))" class="text-xs text-amber-300">indisponível</span>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="index === 0" title="Subir" @click="move(index, -1)">↑</button>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="index === chain.length - 1" title="Descer" @click="move(index, 1)">↓</button>
        <button type="button" class="btn btn-ghost btn-sm text-rose-300" title="Tirar" @click="remove(index)">×</button>
      </li>
    </ol>
    <p v-else class="text-xs text-zinc-500">Nenhum passo: a cota acabou, o turno para com o erro.</p>
    <div v-if="free.length" class="flex gap-2">
      <select v-model="adding" class="h-9 min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-2 text-sm">
        <option value="">Adicionar passo…</option>
        <option v-for="option in free" :key="key(option)" :value="key(option)">{{ protocols.providerName(option.provider) }} · {{ option.model }}</option>
      </select>
      <button type="button" class="btn btn-sm" :disabled="!adding" @click="add">Adicionar</button>
    </div>
  </div>
</template>
