import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import type { IImportJob, IImportJobSummary } from '@/lib/importer'
import { jobKey, useImportsStore } from './imports'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

const ITEMS = '/projects/alfa/import/jobs/j1/items'
const draft = { ops: [], removals: [] }

/** O trabalho leve, como o servidor manda: sem rascunho, só `drafted`. */
function leanJob(states: IImportJob['states']): IImportJob {
  return {
    id: 'j1',
    projectId: 'alfa',
    repository: 'app',
    scannedAt: '2026-11-03T10:00:00.000Z',
    by: 'ana',
    items: states.length,
    byState: {},
    latest: true,
    gone: 0,
    analyses: [],
    scan: {} as IImportJob['scan'],
    states,
  }
}

const itemCalls = () => vi.mocked(api).mock.calls.filter(([path]) => path === ITEMS)

describe('useImportsStore — o estado dos itens numa cópia só', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api).mockReset()
  })

  it('duas telas pedindo as mesmas chaves juntas fazem uma chamada só; a chave já completa não volta ao servidor', async () => {
    let release: (value: unknown) => void = () => undefined
    vi.mocked(api).mockReturnValueOnce(new Promise((resolve) => (release = resolve)) as never)
    const imports = useImportsStore()
    const both = Promise.all([imports.ensureItems('alfa', 'j1', ['a', 'b']), imports.ensureItems('alfa', 'j1', ['b', 'a'])])
    release({
      latest: true,
      states: [
        { key: 'a', state: 'review', fingerprint: 'f', drafts: [draft] },
        { key: 'b', state: 'pending', fingerprint: 'f' },
      ],
    })
    await both
    expect(itemCalls()).toEqual([[ITEMS, { query: { keys: ['a', 'b'] } }]])
    expect(imports.statesOf('alfa', 'j1').a.drafts).toEqual([draft])

    vi.mocked(api).mockResolvedValueOnce({ latest: true, states: [{ key: 'c', state: 'pending', fingerprint: 'f' }] })
    await imports.ensureItems('alfa', 'j1', ['a', 'c'])
    expect(itemCalls().at(-1)).toEqual([ITEMS, { query: { keys: ['c'] } }])
  })

  it('a gravação aparece para todo leitor e refaz a contagem da linha do trabalho; reclassificar substitui o item', async () => {
    const imports = useImportsStore()
    const summary: IImportJobSummary = { ...leanJob([]), byState: { drafting: 1 } }
    vi.mocked(api).mockResolvedValueOnce([summary])
    await imports.jobs.ensure('alfa')
    vi.mocked(api).mockResolvedValueOnce(leanJob([{ key: 'a', state: 'drafting', fingerprint: 'f', conversationId: 'c1' } as IImportJob['states'][number]]))
    await imports.job.ensure(jobKey('alfa', 'j1'))
    const reader = () => imports.statesOf('alfa', 'j1').a

    vi.mocked(api).mockResolvedValueOnce({ key: 'a', state: 'pending', kind: 'spec', fingerprint: 'f' })
    await imports.updateItem('alfa', 'j1', 'a', { kind: 'spec' })
    expect(reader()).toEqual({ key: 'a', state: 'pending', kind: 'spec', fingerprint: 'f', drafted: false })
    expect(imports.jobs.get('alfa')![0].byState).toEqual({ pending: 1 })
  })

  it('o estado leve do trabalho não apaga o rascunho já lido; o item que mudou depois volta a ser buscado inteiro', async () => {
    const imports = useImportsStore()
    vi.mocked(api).mockResolvedValueOnce({ latest: true, states: [{ key: 'a', state: 'review', fingerprint: 'f', at: 't1', drafts: [draft] }] })
    await imports.ensureItems('alfa', 'j1', ['a'])

    // A mesma hora: o rascunho fica e o item segue completo (nada a buscar).
    vi.mocked(api).mockResolvedValueOnce(leanJob([{ key: 'a', state: 'review', fingerprint: 'f', at: 't1', drafted: true }]))
    await imports.job.refresh(jobKey('alfa', 'j1'))
    expect(imports.statesOf('alfa', 'j1').a.drafts).toEqual([draft])
    await imports.ensureItems('alfa', 'j1', ['a'])
    expect(itemCalls()).toHaveLength(1)

    // Mudou depois: o estado novo vale já, o rascunho guardado fica até a busca, e a próxima `ensureItems` busca.
    vi.mocked(api).mockResolvedValueOnce(leanJob([{ key: 'a', state: 'approved', fingerprint: 'f', at: 't2', drafted: true }]))
    await imports.job.refresh(jobKey('alfa', 'j1'))
    expect(imports.statesOf('alfa', 'j1').a).toMatchObject({ state: 'approved', drafts: [draft] })
    vi.mocked(api).mockResolvedValueOnce({ latest: true, states: [{ key: 'a', state: 'approved', fingerprint: 'f', at: 't2', drafts: [draft, draft] }] })
    await imports.ensureItems('alfa', 'j1', ['a'])
    expect(itemCalls()).toHaveLength(2)
    expect(imports.statesOf('alfa', 'j1').a.drafts).toHaveLength(2)
  })

  it('a leitura que volta depois de uma gravação não passa por cima dela', async () => {
    const imports = useImportsStore()
    let release: (value: unknown) => void = () => undefined
    vi.mocked(api).mockReturnValueOnce(new Promise((resolve) => (release = resolve)) as never)
    const reading = imports.refreshItems('alfa', 'j1', ['a'])
    vi.mocked(api).mockResolvedValueOnce({ key: 'a', state: 'approved', fingerprint: 'f' })
    await imports.review('alfa', 'j1', 'a', 'approve', { removals: [] })
    release({ latest: true, states: [{ key: 'a', state: 'review', fingerprint: 'f' }] })
    await reading
    expect(imports.statesOf('alfa', 'j1').a.state).toBe('approved')
  })
})
