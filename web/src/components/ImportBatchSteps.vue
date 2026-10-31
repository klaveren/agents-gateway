<script setup lang="ts">
import { computed } from 'vue'
import { tokens } from '@/lib/format'
import { DONE_LABEL, ID_STATE_LABEL, type IPlanPhaseInfo, type IPlanStep, KIND_LABEL, stepsByPhase, WHY_LABEL } from '@/lib/importer'

/**
 * Os PASSOS de um lote, por fase e na ordem (o do agente e o da seleção): o id proposto, o estado do id, o "já feito"
 * (no catálogo ou aprovado — sem conversa) e as dependências. ⛔ Só mostra.
 */
const props = defineProps<{ phases: IPlanPhaseInfo[]; steps: IPlanStep[] }>()
const emit = defineEmits<{ select: [key: string] }>()

const groups = computed(() => stepsByPhase(props))
const position = computed(() => new Map(props.steps.map((step, at) => [step.key, at + 1])))
</script>

<template>
  <div v-for="group in groups" :key="group.phase" class="flex flex-col gap-1">
    <h4 class="text-xs font-semibold text-zinc-300">Fase {{ group.phase }} · {{ group.label }} · {{ group.steps.length }}</h4>
    <ol class="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
      <li v-for="step in group.steps" :key="step.key" class="flex flex-col gap-0.5 px-3 py-1.5" :class="step.done ? 'opacity-60' : ''" data-test="step">
        <span class="flex flex-wrap items-center gap-2">
          <span class="w-7 shrink-0 text-right font-mono text-xs text-zinc-500">{{ position.get(step.key) }}</span>
          <span class="rounded-full border border-zinc-700 px-2 text-[11px] text-zinc-400">{{ KIND_LABEL[step.kind] }}</span>
          <button type="button" class="min-w-0 font-mono text-sm break-all text-zinc-100 hover:underline" @click="emit('select', step.key)">{{ step.id }}</button>
          <span v-if="step.done" class="rounded-full border border-emerald-500/40 px-2 text-[11px] text-emerald-200" data-test="step-done">{{ DONE_LABEL[step.done] }}</span>
          <span v-else-if="step.state !== 'new'" class="rounded-full border px-2 text-[11px]" :class="step.state === 'update' ? 'border-zinc-700 text-zinc-400' : 'border-rose-500/50 text-rose-200'">{{ ID_STATE_LABEL[step.state] }}</span>
          <span v-if="step.notes.some((note) => note.level === 'untranslatable')" class="rounded-full bg-amber-500/15 px-2 text-[11px] text-amber-200">não traduz</span>
          <span class="text-xs text-zinc-500">{{ WHY_LABEL[step.why] }}<template v-if="!step.done"> · ≈{{ tokens(step.tokens.sources + step.tokens.protocol) }}</template><template v-else> · sem conversa</template></span>
        </span>
        <span v-if="step.dependsOn.length || step.forward.length" class="pl-9 text-xs break-all text-zinc-500">
          <template v-if="step.dependsOn.length">depois de {{ step.dependsOn.join(', ') }}</template>
          <template v-if="step.forward.length"> · cita adiante {{ step.forward.join(', ') }}</template>
        </span>
      </li>
    </ol>
  </div>
</template>
