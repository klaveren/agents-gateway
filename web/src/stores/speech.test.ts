import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, apiBlob } from '@/lib/api'
import { useSpeechStore } from './speech'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn(), apiBlob: vi.fn() }))

const played: string[] = []
let rejectWith: string | undefined
/** Segura o fim do áudio até o teste chamar `release` (para ver o que toca agora). */
let holding = false
let release: (() => void) | undefined

class FakeAudio {
  src = ''
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  pause = vi.fn()
  play() {
    if (rejectWith) return Promise.reject(Object.assign(new Error('blocked'), { name: rejectWith }))
    played.push(this.src)
    // Termina logo, como um áudio curto.
    if (holding) release = () => this.onended?.()
    else queueMicrotask(() => this.onended?.())
    return Promise.resolve()
  }
}

const voice = (extra: Record<string, unknown> = {}) => ({ enabled: true, rate: 1, minLevel: 'info', engine: { available: true }, ...extra })
const message = (id: string, extra: Record<string, unknown> = {}) => ({ id, conversationId: 'c1', agentId: 'z', from: 'agent', body: 'x', level: 'info', createdAt: new Date(Date.now() + 1000).toISOString(), ...extra })

let thread: unknown[] = []
let prefs: ReturnType<typeof voice>

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve))
}

beforeEach(() => {
  setActivePinia(createPinia())
  played.length = 0
  rejectWith = undefined
  holding = false
  release = undefined
  thread = []
  prefs = voice()
  vi.stubGlobal('Audio', FakeAudio)
  let counter = 0
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => `blob:${++counter}`, revokeObjectURL: () => undefined }))
  vi.mocked(api).mockImplementation((async (path: string, request?: { method?: string; body?: object }) => {
    if (path === '/me/voice' && request?.method === 'PUT') return (prefs = { ...prefs, ...request.body })
    if (path === '/me/voice') return prefs
    if (path.startsWith('/messages/')) return { messages: thread }
    throw new Error(`inesperado: ${path}`)
  }) as never)
  vi.mocked(apiBlob).mockResolvedValue(new Blob(['a']))
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as { webkit?: unknown }).webkit
  vi.clearAllMocks()
})

describe('useSpeechStore', () => {
  it('🔊 diz qual mensagem está sendo lida e quantas esperam; acabou, some', async () => {
    holding = true
    const store = useSpeechStore()
    thread = [message('a', { title: 'Preciso do acesso', level: 'attention', status: 'pending' }), message('b', { createdAt: new Date(Date.now() + 3000).toISOString() })]
    await store.onMessageCreated('c1')
    await settle()
    expect(store.current).toEqual({ thread: 'a', agentId: 'z', label: 'Preciso do acesso' })
    expect(store.waiting).toBe(1)
    release?.()
    await settle()
    expect(store.current).toEqual({ thread: 'c1', agentId: 'z', label: 'x' })
    expect(store.waiting).toBe(0)
    store.stop()
    expect(store.current).toBeUndefined()
  })

  it('lê as novas do agente, da mais antiga para a mais nova, uma vez cada', async () => {
    const store = useSpeechStore()
    thread = [message('b', { createdAt: new Date(Date.now() + 3000).toISOString() }), message('a'), message('p', { from: 'person' }), message('old', { createdAt: '2020-01-01T00:00:00Z' })]
    await store.onMessageCreated('c1')
    await settle()
    expect(vi.mocked(apiBlob).mock.calls.map(([path]) => path)).toEqual(['/messages/c1/a/speech', '/messages/c1/b/speech'])
    expect(played).toHaveLength(2)
    await store.onMessageCreated('c1')
    await settle()
    expect(played).toHaveLength(2)
  })

  it('respeita o nível mínimo e a voz desligada ou sem motor', async () => {
    const store = useSpeechStore()
    prefs = voice({ minLevel: 'urgent' })
    thread = [message('a', { level: 'attention' }), message('b', { level: 'urgent' })]
    await store.onMessageCreated('c1')
    await settle()
    expect(vi.mocked(apiBlob).mock.calls.map(([path]) => path)).toEqual(['/messages/c1/b/speech'])

    const other = (setActivePinia(createPinia()), useSpeechStore())
    prefs = voice({ enabled: false })
    await other.onMessageCreated('c1')
    prefs = voice({ engine: { available: false } })
    const third = (setActivePinia(createPinia()), useSpeechStore())
    await third.onMessageCreated('c1')
    await settle()
    expect(vi.mocked(apiBlob)).toHaveBeenCalledTimes(1)
  })

  it('dentro do app do Mac não fala (o ícone da barra de menus fala)', async () => {
    ;(globalThis as { webkit?: unknown }).webkit = { messageHandlers: { gatewayServers: { postMessage: vi.fn() } } }
    thread = [message('a')]
    await useSpeechStore().onMessageCreated('c1')
    await settle()
    expect(vi.mocked(api)).not.toHaveBeenCalled()
    expect(played).toHaveLength(0)
  })

  it('play recusado (autoplay) liga `blocked`; unlock retoma a fila', async () => {
    const store = useSpeechStore()
    thread = [message('a')]
    rejectWith = 'NotAllowedError'
    await store.onMessageCreated('c1')
    await settle()
    expect(store.blocked).toBe(true)
    expect(played).toHaveLength(0)
    rejectWith = undefined
    await store.unlock()
    await settle()
    expect(store.blocked).toBe(false)
    // O mudo do clique e depois a mensagem que esperava.
    expect(played).toHaveLength(2)
    expect(vi.mocked(apiBlob).mock.calls.at(-1)?.[0]).toBe('/messages/c1/a/speech')
  })

  it('save grava as preferências; stop esvazia a fila; replayLast repete a última', async () => {
    const store = useSpeechStore()
    await store.load()
    await store.save({ rate: 1.5 })
    expect(store.voice?.rate).toBe(1.5)
    thread = [message('a')]
    await store.onMessageCreated('c1')
    await settle()
    store.replayLast()
    await settle()
    expect(played).toHaveLength(2)
    store.stop()
    expect(store.active).toBe(false)
  })
})
