<script setup lang="ts">
  import { onBeforeUnmount, ref, watch } from 'vue'
  import { api } from '@/lib/api'

  interface IHostApproval {
    id: string
    agentId?: string
    command: string
    reason: string
    password: boolean
    expiresAt: string
  }

  /**
   * 🖥️ Os pedidos do AGENTE DE MÁQUINA desta conversa: o comando que o cerco sempre recusa (o `sudo`, o que apaga ou desliga a
   * máquina) espera a pessoa aqui. Aprovado, roda fora do cerco; o `sudo` leva a senha digitada, que vai direto para ele e não
   * fica em lugar nenhum. Lidos enquanto o turno roda (o comando espera até 5 minutos).
   */
  const props = defineProps<{ sessionId?: string; running: boolean }>()
  const list = ref<IHostApproval[]>([])
  const passwords = ref<Record<string, string>>({})
  const busy = ref<string>()
  const error = ref<string>()
  let timer: ReturnType<typeof setInterval> | undefined

  async function load(): Promise<void> {
    if (!props.sessionId) return void (list.value = [])
    list.value = await api<IHostApproval[]>(`/sessions/${encodeURIComponent(props.sessionId)}/host-approvals`).catch(() => list.value)
  }

  watch(
    () => [props.sessionId, props.running] as const,
    ([, running]) => {
      if (timer) clearInterval(timer)
      timer = undefined
      void load()
      if (running) timer = setInterval(() => void load(), 2000)
    },
    { immediate: true },
  )
  onBeforeUnmount(() => timer && clearInterval(timer))

  async function answer(item: IHostApproval, approve: boolean): Promise<void> {
    busy.value = item.id
    error.value = undefined
    try {
      const password = approve && item.password ? passwords.value[item.id] : undefined
      await api(`/sessions/${encodeURIComponent(props.sessionId!)}/host-approvals/${encodeURIComponent(item.id)}`, {
        method: 'POST',
        body: { approve, ...(password ? { password } : {}) },
      })
      list.value = list.value.filter((one) => one.id !== item.id)
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      // ⛔ A senha não fica na tela depois de mandada (nem recusada).
      delete passwords.value[item.id]
      busy.value = undefined
    }
  }
</script>

<template>
  <div v-if="list.length" class="flex flex-col gap-2 border-t border-amber-500/30 bg-amber-500/10 px-4 py-3" data-test="host-approvals">
    <form v-for="item in list" :key="item.id" class="flex flex-col gap-2 text-sm" data-test="host-approval" @submit.prevent="answer(item, true)">
      <p class="text-amber-100">
        <strong class="font-medium">{{ item.agentId ?? 'O agente' }}</strong>
        quer rodar fora do cerco ({{ item.reason }}). Aprovado, roda como você no terminal desta máquina.
      </p>
      <pre class="max-h-40 overflow-auto rounded-lg bg-zinc-950 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-zinc-100">{{ item.command }}</pre>
      <label v-if="item.password" class="flex flex-col gap-1 text-xs text-zinc-300">
        Senha desta máquina (vai direto para o sudo; não fica guardada nem aparece para o agente)
        <input
          v-model="passwords[item.id]"
          type="password"
          autocomplete="off"
          required
          class="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
          data-test="host-approval-password"
        />
      </label>
      <div class="flex gap-2">
        <button type="submit" class="btn btn-sm btn-primary" :disabled="busy === item.id" data-test="host-approval-approve">Aprovar e rodar</button>
        <button type="button" class="btn btn-sm btn-secondary" :disabled="busy === item.id" data-test="host-approval-reject" @click="answer(item, false)">Recusar</button>
      </div>
    </form>
    <p v-if="error" class="text-xs text-rose-300" role="alert">{{ error }}</p>
  </div>
</template>
