<script setup lang="ts">
  import { computed, ref, watch } from 'vue'
  import { useAgentsStore } from '@/stores/agents'
  import { useProjectsStore } from '@/stores/projects'
  import ConfirmDialog from './ConfirmDialog.vue'

  /**
   * 🖥️ QUAIS AGENTES do projeto são de máquina (ver `IProject.machineAgents`): rodam no cerco aberto. Marcar e salvar;
   * acrescentar alguém pede confirmação, tirar não. Só aparece com "Permitir agentes de máquina" ligado no sistema.
   */
  const props = defineProps<{ projectId: string }>()
  const projects = useProjectsStore()
  const agents = useAgentsStore()
  const saved = computed(() => projects.list.find((item) => item.id === props.projectId)?.machineAgents ?? [])
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
      await projects.setMachineAgents(props.projectId, chosen.value)
      confirming.value = false
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      busy.value = false
    }
  }
</script>

<template>
  <div class="flex flex-col gap-2 rounded-xl border p-3 text-sm" :class="saved.length ? 'border-amber-500/40 bg-amber-500/10' : 'border-zinc-800'" data-test="machine-agents">
    <p class="text-xs text-zinc-400">
      O agente de máquina faz o que você faria no terminal: lê e grava tudo o que o usuário do gateway pode, fora da pasta do projeto, e usa a rede sem regra. Uma regra de negar
      ainda vale. Os dados do gateway e os segredos (
      <code>.env</code>
      , chaves) seguem fechados. O agente que ele chamar não herda.
    </p>
    <ul class="flex flex-col gap-1" data-test="machine-agents-list">
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
      <button type="button" class="btn btn-sm btn-primary" :disabled="!dirty || busy" data-test="machine-agents-save" @click="save">{{ busy ? 'Salvando…' : 'Salvar' }}</button>
    </div>
    <ConfirmDialog
      :open="confirming"
      :title="`Tornar ${added.map(nameOf).join(', ')} de máquina?`"
      message="Os comandos desses agentes, neste projeto, passam a rodar fora do cerco do projeto: tudo o que o usuário do gateway lê e grava nesta máquina, e a rede sem regra. Os dados do gateway e os segredos seguem fechados."
      action="Tornar de máquina"
      :busy="busy"
      @confirm="persist"
      @cancel="confirming = false"
    />
  </div>
</template>
