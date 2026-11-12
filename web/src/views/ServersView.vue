<script setup lang="ts">
import { ref } from 'vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { addServer, bridgeReason, loadServers, removeServer, serverList, switchServer, type IServer } from '@/lib/servers'

/**
 * Os SERVIDORES do app do Mac: os outros gateways que a mesma janela abre (ver `lib/servers`).
 * ⚖️ Aqui não há "Salvar": adicionar e remover gravam na hora, no app. Quem recusa (nome repetido, endereço que o app
 * não abre) é o app, e o motivo dele é o que aparece.
 */
const ready = ref(false)
void loadServers().finally(() => (ready.value = true))

const name = ref('')
const url = ref('')
const adding = ref(false)
const addError = ref<string>()
const listError = ref<string>()
const removing = ref<IServer>()
const removeBusy = ref(false)

async function add() {
  addError.value = undefined
  adding.value = true
  try {
    await addServer(name.value, url.value)
    name.value = ''
    url.value = ''
  } catch (error) {
    addError.value = bridgeReason(error)
  } finally {
    adding.value = false
  }
}

async function open(id: string) {
  listError.value = undefined
  try {
    await switchServer(id)
  } catch (error) {
    listError.value = bridgeReason(error)
  }
}

async function remove() {
  const server = removing.value
  if (!server) return
  listError.value = undefined
  removeBusy.value = true
  try {
    await removeServer(server.id)
  } catch (error) {
    listError.value = bridgeReason(error)
  } finally {
    removeBusy.value = false
    removing.value = undefined
  }
}
</script>

<template>
  <div class="h-full overflow-y-auto px-4 py-6">
    <div class="mx-auto flex max-w-2xl flex-col gap-6">
      <h1 class="text-xl font-semibold">Servidores</h1>

      <p v-if="ready && !serverList" class="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 text-sm text-zinc-400" data-test="servers-no-app">
        Trocar de servidor é do app do Mac. No navegador, abra o endereço do outro gateway em outra aba.
      </p>

      <template v-else-if="serverList">
        <section class="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
          <p class="text-sm text-zinc-400">
            A mesma janela abre a tela de outro gateway, com o login dele. O app guarda só o nome e o endereço. Para trocar: o menu do projeto, ou o menu Servidor (⌘1, ⌘2…).
          </p>
          <ul class="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
            <li v-for="server in serverList.servers" :key="server.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-test="server-row">
              <div class="min-w-0 flex-1 basis-48">
                <div class="flex items-center gap-2">
                  <span class="truncate text-sm font-medium">{{ server.name }}</span>
                  <span v-if="server.id === serverList.current" class="shrink-0 rounded-full bg-emerald-500/15 px-1.5 text-[10px] text-emerald-200">aberto</span>
                </div>
                <div v-if="server.local || server.url" class="truncate text-xs text-zinc-500">{{ server.local ? 'O gateway que o app sobe neste Mac.' : server.url }}</div>
              </div>
              <button v-if="server.id !== serverList.current" type="button" class="btn btn-sm btn-secondary" @click="open(server.id)">Abrir</button>
              <button v-if="serverList.manage && !server.local" type="button" class="btn btn-sm btn-danger" @click="removing = server">Remover</button>
            </li>
          </ul>
          <p v-if="listError" class="text-sm text-rose-300" data-test="servers-list-error">{{ listError }}</p>
        </section>

        <section v-if="serverList.manage" class="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 class="font-medium">Adicionar servidor</h2>
          <form class="flex flex-wrap items-end gap-2" data-test="servers-form" @submit.prevent="add">
            <label class="flex min-w-0 flex-1 basis-40 flex-col gap-1 text-sm text-zinc-300">
              Nome
              <input v-model="name" required maxlength="40" class="h-9 rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm" placeholder="Servidor 4" data-test="servers-name" />
            </label>
            <label class="flex min-w-0 flex-1 basis-56 flex-col gap-1 text-sm text-zinc-300">
              Endereço
              <input
                v-model="url"
                required
                autocapitalize="off"
                autocorrect="off"
                spellcheck="false"
                class="h-9 rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm"
                placeholder="https://servidor.exemplo.com"
                data-test="servers-url"
              />
            </label>
            <button type="submit" :disabled="adding" class="btn btn-primary">Adicionar</button>
          </form>
          <p class="text-xs text-zinc-500">Na rede local (IP privado, nome sem ponto, <code>.local</code>) o endereço pode ser <code>http</code>. Fora dela, só <code>https</code>.</p>
          <p v-if="addError" class="text-sm text-rose-300" data-test="servers-add-error">{{ addError }}</p>
        </section>
        <p v-else class="text-sm text-zinc-400" data-test="servers-read-only">O cadastro é feito na tela de Este Mac: menu Servidor → Este Mac (⌘1).</p>
      </template>
    </div>

    <ConfirmDialog
      :open="!!removing"
      :title="`Remover “${removing?.name ?? ''}”?`"
      message="O app esquece o nome e o endereço. Nada muda no servidor."
      action="Remover"
      :busy="removeBusy"
      @confirm="remove"
      @cancel="removing = undefined"
    />
  </div>
</template>
