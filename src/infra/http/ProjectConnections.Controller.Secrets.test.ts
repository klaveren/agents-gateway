import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { ResourceSecretsService } from '@application/ResourceSecrets.Service'
import type { ProjectConnectionService } from '@application/ProjectConnection.Service'
import type { IProjectConnection } from '@domain/models/ProjectConnection.Model'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { SqliteResourceSecretRepository } from '@infra/persistence/Sqlite.ResourceSecretRepository'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { useProjectAccess } from './Project.Access'
import { ProjectConnectionsController } from './ProjectConnections.Controller'

/** 🔌 As variáveis secretas que o projeto conectado pede: o status de cada uma aqui e o preenchimento numa tela só. */
describe('ProjectConnections — as variáveis que o projeto pede', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const ANA = tokens.issue({ sub: 'u_ana', email: 'ana@x.test', role: 'member', ver: 0 }).token
  const BIA = tokens.issue({ sub: 'u_bia', email: 'bia@x.test', role: 'member', ver: 0 }).token
  const members: Record<string, Record<string, 'admin'>> = { logiccus: { u_ana: 'admin' } }
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

  const connection = {
    projectId: 'logiccus',
    secrets: [
      { kind: 'skill', id: 'efi', name: 'EFI_CLIENT_ID', description: 'Client ID' },
      { kind: 'skill', id: 'efi', name: 'EFI_CLIENT_SECRET' },
      { kind: 'agent', id: 'zeus', name: 'EFI_CLIENT_ID' },
      { kind: 'command', id: 'sumiu', name: 'GITHUB_TOKEN' },
    ],
  } as unknown as IProjectConnection
  const store = new SqliteResourceSecretRepository(new SecretBox(randomBytes(32)))
  const secrets = new ResourceSecretsService({ store, exists: (_scope, id) => id !== 'sumiu' })
  const controller = new ProjectConnectionsController({
    connections: { get: (id: string) => (id === 'logiccus' ? connection : undefined) } as unknown as ProjectConnectionService,
    proof: { prove: async (value) => !!tokens.verify(value) },
    secrets: { list: (scope, id) => secrets.list(scope, id), save: (scope, id, input, by) => secrets.save(scope, id, input, by) },
  })

  const call = (as: string, handler: 'get' | 'setSecrets', body?: unknown, onScreen = true) =>
    withCaller({ token: as, ...identityFromToken(as) }, async () => {
      const reply: { status: number; body?: { ok: boolean; result?: any } } = { status: 0 } // eslint-disable-line @typescript-eslint/no-explicit-any
      const res = {
        locals: { viaSessionCookie: onScreen },
        status(code: number) {
          reply.status = code
          return this
        },
        json(payload: typeof reply.body) {
          reply.body = payload
          return this
        },
      } as unknown as Response
      await controller[handler]({ params: { projectId: 'logiccus' }, body, query: {}, headers: {} } as unknown as Request, res)
      return reply
    })
  const status = (result: { secrets: Array<{ kind: string; id: string; name: string; configured: boolean }> }) =>
    result.secrets.map((secret) => `${secret.kind}/${secret.id}/${secret.name}=${secret.configured}`)

  it('⚖️ cada variável diz se já tem valor aqui; preencher um nome grava em todo agente e recurso que o pede, e o valor não volta', async () => {
    assert.deepStrictEqual(status((await call(ANA, 'get')).body!.result), [
      'skill/efi/EFI_CLIENT_ID=false',
      'skill/efi/EFI_CLIENT_SECRET=false',
      'agent/zeus/EFI_CLIENT_ID=false',
      'command/sumiu/GITHUB_TOKEN=false',
    ])
    const saved = await call(ANA, 'setSecrets', { values: { EFI_CLIENT_ID: 'id-123', GITHUB_TOKEN: 'ghp_x' } })
    assert.strictEqual(saved.status, 200)
    assert.deepStrictEqual(status(saved.body!.result), [
      'skill/efi/EFI_CLIENT_ID=true',
      'skill/efi/EFI_CLIENT_SECRET=false',
      'agent/zeus/EFI_CLIENT_ID=true',
      'command/sumiu/GITHUB_TOKEN=false',
    ])
    // O item que não veio para cá não derruba os outros: volta em `failed`.
    assert.deepStrictEqual(
      saved.body!.result.failed.map((item: { name: string; id: string }) => `${item.id}/${item.name}`),
      ['sumiu/GITHUB_TOKEN'],
    )
    assert.ok(!JSON.stringify(saved.body).includes('id-123'), 'o valor nunca volta')
    assert.strictEqual(store.value('skill', 'efi', 'EFI_CLIENT_ID'), 'id-123')
    assert.strictEqual(store.value('agent', 'zeus', 'EFI_CLIENT_ID'), 'id-123')
  })

  it('⛔ só na tela, só quem administra o projeto, e só nome que o projeto pede', async () => {
    assert.strictEqual((await call(ANA, 'setSecrets', { values: { EFI_CLIENT_SECRET: 's' } }, false)).status, 403)
    // Quem não administra o projeto ouve 404, como se a conexão não existisse.
    assert.strictEqual((await call(BIA, 'setSecrets', { values: { EFI_CLIENT_SECRET: 's' } })).status, 404)
    const unknown = await call(ANA, 'setSecrets', { values: { OUTRA: 'x' } })
    assert.strictEqual(unknown.status, 422)
    assert.match(JSON.stringify(unknown.body), /not asked by this project: OUTRA/)
    assert.strictEqual(store.value('skill', 'efi', 'EFI_CLIENT_SECRET'), undefined)
  })
})
