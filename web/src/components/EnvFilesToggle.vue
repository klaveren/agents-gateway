<script setup lang="ts">
import { computed, ref } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import ConfirmDialog from './ConfirmDialog.vue'

/**
 * ⚠️ A LEITURA DOS `.env` por ESTE agente, no projeto: a única trava do sistema que cede, porque o ambiente de desenvolvimento
 * precisa deles para subir a aplicação. Por agente — o delegado não herda. Vale na hora (fora do Salvar da tela); ligar pede
 * confirmação, fechar não.
 */
const props = defineProps<{ projectId: string; agentId: string }>()
const projects = useProjectsStore()
const allowed = computed(() => projects.list.find((item) => item.id === props.projectId)?.envFileAgents ?? [])
const open = computed(() => allowed.value.includes(props.agentId))
const confirming = ref(false)
const busy = ref(false)
const error = ref<string>()

async function set(read: boolean): Promise<void> {
  busy.value = true
  error.value = undefined
  try {
    const others = allowed.value.filter((id) => id !== props.agentId)
    await projects.setEnvFileAgents(props.projectId, read ? [...others, props.agentId] : others)
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
        {{ open ? 'Este agente lê' : 'Fechados' }}
      </span>
      <button v-if="open" type="button" class="btn btn-sm btn-secondary ml-auto" :disabled="busy" data-test="env-files-close" @click="set(false)">Fechar de novo</button>
      <button v-else type="button" class="btn btn-sm btn-secondary ml-auto" :disabled="busy" data-test="env-files-open" @click="confirming = true">
        Deixar este agente ler
      </button>
    </div>
    <p class="text-xs text-zinc-400">
      Para o agente subir a aplicação, que lê os <code>.env</code>. Só neste projeto, só leitura, e os valores aparecem mascarados na conversa. Vale na hora, sem o Salvar. O
      agente que ele chamar não herda.
    </p>
    <p v-if="error" class="text-xs text-rose-300" role="alert">{{ error }}</p>
    <ConfirmDialog
      :open="confirming"
      title="Deixar este agente ler os .env?"
      message="Os comandos deste agente, neste projeto, passam a ler os arquivos .env (só leitura) e os valores ficam mascarados na conversa. Um agente determinado ainda consegue contornar a máscara: use em projeto de desenvolvimento, com credenciais de desenvolvimento."
      action="Deixar ler"
      :busy="busy"
      @confirm="set(true)"
      @cancel="confirming = false"
    />
  </div>
</template>
