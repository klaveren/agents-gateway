<script setup lang="ts">
import { computed, ref } from 'vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import type { IImportIssue, TImportIssueMatch } from '@/lib/types'
import { isPendingIssue } from '@/stores/docs'

/**
 * OS PROBLEMAS DA IMPORTAÇÃO de um artefato (doc, skill, command, agente): o que a importação registrou nele em vez de
 * bloquear a gravação — o vínculo quebrado ficou de fora, e a citação continua no texto. "Resolvido" tira um (a
 * revisão vai para o histórico). Os PENDENTES (`link-pending`, `skill-missing`, `delegate-missing`…) saem sozinhos
 * quando o alvo é importado; neles o botão é "Descartar" — tira o problema e esquece o que ficou guardado (o vínculo,
 * a regra do agente): nada volta depois. "Descartar todos os pendentes" faz isso numa gravação só, com confirmação.
 *
 * ⚖️ Quem grava é a store (`resolve` devolve a promessa da gravação): a tela só mostra e espera.
 */
const props = defineProps<{ issues?: IImportIssue[]; resolve: (match: TImportIssueMatch) => Promise<unknown> }>()

const busy = ref<string>()
const error = ref<string>()
const confirmAll = ref(false)
const keyOf = (issue: IImportIssue) => `${issue.code}/${issue.target ?? ''}`
const pendingCount = computed(() => (props.issues ?? []).filter(isPendingIssue).length)

async function run(key: string, match: TImportIssueMatch) {
  busy.value = key
  error.value = undefined
  try {
    await props.resolve(match)
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    busy.value = undefined
  }
}

async function discardAll() {
  await run('pending', { pending: true })
  confirmAll.value = false
}
</script>

<template>
  <section v-if="issues?.length" class="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm" data-test="import-issues">
    <div class="flex flex-wrap items-center gap-2">
      <p class="flex-1 font-medium text-amber-200">Problemas da importação ({{ issues.length }})</p>
      <button v-if="pendingCount" type="button" class="btn btn-ghost btn-sm" :disabled="!!busy" data-test="import-issues-discard-all" @click="confirmAll = true">
        Descartar todos os pendentes
      </button>
    </div>
    <p class="text-xs text-zinc-400">
      Não impediram a gravação: o vínculo quebrado ficou de fora, e a citação continua no texto. Corrija e marque como resolvido — um agente pode fazer isso com
      <code>resolve_import_issue</code>. O pendente volta sozinho quando o alvo for importado; descartado, não volta mais.
    </p>
    <ul class="flex flex-col gap-1.5">
      <li v-for="issue in issues" :key="keyOf(issue)" class="flex flex-wrap items-center gap-2" data-test="import-issue">
        <span class="min-w-0 flex-1 text-zinc-200">{{ issue.message }}</span>
        <code class="text-[10px] text-zinc-500">{{ issue.code }}</code>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="!!busy" data-test="import-issue-resolve" @click="run(keyOf(issue), issue)">
          {{ busy === keyOf(issue) ? 'Gravando…' : isPendingIssue(issue) ? 'Descartar' : 'Resolvido' }}
        </button>
      </li>
    </ul>
    <p v-if="error" class="text-xs text-rose-300" data-test="import-issues-error">{{ error }}</p>
    <ConfirmDialog
      :open="confirmAll"
      title="Descartar todos os pendentes?"
      :message="`${pendingCount} problema(s) pendente(s) saem, e o que eles guardavam (vínculos, regras do agente) é esquecido: não volta quando o alvo for importado.`"
      action="Descartar"
      busy-label="Descartando…"
      :busy="busy === 'pending'"
      @confirm="discardAll"
      @cancel="confirmAll = false"
    />
  </section>
</template>
