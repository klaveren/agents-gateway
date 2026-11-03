import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { CATALOG_SYNC_MS, catalogChanged } from './catalogSync'
import { useDocsStore } from './docs'
import { useRulesStore } from './rules'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

describe('catalogSync — o catálogo mudou no servidor', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(async (path: string) => (path.startsWith('/docs/') ? { id: 'arq', title: 'Arq' } : []) as never)
  })
  afterEach(() => vi.useRealTimers())

  const calls = (prefix: string) => vi.mocked(api).mock.calls.filter(([path]) => String(path).startsWith(prefix)).length

  it('as listas já lidas do tipo são relidas, juntas, depois de um instante; o detalhe aberto só fica velho', async () => {
    const docs = useDocsStore()
    const rules = useRulesStore()
    await docs.lists.ensure(docs.listKey('alfa'))
    await docs.details.ensure('arq')
    await rules.lists.ensure('alfa')
    expect([calls('/docs'), calls('/rules')]).toEqual([2, 1])

    catalogChanged([{ kind: 'spec', id: 'arq', projectId: 'alfa', op: 'update' }])
    catalogChanged([{ kind: 'knowledge', id: 'k', projectId: 'alfa', op: 'create' }])
    expect(calls('/docs')).toBe(2)
    await vi.advanceTimersByTimeAsync(CATALOG_SYNC_MS)
    // Uma releitura da lista (os dois avisos juntos); o detalhe fica na tela, sem buscar; as rules não mudaram.
    expect([calls('/docs?'), calls('/docs'), calls('/rules')]).toEqual([0, 3, 1])
    expect(docs.details.get('arq')).toEqual({ id: 'arq', title: 'Arq' })
    // Aberto de novo, o detalhe velho é buscado.
    await docs.details.ensure('arq')
    expect(calls('/docs/arq')).toBe(2)
  })
})
