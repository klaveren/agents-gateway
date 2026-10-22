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
    assert.deepStrictEqual(toHttpFailure(new Error('boom')), {
      status: 500,
      code: 'internal_error',
      message: 'boom',
    })
    assert.strictEqual(toHttpFailure('just a string').message, 'just a string')
  })
})
