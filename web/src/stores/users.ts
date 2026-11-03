import { defineStore } from 'pinia'
import { computed } from 'vue'
import { api } from '@/lib/api'
import { keyedResource } from '@/lib/resource'
import type { IUser, TUserRole } from '@/lib/types'

/** As contas (só admin), chave única `''`. A gravação põe a conta devolvida na lista, sem reler. */
export const useUsersStore = defineStore('users', () => {
  const accounts = keyedResource(() => api<IUser[]>('/users'))
  const list = computed<IUser[]>({
    get: () => accounts.get('') ?? [],
    set: (value) => accounts.set('', value),
  })
  const loaded = computed(() => accounts.has(''))

  async function load(): Promise<void> {
    await accounts.refresh('')
  }

  async function ensure(): Promise<void> {
    await accounts.ensure('')
  }

  function put(user: IUser): void {
    accounts.update('', (current) => (current.some((one) => one.id === user.id) ? current.map((one) => (one.id === user.id ? user : one)) : [...current, user]))
  }

  async function create(input: { email: string; name: string; password: string; role: TUserRole }): Promise<IUser> {
    const created = await api<IUser>('/users', { method: 'POST', body: input })
    put(created)
    return created
  }

  async function update(id: string, change: { name?: string; role?: TUserRole; disabled?: boolean }): Promise<void> {
    put(await api<IUser>(`/users/${encodeURIComponent(id)}`, { method: 'PUT', body: change }))
  }

  function resetPassword(id: string, password: string): Promise<unknown> {
    return api(`/users/${encodeURIComponent(id)}/password`, { method: 'POST', body: { password } })
  }

  function revokeSessions(id: string): Promise<unknown> {
    return api(`/users/${encodeURIComponent(id)}/sessions`, { method: 'DELETE' })
  }

  /** Esquece o que é de quem administrava (logout). */
  function reset(): void {
    accounts.clear()
  }

  return { accounts, list, loaded, load, ensure, create, update, resetPassword, revokeSessions, reset }
})
