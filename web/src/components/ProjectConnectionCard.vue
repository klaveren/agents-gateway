<script setup lang="ts">
import { computed, ref } from 'vue'
import { changeLabel, originLabel } from '@/lib/connection'
import { fullTime } from '@/lib/format'
import { useConnectionsStore } from '@/stores/connections'
import ConfirmDialog from './ConfirmDialog.vue'

/**
 * 🔌 O projeto conectado: de onde vem, a versão daqui e a da origem, o aviso de atualização (um só, sempre para a
 * última), o que não entrou e as variáveis que o projeto pede. O catálogo é só leitura: mudar é na origem.
 */
const props = defineProps<{ projectId: string }>()
const connections = useConnectionsStore()
const connection = computed(() => connections.byProject.get(props.projectId))
const busy = ref<'sync' | 'check' | 'token'>()
const error = ref<string>()
const note = ref<string>()
const token = ref('')
const askingToken = ref(false)
const disconnecting = ref(false)

const STATE = { ok: 'Conectado', offline: 'Origem fora do ar', unauthorized: 'Token não vale mais' } as const

async function run(kind: 'sync' | 'check' | 'token', work: () => Promise<string | undefined>) {
  busy.value = kind
  error.value = undefined
  note.value = undefined
  try {
    note.value = await work()
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    busy.value = undefined
  }
}

const update = () =>
  run('sync', async () => {
    const result = await connections.sync(props.projectId)
    const removed = result.removed.length ? `, ${result.removed.length} removido(s)` : ''
    return `Atualizado para a v${result.version}: ${result.applied} item(ns) gravado(s)${removed}.`
  })
const check = () =>
  run('check', async () => {
    await connections.check(props.projectId)
    return undefined
  })
const saveToken = () =>
  run('token', async () => {
    await connections.replaceToken(props.projectId, token.value)
    token.value = ''
    askingToken.value = false
    return 'Token trocado.'
  })
async function disconnect() {
  disconnecting.value = false
  await run('check', async () => {
    await connections.disconnect(props.projectId)
    return 'Desconectado: o projeto agora é comum daqui.'
  })
}
</script>

<template>
  <div v-if="connection" class="flex flex-col gap-3 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3 text-sm" data-test="project-connection">
    <div class="flex flex-wrap items-center gap-2">
      <span class="rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-medium text-sky-200">Conectado · só leitura</span>
      <span class="truncate text-xs text-zinc-400">
        origem <code class="text-zinc-200">{{ originLabel(connection.url) }}</code> · projeto <code class="text-zinc-200">{{ connection.remoteProjectId }}</code>
      </span>
      <span class="ml-auto text-xs" :class="connection.state === 'ok' ? 'text-emerald-300' : 'text-amber-300'">{{ STATE[connection.state] }}</span>
    </div>
    <p class="text-xs text-zinc-400">
      Agentes, skills, comandos, specs e regras vêm da origem. A mudança é feita lá e chega aqui pela atualização.
    </p>
    <p v-if="connection.state !== 'ok' && connection.lastError" class="text-xs text-amber-300">{{ connection.lastError }}</p>

    <div v-if="connection.updateAvailable" class="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3" data-test="connection-update">
      <div class="flex flex-wrap items-center gap-2">
        <strong class="text-amber-200">Atualização disponível: v{{ connection.syncedVersion }} → v{{ connection.latestVersion }}</strong>
        <button type="button" class="btn btn-sm btn-primary ml-auto" :disabled="!!busy" @click="update">{{ busy === 'sync' ? 'Atualizando…' : 'Atualizar' }}</button>
      </div>
      <ul class="flex flex-col gap-0.5 text-xs text-zinc-300">
        <li v-for="change in connection.changes" :key="`${change.kind}/${change.id}`">{{ changeLabel(change) }}</li>
      </ul>
      <p v-if="connection.changesTruncated" class="text-xs text-zinc-500">E mais mudanças: a atualização traz todas.</p>
    </div>
    <p v-else class="text-xs text-zinc-500">
      Na última versão (v{{ connection.syncedVersion }}){{ connection.lastCheckedAt ? ` · conferido ${fullTime(connection.lastCheckedAt)}` : '' }}.
    </p>

    <details v-if="connection.skipped.length" class="text-xs">
      <summary class="cursor-pointer text-amber-300">{{ connection.skipped.length }} item(ns) da origem não entraram aqui</summary>
      <!-- Sem versão nova, a mesma versão de novo: o que mudou foi aqui (um modelo ligado, uma variável preenchida). -->
      <button v-if="!connection.updateAvailable" type="button" class="btn btn-sm btn-secondary mt-1" :disabled="!!busy" @click="update">
        {{ busy === 'sync' ? 'Tentando…' : 'Tentar de novo' }}
      </button>
      <ul class="mt-1 flex flex-col gap-0.5 text-zinc-400">
        <li v-for="item in connection.skipped" :key="item.ref"><code class="text-zinc-300">{{ item.ref }}</code>: {{ item.message }}</li>
      </ul>
    </details>
    <details v-if="connection.secrets.length" class="text-xs">
      <summary class="cursor-pointer text-zinc-300">{{ connection.secrets.length }} variável(is) que o projeto pede</summary>
      <p class="mt-1 text-zinc-500">Os valores ficam só nesta máquina: preencha cada um na tela do agente ou do recurso.</p>
      <ul class="mt-1 flex flex-col gap-0.5 text-zinc-400">
        <li v-for="secret in connection.secrets" :key="`${secret.kind}/${secret.id}/${secret.name}`">
          <code class="text-zinc-300">{{ secret.name }}</code> · {{ secret.kind }} {{ secret.id }}<template v-if="secret.description"> — {{ secret.description }}</template>
        </li>
      </ul>
    </details>

    <form v-if="askingToken" class="flex flex-wrap items-end gap-2" @submit.prevent="saveToken">
      <label class="flex min-w-0 flex-1 flex-col gap-1 text-xs text-zinc-300">
        Novo token de conexão
        <input v-model="token" required type="password" autocomplete="off" class="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 font-mono text-sm" placeholder="agc_…" />
      </label>
      <button type="submit" class="btn btn-sm btn-primary" :disabled="!!busy">Trocar</button>
      <button type="button" class="btn btn-sm btn-ghost" @click="askingToken = false">Cancelar</button>
    </form>

    <div class="flex flex-wrap gap-2">
      <button type="button" class="btn btn-sm btn-secondary" :disabled="!!busy" @click="check">{{ busy === 'check' ? 'Conferindo…' : 'Conferir agora' }}</button>
      <button v-if="!askingToken" type="button" class="btn btn-sm btn-secondary" @click="askingToken = true">Trocar token</button>
      <button type="button" class="btn btn-sm btn-danger ml-auto" @click="disconnecting = true">Desconectar</button>
    </div>
    <p v-if="note" class="text-xs text-emerald-300">{{ note }}</p>
    <p v-if="error" class="text-xs text-rose-300">{{ error }}</p>

    <ConfirmDialog
      :open="disconnecting"
      :title="`Desconectar ${projectId}?`"
      message="O projeto fica aqui, como um projeto comum e editável, e para de receber as atualizações da origem. Para conectar de novo, apague-o e conecte outra vez."
      action="Desconectar"
      @confirm="disconnect"
      @cancel="disconnecting = false"
    />
  </div>
</template>
