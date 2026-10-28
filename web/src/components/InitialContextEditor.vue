<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api } from '@/lib/api'
import { CONTEXT_WARN_TOKENS, contextWeight, GLOBAL_SCOPE } from '@/lib/guidance'
import type { IInitialContext, IProjectDoc } from '@/lib/types'

/**
 * O editor de um CONTEXTO INICIAL — o do projeto ou o de um agente: as specs que vão INTEIRAS no prompt, na ordem
 * marcada. `endpoint` é a rota (`/projects/:id/initial-context`, `/agents/:id/initial-context`); `projectId`, de que
 * projeto vêm as specs além das globais (ausente = só as globais); `baseTokens`, o que já entra antes (o do projeto,
 * na guia do agente), para o peso mostrar o total da conversa.
 */
const props = defineProps<{ endpoint: string; projectId?: string; baseTokens?: number }>()
/** O peso das marcadas (o que já está na lista, salvo ou não): quem embute mostra o total da conversa. */
const emit = defineEmits<{ weight: [tokens: number] }>()

const available = ref<IProjectDoc[]>([])
const selected = ref<string[]>([])
const saved = ref<string[]>([])
const loading = ref(false)
const busy = ref(false)
const error = ref<string>()
const note = ref<string>()

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

watch(() => [props.endpoint, props.projectId], load, { immediate: true })

async function load() {
  loading.value = true
  error.value = undefined
  note.value = undefined
  try {
    const [globals, local, context] = await Promise.all([
      api<IProjectDoc[]>('/docs', { query: { project: GLOBAL_SCOPE, kind: 'spec' } }),
      props.projectId ? api<IProjectDoc[]>('/docs', { query: { project: props.projectId, kind: 'spec' } }) : Promise.resolve([]),
      api<IInitialContext>(props.endpoint),
    ])
    available.value = [...local, ...globals]
    saved.value = context.docs.map((doc) => doc.id)
    selected.value = [...saved.value]
  } catch (failure) {
    error.value = describe(failure)
  } finally {
    loading.value = false
  }
}

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

async function save() {
  busy.value = true
  error.value = undefined
  note.value = undefined
  try {
    const result = await api<IInitialContext>(props.endpoint, { method: 'PUT', body: { docIds: selected.value } })
    saved.value = result.docs.map((doc) => doc.id)
    selected.value = [...saved.value]
    note.value = 'Contexto inicial salvo. Vale para as conversas que começarem agora.'
  } catch (failure) {
    error.value = describe(failure)
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
      Nenhuma spec que possa entrar aqui ainda. <RouterLink to="/specs/new" class="text-emerald-400 underline underline-offset-2">Criar uma spec</RouterLink>.
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
        <template v-if="total.warn"> — acima de {{ CONTEXT_WARN_TOKENS.toLocaleString('pt-BR') }}, pesa no custo e no contexto de cada conversa</template>
      </span>
      <button type="button" :disabled="busy || !dirty" class="ml-auto rounded-full bg-emerald-500 px-4 py-1.5 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-40" @click="save">Salvar</button>
    </div>
    <p v-if="note" class="text-sm text-emerald-300">{{ note }}</p>
  </section>
</template>
