<script setup lang="ts">
import { useRouter } from 'vue-router'
import { initials } from '@/lib/format'
import { usePopover } from '@/lib/popover'
import { useAuthStore } from '@/stores/auth'
import Icon from './Icon.vue'

/**
 * O menu da conta: o avatar abre um submenu com quem está logado, o perfil e o sair.
 * `placement`: no trilho (desktop) abre para o lado; na barra inferior (celular), para cima.
 */
defineProps<{ placement: 'side' | 'up' }>()

const auth = useAuthStore()
const router = useRouter()
const { open, root } = usePopover()

async function logout() {
  open.value = false
  // ⚠️ `logout` limpa o estado de quem saiu e refaz o escopo (conversas, agentes, eventos) sozinho.
  await auth.logout()
  await router.push('/login')
}
</script>

<template>
  <div v-if="auth.user" ref="root" class="relative flex justify-center" :class="placement === 'up' ? 'min-w-0 flex-1' : ''">
    <button
      type="button"
      class="flex flex-col items-center gap-0.5 text-[10px] font-medium"
      :class="placement === 'up' ? 'w-full py-1.5 text-zinc-400' : ''"
      :aria-expanded="open"
      aria-haspopup="menu"
      :title="`${auth.user.name} (${auth.user.email})`"
      @click="open = !open"
    >
      <span
        class="grid place-items-center rounded-full text-xs font-semibold"
        :class="[auth.isAdmin ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-800 text-zinc-300', placement === 'up' ? 'h-[22px] w-[22px] text-[9px]' : 'h-9 w-9', open ? 'ring-2 ring-emerald-500/60' : '']"
        >{{ initials(auth.user.name) }}</span
      >
      <span v-if="placement === 'up'">Conta</span>
    </button>

    <div
      v-if="open"
      role="menu"
      class="absolute z-50 w-60 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 text-sm shadow-xl shadow-black/40"
      :class="placement === 'side' ? 'bottom-0 left-full ml-3' : 'right-1 bottom-full mb-2'"
    >
      <div class="border-b border-zinc-800 px-3 py-2.5">
        <div class="truncate font-medium text-zinc-100">{{ auth.user.name }}</div>
        <div class="truncate text-xs text-zinc-500">{{ auth.user.email }}<template v-if="auth.isAdmin"> · administrador</template></div>
      </div>
      <RouterLink to="/profile" role="menuitem" class="flex items-center gap-2.5 px-3 py-2.5 text-zinc-200 hover:bg-zinc-800"><Icon name="user" class="h-4 w-4 text-zinc-400" /> Perfil</RouterLink>
      <button type="button" role="menuitem" class="flex w-full items-center gap-2.5 border-t border-zinc-800 px-3 py-2.5 text-left text-zinc-200 hover:bg-zinc-800 hover:text-rose-300" @click="logout">
        <Icon name="logout" class="h-4 w-4 text-zinc-400" /> Sair
      </button>
    </div>
  </div>
</template>
