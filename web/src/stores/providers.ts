import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '@/lib/api'
import type { IProbeResult, IProviderStatus, TProvider } from '@/lib/types'

export interface INewProvider {
  id: string
  name: string
  protocol: TProvider
  baseUrl: string
  key?: string
}

export const useProvidersStore = defineStore('providers', () => {
  const list = ref<IProviderStatus[]>([])
  const names = computed(() => new Map(list.value.map((provider) => [provider.id, provider.name])))

  async function load(): Promise<void> {
    list.value = await api<IProviderStatus[]>('/providers')
  }

  async function create(input: INewProvider): Promise<void> {
    await api('/providers', { method: 'POST', body: input })
    await load()
  }

  async function update(id: string, change: { name?: string; baseUrl?: string; enabled?: boolean }): Promise<void> {
    await api(`/providers/${encodeURIComponent(id)}`, { method: 'PUT', body: change })
    await load()
  }

  async function remove(id: string): Promise<void> {
    await api(`/providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await load()
  }

  async function save(id: string, key: string): Promise<void> {
    await api(`/providers/${encodeURIComponent(id)}/key`, { method: 'PUT', body: { key } })
    await load()
  }

  async function clear(id: string): Promise<void> {
    await api(`/providers/${encodeURIComponent(id)}/key`, { method: 'DELETE' })
    await load()
  }

  /** Com `key`, testa a colada (antes de salvar); sem, a que está em vigor. */
  function test(id: string, key?: string): Promise<IProbeResult> {
    return api<IProbeResult>(`/providers/${encodeURIComponent(id)}/test`, { method: 'POST', body: key ? { key } : {} })
  }

  return { list, names, load, create, update, remove, save, clear, test }
})
