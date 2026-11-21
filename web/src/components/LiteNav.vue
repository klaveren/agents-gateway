<script setup lang="ts">
  import { useMessagesStore } from '@/stores/messages'
  import { computed } from 'vue'
  import { useRoute } from 'vue-router'
  import { useAuthStore } from '@/stores/auth'
  import { useConversationsStore } from '@/stores/conversations'
  import { useProjectsStore } from '@/stores/projects'
  import AccountMenu from './AccountMenu.vue'
  import Icon from './Icon.vue'
  import ProjectSwitcher from './ProjectSwitcher.vue'
  import RailMenu, { type IRailMenuItem } from './RailMenu.vue'

  /** O menu da lite: independente do `NavRail` (nada de condição de edição lá). Mesmo visual: trilho no desktop, barra no celular. */
  const route = useRoute()
  const auth = useAuthStore()
  const messages = useMessagesStore()
  const conversations = useConversationsStore()
  const projects = useProjectsStore()

  const section = computed(() => {
    const name = String(route.name ?? '')
    if (name === 'messages' || name === 'message') return 'messages'
    if (name.startsWith('agent')) return 'agents'
    if (name.startsWith('provider')) return 'providers'
    if (name === 'usage') return 'usage'
    if (name.startsWith('mcp')) return 'mcp'
    if (name === 'settings') return 'settings'
    if (name === 'audit' || name === 'errors') return name
    if (name === 'user' || name.startsWith('user')) return 'users'
    return 'inbox'
  })

  // Agentes e Modelos para o admin do gateway também: no gateway que acabou de nascer não há projeto (os agentes são globais).
  const links = computed<Array<{ to: string; key: string; label: string; icon: 'inbox' | 'chart' | 'agents' | 'bell' | 'users' | 'key' | 'plug' | 'settings'; badge: number }>>(() => [
    { to: '/', key: 'inbox', label: 'Conversas', icon: 'inbox' as const, badge: conversations.unread.size },
    ...(auth.signedIn ? [{ to: '/messages', key: 'messages', label: 'Mensagens', short: 'Mensagens', icon: 'bell' as const, badge: messages.unread }] : []),
    ...(auth.signedIn ? [{ to: '/usage', key: 'usage', label: 'Uso', icon: 'chart' as const, badge: 0 }] : []),
    ...(projects.manages || auth.isAdmin ? [{ to: '/agents', key: 'agents', label: 'Agentes', icon: 'agents' as const, badge: 0 }] : []),
    ...(auth.isAdmin ? [{ to: '/users', key: 'users', label: 'Usuários', icon: 'users' as const, badge: 0 }] : []),
    ...(auth.isAdmin ? [{ to: '/models', key: 'providers', label: 'Modelos', icon: 'key' as const, badge: 0 }] : []),
    // MCPs só para quem administra: na lite, todo usuário é membro do Geral, e o membro não tem o que fazer ali.
    ...(auth.isAdmin || projects.manages ? [{ to: '/mcp', key: 'mcp', label: 'MCPs', icon: 'plug' as const, badge: 0 }] : []),
    ...(auth.isAdmin ? [{ to: '/settings', key: 'settings', label: 'Configuração', icon: 'settings' as const, badge: 0 }] : []),
  ])

  /** Os logs num menu só (o que aconteceu, e o que falhou): só de quem administra. */
  const AUDIT_ITEMS: IRailMenuItem[] = [
    { to: '/audit', key: 'audit', label: 'Logs', hint: 'Quem fez o quê, quando e de onde', icon: 'shield' },
    { to: '/errors', key: 'errors', label: 'Erros', hint: 'Ferramentas e turnos que falharam, por período', icon: 'warn' },
  ]
</script>

<template>
  <nav
    class="fixed inset-x-0 bottom-0 z-30 flex shrink-0 items-stretch border-t border-zinc-800/80 bg-zinc-900/95 pb-[max(var(--safe-bottom),0.5rem)] backdrop-blur md:static md:w-[52px] md:flex-col md:items-center md:gap-1 md:border-t-0 md:border-r md:bg-zinc-900/60 md:py-2.5 md:pb-2.5 md:backdrop-blur-none"
  >
    <!-- 📱 No celular os itens não se espremem: cada um tem largura mínima e a barra rola de lado. No computador, `md:contents` some com esta camada. -->
    <div class="flex min-w-0 flex-1 items-stretch overflow-x-auto overscroll-x-contain [scrollbar-width:none] md:contents [&::-webkit-scrollbar]:hidden">
      <div v-if="auth.user" class="flex min-w-[64px] flex-1 shrink-0 md:hidden"><ProjectSwitcher placement="up" /></div>
      <div v-if="auth.user" class="mb-2 hidden md:block"><ProjectSwitcher placement="side" /></div>
      <div
        v-else
        class="mb-2 hidden h-8 w-8 place-items-center rounded-lg md:grid bg-gradient-to-br from-emerald-400 to-accent-end text-sm font-bold text-zinc-950"
        title="Agents Gateway"
      >
        AG
      </div>
      <RouterLink
        v-for="link in links"
        :key="link.key"
        :to="link.to"
        :title="link.label"
        class="relative flex min-w-[64px] flex-1 shrink-0 flex-col items-center md:min-w-0 gap-1 py-2.5 text-[11px] font-medium transition-colors md:h-9 md:w-9 md:flex-none md:justify-center md:gap-0 md:rounded-lg md:py-0"
        :class="section === link.key ? 'bg-zinc-800 text-emerald-300 md:text-zinc-50' : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'"
      >
        <Icon :name="link.icon" class="h-[22px] w-[22px] md:h-[18px] md:w-[18px]" />
        <span class="md:hidden">{{ link.label }}</span>
        <span
          v-if="link.badge"
          class="absolute top-0.5 right-[calc(50%-20px)] md:-top-1 md:-right-1.5 md:min-w-[16px] md:text-[9px] md:leading-4 min-w-[18px] rounded-full bg-emerald-500 px-1 text-center text-[10px] leading-[18px] font-semibold text-zinc-950"
        >
          {{ link.badge > 99 ? '99+' : link.badge }}
        </span>
      </RouterLink>
      <div v-if="auth.isAdmin" class="flex min-w-[64px] flex-1 shrink-0 md:hidden">
        <RailMenu title="Logs" icon="shield" :items="AUDIT_ITEMS" placement="up" :active="section" />
      </div>
      <div v-if="auth.isAdmin" class="hidden md:block"><RailMenu title="Logs" icon="shield" :items="AUDIT_ITEMS" placement="side" :active="section" /></div>
      <AccountMenu v-if="auth.user" placement="up" class="md:hidden" />
      <RouterLink
        v-else-if="auth.localAccounts"
        to="/login"
        class="flex min-w-[64px] flex-1 shrink-0 flex-col items-center justify-center py-2.5 text-[11px] font-medium text-zinc-300 md:hidden"
      >
        Entrar
      </RouterLink>
      <div class="mt-auto hidden flex-col items-center gap-2 pb-1 text-[10px] text-zinc-500 md:flex">
        <span class="h-2 w-2 rounded-full" :class="conversations.live ? 'bg-success-400' : 'bg-zinc-600'" :title="conversations.live ? 'Ao vivo' : 'Sem conexão ao vivo'" />
        <AccountMenu v-if="auth.user" placement="side" />
        <RouterLink v-else-if="auth.localAccounts" to="/login" class="rounded-lg px-2 py-1 text-zinc-300 hover:bg-zinc-800">Entrar</RouterLink>
      </div>
    </div>
  </nav>
</template>
