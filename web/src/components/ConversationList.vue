<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CLASSIFICATION_COLOR, CLASSIFICATION_LABEL } from '@/lib/format'
import { useAgentsStore } from '@/stores/agents'
import { useAuthStore } from '@/stores/auth'
import { useConversationsStore } from '@/stores/conversations'
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

onBeforeUnmount(() => observer?.disconnect())

/** As conversas delegadas por outro agente (filhas) aparecem dentro da conversa que as originou, não na lista. */
const topLevel = computed(() => conversations.items.filter((conversation) => !conversation.metadata?.delegatedBy))
</script>

<template>
  <section class="flex h-full flex-col">
    <header class="flex items-center gap-2 px-4 pt-4 pb-2">
      <h1 class="text-xl font-semibold">Conversas</h1>
      <span class="text-sm text-zinc-500">{{ conversations.total }}</span>
      <RouterLink to="/new" class="ml-auto grid h-9 w-9 place-items-center rounded-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400" title="Nova conversa">
        <Icon name="plus" class="h-5 w-5" />
      </RouterLink>
    </header>

    <div class="px-4 pb-2">
      <label class="flex items-center gap-2 rounded-full bg-zinc-800/80 px-3 py-2 text-sm focus-within:ring-1 focus-within:ring-emerald-500/60">
        <Icon name="search" class="h-4 w-4 text-zinc-500" />
        <input v-model="search" type="search" :placeholder="auth.isAdmin ? 'Buscar por título, e-mail, conta…' : 'Buscar por título…'" class="w-full bg-transparent outline-none placeholder:text-zinc-500" />
      </label>
    </div>

    <div v-if="agentTabs.length > 1 || conversations.filters.agentId" class="scroll-thin flex gap-1.5 overflow-x-auto px-4 pb-2">
      <button
        v-for="tab in agentTabs"
        :key="tab.id"
        class="shrink-0 rounded-full border px-3 py-1 text-xs transition-colors"
        :class="conversations.filters.agentId === tab.id ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'"
        @click="toggleAgent(tab.id)"
      >
        {{ tab.name }} <span class="text-zinc-500">{{ tab.count }}</span>
      </button>
    </div>

    <div v-if="classificationTabs.length" class="flex gap-1.5 px-4 pb-2">
      <button
        v-for="tab in classificationTabs"
        :key="tab.value"
        class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors"
        :class="conversations.filters.classification === tab.value ? 'border-zinc-400 bg-zinc-800 text-white' : 'border-zinc-800 text-zinc-400 hover:bg-zinc-800'"
        :title="CLASSIFICATION_LABEL[tab.value]"
        @click="toggleClassification(tab.value)"
      >
        <span class="h-2 w-2 rounded-full" :class="CLASSIFICATION_COLOR[tab.value]" /> {{ tab.count }}
      </button>
    </div>

    <div class="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-4">
      <p v-if="auth.unauthorized" class="m-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
        O gateway recusou a credencial. Informe os tokens em <RouterLink to="/settings" class="underline">Configuração</RouterLink>.
      </p>
      <p v-else-if="conversations.error" class="m-3 text-sm text-rose-300">{{ conversations.error }}</p>
      <p v-else-if="!conversations.loading && !conversations.items.length" class="m-6 text-center text-sm text-zinc-500">Nenhuma conversa{{ conversations.filters.q || conversations.filters.agentId ? ' com esse filtro' : ' ainda' }}.</p>

      <ConversationRow
        v-for="conversation in topLevel"
        :key="conversation.id"
        :conversation="conversation"
        :active="conversation.id === conversations.selectedId"
        :unread="conversations.unread.has(conversation.id)"
        :show-owner="auth.isAdmin"
      />
      <div ref="sentinel" class="h-6" />
      <p v-if="conversations.loading" class="py-2 text-center text-xs text-zinc-500">Carregando…</p>
    </div>
  </section>
</template>
