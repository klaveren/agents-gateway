<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useConnectionsStore } from '@/stores/connections'

/** 🔌 O aviso de cima: um por projeto conectado que pede atenção (atualização disponível, sempre para a última, ou token que caiu). */
const connections = useConnectionsStore()
const route = useRoute()
/** O projeto aberto já mostra o aviso no card dele: aqui, só os outros. */
const shown = computed(() => connections.attention.filter((connection) => !(route.path === `/projects/${connection.projectId}`)))
onMounted(() => connections.follow())
</script>

<template>
  <!-- Flutuante, no canto: não empurra a tela de ninguém. No celular, acima da barra de navegação. -->
  <div
    v-if="shown.length"
    class="fixed right-3 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 flex max-w-sm flex-col overflow-hidden rounded-xl border border-amber-500/40 bg-amber-950/95 shadow-lg md:bottom-4"
    role="status"
    data-test="connection-notice"
  >
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
</template>
