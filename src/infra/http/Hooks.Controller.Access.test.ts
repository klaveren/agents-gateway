import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { AgentHooksService } from '@application/AgentHooks.Service'
import { IAgentHook } from '@domain/models/AgentHook.Model'
import { HooksController } from './Hooks.Controller'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { useProjectAccess } from './Project.Access'

/** ⛔ O isolamento por projeto (ver `Project.Access`): o hook é do escopo do agente dele. */
describe('Hooks: o admin do projeto, só os agentes dele', () => {
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

  type TReply = { status: number; body?: { ok: boolean; result?: any } } // eslint-disable-line @typescript-eslint/no-explicit-any
  const callOf =
    <H extends string>(controller: Record<H, (req: Request, res: Response) => Promise<unknown>>) =>
    (as: string, handler: H, input: { params?: Record<string, string>; body?: unknown; query?: Record<string, string> } = {}) =>
      withCaller({ token: as, ...identityFromToken(as) }, async () => {
        const reply: TReply = { status: 0 }
        const res = {
          locals: {},
          status(code: number) {
            reply.status = code
            return this
          },
          json(payload: TReply['body']) {
            reply.body = payload
            return this
          },
        } as unknown as Response
        await controller[handler]({ params: input.params ?? {}, body: input.body, query: input.query ?? {} } as unknown as Request, res)
        return reply
      })

  const at = new Date()
  const hook = (agentId: string): IAgentHook =>
    ({
      agentId,
      name: 'deploy',
      prompt: 'x',
      enabled: true,
      verify: 'key',
      signatureHeader: 'x-sig',
      signaturePrefix: '',
      signatureEncoding: 'hex',
      requireTimestamp: false,
      session: 'new',
      runAs: 'u',
      createdAt: at,
      updatedAt: at,
      updatedBy: 'root',
    }) as IAgentHook
  const hooks = {
    list: (agentId: string) => [hook(agentId)],
    get: (agentId: string) => hook(agentId),
    create: (agentId: string) => ({ hook: hook(agentId), secret: 's' }),
    update: (agentId: string) => hook(agentId),
    remove: () => undefined,
    rotate: () => 'novo',
    deliveries: () => [],
    secretLast4: () => 'abcd',
  } as unknown as AgentHooksService
  const call = callOf(new HooksController({ hooks, sessionFor: () => undefined, proof }))
  const input = (agentId: string) => ({ params: { agentId, hookName: 'deploy' }, body: { name: 'deploy', prompt: 'x' } })
  const handlers = ['list', 'create', 'update', 'remove', 'rotate', 'deliveries'] as const

  it('o agente do alfa: a Ana mexe; a Bia, o root e o membro, 404', async () => {
    for (const handler of handlers) {
      assert.ok([200, 201].includes((await call(ANA, handler, input('agente-alfa'))).status), `${handler}: a Ana`)
      for (const [name, who] of [
        ['a Bia', BIA],
        ['o root', ROOT],
        ['o Caio', CAIO],
      ] as const)
        assert.strictEqual((await call(who, handler, input('agente-alfa'))).status, 404, `${handler}: ${name}`)
    }
  })

  it('⛔ o agente global: só o admin do gateway; o agente que não existe também', async () => {
    for (const handler of handlers) {
      assert.ok([200, 201].includes((await call(ROOT, handler, input('agente-global'))).status), `${handler}: o root`)
      assert.strictEqual((await call(ANA, handler, input('agente-global'))).status, 404, `${handler}: a Ana`)
      assert.strictEqual((await call(ANA, handler, input('fantasma'))).status, 404, `${handler}: fantasma`)
    }
  })
})
