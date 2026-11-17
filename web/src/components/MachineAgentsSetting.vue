<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { machineAgentsOn } from '@/lib/machine'
  import { useProjectsStore } from '@/stores/projects'
  import { useSettingsStore } from '@/stores/settings'
  import ConfirmDialog from './ConfirmDialog.vue'

  /**
   * 🖥️ "Permitir agentes de máquina" (só o admin do gateway): ligar só torna a marcação possível; ninguém ganha nada até o
   * admin de um projeto marcar um agente. Desligar devolve todos ao cerco na hora, e a marcação fica guardada. Vale na hora
   * (fora do Salvar da tela); ligar pede confirmação, desligar não.
   */
  const settings = useSettingsStore()
  const projects = useProjectsStore()
  const on = computed(() => settings.current?.machineAgents === true)
  const locked = computed(() => settings.current?.deployment?.machineAgentsLocked === true)
  const confirming = ref(false)
  const busy = ref(false)
  const error = ref<string>()

  async function set(value: boolean): Promise<void> {
    busy.value = true
    error.value = undefined
    try {
      await settings.save({ machineAgents: value })
      machineAgentsOn.value = value
      confirming.value = false
      // A lista dos projetos traz (ou deixa de trazer) quem é de máquina.
      await projects.load().catch(() => undefined)
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      busy.value = false
    }
  }
</script>

<template>
  <section
    class="flex flex-col gap-3 rounded-2xl border p-5"
    :class="on && !locked ? 'border-amber-500/40 bg-amber-500/10' : 'border-zinc-800 bg-zinc-900/50'"
    data-test="machine-agents-setting"
  >
    <div class="flex flex-wrap items-center gap-2">
      <h2 class="font-medium">Agentes de máquina</h2>
      <span class="rounded-full px-2 py-0.5 text-xs" :class="on && !locked ? 'bg-amber-500/20 text-amber-200' : 'bg-zinc-800 text-zinc-300'" data-test="machine-agents-state">
        {{ locked ? 'Travado pelo deploy' : on ? 'Permitidos' : 'Desligados' }}
      </span>
      <template v-if="!locked">
        <button v-if="on" type="button" class="btn btn-sm btn-secondary ml-auto" :disabled="busy" data-test="machine-agents-off" @click="set(false)">Desligar</button>
        <button v-else type="button" class="btn btn-sm btn-secondary ml-auto" :disabled="busy" data-test="machine-agents-on" @click="confirming = true">Permitir</button>
      </template>
    </div>
    <p class="text-xs text-zinc-400">
      O agente de máquina faz o que você faria no terminal desta máquina: lê e grava tudo o que o usuário do gateway pode, e usa a rede sem regra. Os dados do gateway e os segredos
      (
      <code>.env</code>
      , chaves) seguem fechados. Ligar aqui não muda nenhum agente: quem administra o projeto marca, um por um, em Projeto → Configurações. Desligar devolve todos ao cerco na hora.
    </p>
    <p v-if="locked" class="text-xs text-zinc-400">
      A variável
      <code>MACHINE_AGENTS=off</code>
      do deploy desliga o modo neste servidor.
    </p>
    <p v-if="error" class="text-xs text-rose-300" role="alert">{{ error }}</p>
    <ConfirmDialog
      :open="confirming"
      title="Permitir agentes de máquina?"
      message="Quem administra um projeto passa a poder marcar agentes que rodam fora do cerco do projeto, com tudo o que o usuário do gateway lê e grava nesta máquina. Os dados do gateway e os segredos seguem fechados."
      action="Permitir"
      :busy="busy"
      @confirm="set(true)"
      @cancel="confirming = false"
    />
  </section>
</template>
