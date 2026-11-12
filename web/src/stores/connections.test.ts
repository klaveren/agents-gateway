import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useConnectionsStore, type IProjectConnection } from './connections'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

const connection = (projectId: string) =>
  ({ projectId, url: 'http://origem.test', updateAvailable: true, state: 'ok', changes: [], skipped: [], secrets: [], modelMap: {} }) as unknown as IProjectConnection

describe('useConnectionsStore — as conexões são de quem está logado', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api).mockReset()
  })

  it('⛔ `reset` esvazia a lista, e a leitura que estava no ar não escreve na conta seguinte', async () => {
    const store = useConnectionsStore()
    vi.mocked(api).mockResolvedValueOnce([connection('de-quem-saiu')] as never)
    await store.refresh()
    expect(store.list.map((one) => one.projectId)).toEqual(['de-quem-saiu'])

    let answer: (value: unknown) => void = () => undefined
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)) as never)
    const late = store.refresh()
    store.reset()
    expect(store.list).toEqual([])
    answer([connection('de-quem-saiu')])
    await late
    expect(store.list).toEqual([])

    vi.mocked(api).mockResolvedValueOnce([connection('de-quem-entrou')] as never)
    await store.refresh()
    expect(store.list.map((one) => one.projectId)).toEqual(['de-quem-entrou'])
  })
})
