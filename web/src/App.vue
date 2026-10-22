<script setup lang="ts">
import { onMounted } from 'vue'
import NavRail from './components/NavRail.vue'
import { useAgentsStore } from './stores/agents'
import { useAuthStore } from './stores/auth'
import { useConversationsStore } from './stores/conversations'

const auth = useAuthStore()
const agents = useAgentsStore()
const conversations = useConversationsStore()

onMounted(async () => {
  await auth.probe()
  await agents.load().catch(() => undefined)
  // Assinado aqui, e não na caixa de entrada: o contador de não lidas vale em qualquer tela.
  conversations.subscribe(auth.isAdmin)
})
</script>

<template>
  <div class="flex h-full overflow-hidden">
    <NavRail />
    <main class="min-w-0 flex-1">
      <RouterView v-if="auth.checked" />
    </main>
  </div>
</template>
