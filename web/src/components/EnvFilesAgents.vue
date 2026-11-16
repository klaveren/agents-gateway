<script setup lang="ts">
  import { computed, ref, watch } from 'vue'
  import { useAgentsStore } from '@/stores/agents'
  import { useProjectsStore } from '@/stores/projects'
  import ConfirmDialog from './ConfirmDialog.vue'

  /**
   * ⚠️ QUAIS AGENTES do projeto leem os `.env`: a única trava do sistema que cede, um agente por vez (o delegado não herda).
   * Marcar e salvar; acrescentar alguém pede confirmação, tirar não. O id que não é mais de agente nenhum aparece para sair.
   */
  const props = defineProps<{ projectId: string }>()
  const projects = useProjectsStore()
  const agents = useAgentsStore()
  const saved = computed(() => projects.list.find((item) => item.id === props.projectId)?.envFileAgents ?? [])
  const chosen = ref<string[]>([])
  watch(saved, (list) => (chosen.value = [...list]), { immediate: true })

  const rows = computed(() => {
    const known = agents.list.map((agent) => ({ id: agent.id, name: agent.name, gone: false }))
    const gone = saved.value.filter((id) => !known.some((agent) => agent.id === id)).map((id) => ({ id, name: id, gone: true }))
    return [...known, ...gone].sort((a, b) => a.name.localeCompare(b.name))
  })
  const added = computed(() => chosen.value.filter((id) => !saved.value.includes(id)))
  const dirty = computed(() => added.value.length > 0 || saved.value.some((id) => !chosen.value.includes(id)))
  const nameOf = (id: string) => rows.value.find((row) => row.id === id)?.name ?? id

  const confirming = ref(false)
  const busy = ref(false)
  const error = ref<string>()

  function toggle(id: string, on: boolean): void {
    chosen.value = on ? [...new Set([...chosen.value, id])] : chosen.value.filter((one) => one !== id)
  }

  function save(): void {
    if (added.value.length) confirming.value = true
    else void persist()
  }

  async function persist(): Promise<void> {
    busy.value = true
    error.value = undefined
    try {
      await projects.setEnvFileAgents(props.projectId, chosen.value)
      confirming.value = false
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      busy.value = false
    }
  }
</script>

<template>
  <div class="flex flex-col gap-2 rounded-xl border p-3 text-sm" :class="saved.length ? 'border-amber-500/40 bg-amber-500/10' : 'border-zinc-800'" data-test="env-files">
    <div class="flex flex-wrap items-center gap-2">
      <strong class="font-medium text-zinc-100">Arquivos .env</strong>
      <span class="rounded-full px-2 py-0.5 text-xs" :class="saved.length ? 'bg-amber-500/20 text-amber-200' : 'bg-zinc-800 text-zinc-300'" data-test="env-files-state">
        {{ saved.length ? `${saved.length} agente(s) leem` : 'Fechados para todos' }}
      </span>
    </div>
    <p class="text-xs text-zinc-400">
      Marque só o agente que precisa subir a aplicação. Só leitura, e os valores aparecem mascarados na conversa; o agente que ele chamar não herda. Gravar
      <code>.env</code>
      , as credenciais do gateway (
      <code>.credentials/</code>
      ), chaves e
      <code>secrets.*</code>
      seguem fechados sempre.
    </p>
    <ul class="flex flex-col gap-1" data-test="env-files-agents">
      <li v-for="row in rows" :key="row.id">
        <label class="flex items-center gap-2 text-zinc-200">
          <input type="checkbox" :checked="chosen.includes(row.id)" :data-agent="row.id" @change="toggle(row.id, ($event.target as HTMLInputElement).checked)" />
          <span>{{ row.name }}</span>
          <code class="text-xs text-zinc-500">{{ row.id }}</code>
          <span v-if="row.gone" class="text-xs text-amber-200">agente removido — desmarque</span>
        </label>
      </li>
      <li v-if="!rows.length" class="text-xs text-zinc-500">Nenhum agente neste projeto.</li>
    </ul>
    <p v-if="error" class="text-xs text-rose-300" role="alert">{{ error }}</p>
    <div class="flex justify-end">
      <button type="button" class="btn btn-sm btn-primary" :disabled="!dirty || busy" data-test="env-files-save" @click="save">{{ busy ? 'Salvando…' : 'Salvar' }}</button>
    </div>
    <ConfirmDialog
      :open="confirming"
      :title="`Deixar ${added.map(nameOf).join(', ')} ler os .env?`"
      message="Os comandos desses agentes, neste projeto, passam a ler os arquivos .env (só leitura) e os valores ficam mascarados na conversa. Um agente determinado ainda consegue contornar a máscara: use em projeto de desenvolvimento, com credenciais de desenvolvimento."
      action="Deixar ler"
      :busy="busy"
      @confirm="persist"
      @cancel="confirming = false"
    />
  </div>
</template>
