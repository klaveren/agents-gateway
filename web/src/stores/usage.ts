import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/lib/api'
import type { IGroupUsage, IUsageFigure, IUsageSummary, IUserUsage } from '@/lib/types'

/** O fuso do navegador, como o gateway espera: minutos a SOMAR ao UTC (São Paulo: -180). */
const tz = () => -new Date().getTimezoneOffset()

/** O que a tela de uso quer ver: a aba, o período e — conforme a aba — o usuário, a chave e o valor. */
export interface IUsageTarget {
  tab: 'mine' | 'users' | 'keys'
  days: number
  user?: string
  key?: string
  value?: string
  /** Só as conversas deste projeto. Ausente = todos. */
  project?: string
}

export const useUsageStore = defineStore('usage', () => {
  const mine = ref<IUsageSummary>()
  const users = ref<{ totals: IUsageFigure; users: IUserUsage[] }>()
  const detail = ref<IUsageSummary & { ownerId: string; name?: string; email?: string }>()
  const groups = ref<{ key: string; totals: IUsageFigure; groups: IGroupUsage[] }>()
  const valueDetail = ref<IUsageSummary & { key: string; value?: string }>()
  const loading = ref(false)
  const error = ref<string>()

  /** ⚠️ Cada carga ganha um número; resposta de carga antiga (troca rápida de usuário, chave ou período) é descartada. */
  let generation = 0

  function fetchMine(days: number, scope: Record<string, string> = {}): Promise<IUsageSummary> {
    return api<IUsageSummary>('/usage/me', { query: { days, tz: tz(), ...scope } })
  }

  function fetchUsers(days: number, scope: Record<string, string> = {}): Promise<{ totals: IUsageFigure; users: IUserUsage[] }> {
    return api('/usage/users', { query: { days, tz: tz(), ...scope } })
  }

  function fetchUser(ownerId: string, days: number, scope: Record<string, string> = {}): Promise<IUsageSummary & { ownerId: string; name?: string; email?: string }> {
    return api(`/usage/users/${encodeURIComponent(ownerId)}`, { query: { days, tz: tz(), ...scope } })
  }

  /** Os valores de uma chave do `metadata`, com custo. Só admin. */
  function fetchByKey(key: string, days: number, scope: Record<string, string> = {}): Promise<{ key: string; totals: IUsageFigure; groups: IGroupUsage[] }> {
    return api(`/usage/by/${encodeURIComponent(key)}`, { query: { days, tz: tz(), ...scope } })
  }

  /** O detalhe de um valor; `~none` = as conversas sem a chave. */
  function fetchByKeyValue(key: string, value: string, days: number, scope: Record<string, string> = {}): Promise<IUsageSummary & { key: string; value?: string }> {
    return api(`/usage/by/${encodeURIComponent(key)}/${encodeURIComponent(value)}`, { query: { days, tz: tz(), ...scope } })
  }

  function clear(): void {
    mine.value = undefined
    users.value = undefined
    detail.value = undefined
    groups.value = undefined
    valueDetail.value = undefined
  }

  /** Esquece tudo (logout) e invalida o que ainda está a caminho. */
  function reset(): void {
    generation++
    clear()
    loading.value = false
    error.value = undefined
  }

  /**
   * Carrega o alvo. ⚠️ Limpa antes: enquanto o novo usuário/chave carrega, a tela não mostra os números do
   * anterior como se fossem dele.
   */
  async function load(target: IUsageTarget): Promise<void> {
    const mineGeneration = ++generation
    clear()
    error.value = undefined
    loading.value = true
    try {
      const { tab, days } = target
      // O projeto escolhido recorta tudo (o `metadata.project` da conversa).
      const scope: Record<string, string> = target.project ? { project: target.project } : {}
      if (tab === 'mine') {
        const result = await fetchMine(days, scope)
        if (mineGeneration === generation) mine.value = result
      } else if (tab === 'keys') {
        const key = target.key ?? ''
        if (target.value) {
          const result = await fetchByKeyValue(key, target.value, days, scope)
          if (mineGeneration === generation) valueDetail.value = result
        } else {
          const result = await fetchByKey(key, days, scope)
          if (mineGeneration === generation) groups.value = result
        }
      } else if (target.user) {
        const result = await fetchUser(target.user, days, scope)
        if (mineGeneration === generation) detail.value = result
      } else {
        const result = await fetchUsers(days, scope)
        if (mineGeneration === generation) users.value = result
      }
    } catch (failure) {
      if (mineGeneration === generation) error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      if (mineGeneration === generation) loading.value = false
    }
  }

  return { mine, users, detail, groups, valueDetail, loading, error, load, reset }
})
