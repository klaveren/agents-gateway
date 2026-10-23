<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ApiError } from './lib/api'
import NavRail from './components/NavRail.vue'
import { useAgentsStore } from './stores/agents'
import { useAuthStore } from './stores/auth'
import { useConversationsStore } from './stores/conversations'
import { useProtocolsStore } from './stores/protocols'

const auth = useAuthStore()
const agents = useAgentsStore()
const conversations = useConversationsStore()
const protocols = useProtocolsStore()
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

/** ⚠️ Sem agentes a tela inteira fica vazia sem explicação: a falha aparece, com um jeito de tentar de novo. */
const agentsError = ref<string>()
const retrying = ref(false)
async function loadAgents() {
  retrying.value = true
  agentsError.value = undefined
  try {
    await agents.load()
  } catch (error) {
    // 401 é "falta entrar", não falha: a tela de login já diz isso.
    if (error instanceof ApiError && error.status === 401) return
    agentsError.value = error instanceof Error ? error.message : String(error)
  } finally {
    retrying.value = false
  }
}

onMounted(async () => {
  await auth.probe()
  // As regras de cada protocolo (lanes, níveis, assinatura): vêm do servidor, a tela não copia.
  void protocols.load().catch(() => undefined)
  await loadAgents()
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
    <main class="relative min-h-0 min-w-0 flex-1 pb-[calc(3.25rem+env(safe-area-inset-bottom))] md:pb-0">
      <div v-if="agentsError" role="alert" class="absolute inset-x-0 top-0 z-40 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rose-500/30 bg-rose-950 px-4 py-2 text-sm text-rose-200">
        <span class="min-w-0 flex-1">Não consegui carregar os agentes: {{ agentsError }}</span>
        <button type="button" :disabled="retrying" class="shrink-0 rounded-full bg-rose-500/20 px-3 py-1 text-xs font-medium hover:bg-rose-500/30 disabled:opacity-50" @click="loadAgents">{{ retrying ? 'Tentando…' : 'Tentar de novo' }}</button>
      </div>
      <RouterView v-if="auth.checked" />
    </main>
  </div>
</template>
