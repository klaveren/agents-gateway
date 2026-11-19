<script setup lang="ts">
  import { onMounted, ref } from 'vue'
  import { api } from '@/lib/api'
  import ConfirmDialog from './ConfirmDialog.vue'

  /**
   * 📱 O AVISO NO CELULAR (Web Push), do admin do gateway: o contato que vai para a Apple e o Google junto de cada aviso
   * (eles usam se precisarem falar com quem manda) e o par de chaves VAPID. O par nasce sozinho; aqui dá para trazer um de
   * fora (o mesmo de outra instalação) ou gerar outro. ⛔ A chave privada só entra: a tela nunca a recebe de volta.
   * Trocar o par desliga o aviso em todos os aparelhos — cada pessoa liga de novo em Mensagens.
   */
  interface IPushConfig {
    publicKey: string
    contact: string
    custom: boolean
    devices: number
  }

  const config = ref<IPushConfig>()
  const contact = ref('')
  const publicKey = ref('')
  const privateKey = ref('')
  const importing = ref(false)
  const confirmRotate = ref(false)
  const busy = ref(false)
  const error = ref<string>()
  const saved = ref<string>()
  const copied = ref(false)

  function show(next: IPushConfig | undefined) {
    if (typeof next?.publicKey !== 'string' || typeof next.contact !== 'string') return
    config.value = next
    contact.value = next.custom ? next.contact.replace(/^mailto:/, '') : ''
  }

  onMounted(async () => {
    try {
      show(await api<IPushConfig>('/push/config'))
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : String(failure)
    }
  })

  async function run(action: () => Promise<IPushConfig>, done: string) {
    busy.value = true
    error.value = undefined
    saved.value = undefined
    try {
      show(await action())
      saved.value = done
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      busy.value = false
    }
  }

  const saveContact = () => run(() => api<IPushConfig>('/push/config', { method: 'PUT', body: { contact: contact.value.trim() } }), 'Contato salvo.')

  async function saveKeys() {
    await run(() => api<IPushConfig>('/push/config', { method: 'PUT', body: { publicKey: publicKey.value.trim(), privateKey: privateKey.value.trim() } }), 'Chaves trocadas. Os aparelhos precisam ligar o aviso de novo.')
    if (!error.value) {
      importing.value = false
      publicKey.value = ''
      privateKey.value = ''
    }
  }

  async function rotate() {
    await run(() => api<IPushConfig>('/push/config/rotate', { method: 'POST' }), 'Chaves novas geradas. Os aparelhos precisam ligar o aviso de novo.')
    confirmRotate.value = false
  }

  async function copy() {
    if (!config.value) return
    await navigator.clipboard?.writeText(config.value.publicKey).catch(() => undefined)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  }
</script>

<template>
  <section class="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5" data-test="push-setting">
    <div class="flex flex-wrap items-center gap-2">
      <h2 class="font-medium">Aviso no celular (Web Push)</h2>
      <span v-if="config" class="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300" data-test="push-devices">
        {{ config.devices === 1 ? '1 aparelho recebe' : `${config.devices} aparelhos recebem` }}
      </span>
    </div>
    <p class="text-xs text-zinc-400">
      Quando um agente escreve para alguém, o aviso chega no celular de quem ligou em Mensagens → "Receber aviso neste aparelho". As chaves são geradas sozinhas; não precisa de conta na Apple
      nem no Google.
    </p>

    <form class="flex flex-wrap items-end gap-2" @submit.prevent="saveContact">
      <label class="flex min-w-0 flex-1 flex-col gap-1 text-sm text-zinc-300">
        Contato
        <input
          v-model="contact"
          type="text"
          inputmode="email"
          autocomplete="off"
          class="h-9 rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm"
          :placeholder="config && !config.custom ? config.contact.replace(/^mailto:/, '') : 'voce@empresa.com'"
          data-test="push-contact"
        />
        <small class="text-xs text-zinc-500">Um e-mail (ou endereço https) que a Apple e o Google usam se precisarem falar com quem manda os avisos.</small>
      </label>
      <button type="submit" class="btn btn-sm btn-secondary" :disabled="busy" data-test="push-contact-save">Salvar contato</button>
    </form>

    <div v-if="config" class="flex flex-col gap-1 text-sm text-zinc-300">
      Chave pública
      <div class="flex items-center gap-2">
        <code class="min-w-0 flex-1 truncate rounded-lg bg-zinc-950 px-3 py-2 text-xs text-zinc-400" data-test="push-public-key">{{ config.publicKey }}</code>
        <button type="button" class="btn btn-sm btn-ghost" @click="copy">{{ copied ? 'Copiada' : 'Copiar' }}</button>
      </div>
      <small class="text-xs text-zinc-500">A chave privada fica cifrada no servidor e não aparece aqui.</small>
    </div>

    <div class="flex flex-wrap gap-2">
      <button type="button" class="btn btn-sm btn-ghost" :disabled="busy" data-test="push-import" @click="importing = !importing">Usar minhas chaves</button>
      <button type="button" class="btn btn-sm btn-ghost" :disabled="busy" data-test="push-rotate" @click="confirmRotate = true">Gerar chaves novas</button>
    </div>

    <form v-if="importing" class="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3" data-test="push-import-form" @submit.prevent="saveKeys">
      <label class="flex flex-col gap-1 text-sm text-zinc-300">
        Chave pública VAPID
        <input v-model="publicKey" type="text" autocomplete="off" spellcheck="false" class="h-9 rounded-lg border border-zinc-800 bg-zinc-900 px-3 font-mono text-xs" />
      </label>
      <label class="flex flex-col gap-1 text-sm text-zinc-300">
        Chave privada VAPID
        <input v-model="privateKey" type="password" autocomplete="off" spellcheck="false" class="h-9 rounded-lg border border-zinc-800 bg-zinc-900 px-3 font-mono text-xs" />
      </label>
      <small class="text-xs text-amber-300">Trocar as chaves desliga o aviso em todos os aparelhos: cada pessoa liga de novo em Mensagens.</small>
      <div class="flex gap-2">
        <button type="submit" class="btn btn-sm btn-secondary" :disabled="busy || !publicKey.trim() || !privateKey.trim()" data-test="push-import-save">Trocar as chaves</button>
        <button type="button" class="btn btn-sm btn-ghost" @click="importing = false">Cancelar</button>
      </div>
    </form>

    <p v-if="saved" class="text-xs text-emerald-300" role="status">{{ saved }}</p>
    <p v-if="error" class="text-xs text-rose-300" role="alert">{{ error }}</p>
    <ConfirmDialog
      :open="confirmRotate"
      title="Gerar chaves novas?"
      message="O aviso no celular para em todos os aparelhos até cada pessoa ligar de novo em Mensagens. Use se a chave privada vazou."
      action="Gerar"
      :busy="busy"
      @confirm="rotate"
      @cancel="confirmRotate = false"
    />
  </section>
</template>
