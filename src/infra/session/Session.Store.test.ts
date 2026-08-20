import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { SessionStore, type TSessionSeed } from './Session.Store'

describe('SessionStore', () => {
  const seed = (): TSessionSeed<string[]> => ({
    agentId: 'sysops-agent',
    provider: EProvider.CLAUDE,
    mode: EMode.CHAT,
    model: 'claude-sonnet-5',
    reasoning: 'high',
    systemPrompt: 'You are a system operator.',
    native: [],
  })

  it('creates prefixed ids and stores the record', () => {
    const store = new SessionStore<string[]>()
    const record = store.create('claude-chat', seed())

    assert.ok(record.id.startsWith('claude-chat-'))
    assert.strictEqual(store.get(record.id)?.model, 'claude-sonnet-5')
  })

  it('never repeats an id, even within the same millisecond', () => {
    const store = new SessionStore<string[]>()
    const ids = new Set(Array.from({ length: 200 }, () => store.create('claude-chat', seed()).id))

    assert.strictEqual(ids.size, 200)
  })

  it('drops sessions past the ttl', () => {
    const store = new SessionStore<string[]>({ ttlMs: -1 })
    const record = store.create('claude-chat', seed())

    assert.strictEqual(store.get(record.id), undefined)
  })

  it('evicts the least recently used session past the cap', () => {
    const store = new SessionStore<string[]>({ maxSessions: 2 })
    const first = store.create('claude-chat', seed())
    store.create('claude-chat', seed())
    store.create('claude-chat', seed())

    assert.strictEqual(store.size, 2)
    assert.strictEqual(store.get(first.id), undefined)
  })

  it('require throws for an unknown session', () => {
    const store = new SessionStore<string[]>()
    assert.throws(() => store.require('nope'), /Session not found/)
  })

  it('aborts the in-flight request when the session is deleted', () => {
    const store = new SessionStore<string[]>()
    const record = store.create('claude-chat', seed())
    const abort = new AbortController()
    record.abort = abort

    store.delete(record.id)

    assert.strictEqual(abort.signal.aborted, true)
  })
})
