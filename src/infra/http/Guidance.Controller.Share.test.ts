import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { GuidanceService } from '@application/Guidance.Service'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { SqliteGuidanceRepository } from '@infra/persistence/Sqlite.GuidanceRepository'
import { GuidanceController } from './Guidance.Controller'
import { useProjectAccess } from './Project.Access'

/**
 * ⛔ O compartilhamento entre projetos (ver `Share.Policy`): a Ana administra `alfa` e `beta`; a Bia, só `beta`; o
 * Caio, só `gama`.
 */
describe('Guidance: compartilhar skill, command, spec e conhecimento', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const token = (id: string) => tokens.issue({ sub: id, email: `${id}@x.test`, role: 'member', ver: 0 }).token
  const ANA = token('u_ana')
  const BIA = token('u_bia')
  const CAIO = token('u_caio')
  const proof = { prove: async (value: string) => !!tokens.verify(value) }
  const members: Record<string, Record<string, 'admin' | 'member'>> = { alfa: { u_ana: 'admin' }, beta: { u_ana: 'admin', u_bia: 'admin' }, gama: { u_caio: 'admin' } }
  before(() =>
    useProjectAccess({
      roles: {
        exists: (id) => id in members,
        roleOf: (id, userId) => (userId ? members[id]?.[userId] : undefined),
        projectsOf: (userId) => Object.keys(members).filter((id) => members[id]![userId]),
      },
    }),
  )
  after(() => useProjectAccess(undefined))

  const guidance = new GuidanceService(new SqliteGuidanceRepository(':memory:'), (id) => id in members)
  const controller = new GuidanceController({ guidance, proof })
  guidance.createResource({ id: 'deploy', kind: 'skill', projectId: 'alfa', description: 'Deploy', body: 'b' }, 'root')
  guidance.createDoc({ id: 'spec-api', kind: 'spec', projectId: 'alfa', title: 'API', body: 'b' }, 'root')
  guidance.createDoc({ id: 'adr-1', kind: 'adr', projectId: 'alfa', title: 'ADR', body: 'b' }, 'root')

  type THandler = 'shareResource' | 'shareDoc' | 'getResource' | 'getDoc' | 'listResources' | 'listDocs' | 'updateResource'
  const call = (as: string, handler: THandler, input: { params?: Record<string, string>; body?: unknown; query?: Record<string, string> } = {}) =>
    withCaller({ token: as, ...identityFromToken(as) }, async () => {
      const reply: { status: number; body?: { ok: boolean; result?: any } } = { status: 0 } // eslint-disable-line @typescript-eslint/no-explicit-any
      const res = {
        status(code: number) {
          reply.status = code
          return this
        },
        json(payload: typeof reply.body) {
          reply.body = payload
          return this
        },
      } as unknown as Response
      await controller[handler]({ params: input.params ?? {}, body: input.body, query: input.query ?? {} } as unknown as Request, res)
      return reply
    })

  it('⛔ só compartilha quem administra a origem E o destino; tirar da lista basta a origem', async () => {
    assert.strictEqual((await call(BIA, 'shareResource', { params: { id: 'deploy' }, body: { projects: ['beta'] } })).status, 404, 'a Bia não administra alfa')
    assert.strictEqual((await call(ANA, 'shareResource', { params: { id: 'deploy' }, body: { projects: ['gama'] } })).status, 404, 'a Ana não administra gama')
    const shared = await call(ANA, 'shareResource', { params: { id: 'deploy' }, body: { projects: ['beta'] } })
    assert.deepStrictEqual([shared.status, shared.body?.result.sharedWith], [200, ['beta']])
    assert.strictEqual((await call(ANA, 'shareDoc', { params: { id: 'spec-api' }, body: { projects: ['beta'] } })).status, 200)
  })

  it('o projeto que recebe lê e lista (marcado `sharedFrom`), mas não edita', async () => {
    assert.strictEqual((await call(BIA, 'getResource', { params: { id: 'deploy' } })).status, 200)
    assert.strictEqual((await call(BIA, 'getDoc', { params: { id: 'spec-api' } })).status, 200)
    assert.strictEqual((await call(CAIO, 'getResource', { params: { id: 'deploy' } })).status, 404)
    const list = await call(BIA, 'listResources', { query: { project: 'beta' } })
    assert.deepStrictEqual(
      list.body?.result.map((item: { id: string; sharedFrom?: string }) => [item.id, item.sharedFrom]),
      [['deploy', 'alfa']],
    )
    const docs = await call(BIA, 'listDocs', { query: { project: 'beta' } })
    assert.deepStrictEqual(
      docs.body?.result.map((item: { id: string; sharedFrom?: string }) => [item.id, item.sharedFrom]),
      [['spec-api', 'alfa']],
    )
    assert.strictEqual((await call(BIA, 'updateResource', { params: { id: 'deploy' }, body: { body: 'invadido' } })).status, 404)
  })

  it('ADR e item global não se compartilham; projeto inexistente nem o próprio, também não', async () => {
    assert.strictEqual((await call(ANA, 'shareDoc', { params: { id: 'adr-1' }, body: { projects: ['beta'] } })).status, 422)
    assert.strictEqual((await call(ANA, 'shareResource', { params: { id: 'deploy' }, body: { projects: ['alfa'] } })).status, 422)
  })

  it('parar de compartilhar: some do projeto que recebia', async () => {
    guidance.shareResource('deploy', ['beta'], 'root')
    assert.strictEqual((await call(ANA, 'shareResource', { params: { id: 'deploy' }, body: { projects: [] } })).status, 200)
    assert.strictEqual((await call(BIA, 'getResource', { params: { id: 'deploy' } })).status, 404)
    assert.deepStrictEqual(guidance.sharedResources('beta'), [])
  })

  it('apagar o projeto que recebia o tira da lista; mover o item para ele também', () => {
    guidance.shareResource('deploy', ['beta', 'gama'], 'root')
    guidance.removeProject('gama')
    assert.deepStrictEqual(guidance.resource('deploy').sharedWith, ['beta'])
    guidance.updateResource('deploy', { projectId: 'beta' }, 'root')
    assert.strictEqual(guidance.resource('deploy').sharedWith, undefined)
  })
})
