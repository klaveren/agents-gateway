import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import { keyedResource } from '@/lib/resource'
import type { ISession } from '@/lib/types'

/** Uma sessão de login aberta como a lista a traz: ⛔ nunca o token, só o aparelho e as datas. */
export interface ILoginSession {
  id: string
  /** Navegador e aparelho, resumidos do user-agent (`Safari · iPhone`). */
  device: string
  keepSignedIn: boolean
  createdAt: string
  lastUsedAt: string
  expiresAt: string
  /** A sessão desta tela. */
  current: boolean
}

/** As sessões de login abertas da conta (a chave é o id da conta). Encerrar relê a lista. */
export const useSessionsStore = defineStore('sessions', () => {
  const lists = keyedResource(() => api<ILoginSession[]>('/auth/sessions'))

  async function end(userId: string, id: string): Promise<void> {
    await api(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await lists.refresh(userId).catch(() => undefined)
  }

  /** Encerra as outras; esta continua (o gateway grava o cookie novo). */
  async function endOthers(userId: string): Promise<void> {
    await api<ISession>('/auth/sessions', { method: 'DELETE' })
    await lists.refresh(userId).catch(() => undefined)
  }

  return { lists, end, endOthers }
})
