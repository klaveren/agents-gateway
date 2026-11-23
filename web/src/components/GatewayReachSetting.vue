<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { useSettingsStore } from '@/stores/settings'
  import ConfirmDialog from './ConfirmDialog.vue'

  /**
   * 🔌 "Agentes alcançam a API deste gateway" (só o admin do gateway): ligado, a porta HTTP do gateway deixa de ser negada
   * sempre aos comandos dos agentes e passa a valer como qualquer serviço local, só com a regra de rede exata
   * `localhost:<porta>`. Vale na hora (fora do Salvar da tela); ligar pede confirmação, desligar não.
   */
  const settings = useSettingsStore()
  const on = computed(() => settings.current?.agentsReachGatewayApi === true)
  const confirming = ref(false)
  const busy = ref(false)
  const error = ref<string>()

  async function set(value: boolean): Promise<void> {
    busy.value = true
    error.value = undefined
    try {
      await settings.save({ agentsReachGatewayApi: value })
      confirming.value = false
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
    :class="on ? 'border-amber-500/40 bg-amber-500/10' : 'border-zinc-800 bg-zinc-900/50'"
    data-test="gateway-reach-setting"
  >
    <div class="flex flex-wrap items-center gap-2">
      <h2 class="font-medium">Agentes alcançam a API deste gateway</h2>
      <span class="rounded-full px-2 py-0.5 text-xs" :class="on ? 'bg-amber-500/20 text-amber-200' : 'bg-zinc-800 text-zinc-300'" data-test="gateway-reach-state">
        {{ on ? 'Permitido' : 'Desligado' }}
      </span>
      <button v-if="on" type="button" class="btn btn-sm btn-secondary ml-auto" :disabled="busy" data-test="gateway-reach-off" @click="set(false)">Desligar</button>
      <button v-else type="button" class="btn btn-sm btn-secondary ml-auto" :disabled="busy" data-test="gateway-reach-on" @click="confirming = true">Permitir</button>
    </div>
    <p class="text-xs text-zinc-400">
      Desligado (o padrão), os comandos dos agentes, e os processos que eles sobem, não alcançam a porta HTTP deste gateway, nem com regra de rede. Ligado, ela passa a valer como
      qualquer serviço local: só com a regra exata
      <code>localhost:&lt;porta&gt;</code>
      nas regras de rede do agente ou do projeto. Serve para a API do projeto que o agente sobe e que precisa chamar este gateway com o token dela. A porta do portão de rede segue
      sempre fechada.
    </p>
    <p v-if="error" class="text-xs text-rose-300" role="alert">{{ error }}</p>
    <ConfirmDialog
      :open="confirming"
      title="Permitir que agentes alcancem a API deste gateway?"
      message="Com uma regra de rede exata para a porta deste gateway, o agente e os processos que ele sobe passam a chamar a API daqui com o token que tiverem. A porta do portão de rede segue fechada."
      action="Permitir"
      :busy="busy"
      @confirm="set(true)"
      @cancel="confirming = false"
    />
  </section>
</template>
