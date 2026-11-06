import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { PermissionsService } from '@application/Permissions.Service'
import { SqlitePermissionRepository } from '@infra/persistence/Sqlite.PermissionRepository'
import { PermissionsController } from './Permissions.Controller'
import { useProjectAccess } from './Project.Access'

/**
 * ⛔ O isolamento por projeto (ver `Project.Access`): a Ana administra `alfa`, a Bia administra `beta`, o Caio é membro
 * de `alfa` e o root administra o gateway e não é membro de projeto nenhum.
 */
describe('Permissões do projeto: o admin do projeto, só o projeto dele', () => {
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
      agentProject: (agentId) => ({ 'agente-alfa': 'alfa', 'agente-beta': 'beta', 'agente-global': null })[agentId],
    }),
  )
  after(() => useProjectAccess(undefined))

  const permissions = new PermissionsService(new SqlitePermissionRepository(), () => undefined)
  const controller = new PermissionsController({ permissions, projectExists: (id) => id in members, agentExists: () => true, installationRules: () => [], proof })
  type THandler = 'get' | 'save' | 'decisions'

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
      await controller[handler]({ params: input.params ?? {}, body: input.body, query: input.query ?? {}, headers: {} } as unknown as Request, res)
      return reply
    })

  const rules = { rules: [{ category: 'read', pattern: 'src/**', decision: 'allow' }] }

  it('a Ana lê e grava as regras do alfa; a Bia e o membro comum, não (404)', async () => {
    assert.strictEqual((await call(ANA, 'save', { params: { projectId: 'alfa' }, body: rules })).status, 200)
    assert.strictEqual((await call(ANA, 'get', { params: { projectId: 'alfa' } })).status, 200)
    assert.strictEqual((await call(BIA, 'get', { params: { projectId: 'alfa' } })).status, 404)
    assert.strictEqual((await call(CAIO, 'decisions', { params: { projectId: 'alfa' } })).status, 404)
    assert.strictEqual((await call(BIA, 'save', { params: { projectId: 'alfa' }, body: { rules: [] } })).status, 404)
    assert.strictEqual(permissions.projectRules('alfa').rules.length, 1, 'a Bia não apagou nada')
  })

  it('⛔ o admin do gateway não entra no projeto de que não é admin', async () => {
    assert.strictEqual((await call(ROOT, 'get', { params: { projectId: 'alfa' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'save', { params: { projectId: 'alfa' }, body: { rules: [] } })).status, 404)
    assert.strictEqual((await call(ROOT, 'decisions', { params: { projectId: 'beta' } })).status, 404)
  })
})
