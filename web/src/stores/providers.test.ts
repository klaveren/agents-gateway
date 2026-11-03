import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import type { ICatalogModel, IProviderStatus } from '@/lib/types'
import { useProvidersStore } from './providers'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

const model = (modelId: string, enabled: boolean): ICatalogModel => ({ modelId, enabled, available: true, updatedAt: '' })
const provider = (id: string, name: string): IProviderStatus =>
  ({ id, name, protocol: 'openai', official: true, enabled: true, credential: { configured: true, source: 'stored' }, models: [], agents: [] }) as IProviderStatus

describe('useProvidersStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api).mockReset()
  })

  it('os modelos de um provider são lidos uma vez, por mais telas que peçam', async () => {
    vi.mocked(api).mockResolvedValue([model('m1', true)] as never)
    const providers = useProvidersStore()
    await Promise.all([providers.models('openai'), providers.models('openai')])
    await providers.models('openai')

    expect(api).toHaveBeenCalledTimes(1)
    expect(providers.catalogs.get('openai')?.map((one) => one.modelId)).toEqual(['m1'])
  })

  it('o preço gravado troca a linha no catálogo guardado, sem reler os modelos', async () => {
    vi.mocked(api).mockResolvedValueOnce([model('m1', true), model('m2', false)] as never)
    const providers = useProvidersStore()
    await providers.models('openai')
    vi.mocked(api).mockResolvedValueOnce({ ...model('m2', false), price: { input: 1, output: 2 } } as never)
    await providers.updateModel('openai', { modelId: 'm2', price: { input: 1, output: 2 } })

    expect(providers.catalogs.get('openai')?.find((one) => one.modelId === 'm2')?.price).toEqual({ input: 1, output: 2 })
    expect(api).toHaveBeenCalledTimes(2)
  })

  it('criar põe o provider devolvido na lista, sem reler', async () => {
    vi.mocked(api).mockResolvedValueOnce([provider('openai', 'OpenAI')] as never)
    const providers = useProvidersStore()
    await providers.ensure()
    vi.mocked(api).mockResolvedValueOnce(provider('groq', 'Groq') as never)
    await providers.create({ id: 'groq', name: 'Groq', protocol: 'openai', baseUrl: 'https://api.groq.com' })

    expect(providers.list.map((one) => one.id)).toEqual(['openai', 'groq'])
    expect(api).toHaveBeenCalledTimes(2)
  })
})
