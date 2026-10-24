import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useUsageStore } from './usage'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))

const summary = (turns: number) => ({ totals: { turns } })

/** Uma resposta que o teste resolve na hora que quiser. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => ((resolve = done), (reject = fail)))
  return { promise, resolve, reject }
}

describe('useUsageStore.load', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api).mockReset()
  })

  it('descarta a resposta antiga quando o usuário muda no meio da carga', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    vi.mocked(api).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const usage = useUsageStore()

    const a = usage.load({ tab: 'users', days: 30, user: 'a' })
    const b = usage.load({ tab: 'users', days: 30, user: 'b' })
    second.resolve({ ownerId: 'b', ...summary(2) })
    await b
    first.resolve({ ownerId: 'a', ...summary(1) })
    await a

    expect(usage.detail?.ownerId).toBe('b')
    expect(usage.loading).toBe(false)
  })

  it('limpa o que era de outro alvo enquanto o novo carrega', async () => {
    const usage = useUsageStore()
    vi.mocked(api).mockResolvedValueOnce({ ownerId: 'a', ...summary(1) })
    await usage.load({ tab: 'users', days: 30, user: 'a' })
    expect(usage.detail?.ownerId).toBe('a')

    const pending = deferred<unknown>()
    vi.mocked(api).mockReturnValueOnce(pending.promise)
    const next = usage.load({ tab: 'users', days: 30, user: 'b' })

    expect(usage.detail).toBeUndefined()
    expect(usage.loading).toBe(true)
    pending.resolve({ ownerId: 'b', ...summary(2) })
    await next
    expect(usage.detail?.ownerId).toBe('b')
  })

  it('erro de carga antiga não aparece sobre a nova', async () => {
    const first = deferred<unknown>()
    vi.mocked(api).mockReturnValueOnce(first.promise).mockResolvedValueOnce(summary(3))
    const usage = useUsageStore()

    const a = usage.load({ tab: 'mine', days: 7 })
    await usage.load({ tab: 'mine', days: 30 })
    // Rejeita a antiga depois que a nova já terminou.
    first.reject(new Error('velho'))
    await a

    expect(usage.error).toBeUndefined()
    expect(usage.mine?.totals.turns).toBe(3)
  })

  it('reset esquece tudo e invalida a carga em andamento', async () => {
    const pending = deferred<unknown>()
    vi.mocked(api).mockReturnValueOnce(pending.promise)
    const usage = useUsageStore()

    const load = usage.load({ tab: 'mine', days: 30 })
    usage.reset()
    pending.resolve(summary(9))
    await load

    expect(usage.mine).toBeUndefined()
    expect(usage.loading).toBe(false)
  })
})
