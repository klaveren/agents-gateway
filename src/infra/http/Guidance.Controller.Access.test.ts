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
 * ⛔ O isolamento por projeto (ver `Project.Access`): a Ana administra `alfa`, a Bia administra `beta`, o root
 * administra o gateway e não é membro de projeto nenhum.
 */
describe('Guidance: o admin do projeto, só o projeto dele', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const token = (id: string, role: 'admin' | 'member') => tokens.issue({ sub: id, email: `${id}@x.test`, role, ver: 0 }).token
  const ROOT = token('u_root', 'admin')
  const ANA = token('u_ana', 'member')
  const BIA = token('u_bia', 'member')
  const CAIO = token('u_caio', 'member')
  const proof = { prove: async (value: string) => !!tokens.verify(value) }
  const members: Record<string, Record<string, 'admin' | 'member'>> = { alfa: { u_ana: 'admin', u_caio: 'member' }, beta: { u_bia: 'admin' } }
  before(() =>
    useProjectAccess({
      roles: {
        exists: (id) => id in members,
        roleOf: (id, userId) => (userId ? members[id]?.[userId] : undefined),
        projectsOf: (userId) => Object.keys(members).filter((id) => members[id]![userId]),
      },
      agentProject: (agentId) => ({ 'agente-alfa': 'alfa', 'agente-global': null })[agentId],
    }),
  )
  after(() => useProjectAccess(undefined))

  const guidance = new GuidanceService(
    new SqliteGuidanceRepository(':memory:'),
    () => true,
    (id) => (id === 'agente-alfa' ? { id, projectId: 'alfa' } : id === 'agente-global' ? { id } : undefined),
  )
  const controller = new GuidanceController({ guidance, proof })
  guidance.createRule({ projectId: 'alfa', title: 'Regra alfa', body: 'a' }, 'root')
  guidance.createRule({ projectId: null, title: 'Regra global', body: 'g' }, 'root')
  const alfaDoc = guidance.createDoc({ id: 'spec-alfa', projectId: 'alfa', kind: 'spec', title: 'Spec alfa', body: 'a' }, 'root')

  type THandler = keyof GuidanceController & ('listRules' | 'createRule' | 'updateDoc' | 'getDoc' | 'getAgentResources' | 'createResource')
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

  it('a Ana lê e grava o alfa; a Bia e o membro comum, não (404)', async () => {
    assert.strictEqual((await call(ANA, 'listRules', { query: { project: 'alfa' } })).status, 200)
    assert.strictEqual((await call(BIA, 'listRules', { query: { project: 'alfa' } })).status, 404)
    assert.strictEqual((await call(CAIO, 'listRules', { query: { project: 'alfa' } })).status, 404)
    assert.strictEqual((await call(ANA, 'getDoc', { params: { id: alfaDoc.id } })).status, 200)
    assert.strictEqual((await call(BIA, 'getDoc', { params: { id: alfaDoc.id } })).status, 404)
    assert.strictEqual((await call(ANA, 'createRule', { body: { projectId: 'alfa', title: 'Nova', body: 'n' } })).status, 201)
    assert.strictEqual((await call(BIA, 'createRule', { body: { projectId: 'alfa', title: 'Intrusa', body: 'x' } })).status, 404)
  })

  it('⛔ o admin do gateway não entra no projeto de que não é membro; o global é dele', async () => {
    assert.strictEqual((await call(ROOT, 'listRules', { query: { project: 'alfa' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'createRule', { body: { title: 'Global', body: 'g' } })).status, 201)
  })

  it('o global: o admin de projeto lê, só o do gateway grava; o membro comum nem lê', async () => {
    assert.strictEqual((await call(ANA, 'listRules', { query: { project: 'global' } })).status, 200)
    assert.strictEqual((await call(CAIO, 'listRules', { query: { project: 'global' } })).status, 404)
    assert.strictEqual((await call(ANA, 'createRule', { body: { title: 'Global da Ana', body: 'x' } })).status, 404)
    assert.strictEqual((await call(ANA, 'createResource', { body: { id: 'skill-global', kind: 'skill', description: 'd', body: 'b' } })).status, 404)
  })

  it('⛔ mover para outro projeto exige admin dos dois', async () => {
    assert.strictEqual((await call(ANA, 'updateDoc', { params: { id: alfaDoc.id }, body: { projectId: 'beta' } })).status, 404)
    assert.strictEqual(guidance.doc(alfaDoc.id).projectId, 'alfa')
  })

  it('o agente: o admin do projeto dele; o agente global, o do gateway', async () => {
    assert.strictEqual((await call(ANA, 'getAgentResources', { params: { agentId: 'agente-alfa' } })).status, 200)
    assert.strictEqual((await call(BIA, 'getAgentResources', { params: { agentId: 'agente-alfa' } })).status, 404)
    assert.strictEqual((await call(ANA, 'getAgentResources', { params: { agentId: 'agente-global' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'getAgentResources', { params: { agentId: 'agente-global' } })).status, 200)
  })
})
