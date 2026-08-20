import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { SessionStore, type TSessionSeed } from './Session.Store'

describe('SessionStore', () => {
  const seed = (overrides: Partial<TSessionSeed> = {}): TSessionSeed => ({
    agentId: 'sysops-agent',
    provider: EProvider.CLAUDE,
    mode: EMode.CHAT,
    model: 'claude-sonnet-5',
    reasoning: 'high',
    systemPrompt: 'You are a system operator.',
    ...overrides,
  })

  it('creates prefixed ids and starts the counters at zero', () => {
    const store = new SessionStore()
    const record = store.create('claude-chat', seed())

    assert.ok(record.id.startsWith('claude-chat-'))
    assert.strictEqual(record.turns, 0)
    assert.strictEqual(record.status, 'idle')
    assert.deepStrictEqual(record.usage, {})
    assert.strictEqual(store.get(record.id)?.model, 'claude-sonnet-5')
  })

  it('never repeats an id, even within the same millisecond', () => {
    const store = new SessionStore()
    const ids = new Set(Array.from({ length: 200 }, () => store.create('claude-chat', seed()).id))

    assert.strictEqual(ids.size, 200)
  })

  it('knows which agent and lane a session belongs to', () => {
    const store = new SessionStore()
    const chat = store.create('claude-chat', seed())
    const agent = store.create('google-agent', seed({ agentId: 'researcher-agent', provider: EProvider.GOOGLE, mode: EMode.AGENT }))

    // É isto que permite tirar o agentId do path da requisição.
    assert.strictEqual(store.get(chat.id)?.agentId, 'sysops-agent')
    assert.strictEqual(store.get(chat.id)?.mode, EMode.CHAT)
    assert.strictEqual(store.get(agent.id)?.provider, EProvider.GOOGLE)
    assert.strictEqual(store.get(agent.id)?.mode, EMode.AGENT)
  })

  it('holds each adapter native state side by side without collision', () => {
    const store = new SessionStore()
    const first = store.create('claude-chat', seed())
    const second = store.create('openai-agent', seed({ provider: EProvider.OPENAI, mode: EMode.AGENT }))

    first.native = ['claude history']
    second.native = { sdkSessionId: 'abc' }

    assert.deepStrictEqual(store.get(first.id)?.native, ['claude history'])
    assert.deepStrictEqual(store.get(second.id)?.native, { sdkSessionId: 'abc' })
  })

  it('accumulates usage across turns', () => {
    const store = new SessionStore()
    const record = store.create('claude-chat', seed())

    store.addUsage(record, { inputTokens: 10, outputTokens: 5 })
    store.addUsage(record, { inputTokens: 3, outputTokens: 2, reasoningTokens: 7 })

    assert.deepStrictEqual(record.usage, { inputTokens: 13, outputTokens: 7, reasoningTokens: 7 })
  })

  it('lists live sessions, most recently active first', () => {
    const store = new SessionStore()
    const first = store.create('claude-chat', seed())
    const second = store.create('openai-chat', seed({ provider: EProvider.OPENAI }))
    store.get(first.id)

    assert.deepStrictEqual(
      store.list().map((record) => record.id),
      [first.id, second.id],
    )
  })

  it('drops sessions past the ttl', () => {
    const store = new SessionStore({ ttlMs: -1 })
    const record = store.create('claude-chat', seed())

    assert.strictEqual(store.get(record.id), undefined)
    assert.deepStrictEqual(store.list(), [])
  })

  it('evicts the least recently used session past the cap', () => {
    const store = new SessionStore({ maxSessions: 2 })
    const first = store.create('claude-chat', seed())
    store.create('claude-chat', seed())
    store.create('claude-chat', seed())

    assert.strictEqual(store.size, 2)
    assert.strictEqual(store.get(first.id), undefined)
  })

  it('aborts the in-flight request when the session is deleted, and reports whether it existed', () => {
    const store = new SessionStore()
    const record = store.create('claude-chat', seed())
    const abort = new AbortController()
    record.abort = abort

    assert.strictEqual(store.delete(record.id), true)
    assert.strictEqual(abort.signal.aborted, true)
    assert.strictEqual(store.delete(record.id), false)
  })
})
