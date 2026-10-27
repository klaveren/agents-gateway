<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useConversationsStore } from '@/stores/conversations'
import AccountMenu from './AccountMenu.vue'
import Icon from './Icon.vue'

const route = useRoute()
const auth = useAuthStore()
const conversations = useConversationsStore()


const section = computed(() => {
  const name = String(route.name ?? '')
  if (name.startsWith('agent')) return 'agents'
  if (name.startsWith('provider')) return 'providers'
  if (name.startsWith('mcp')) return 'mcp'
  if (name === 'user' || name.startsWith('user-')) return 'users'
  // Perfil não tem item no trilho (mora no menu da conta): nada fica aceso.
  if (name === 'packages' || name === 'profile') return name
  return ['settings', 'users', 'usage'].includes(name) ? name : 'inbox'
})

/**
 * ⚖️ Abaixo de `md` o trilho vira uma BARRA INFERIOR: no celular, 68px de coluna fixa eram quase um
 * quinto da tela. Os mesmos links; Perfil e Sair ficam no menu da conta.
 */
const links = computed<Array<{ to: string; key: string; label: string; short?: string; icon: 'inbox' | 'chart' | 'agents' | 'key' | 'users' | 'settings' | 'plug' | 'box'; badge: number }>>(() => [
  { to: '/', key: 'inbox', label: 'Conversas', short: 'Chats', icon: 'inbox' as const, badge: conversations.unread.size },
  ...(auth.signedIn ? [{ to: '/usage', key: 'usage', label: 'Uso', icon: 'chart' as const, badge: 0 }] : []),
  ...(auth.isAdmin
    ? [
        { to: '/agents', key: 'agents', label: 'Agentes', icon: 'agents' as const, badge: 0 },
        { to: '/providers', key: 'providers', label: 'Providers', short: 'APIs', icon: 'key' as const, badge: 0 },
        { to: '/mcp', key: 'mcp', label: 'MCPs', icon: 'plug' as const, badge: 0 },
        { to: '/packages', key: 'packages', label: 'Pacotes', icon: 'box' as const, badge: 0 },
        { to: '/users', key: 'users', label: 'Usuários', short: 'Equipe', icon: 'users' as const, badge: 0 },
        // Configuração é do SISTEMA: só admin. O que é da pessoa fica em Perfil, no menu da conta.
        { to: '/settings', key: 'settings', label: 'Configuração', short: 'Ajustes', icon: 'settings' as const, badge: 0 },
      ]
    : []),
])
</script>

<template>
  <nav
    class="fixed inset-x-0 bottom-0 z-30 flex shrink-0 items-stretch border-t border-zinc-800/80 bg-zinc-900/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:static md:w-[68px] md:flex-col md:items-center md:gap-1 md:border-t-0 md:border-r md:bg-zinc-900/60 md:py-3 md:pb-3 md:backdrop-blur-none"
  >
    <div class="mb-3 hidden h-10 w-10 place-items-center rounded-xl md:grid bg-gradient-to-br from-emerald-400 to-teal-600 text-sm font-bold text-zinc-950" title="Agents Gateway">AG</div>
    <RouterLink
      v-for="link in links"
      :key="link.key"
      :to="link.to"
      :title="link.label"
      class="relative flex min-w-0 flex-1 flex-col items-center gap-0.5 py-1.5 text-[10px] font-medium transition-colors md:w-14 md:flex-none md:gap-1 md:rounded-xl md:py-2"
      :class="section === link.key ? 'bg-zinc-800 text-emerald-300' : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'"
    >
      <Icon :name="link.icon" class="h-[22px] w-[22px]" />
      <span class="max-w-full truncate px-0.5 md:hidden">{{ link.short ?? link.label }}</span>
      <span class="hidden md:inline">{{ link.label }}</span>
      <span v-if="link.badge" class="absolute top-0.5 right-[calc(50%-20px)] md:top-1 md:right-2 min-w-[18px] rounded-full bg-emerald-500 px-1 text-center text-[10px] leading-[18px] font-semibold text-zinc-950">{{ link.badge > 99 ? '99+' : link.badge }}</span>
    </RouterLink>
    <AccountMenu v-if="auth.user" placement="up" class="md:hidden" />
    <RouterLink v-else-if="auth.localAccounts" to="/login" class="flex flex-1 flex-col items-center justify-center py-1.5 text-[10px] font-medium text-zinc-300 md:hidden">Entrar</RouterLink>
    <div class="mt-auto hidden flex-col items-center gap-2 pb-1 text-[10px] text-zinc-500 md:flex">
      <span class="h-2 w-2 rounded-full" :class="conversations.live ? 'bg-emerald-400' : 'bg-zinc-600'" :title="conversations.live ? 'Ao vivo' : 'Sem conexão ao vivo'" />
      <AccountMenu v-if="auth.user" placement="side" />
      <RouterLink v-else-if="auth.localAccounts" to="/login" class="rounded-lg px-2 py-1 text-zinc-300 hover:bg-zinc-800">Entrar</RouterLink>
    </div>
  </nav>
</template>
