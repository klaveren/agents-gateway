<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import UsageSummaryView from '@/components/UsageSummaryView.vue'
import { tokens, usd } from '@/lib/format'
import type { IUsageFigure, IUsageSummary, IUserUsage } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useUsageStore } from '@/stores/usage'

/**
 * O uso: o meu (só tokens) e, para o admin, o de cada usuário (com custo).
 * ⛔ O custo só existe na aba do admin — a rota do "meu uso" nem o devolve.
 */
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const usage = useUsageStore()

const PERIODS = [7, 30, 90]
const days = ref(30)
const tab = computed(() => (route.query.tab === 'users' && auth.isAdmin ? 'users' : 'mine'))
const selectedUser = computed(() => (typeof route.query.user === 'string' ? route.query.user : undefined))

const mine = ref<IUsageSummary>()
const users = ref<{ totals: IUsageFigure; users: IUserUsage[] }>()
const detail = ref<IUsageSummary & { ownerId: string; name?: string; email?: string }>()
const loading = ref(false)
const error = ref<string>()

async function load() {
  error.value = undefined
  loading.value = true
  try {
    if (tab.value === 'mine') mine.value = await usage.mine(days.value)
    else if (selectedUser.value) detail.value = await usage.user(selectedUser.value, days.value)
    else users.value = await usage.users(days.value)
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    loading.value = false
  }
}

watch([days, tab, selectedUser, () => auth.signedIn], () => void load(), { immediate: true })

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
    <div class="mx-auto flex max-w-4xl flex-col gap-4">
      <header class="flex flex-wrap items-center gap-3">
        <h1 class="text-xl font-semibold">Uso</h1>
        <div v-if="auth.isAdmin" class="flex gap-1 rounded-full bg-zinc-900 p-1 text-sm">
          <button class="rounded-full px-3 py-1" :class="tab === 'mine' ? 'bg-zinc-700 text-white' : 'text-zinc-400'" @click="go({ tab: undefined, user: undefined })">Meu uso</button>
          <button class="rounded-full px-3 py-1" :class="tab === 'users' ? 'bg-zinc-700 text-white' : 'text-zinc-400'" @click="go({ tab: 'users', user: undefined })">Por usuário</button>
        </div>
        <div class="ml-auto flex gap-1 rounded-full bg-zinc-900 p-1 text-sm" role="group" aria-label="Período">
          <button v-for="period in PERIODS" :key="period" class="rounded-full px-3 py-1" :class="days === period ? 'bg-zinc-700 text-white' : 'text-zinc-400'" @click="days = period">{{ period }} dias</button>
        </div>
      </header>

      <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
      <p v-if="loading && !mine && !users && !detail" class="text-sm text-zinc-500">Carregando…</p>

      <template v-if="tab === 'mine' && mine">
        <p class="text-xs text-zinc-500">Os tokens das suas conversas. O custo fica com quem administra o gateway.</p>
        <UsageSummaryView :summary="mine" :show-cost="false" />
      </template>

      <template v-else-if="tab === 'users' && selectedUser && detail">
        <button class="self-start text-sm text-zinc-400 hover:text-zinc-100" @click="go({ user: undefined })">← Todos os usuários</button>
        <h2 class="text-lg font-medium">{{ detail.name ?? detail.email ?? (detail.ownerId === 'anonymous' ? 'Sem conta (anônimo)' : detail.ownerId) }} <span v-if="detail.name && detail.email" class="text-sm font-normal text-zinc-500">{{ detail.email }}</span></h2>
        <UsageSummaryView :summary="detail" :show-cost="true" />
      </template>

      <template v-else-if="tab === 'users' && users">
        <div class="grid grid-cols-3 gap-3">
          <div class="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4"><span class="block text-xs text-zinc-500">Custo estimado</span><span class="text-2xl font-semibold tabular-nums">{{ cost(users.totals) }}</span></div>
          <div class="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4"><span class="block text-xs text-zinc-500">Tokens</span><span class="text-2xl font-semibold tabular-nums">{{ tokens(users.totals.usage.totalTokens) }}</span></div>
          <div class="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4"><span class="block text-xs text-zinc-500">Usuários</span><span class="text-2xl font-semibold tabular-nums">{{ users.users.length }}</span></div>
        </div>
        <p v-if="!users.users.length" class="text-sm text-zinc-500">Nenhum uso neste período.</p>
        <table v-else class="w-full overflow-hidden rounded-2xl border border-zinc-800 text-left text-sm">
          <thead class="bg-zinc-900 text-xs text-zinc-500">
            <tr><th class="px-4 py-2 font-medium">Usuário</th><th class="font-medium">Conversas</th><th class="font-medium">Turnos</th><th class="font-medium">Tokens</th><th class="pr-4 text-right font-medium">Custo</th></tr>
          </thead>
          <tbody>
            <tr v-for="user in users.users" :key="user.ownerId ?? 'anonymous'" class="cursor-pointer border-t border-zinc-800 hover:bg-zinc-900/70" @click="go({ user: user.ownerId ?? 'anonymous' })">
              <td class="px-4 py-2">
                <span class="block text-zinc-200">{{ user.name ?? user.email ?? (user.ownerId ? user.ownerId : 'Sem conta (anônimo)') }}</span>
                <span v-if="user.name && user.email" class="block text-xs text-zinc-500">{{ user.email }}</span>
              </td>
              <td class="tabular-nums text-zinc-300">{{ user.conversations }}</td>
              <td class="tabular-nums text-zinc-300">{{ user.turns }}</td>
              <td class="tabular-nums text-zinc-300">{{ tokens(user.usage.totalTokens) }}</td>
              <td class="pr-4 text-right tabular-nums text-zinc-100">{{ cost(user) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="text-xs text-zinc-500">Custo estimado pelos preços do catálogo (Providers → Modelos). "≥" = algum modelo sem preço: o valor é um piso.</p>
      </template>
    </div>
  </div>
</template>
