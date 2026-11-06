import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { ILedgerAgentInfo, LedgerService } from '@application/Ledger.Service'
import { SqliteLedgerRepository } from '@infra/persistence/Sqlite.LedgerRepository'
import { LedgerController } from './Ledger.Controller'
import { useProjectAccess } from './Project.Access'

/**
 * ⛔ O isolamento por projeto (ver `Project.Access`): a Ana administra `alfa`, a Bia administra `beta`, o Caio é membro
 * de `alfa` e o root administra o gateway e não é membro de projeto nenhum.
 */
describe('Ledger: o admin do projeto, só o projeto do agente dele', () => {
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

  const AGENTS: Record<string, ILedgerAgentInfo> = {
    'agente-alfa': { id: 'agente-alfa', projectId: 'alfa' },
    'agente-beta': { id: 'agente-beta', projectId: 'beta' },
    'agente-global': { id: 'agente-global' },
  }
  const controller = new LedgerController({ service: new LedgerService(new SqliteLedgerRepository(), { get: (id) => AGENTS[id] }), proof })
  type THandler = 'index' | 'createContext' | 'search'

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

  const create = { topic: 'build-oom', trigger: 'quando o build estourar memória no CI' }

  it('a Ana lê e grava o ledger do agente do alfa; a Bia e o membro comum, não (404)', async () => {
    assert.strictEqual((await call(ANA, 'index', { params: { agentId: 'agente-alfa' } })).status, 200)
    assert.strictEqual((await call(ANA, 'createContext', { params: { agentId: 'agente-alfa' }, body: create })).status, 201)
    assert.strictEqual((await call(BIA, 'index', { params: { agentId: 'agente-alfa' } })).status, 404)
    assert.strictEqual((await call(BIA, 'createContext', { params: { agentId: 'agente-alfa' }, body: { ...create, topic: 'intruso' } })).status, 404)
    assert.strictEqual((await call(CAIO, 'search', { params: { agentId: 'agente-alfa' }, query: { q: 'build' } })).status, 404)
  })

  it('⛔ o admin do gateway não entra no ledger do agente de projeto que não é dele; o agente global é dele', async () => {
    assert.strictEqual((await call(ROOT, 'index', { params: { agentId: 'agente-alfa' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'createContext', { params: { agentId: 'agente-alfa' }, body: { ...create, topic: 'root' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'createContext', { params: { agentId: 'agente-global' }, body: create })).status, 201)
  })

  it('o agente global: só o admin do gateway grava e lê', async () => {
    assert.strictEqual((await call(ANA, 'index', { params: { agentId: 'agente-global' } })).status, 404)
    assert.strictEqual((await call(ANA, 'createContext', { params: { agentId: 'agente-global' }, body: { ...create, topic: 'ana' } })).status, 404)
  })
})
