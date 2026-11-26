<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { useRouter } from 'vue-router'
  import { useResource } from '@/composables/useResource'
  import { initials } from '@/lib/format'
  import { useAboveBar, usePopover } from '@/lib/popover'
  import { loadServers, serverList } from '@/lib/servers'
  import { useAuthStore } from '@/stores/auth'
  import { usePermissionRequestsStore } from '@/stores/permissionRequests'
  import { useProjectsStore } from '@/stores/projects'
import { useSpeechStore } from '@/stores/speech'
  import AboutDialog from './AboutDialog.vue'
  import Icon from './Icon.vue'

  /**
   * O menu da conta: o avatar abre um submenu com quem está logado, o perfil, os servidores (no app do Mac), o sobre (a versão) e o sair.
   * `placement`: no trilho (desktop) abre para o lado; na barra inferior (celular), para cima.
   */
  defineProps<{ placement: 'side' | 'up' }>()

  const auth = useAuthStore()
  const projects = useProjectsStore()
  const router = useRouter()
  const speech = useSpeechStore()
  const { open, root } = usePopover()
  const above = useAboveBar(open, root)

  // ⛔ Só quem administra projeto lê os pedidos (a rota recusa o resto). ⚖️ A lista de todos (`''`) é a mesma do selo da lista de agentes e
  // anda sozinha com o `catalog.changed`: o número aqui não precisa de tela aberta nem de releitura.
  const requests = usePermissionRequestsStore()
  const { data: allRequests } = useResource(requests.lists, () => (projects.managesAny ? '' : undefined))
  const pending = computed(() => (projects.managesAny ? (allRequests.value ?? []).filter((request) => request.status === 'pending').length : 0))

  // O cadastro dos servidores só existe no app do Mac, e só a tela deste Mac cadastra (ver `lib/servers`).
  void loadServers()

  const about = ref(false)
  function showAbout() {
    open.value = false
    about.value = true
  }

  async function logout(all = false) {
    open.value = false
    // ⚠️ `logout` limpa o estado de quem saiu e refaz o escopo (conversas, agentes, eventos) sozinho.
    await auth.logout(all)
    await router.push('/login')
  }
</script>

<template>
  <div v-if="auth.user" ref="root" class="relative flex justify-center" :class="placement === 'up' ? 'min-w-[64px] flex-1 shrink-0' : ''">
    <button
      type="button"
      class="flex flex-col items-center gap-0.5 text-[10px] font-medium"
      :class="placement === 'up' ? 'w-full py-2.5 text-zinc-400' : ''"
      :aria-expanded="open"
      aria-haspopup="menu"
      :title="`${auth.user.name} (${auth.user.email})`"
      @click="open = !open"
    >
      <span
        class="relative grid place-items-center rounded-full text-xs font-semibold"
        :class="[
          auth.isAdmin ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-800 text-zinc-300',
          placement === 'up' ? 'h-[22px] w-[22px] text-[9px]' : 'h-7 w-7 text-[11px]',
          open ? 'ring-2 ring-emerald-500/60' : '',
        ]"
      >
        {{ initials(auth.user.name) }}
        <span
          v-if="pending"
          class="absolute -top-1 -right-1.5 grid min-w-4 place-items-center rounded-full bg-amber-500 px-1 text-[10px] leading-4 font-semibold text-zinc-950"
          :title="`${pending} pedido(s) de permissão esperando confirmação`"
          data-test="notifications-badge"
        >
          {{ pending }}
        </span>
        <span v-if="speech.blocked" class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-amber-400" title="Ativar som" data-test="speech-blocked-dot" />
      </span>
      <span v-if="placement === 'up'">Conta</span>
    </button>

    <div
      v-if="open"
      role="menu"
      class="z-50 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 text-sm shadow-xl shadow-black/40"
      :class="placement === 'side' ? 'absolute w-60 bottom-0 left-full ml-3' : 'fixed inset-x-2'"
      :style="placement === 'up' && above ? { bottom: `${above}px` } : undefined"
    >
      <div class="border-b border-zinc-800 px-3 py-2.5">
        <div class="truncate font-medium text-zinc-100">{{ auth.user.name }}</div>
        <div class="truncate text-xs text-zinc-500">
          {{ auth.user.email }}
          <template v-if="auth.isAdmin">· administrador</template>
        </div>
      </div>
      <RouterLink to="/profile" role="menuitem" class="flex items-center gap-2.5 px-3 py-2.5 text-zinc-200 hover:bg-zinc-800">
        <Icon name="user" class="h-4 w-4 text-zinc-400" />
        Perfil
      </RouterLink>
      <RouterLink
        :to="{ path: '/profile', hash: '#sessions' }"
        role="menuitem"
        class="flex items-center gap-2.5 px-3 py-2.5 text-zinc-200 hover:bg-zinc-800"
        data-test="sessions-item"
        @click="open = false"
      >
        <Icon name="shield" class="h-4 w-4 text-zinc-400" />
        Sessões abertas
      </RouterLink>
      <RouterLink
        v-if="projects.managesAny"
        to="/notifications"
        role="menuitem"
        class="flex items-center gap-2.5 px-3 py-2.5 text-zinc-200 hover:bg-zinc-800"
        data-test="notifications-item"
        @click="open = false"
      >
        <Icon name="bell" class="h-4 w-4 text-zinc-400" />
        Notificações
        <span v-if="pending" class="ml-auto rounded-full bg-amber-500 px-1.5 text-[10px] leading-4 font-semibold text-zinc-950" data-test="notifications-pill">{{ pending }}</span>
      </RouterLink>
      <button
        v-if="speech.blocked"
        type="button"
        role="menuitem"
        class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-amber-300 hover:bg-zinc-800"
        data-test="speech-unlock-item"
        title="O navegador bloqueou o som até você interagir com a página."
        @click="speech.unlock()"
      >
        <Icon name="bell" class="h-4 w-4" />
        Ativar som
      </button>
      <button
        v-else-if="speech.active"
        type="button"
        role="menuitem"
        class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-zinc-200 hover:bg-zinc-800"
        data-test="speech-stop-item"
        @click="speech.stop()"
      >
        <Icon name="stop" class="h-4 w-4 shrink-0 text-zinc-400" />
        <span v-if="speech.current" class="min-w-0 flex-1" data-test="speech-current">
          <span class="block truncate">Lendo: {{ speech.current.label }}</span>
          <span class="block text-xs text-zinc-500">Toque para parar{{ speech.waiting ? ` · na fila: ${speech.waiting}` : '' }}</span>
        </span>
        <template v-else>Parar leitura</template>
      </button>
      <RouterLink
        v-if="serverList?.manage"
        to="/servers"
        role="menuitem"
        class="flex items-center gap-2.5 px-3 py-2.5 text-zinc-200 hover:bg-zinc-800"
        data-test="servers-item"
        @click="open = false"
      >
        <Icon name="globe" class="h-4 w-4 text-zinc-400" />
        Servidores
      </RouterLink>
      <button
        type="button"
        role="menuitem"
        class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-zinc-200 hover:bg-zinc-800"
        data-test="about-item"
        @click="showAbout"
      >
        <Icon name="info" class="h-4 w-4 text-zinc-400" />
        Sobre
      </button>
      <button
        type="button"
        role="menuitem"
        class="flex w-full items-center gap-2.5 border-t border-zinc-800 px-3 py-2.5 text-left text-zinc-200 hover:bg-zinc-800 hover:text-rose-300"
        data-test="logout-item"
        @click="logout()"
      >
        <Icon name="logout" class="h-4 w-4 text-zinc-400" />
        Sair
      </button>
      <button
        type="button"
        role="menuitem"
        class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-xs text-zinc-400 hover:bg-zinc-800 hover:text-rose-300"
        data-test="logout-all-item"
        title="Encerra o login em todos os navegadores e aparelhos. As conversas que já estão rodando terminam o que estavam fazendo."
        @click="logout(true)"
      >
        <Icon name="logout" class="h-4 w-4 text-zinc-500" />
        Sair de todos os aparelhos
      </button>
    </div>
    <AboutDialog :open="about" @close="about = false" />
  </div>
</template>
