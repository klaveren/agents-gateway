import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import type { Request, Response } from 'express'
import { SqliteAuditRepository } from '@infra/persistence/Sqlite.AuditRepository'
import { AUDIT_ERROR_LOCAL, AUDIT_STATUS_LOCAL, AuditController, errorOf } from './Audit.Controller'

describe('AuditController.trail', () => {
  const fire = (locals: Record<string, unknown>, statusCode = 200, answer?: unknown) => {
    const repository = new SqliteAuditRepository()
    const trail = new AuditController({ repository }).trail('post', '/sessions/:id/messages')!
    const res = Object.assign(new EventEmitter(), { statusCode, locals, json: (body: unknown) => body }) as unknown as Response
    const req = { params: { id: 'gw_1' }, headers: {}, body: { message: 'segredo' }, socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1' } as unknown as Request
    trail(req, res, () => undefined)
    if (answer !== undefined) res.json(answer)
    ;(res as unknown as EventEmitter).emit('finish')
    return repository.query({})[0]
  }

  it('o erro devolvido pela API entra no registro (com os campos do 422); o corpo de sucesso, nunca', () => {
    const invalid = {
      ok: false,
      message: 'Request body is invalid',
      code: 'validation_error',
      details: [{ field: 'limits.userMonthlyCostCapUsd', message: 'must be 1 to 1000000' }],
    }
    assert.strictEqual(fire({}, 422, invalid).error, 'Request body is invalid — limits.userMonthlyCostCapUsd: must be 1 to 1000000')
    assert.strictEqual(fire({}, 200, { ok: true, result: { segredo: 'x' } }).error, undefined)
    assert.strictEqual(fire({ [AUDIT_STATUS_LOCAL]: 429, [AUDIT_ERROR_LOCAL]: 'Você atingiu o teto' }).error, 'Você atingiu o teto')
    assert.strictEqual(errorOf({ ok: true }), undefined)
  })

  it('a recusa que saiu pelo stream (depois do 200) fica com o status dela; sem ela, vale o da resposta', () => {
    assert.strictEqual(fire({ [AUDIT_STATUS_LOCAL]: 429 }).status, 429)
    const plain = fire({})
    assert.deepStrictEqual([plain.status, plain.action, plain.target], [200, 'POST /sessions/:id/messages', { id: 'gw_1' }])
    assert.ok(!JSON.stringify(plain).includes('segredo'))
  })
})
