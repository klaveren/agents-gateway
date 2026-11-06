<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CLASSIFICATION_COLOR, CLASSIFICATION_LABEL } from '@/lib/format'
import { usePopover } from '@/lib/popover'
import { useAgentsStore } from '@/stores/agents'
import { useAuthStore } from '@/stores/auth'
import { matchesFilters, useConversationsStore } from '@/stores/conversations'
import ConversationRow from './ConversationRow.vue'
import Icon from './Icon.vue'

const auth = useAuthStore()
const agents = useAgentsStore()
const conversations = useConversationsStore()

const search = ref(conversations.filters.q)
const sentinel = ref<HTMLElement>()
let debounce: ReturnType<typeof setTimeout> | undefined
let observer: IntersectionObserver | undefined

watch(search, (value) => {
  clearTimeout(debounce)
  debounce = setTimeout(() => void conversations.setFilters({ q: value }, auth.isAdmin), 250)
})

/** As abas de agente: os que têm conversa (pela contagem), na ordem da lista de agentes. */
const agentTabs = computed(() => {
  const counts = conversations.facets?.agent ?? {}
  const known = agents.list.filter((agent) => counts[agent.id]).map((agent) => ({ id: agent.id, name: agent.name, count: counts[agent.id] }))
  const orphans = Object.keys(counts)
    .filter((id) => !agents.byId.has(id))
    .map((id) => ({ id, name: id, count: counts[id] }))
  return [...known, ...orphans]
})

const classificationTabs = computed(() =>
  Object.entries(conversations.facets?.classification ?? {})
    .filter(([, count]) => count)
    .map(([value, count]) => ({ value, count })),
)

function toggleAgent(id: string) {
  void conversations.setFilters({ agentId: conversations.filters.agentId === id ? '' : id }, auth.isAdmin)
}

function toggleClassification(value: string) {
  void conversations.setFilters({ classification: conversations.filters.classification === value ? '' : value }, auth.isAdmin)
}

onMounted(() => {
  observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) void conversations.loadMore()
  })
  if (sentinel.value) observer.observe(sentinel.value)
})

// ⚠️ A busca pendente não pode disparar depois da tela sair (logout): recarregaria a lista do usuário anterior.
onBeforeUnmount(() => {
  observer?.disconnect()
  clearTimeout(debounce)
})

/** As conversas delegadas por outro agente (filhas) aparecem dentro da conversa que as originou, não na lista. */
const topLevel = computed(() => conversations.items.filter((conversation) => !conversation.metadata?.delegatedBy))
/** As arquivadas, com a mesma busca da caixa de entrada (feita aqui: a lista delas vem inteira). */
const archivedTop = computed(() => conversations.archivedItems.filter((conversation) => matchesFilters(conversation, { q: conversations.filters.q, agentId: '', classification: '' })))
const inArchived = computed(() => conversations.view === 'archived')

/** O menu de três pontos ao lado da busca, no desenho do menu principal: as arquivadas e, para quem administra, as de todos. */
const { open: menuOpen, root: menuRoot } = usePopover()
const showArchived = computed(() => conversations.archivedCount > 0 || inArchived.value)
const showEveryone = computed(() => auth.isAdmin && !inArchived.value)
function pick(action: () => void) {
  menuOpen.value = false
  action()
}
</script>

<template>
  <section class="flex h-full flex-col">
    <header class="flex items-center gap-2 px-4 pt-4 pb-2">
      <h1 class="text-xl font-semibold">{{ inArchived ? 'Arquivadas' : 'Conversas' }}</h1>
      <span class="text-sm text-zinc-500">{{ inArchived ? archivedTop.length : conversations.total }}</span>
      <RouterLink to="/new" class="ml-auto grid h-9 w-9 place-items-center rounded-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400" title="Nova conversa">
        <Icon name="plus" class="h-5 w-5" />
      </RouterLink>
    </header>

    <!-- A busca e o menu de três pontos: as arquivadas (na mesma tela) e, para quem administra, as de todos. -->
    <div class="flex items-center gap-1.5 px-4 pb-2">
      <label class="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-zinc-800/80 px-3 py-2 text-sm focus-within:ring-1 focus-within:ring-emerald-500/60">
        <Icon name="search" class="h-4 w-4 text-zinc-500" />
        <input
          v-model="search"
          type="search"
          :placeholder="auth.isAdmin && conversations.everyone && !inArchived ? 'Buscar por título, e-mail, conta ou id…' : 'Buscar por título ou id…'"
          class="w-full bg-transparent outline-none placeholder:text-zinc-500"
        />
      </label>
      <div v-if="showArchived || showEveryone" ref="menuRoot" class="relative shrink-0">
        <button
          type="button"
          class="relative grid h-9 w-9 place-items-center rounded-full hover:bg-zinc-800"
          :class="menuOpen || inArchived || conversations.everyone ? 'bg-zinc-800 text-emerald-400' : 'text-zinc-400'"
          title="Mais opções"
          aria-label="Mais opções"
          aria-haspopup="menu"
          :aria-expanded="menuOpen"
          data-testid="list-menu"
          @click="menuOpen = !menuOpen"
        >
          <Icon name="more" class="h-5 w-5" />
        </button>
        <div v-if="menuOpen" role="menu" class="absolute top-full right-0 z-50 mt-1 w-64 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 text-sm shadow-xl shadow-black/40">
          <div class="border-b border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-500">Conversas</div>
          <button
            v-if="showArchived"
            type="button"
            role="menuitem"
            class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-zinc-800"
            :class="inArchived ? 'text-emerald-300' : 'text-zinc-200'"
            data-testid="archived-toggle"
            @click="pick(() => conversations.showView(inArchived ? 'inbox' : 'archived'))"
          >
            <Icon name="archive" class="h-4 w-4 shrink-0 text-zinc-400" />
            <span class="min-w-0 flex-1">
              <span class="block">{{ inArchived ? 'Voltar às conversas' : 'Arquivadas' }}</span>
              <span class="block truncate text-xs text-zinc-500">{{ inArchived ? 'A caixa de entrada' : 'As conversas que você guardou' }}</span>
            </span>
            <span v-if="conversations.archivedCount > 0" class="rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-400" data-testid="archived-count">{{ conversations.archivedCount }}</span>
          </button>
          <button
            v-if="showEveryone"
            type="button"
            role="menuitemcheckbox"
            :aria-checked="conversations.everyone"
            class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-zinc-800"
            :class="conversations.everyone ? 'text-emerald-300' : 'text-zinc-200'"
            data-test="everyone-toggle"
            @click="pick(() => conversations.setEveryone(!conversations.everyone))"
          >
            <Icon name="users" class="h-4 w-4 shrink-0 text-zinc-400" />
            <span class="min-w-0 flex-1">
              <span class="block">Conversas de todo mundo</span>
              <span class="block truncate text-xs text-zinc-500">O monitor: as de todas as contas</span>
            </span>
            <Icon v-if="conversations.everyone" name="check" class="h-4 w-4 shrink-0" />
          </button>
        </div>
      </div>
    </div>

    <div v-if="!inArchived && (agentTabs.length > 1 || conversations.filters.agentId)" class="flex gap-1.5 overflow-x-auto px-4 pb-2">
      <button
        v-for="tab in agentTabs"
        :key="tab.id"
        class="chip shrink-0"
        :class="{ on: conversations.filters.agentId === tab.id }"
        @click="toggleAgent(tab.id)"
      >
        {{ tab.name }} <span class="text-zinc-500">{{ tab.count }}</span>
      </button>
    </div>

    <div v-if="!inArchived && classificationTabs.length" class="flex gap-1.5 px-4 pb-2">
      <button
        v-for="tab in classificationTabs"
        :key="tab.value"
        class="chip"
        :class="{ on: conversations.filters.classification === tab.value }"
        :title="CLASSIFICATION_LABEL[tab.value]"
        @click="toggleClassification(tab.value)"
      >
        <span class="h-2 w-2 rounded-full" :class="CLASSIFICATION_COLOR[tab.value]" /> {{ tab.count }}
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
      <p v-if="conversations.actionError" class="m-3 flex items-start gap-2 text-sm text-rose-300" role="alert">
        <span class="min-w-0 flex-1">{{ conversations.actionError }}</span>
        <button type="button" class="shrink-0 text-zinc-400 hover:text-white" title="Dispensar" @click="conversations.actionError = undefined"><Icon name="x" class="h-4 w-4" /></button>
      </p>
      <template v-if="inArchived">
        <ConversationRow
          v-for="conversation in archivedTop"
          :key="conversation.id"
          :conversation="conversation"
          :active="conversation.id === conversations.selectedId"
          :unread="false"
          :show-owner="auth.isAdmin && conversations.everyone"
          archived
        />
        <p v-if="conversations.archivedLoading" class="py-2 text-center text-xs text-zinc-500">Carregando…</p>
        <p v-else-if="!archivedTop.length" class="m-6 text-center text-sm text-zinc-500">Nenhuma conversa arquivada{{ conversations.filters.q ? ' com essa busca' : '' }}.</p>
      </template>
      <template v-else>
      <p v-if="auth.unauthorized" class="m-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
        Sua sessão expirou. <RouterLink to="/login" class="underline">Entre de novo</RouterLink>.
      </p>
      <p v-else-if="conversations.error" class="m-3 text-sm text-rose-300">{{ conversations.error }}</p>
      <p v-else-if="!conversations.loading && !conversations.items.length" class="m-6 text-center text-sm text-zinc-500">Nenhuma conversa{{ conversations.filters.q || conversations.filters.agentId ? ' com esse filtro' : ' ainda' }}.</p>

      <ConversationRow
        v-for="conversation in topLevel"
        :key="conversation.id"
        :conversation="conversation"
        :active="conversation.id === conversations.selectedId"
        :unread="conversations.unread.has(conversation.id)"
        :running="conversations.running.has(conversation.id)"
        :show-owner="auth.isAdmin && conversations.everyone"
      />
      <div ref="sentinel" class="h-6" />
      <p v-if="conversations.loading" class="py-2 text-center text-xs text-zinc-500">Carregando…</p>
      </template>
    </div>
  </section>
</template>
