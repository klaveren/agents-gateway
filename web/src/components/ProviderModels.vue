<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ApiError } from '@/lib/api'
import { fullTime } from '@/lib/format'
import type { ICatalogModel, IProviderStatus } from '@/lib/types'
import { useProvidersStore } from '@/stores/providers'

/**
 * Os modelos de um provider: atualizar a lista, ativar o que pode ser usado, ajustar o preço.
 *
 * ⚖️ A LISTAGEM PROPÕE, QUEM ADMINISTRA DECIDE: modelo novo chega desligado; preço digitado aqui vale
 * sobre o da listagem e o de fábrica, e sobrevive à próxima atualização.
 */
const props = defineProps<{ provider: IProviderStatus }>()

const providers = useProvidersStore()

const models = ref<ICatalogModel[]>([])
const loading = ref(false)
const syncing = ref(false)
const note = ref<string>()
const error = ref<string>()
const search = ref('')
const onlyEnabled = ref(false)
const editing = ref<string>()
const draft = ref({ input: '', output: '' })
const rowError = ref<Record<string, string>>({})

const SOURCE: Record<string, string> = { manual: 'manual', catalog: 'da listagem', default: 'sugerido' }

const visible = computed(() => {
  const term = search.value.trim().toLowerCase()
  return models.value.filter((model) => (!onlyEnabled.value || model.enabled) && (!term || model.modelId.toLowerCase().includes(term) || model.label?.toLowerCase().includes(term)))
})
const enabledCount = computed(() => models.value.filter((model) => model.enabled).length)
const lastSync = computed(() => models.value.map((model) => model.syncedAt).filter(Boolean).sort().at(-1))

onMounted(load)

async function load() {
  loading.value = true
  try {
    models.value = await providers.models(props.provider.id)
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    loading.value = false
  }
}

async function sync() {
  syncing.value = true
  note.value = undefined
  error.value = undefined
  try {
    const result = await providers.syncModels(props.provider.id)
    models.value = result.models
    note.value = `${result.total} modelos na listagem · ${result.added} novos (desligados)${result.missing ? ` · ${result.missing} sumiram da listagem` : ''}.`
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    syncing.value = false
  }
}

function replace(updated: ICatalogModel) {
  models.value = models.value.map((model) => (model.modelId === updated.modelId ? updated : model))
}

async function toggle(model: ICatalogModel) {
  rowError.value = { ...rowError.value, [model.modelId]: '' }
  try {
    replace(await providers.updateModel(props.provider.id, { modelId: model.modelId, enabled: !model.enabled }))
  } catch (failure) {
    rowError.value = { ...rowError.value, [model.modelId]: failure instanceof Error ? failure.message : String(failure) }
  }
}

function edit(model: ICatalogModel) {
  editing.value = model.modelId
  draft.value = { input: model.price ? String(model.price.input) : '', output: model.price ? String(model.price.output) : '' }
}

async function savePrice(model: ICatalogModel, reset = false) {
  const input = Number(draft.value.input.replace(',', '.'))
  const output = Number(draft.value.output.replace(',', '.'))
  if (!reset && (!Number.isFinite(input) || !Number.isFinite(output) || draft.value.input === '' || draft.value.output === '')) {
    rowError.value = { ...rowError.value, [model.modelId]: 'informe entrada e saída, em US$ por 1M de tokens' }
    return
  }
  try {
    replace(await providers.updateModel(props.provider.id, { modelId: model.modelId, price: reset ? null : { input, output } }))
    editing.value = undefined
    rowError.value = { ...rowError.value, [model.modelId]: '' }
  } catch (failure) {
    rowError.value = { ...rowError.value, [model.modelId]: failure instanceof ApiError ? Object.values(failure.fieldIssues).flat().join('; ') || failure.message : String(failure) }
  }
}

function context(tokens?: number): string {
  if (!tokens) return ''
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M` : `${Math.round(tokens / 1000)}k`
}
</script>

<template>
  <div class="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-sm font-medium">Modelos</span>
      <span class="text-xs text-zinc-500">{{ enabledCount }} ativados de {{ models.length }}<template v-if="lastSync"> · lista de {{ fullTime(lastSync) }}</template></span>
      <button type="button" :disabled="syncing || (!provider.credential.configured && !provider.subscription)" class="ml-auto rounded-full bg-zinc-800 px-3 py-1 text-xs hover:bg-zinc-700 disabled:opacity-40" :title="provider.credential.configured || provider.subscription ? '' : 'Salve uma chave antes'" @click="sync">
        {{ syncing ? 'Atualizando…' : 'Atualizar lista' }}
      </button>
    </div>

    <p v-if="note" class="text-xs text-emerald-300">{{ note }}</p>
    <p v-if="error" class="text-xs text-rose-300">{{ error }}</p>

    <div v-if="models.length" class="flex flex-wrap items-center gap-2">
      <input v-model="search" type="search" placeholder="Buscar modelo…" class="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-emerald-500/60" />
      <label class="flex items-center gap-1.5 text-xs text-zinc-400"><input v-model="onlyEnabled" type="checkbox" class="accent-emerald-500" /> só ativados</label>
    </div>

    <p v-if="loading" class="text-xs text-zinc-500">Carregando…</p>
    <p v-else-if="!models.length" class="text-xs text-zinc-500">Nenhum modelo ainda. {{ provider.credential.configured || provider.subscription ? 'Clique em "Atualizar lista" para buscar os do provider.' : 'Salve uma chave e atualize a lista.' }}</p>

    <ul v-if="visible.length" class="scroll-thin max-h-96 divide-y divide-zinc-800/70 overflow-y-auto">
      <li v-for="model in visible" :key="model.modelId" class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" :class="{ 'opacity-50': !model.available }">
        <button type="button" role="switch" :aria-checked="model.enabled" :aria-label="`Ativar ${model.modelId}`" class="switch shrink-0" :class="{ on: model.enabled }" @click="toggle(model)"><span /></button>
        <div class="min-w-0 flex-1 basis-44">
          <div class="truncate font-mono text-[13px]" :title="model.modelId">{{ model.modelId }}</div>
          <div class="truncate text-xs text-zinc-500">
            {{ model.label && model.label !== model.modelId ? model.label : '' }}
            <template v-if="model.contextLength"> · {{ context(model.contextLength) }} de contexto</template>
            <span
              v-if="model.reasoning?.supported"
              class="ml-1 rounded-full bg-violet-500/15 px-1.5 text-[10px] text-violet-300"
              :title="model.reasoning.levels ? `Níveis: ${model.reasoning.levels.join(', ')}` : model.reasoning.source === 'heuristic' ? 'Estimado pelo id: a listagem deste provider não diz' : 'Segundo a listagem do provider'"
              >raciocina{{ model.reasoning.source === 'heuristic' ? ' (estimado)' : '' }}</span
            >
            <span v-if="!model.available" class="ml-1 rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-400">sumiu da listagem</span>
          </div>
        </div>

        <div v-if="editing !== model.modelId" class="ml-auto flex items-center gap-2 text-xs">
          <span v-if="model.price" class="text-zinc-300">${{ model.price.input }} / ${{ model.price.output }} <span class="text-zinc-500">por 1M</span></span>
          <span v-else class="text-zinc-500">sem preço</span>
          <span v-if="model.priceSource" class="rounded-full px-1.5 text-[10px]" :class="model.priceSource === 'manual' ? 'bg-sky-500/15 text-sky-300' : 'bg-zinc-800 text-zinc-400'">{{ SOURCE[model.priceSource] }}</span>
          <button type="button" class="text-zinc-400 hover:text-zinc-100" @click="edit(model)">editar</button>
        </div>
        <form v-else class="flex items-center gap-1.5 text-xs" @submit.prevent="savePrice(model)">
          <input v-model="draft.input" inputmode="decimal" placeholder="entrada" class="w-20 rounded border border-zinc-700 bg-zinc-900 px-2 py-1" />
          <input v-model="draft.output" inputmode="decimal" placeholder="saída" class="w-20 rounded border border-zinc-700 bg-zinc-900 px-2 py-1" />
          <span class="text-zinc-500">US$/1M</span>
          <button type="submit" class="rounded-full bg-emerald-500 px-2.5 py-1 font-medium text-zinc-950">ok</button>
          <button v-if="model.priceSource === 'manual'" type="button" class="text-zinc-400 hover:text-zinc-100" title="Apaga o preço manual e volta ao da listagem ou ao sugerido" @click="savePrice(model, true)">voltar ao sugerido</button>
          <button type="button" class="text-zinc-500 hover:text-zinc-200" @click="editing = undefined">cancelar</button>
        </form>
        <p v-if="rowError[model.modelId]" class="w-full text-xs text-rose-300">{{ rowError[model.modelId] }}</p>
      </li>
    </ul>
  </div>
</template>

<style scoped>
@reference '../style.css';

.switch {
  @apply relative h-5 w-9 rounded-full bg-zinc-700 transition-colors;
}
.switch span {
  @apply absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform;
}
.switch.on {
  @apply bg-emerald-500;
}
.switch.on span {
  @apply translate-x-4;
}
</style>
