import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, openStream } from '@/lib/api'
import { watchLive } from '@/lib/liveChannel'
import { readSse, type ISseFrame } from '@/lib/sse'
import { useConversationsStore } from './conversations'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn(), openStream: vi.fn() }))
vi.mock('@/lib/sse', () => ({ readSse: vi.fn() }))

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** O stream da caixa de entrada, alimentado à mão. */
function inboxStream() {
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
  return {
    push: (data: Record<string, unknown>) => {
      frames.push({ data })
      wake?.()
    },
  }
}

const puts = (suffix: string) => vi.mocked(api).mock.calls.filter(([path]) => String(path).endsWith(suffix)).map(([, init]) => (init as { body: unknown }).body)

describe('canais no stream da caixa de entrada (navegador ao vivo, terminal)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation((async (path: string) => (path.startsWith('/conversations/events/') ? {} : { sessions: [], total: 0, page: 1, pageSize: 30, facets: { agent: {} } })) as never)
    vi.mocked(openStream).mockReset()
    vi.mocked(readSse).mockReset()
  })

  it('liga o canal por um PUT, entrega só os quadros marcados com ele e desliga ao sair', async () => {
    const stream = inboxStream()
    const inbox = useConversationsStore()
    inbox.subscribe(false)
    stream.push({ type: 'stream.ready', streamId: 's1' })
    await tick()

    const mine: Array<Record<string, unknown>> = []
    const other: Array<Record<string, unknown>> = []
    const off = await inbox.openChannel('browser:A', (frame) => mine.push(frame))
    await inbox.openChannel('browser:B', (frame) => other.push(frame))
    expect(off).toBeTypeOf('function')
    expect(puts('/s1/channels')).toEqual([
      { channel: 'browser:A', on: true },
      { channel: 'browser:B', on: true },
    ])

    stream.push({ type: 'browser.frame', channel: 'browser:A', data: 'jpeg' })
    stream.push({ type: 'browser.state', channel: 'browser:B', live: true })
    // Um aviso comum do stream não é de canal nenhum.
    stream.push({ type: 'conversation.idle', sessionId: 'A' })
    await tick()
    expect(mine).toEqual([{ type: 'browser.frame', channel: 'browser:A', data: 'jpeg' }])
    expect(other).toEqual([{ type: 'browser.state', channel: 'browser:B', live: true }])

    off!()
    await tick()
    expect(puts('/s1/channels').at(-1)).toEqual({ channel: 'browser:A', on: false })
    stream.push({ type: 'browser.frame', channel: 'browser:A', data: 'depois' })
    await tick()
    expect(mine).toHaveLength(1)
    inbox.reset()
  })

  it('o servidor recusou (404) ou não há stream: não liga, e quem chamou usa o endpoint dedicado', async () => {
    const stream = inboxStream()
    const inbox = useConversationsStore()
    // Sem stream aberto.
    expect(await inbox.openChannel('browser:A', () => undefined)).toBeUndefined()

    inbox.subscribe(false)
    stream.push({ type: 'stream.ready', streamId: 's1' })
    await tick()
    vi.mocked(api).mockRejectedValueOnce(new Error('404'))
    const frames: unknown[] = []
    expect(await inbox.openChannel('terminal:t1', (frame) => frames.push(frame))).toBeUndefined()
    stream.push({ type: 'terminal.data', channel: 'terminal:t1', data: 'x' })
    await tick()
    expect(frames).toEqual([])
    inbox.reset()
  })

  it('o stream reconectou (id novo): os canais ligados são ligados de novo', async () => {
    const stream = inboxStream()
    const inbox = useConversationsStore()
    inbox.subscribe(false)
    stream.push({ type: 'stream.ready', streamId: 's1' })
    await tick()
    await inbox.openChannel('browser:A', () => undefined)

    stream.push({ type: 'stream.ready', streamId: 's2' })
    await tick()
    expect(vi.mocked(api).mock.calls.filter(([path]) => String(path) === '/conversations/events/s2/channels')).toHaveLength(1)
    expect(puts('/s2/channels')).toEqual([{ channel: 'browser:A', on: true }])
    inbox.reset()
  })

  it('watchLive: com o canal, nenhuma conexão extra abre; sem ele, cai no endpoint antigo', async () => {
    const stream = inboxStream()
    const inbox = useConversationsStore()
    inbox.subscribe(false)
    stream.push({ type: 'stream.ready', streamId: 's1' })
    await tick()
    const opened = vi.mocked(openStream).mock.calls.length

    const got: Array<[string, Record<string, unknown>]> = []
    const controller = new AbortController()
    const watching = watchLive('browser:A', '/sessions/A/browser', (type, data) => got.push([type, data]), controller.signal)
    await tick()
    stream.push({ type: 'browser.state', channel: 'browser:A', live: false })
    await tick()
    expect(got.map(([type]) => type)).toEqual(['browser.state'])
    // Só a conexão da caixa de entrada: o `/sessions/A/browser` não foi aberto.
    expect(vi.mocked(openStream).mock.calls).toHaveLength(opened)
    controller.abort()
    await watching

    // Recusado: abre o endpoint antigo.
    vi.mocked(api).mockRejectedValueOnce(new Error('404'))
    vi.mocked(readSse).mockImplementationOnce(async function* () {
      yield { event: 'browser.state', data: { live: true } }
    })
    const fallback: string[] = []
    await watchLive('browser:B', '/sessions/B/browser', (type) => fallback.push(type), new AbortController().signal)
    expect(fallback).toEqual(['browser.state'])
    expect(vi.mocked(openStream).mock.calls.at(-1)?.[0]).toBe('/sessions/B/browser')
    inbox.reset()
  })
})
