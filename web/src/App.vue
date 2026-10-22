<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import NavRail from './components/NavRail.vue'
import { useAgentsStore } from './stores/agents'
import { useAuthStore } from './stores/auth'
import { useConversationsStore } from './stores/conversations'

const auth = useAuthStore()
const agents = useAgentsStore()
const conversations = useConversationsStore()
const route = useRoute()
const router = useRouter()

/** Sem nenhuma conta ainda, tudo leva ao setup do primeiro admin. */
watch(
  () => [auth.checked, auth.setupRequired, route.name] as const,
  ([checked, setupRequired, name]) => {
    if (checked && setupRequired && name !== 'setup') void router.replace('/setup')
  },
)

// A sessão caiu (401): volta ao login, guardando onde a pessoa estava.
watch(
  () => auth.signedIn,
  (signedIn, was) => {
    if (was && !signedIn && auth.localAccounts && route.name !== 'login') void router.replace({ path: '/login', query: { next: route.fullPath } })
  },
)

onMounted(async () => {
  await auth.probe()
  await agents.load().catch(() => undefined)
  // As ferramentas (com os rótulos das nativas), para o histórico mostrar "Busca na web" e não `WebSearch`.
  void agents.loadTools().catch(() => undefined)
  // Assinado aqui, e não na caixa de entrada: o contador de não lidas vale em qualquer tela.
  conversations.subscribe(auth.isAdmin)
})
</script>

<template>
  <div class="flex h-full overflow-hidden">
    <NavRail />
    <!-- No celular a navegação é uma barra fixa embaixo: o conteúdo para antes dela. -->
    <main class="min-h-0 min-w-0 flex-1 pb-[calc(3.25rem+env(safe-area-inset-bottom))] md:pb-0">
      <RouterView v-if="auth.checked" />
    </main>
  </div>
</template>
