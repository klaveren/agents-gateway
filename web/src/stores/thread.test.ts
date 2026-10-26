import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, openStream } from '@/lib/api'
import { readSse, type ISseFrame } from '@/lib/sse'
import { reconcileDraft, useThreadStore } from './thread'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn(), openStream: vi.fn() }))
vi.mock('@/lib/sse', () => ({ readSse: vi.fn() }))

/** Um stream SSE que o teste alimenta à mão — e que morre com o sinal de aborto, como o fetch de verdade. */
function channel() {
  const queue: ISseFrame[] = []
  let wake: (() => void) | undefined
  let closed = false
  let signal: AbortSignal | undefined
  const notify = () => wake?.()
  return {
    attach: (next?: AbortSignal) => {
      signal = next
      signal?.addEventListener('abort', notify)
    },
    push: (type: string, payload: Record<string, unknown> = {}) => {
      queue.push({ data: { type, payload } })
      notify()
    },
    end: () => {
      closed = true
      notify()
    },
    async *iterate(): AsyncGenerator<ISseFrame> {
      while (true) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
        const next = queue.shift()
        if (next) yield next
        else if (closed) return
        else await new Promise<void>((resolve) => (wake = resolve))
      }
    },
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** As rotas da API que a conversa lê ao abrir; `sessions` pode falhar. */
function routes(overrides: Record<string, () => unknown> = {}) {
  vi.mocked(api).mockImplementation(async (path: string) => {
    for (const [prefix, handler] of Object.entries(overrides)) if (path.startsWith(prefix)) return handler() as never
    if (path.endsWith('/turns')) return { turns: [] } as never
    if (path.startsWith('/sessions/')) return { model: 'm1' } as never
    if (path === '/agents') return [] as never
    throw new Error(`rota não prevista: ${path}`)
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(api).mockReset()
  vi.mocked(openStream).mockReset()
  vi.mocked(readSse).mockReset()
})

describe('send: geração', () => {
  it('trocar de conversa no meio do stream aborta e o resultado velho não vaza para a nova', async () => {
    routes()
    const thread = useThreadStore()
    await thread.open('A')

    const stream = channel()
    vi.mocked(openStream).mockImplementation(async (_path, request) => {
      stream.attach(request?.signal)
      return new ReadableStream()
    })
    vi.mocked(readSse).mockImplementation(() => stream.iterate())

    const sent = thread.send('oi', [])
    await tick()
    stream.push('text.delta', { text: 'parcial' })
    await tick()
    expect(thread.pending?.text).toBe('parcial')

    await thread.open('B')
    // O que ainda chegar do stream de A não pode tocar B.
    stream.push('text.delta', { text: 'VAZOU' })
    stream.end()
    const result = await sent

    expect(result.ok).toBe(false)
    expect(thread.sessionId).toBe('B')
    expect(thread.pending).toBeUndefined()
    expect(thread.turns).toEqual([])
    expect(thread.error).toBeUndefined()
    expect(thread.sending).toBe(false)
  })

  it('o fim tardio do stream velho não derruba o envio da conversa nova', async () => {
    routes()
    const thread = useThreadStore()
    await thread.open('A')

    const old = channel()
    vi.mocked(openStream).mockImplementationOnce(async (_path, request) => {
      old.attach(request?.signal)
      return new ReadableStream()
    })
    vi.mocked(readSse).mockImplementationOnce(() => old.iterate())
    const first = thread.send('a', [])
    await tick()

    await thread.open('B')
    const fresh = channel()
    vi.mocked(openStream).mockImplementationOnce(async (_path, request) => {
      fresh.attach(request?.signal)
      return new ReadableStream()
    })
    vi.mocked(readSse).mockImplementationOnce(() => fresh.iterate())
    const second = thread.send('b', [])
    await tick()
    expect(thread.sending).toBe(true)

    await first
    // O `finally` do envio velho não pode zerar o `sending` do novo.
    expect(thread.sending).toBe(true)

    fresh.push('text.delta', { text: 'resposta' })
    fresh.end()
    expect((await second).ok).toBe(true)
    expect(thread.turns.map((turn) => turn.text)).toEqual(['resposta'])
  })

  it('reset derruba o stream e limpa tudo', async () => {
    routes()
    const thread = useThreadStore()
    await thread.open('A')
    const stream = channel()
    vi.mocked(openStream).mockImplementation(async (_path, request) => {
      stream.attach(request?.signal)
      return new ReadableStream()
    })
    vi.mocked(readSse).mockImplementation(() => stream.iterate())
    const sent = thread.send('oi', [])
    await tick()

    thread.reset()

    expect((await sent).ok).toBe(false)
    expect(thread.sessionId).toBeUndefined()
    expect(thread.pending).toBeUndefined()
    expect(thread.sending).toBe(false)
  })
})

describe('send: falhas', () => {
  async function failWith(failure: unknown) {
    routes()
    const thread = useThreadStore()
    await thread.open('A')
    vi.mocked(openStream).mockRejectedValue(failure)
    const result = await thread.send('oi', [])
    return { thread, result }
  }

  it('404 na sessão: texto devolvido, turno não gravado, sessão marcada como encerrada', async () => {
    const { thread, result } = await failWith(new ApiError(404, 'not_found', 'Session not found'))

    expect(result.ok).toBe(false)
    expect(thread.turns).toEqual([])
    expect(thread.pending).toBeUndefined()
    expect(thread.liveSession).toBe(false)
    expect(thread.error).toContain('sessão encerrada')
  })

  it('409 model_disabled mostra a mensagem do servidor', async () => {
    const { thread, result } = await failWith(new ApiError(409, 'model_disabled', 'O modelo m1 foi desativado'))

    expect(result.ok).toBe(false)
    expect(thread.error).toBe('O modelo m1 foi desativado')
    expect(thread.liveSession).toBe(true)
    expect(thread.turns).toEqual([])
  })

  it('outro erro aparece, sem virar turno', async () => {
    const { thread, result } = await failWith(new TypeError('Failed to fetch'))

    expect(result.ok).toBe(false)
    expect(thread.error).toBe('Failed to fetch')
    expect(thread.turns).toEqual([])
  })

  it('stream que termina em erro sem resposta é falha, não turno enviado', async () => {
    routes()
    const thread = useThreadStore()
    await thread.open('A')
    const stream = channel()
    vi.mocked(openStream).mockResolvedValue(new ReadableStream())
    vi.mocked(readSse).mockImplementation(() => stream.iterate())
    const sent = thread.send('oi', [])
    await tick()
    stream.push('error', { message: 'provider caiu' })
    stream.end()

    expect((await sent).ok).toBe(false)
    expect(thread.turns).toEqual([])
    expect(thread.error).toBe('provider caiu')
  })

  it('a falha ao criar a sessão devolve o texto e mantém o rascunho', async () => {
    routes({ '/sessions': () => Promise.reject(new ApiError(409, 'model_disabled', 'modelo fora')) })
    const thread = useThreadStore()
    thread.startDraft({ agentId: 'x', mode: 'chat', tools: false, model: 'm1' })

    const result = await thread.send('oi', [])

    expect(result).toEqual({ ok: false })
    expect(thread.error).toBe('modelo fora')
    expect(thread.draft?.agentId).toBe('x')
    expect(thread.sessionId).toBeUndefined()
  })

  it('a sessão criada num envio que falhou ainda troca a rota no próximo que der certo', async () => {
    routes({ '/sessions': () => ({ id: 'novo' }) })
    const thread = useThreadStore()
    thread.startDraft({ agentId: 'x', mode: 'chat', tools: false, model: 'm1' })
    vi.mocked(openStream).mockRejectedValueOnce(new TypeError('rede'))
    expect(await thread.send('oi', [])).toEqual({ ok: false })
    expect(thread.sessionId).toBe('novo')

    const stream = channel()
    vi.mocked(openStream).mockResolvedValue(new ReadableStream())
    vi.mocked(readSse).mockImplementation(() => stream.iterate())
    const again = thread.send('oi', [])
    await tick()
    stream.push('text.delta', { text: 'ok' })
    stream.end()

    expect(await again).toEqual({ ok: true, created: 'novo' })
  })
})

describe('open: sessão viva', () => {
  it('falha transitória NÃO marca a conversa como não ativa', async () => {
    routes({ '/sessions/': () => Promise.reject(new ApiError(503, undefined, 'indisponível')) })
    const thread = useThreadStore()
    await thread.open('A')

    expect(thread.liveSession).toBe(true)
    expect(thread.error).toBeTruthy()
  })

  it('falha de rede também não', async () => {
    routes({ '/sessions/': () => Promise.reject(new TypeError('Failed to fetch')) })
    const thread = useThreadStore()
    await thread.open('A')

    expect(thread.liveSession).toBe(true)
  })

  it('só o 404 marca como não ativa', async () => {
    routes({ '/sessions/': () => Promise.reject(new ApiError(404, 'not_found', 'sem sessão')) })
    const thread = useThreadStore()
    await thread.open('A')

    expect(thread.liveSession).toBe(false)
    expect(thread.error).toBeUndefined()
  })
})

describe('reconcileDraft', () => {
  const provider = (id: string, models: string[], modelReasoning: Record<string, string[] | null>, extra = {}) => ({
    id,
    name: id,
    models,
    pricing: {},
    modelReasoning,
    reasoningEfforts: ['low'],
    ...extra,
  })
  const agent = {
    providers: [provider('p1', ['m1', 'm2'], { m1: ['low', 'high'], m2: [] })],
    modes: ['chat' as const, 'agent' as const],
    allowedTools: ['Read'],
    reasoningEfforts: ['low'],
  }
  const two = { ...agent, providers: [...agent.providers, provider('sub', ['m3', 'm1'], { m3: null, m1: ['low'] })] }

  it('mantém o que ainda vale', () => {
    const draft = { agentId: 'a', mode: 'agent' as const, tools: false, provider: 'p1', model: 'm2' }

    expect(reconcileDraft(draft, agent)).toEqual({ ...draft, reasoning: undefined })
  })

  it('provider + modelo que saíram do agente voltam ao padrão', () => {
    expect(reconcileDraft({ agentId: 'a', mode: 'chat', tools: false, provider: 'p1', model: 'velho' }, agent)).toMatchObject({ provider: 'p1', model: 'm1' })
    expect(reconcileDraft({ agentId: 'a', mode: 'chat', tools: false }, agent)).toMatchObject({ provider: 'p1', model: 'm1' })
    expect(reconcileDraft({ agentId: 'a', mode: 'chat', tools: false, provider: 'sumiu', model: 'm3' }, two)).toMatchObject({ provider: 'p1', model: 'm1' })
  })

  it('o mesmo modelo em dois providers: vale o provider pedido; sem provider, o primeiro que o oferece', () => {
    expect(reconcileDraft({ agentId: 'a', mode: 'agent', tools: false, provider: 'sub', model: 'm1' }, two)).toMatchObject({ provider: 'sub', model: 'm1' })
    expect(reconcileDraft({ agentId: 'a', mode: 'agent', tools: false, model: 'm3' }, two)).toMatchObject({ provider: 'sub', model: 'm3' })
  })

  it('o padrão pula o provider que não roda agora', () => {
    const off = { ...two, providers: [{ ...two.providers[0], unavailable: { reason: 'no_key', label: 'sem chave' } }, two.providers[1]] }
    expect(reconcileDraft({ agentId: 'a', mode: 'agent', tools: false }, off)).toMatchObject({ provider: 'sub', model: 'm3' })
  })

  it('lane que saiu volta à primeira, sem tools', () => {
    const only = { ...agent, modes: ['agent' as const] }

    expect(reconcileDraft({ agentId: 'a', mode: 'chat', tools: true, model: 'm1' }, only)).toMatchObject({ mode: 'agent', tools: false })
  })

  it('provider que não roda a lane (assinatura) leva a lane que ele roda', () => {
    const lanes = (id: string) => (id === 'sub' ? (['agent'] as const) : (['chat', 'agent'] as const))
    expect(reconcileDraft({ agentId: 'a', mode: 'chat', tools: true, provider: 'sub', model: 'm3' }, two, lanes)).toMatchObject({ mode: 'agent', tools: false })
    expect(reconcileDraft({ agentId: 'a', mode: 'chat', tools: false, provider: 'p1', model: 'm1' }, two, lanes)).toMatchObject({ mode: 'chat' })
  })

  it('tools só valem no chat e com ferramentas liberadas', () => {
    expect(reconcileDraft({ agentId: 'a', mode: 'chat', tools: true, model: 'm1' }, agent).tools).toBe(true)
    expect(reconcileDraft({ agentId: 'a', mode: 'chat', tools: true, model: 'm1' }, { ...agent, allowedTools: [] }).tools).toBe(false)
  })

  it('nível de raciocínio que o modelo não aceita volta ao padrão', () => {
    expect(reconcileDraft({ agentId: 'a', mode: 'chat', tools: false, model: 'm1', reasoning: 'high' }, agent).reasoning).toBe('high')
    expect(reconcileDraft({ agentId: 'a', mode: 'chat', tools: false, model: 'm2', reasoning: 'high' }, agent).reasoning).toBeUndefined()
    // O mesmo modelo noutro provider aceita outros níveis: conferido contra o provider escolhido.
    expect(reconcileDraft({ agentId: 'a', mode: 'agent', tools: false, provider: 'sub', model: 'm1', reasoning: 'high' }, two).reasoning).toBeUndefined()
    // Catálogo que não sabe (`null`): valem os do provider.
    expect(reconcileDraft({ agentId: 'a', mode: 'agent', tools: false, provider: 'sub', model: 'm3', reasoning: 'low' }, two).reasoning).toBe('low')
  })
})
