<script setup lang="ts">
  import { computed, onMounted, ref } from 'vue'
  import Icon from './Icon.vue'
  import { useRoute } from 'vue-router'
  import { useConnectionsStore } from '@/stores/connections'

  /** 🔌 O aviso de cima: um por projeto conectado que pede atenção (atualização disponível, sempre para a última, ou token que caiu). */
  const connections = useConnectionsStore()
  const route = useRoute()
  /** O projeto aberto já mostra o aviso no card dele: aqui, só os outros. */
  const elsewhere = (projectId: string) => route.path !== `/projects/${projectId}`
  /** Fechado aqui: some até mudar (outra versão disponível, ou o token cair de novo). Só nesta aba. */
  const dismissed = ref(new Set<string>())
  const noticeKey = (connection: { projectId: string; state?: string; latestVersion?: number }) => `${connection.projectId}:${connection.state}:${connection.latestVersion}`
  const shown = computed(() => connections.attention.filter((connection) => elsewhere(connection.projectId) && !dismissed.value.has(noticeKey(connection))))
  const dismiss = (connection: { projectId: string; state?: string; latestVersion?: number }) => (dismissed.value = new Set([...dismissed.value, noticeKey(connection)]))
  /** 🔄 O que atualizou sozinho: abrir o aviso o dá por visto. */
  const updated = computed(() => connections.updated.filter((connection) => elsewhere(connection.projectId)))
  const seen = (projectId: string) => void connections.markUpdateSeen(projectId).catch(() => undefined)
  onMounted(() => connections.follow())
</script>

<template>
  <!-- Flutuante, no canto: não empurra a tela de ninguém. No celular, acima da barra de navegação. -->
  <div v-if="shown.length || updated.length" class="fixed right-3 bottom-[calc(4rem+var(--safe-bottom))] z-40 flex max-w-sm flex-col gap-2 md:bottom-4">
    <div
      v-if="updated.length"
      class="flex flex-col overflow-hidden rounded-xl border border-emerald-500/40 bg-emerald-950/95 shadow-lg"
      role="status"
      data-test="connection-updated"
    >
      <div v-for="connection in updated" :key="connection.projectId" class="flex items-center gap-1 py-1 pr-1.5 pl-4 text-xs text-emerald-100">
        <span class="min-w-0 flex-1">
          <strong>{{ connection.projectId }}</strong>
          atualizado: v{{ connection.lastUpdate!.from }} → v{{ connection.lastUpdate!.to }} ({{ connection.lastUpdate!.changes.length }} mudança(s))
        </span>
        <RouterLink
          :to="`/projects/${connection.projectId}`"
          class="shrink-0 rounded-md px-2 py-1 font-medium underline underline-offset-2 hover:bg-emerald-500/15"
          data-test="connection-updated-open"
          @click="seen(connection.projectId)"
        >
          Ver
        </RouterLink>
        <button
          type="button"
          class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-emerald-300 hover:bg-emerald-500/15 hover:text-white"
          title="Fechar"
          aria-label="Fechar"
          data-test="connection-updated-close"
          @click="seen(connection.projectId)"
        >
          <Icon name="x" class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
    <div v-if="shown.length" class="flex flex-col overflow-hidden rounded-xl border border-amber-500/40 bg-amber-950/95 shadow-lg" role="status" data-test="connection-notice">
      <div v-for="connection in shown" :key="connection.projectId" class="flex items-center gap-1 py-1 pr-1.5 pl-4 text-xs text-amber-100">
        <span class="min-w-0 flex-1">
          <strong>{{ connection.projectId }}</strong>
          <template v-if="connection.state === 'unauthorized'">o token de conexão não vale mais: troque-o no projeto.</template>
          <template v-else>atualização disponível: v{{ connection.syncedVersion }} → v{{ connection.latestVersion }} ({{ connection.changes.length }} mudança(s))</template>
        </span>
        <RouterLink :to="`/projects/${connection.projectId}`" class="shrink-0 rounded-md px-2 py-1 font-medium underline underline-offset-2 hover:bg-amber-500/15">Ver</RouterLink>
        <button
          type="button"
          class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-amber-300 hover:bg-amber-500/15 hover:text-white"
          title="Fechar"
          aria-label="Fechar"
          data-test="connection-notice-close"
          @click="dismiss(connection)"
        >
          <Icon name="x" class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  </div>
</template>
