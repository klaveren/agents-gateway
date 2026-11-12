import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { ProjectVariablesService } from '@application/ProjectVariables.Service'
import { ResourceSecretsService } from '@application/ResourceSecrets.Service'
import { IMcpServerConfig } from '@domain/models/McpServer.Model'
import { IProject, IProjectMcpVar } from '@domain/models/Project.Model'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { SqliteResourceSecretRepository } from '@infra/persistence/Sqlite.ResourceSecretRepository'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { useProjectAccess } from './Project.Access'
import { ProjectVariablesController } from './ProjectVariables.Controller'

/** ⛔ As variáveis do projeto: só o admin dele, a secreta só pela tela; no projeto conectado, o valor visível de MCP é desta máquina. */
describe('ProjectVariablesController', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const token = (id: string) => tokens.issue({ sub: id, email: `${id}@x.test`, role: 'member', ver: 0 }).token
  const ANA = token('u_ana')
  const BIA = token('u_bia')
  const proof = { prove: async (value: string) => !!tokens.verify(value) }
  const members: Record<string, Record<string, 'admin' | 'member'>> = { alfa: { u_ana: 'admin', u_bia: 'member' }, conectado: { u_ana: 'admin' } }
  before(() =>
    useProjectAccess({
      roles: {
        exists: (id) => id in members,
        roleOf: (id, userId) => (userId ? members[id]?.[userId] : undefined),
        projectsOf: (userId) => Object.keys(members).filter((id) => members[id]![userId]),
      },
      connection: (projectId) => (projectId === 'conectado' ? { url: 'http://origem.test' } : undefined),
    }),
  )
  after(() => useProjectAccess(undefined))

  const at = new Date()
  const n8n: IMcpServerConfig = {
    id: 'n8n',
    name: 'n8n',
    kind: 'process',
    process: { command: 'npx', args: [], projectVars: ['N8N_URL'], env: ['N8N_API_KEY'], scope: 'conversation' },
    url: '',
    transport: 'auto',
    auth: 'none',
    enabled: true,
    createdAt: at,
    updatedAt: at,
  }
  const projects = new Map<string, IProject>(Object.keys(members).map((id) => [id, { id, name: id, createdAt: at, updatedAt: at }]))
  const secrets = new ResourceSecretsService({ store: new SqliteResourceSecretRepository(new SecretBox(randomBytes(32))), exists: () => true })
  /** Os valores visíveis desta máquina do projeto conectado (a conexão). */
  const local = { list: [] as IProjectMcpVar[] }
  const controller = new ProjectVariablesController({
    proof,
    variables: new ProjectVariablesService({
      projects: {
        get: (id) => projects.get(id)!,
        update: (id, change: { mcpEnv: readonly IProjectMcpVar[] }) => Object.assign(projects.get(id)!, { mcpEnv: [...change.mcpEnv] }),
      },
      secrets,
      mcps: () => [n8n],
      connected: { read: (id) => (id === 'conectado' ? [...local.list] : undefined), write: (_id, list) => void (local.list = list) },
    }),
  })

  type THandler = 'secrets' | 'saveSecret' | 'removeSecret' | 'mcpVariables' | 'saveMcpVariable' | 'removeMcpVariable'
  const call = (as: string, handler: THandler, input: { project?: string; params?: Record<string, string>; body?: unknown; onScreen?: boolean } = {}) =>
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
      const req = { params: { projectId: input.project ?? 'alfa', ...input.params }, body: input.body, query: {}, headers: {} }
      await controller[handler](req as unknown as Request, res)
      return reply
    })

  it('⛔ quem não administra o projeto ouve 404 em tudo', async () => {
    assert.strictEqual((await call(BIA, 'secrets')).status, 404)
    assert.strictEqual((await call(BIA, 'mcpVariables')).status, 404)
    assert.strictEqual((await call(BIA, 'saveSecret', { params: { name: 'X_TOKEN' }, body: { value: 'x' } })).status, 404)
  })

  it('⛔ a secreta só entra pela tela, e nunca volta', async () => {
    assert.strictEqual((await call(ANA, 'saveSecret', { params: { name: 'DB_PASSWORD' }, body: { value: 's3gr3d0' }, onScreen: false })).status, 403)
    assert.strictEqual((await call(ANA, 'saveSecret', { params: { name: 'DB_PASSWORD' }, body: { value: 's3gr3d0' } })).status, 200)
    const listed = await call(ANA, 'secrets')
    assert.deepStrictEqual(
      listed.body?.result.map((item: { name: string; configured: boolean }) => [item.name, item.configured]),
      [['DB_PASSWORD', true]],
    )
    assert.ok(!JSON.stringify(listed.body).includes('s3gr3d0'))
    assert.strictEqual((await call(ANA, 'removeSecret', { params: { name: 'DB_PASSWORD' }, onScreen: false })).status, 403)
    assert.strictEqual((await call(ANA, 'removeSecret', { params: { name: 'DB_PASSWORD' } })).status, 200)
  })

  it('o valor do MCP: a secreta só pela tela; a visível também pela API; o nome que o MCP não pede é 422', async () => {
    const secret = { params: { server: 'n8n', name: 'N8N_API_KEY' }, body: { value: 'chave' } }
    assert.strictEqual((await call(ANA, 'saveMcpVariable', { ...secret, onScreen: false })).status, 403)
    assert.strictEqual((await call(ANA, 'saveMcpVariable', secret)).status, 200)
    assert.strictEqual((await call(ANA, 'saveMcpVariable', { params: { server: 'n8n', name: 'N8N_URL' }, body: { value: 'https://n8n' }, onScreen: false })).status, 200)
    assert.strictEqual((await call(ANA, 'saveMcpVariable', { params: { server: 'n8n', name: 'OUTRA' }, body: { value: 'x' } })).status, 422)
    assert.strictEqual((await call(ANA, 'saveMcpVariable', { params: { server: 'nada', name: 'X' }, body: { value: 'x' } })).status, 404)
    assert.deepStrictEqual(secrets.mcpEnv('n8n', 'alfa'), { N8N_API_KEY: 'chave' })
  })

  it('🔌 projeto conectado: a secreta e a visível são desta máquina (gravam; a visível na conexão, não no projeto)', async () => {
    assert.strictEqual((await call(ANA, 'saveMcpVariable', { project: 'conectado', params: { server: 'n8n', name: 'N8N_API_KEY' }, body: { value: 'local' } })).status, 200)
    const visible = await call(ANA, 'saveMcpVariable', { project: 'conectado', params: { server: 'n8n', name: 'N8N_URL' }, body: { value: 'https://x' } })
    assert.deepStrictEqual([visible.status, visible.body?.ok], [200, true])
    assert.deepStrictEqual(local.list, [{ server: 'n8n', name: 'N8N_URL', value: 'https://x' }])
    assert.strictEqual(projects.get('conectado')!.mcpEnv, undefined, 'o projeto (o espelho da origem) não muda')
    assert.strictEqual((await call(ANA, 'saveSecret', { project: 'conectado', params: { name: 'LOCAL_TOKEN' }, body: { value: 'x' } })).status, 200)
  })
})
