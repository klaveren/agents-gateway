<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { useProjectsStore } from '@/stores/projects'
  import ConfirmDialog from './ConfirmDialog.vue'

  /**
   * 🖥️ ESTE agente é de máquina no projeto? A mesma lista de Projeto → Configurações (`IProject.machineAgents`), daqui do
   * cadastro. Vale na hora (fora do Salvar da tela); ligar pede confirmação, desligar não. Só com o sistema permitindo.
   */
  const props = defineProps<{ projectId: string; agentId: string }>()
  const projects = useProjectsStore()
  const marked = computed(() => projects.list.find((item) => item.id === props.projectId)?.machineAgents ?? [])
  const on = computed(() => marked.value.includes(props.agentId))
  const confirming = ref(false)
  const busy = ref(false)
  const error = ref<string>()

  async function set(value: boolean): Promise<void> {
    busy.value = true
    error.value = undefined
    try {
      const others = marked.value.filter((id) => id !== props.agentId)
      await projects.setMachineAgents(props.projectId, value ? [...others, props.agentId] : others)
      confirming.value = false
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      busy.value = false
    }
  }
</script>

<template>
  <div class="flex flex-col gap-2 rounded-xl border p-3 text-sm" :class="on ? 'border-amber-500/40 bg-amber-500/10' : 'border-zinc-800'" data-test="machine-toggle">
    <div class="flex flex-wrap items-center gap-2">
      <strong class="font-medium text-zinc-100">Agente de máquina</strong>
      <span class="rounded-full px-2 py-0.5 text-xs" :class="on ? 'bg-amber-500/20 text-amber-200' : 'bg-zinc-800 text-zinc-300'" data-test="machine-state">
        {{ on ? 'Fora do cerco do projeto' : 'No cerco do projeto' }}
      </span>
      <button v-if="on" type="button" class="btn btn-sm btn-secondary ml-auto" :disabled="busy" data-test="machine-off" @click="set(false)">Voltar ao cerco</button>
      <button v-else type="button" class="btn btn-sm btn-secondary ml-auto" :disabled="busy" data-test="machine-on" @click="confirming = true">Tornar de máquina</button>
    </div>
    <p class="text-xs text-zinc-400">
      Faz o que você faria no terminal desta máquina, neste projeto: lê e grava tudo o que o usuário do gateway pode e usa a rede sem regra. Os dados do gateway e os segredos
      seguem fechados. Vale na hora, sem o Salvar.
    </p>
    <p v-if="error" class="text-xs text-rose-300" role="alert">{{ error }}</p>
    <ConfirmDialog
      :open="confirming"
      title="Tornar este agente de máquina?"
      message="Os comandos deste agente, neste projeto, passam a rodar fora do cerco do projeto: tudo o que o usuário do gateway lê e grava nesta máquina, e a rede sem regra. Os dados do gateway e os segredos seguem fechados."
      action="Tornar de máquina"
      :busy="busy"
      @confirm="set(true)"
      @cancel="confirming = false"
    />
  </div>
</template>
