<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import UsageSummaryView from '@/components/UsageSummaryView.vue'
import UsageTiles from '@/components/UsageTiles.vue'
import { tokens, usd } from '@/lib/format'
import type { IUsageFigure } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useUsageStore } from '@/stores/usage'

/**
 * O uso: o meu (só tokens) e, para o admin, o de cada usuário (com custo).
 * ⛔ O custo só existe na aba do admin — a rota do "meu uso" nem o devolve.
 */
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const usage = useUsageStore()
const projects = useProjectsStore()

const PERIODS = [7, 30, 90]
const days = ref(30)
/** O projeto do recorte (`?project=`, na URL para o link levar junto). Ausente = todos. */
const selectedProject = computed(() => (typeof route.query.project === 'string' && route.query.project ? route.query.project : undefined))
const tab = computed(() => (auth.isAdmin && (route.query.tab === 'users' || route.query.tab === 'keys') ? route.query.tab : 'mine'))
const selectedUser = computed(() => (typeof route.query.user === 'string' ? route.query.user : undefined))

/** A chave do `metadata` agrupada na aba "Por chave"; lembrada neste navegador. */
const KEY_STORAGE = 'usage.metadataKey'
const storedKey = () => {
  try {
    return localStorage.getItem(KEY_STORAGE) || 'accountId'
  } catch {
    return 'accountId'
  }
}
const metaKey = computed(() => (typeof route.query.key === 'string' && route.query.key ? route.query.key : storedKey()))
const keyDraft = ref(metaKey.value)
const selectedValue = computed(() => (typeof route.query.value === 'string' ? route.query.value : undefined))
const NO_VALUE = '~none'

// ⚠️ Os dados moram na store: ela descarta resposta velha e limpa o que era de outro usuário/chave/período.
const { mine, users, detail, groups, valueDetail, loading, error } = storeToRefs(usage)

function load() {
  if (!auth.signedIn) return usage.reset()
  return usage.load({ tab: tab.value, days: days.value, user: selectedUser.value, key: metaKey.value, value: selectedValue.value, project: selectedProject.value })
}

watch([days, tab, selectedUser, metaKey, selectedValue, selectedProject, () => auth.signedIn], () => void load(), { immediate: true })
// A lista do seletor: os projetos que a pessoa pode usar (o admin, todos).
watch(
  () => auth.signedIn,
  (signedIn) => {
    if (signedIn && !projects.loaded) void projects.load().catch(() => undefined)
  },
  { immediate: true },
)
watch(metaKey, (key) => (keyDraft.value = key))

function applyKey() {
  const key = keyDraft.value.trim()
  if (!key) return
  try {
    localStorage.setItem(KEY_STORAGE, key)
  } catch {
    /* sem armazenamento: vale só para esta visita */
  }
  void go({ key, value: undefined })
}

const cost = (item: IUsageFigure) => (item.costUsd === undefined ? '—' : `${item.costIsFloor ? '≥ ' : ''}${usd(item.costUsd)}`)
const go = (query: Record<string, string | undefined>) => router.replace({ query: { ...route.query, ...query } })
</script>

<template>
  <div v-if="!auth.signedIn" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <div>
      <p class="font-medium text-zinc-200">Entre para ver o seu uso.</p>
      <RouterLink v-if="auth.localAccounts" :to="{ path: '/login', query: { next: '/usage' } }" class="mt-3 inline-block rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950">Entrar</RouterLink>
    </div>
  </div>

  <div v-else class="scroll-thin h-full overflow-y-auto px-4 py-6">
    <div class="mx-auto flex max-w-5xl flex-col gap-4">
      <header class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 class="text-xl font-semibold">Uso</h1>
        <div v-if="auth.isAdmin" class="scroll-thin order-3 flex max-w-full gap-1 overflow-x-auto rounded-full bg-zinc-900 p-1 text-sm whitespace-nowrap sm:order-none">
          <button class="rounded-full px-3 py-1" :class="tab === 'mine' ? 'bg-zinc-700 text-white' : 'text-zinc-400'" @click="go({ tab: undefined, user: undefined })">Meu uso</button>
          <button class="rounded-full px-3 py-1" :class="tab === 'users' ? 'bg-zinc-700 text-white' : 'text-zinc-400'" @click="go({ tab: 'users', user: undefined })">Por usuário</button>
          <button class="rounded-full px-3 py-1" :class="tab === 'keys' ? 'bg-zinc-700 text-white' : 'text-zinc-400'" @click="go({ tab: 'keys', user: undefined, value: undefined })">Por chave</button>
        </div>
        <select
          v-if="projects.list.length > 1 || selectedProject"
          class="ml-auto rounded-full bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 ring-1 ring-zinc-800"
          aria-label="Projeto"
          :value="selectedProject ?? ''"
          @change="go({ project: ($event.target as HTMLSelectElement).value || undefined })"
        >
          <option value="">Todos os projetos</option>
          <option v-for="project in projects.list" :key="project.id" :value="project.id">{{ project.name }}</option>
        </select>
        <div class="flex shrink-0 gap-1 rounded-full bg-zinc-900 p-1 text-sm whitespace-nowrap" :class="projects.list.length > 1 || selectedProject ? '' : 'ml-auto'" role="group" aria-label="Período">
          <button v-for="period in PERIODS" :key="period" class="rounded-full px-3 py-1" :class="days === period ? 'bg-zinc-700 text-white' : 'text-zinc-400'" @click="days = period">{{ period }} dias</button>
        </div>
      </header>

      <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
      <p v-if="loading && !mine && !users && !detail && !groups && !valueDetail" class="text-sm text-zinc-500">Carregando…</p>

      <template v-if="tab === 'mine' && mine">
        <p class="text-xs text-zinc-500">Quanto você usou nas suas conversas. O custo aparece só para quem administra.</p>
        <UsageSummaryView :summary="mine" :show-cost="false" />
      </template>

      <template v-else-if="tab === 'keys' && selectedValue && valueDetail">
        <button class="self-start text-sm text-zinc-400 hover:text-zinc-100" @click="go({ value: undefined })">← Todos os valores de {{ metaKey }}</button>
        <h2 class="text-lg font-medium"><span class="font-mono text-sm text-zinc-500">{{ metaKey }} =</span> {{ selectedValue === NO_VALUE ? 'sem valor' : selectedValue }}</h2>
        <UsageSummaryView :summary="valueDetail" :show-cost="true" />
      </template>

      <template v-else-if="tab === 'keys'">
        <form class="flex flex-wrap items-center gap-2 text-sm" @submit.prevent="applyKey">
          <label class="text-zinc-400" for="metadata-key">Agrupar pelo campo</label>
          <input id="metadata-key" v-model="keyDraft" class="w-48 rounded-lg bg-zinc-900 px-2 py-1 font-mono text-zinc-100 ring-1 ring-zinc-800" placeholder="accountId" />
          <button class="rounded-full bg-zinc-800 px-3 py-1 text-zinc-100 hover:bg-zinc-700">Agrupar</button>
        </form>
        <template v-if="groups">
          <UsageTiles :figure="groups.totals" :show-cost="true">
            <div class="tile"><span class="tile-label">Valores</span><span class="tile-value">{{ groups.groups.filter((group) => group.value !== undefined).length }}</span></div>
          </UsageTiles>
          <p v-if="!groups.groups.length" class="text-sm text-zinc-500">Nenhum uso neste período.</p>
          <table v-else class="w-full overflow-hidden rounded-2xl border border-zinc-800 text-left text-sm">
            <thead class="bg-zinc-900 text-xs text-zinc-500">
              <tr><th class="px-4 py-2 font-medium">{{ groups.key }}</th><th class="font-medium">Conversas</th><th class="font-medium">Mensagens</th><th class="font-medium">Tokens</th><th class="pr-4 text-right font-medium">Custo</th></tr>
            </thead>
            <tbody>
              <tr v-for="group in groups.groups" :key="group.value ?? NO_VALUE" class="cursor-pointer border-t border-zinc-800 hover:bg-zinc-900/70" @click="go({ value: group.value ?? NO_VALUE })">
                <td class="px-4 py-2 font-mono" :class="group.value === undefined ? 'text-zinc-500' : 'text-zinc-200'">{{ group.value ?? 'sem valor' }}</td>
                <td class="tabular-nums text-zinc-300">{{ group.conversations }}</td>
                <td class="tabular-nums text-zinc-300">{{ group.turns }}</td>
                <td class="tabular-nums text-zinc-300">{{ tokens(group.usage.totalTokens) }}</td>
                <td class="pr-4 text-right tabular-nums text-zinc-100">{{ cost(group) }}</td>
              </tr>
            </tbody>
          </table>
        </template>
        <p class="text-xs text-zinc-500">
          Agrupa pelo campo que quem cria a conversa informa. Os valores não são conferidos.
        </p>
      </template>

      <template v-else-if="tab === 'users' && selectedUser && detail">
        <button class="self-start text-sm text-zinc-400 hover:text-zinc-100" @click="go({ user: undefined })">← Todos os usuários</button>
        <h2 class="text-lg font-medium">{{ detail.name ?? detail.email ?? (detail.ownerId === 'anonymous' ? 'Sem conta' : detail.ownerId) }} <span v-if="detail.name && detail.email" class="text-sm font-normal text-zinc-500">{{ detail.email }}</span></h2>
        <UsageSummaryView :summary="detail" :show-cost="true" />
      </template>

      <template v-else-if="tab === 'users' && users">
        <UsageTiles :figure="users.totals" :show-cost="true">
          <div class="tile"><span class="tile-label">Usuários</span><span class="tile-value">{{ users.users.length }}</span></div>
        </UsageTiles>
        <p v-if="!users.users.length" class="text-sm text-zinc-500">Nenhum uso neste período.</p>
        <table v-else class="w-full overflow-hidden rounded-2xl border border-zinc-800 text-left text-sm">
          <thead class="bg-zinc-900 text-xs text-zinc-500">
            <tr><th class="px-4 py-2 font-medium">Usuário</th><th class="font-medium">Conversas</th><th class="font-medium">Mensagens</th><th class="font-medium">Tokens</th><th class="pr-4 text-right font-medium">Custo</th></tr>
          </thead>
          <tbody>
            <tr v-for="user in users.users" :key="user.ownerId ?? 'anonymous'" class="cursor-pointer border-t border-zinc-800 hover:bg-zinc-900/70" @click="go({ user: user.ownerId ?? 'anonymous' })">
              <td class="px-4 py-2">
                <span class="block text-zinc-200">{{ user.name ?? user.email ?? (user.ownerId ? user.ownerId : 'Sem conta') }}</span>
                <span v-if="user.name && user.email" class="block text-xs text-zinc-500">{{ user.email }}</span>
              </td>
              <td class="tabular-nums text-zinc-300">{{ user.conversations }}</td>
              <td class="tabular-nums text-zinc-300">{{ user.turns }}</td>
              <td class="tabular-nums text-zinc-300">{{ tokens(user.usage.totalTokens) }}</td>
              <td class="pr-4 text-right tabular-nums text-zinc-100">{{ cost(user) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="text-xs text-zinc-500">Custo estimado. "≥" indica que algum modelo está sem preço e o valor real pode ser maior.</p>
      </template>
    </div>
  </div>
</template>
