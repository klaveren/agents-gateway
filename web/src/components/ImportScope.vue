<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useResource } from '@/composables/useResource'
import { ApiError } from '@/lib/api'
import type { IInventoryScope } from '@/lib/importer'
import { useImportsStore } from '@/stores/imports'

/**
 * O AMBIENTE AGÊNTICO DESTE PROJETO: o que a análise olha. Os lugares padrão, por ferramenta, com um interruptor cada
 * (o `AGENTS.md` é do opencode e do Codex: o mesmo interruptor nos dois) e o "encontrado" da última análise; e os
 * caminhos a mais, um por linha. O resto do repositório fica fora; o ignorar vale dentro.
 *
 * ⚖️ Salvar grava pela store e fica com o que o servidor devolveu (sem reler); vale no próximo "Analisar de novo".
 */
/** `embedded`: sem botão próprio — quem grava é o rodapé da tela (`commit`), junto com o ignorar. */
const props = defineProps<{ projectId?: string; scope?: IInventoryScope; embedded?: boolean }>()

const imports = useImportsStore()
const { data, error: loadError } = useResource(imports.scope, () => props.projectId)

const off = ref(new Set<string>())
const extraText = ref('')
watch(
  data,
  (setting) => {
    off.value = new Set(setting?.disabled ?? [])
    extraText.value = (setting?.extra ?? []).join('\n')
  },
  { immediate: true },
)
const busy = ref(false)
const saved = ref<string>()
const saveError = ref<string>()
const error = computed(() => saveError.value ?? (loadError.value === undefined ? undefined : message(loadError.value)))

const tools = computed(() => data.value?.tools ?? [])
const places = computed(() => [...new Set(tools.value.flatMap((tool) => tool.places))])
const onCount = computed(() => places.value.filter((place) => !off.value.has(place)).length)
const extra = computed(() => [...new Set(extraText.value.split('\n').map((line) => line.trim()).filter(Boolean))])
const dirty = computed(() => {
  const setting = data.value
  if (!setting) return false
  const disabled = places.value.filter((place) => off.value.has(place))
  return disabled.join('\n') !== setting.disabled.join('\n') || extra.value.join('\n') !== setting.extra.join('\n')
})
const foundBy = computed(() => new Map((props.scope?.places ?? []).map((place) => [place.place, place])))
const found = computed(() => (props.scope?.places ?? []).filter((place) => place.found).map((place) => place.place))

function toggle(place: string) {
  const next = new Set(off.value)
  if (next.has(place)) next.delete(place)
  else next.add(place)
  off.value = next
  saved.value = undefined
}

/** O rodapé da importação grava este painel junto: lança se falhar. */
async function commit(): Promise<void> {
  if (!dirty.value) return
  await save()
  if (saveError.value) throw new Error(saveError.value)
}
defineExpose({ dirty, commit })

async function save() {
  if (!props.projectId) return
  busy.value = true
  saved.value = undefined
  saveError.value = undefined
  try {
    await imports.saveScope(props.projectId, { disabled: places.value.filter((place) => off.value.has(place)), extra: extra.value })
    saved.value = 'Salvo. Vale no próximo “Analisar de novo”.'
  } catch (failure) {
    saveError.value = message(failure)
  } finally {
    busy.value = false
  }
}

function message(failure: unknown): string {
  if (failure instanceof ApiError && Array.isArray(failure.details)) {
    const issues = (failure.details as Array<{ field?: string; message?: string }>).map((item) => [item.field, item.message].filter(Boolean).join(': ')).filter(Boolean)
    if (issues.length) return issues.join('; ')
  }
  return failure instanceof Error ? failure.message : String(failure)
}
</script>

<template>
  <details class="rounded-xl border border-zinc-800 px-3 py-2 text-xs" data-test="scope-editor">
    <summary class="cursor-pointer text-zinc-400">
      Ambiente agêntico deste projeto ({{ onCount }} de {{ places.length }} lugar(es)<template v-if="data?.extra.length"> + {{ data.extra.length }} a mais</template>)
    </summary>
    <form class="mt-2 flex flex-col gap-3" @submit.prevent="save">
      <p class="text-zinc-400">
        A análise olha só estes lugares: o resto do repositório (o código do projeto) fica fora, e o que for citado de lá vira só referência. O ignorar vale dentro.
      </p>
      <p v-if="scope" class="text-zinc-400" data-test="scope-found">
        Encontrado na última análise:
        <code v-for="place in found" :key="place" class="mr-1 rounded bg-zinc-900 px-1 text-zinc-200">{{ place }}</code>
        <span v-if="!found.length">nada</span>
        <template v-if="scope.outside"> · {{ scope.outside.toLocaleString('pt-BR') }} arquivo(s) fora do ambiente</template>
      </p>
      <p v-else class="text-zinc-500" data-test="scope-not-analysed">Analise de novo para ver o que é encontrado.</p>
      <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <fieldset v-for="tool in tools" :key="tool.id" class="rounded-lg border border-zinc-800 px-2 py-1.5" data-test="scope-tool">
          <legend class="px-1 text-zinc-300">{{ tool.label }}</legend>
          <label v-for="place in tool.places" :key="place" class="flex items-center gap-2 py-0.5" data-test="scope-place" :data-place="place">
            <input type="checkbox" :checked="!off.has(place)" data-test="scope-toggle" @change="toggle(place)" />
            <code class="break-all text-zinc-200">{{ place }}</code>
            <span v-if="foundBy.get(place)?.found" class="text-emerald-300" data-test="scope-mark">encontrado</span>
            <span v-else-if="foundBy.has(place)" class="text-zinc-500" data-test="scope-mark">não encontrado</span>
          </label>
        </fieldset>
      </div>
      <label class="field">
        Caminhos a mais, um por linha, como no .gitignore: sem <code>/</code> casa o nome em qualquer pasta; com <code>/</code>, a partir da raiz do repositório.
        <textarea v-model="extraText" class="input min-h-16 font-mono" rows="3" placeholder="prompts&#10;docs/agentes/**/*.md" data-test="scope-extra" @input="saved = undefined" />
      </label>
      <div class="flex flex-wrap items-center gap-2">
        <button v-if="!embedded" type="submit" class="btn btn-secondary btn-sm" :disabled="busy || !dirty" data-test="scope-save">{{ busy ? 'Salvando…' : 'Salvar ambiente' }}</button>
        <span v-else-if="dirty" class="text-amber-300">Mudança não salva</span>
        <span v-if="saved" class="text-emerald-300" data-test="scope-saved">{{ saved }}</span>
        <span v-if="error" class="text-rose-300" data-test="scope-error">{{ error }}</span>
      </div>
    </form>
  </details>
</template>
