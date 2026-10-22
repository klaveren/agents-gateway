import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/lib/api'
import type { IUser, TUserRole } from '@/lib/types'

export const useUsersStore = defineStore('users', () => {
  const list = ref<IUser[]>([])

  async function load(): Promise<void> {
    list.value = await api<IUser[]>('/users')
  }

  async function create(input: { email: string; name: string; password: string; role: TUserRole }): Promise<IUser> {
    const created = await api<IUser>('/users', { method: 'POST', body: input })
    await load()
    return created
  }

  async function update(id: string, change: { name?: string; role?: TUserRole; disabled?: boolean }): Promise<void> {
    await api(`/users/${encodeURIComponent(id)}`, { method: 'PUT', body: change })
    await load()
  }

  function resetPassword(id: string, password: string): Promise<unknown> {
    return api(`/users/${encodeURIComponent(id)}/password`, { method: 'POST', body: { password } })
  }

  function revokeSessions(id: string): Promise<unknown> {
    return api(`/users/${encodeURIComponent(id)}/sessions`, { method: 'DELETE' })
  }

  return { list, load, create, update, resetPassword, revokeSessions }
})
