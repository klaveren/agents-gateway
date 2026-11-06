import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { PermissionRequestsService } from '@application/PermissionRequests.Service'
import { PermissionRequestNotFoundError } from '@domain/errors/Domain.Error'
import { PermissionRequestsController } from './PermissionRequests.Controller'
import { useProjectAccess } from './Project.Access'

/**
 * ⛔ O isolamento por projeto (ver `Project.Access`): a Ana administra `alfa`, a Bia administra `beta`, o Caio é membro
 * de `alfa` e o root administra o gateway e não é membro de projeto nenhum.
 */
describe('Pedidos de permissão: o admin do projeto, só os do projeto dele', () => {
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

  // O serviço é um dublê: o que se prova aqui é quem pode chamar, não o que o serviço faz.
  const requests = [
    { id: 'r-alfa', kind: 'project-rules', projectId: 'alfa', status: 'pending' },
    { id: 'r-ag-alfa', kind: 'agent-rules', agentId: 'agente-alfa', projectId: 'alfa', status: 'pending' },
    { id: 'r-ag-beta', kind: 'agent-patch', agentId: 'agente-beta', projectId: 'beta', status: 'pending' },
    { id: 'r-global', kind: 'agent-rules', agentId: 'agente-global', status: 'pending' },
  ] as Array<{ id: string; kind: string; agentId?: string; projectId?: string; status: string }>
  const rejected: string[] = []
  const service = {
    list: (filter: { agentId?: string; projectId?: string } = {}) =>
      requests.filter((request) => (!filter.agentId || request.agentId === filter.agentId) && (!filter.projectId || request.projectId === filter.projectId)),
    get: (id: string) => requests.find((request) => request.id === id) ?? Promise.reject(new PermissionRequestNotFoundError(id)),
    rules: () => ({ rules: [], pending: [] }),
    reject: (id: string) => (rejected.push(id), { id }),
  } as unknown as PermissionRequestsService
  const controller = new PermissionRequestsController({ service, proof })
  type THandler = 'list' | 'listForProject' | 'listForAgent' | 'rules' | 'reject' | 'change'
  const ids = (reply: { body?: { result?: Array<{ id: string }> } }) => (reply.body?.result ?? []).map((request) => request.id).sort()

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

  it('a lista traz só os pedidos dos projetos que a conta administra; o global, só o admin do gateway', async () => {
    assert.deepStrictEqual(ids(await call(ANA, 'list')), ['r-alfa', 'r-ag-alfa'].sort())
    assert.deepStrictEqual(ids(await call(BIA, 'list')), ['r-ag-beta'])
    assert.deepStrictEqual(ids(await call(ROOT, 'list')), ['r-global'])
    assert.strictEqual((await call(CAIO, 'list')).status, 404)
  })

  it('⛔ listar por projeto ou por agente de fora é 404 — o admin do gateway também', async () => {
    assert.strictEqual((await call(ANA, 'listForProject', { params: { projectId: 'alfa' } })).status, 200)
    assert.strictEqual((await call(BIA, 'listForProject', { params: { projectId: 'alfa' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'listForProject', { params: { projectId: 'alfa' } })).status, 404)
    assert.strictEqual((await call(ANA, 'list', { query: { projectId: 'beta' } })).status, 404)
    assert.strictEqual((await call(BIA, 'listForAgent', { params: { agentId: 'agente-alfa' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'listForAgent', { params: { agentId: 'agente-global' } })).status, 200)
    assert.strictEqual((await call(ANA, 'listForAgent', { params: { agentId: 'agente-global' } })).status, 404)
  })

  it('recusar: o admin do projeto do pedido; os outros (e o gateway, num pedido de projeto) 404', async () => {
    assert.strictEqual((await call(BIA, 'reject', { params: { requestId: 'r-alfa' }, body: {} })).status, 404)
    assert.strictEqual((await call(ROOT, 'reject', { params: { requestId: 'r-ag-alfa' }, body: {} })).status, 404)
    assert.strictEqual((await call(CAIO, 'reject', { params: { requestId: 'r-alfa' }, body: {} })).status, 404)
    assert.deepStrictEqual(rejected, [])
    assert.strictEqual((await call(ANA, 'reject', { params: { requestId: 'r-alfa' }, body: {} })).status, 200)
    assert.strictEqual((await call(ROOT, 'reject', { params: { requestId: 'r-global' }, body: {} })).status, 200)
    assert.deepStrictEqual(rejected, ['r-alfa', 'r-global'])
  })

  it('as regras: do projeto e do agente, o admin do projeto; mudar, idem', async () => {
    assert.strictEqual((await call(ANA, 'rules', { params: { projectId: 'alfa' } })).status, 200)
    assert.strictEqual((await call(BIA, 'rules', { params: { projectId: 'alfa' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'rules', { params: { agentId: 'agente-alfa' } })).status, 404)
    assert.strictEqual((await call(BIA, 'change', { params: { agentId: 'agente-alfa' }, body: { add: [], reason: 'x' } })).status, 404)
  })
})
