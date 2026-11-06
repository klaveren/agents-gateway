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
 * ⛔ As variáveis secretas de uma skill COMPARTILHADA: cada projeto configura as suas. A Ana administra `alfa` (a origem) e
 * `beta`; a Bia, só `beta`; o Caio, só `gama` (que não recebeu a skill).
 */
describe('Variáveis secretas de skill compartilhada: por projeto', () => {
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

  const sharedWith = ['beta']
  const secrets = new ResourceSecretsService({
    store: new SqliteResourceSecretRepository(new SecretBox(randomBytes(32))),
    exists: () => true,
    agentProject: (id) => ({ 'agente-alfa': 'alfa', 'agente-beta': 'beta' })[id],
    resourceProject: (id) => (id === 'deploy' ? 'alfa' : undefined),
  })
  const asked: unknown[] = []
  const service = { requestSecret: (input: unknown) => (asked.push(input), { id: 'r1' }) } as unknown as PermissionRequestsService
  const controller = new PermissionRequestsController({
    service,
    proof,
    secrets,
    resourceKindOf: (id) => (id === 'deploy' ? 'skill' : undefined),
    resourceProjectOf: (id) => (id === 'deploy' ? 'alfa' : undefined),
    resourceSharedWithOf: (id) => (id === 'deploy' ? sharedWith : undefined),
  })

  type THandler = 'listSecrets' | 'saveSecret' | 'removeSecret' | 'requestSecret'
  const call = (as: string, handler: THandler, input: { name?: string; body?: unknown; project?: string; onScreen?: boolean } = {}) =>
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
      const req = {
        params: { resourceId: 'deploy', ...(input.name ? { name: input.name } : {}) },
        body: input.body,
        query: input.project ? { project: input.project } : {},
        headers: {},
      }
      await controller[handler](req as unknown as Request, res)
      return reply
    })

  it('valores separados: o da origem e o do beta não se misturam, e o agente de cada projeto recebe o seu', async () => {
    assert.strictEqual((await call(ANA, 'saveSecret', { name: 'TOKEN', body: { value: 'valor-do-alfa', description: 'deploy' } })).status, 200)
    assert.strictEqual((await call(BIA, 'saveSecret', { name: 'TOKEN', body: { value: 'valor-do-beta' }, project: 'beta' })).status, 200)

    secrets.markLoaded('c-alfa', 'skill', 'deploy')
    secrets.markLoaded('c-beta', 'skill', 'deploy')
    assert.strictEqual(secrets.envFor('agente-alfa', 'c-alfa').env.TOKEN, 'valor-do-alfa')
    assert.strictEqual(secrets.envFor('agente-beta', 'c-beta').env.TOKEN, 'valor-do-beta')
  })

  it('a lista traz só nomes e estado (mesmo formato de antes) e, para o beta, o nome que falta configurar', async () => {
    await call(ANA, 'saveSecret', { name: 'OUTRO', body: { value: 'valor-outro-123', description: 'o outro' } })
    const origin = await call(ANA, 'listSecrets')
    assert.deepStrictEqual(
      origin.body?.result.map((item: { name: string }) => item.name),
      ['OUTRO', 'TOKEN'],
    )
    const beta = await call(BIA, 'listSecrets', { project: 'beta' })
    assert.deepStrictEqual(
      beta.body?.result.map((item: { name: string; configured: boolean }) => [item.name, item.configured]),
      [
        ['OUTRO', false],
        ['TOKEN', true],
      ],
    )
    assert.ok(!JSON.stringify([origin.body, beta.body]).includes('valor-'))
    // `?project=<a origem>` é o mesmo que sem `project`.
    assert.strictEqual((await call(ANA, 'listSecrets', { project: 'alfa' })).body?.result.length, 2)
  })

  it('⛔ o admin do beta não lê, grava nem apaga os da origem; sem `project` o alvo é a origem', async () => {
    for (const handler of ['listSecrets', 'saveSecret', 'removeSecret'] as const) {
      assert.strictEqual((await call(BIA, handler, { name: 'TOKEN', body: { value: 'invasao-12345' } })).status, 404, handler)
      assert.strictEqual((await call(BIA, handler, { name: 'TOKEN', body: { value: 'invasao-12345' }, project: 'alfa' })).status, 404, `${handler} ?project=alfa`)
    }
    secrets.markLoaded('c-alfa', 'skill', 'deploy')
    assert.strictEqual(secrets.envFor('agente-alfa', 'c-alfa').env.TOKEN, 'valor-do-alfa')
  })

  it('⛔ quem administra a origem mas não o beta não lê nem grava os do beta', async () => {
    members.beta = { u_bia: 'admin' }
    try {
      for (const handler of ['listSecrets', 'saveSecret', 'removeSecret'] as const)
        assert.strictEqual((await call(ANA, handler, { name: 'TOKEN', body: { value: 'invasao-12345' }, project: 'beta' })).status, 404, handler)
    } finally {
      members.beta = { u_ana: 'admin', u_bia: 'admin' }
    }
  })

  it('⛔ o admin de gama (sem compartilhamento) recebe 404, com ou sem `project`', async () => {
    for (const handler of ['listSecrets', 'saveSecret', 'removeSecret'] as const) {
      for (const project of ['gama', 'beta', 'alfa', undefined])
        assert.strictEqual((await call(CAIO, handler, { name: 'TOKEN', body: { value: 'invasao-12345' }, ...(project ? { project } : {}) })).status, 404, `${handler} ${project}`)
    }
  })

  it('⛔ projeto com que a skill NÃO é compartilhada: 404 até para quem o administra', async () => {
    members.gama = { u_caio: 'admin', u_ana: 'admin' }
    try {
      assert.strictEqual((await call(ANA, 'listSecrets', { project: 'gama' })).status, 404)
      assert.strictEqual((await call(ANA, 'saveSecret', { name: 'TOKEN', body: { value: 'valor-do-gama' }, project: 'gama' })).status, 404)
    } finally {
      members.gama = { u_caio: 'admin' }
    }
  })

  it('⛔ gravar e apagar só pela tela, também no projeto que recebeu', async () => {
    assert.strictEqual((await call(BIA, 'saveSecret', { name: 'TOKEN', body: { value: 'por-fora-1234' }, project: 'beta', onScreen: false })).status, 403)
    assert.strictEqual((await call(BIA, 'removeSecret', { name: 'TOKEN', project: 'beta', onScreen: false })).status, 403)
    assert.strictEqual((await call(BIA, 'removeSecret', { name: 'NAO_HA', project: 'beta' })).status, 404)
  })

  it('⛔ o agente pede a variável do projeto dele (o admin do beta decide); o admin de gama não pede nada', async () => {
    const body = { scope: 'skill', scopeId: 'deploy', name: 'TOKEN', reason: 'precisa' }
    assert.strictEqual((await call(BIA, 'requestSecret', { body: { ...body, project: 'beta' } })).status, 200)
    assert.strictEqual((await call(BIA, 'requestSecret', { body })).status, 404, 'sem project: a origem, que a Bia não administra')
    assert.strictEqual((await call(CAIO, 'requestSecret', { body: { ...body, project: 'gama' } })).status, 404)
    assert.strictEqual((await call(ANA, 'requestSecret', { body })).status, 200)
    assert.deepStrictEqual(asked, [{ ...body, project: 'beta' }, body])
  })

  it('apagar no beta não toca a origem', async () => {
    assert.strictEqual((await call(BIA, 'removeSecret', { name: 'TOKEN', project: 'beta' })).status, 200)
    secrets.markLoaded('c-beta', 'skill', 'deploy')
    assert.strictEqual(secrets.envFor('agente-beta', 'c-beta').env.TOKEN, undefined)
    assert.strictEqual(secrets.envFor('agente-alfa', 'c-alfa').env.TOKEN, 'valor-do-alfa')
  })
})
