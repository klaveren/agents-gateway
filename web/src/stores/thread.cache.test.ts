import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, openStream } from '@/lib/api'
import { readSse, type ISseFrame } from '@/lib/sse'
import { CACHE_LIMIT, useThreadStore } from './thread'
import { useConversationsStore } from './conversations'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn(), openStream: vi.fn() }))
vi.mock('@/lib/sse', () => ({ readSse: vi.fn() }))

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const turn = (sessionId: string, index: number, text = `r${index}`) => ({ sessionId, index, at: '', request: `p${index}`, text, toolCalls: [] })

/** O servidor de mentira: cada conversa tem os turnos que `server[id]` diz; `gate` segura a leitura do histórico de uma conversa. */
function serve(server: Record<string, ReturnType<typeof turn>[]>) {
  const gates = new Map<string, Promise<void>>()
  const turnReads: string[] = []
  vi.mocked(api).mockImplementation((async (path: string) => {
    const history = /^\/conversations\/([^/]+)\/turns$/.exec(path)
    if (history) {
      const id = history[1]!
      turnReads.push(id)
      await gates.get(id)
      const all = server[id] ?? []
      return { turns: all.slice(-5), hasMore: all.length > 5 }
    }
    if (/^\/conversations\/[^/]+\/todos$/.test(path)) return { items: [] }
    if (/\/watches$/.test(path)) return { watches: [] }
    if (path.startsWith('/sessions/')) return { model: 'm1' }
    if (path.startsWith('/conversations/events/')) return {}
    throw new Error(`rota não prevista: ${path}`)
  }) as never)
  /** Segura a próxima leitura do histórico de `id` até chamar `release`. */
  const hold = (id: string) => {
    let release!: () => void
    gates.set(id, new Promise<void>((resolve) => (release = () => (gates.delete(id), resolve()))))
    return release
  }
  return { hold, turnReads }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(api).mockReset()
  vi.mocked(openStream).mockReset()
  vi.mocked(readSse).mockReset()
})

describe('a conversa já visitada abre do que está guardado e se atualiza por trás', () => {
  it('a primeira visita carrega do zero; a segunda aparece na hora, sem esperar o servidor, e a releitura entra', async () => {
    const server = { A: [turn('A', 0), turn('A', 1)], B: [turn('B', 0, 'da B')] }
    const control = serve(server)
    const thread = useThreadStore()

    const first = thread.open('A')
    expect(thread.loading).toBe(true)
    expect(thread.turns).toEqual([])
    await first
    expect(thread.turns.map((item) => item.text)).toEqual(['r0', 'r1'])
    await thread.open('B')
    expect(thread.turns.map((item) => item.text)).toEqual(['da B'])

    // Voltou à A: o servidor demora, e a tela já tem a conversa (nada de "carregando").
    server.A.push(turn('A', 2, 'chegou enquanto estava fora'))
    const release = control.hold('A')
    const second = thread.open('A')
    expect(thread.loading).toBe(false)
    expect(thread.revalidating).toBe(true)
    expect(thread.turns.map((item) => item.text)).toEqual(['r0', 'r1'])
    expect(thread.sessionId).toBe('A')

    release()
    await second
    expect(thread.revalidating).toBe(false)
    // A releitura entra no que estava na tela (sem trocar a lista por uma mais curta).
    expect(thread.turns.map((item) => item.text)).toEqual(['r0', 'r1', 'chegou enquanto estava fora'])
  })

  it('⛔ a chave é o id: a conversa que nunca foi aberta não mostra nada de outra, nem enquanto carrega', async () => {
    const control = serve({ A: [turn('A', 0, 'segredo da A')], B: [turn('B', 0)] })
    const thread = useThreadStore()
    await thread.open('A')
    const release = control.hold('B')
    const opening = thread.open('B')
    expect(thread.turns).toEqual([])
    expect(thread.loading).toBe(true)
    expect(thread.todos).toEqual([])
    expect(thread.header).toBeUndefined()
    release()
    await opening
    expect(thread.turns.map((item) => item.sessionId)).toEqual(['B'])
  })

  it('o limite guarda só as últimas visitadas: a mais antiga sai', async () => {
    const server: Record<string, ReturnType<typeof turn>[]> = {}
    const ids = Array.from({ length: CACHE_LIMIT + 3 }, (_, index) => `c${index}`)
    for (const id of ids) server[id] = [turn(id, 0)]
    const control = serve(server)
    const thread = useThreadStore()
    for (const id of ids) await thread.open(id)

    // A aberta agora ainda não foi guardada (só ao sair dela).
    expect(thread.cachedIds()).toHaveLength(CACHE_LIMIT)
    expect(thread.cachedIds()).not.toContain('c0')
    expect(thread.cachedIds()).toContain(ids[ids.length - 2])

    // A que saiu do guardado carrega do zero de novo; a guardada abre na hora.
    control.turnReads.length = 0
    const evicted = thread.open('c0')
    expect(thread.loading).toBe(true)
    await evicted
    const kept = thread.open(ids[ids.length - 3]!)
    expect(thread.loading).toBe(false)
    await kept
  })

  it('reentrar numa conversa a põe como a mais recente (sai por último)', async () => {
    const server: Record<string, ReturnType<typeof turn>[]> = {}
    for (let index = 0; index < CACHE_LIMIT + 2; index++) server[`c${index}`] = [turn(`c${index}`, 0)]
    serve(server)
    const thread = useThreadStore()
    await thread.open('c0')
    await thread.open('c1')
    await thread.open('c0')
    for (let index = 2; index < CACHE_LIMIT + 2; index++) await thread.open(`c${index}`)
    // c0 foi revisitada depois da c1: a c1 é a mais antiga.
    expect(thread.cachedIds()).toContain('c0')
    expect(thread.cachedIds()).not.toContain('c1')
  })

  it('falha de rede na releitura por trás não apaga o que está na tela', async () => {
    serve({ A: [turn('A', 0)], B: [] })
    const thread = useThreadStore()
    await thread.open('A')
    await thread.open('B')
    vi.mocked(api).mockImplementation((async (path: string) => {
      if (path.endsWith('/turns')) throw new Error('rede caiu')
      if (path.endsWith('/todos')) return { items: [] }
      if (path.endsWith('/watches')) return { watches: [] }
      return { model: 'm1' }
    }) as never)
    await thread.open('A')
    expect(thread.turns.map((item) => item.text)).toEqual(['r0'])
    expect(thread.error).toBeUndefined()
  })

  it('o logout (reset) esquece todas as guardadas', async () => {
    serve({ A: [turn('A', 0)], B: [] })
    const thread = useThreadStore()
    await thread.open('A')
    await thread.open('B')
    expect(thread.cachedIds()).toEqual(['A'])
    thread.reset()
    expect(thread.cachedIds()).toEqual([])
  })

  it('o turno que está rodando aparece andando logo depois da troca, antes de o histórico voltar', async () => {
    serve({ A: [turn('A', 0)], B: [turn('B', 0)] })
    const frames: ISseFrame[] = []
    let wake: (() => void) | undefined
    vi.mocked(openStream).mockImplementation(async () => new ReadableStream())
    vi.mocked(readSse).mockImplementation(async function* () {
      while (true) {
        const next = frames.shift()
        if (next) yield next
        else await new Promise<void>((resolve) => (wake = resolve))
      }
    })
    const inbox = useConversationsStore()
    inbox.subscribe(false)
    frames.push({ data: { type: 'stream.ready', streamId: 's1' } })
    wake?.()
    await tick()

    const control = serve({ A: [turn('A', 0)], B: [turn('B', 0)] })
    const thread = useThreadStore()
    await thread.open('A')
    await thread.open('B')
    const release = control.hold('A')
    const reopening = thread.open('A')
    frames.push({ data: { type: 'turn.started', sessionId: 'A', turn: { request: 'faça', events: [{ type: 'text.delta', payload: { text: 'andando' } }] } } })
    wake?.()
    await tick()
    expect(thread.revalidating).toBe(true)
    expect(thread.pending).toMatchObject({ request: 'faça', text: 'andando' })
    expect(thread.following).toBe(true)

    release()
    await reopening
    expect(thread.pending).toMatchObject({ text: 'andando' })
    thread.reset()
    inbox.reset()
  })
})
