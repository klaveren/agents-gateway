<script setup lang="ts">
  import { computed, onMounted } from 'vue'
  import { useRoute } from 'vue-router'
  import { useConnectionsStore } from '@/stores/connections'

  /** 🔌 O aviso de cima: um por projeto conectado que pede atenção (atualização disponível, sempre para a última, ou token que caiu). */
  const connections = useConnectionsStore()
  const route = useRoute()
  /** O projeto aberto já mostra o aviso no card dele: aqui, só os outros. */
  const elsewhere = (projectId: string) => route.path !== `/projects/${projectId}`
  const shown = computed(() => connections.attention.filter((connection) => elsewhere(connection.projectId)))
  /** 🔄 O que atualizou sozinho: abrir o aviso o dá por visto. */
  const updated = computed(() => connections.updated.filter((connection) => elsewhere(connection.projectId)))
  const seen = (projectId: string) => void connections.markUpdateSeen(projectId).catch(() => undefined)
  onMounted(() => connections.follow())
</script>

<template>
  <!-- Flutuante, no canto: não empurra a tela de ninguém. No celular, acima da barra de navegação. -->
  <div v-if="shown.length || updated.length" class="fixed right-3 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 flex max-w-sm flex-col gap-2 md:bottom-4">
    <div
      v-if="updated.length"
      class="flex flex-col overflow-hidden rounded-xl border border-emerald-500/40 bg-emerald-950/95 shadow-lg"
      role="status"
      data-test="connection-updated"
    >
      <RouterLink
        v-for="connection in updated"
        :key="connection.projectId"
        :to="`/projects/${connection.projectId}`"
        class="flex flex-wrap items-center gap-x-2 px-4 py-1.5 text-xs text-emerald-100 hover:bg-emerald-500/10"
        @click="seen(connection.projectId)"
      >
        <strong>{{ connection.projectId }}</strong>
        <span>atualizado: v{{ connection.lastUpdate!.from }} → v{{ connection.lastUpdate!.to }} ({{ connection.lastUpdate!.changes.length }} mudança(s))</span>
        <span class="ml-auto underline underline-offset-2">Ver</span>
      </RouterLink>
    </div>
    <div v-if="shown.length" class="flex flex-col overflow-hidden rounded-xl border border-amber-500/40 bg-amber-950/95 shadow-lg" role="status" data-test="connection-notice">
      <RouterLink
        v-for="connection in shown"
        :key="connection.projectId"
        :to="`/projects/${connection.projectId}`"
        class="flex flex-wrap items-center gap-x-2 px-4 py-1.5 text-xs text-amber-100 hover:bg-amber-500/10"
      >
        <strong>{{ connection.projectId }}</strong>
        <span v-if="connection.state === 'unauthorized'">o token de conexão não vale mais: troque-o no projeto.</span>
        <span v-else>atualização disponível: v{{ connection.syncedVersion }} → v{{ connection.latestVersion }} ({{ connection.changes.length }} mudança(s))</span>
        <span class="ml-auto underline underline-offset-2">Ver</span>
      </RouterLink>
    </div>
  </div>
</template>
