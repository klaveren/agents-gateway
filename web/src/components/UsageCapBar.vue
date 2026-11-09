<script setup lang="ts">
  import { computed, onMounted, ref } from 'vue'
  import { api } from '@/lib/api'
  import { tokens, usd } from '@/lib/format'

  /**
   * O teto de uso do mês contra o consumo (`/usage/cap`): só aparece com teto configurado. Quem administra o gateway vê
   * o do gateway e o seu, em US$ e tokens; quem não administra vê os seus tokens e só a porcentagem do teto em US$.
   */
  interface ISpent {
    costUsd?: number
    tokens: number
    costPercent?: number
    /** Algum modelo usado não tem preço: o custo é um piso. */
    costIsFloor?: boolean
  }
  interface ICapStatus {
    caps: { monthlyCostUsd?: number; userMonthlyCostUsd?: number; monthlyTokens?: number; userMonthlyTokens?: number }
    gateway?: ISpent
    user?: ISpent
    reached?: { scope: 'gateway' | 'user'; kind: 'cost' | 'tokens' }
  }

  const status = ref<ICapStatus>()
  onMounted(async () => {
    status.value = await api<ICapStatus>('/usage/cap').catch(() => undefined)
  })

  const percent = (used: number | undefined, cap: number | undefined) => (cap && used !== undefined ? Math.min(Math.round((used / cap) * 100), 100) : undefined)

  const rows = computed(() => {
    const value = status.value
    if (!value) return []
    const { caps, gateway, user } = value
    const all: Array<{ label: string; used: string; cap: string; percent: number }> = []
    const add = (label: string, used: string, cap: string, share: number | undefined) => share !== undefined && all.push({ label, used, cap, percent: share })
    if (gateway) {
      add('Gateway · custo', `${gateway.costIsFloor ? '≥ ' : ''}${usd(gateway.costUsd)}`, usd(caps.monthlyCostUsd), percent(gateway.costUsd, caps.monthlyCostUsd))
      add('Gateway · tokens', tokens(gateway.tokens), tokens(caps.monthlyTokens), percent(gateway.tokens, caps.monthlyTokens))
    }
    if (user) {
      if (user.costUsd !== undefined) add('Você · custo', `${user.costIsFloor ? '≥ ' : ''}${usd(user.costUsd)}`, usd(caps.userMonthlyCostUsd), percent(user.costUsd, caps.userMonthlyCostUsd))
      else if (user.costPercent !== undefined) add('Você · custo', `${user.costPercent}%`, 'do teto', user.costPercent)
      add('Você · tokens', tokens(user.tokens), tokens(caps.userMonthlyTokens), percent(user.tokens, caps.userMonthlyTokens))
    }
    return all
  })
  /** O teto em US$ está ligado e o custo é piso: avisa que ele pode não disparar. */
  const floorWarning = computed(() => {
    const value = status.value
    if (!value) return false
    const costCap = value.caps.monthlyCostUsd !== undefined || value.caps.userMonthlyCostUsd !== undefined
    return costCap && (!!value.gateway?.costIsFloor || !!value.user?.costIsFloor)
  })
</script>

<template>
  <section v-if="rows.length" class="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4" aria-label="Teto de uso do mês">
    <h2 class="text-sm font-medium text-zinc-300">Teto de uso do mês</h2>
    <div v-for="row in rows" :key="row.label" class="flex flex-col gap-1">
      <div class="flex items-baseline justify-between gap-3 text-xs">
        <span class="text-zinc-400">{{ row.label }}</span>
        <span class="tabular-nums text-zinc-300">{{ row.used }} de {{ row.cap }} · {{ row.percent }}%</span>
      </div>
      <div class="h-1.5 overflow-hidden rounded-full bg-zinc-800">
        <div class="h-full rounded-full" :class="row.percent >= 100 ? 'bg-rose-500' : row.percent >= 80 ? 'bg-amber-400' : 'bg-emerald-500'" :style="{ width: `${row.percent}%` }" />
      </div>
    </div>
    <p v-if="floorWarning" class="text-xs text-amber-300">
      ⚠ Há modelo usado sem preço cadastrado: o custo aparece menor do que é, e o teto em US$ pode não disparar. Cadastre os preços em Modelos.
    </p>
    <p v-if="status?.reached" class="text-xs text-rose-300">
      {{ status.reached.scope === 'gateway' ? 'O gateway atingiu' : 'Você atingiu' }} o teto do mês: novas mensagens voltam no dia 1º, ou quando quem administra aumentar o teto.
    </p>
  </section>
</template>
