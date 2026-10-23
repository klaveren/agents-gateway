import assert from 'node:assert'
import { describe, it } from 'node:test'
import { AdapterNotFoundError, AgentNotFoundError, AgentUnavailableError, ModeNotSupportedError, SessionNotFoundError } from '@domain/errors/Domain.Error'
import { HttpError, toHttpFailure } from './Http.Error'

describe('toHttpFailure', () => {
  it('gives each domain failure its own status and code', () => {
    assert.deepStrictEqual(
      [
        new AgentNotFoundError('a'),
        new SessionNotFoundError('s'),
        new ModeNotSupportedError('a', 'telepathy'),
        new AdapterNotFoundError('google', 'agent'),
        new AgentUnavailableError(),
      ].map((error) => {
        const failure = toHttpFailure(error)
        return [failure.status, failure.code]
      }),
      [
        [404, 'agent_not_found'],
        [404, 'session_not_found'],
        [422, 'mode_not_supported'],
        [500, 'adapter_not_found'],
        // ⚠️ Nem 404 (o agente existe) nem 500 (ninguém quebrou): desligar é decisão de operação.
        // E o código não é `unauthorized`, que mandaria pedir acesso em vez de pedir para religar.
        [403, 'agent_unavailable'],
      ],
    )
  })

  it('passes an HttpError through with its details', () => {
    const failure = toHttpFailure(new HttpError(401, 'unauthorized', 'nope', { hint: 'bearer' }))

    assert.strictEqual(failure.status, 401)
    assert.strictEqual(failure.code, 'unauthorized')
    assert.deepStrictEqual(failure.details, { hint: 'bearer' })
  })

  it('falls back to 500 for anything unexpected', () => {
    const failure = toHttpFailure(new Error('boom em /etc/segredo'))
    assert.strictEqual(failure.status, 500)
    assert.strictEqual(failure.code, 'internal_error')
    // ⛔ O texto do erro inesperado não sai: só uma referência para achar no log.
    assert.match(failure.message, /^Internal error \(ref [0-9a-f]{8}\)$/)
    assert.ok(!toHttpFailure('just a string').message.includes('just a string'))
  })

  it('corpo grande demais é 413 e malformado é 400, não 500', () => {
    assert.strictEqual(toHttpFailure(Object.assign(new Error('x'), { type: 'entity.too.large' })).status, 413)
    assert.strictEqual(toHttpFailure(Object.assign(new SyntaxError('x'), { type: 'entity.parse.failed' })).status, 400)
  })
})
