<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CONTEXT_WARN_TOKENS, contextWeight } from '@/lib/guidance'
import type { IProjectDoc } from '@/lib/types'
import { useScopedDocs } from '@/composables/useCatalogLists'
import { useResource } from '@/composables/useResource'
import { type TContextOwner, useAgentCatalogStore } from '@/stores/agentCatalog'

/**
 * O editor de um CONTEXTO INICIAL — o do projeto ou o de um agente: as specs que vão INTEIRAS no prompt, na ordem
 * marcada. `owner` + `ownerId` dizem de quem é (`projects`/`agents`, a rota `/<owner>/:id/initial-context`);
 * `projectId`, de que projeto vêm as specs além das globais (ausente = só as globais); `baseTokens`, o que já entra
 * antes (o do projeto, na guia do agente), para o peso mostrar o total da conversa. As specs e o contexto moram nas
 * stores: o Ambiente e a guia do agente leem a mesma cópia.
 */
/** `embedded`: dentro de um formulário maior, sem botão próprio — quem grava é o Salvar dele (`commit`). */
const props = defineProps<{ owner: TContextOwner; ownerId: string; projectId?: string; baseTokens?: number; embedded?: boolean }>()
/** O peso das marcadas (o que já está na lista, salvo ou não): quem embute mostra o total da conversa. */
const emit = defineEmits<{ weight: [tokens: number] }>()
const catalog = useAgentCatalogStore()

const specs = useScopedDocs(() => props.projectId ?? null, 'spec')
const context = useResource(catalog.initialContexts, () => catalog.contextKey(props.owner, props.ownerId))
const available = specs.list
const saved = computed(() => context.data.value?.docs?.map((doc) => doc.id) ?? [])
const selected = ref<string[]>([])
const loading = computed(() => specs.loading.value || context.loading.value)
const busy = ref(false)
const saveError = ref<unknown>()
const error = computed(() => {
  const failure = saveError.value ?? context.error.value ?? specs.error.value
  return failure === undefined ? undefined : describe(failure)
})
const note = ref<string>()

// O salvo chegou (ou mudou): a marcação volta a ele.
watch(
  () => context.data.value,
  () => (selected.value = [...saved.value]),
  { immediate: true },
)

const byId = computed(() => new Map(available.value.map((doc) => [doc.id, doc])))
const weight = computed(() => contextWeight(selected.value, (id) => byId.value.get(id)?.tokens))
/** O peso na conversa: o deste editor mais o que já entra antes (o contexto do projeto, na guia do agente). */
const total = computed(() => {
  const sum = weight.value.total + (props.baseTokens ?? 0)
  return { total: sum, warn: sum > CONTEXT_WARN_TOKENS }
})
const dirty = computed(() => selected.value.join() !== saved.value.join())
watch(weight, (value) => emit('weight', value.total), { immediate: true })
/** As marcadas primeiro, na ordem do prompt; depois as demais, pelo título. */
const ordered = computed(() => [...selected.value.map((id) => byId.value.get(id)).filter((doc): doc is IProjectDoc => !!doc), ...available.value.filter((doc) => !selected.value.includes(doc.id))])

function toggle(id: string) {
  selected.value = selected.value.includes(id) ? selected.value.filter((item) => item !== id) : [...selected.value, id]
}

function move(id: string, step: -1 | 1) {
  const list = [...selected.value]
  const index = list.indexOf(id)
  const other = index + step
  if (index < 0 || other < 0 || other >= list.length) return
  ;[list[index], list[other]] = [list[other], list[index]]
  selected.value = list
}

/** O Salvar de fora grava este editor junto: lança se falhar. */
async function commit(): Promise<void> {
  if (!dirty.value) return
  await save()
  if (saveError.value) throw saveError.value
}
defineExpose({ dirty, commit })

async function save() {
  busy.value = true
  saveError.value = undefined
  note.value = undefined
  try {
    await catalog.saveContext(props.owner, props.ownerId, selected.value)
    note.value = 'Salvo. Vale para as próximas conversas.'
  } catch (failure) {
    saveError.value = failure
  } finally {
    busy.value = false
  }
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}
</script>

<template>
  <section class="flex flex-col gap-3">
    <slot />

    <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
    <p v-if="!loading && !available.length" class="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500">
      Nenhuma Spec ainda. <RouterLink to="/specs/new" class="text-emerald-400 underline underline-offset-2">Criar Spec</RouterLink>.
    </p>

    <ul v-if="available.length" class="flex flex-col divide-y divide-zinc-800 rounded-xl border border-zinc-800">
      <li v-for="doc in ordered" :key="doc.id" class="flex items-center gap-3 px-3 py-2">
        <input type="checkbox" class="accent-emerald-500" :checked="selected.includes(doc.id)" :aria-label="`Carregar ${doc.title} no início`" @change="toggle(doc.id)" />
        <span v-if="selected.includes(doc.id)" class="w-5 shrink-0 text-center font-mono text-xs text-emerald-300">{{ selected.indexOf(doc.id) + 1 }}</span>
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-2">
            <RouterLink :to="`/specs/${doc.id}`" class="truncate text-sm font-medium hover:underline">{{ doc.title }}</RouterLink>
            <span class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px]" :class="doc.projectId ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-800 text-zinc-400'">{{ doc.projectId ? 'projeto' : 'global' }}</span>
          </span>
          <span class="block truncate text-xs text-zinc-500">{{ doc.summary || doc.id }}</span>
        </span>
        <span class="shrink-0 text-xs text-zinc-500 tabular-nums">≈ {{ (doc.tokens ?? 0).toLocaleString('pt-BR') }} tokens</span>
        <span v-if="selected.includes(doc.id)" class="flex shrink-0 text-zinc-400">
          <button type="button" class="grid h-7 w-7 place-items-center rounded-full hover:bg-zinc-800 disabled:opacity-30" :disabled="selected.indexOf(doc.id) === 0" title="Subir" @click="move(doc.id, -1)">↑</button>
          <button type="button" class="grid h-7 w-7 place-items-center rounded-full hover:bg-zinc-800 disabled:opacity-30" :disabled="selected.indexOf(doc.id) === selected.length - 1" title="Descer" @click="move(doc.id, 1)">↓</button>
        </span>
      </li>
    </ul>

    <div class="flex flex-wrap items-center gap-3 text-sm">
      <span :class="total.warn ? 'text-amber-300' : 'text-zinc-400'">
        {{ selected.length }} spec(s) · ≈ {{ weight.total.toLocaleString('pt-BR') }} tokens<template v-if="baseTokens"> · ≈ {{ total.total.toLocaleString('pt-BR') }} com o contexto do projeto</template> em toda conversa
        <template v-if="total.warn"> — acima de {{ CONTEXT_WARN_TOKENS.toLocaleString('pt-BR') }}, fica mais caro</template>
      </span>
      <button v-if="!embedded" type="button" :disabled="busy || !dirty" class="btn btn-primary ml-auto" @click="save">Salvar</button>
      <span v-else-if="dirty" class="ml-auto text-xs text-amber-300">Mudança não salva</span>
    </div>
    <p v-if="note" class="text-sm text-emerald-300">{{ note }}</p>
  </section>
</template>
