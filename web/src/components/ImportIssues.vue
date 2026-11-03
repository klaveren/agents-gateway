<script setup lang="ts">
import { ref } from 'vue'
import type { IImportIssue } from '@/lib/types'

/**
 * OS PROBLEMAS DA IMPORTAÇÃO de um artefato (doc, skill, command, agente): o que a importação registrou nele em vez de
 * bloquear a gravação — o vínculo quebrado ficou de fora, e a citação continua no texto. "Resolvido" tira um (a
 * revisão vai para o histórico); `link-pending` e `skill-missing` saem sozinhos quando o alvo é importado.
 *
 * ⚖️ Quem grava é a store (`resolve` devolve a promessa da gravação): a tela só mostra e espera.
 */
const props = defineProps<{ issues?: IImportIssue[]; resolve: (issue: IImportIssue) => Promise<unknown> }>()

const busy = ref<string>()
const error = ref<string>()
const keyOf = (issue: IImportIssue) => `${issue.code}/${issue.target ?? ''}`

async function resolved(issue: IImportIssue) {
  busy.value = keyOf(issue)
  error.value = undefined
  try {
    await props.resolve(issue)
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    busy.value = undefined
  }
}
</script>

<template>
  <section v-if="issues?.length" class="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm" data-test="import-issues">
    <p class="font-medium text-amber-200">Problemas da importação ({{ issues.length }})</p>
    <p class="text-xs text-zinc-400">
      Não impediram a gravação: o vínculo quebrado ficou de fora, e a citação continua no texto. Corrija e marque como resolvido — um agente pode fazer isso com
      <code>resolve_import_issue</code>.
    </p>
    <ul class="flex flex-col gap-1.5">
      <li v-for="issue in issues" :key="keyOf(issue)" class="flex flex-wrap items-center gap-2" data-test="import-issue">
        <span class="min-w-0 flex-1 text-zinc-200">{{ issue.message }}</span>
        <code class="text-[10px] text-zinc-500">{{ issue.code }}</code>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="!!busy" data-test="import-issue-resolve" @click="resolved(issue)">
          {{ busy === keyOf(issue) ? 'Gravando…' : 'Resolvido' }}
        </button>
      </li>
    </ul>
    <p v-if="error" class="text-xs text-rose-300" data-test="import-issues-error">{{ error }}</p>
  </section>
</template>
