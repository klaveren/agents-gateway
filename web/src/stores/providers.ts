import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/lib/api'
import type { IProbeResult, IProviderStatus, TProvider } from '@/lib/types'

export const useProvidersStore = defineStore('providers', () => {
  const list = ref<IProviderStatus[]>([])

  async function load(): Promise<void> {
    list.value = await api<IProviderStatus[]>('/providers')
  }

  async function save(provider: TProvider, key: string): Promise<void> {
    await api(`/providers/${provider}/key`, { method: 'PUT', body: { key } })
    await load()
  }

  async function clear(provider: TProvider): Promise<void> {
    await api(`/providers/${provider}/key`, { method: 'DELETE' })
    await load()
  }

  /** Com `key`, testa a colada (antes de salvar); sem, a que está em vigor. */
  function test(provider: TProvider, key?: string): Promise<IProbeResult> {
    return api<IProbeResult>(`/providers/${provider}/test`, { method: 'POST', body: key ? { key } : {} })
  }

  return { list, load, save, clear, test }
})
