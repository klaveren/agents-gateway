import assert from 'node:assert'
import { afterEach, describe, it } from 'node:test'
import { NextFunction, Request, Response } from 'express'
import { HttpError } from './Http.Error'
import { corsOptions, requireCaller } from './Security.Middleware'

describe('security middleware', () => {
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

  describe('requireCaller', () => {
    const run = (headers: Record<string, string | string[] | undefined>) => {
      let passed = false
      let error: unknown
      const next: NextFunction = ((value?: unknown) => {
        if (value) error = value
        else passed = true
      }) as NextFunction

      requireCaller()({ headers } as unknown as Request, {} as Response, next)
      return { passed, error }
    }

    afterEach(() => delete process.env.ALLOW_ANONYMOUS)

    it('401 sem a credencial do chamador', () => {
      const { passed, error } = run({})

      assert.strictEqual(passed, false)
      assert.ok(error instanceof HttpError)
      assert.strictEqual(error.status, 401)
      assert.strictEqual(error.code, 'unauthorized')
    })

    it('o `Authorization` do serviço NÃO é a credencial do chamador', () => {
      // É o ponto de existir: o proxy satisfaz o `Authorization` por todo mundo.
      assert.strictEqual(run({ authorization: 'Bearer s3cret' }).passed, false)
    })

    it('header vazio ou só "Bearer" também é ausência', () => {
      for (const value of ['', '   ', 'Bearer ', 'Bearer    ']) {
        assert.strictEqual(run({ 'x-tool-authorization': value }).passed, false, JSON.stringify(value))
      }
    })

    it('passa com o header, com e sem Bearer', () => {
      assert.strictEqual(run({ 'x-tool-authorization': 'Bearer abc' }).passed, true)
      assert.strictEqual(run({ 'x-tool-authorization': 'abc' }).passed, true)
    })

    it('ALLOW_ANONYMOUS=1 reabre; qualquer outro valor não', () => {
      process.env.ALLOW_ANONYMOUS = '1'
      assert.strictEqual(run({}).passed, true)

      for (const value of ['0', 'true', '']) {
        process.env.ALLOW_ANONYMOUS = value
        assert.strictEqual(run({}).passed, false, value)
      }
    })
  })
})
