import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { IConversationRepository } from '@domain/ports/ConversationRepository.Port'
import { IUsageQuery, IUsageRow } from '@domain/models/Usage.Model'
import { UsageController } from './Usage.Controller'
import { useProjectAccess } from './Project.Access'

/**
 * ⛔ O isolamento por projeto (ver `Project.Access`): a Ana administra `alfa`, a Bia administra `beta`, o Caio é membro
 * de `alfa` e o root administra o gateway e não é membro de projeto nenhum.
 */
describe('Uso: o admin vê só os projetos que administra', () => {
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

  const day = new Date().toISOString().slice(0, 10)
  const conversations: Array<{ id: string; project?: string }> = [{ id: 'c-alfa', project: 'alfa' }, { id: 'c-beta', project: 'beta' }, { id: 'c-sem' }]
  // Um repositório de mentira: honra `metadata.project` e `groupBy`, o que o controlador usa para confinar.
  const repository = {
    usage: async (query: IUsageQuery): Promise<IUsageRow[]> =>
      conversations
        .filter((item) => !query.metadata?.project || item.project === query.metadata.project)
        .map((item) => ({
          day,
          conversationId: item.id,
          ownerId: 'u_caio',
          agentId: 'a',
          provider: 'claude',
          model: 'm',
          turns: 1,
          usage: { totalTokens: 10 },
          ...(query.groupBy === 'project' && item.project ? { group: item.project } : {}),
        })),
  } as unknown as IConversationRepository
  const controller = new UsageController({ conversations: repository, proof })
  type THandler = 'mine' | 'users' | 'user' | 'byKey' | 'byKeyValue'
  const total = (reply: { body?: { result?: { totals: { conversations: number } } } }) => reply.body?.result?.totals.conversations

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

  it('cada admin vê só os projetos que administra; o sem-projeto, só o gateway', async () => {
    assert.strictEqual(total(await call(ANA, 'users')), 1)
    assert.strictEqual(total(await call(BIA, 'users')), 1)
    assert.strictEqual(total(await call(ROOT, 'users')), 1, 'só a conversa sem projeto')
    assert.strictEqual((await call(CAIO, 'users')).status, 404)
  })

  it('⛔ ?project= de projeto de fora é 404 — o admin do gateway também', async () => {
    assert.strictEqual(total(await call(ANA, 'users', { query: { project: 'alfa' } })), 1)
    assert.strictEqual((await call(ANA, 'users', { query: { project: 'beta' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'users', { query: { project: 'alfa' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'byKey', { params: { key: 'userId' }, query: { project: 'beta' } })).status, 404)
  })

  it('por usuário e por chave: o mesmo recorte', async () => {
    assert.strictEqual(total(await call(ANA, 'user', { params: { ownerId: 'u_caio' } })), 1)
    assert.strictEqual(total(await call(ROOT, 'user', { params: { ownerId: 'u_caio' } })), 1)
    const keyed = await call(ANA, 'byKey', { params: { key: 'accountId' } })
    assert.strictEqual(keyed.body?.result.totals.conversations, 1)
    assert.strictEqual((await call(CAIO, 'byKeyValue', { params: { key: 'accountId', value: '~none' } })).status, 404)
  })

  it('o uso do próprio chamador segue aberto', async () => {
    assert.strictEqual((await call(CAIO, 'mine')).status, 200)
  })
})
