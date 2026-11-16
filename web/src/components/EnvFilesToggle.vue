<script setup lang="ts">
import { computed, ref } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import ConfirmDialog from './ConfirmDialog.vue'

/**
 * ⚠️ A LEITURA DOS `.env` pelos agentes do projeto: a única trava do sistema que cede, porque o ambiente de desenvolvimento
 * precisa deles para subir a aplicação. Ligar pede confirmação; fechar, não.
 */
const props = defineProps<{ projectId: string }>()
const projects = useProjectsStore()
const project = computed(() => projects.list.find((item) => item.id === props.projectId))
const open = computed(() => project.value?.readEnvFiles === true)
const confirming = ref(false)
const busy = ref(false)
const error = ref<string>()

async function set(read: boolean): Promise<void> {
  busy.value = true
  error.value = undefined
  try {
    await projects.setEnvFiles(props.projectId, read)
    confirming.value = false
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-2 rounded-xl border p-3 text-sm" :class="open ? 'border-amber-500/40 bg-amber-500/10' : 'border-zinc-800'" data-test="env-files">
    <div class="flex flex-wrap items-center gap-2">
      <strong class="font-medium text-zinc-100">Arquivos .env</strong>
      <span class="rounded-full px-2 py-0.5 text-xs" :class="open ? 'bg-amber-500/20 text-amber-200' : 'bg-zinc-800 text-zinc-300'" data-test="env-files-state">
        {{ open ? 'Os agentes leem' : 'Fechados' }}
      </span>
      <button v-if="open" type="button" class="btn btn-sm btn-secondary ml-auto" :disabled="busy" data-test="env-files-close" @click="set(false)">Fechar de novo</button>
      <button v-else type="button" class="btn btn-sm btn-secondary ml-auto" :disabled="busy" data-test="env-files-open" @click="confirming = true">
        Deixar os agentes lerem
      </button>
    </div>
    <p class="text-xs text-zinc-400">
      Para o agente subir a aplicação, que lê os <code>.env</code>. Só leitura, e os valores aparecem mascarados na conversa. Gravar <code>.env</code>, as credenciais do
      gateway (<code>.credentials/</code>), chaves e <code>secrets.*</code> seguem fechados sempre.
    </p>
    <p v-if="error" class="text-xs text-rose-300" role="alert">{{ error }}</p>
    <ConfirmDialog
      :open="confirming"
      title="Deixar os agentes deste projeto lerem os .env?"
      message="Os comandos do agente passam a ler os arquivos .env (só leitura) e os valores ficam mascarados na conversa. Um agente determinado ainda consegue contornar a máscara: use em projeto de desenvolvimento, com credenciais de desenvolvimento."
      action="Deixar ler"
      :busy="busy"
      @confirm="set(true)"
      @cancel="confirming = false"
    />
  </div>
</template>
