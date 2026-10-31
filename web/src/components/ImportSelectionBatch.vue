<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ImportBatchSteps from '@/components/ImportBatchSteps.vue'
import { fullTime, tokens } from '@/lib/format'
import { EXCLUSION_LABEL, ID_STATE_LABEL, type IImportBatch, type ISelectionPlan, KIND_LABEL, OUTSIDE_LABEL, outsideByState, prefixIssue, type TInventoryKind } from '@/lib/importer'

/**
 * O LOTE POR SELEÇÃO de um trabalho: a ordem só entre os itens escolhidos, os ciclos, as citações para fora da seleção
 * (no catálogo, aprovada, em outro lote, faltando, quebrada), o mapa de ids e a estimativa. Na prévia, a pessoa dá um
 * nome e salva o lote no trabalho; o lote salvo mostra quem montou e quando.
 *
 * ⛔ Salvar o lote é só o registro no trabalho: nenhum botão daqui grava no catálogo nem dispara construtor.
 */
const props = defineProps<{
  plan: ISelectionPlan
  /** O lote salvo (ausente = prévia da seleção). */
  batch?: IImportBatch
  /** O nome proposto na prévia. */
  name?: string
  busy?: boolean
  /** Trabalho antigo: a prévia vale, salvar não. */
  readonly?: boolean
  error?: string
}>()
const emit = defineEmits<{ close: []; select: [key: string]; replan: [prefix: string]; save: [name: string] }>()

const prefix = ref(props.plan.prefix)
const title = ref(props.name ?? '')
watch(
  () => props.plan.prefix,
  (value) => (prefix.value = value),
)
watch(
  () => props.name,
  (value) => (title.value = value ?? ''),
)
const issue = computed(() => prefixIssue(prefix.value))
const pending = computed(() => props.plan.steps.filter((step) => !step.done).length)
const outside = computed(() => outsideByState(props.plan.outside))
const changedIds = computed(() => props.plan.idMap.filter((entry) => entry.prefixed || entry.state !== 'new' || entry.cut))
const kinds = computed(() => {
  const out = new Map<TInventoryKind, number>()
  for (const step of props.plan.steps) out.set(step.kind, (out.get(step.kind) ?? 0) + 1)
  return [...out.entries()]
})
</script>

<template>
  <section class="flex flex-col gap-4 rounded-xl border border-sky-500/30 p-3 text-sm" data-test="selection-batch">
    <header class="flex flex-wrap items-start gap-2">
      <div class="min-w-0 flex-1">
        <h2 class="text-base font-semibold text-zinc-100">
          <template v-if="batch">Lote <span class="text-sky-200">{{ batch.name }}</span></template>
          <template v-else>Lote da seleção (prévia)</template>
        </h2>
        <p v-if="batch" class="text-xs text-zinc-500" data-test="batch-meta">
          Montado por {{ batch.by }} em {{ fullTime(batch.at) }} · {{ batch.keys.length }} item(ns) escolhido(s){{ batch.prefix ? ` · prefixo ${batch.prefix}` : '' }}. Recalculado sobre o estado de agora.
        </p>
        <p class="text-xs text-zinc-500">Ordem só entre os itens escolhidos. Nada é gravado no catálogo e nenhum construtor é disparado.</p>
      </div>
      <form v-if="!batch" class="flex items-end gap-2" @submit.prevent="!issue && emit('replan', prefix.trim().toLowerCase())">
        <label class="field w-36">
          Prefixo dos ids
          <input v-model="prefix" class="input" placeholder="sem prefixo" maxlength="16" data-test="selection-prefix" />
        </label>
        <button type="submit" class="btn btn-secondary btn-sm mb-0.5" :disabled="busy || !!issue" data-test="selection-replan">{{ busy ? 'Montando…' : 'Recalcular' }}</button>
        <button type="button" class="btn btn-ghost btn-sm mb-0.5" @click="emit('close')">Fechar</button>
      </form>
      <button v-else type="button" class="btn btn-ghost btn-sm" @click="emit('close')">Fechar</button>
    </header>
    <p v-if="issue && !batch" class="text-xs text-rose-300">Prefixo: {{ issue }}</p>

    <form v-if="!batch && !readonly" class="flex flex-wrap items-end gap-2" data-test="save-batch" @submit.prevent="title.trim() && emit('save', title.trim())">
      <label class="field min-w-48 flex-1 sm:max-w-sm">
        Nome do lote
        <input v-model="title" class="input" maxlength="120" placeholder="ex.: knowledge, specs de core/" data-test="batch-name" />
      </label>
      <button type="submit" class="btn btn-primary btn-sm mb-0.5" :disabled="busy || !title.trim() || !!issue" data-test="batch-save">{{ busy ? 'Salvando…' : 'Salvar lote no trabalho' }}</button>
    </form>
    <p v-else-if="!batch && readonly" class="text-xs text-amber-200">Trabalho antigo: a prévia vale, mas o lote só é salvo no trabalho mais novo.</p>
    <p v-if="error" class="text-xs text-rose-300" data-test="batch-error">{{ error }}</p>

    <section v-if="plan.blocked.length" class="rounded-xl border border-rose-500/50 bg-rose-500/10 px-3 py-2" data-test="selection-blocked">
      <h3 class="text-xs font-semibold tracking-wide text-rose-200 uppercase">Bloqueado: id em conflito</h3>
      <ul class="mt-1 flex flex-col gap-0.5 text-xs text-rose-50">
        <li v-for="line in plan.blocked" :key="line">{{ line }}</li>
      </ul>
    </section>

    <section class="flex flex-col gap-1 rounded-xl border border-zinc-800 px-3 py-2" data-test="selection-estimate">
      <h3 class="text-xs font-medium text-zinc-500">Estimativa</h3>
      <p class="text-zinc-200">
        <strong>{{ plan.estimate.conversations }}</strong> conversa(s) de construtor · ≈<strong>{{ tokens(plan.estimate.inputTokens) }}</strong> tokens de entrada
        <span class="text-xs text-zinc-500">({{ tokens(plan.estimate.sourceTokens) }} das fontes + {{ tokens(plan.estimate.protocolTokens) }} do protocolo)</span>
      </p>
      <p class="flex flex-wrap gap-x-3 text-xs text-zinc-400">
        <span v-for="(entry, kind) in plan.estimate.byKind" :key="kind">{{ KIND_LABEL[kind] }}: {{ entry!.conversations }} · ≈{{ tokens(entry!.inputTokens) }}</span>
      </p>
      <p v-if="plan.estimate.done" class="text-xs text-emerald-200/80">{{ plan.estimate.done }} passo(s) já no catálogo ou aprovado(s) ficam fora da conta.</p>
      <p class="text-xs text-zinc-500">{{ plan.estimate.note }}.</p>
    </section>

    <section class="flex flex-col gap-2" data-test="selection-order">
      <h3 class="text-xs font-medium text-zinc-500">
        Ordem ({{ pending }} com conversa<template v-if="pending !== plan.steps.length"> de {{ plan.steps.length }}</template>)
        <template v-if="kinds.length"> · <span v-for="[kind, count] in kinds" :key="kind" class="mr-2">{{ KIND_LABEL[kind] }} {{ count }}</span></template>
      </h3>
      <p v-if="!plan.steps.length" class="text-xs text-zinc-500">Nenhum item escolhido vai ao catálogo.</p>
      <ImportBatchSteps :phases="plan.phases" :steps="plan.steps" @select="emit('select', $event)" />
    </section>

    <section v-if="plan.cycles.length" class="flex flex-col gap-1" data-test="selection-cycles">
      <h3 class="text-xs font-medium text-zinc-500">Ciclos ({{ plan.cycles.length }})</h3>
      <p v-for="cycle in plan.cycles" :key="cycle.keys.join()" class="text-xs break-words text-amber-200">{{ cycle.text }}</p>
    </section>

    <section class="flex flex-col gap-1.5" data-test="outside">
      <h3 class="text-xs font-medium text-zinc-500">Citações para fora da seleção ({{ plan.outside.length }})</h3>
      <p v-if="!plan.outside.length" class="text-xs text-zinc-500">Os itens escolhidos só citam uns aos outros.</p>
      <div v-for="group in outside" :key="group.state" data-test="outside-group">
        <p class="text-xs font-medium" :class="group.state === 'broken' ? 'text-rose-300' : group.state === 'missing' ? 'text-amber-200' : 'text-zinc-400'">{{ OUTSIDE_LABEL[group.state] }} ({{ group.entries.length }})</p>
        <ul class="flex flex-col gap-0.5 text-xs text-zinc-400">
          <li v-for="entry in group.entries" :key="`${entry.from}|${entry.item ?? ''}|${entry.path ?? ''}`" class="break-all">
            <button type="button" class="font-mono text-zinc-300 hover:underline" @click="emit('select', entry.from)">{{ entry.from }}</button>
            →
            <button v-if="entry.item" type="button" class="font-mono text-zinc-300 hover:underline" @click="emit('select', entry.item)">{{ entry.item }}</button>
            <code v-else>{{ entry.path }}</code>
            <span v-if="entry.id && entry.id !== entry.item?.split(':')[1]" class="text-zinc-500"> ({{ entry.id }})</span>
            <span class="text-zinc-500"> — {{ entry.text }}</span>
          </li>
        </ul>
      </div>
    </section>

    <section v-if="changedIds.length" class="flex flex-col gap-1" data-test="selection-id-map">
      <h3 class="text-xs font-medium text-zinc-500">Mapa de ids ({{ plan.idMap.length }}{{ plan.prefix ? `, prefixo ${plan.prefix}` : ', sem prefixo' }})</h3>
      <table class="w-full text-left text-xs">
        <tbody class="divide-y divide-zinc-800">
          <tr v-for="entry in changedIds" :key="entry.key" :class="entry.state === 'conflict' || entry.state === 'duplicate' ? 'text-rose-200' : 'text-zinc-300'">
            <td class="py-1 pr-2 font-mono break-all">{{ entry.key }}</td>
            <td class="py-1 pr-2 font-mono break-all">{{ entry.parent ? `${entry.parent}/` : '' }}{{ entry.id }}</td>
            <td class="py-1">{{ ID_STATE_LABEL[entry.state] }}<span v-if="entry.reason" class="text-zinc-500"> — {{ entry.reason }}</span></td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="plan.excluded.length" class="flex flex-col gap-0.5 text-xs" data-test="selection-excluded">
      <h3 class="font-medium text-zinc-500">Escolhidos que não vão ao catálogo ({{ plan.excluded.length }})</h3>
      <p v-for="entry in plan.excluded" :key="entry.from" class="break-all text-zinc-400">
        <code>{{ entry.from }}</code> — {{ EXCLUSION_LABEL[entry.reason] }}
      </p>
    </section>

    <ul v-if="plan.notes.some((note) => note.level !== 'info')" class="text-xs text-amber-200">
      <li v-for="note in plan.notes.filter((one) => one.level !== 'info')" :key="note.code">{{ note.text }}</li>
    </ul>
  </section>
</template>

<style scoped>
@reference '../style.css';

.field {
  @apply flex min-w-0 flex-col gap-1.5 text-xs font-medium text-zinc-400;
}
.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
</style>
