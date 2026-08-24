import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { readMode, readProvider, sessionPrefix } from './Session.Key'

describe('SessionKey', () => {
  it('builds a prefix that carries provider and lane', () => {
    assert.strictEqual(sessionPrefix(EProvider.CLAUDE, EMode.AGENT), 'claude-agent')
  })

  it('reads the lane back out of a session id', () => {
    const id = `${sessionPrefix(EProvider.OPENAI, EMode.AGENT)}-2f1c9e3a-0000-4000-8000-000000000000`

    assert.strictEqual(readMode(id), EMode.AGENT)
    assert.strictEqual(readProvider(id), EProvider.OPENAI)
  })

  it('returns undefined for ids that do not carry a lane', () => {
    assert.strictEqual(readMode('legacy-session-id'), undefined)
    assert.strictEqual(readProvider('legacy-session-id'), undefined)
  })
})
