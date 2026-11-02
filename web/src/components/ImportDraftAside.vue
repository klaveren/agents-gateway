<script setup lang="ts">
import { ref, watch } from 'vue'
import ImportItemReview from '@/components/ImportItemReview.vue'
import { api, ApiError } from '@/lib/api'
import { type IImportBuildStatus, lastDraft } from '@/lib/importDraft'
import { STATE_HINT, STATE_LABEL } from '@/lib/importer'

/**
 * O RASCUNHO AO LADO DA CONVERSA DE IMPORTAÇÃO: o estado de cada item da conversa e, quando o construtor propôs, a
 * mesma revisão do Importador (os OKs de remoção, Aprovar, Pedir ajuste). Recarrega a cada proposta que termina
 * (`refresh`). ⛔ Gravar no catálogo continua no Importador: o plano e a gravação são do lote, não do item.
 */
const props = defineProps<{ projectId: string; jobId: string; keys: readonly string[]; refresh: number }>()

const statuses = ref<Record<string, IImportBuildStatus>>({})
const latest = ref(true)
const loadError = ref<string>()
const busyKey = ref<string>()
const reviewError = ref<{ key: string; text: string }>()

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

async function load() {
  if (!props.keys.length) return
  try {
    const found = await api<{ latest: boolean; states: IImportBuildStatus[] }>(`${jobPath()}/items`, { query: { keys: props.keys } })
    statuses.value = Object.fromEntries(found.states.map((state) => [state.key, state]))
    latest.value = found.latest
    loadError.value = undefined
  } catch (failure) {
    loadError.value = message(failure)
  }
}

watch(() => [props.projectId, props.jobId, props.keys.join('\n'), props.refresh], load, { immediate: true })

async function review(key: string, action: 'approve' | 'adjust', body: { removals?: number[]; comment?: string }) {
  busyKey.value = key
  reviewError.value = undefined
  try {
    const updated = await api<IImportBuildStatus>(`${jobPath()}/items/${action}`, { method: 'POST', body: { key, ...body } })
    statuses.value = { ...statuses.value, [key]: { ...statuses.value[key], ...updated } }
  } catch (failure) {
    reviewError.value = { key, text: message(failure) }
  } finally {
    busyKey.value = undefined
  }
}
</script>

<template>
  <div class="flex flex-col gap-3" data-test="import-drafts">
    <p v-if="loadError" class="text-xs text-rose-300" data-test="import-drafts-error">{{ loadError }}</p>
    <p v-if="!latest" class="text-xs text-amber-300" data-test="import-drafts-outdated">Há uma análise mais nova deste repositório: a revisão é nela, no Importador.</p>
    <ul class="flex flex-col gap-3">
      <li v-for="key in keys" :key="key" class="flex flex-col gap-2" data-test="import-draft-item">
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <code class="min-w-0 flex-1 break-all text-zinc-300">{{ key }}</code>
          <span v-if="statuses[key]" class="rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-300" :title="STATE_HINT[statuses[key].state]" data-test="import-draft-state">
            {{ STATE_LABEL[statuses[key].state] }}
          </span>
        </div>
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
        <p v-else-if="statuses[key]?.state === 'drafting'" class="text-xs text-zinc-500">Ainda sem rascunho: quando o construtor propuser, ele aparece aqui.</p>
      </li>
    </ul>
  </div>
</template>
