<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import { routerKey } from 'vue-router'
import { fullTime } from '@/lib/format'
import { type IImportDraftView, type IImportReviewView, LINK_LABEL, missingOks, OP_LABEL, opSummary } from '@/lib/importDraft'
import type { TImportItemState } from '@/lib/importer'

/**
 * A REVISÃO MÍNIMA do rascunho de importação: os metadados, as operações (as REMOÇÕES em destaque, cada uma com a sua
 * caixa de OK), os vínculos e o diff fonte × final, por fonte. Aprovar exige OK em toda remoção; "pedir ajuste" volta o
 * item ao construtor com um comentário para a conversa.
 *
 * ⛔ Aprovar não grava no catálogo (é do L5): só muda o estado do item.
 */
const props = defineProps<{
  draft: IImportDraftView
  state: TImportItemState
  review?: IImportReviewView
  approvedBy?: string
  approvedAt?: string
  /** A tela da conversa do construtor. */
  conversationLink?: string
  readonly?: boolean
  busy?: boolean
  error?: string
}>()
const emit = defineEmits<{ approve: [oks: number[]]; adjust: [comment: string] }>()

const router = inject(routerKey, null)
/** Abre a conversa pela navegação da tela (sem recarregar); fora do roteador, pelo endereço. */
function go(path: string) {
  if (router) void router.push(path)
  else window.location.assign(path)
}

const oks = ref(new Set<number>())
const adjusting = ref(false)
const comment = ref('')
// Rascunho novo: os OKs do anterior não valem.
watch(
  () => props.draft.proposedAt,
  () => {
    oks.value = new Set(props.state === 'approved' ? (props.review?.removals ?? []) : [])
    adjusting.value = false
    comment.value = ''
  },
  { immediate: true },
)

const reviewing = computed(() => props.state === 'review' && !props.readonly)
const missing = computed(() => missingOks(props.draft, oks.value))
const removalOf = computed(() => new Map(props.draft.removals.map((removal) => [removal.op, removal])))
const metaEntries = computed(() => Object.entries(props.draft.meta))
const splits = computed(() => props.draft.outputs.filter((output) => output.from === 'split'))
const changed = computed(() => props.draft.diffs.filter((entry) => !entry.diff.equal))

function toggle(op: number, event: Event) {
  const next = new Set(oks.value)
  if ((event.target as HTMLInputElement).checked) next.add(op)
  else next.delete(op)
  oks.value = next
}

function approve() {
  if (missing.value.length) return
  emit('approve', [...oks.value].sort((a, b) => a - b))
}

function sendAdjust() {
  const text = comment.value.trim()
  if (text) emit('adjust', text)
}

function clip(text: string, max = 800): string {
  return text.length > max ? `${text.slice(0, max)}… (+${(text.length - max).toLocaleString('pt-BR')} caracteres)` : text
}
</script>

<template>
  <section class="flex flex-col gap-3 rounded-xl border border-emerald-500/30 px-3 py-2" data-test="import-review">
    <header class="flex flex-wrap items-center gap-2">
      <h3 class="text-xs font-semibold tracking-wide text-emerald-200 uppercase">Rascunho do construtor</h3>
      <span class="text-xs text-zinc-500">{{ fullTime(draft.proposedAt) }}</span>
      <span class="flex-1" />
      <a v-if="conversationLink" :href="conversationLink" class="text-xs text-emerald-300 hover:underline" data-test="conversation-link" @click.prevent="go(conversationLink)">Abrir a conversa</a>
    </header>
    <p class="text-xs text-zinc-500">O texto é a fonte com as operações abaixo, aplicadas e conferidas pelo servidor. Nenhuma operação escreve texto no corpo.</p>

    <p v-if="state === 'drafting' && review?.adjust" class="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-100" data-test="adjust-pending">
      Ajuste pedido por {{ review.adjust.by }}: {{ review.adjust.comment }}
    </p>
    <p v-if="state === 'approved'" class="text-xs text-emerald-200" data-test="approved">
      Aprovado<template v-if="approvedBy"> por {{ approvedBy }}</template><template v-if="approvedAt"> em {{ fullTime(approvedAt) }}</template>. Nada foi ao catálogo ainda.
    </p>

    <div class="flex flex-col gap-1">
      <h4 class="text-xs font-medium text-zinc-500">Metadados</h4>
      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs" data-test="draft-meta">
        <template v-for="[name, value] in metaEntries" :key="name">
          <dt class="text-zinc-500">{{ name }}</dt>
          <dd class="break-words text-zinc-200">{{ value }}</dd>
        </template>
      </dl>
    </div>

    <div v-if="splits.length" class="flex flex-col gap-1" data-test="draft-splits">
      <h4 class="text-xs font-medium text-zinc-500">Vira também ({{ splits.length }})</h4>
      <ul class="flex flex-col gap-0.5 text-xs">
        <li v-for="(output, index) in splits" :key="index" class="text-zinc-300">
          <code>{{ output.meta.id ?? output.meta.title }}</code>
          <template v-if="output.meta.title && output.meta.id"> — {{ output.meta.title }}</template>
        </li>
      </ul>
    </div>

    <div class="flex flex-col gap-1">
      <h4 class="text-xs font-medium text-zinc-500">
        Operações ({{ draft.ops.length }})<template v-if="draft.removals.length"> · {{ draft.removals.length }} remoção(ões) pedem OK</template>
      </h4>
      <ol class="flex flex-col gap-1.5" data-test="draft-ops">
        <li
          v-for="(op, index) in draft.ops"
          :key="index"
          class="flex flex-col gap-1 rounded-lg border px-2 py-1 text-xs"
          :class="op.op === 'remove' ? 'border-rose-500/50 bg-rose-500/10' : 'border-zinc-800'"
          :data-test="op.op === 'remove' ? 'removal' : 'op'"
        >
          <div class="flex flex-wrap items-center gap-2">
            <span class="rounded-full px-1.5 text-[10px]" :class="op.op === 'remove' ? 'bg-rose-500/20 text-rose-100' : 'bg-zinc-800 text-zinc-300'">{{ OP_LABEL[op.op] }}</span>
            <span class="min-w-0 flex-1 break-words text-zinc-200">{{ opSummary(op) }}</span>
            <label v-if="op.op === 'remove'" class="flex items-center gap-1 text-rose-100">
              <input type="checkbox" :checked="oks.has(index)" :disabled="!reviewing || busy" data-test="removal-ok" @change="toggle(index, $event)" />
              OK
            </label>
          </div>
          <template v-if="op.op === 'remove'">
            <p class="text-rose-100/80">Motivo: {{ op.reason }}</p>
            <pre class="max-h-48 overflow-auto rounded bg-zinc-950 px-2 py-1 text-[11px] whitespace-pre-wrap text-rose-200 line-through decoration-rose-500/60">{{ clip(removalOf.get(index)?.text ?? op.text ?? '') }}</pre>
          </template>
        </li>
      </ol>
    </div>

    <div v-if="draft.links.length" class="flex flex-col gap-1">
      <h4 class="text-xs font-medium text-zinc-500">Vínculos no painel</h4>
      <ul class="flex flex-col gap-0.5 text-xs" data-test="draft-links">
        <li v-for="link in draft.links" :key="link.op" class="break-all text-zinc-300">
          <code>{{ link.text }}</code> → <code class="text-emerald-300">{{ link.target }}</code> ({{ LINK_LABEL[link.link] ?? link.link }})
        </li>
      </ul>
    </div>

    <div class="flex flex-col gap-1">
      <h4 class="text-xs font-medium text-zinc-500">Fonte × final</h4>
      <p v-if="!changed.length" class="text-xs text-zinc-500">O texto das fontes não mudou (só metadados).</p>
      <details v-for="entry in changed" :key="entry.source" class="rounded-lg border border-zinc-800 text-xs" open data-test="draft-diff">
        <summary class="cursor-pointer px-2 py-1 text-zinc-300">
          <code class="break-all">{{ entry.source }}</code>
          <span class="ml-2 text-emerald-300">+{{ entry.diff.added }}</span>
          <span class="ml-1 text-rose-300">−{{ entry.diff.removed }}</span>
        </summary>
        <div class="scroll-thin max-h-96 overflow-auto font-mono text-[11px]">
          <div v-for="(hunk, h) in entry.diff.hunks" :key="h" class="border-t border-zinc-800">
            <p class="bg-zinc-900 px-2 text-zinc-500">@@ -{{ hunk.oldStart }},{{ hunk.oldLines }} +{{ hunk.newStart }},{{ hunk.newLines }} @@</p>
            <p
              v-for="(line, l) in hunk.lines"
              :key="l"
              class="px-2 break-all whitespace-pre-wrap"
              :class="line.op === 'add' ? 'bg-emerald-500/10 text-emerald-200' : line.op === 'remove' ? 'bg-rose-500/10 text-rose-200' : 'text-zinc-400'"
              :data-test="`diff-${line.op}`"
            >{{ line.op === 'add' ? '+' : line.op === 'remove' ? '−' : ' ' }}{{ line.text }}</p>
          </div>
        </div>
      </details>
    </div>

    <div v-if="reviewing" class="flex flex-col gap-2 border-t border-zinc-800 pt-2">
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class="btn btn-primary btn-sm" :disabled="busy || missing.length > 0" data-test="approve" @click="approve">Aprovar</button>
        <button type="button" class="btn btn-secondary btn-sm" :disabled="busy" data-test="adjust" @click="adjusting = !adjusting">Pedir ajuste</button>
        <span v-if="missing.length" class="text-xs text-rose-200" data-test="missing">Falta o OK de {{ missing.length }} remoção(ões).</span>
      </div>
      <form v-if="adjusting" class="flex flex-col gap-1.5" @submit.prevent="sendAdjust">
        <textarea v-model="comment" class="input min-h-16 text-xs" rows="3" placeholder="O que o construtor deve mudar" data-test="adjust-comment" />
        <button type="submit" class="btn btn-secondary btn-sm self-start" :disabled="busy || !comment.trim()" data-test="adjust-send">Devolver ao construtor</button>
      </form>
      <p class="text-xs text-zinc-500">Aprovar não grava no catálogo: o item fica aprovado até a gravação pelo catálogo.</p>
    </div>
    <p v-if="error" class="text-xs text-rose-300" data-test="review-error">{{ error }}</p>
  </section>
</template>

<style scoped>
@reference '../style.css';

.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
</style>
