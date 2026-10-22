<script setup lang="ts">
import { onMounted } from 'vue'
import NavRail from './components/NavRail.vue'
import { useAgentsStore } from './stores/agents'
import { useAuthStore } from './stores/auth'

const auth = useAuthStore()
const agents = useAgentsStore()

onMounted(async () => {
  await auth.probe()
  await agents.load().catch(() => undefined)
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
