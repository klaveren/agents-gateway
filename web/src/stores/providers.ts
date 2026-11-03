import { defineStore } from 'pinia'
import { computed } from 'vue'
import { api } from '@/lib/api'
import { keyedResource } from '@/lib/resource'
import type { ICatalogModel, IModelPrice, IProbeResult, IProviderStatus, ISubscriptionLogin, TProvider } from '@/lib/types'
import { useAgentsStore } from './agents'

export interface INewProvider {
  id: string
  name: string
  protocol: TProvider
  baseUrl: string
  key?: string
}

/**
 * Os providers (só admin): a lista (`catalog`, chave única `''`) e os modelos de cada um (`catalogs`, a chave é o id do
 * provider). A gravação põe a resposta do servidor na store, sem reler a lista inteira.
 */
export const useProvidersStore = defineStore('providers', () => {
  const catalog = keyedResource(() => api<IProviderStatus[]>('/providers'))
  const catalogs = keyedResource((id) => api<ICatalogModel[]>(`/providers/${encodeURIComponent(id)}/models`))

  const list = computed<IProviderStatus[]>({
    get: () => catalog.get('') ?? [],
    set: (value) => catalog.set('', value),
  })
  const loaded = computed(() => catalog.has(''))
  const names = computed(() => new Map(list.value.map((provider) => [provider.id, provider.name])))

  async function load(): Promise<void> {
    await catalog.refresh('')
  }

  async function ensure(): Promise<void> {
    await catalog.ensure('')
  }

  /** Troca (ou acrescenta) o provider na lista, como o servidor o devolveu. */
  function put(provider: IProviderStatus): void {
    catalog.update('', (current) => (current.some((one) => one.id === provider.id) ? current.map((one) => (one.id === provider.id ? provider : one)) : [...current, provider]))
  }

  /** Troca (ou acrescenta) o modelo no catálogo do provider. */
  function putModel(id: string, model: ICatalogModel): void {
    catalogs.update(id, (current) =>
      current.some((one) => one.modelId === model.modelId) ? current.map((one) => (one.modelId === model.modelId ? model : one)) : [...current, model],
    )
  }

  /** ⚖️ Os agentes dependem do provider e dos modelos dele: depois de mudar um, os agentes são relidos. O erro aqui não derruba a ação que já deu certo. */
  async function reloadAgents(): Promise<void> {
    await useAgentsStore()
      .reloadAll()
      .catch(() => undefined)
  }

  async function create(input: INewProvider): Promise<void> {
    put(await api<IProviderStatus>('/providers', { method: 'POST', body: input }))
  }

  async function update(id: string, change: { name?: string; baseUrl?: string; enabled?: boolean }): Promise<void> {
    put(await api<IProviderStatus>(`/providers/${encodeURIComponent(id)}`, { method: 'PUT', body: change }))
    await reloadAgents()
  }

  async function remove(id: string): Promise<void> {
    await api(`/providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
    catalog.update('', (current) => current.filter((one) => one.id !== id))
    catalogs.drop(id)
    await reloadAgents()
  }

  async function save(id: string, key: string): Promise<void> {
    put(await api<IProviderStatus>(`/providers/${encodeURIComponent(id)}/key`, { method: 'PUT', body: { key } }))
    await reloadAgents()
  }

  async function clear(id: string): Promise<void> {
    put(await api<IProviderStatus>(`/providers/${encodeURIComponent(id)}/key`, { method: 'DELETE' }))
    await reloadAgents()
  }

  /** Com `key`, testa a colada (antes de salvar); sem, a que está em vigor. */
  function test(id: string, key?: string): Promise<IProbeResult> {
    return api<IProbeResult>(`/providers/${encodeURIComponent(id)}/test`, { method: 'POST', body: key ? { key } : {} })
  }

  /** Os modelos do provider: os guardados, ou lidos uma vez. */
  function models(id: string): Promise<ICatalogModel[]> {
    return catalogs.ensure(id)
  }

  async function syncModels(id: string): Promise<{ added: number; updated: number; missing: number; total: number; models: ICatalogModel[] }> {
    const result = await api<{ added: number; updated: number; missing: number; total: number; models: ICatalogModel[] }>(`/providers/${encodeURIComponent(id)}/models/sync`, {
      method: 'POST',
    })
    catalogs.set(id, result.models)
    // A contagem do catálogo na lista mudou, e a resposta não a traz.
    await load().catch(() => undefined)
    return result
  }

  /** Liga/desliga e/ou define o preço manual (`price: null` volta ao sugerido). */
  async function updateModel(id: string, change: { modelId: string; enabled?: boolean; price?: IModelPrice | null }): Promise<ICatalogModel> {
    const model = await api<ICatalogModel>(`/providers/${encodeURIComponent(id)}/models`, { method: 'PUT', body: change })
    putModel(id, model)
    if (change.enabled !== undefined) {
      await load().catch(() => undefined)
      await reloadAgents()
    }
    return model
  }

  /** Adiciona um modelo pelo id (vale para qualquer provider, inclusive assinatura sem listagem): entra desligado, com preço sugerido. Idempotente. */
  async function addModel(id: string, modelId: string): Promise<ICatalogModel> {
    const model = await api<ICatalogModel>(`/providers/${encodeURIComponent(id)}/models`, { method: 'POST', body: { modelId } })
    putModel(id, model)
    await load().catch(() => undefined)
    return model
  }

  /** O login de uma assinatura pela tela: começar, ver o estado, colar o código, cancelar. ⚖️ Estado ao vivo: lido na hora, não guardado. */
  function login(id: string, action: 'status' | 'start' | 'cancel'): Promise<ISubscriptionLogin> {
    const method = action === 'start' ? 'POST' : action === 'cancel' ? 'DELETE' : 'GET'
    return api<ISubscriptionLogin>(`/providers/${encodeURIComponent(id)}/login`, { method })
  }

  function loginCode(id: string, code: string): Promise<ISubscriptionLogin> {
    return api<ISubscriptionLogin>(`/providers/${encodeURIComponent(id)}/login/code`, { method: 'POST', body: { code } })
  }

  /** Esquece o que é de quem administrava (logout). */
  function reset(): void {
    catalog.clear()
    catalogs.clear()
  }

  return { catalog, catalogs, list, loaded, names, load, ensure, create, update, remove, save, clear, test, models, syncModels, updateModel, addModel, login, loginCode, reset }
})
