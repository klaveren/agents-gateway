import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { AgentProjectLayerService } from '@application/AgentProjectLayer.Service'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { SqliteAgentProjectLayerRepository } from '@infra/persistence/Sqlite.AgentProjectLayerRepository'
import { AgentProjectLayerController } from './AgentProjectLayer.Controller'
import { useProjectAccess } from './Project.Access'

/** ⛔ A camada do projeto do agente global: só o admin do projeto, e gravar só pela tela. */
describe('AgentProjectLayerController', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const token = (id: string) => tokens.issue({ sub: id, email: `${id}@x.test`, role: 'member', ver: 0 }).token
  const ANA = token('u_ana')
  const BIA = token('u_bia')
  const proof = { prove: async (value: string) => !!tokens.verify(value) }
  const members: Record<string, Record<string, 'admin' | 'member'>> = { bh: { u_ana: 'admin', u_bia: 'member' } }
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

  const atlas = { id: 'atlas', name: 'Atlas', providers: [{ provider: EProvider.CLAUDE, models: ['m'] }], systemPrompt: 'p', modes: [EMode.AGENT], allowedTools: [] } as IAgent
  const layers = new AgentProjectLayerService({
    repository: new SqliteAgentProjectLayerRepository(':memory:'),
    agents: { entry: (id: string) => (id === 'atlas' ? { agent: atlas } : undefined) } as never,
    projectExists: (id) => id === 'bh',
  })
  layers.useAgentValidation(async () => ({ rules: { knownTools: ['cap:terminal'], modelEnabled: () => true }, issues: () => [] }))
  const controller = new AgentProjectLayerController({ layers, proof })

  const call = (as: string, handler: 'get' | 'save' | 'remove', input: { body?: unknown; onScreen?: boolean } = {}) =>
    withCaller({ token: as, ...identityFromToken(as) }, async () => {
      const reply: { status: number; body?: { ok: boolean; result?: any } } = { status: 0 } // eslint-disable-line @typescript-eslint/no-explicit-any
      const res = {
        locals: { viaSessionCookie: input.onScreen ?? true },
        status(code: number) {
          reply.status = code
          return this
        },
        json(payload: typeof reply.body) {
          reply.body = payload
          return this
        },
      } as unknown as Response
      await controller[handler]({ params: { projectId: 'bh', agentId: 'atlas' }, body: input.body, query: {}, headers: {} } as unknown as Request, res)
      return reply
    })

  it('⛔ o membro do projeto não vê nem grava; o admin grava pela tela, e só pela tela', async () => {
    const body = { allowedTools: [], permissions: [{ category: 'terminal', pattern: 'git status', decision: 'allow' }] }
    assert.strictEqual((await call(BIA, 'get')).status, 404)
    assert.strictEqual((await call(BIA, 'save', { body })).status, 404)
    assert.strictEqual((await call(ANA, 'save', { body, onScreen: false })).status, 403)
    const saved = await call(ANA, 'save', { body })
    assert.deepStrictEqual([saved.status, saved.body?.result.layer.permissions.length], [200, 1])
    assert.strictEqual((await call(ANA, 'remove', { onScreen: false })).status, 403)
    assert.deepStrictEqual((await call(ANA, 'remove')).body?.result.layer.permissions, [])
  })
})
