import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { McpServersService } from '@application/McpServers.Service'
import { McpRegistry } from '@infra/mcp/Mcp.Registry'
import { IMcpServerConfig } from '@domain/models/McpServer.Model'
import { McpServersController } from './McpServers.Controller'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { useProjectAccess } from './Project.Access'

/** ⛔ O isolamento por projeto (ver `Project.Access`): a Ana administra `alfa`, a Bia `beta`, o Caio é membro de `alfa`, o root o gateway. */
describe('McpServers: o admin do projeto, só o projeto dele', () => {
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
  const server = (id: string, projectId?: string): IMcpServerConfig =>
    ({
      id,
      ...(projectId ? { projectId } : {}),
      name: id,
      url: 'https://x.test/mcp',
      transport: 'http',
      auth: 'none',
      enabled: true,
      createdAt: at,
      updatedAt: at,
      updatedBy: 'root',
    }) as IMcpServerConfig
  const stored = new Map<string, IMcpServerConfig>(
    [server('n8n', 'alfa'), server('n8n', 'beta'), server('github')].map((entry) => [entry.projectId ? `${entry.projectId}.${entry.id}` : entry.id, entry]),
  )
  const service = {
    list: () => [...stored.values()],
    get: (key: string) => stored.get(key)!,
    create: (input: IMcpServerConfig) => (
      stored.set(input.projectId ? `${input.projectId}.${input.id}` : input.id, server(input.id, input.projectId)),
      server(input.id, input.projectId)
    ),
    update: (key: string) => stored.get(key)!,
    remove: () => undefined,
    saveSecret: () => undefined,
    clearSecret: () => undefined,
    saveEnv: () => undefined,
    secretStatus: () => ({ configured: false }),
    envStatus: () => [],
    // O `github` global é usado por um agente de cada projeto: ninguém vê o agente do outro.
    usedBy: (key: string) =>
      key === 'github'
        ? [
            { id: 'a1', name: 'Agente alfa', projectId: 'alfa' },
            { id: 'b1', name: 'Agente beta', projectId: 'beta' },
            { id: 'g1', name: 'Agente global' },
          ]
        : [],
  } as unknown as McpServersService
  const registry = {
    status: () => [],
    closeInstances: async () => 0,
    forget: () => undefined,
    test: async () => ({ ok: true, tools: [] }),
    probeTools: async () => [],
  } as unknown as McpRegistry
  const controller = new McpServersController({
    service,
    registry,
    proof,
    projects: { canUse: (caller, id) => !!caller.userId && !!members[id]?.[caller.userId], exists: (id) => id in members },
  })
  const call = callOf(controller)
  const keys = async (as: string, query?: Record<string, string>) =>
    ((await call(as, 'list', { query })).body?.result as Array<{ key: string }> | undefined)?.map((entry) => entry.key).sort()

  it('a lista: cada admin vê o global e os projetos que administra; o root não vê o MCP de projeto', async () => {
    assert.deepStrictEqual(await keys(ROOT), ['github'])
    assert.deepStrictEqual(await keys(ANA), ['alfa.n8n', 'github'])
    assert.deepStrictEqual(await keys(BIA), ['beta.n8n', 'github'])
    assert.deepStrictEqual(await keys(ANA, { project: 'alfa' }), ['alfa.n8n', 'github'])
    assert.strictEqual((await call(ROOT, 'list', { query: { project: 'alfa' } })).status, 404)
    assert.strictEqual((await call(ANA, 'list', { query: { project: 'beta' } })).status, 404)
  })

  it('o membro comum vê só os MCPs do projeto dele, com ?project=', async () => {
    assert.deepStrictEqual(await keys(CAIO, { project: 'alfa' }), ['alfa.n8n'])
    assert.strictEqual((await call(CAIO, 'list')).status, 404)
    assert.strictEqual((await call(CAIO, 'list', { query: { project: 'beta' } })).status, 404)
  })

  it('o global é lido por qualquer admin, sem os agentes dos projetos que ele não administra', async () => {
    const github = async (as: string) =>
      ((await call(as, 'list')).body?.result as Array<{ key: string; agents: Array<{ id: string }> }>).find((entry) => entry.key === 'github')!.agents.map((agent) => agent.id)
    assert.deepStrictEqual(await github(ANA), ['a1'])
    assert.deepStrictEqual(await github(ROOT), ['g1'])
  })

  it('⛔ gravar: o servidor de projeto é do admin dele; o global, só do gateway', async () => {
    const body = (projectId?: string) => ({ id: 'novo', name: 'Novo', url: 'https://x.test/mcp', ...(projectId ? { projectId } : {}) })
    assert.strictEqual((await call(ANA, 'create', { body: body('alfa') })).status, 201)
    assert.strictEqual((await call(BIA, 'create', { body: body('alfa') })).status, 404)
    assert.strictEqual((await call(ROOT, 'create', { body: body('alfa') })).status, 404)
    assert.strictEqual((await call(CAIO, 'create', { body: body('alfa') })).status, 404)
    assert.strictEqual((await call(ANA, 'create', { body: body() })).status, 404, 'global só o gateway cria')
    assert.strictEqual((await call(ROOT, 'create', { body: body() })).status, 201)
    for (const handler of ['update', 'saveSecret', 'clearSecret', 'saveEnv', 'remove', 'test', 'tools', 'stopInstances', 'install'] as const) {
      const input = { params: { id: 'alfa.n8n', name: 'X' }, body: { name: 'x', secret: 'x', value: 'x' } }
      assert.strictEqual((await call(BIA, handler, input)).status, 404, `${handler}: a Bia`)
      assert.strictEqual((await call(ROOT, handler, input)).status, 404, `${handler}: o root`)
      assert.strictEqual((await call(CAIO, handler, input)).status, 404, `${handler}: o membro`)
      // install responde 422 (não é um MCP de pacote): passou da regra de acesso, que é o que importa aqui.
      assert.ok([200, 422].includes((await call(ANA, handler, input)).status), `${handler}: a Ana`)
    }
    assert.strictEqual((await call(ANA, 'update', { params: { id: 'github' }, body: { name: 'x' } })).status, 404, 'o global é do gateway')
    assert.strictEqual((await call(ROOT, 'update', { params: { id: 'github' }, body: { name: 'x' } })).status, 200)
  })

  it('⛔ o MCP que roda no host ou leva a credencial de quem conversa: só quem administra o gateway E o projeto', async () => {
    const process = { id: 'shell', name: 'Shell', projectId: 'alfa', kind: 'process', process: { command: 'bash', args: ['-c', 'id'] } }
    assert.strictEqual((await call(ANA, 'create', { body: process })).status, 404, 'comando no host')
    const caller = { id: 'espiao', name: 'Espião', projectId: 'alfa', url: 'https://x.test/mcp', auth: 'caller' }
    assert.strictEqual((await call(ANA, 'create', { body: caller })).status, 404, 'o token de quem conversa')
    assert.strictEqual((await call(ANA, 'update', { params: { id: 'alfa.n8n' }, body: { auth: 'caller' } })).status, 404, 'virar caller na edição')
  })

  it('⛔ trocar o escopo pede admin dos dois', async () => {
    assert.strictEqual((await call(ANA, 'update', { params: { id: 'alfa.n8n' }, body: { projectId: 'beta' } })).status, 404)
    assert.strictEqual((await call(ANA, 'update', { params: { id: 'alfa.n8n' }, body: { projectId: null } })).status, 404, 'tornar global é do gateway')
    assert.strictEqual((await call(ROOT, 'update', { params: { id: 'github' }, body: { projectId: 'alfa' } })).status, 404, 'o root não grava no alfa')
  })
})
