<script setup lang="ts">
import { computed, watch } from 'vue'
import ImportDraftAside from '@/components/ImportDraftAside.vue'
import ThreadView from '@/components/ThreadView.vue'
import { BUILD_KINDS, importBuilderAgentId, type TBuildKind } from '@/lib/builder'
import { builderKindFor, draftingWithoutConversation, type IImportBuildStatus, importOpening, importProposals } from '@/lib/importDraft'
import { effectiveKind, type IImportItemStatus, type IInventoryItem, type TOverrides } from '@/lib/importer'
import { useThreadStore } from '@/stores/thread'

/**
 * A MESA DO PASSO PREPARAR: as conversas da migração (uma por construtor) à esquerda, a conversa escolhida no meio — a
 * mesma da tela do construtor, embutida — e a fila de revisão dela à direita. Trocar de conversa não sai da tela.
 * ⛔ Aprovar não grava no catálogo (é do passo Gravar).
 */
const props = defineProps<{
  projectId: string
  jobId: string
  keys: readonly string[]
  items: ReadonlyMap<string, IInventoryItem>
  statuses: Readonly<Record<string, IImportItemStatus>>
  overrides: TOverrides
}>()
const emit = defineEmits<{ updated: [states: IImportBuildStatus[]] }>()

const thread = useThreadStore()

/** As conversas da migração: os itens agrupados pela conversa do construtor em que estão. */
const conversations = computed(() => {
  const groups = new Map<string, { id: string; kind: TBuildKind; keys: string[] }>()
  for (const key of props.keys) {
    const status = props.statuses[key] as IImportBuildStatus | undefined
    const item = props.items.get(key)
    if (!item || !status?.conversationId || draftingWithoutConversation(status)) continue
    const kind = builderKindFor(effectiveKind(item, props.overrides))
    if (!kind) continue
    const group = groups.get(status.conversationId) ?? { id: status.conversationId, kind, keys: [] }
    group.keys.push(key)
    groups.set(status.conversationId, group)
  }
  return [...groups.values()].map((group) => {
    const states = group.keys.map((key) => props.statuses[key]?.state)
    return {
      ...group,
      review: states.filter((state) => state === 'review').length,
      done: states.filter((state) => state === 'approved' || state === 'applied').length,
    }
  })
})

/** A conversa aberta no meio (quem embute pode escolher: a lista "Todos os itens" leva à conversa do item). */
const selected = defineModel<string | undefined>('selected')
const current = computed(() => conversations.value.find((entry) => entry.id === selected.value))
// Abre na conversa que pede revisão (senão, a primeira); a que sumiu da lista cede o lugar.
watch(
  conversations,
  (list) => {
    if (!current.value) selected.value = (list.find((entry) => entry.review) ?? list[0])?.id
  },
  { immediate: true },
)
watch(
  selected,
  (id) => {
    if (id && thread.sessionId !== id) void thread.open(id)
  },
  { immediate: true },
)

const here = computed(() => !!selected.value && thread.sessionId === selected.value)
const canStart = computed(() => here.value && !thread.turns.length && !thread.sending && !thread.loading)
const refresh = computed(() => (here.value ? importProposals(thread.turns, thread.pending) : 0))

function start() {
  if (current.value) void thread.send(importOpening(current.value.keys), [])
}
</script>

<template>
  <section class="grid min-h-0 gap-3 lg:h-[calc(100vh-13rem)] lg:grid-cols-[13rem_minmax(0,1fr)_minmax(0,24rem)]" data-test="prepare-desk">
    <nav class="flex flex-col gap-1.5 lg:overflow-y-auto" aria-label="Conversas da migração" data-test="desk-conversations">
      <p v-if="!conversations.length" class="text-xs text-zinc-500">Nenhuma conversa ainda: use "Preparar com o construtor".</p>
      <button
        v-for="entry in conversations"
        :key="entry.id"
        type="button"
        class="flex flex-col gap-0.5 rounded-xl border px-3 py-2 text-left text-xs hover:bg-zinc-900"
        :class="entry.id === selected ? 'border-emerald-500/50 bg-zinc-900' : 'border-zinc-800'"
        :aria-current="entry.id === selected"
        data-test="desk-conversation"
        @click="selected = entry.id"
      >
        <span class="font-medium text-zinc-200">{{ BUILD_KINDS[entry.kind].title }}</span>
        <span class="text-zinc-500">{{ entry.keys.length }} item(ns)</span>
        <span class="flex flex-wrap gap-1">
          <span v-if="entry.review" class="rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-200">{{ entry.review }} a revisar</span>
          <span class="rounded-full bg-emerald-500/15 px-1.5 text-[10px] text-emerald-200">{{ entry.done }} aprovado(s)</span>
        </span>
      </button>
    </nav>

    <div class="flex min-h-[28rem] min-w-0 flex-col overflow-hidden rounded-xl border border-zinc-800" data-test="desk-thread">
      <template v-if="current">
        <div v-if="canStart" class="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs">
          <span class="text-zinc-400">O construtor ainda não começou estes {{ current.keys.length }} item(ns).</span>
          <button type="button" class="btn btn-primary btn-sm" data-test="desk-start" @click="start">Começar</button>
        </div>
        <ThreadView :key="current.id" embedded :agent-id="importBuilderAgentId(current.kind)" mode="agent" />
      </template>
      <p v-else class="m-auto p-6 text-sm text-zinc-500">Escolha uma conversa à esquerda.</p>
    </div>

    <aside class="scroll-thin min-w-0 lg:overflow-y-auto" data-test="desk-review">
      <ImportDraftAside v-if="current" :key="current.id" :project-id="projectId" :job-id="jobId" :keys="current.keys" :refresh="refresh" @updated="emit('updated', $event)" />
    </aside>
  </section>
</template>
