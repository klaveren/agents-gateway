import assert from 'node:assert'
import { describe, it } from 'node:test'
import { NextFunction, Request, Response } from 'express'
import { HttpError } from './Http.Error'
import { corsOptions, requireToken } from './Security.Middleware'

describe('security middleware', () => {
  const run = (token: string | undefined, authorization?: string) => {
    let passed = false
    let error: unknown

    const next: NextFunction = ((value?: unknown) => {
      if (value) error = value
      else passed = true
    }) as NextFunction

    requireToken(token)({ headers: { authorization } } as unknown as Request, {} as Response, next)
    return { passed, error }
  }

  it('lets everything through when no token is configured', () => {
    assert.strictEqual(run(undefined).passed, true)
  })

  it('accepts the right bearer token', () => {
    assert.strictEqual(run('s3cret', 'Bearer s3cret').passed, true)
  })

  it('rejects a missing, malformed or wrong token with 401', () => {
    for (const header of [undefined, 's3cret', 'Bearer wrong', 'Basic s3cret']) {
      const { passed, error } = run('s3cret', header)

      assert.strictEqual(passed, false, `deveria recusar: ${header}`)
      assert.ok(error instanceof HttpError)
      assert.strictEqual(error.status, 401)
      assert.strictEqual(error.code, 'unauthorized')
    }
  })

  it('blocks every cross-origin request by default', () => {
    delete process.env.CORS_ORIGINS
    // `origin: false` faz o cors não emitir Access-Control-Allow-Origin nenhum. A UI
    // embutida é same-origin, então segue funcionando.
    assert.deepStrictEqual(corsOptions(), { origin: false })
  })

  it('opens only the origins that were listed', () => {
    process.env.CORS_ORIGINS = 'http://localhost:5173, https://studio.example '
    try {
      assert.deepStrictEqual(corsOptions(), {
        origin: ['http://localhost:5173', 'https://studio.example'],
        credentials: true,
      })
    } finally {
      delete process.env.CORS_ORIGINS
    }
  })
})
