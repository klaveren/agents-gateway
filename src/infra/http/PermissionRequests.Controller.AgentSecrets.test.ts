import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { ResourceSecretsService } from '@application/ResourceSecrets.Service'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { SqliteResourceSecretRepository } from '@infra/persistence/Sqlite.ResourceSecretRepository'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import type { PermissionRequestsService } from '@application/PermissionRequests.Service'
import { PermissionRequestsController } from './PermissionRequests.Controller'
import { useProjectAccess } from './Project.Access'

/**
 * ⛔ As variáveis secretas de um AGENTE COMPARTILHADO: cada projeto configura as suas. A Ana administra `alfa` (a origem) e
 * `beta`; a Bia, só `beta`; o Caio, só `gama` (que não recebeu o agente).
 */
describe('Variáveis secretas de agente compartilhado: por projeto', () => {
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
      agentProject: (agentId) => ({ theo: 'alfa' })[agentId],
    }),
  )
  after(() => useProjectAccess(undefined))

  const secrets = new ResourceSecretsService({
    store: new SqliteResourceSecretRepository(new SecretBox(randomBytes(32))),
    exists: () => true,
    agentProject: (id) => ({ theo: 'alfa' })[id],
  })
  const asked: Array<{ project?: string }> = []
  const service = { requestSecret: (input: { project?: string }) => (asked.push(input), { id: 'r1' }) } as unknown as PermissionRequestsService
  const controller = new PermissionRequestsController({ service, proof, secrets, agentSharedWithOf: (id) => (id === 'theo' ? ['beta'] : undefined) })

  type THandler = 'listSecrets' | 'saveSecret' | 'removeSecret' | 'requestSecret'
  const call = (as: string, handler: THandler, input: { name?: string; body?: unknown; project?: string } = {}) =>
    withCaller({ token: as, ...identityFromToken(as) }, async () => {
      const reply: { status: number; body?: { ok: boolean; result?: any } } = { status: 0 } // eslint-disable-line @typescript-eslint/no-explicit-any
      const res = {
        locals: { viaSessionCookie: true },
        status(code: number) {
          reply.status = code
          return this
        },
        json(payload: typeof reply.body) {
          reply.body = payload
          return this
        },
      } as unknown as Response
      const req = {
        params: { agentId: 'theo', ...(input.name ? { name: input.name } : {}) },
        body: input.body,
        query: input.project ? { project: input.project } : {},
        headers: {},
      }
      await controller[handler](req as unknown as Request, res)
      return reply
    })

  it('valores separados: a conversa do beta recebe o do beta, nunca o da origem', async () => {
    assert.strictEqual((await call(ANA, 'saveSecret', { name: 'TOKEN', body: { value: 'valor-do-alfa', description: 'api' } })).status, 200)
    assert.strictEqual((await call(BIA, 'saveSecret', { name: 'TOKEN', body: { value: 'valor-do-beta' }, project: 'beta' })).status, 200)
    assert.strictEqual(secrets.envFor('theo', 'c-alfa', 'alfa').env.TOKEN, 'valor-do-alfa')
    assert.strictEqual(secrets.envFor('theo', 'c-beta', 'beta').env.TOKEN, 'valor-do-beta')
  })

  it('a lista do beta traz só nomes (e o que a origem usa e ele ainda não configurou)', async () => {
    await call(ANA, 'saveSecret', { name: 'OUTRO', body: { value: 'valor-outro-123', description: 'o outro' } })
    const beta = await call(BIA, 'listSecrets', { project: 'beta' })
    assert.deepStrictEqual(
      beta.body?.result.map((item: { name: string; configured: boolean }) => [item.name, item.configured]),
      [
        ['OUTRO', false],
        ['TOKEN', true],
      ],
    )
    assert.ok(!JSON.stringify(beta.body).includes('valor-'))
  })

  it('⛔ o admin do beta não lê, grava nem apaga os da origem; sem `project` o alvo é a origem', async () => {
    assert.strictEqual((await call(BIA, 'listSecrets')).status, 404)
    assert.strictEqual((await call(BIA, 'saveSecret', { name: 'TOKEN', body: { value: 'invadido-123' }, project: 'alfa' })).status, 404)
    assert.strictEqual((await call(BIA, 'removeSecret', { name: 'TOKEN', project: 'alfa' })).status, 404)
    assert.strictEqual(secrets.envFor('theo', 'c-alfa', 'alfa').env.TOKEN, 'valor-do-alfa')
  })

  it('⛔ a origem não mexe nos valores do beta (admin dele só), e o gama, que não recebeu o agente, é 404', async () => {
    const ONLY_ALFA = token('u_so_alfa')
    members.alfa!.u_so_alfa = 'admin'
    assert.strictEqual((await call(ONLY_ALFA, 'listSecrets', { project: 'beta' })).status, 404)
    assert.strictEqual((await call(ONLY_ALFA, 'saveSecret', { name: 'TOKEN', body: { value: 'invadido-123' }, project: 'beta' })).status, 404)
    delete members.alfa!.u_so_alfa
    assert.strictEqual((await call(CAIO, 'listSecrets', { project: 'gama' })).status, 404, 'gama não recebeu o agente')
    assert.strictEqual((await call(CAIO, 'saveSecret', { name: 'TOKEN', body: { value: 'invadido-123' }, project: 'gama' })).status, 404)
    assert.strictEqual(secrets.envFor('theo', 'c-beta', 'beta').env.TOKEN, 'valor-do-beta')
  })

  it('o pedido do agente (`request_secret`) com `project` vai para o admin do projeto; o de projeto que não recebeu é 404', async () => {
    assert.strictEqual((await call(BIA, 'requestSecret', { body: { scope: 'agent', scopeId: 'theo', name: 'NOVO_TOKEN', reason: 'preciso', project: 'beta' } })).status, 200)
    assert.strictEqual(asked.at(-1)?.project, 'beta')
    assert.strictEqual((await call(CAIO, 'requestSecret', { body: { scope: 'agent', scopeId: 'theo', name: 'NOVO_TOKEN', reason: 'preciso', project: 'gama' } })).status, 404)
  })
})
