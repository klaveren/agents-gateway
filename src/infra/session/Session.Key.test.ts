import assert from 'node:assert'
import { describe, it } from 'node:test'
import { newSessionId } from './Session.Key'

describe('SessionKey', () => {
  it('gw_ + 26 caracteres de base32, ordenável pelo momento em que nasceu', () => {
    const first = newSessionId(1_700_000_000_000)
    const later = newSessionId(1_700_000_000_001)
    assert.match(first, /^gw_[0-9A-HJKMNP-TV-Z]{26}$/)
    assert.ok(first.slice(0, 13) < later.slice(0, 13), 'o tempo vem primeiro')
    assert.notStrictEqual(newSessionId(1), newSessionId(1), 'a parte aleatória muda')
  })
})
