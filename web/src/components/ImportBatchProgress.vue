<script setup lang="ts">
import { computed } from 'vue'
import { builderKindFor, draftingWithoutConversation, type IImportBuildStatus } from '@/lib/importDraft'
import { effectiveKind, type IImportItemStatus, type IInventoryItem, KIND_LABEL, STATE_HINT, STATE_LABEL, type TImportItemState, type TOverrides } from '@/lib/importer'

/**
 * O PASSO "PREPARAR" de um lote: cada item na ordem do lote, com o tipo, o estado e a conversa do construtor em que
 * ele está — e o resumo do lote (quantos a importar, no construtor, a revisar, aprovados, gravados). ⛔ Só mostra e leva
 * à conversa ou ao item; abrir as conversas e gravar são da tela.
 */
const props = defineProps<{
  keys: readonly string[]
  items: ReadonlyMap<string, IInventoryItem>
  statuses: Readonly<Record<string, IImportItemStatus>>
  overrides: TOverrides
}>()
/** `conversation`: abrir a conversa do item na mesa (sem sair da tela). */
const emit = defineEmits<{ select: [key: string]; conversation: [id: string] }>()


const rows = computed(() =>
  props.keys.flatMap((key) => {
    const item = props.items.get(key)
    if (!item) return []
    const status = props.statuses[key] as IImportBuildStatus | undefined
    const state: TImportItemState = status?.state ?? 'pending'
    const kind = effectiveKind(item, props.overrides)
    const builder = builderKindFor(kind)
    const conversationId = builder && status?.conversationId && !draftingWithoutConversation(status) ? status.conversationId : undefined
    return [{ key, item, kind, state, conversationId, builder }]
  }),
)

/** O resumo do lote, na ordem do fluxo. */
const FLOW: readonly TImportItemState[] = ['pending', 'stale', 'drafting', 'review', 'rejected', 'error', 'approved', 'applied', 'skipped']
const summary = computed(() => {
  const counts = new Map<TImportItemState, number>()
  for (const row of rows.value) counts.set(row.state, (counts.get(row.state) ?? 0) + 1)
  return FLOW.filter((state) => counts.get(state)).map((state) => ({ state, count: counts.get(state)! }))
})

const TONE: Partial<Record<TImportItemState, string>> = {
  drafting: 'bg-sky-500/15 text-sky-200',
  review: 'bg-amber-500/15 text-amber-200',
  approved: 'bg-emerald-500/15 text-emerald-200',
  applied: 'bg-emerald-500/25 text-emerald-100',
  stale: 'bg-amber-500/15 text-amber-200',
  error: 'bg-rose-500/15 text-rose-200',
  rejected: 'bg-rose-500/15 text-rose-200',
}

</script>

<template>
  <section class="flex flex-col gap-2" data-test="batch-progress">
    <div class="flex flex-wrap gap-1.5 text-xs" data-test="progress-summary">
      <span v-for="entry in summary" :key="entry.state" class="rounded-full px-2 py-0.5" :class="TONE[entry.state] ?? 'bg-zinc-800 text-zinc-300'" :title="STATE_HINT[entry.state]">
        {{ STATE_LABEL[entry.state] }} {{ entry.count }}
      </span>
    </div>
    <ul class="divide-y divide-zinc-800 rounded-xl border border-zinc-800 text-xs">
      <li v-for="row in rows" :key="row.key" class="flex flex-wrap items-center gap-2 px-3 py-1.5" data-test="progress-row">
        <span class="w-20 shrink-0 text-zinc-500">{{ KIND_LABEL[row.kind] }}</span>
        <button type="button" class="min-w-0 flex-1 truncate text-left font-mono text-zinc-200 hover:underline" :title="`${row.key} — ver no inventário`" @click="emit('select', row.key)">{{ row.item.candidateId }}</button>
        <span class="rounded-full px-2" :class="TONE[row.state] ?? 'bg-zinc-800 text-zinc-400'" :title="STATE_HINT[row.state]" data-test="progress-state">{{ STATE_LABEL[row.state] }}</span>
        <button
          v-if="row.conversationId"
          type="button"
          class="text-emerald-300 hover:underline"
          data-test="progress-conversation"
          @click="emit('conversation', row.conversationId)"
        >
          {{ row.state === 'review' ? 'Revisar' : 'Ver conversa' }}
        </button>
        <span v-else-if="!row.builder" class="text-zinc-600" title="Este tipo não passa pelo construtor">sem construtor</span>
      </li>
    </ul>
  </section>
</template>
