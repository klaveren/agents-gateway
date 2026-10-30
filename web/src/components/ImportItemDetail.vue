<script setup lang="ts">
import { computed } from 'vue'
import { tokens } from '@/lib/format'
import { bytesLabel, CATALOG_HINT, CATALOG_LABEL, type IInventoryItem, itemBytes, itemTokens, KIND_LABEL, RECLASSIFY_KINDS, type TInventoryKind } from '@/lib/importer'

/**
 * O DETALHE de um item do inventário: as fontes (caminho, aliases, tamanho, ≈tokens, gerado, segredo — ⛔ nunca o
 * conteúdo), o que ele cita e quem o cita, as notas e o "não traduz" em destaque. Reclassificar vale SÓ NA TELA.
 */
const props = defineProps<{
  item: IInventoryItem
  /** O tipo em vigor na tela (o reclassificado, se houver). */
  kind: TInventoryKind
  /** As chaves dos itens que citam este. */
  citedBy: readonly string[]
  /** As chaves que existem na análise: a citação vira link para o item. */
  known: ReadonlySet<string>
  /** O lote deste agente está sendo montado. */
  planning?: boolean
}>()
const emit = defineEmits<{ select: [key: string]; reclassify: [kind: TInventoryKind | undefined]; close: []; plan: [] }>()

const untranslatable = computed(() => props.item.notes.filter((note) => note.level === 'untranslatable'))
const others = computed(() => props.item.notes.filter((note) => note.level !== 'untranslatable'))
const reclassified = computed(() => props.kind !== props.item.kind)

function onReclassify(event: Event) {
  const value = (event.target as HTMLSelectElement).value as TInventoryKind
  emit('reclassify', value === props.item.kind ? undefined : value)
}
</script>

<template>
  <article class="flex flex-col gap-4 text-sm" data-test="import-detail">
    <header class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <span class="rounded-full border border-zinc-700 px-2 text-[11px] text-zinc-300">{{ KIND_LABEL[kind] }}</span>
          <h2 class="min-w-0 font-mono text-base font-semibold break-all text-zinc-100">{{ item.candidateId }}</h2>
          <span v-if="item.catalog" class="rounded-full border px-2 text-[11px]" :class="item.catalog === 'other-project' ? 'border-rose-500/50 text-rose-200' : 'border-zinc-700 text-zinc-400'" :title="CATALOG_HINT[item.catalog]">{{
            CATALOG_LABEL[item.catalog]
          }}</span>
        </div>
        <p v-if="item.title" class="mt-1 text-zinc-300">{{ item.title }}</p>
        <p class="mt-1 text-xs break-all text-zinc-500">
          <code>{{ item.key }}</code>
          <template v-if="item.parent">
            · de
            <button v-if="known.has(item.parent)" type="button" class="font-mono text-emerald-300 hover:underline" @click="emit('select', item.parent)">{{ item.parent }}</button>
            <code v-else>{{ item.parent }}</code>
          </template>
          · achado por {{ item.detectors.join(', ') }}
        </p>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" title="Fechar o detalhe" @click="emit('close')">Fechar</button>
    </header>

    <section v-if="item.kind === 'agent'" class="flex flex-col gap-1.5 rounded-xl border border-emerald-500/30 px-3 py-2">
      <button type="button" class="btn btn-primary btn-sm self-start" :disabled="planning" data-test="plan" @click="emit('plan')">{{ planning ? 'Montando…' : 'Montar lote' }}</button>
      <p class="text-xs text-zinc-500">O que este agente precisa, em ordem: docs, skills e commands, rules, ele com os triggers, e as permissões por último. Só mostra: nada é gravado.</p>
    </section>

    <section v-if="untranslatable.length" class="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2" data-test="untranslatable">
      <h3 class="text-xs font-semibold tracking-wide text-amber-200 uppercase">Não traduz</h3>
      <p class="text-xs text-amber-100/80">O gateway não tem par para isto: fica de fora da importação ou precisa de decisão à mão.</p>
      <ul class="mt-1.5 flex flex-col gap-1">
        <li v-for="note in untranslatable" :key="note.code + note.text" class="text-amber-50">
          <code class="text-xs text-amber-300">{{ note.code }}</code> {{ note.text }}
        </li>
      </ul>
    </section>

    <section v-if="others.length" class="flex flex-col gap-1">
      <h3 class="text-xs font-medium text-zinc-500">Notas</h3>
      <ul class="flex flex-col gap-1">
        <li v-for="note in others" :key="note.code + note.text" class="flex gap-2">
          <span class="mt-0.5 shrink-0 rounded-full px-1.5 text-[10px]" :class="note.level === 'attention' ? 'bg-amber-500/15 text-amber-200' : 'bg-zinc-800 text-zinc-400'">{{
            note.level === 'attention' ? 'alerta' : 'info'
          }}</span>
          <span class="min-w-0 break-words text-zinc-300"><code class="text-xs text-zinc-500">{{ note.code }}</code> {{ note.text }}</span>
        </li>
      </ul>
    </section>

    <section class="flex flex-col gap-1.5">
      <h3 class="text-xs font-medium text-zinc-500">
        Fontes ({{ item.sources.length }}) · {{ bytesLabel(itemBytes(item)) }} · ≈{{ tokens(itemTokens(item)) }} tokens
      </h3>
      <p v-if="!item.sources.length" class="text-xs text-zinc-500">Sem arquivo próprio.</p>
      <ul v-else class="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
        <li v-for="source in item.sources" :key="source.path" class="flex flex-col gap-0.5 px-3 py-2">
          <div class="flex flex-wrap items-center gap-2">
            <code class="min-w-0 text-xs break-all text-zinc-200">{{ source.path }}</code>
            <span v-if="source.role" class="rounded-full border border-zinc-700 px-1.5 text-[10px] text-zinc-400">{{ source.role }}</span>
            <span v-if="source.generated" class="rounded-full border border-sky-500/40 px-1.5 text-[10px] text-sky-200" title="O cabeçalho diz que o arquivo é gerado">gerado</span>
            <span v-if="source.secret" class="rounded-full border border-rose-500/50 px-1.5 text-[10px] text-rose-200" title="Bateu na máscara de segredos: só a versão mascarada é lida">segredo</span>
          </div>
          <p class="text-xs text-zinc-500">
            {{ bytesLabel(source.bytes) }} · ≈{{ tokens(source.tokens) }} tokens · <span :title="source.sha256">sha256 {{ source.sha256.slice(0, 12) }}</span>
          </p>
          <p v-if="source.aliases.length" class="text-xs break-all text-zinc-500">também em: <code v-for="alias in source.aliases" :key="alias" class="mr-2">{{ alias }}</code></p>
          <p v-if="source.generated" class="text-xs break-all text-zinc-500">
            gerado de:
            <template v-if="source.generated.length"><code v-for="origin in source.generated" :key="origin" class="mr-2">{{ origin }}</code></template>
            <template v-else>(o cabeçalho não diz)</template>
          </p>
        </li>
      </ul>
    </section>

    <section class="flex flex-col gap-1.5">
      <h3 class="text-xs font-medium text-zinc-500">Cita ({{ item.refs.length + item.unresolved.length }})</h3>
      <p v-if="!item.refs.length && !item.unresolved.length" class="text-xs text-zinc-500">Nenhuma citação.</p>
      <ul v-if="item.refs.length" class="flex flex-col gap-0.5">
        <li v-for="ref in item.refs" :key="ref.path" class="text-xs break-all text-zinc-300">
          <code>{{ ref.path }}</code>
          <template v-if="ref.item">
            →
            <button v-if="known.has(ref.item)" type="button" class="font-mono text-emerald-300 hover:underline" @click="emit('select', ref.item)">{{ ref.item }}</button>
            <code v-else>{{ ref.item }}</code>
          </template>
        </li>
      </ul>
      <div v-if="item.unresolved.length" class="flex flex-col gap-0.5" data-test="unresolved">
        <p class="text-xs text-rose-300">Não resolvidas (referência quebrada):</p>
        <code v-for="path in item.unresolved" :key="path" class="text-xs break-all text-rose-200">{{ path }}</code>
      </div>
    </section>

    <section class="flex flex-col gap-1.5">
      <h3 class="text-xs font-medium text-zinc-500">Citado por ({{ citedBy.length }})</h3>
      <p v-if="!citedBy.length" class="text-xs text-zinc-500">Ninguém da análise cita este item.</p>
      <ul v-else class="flex flex-wrap gap-x-3 gap-y-0.5">
        <li v-for="key in citedBy" :key="key">
          <button type="button" class="font-mono text-xs text-emerald-300 hover:underline" @click="emit('select', key)">{{ key }}</button>
        </li>
      </ul>
    </section>

    <section class="flex flex-col gap-1.5 rounded-xl border border-zinc-800 px-3 py-2">
      <label class="field">
        Reclassificar
        <select class="input" :value="kind" data-test="reclassify" @change="onReclassify">
          <option v-for="option in RECLASSIFY_KINDS" :key="option" :value="option">{{ KIND_LABEL[option] }}{{ option === item.kind ? ' (detectado)' : '' }}</option>
        </select>
      </label>
      <p class="text-xs text-zinc-500">
        Vale só para esta análise, nesta tela: nada é gravado, e analisar de novo volta ao tipo detectado.
        <button v-if="reclassified" type="button" class="text-emerald-300 hover:underline" @click="emit('reclassify', undefined)">Voltar a {{ KIND_LABEL[item.kind] }}</button>
      </p>
    </section>
  </article>
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
