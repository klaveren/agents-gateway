import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import type { Request, Response } from 'express'
import { SqliteAuditRepository } from '@infra/persistence/Sqlite.AuditRepository'
import { AUDIT_STATUS_LOCAL, AuditController } from './Audit.Controller'

describe('AuditController.trail', () => {
  const fire = (locals: Record<string, unknown>, statusCode = 200) => {
    const repository = new SqliteAuditRepository()
    const trail = new AuditController({ repository }).trail('post', '/sessions/:id/messages')!
    const res = Object.assign(new EventEmitter(), { statusCode, locals }) as unknown as Response
    const req = { params: { id: 'gw_1' }, headers: {}, body: { message: 'segredo' }, socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1' } as unknown as Request
    trail(req, res, () => undefined)
    ;(res as unknown as EventEmitter).emit('finish')
    return repository.query({})[0]
  }

  it('a recusa que saiu pelo stream (depois do 200) fica com o status dela; sem ela, vale o da resposta', () => {
    assert.strictEqual(fire({ [AUDIT_STATUS_LOCAL]: 429 }).status, 429)
    const plain = fire({})
    assert.deepStrictEqual([plain.status, plain.action, plain.target], [200, 'POST /sessions/:id/messages', { id: 'gw_1' }])
    assert.ok(!JSON.stringify(plain).includes('segredo'))
  })
})
