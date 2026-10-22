<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { initials } from '@/lib/format'
import { useAuthStore } from '@/stores/auth'
import { useConversationsStore } from '@/stores/conversations'
import Icon from './Icon.vue'

const route = useRoute()
const auth = useAuthStore()
const conversations = useConversationsStore()
const router = useRouter()

async function logout() {
  await auth.logout()
  conversations.subscribe(auth.isAdmin)
  void conversations.load(auth.isAdmin)
  await router.push('/login')
}

const section = computed(() => {
  const name = String(route.name ?? '')
  if (name.startsWith('agent')) return 'agents'
  return ['settings', 'users'].includes(name) ? name : 'inbox'
})

const links = computed(() => [
  { to: '/', key: 'inbox', label: 'Conversas', icon: 'inbox' as const, badge: conversations.unread.size },
  ...(auth.isAdmin
    ? [
        { to: '/agents', key: 'agents', label: 'Agentes', icon: 'agents' as const, badge: 0 },
        { to: '/users', key: 'users', label: 'Usuários', icon: 'users' as const, badge: 0 },
      ]
    : []),
  { to: '/settings', key: 'settings', label: 'Configuração', icon: 'settings' as const, badge: 0 },
])
</script>

<template>
  <nav class="flex w-[68px] shrink-0 flex-col items-center gap-1 border-r border-zinc-800/80 bg-zinc-900/60 py-3">
    <div class="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 text-sm font-bold text-zinc-950" title="Agents Gateway">AG</div>
    <RouterLink
      v-for="link in links"
      :key="link.key"
      :to="link.to"
      :title="link.label"
      class="relative flex w-14 flex-col items-center gap-1 rounded-xl py-2 text-[10px] font-medium transition-colors"
      :class="section === link.key ? 'bg-zinc-800 text-emerald-300' : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'"
    >
      <Icon :name="link.icon" class="h-[22px] w-[22px]" />
      {{ link.label }}
      <span v-if="link.badge" class="absolute top-1 right-2 min-w-[18px] rounded-full bg-emerald-500 px-1 text-center text-[10px] leading-[18px] font-semibold text-zinc-950">{{ link.badge > 99 ? '99+' : link.badge }}</span>
    </RouterLink>
    <div class="mt-auto flex flex-col items-center gap-2 pb-1 text-[10px] text-zinc-500">
      <span class="h-2 w-2 rounded-full" :class="conversations.live ? 'bg-emerald-400' : 'bg-zinc-600'" :title="conversations.live ? 'Ao vivo' : 'Sem conexão ao vivo'" />
      <template v-if="auth.user">
        <RouterLink to="/settings" class="grid h-9 w-9 place-items-center rounded-full text-xs font-semibold" :class="auth.isAdmin ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-800 text-zinc-300'" :title="`${auth.user.name} (${auth.user.email})`">
          {{ initials(auth.user.name) }}
        </RouterLink>
        <button class="hover:text-zinc-200" title="Sair" @click="logout">Sair</button>
      </template>
      <RouterLink v-else-if="auth.localAccounts" to="/login" class="rounded-lg px-2 py-1 text-zinc-300 hover:bg-zinc-800">Entrar</RouterLink>
    </div>
  </nav>
</template>
