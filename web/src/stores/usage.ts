import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import type { IUsageFigure, IUsageSummary, IUserUsage } from '@/lib/types'

/** O fuso do navegador, como o gateway espera: minutos a SOMAR ao UTC (São Paulo: -180). */
const tz = () => -new Date().getTimezoneOffset()

export const useUsageStore = defineStore('usage', () => {
  function mine(days: number): Promise<IUsageSummary> {
    return api<IUsageSummary>('/usage/me', { query: { days, tz: tz() } })
  }

  function users(days: number): Promise<{ totals: IUsageFigure; users: IUserUsage[] }> {
    return api('/usage/users', { query: { days, tz: tz() } })
  }

  function user(ownerId: string, days: number): Promise<IUsageSummary & { ownerId: string; name?: string; email?: string }> {
    return api(`/usage/users/${encodeURIComponent(ownerId)}`, { query: { days, tz: tz() } })
  }

  return { mine, users, user }
})
