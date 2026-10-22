import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '@/lib/api'
import type { ICatalogModel, IModelPrice, IProbeResult, IProviderStatus, TProvider } from '@/lib/types'

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

  function models(id: string): Promise<ICatalogModel[]> {
    return api<ICatalogModel[]>(`/providers/${encodeURIComponent(id)}/models`)
  }

  async function syncModels(id: string): Promise<{ added: number; updated: number; missing: number; total: number; models: ICatalogModel[] }> {
    const result = await api<{ added: number; updated: number; missing: number; total: number; models: ICatalogModel[] }>(`/providers/${encodeURIComponent(id)}/models/sync`, { method: 'POST' })
    await load()
    return result
  }

  /** Liga/desliga e/ou define o preço manual (`price: null` volta ao sugerido). */
  async function updateModel(id: string, change: { modelId: string; enabled?: boolean; price?: IModelPrice | null }): Promise<ICatalogModel> {
    const model = await api<ICatalogModel>(`/providers/${encodeURIComponent(id)}/models`, { method: 'PUT', body: change })
    if (change.enabled !== undefined) await load()
    return model
  }

  return { list, names, load, create, update, remove, save, clear, test, models, syncModels, updateModel }
})
