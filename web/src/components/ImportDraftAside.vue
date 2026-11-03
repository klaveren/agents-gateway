<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ImportItemReview from '@/components/ImportItemReview.vue'
import { api, ApiError } from '@/lib/api'
import { type IImportBuildStatus, lastDraft } from '@/lib/importDraft'
import { BUILDER_KINDS, canReclassifyState, KIND_LABEL, STATE_HINT, STATE_LABEL, type TImportItemState, type TInventoryKind } from '@/lib/importer'

/**
 * A FILA DE REVISÃO de uma conversa de importação (ao lado da conversa, na tela do construtor e na mesa do passo
 * Preparar): os itens da conversa, primeiro os que estão a revisar, um aberto por vez com a revisão do rascunho (os OKs
 * de remoção, Aprovar, Pedir ajuste). Aprovar abre o próximo a revisar. "Aprovar os N sem remoção" aprova, com
 * confirmação, os rascunhos que não removem nada (a remoção segue pedindo o OK de cada uma). Recarrega a cada proposta
 * que termina (`refresh`). ⛔ Gravar no catálogo é do passo Gravar da migração.
 */
const props = withDefaults(
  defineProps<{
    projectId: string
    jobId: string
    keys: readonly string[]
    refresh: number
    /** Onde os itens estão, na contagem ("na conversa", "na migração"). */
    scope?: string
    /** O andamento do construtor por item (a mesa do Preparar): no lugar do estado, enquanto o item está com ele. */
    badges?: Readonly<Record<string, { label: string; hint?: string; tone: 'work' | 'idle' }>>
    /** Mostra, em cada item, o botão que abre a conversa dele (`conversation`). */
    withConversation?: boolean
  }>(),
  { scope: 'na conversa', badges: () => ({}), withConversation: false },
)
/** O estado de agora dos itens (o que a fila carregou ou a revisão mudou): quem embute atualiza as contagens. */
const emit = defineEmits<{ updated: [states: IImportBuildStatus[]]; conversation: [conversationId: string] }>()

const statuses = ref<Record<string, IImportBuildStatus>>({})
const latest = ref(true)
const loadError = ref<string>()
const busyKey = ref<string>()
const reviewError = ref<{ key: string; text: string }>()
/** O item aberto (um por vez) e se a fila mostra só os a revisar. */
const open = ref<string>()
const onlyReview = ref(true)
/** A aprovação em bloco: a confirmação aberta e o andamento. */
const confirming = ref(false)
const bulk = ref<{ done: number; total: number; failed: string[] }>()

/** A ordem da fila: o que pede ação primeiro. */
const RANK: Partial<Record<TImportItemState, number>> = { review: 0, drafting: 1, approved: 2, applied: 3 }
const ordered = computed(() =>
  props.keys
    .map((key, index) => ({ key, index, state: statuses.value[key]?.state }))
    .sort((a, b) => (RANK[a.state ?? 'pending'] ?? 4) - (RANK[b.state ?? 'pending'] ?? 4) || a.index - b.index)
    .map((entry) => entry.key),
)
const toReview = computed(() => ordered.value.filter((key) => statuses.value[key]?.state === 'review'))
const shown = computed(() => (onlyReview.value && toReview.value.length ? toReview.value : ordered.value))
/** Os rascunhos a revisar que não removem nada: aprovar não pede OK nenhum. */
const quick = computed(() => toReview.value.filter((key) => lastDraft(statuses.value[key])?.removals.length === 0))

function message(failure: unknown): string {
  if (failure instanceof ApiError && Array.isArray(failure.details)) {
    const issues = (failure.details as Array<{ message?: string }>).map((item) => item.message).filter(Boolean)
    if (issues.length) return issues.join('; ')
  }
  return failure instanceof Error ? failure.message : String(failure)
}

function jobPath(): string {
  return `/projects/${encodeURIComponent(props.projectId)}/import/jobs/${encodeURIComponent(props.jobId)}`
}

/** O servidor lê no máximo 200 chaves por pedido. */
const KEYS_PER_CALL = 200

async function load() {
  if (!props.keys.length) return
  try {
    const states: IImportBuildStatus[] = []
    let fresh = true
    for (let at = 0; at < props.keys.length; at += KEYS_PER_CALL) {
      const found = await api<{ latest: boolean; states: IImportBuildStatus[] }>(`${jobPath()}/items`, { query: { keys: props.keys.slice(at, at + KEYS_PER_CALL) } })
      states.push(...found.states)
      fresh &&= found.latest
    }
    statuses.value = Object.fromEntries(states.map((state) => [state.key, state]))
    latest.value = fresh
    loadError.value = undefined
    if (!open.value || !statuses.value[open.value] || statuses.value[open.value].state !== 'review') open.value = toReview.value[0]
    emit('updated', states)
  } catch (failure) {
    loadError.value = message(failure)
  }
}

// ⚠️ Um texto, não um array: o array novo a cada leitura dispararia de novo a cada mudança de estado (e a carga muda o estado).
watch(() => `${props.projectId}\n${props.jobId}\n${props.refresh}\n${props.keys.join('\n')}`, load, { immediate: true })

/** O próximo a revisar depois deste (ou o primeiro que sobrou). */
function nextAfter(key: string): string | undefined {
  const rest = toReview.value.filter((one) => one !== key)
  return rest.find((one) => props.keys.indexOf(one) > props.keys.indexOf(key)) ?? rest[0]
}

async function review(key: string, action: 'approve' | 'adjust', body: { removals?: number[]; comment?: string }) {
  busyKey.value = key
  reviewError.value = undefined
  try {
    const updated = await api<IImportBuildStatus>(`${jobPath()}/items/${action}`, { method: 'POST', body: { key, ...body } })
    const next = action === 'approve' ? nextAfter(key) : key
    statuses.value = { ...statuses.value, [key]: { ...statuses.value[key], ...updated } }
    emit('updated', [statuses.value[key]])
    open.value = next
  } catch (failure) {
    reviewError.value = { key, text: message(failure) }
  } finally {
    busyKey.value = undefined
  }
}

/** O tipo em vigor do item (o reclassificado, senão o da chave). */
function kindOf(key: string): TInventoryKind {
  return statuses.value[key]?.kind ?? (key.slice(0, key.indexOf(':')) as TInventoryKind)
}

/** Reclassificar daqui: o item sem rascunho (mesmo já com o construtor) sai da conversa e volta à fila. */
function canMove(key: string): boolean {
  const status = statuses.value[key]
  return latest.value && !!status && canReclassifyState(status.state, !!lastDraft(status))
}

async function reclassify(key: string, kind: TInventoryKind) {
  busyKey.value = key
  reviewError.value = undefined
  try {
    const updated = await api<IImportBuildStatus>(`${jobPath()}/items`, { method: 'PATCH', body: { key, kind } })
    // ⚠️ Substitui (não mescla): a conversa de que o item saiu não vem na resposta.
    statuses.value = { ...statuses.value, [key]: updated }
    emit('updated', [updated])
  } catch (failure) {
    reviewError.value = { key, text: message(failure) }
  } finally {
    busyKey.value = undefined
  }
}

/** Aprova, um a um, os rascunhos sem remoção (o servidor confere cada um de novo com a fonte). */
async function approveQuick() {
  const keys = [...quick.value]
  confirming.value = false
  bulk.value = { done: 0, total: keys.length, failed: [] }
  for (const key of keys) {
    try {
      const updated = await api<IImportBuildStatus>(`${jobPath()}/items/approve`, { method: 'POST', body: { key, removals: [] } })
      statuses.value = { ...statuses.value, [key]: { ...statuses.value[key], ...updated } }
      emit('updated', [statuses.value[key]])
    } catch (failure) {
      bulk.value.failed.push(`${key}: ${message(failure)}`)
    }
    bulk.value.done += 1
  }
  open.value = toReview.value[0]
}
</script>

<template>
  <div class="flex flex-col gap-3" data-test="import-drafts">
    <p v-if="loadError" class="text-xs text-rose-300" data-test="import-drafts-error">{{ loadError }}</p>
    <p v-if="!latest" class="text-xs text-amber-300" data-test="import-drafts-outdated">Há uma análise mais nova deste repositório: a revisão é nela, no Importador.</p>

    <div class="flex flex-wrap items-center gap-2 text-xs">
      <span class="text-zinc-300" data-test="review-count">{{ toReview.length }} a revisar · {{ keys.length }} {{ scope }}</span>
      <span class="flex-1" />
      <label v-if="toReview.length" class="flex items-center gap-1 text-zinc-400">
        <input v-model="onlyReview" type="checkbox" class="accent-emerald-500" data-test="only-review" />
        só a revisar
      </label>
    </div>

    <section v-if="quick.length && latest" class="flex flex-col gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-2 text-xs" data-test="quick-approve">
      <button v-if="!confirming" type="button" class="btn btn-secondary btn-sm self-start" :disabled="!!bulk && bulk.done < bulk.total" data-test="quick-approve-open" @click="confirming = true">
        Aprovar os {{ quick.length }} sem remoção
      </button>
      <template v-else>
        <p class="text-zinc-300">Aprovar estes {{ quick.length }} rascunhos? Nenhum remove trecho; cada um é conferido de novo com a fonte.</p>
        <ul class="scroll-thin max-h-32 overflow-y-auto font-mono text-zinc-400" data-test="quick-approve-list">
          <li v-for="key in quick" :key="key">{{ key }}</li>
        </ul>
        <div class="flex gap-2">
          <button type="button" class="btn btn-primary btn-sm" data-test="quick-approve-confirm" @click="approveQuick">Aprovar {{ quick.length }}</button>
          <button type="button" class="btn btn-ghost btn-sm" @click="confirming = false">Cancelar</button>
        </div>
      </template>
    </section>
    <p v-if="bulk" class="text-xs" :class="bulk.failed.length ? 'text-amber-200' : 'text-emerald-300'" data-test="quick-approve-result">
      {{ bulk.done }}/{{ bulk.total }} aprovado(s)<template v-if="bulk.failed.length"> · {{ bulk.failed.length }} não: {{ bulk.failed.join('; ') }}</template>
    </p>

    <ul class="flex flex-col gap-1.5">
      <li v-for="key in shown" :key="key" class="flex flex-col gap-2" data-test="import-draft-item">
        <button
          type="button"
          class="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1 text-left text-xs hover:bg-zinc-900"
          :class="open === key ? 'bg-zinc-900' : ''"
          :aria-expanded="open === key"
          data-test="import-draft-toggle"
          @click="open = open === key ? undefined : key"
        >
          <code class="min-w-0 flex-1 break-all text-zinc-300">{{ key }}</code>
          <span
            v-if="badges[key] && statuses[key]?.state === 'drafting'"
            class="rounded-full px-1.5 text-[10px]"
            :class="badges[key].tone === 'work' ? 'animate-pulse bg-sky-500/15 text-sky-200' : 'bg-orange-500/15 text-orange-200'"
            :title="badges[key].hint"
            data-test="import-draft-badge"
          >
            {{ badges[key].label }}
          </span>
          <span
            v-else-if="statuses[key]"
            class="rounded-full px-1.5 text-[10px]"
            :class="statuses[key].state === 'review' ? 'bg-amber-500/15 text-amber-200' : statuses[key].state === 'approved' ? 'bg-emerald-500/15 text-emerald-200' : 'bg-zinc-800 text-zinc-300'"
            :title="STATE_HINT[statuses[key].state]"
            data-test="import-draft-state"
          >
            {{ STATE_LABEL[statuses[key].state] }}
          </span>
        </button>
        <button
          v-if="withConversation && open === key && statuses[key]?.conversationId"
          type="button"
          class="btn btn-ghost btn-sm self-start"
          data-test="import-draft-conversation"
          @click="emit('conversation', statuses[key].conversationId!)"
        >
          Abrir a conversa deste item
        </button>
        <template v-if="open === key">
          <ImportItemReview
            v-if="statuses[key] && lastDraft(statuses[key]) && ['drafting', 'review', 'approved'].includes(statuses[key].state)"
            :draft="lastDraft(statuses[key])!"
            :state="statuses[key].state"
            :review="statuses[key].review"
            :approved-by="statuses[key].approvedBy"
            :approved-at="statuses[key].approvedAt"
            :readonly="!latest"
            :busy="busyKey === key"
            :error="reviewError?.key === key ? reviewError.text : undefined"
            @approve="review(key, 'approve', { removals: $event })"
            @adjust="review(key, 'adjust', { comment: $event })"
          />
          <p v-else-if="statuses[key]?.state === 'drafting'" class="px-2 text-xs text-zinc-500">Ainda sem rascunho: quando o construtor propuser, ele aparece aqui.</p>
          <label v-if="canMove(key)" class="flex flex-wrap items-center gap-2 px-2 text-xs text-zinc-400" data-test="import-draft-reclassify">
            Não é {{ KIND_LABEL[kindOf(key)] }}? Reclassificar
            <select
              class="input w-auto py-0.5 text-xs"
              :value="kindOf(key)"
              :disabled="busyKey === key"
              data-test="import-draft-reclassify-kind"
              @change="reclassify(key, ($event.target as HTMLSelectElement).value as TInventoryKind)"
            >
              <option v-for="kind in BUILDER_KINDS" :key="kind" :value="kind">{{ KIND_LABEL[kind] }}</option>
            </select>
            <span class="text-zinc-500">sai da conversa e vai ao construtor do tipo novo no próximo "Retomar".</span>
          </label>
          <p v-if="reviewError?.key === key && !lastDraft(statuses[key])" class="px-2 text-xs text-rose-300" data-test="import-draft-error">{{ reviewError.text }}</p>
        </template>
      </li>
    </ul>
  </div>
</template>
