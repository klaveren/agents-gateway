import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { ProjectConnectionService } from '@application/ProjectConnection.Service'
import { makeAgentLocalLayers } from '@composition/factories/AgentLocalLayers.Factory'
import { makeAgents } from '@composition/factories/Agents.Factory'
import { makeAuth } from '@composition/factories/Auth.Factory'
import { makeAuthController, makeController, makePermissionRequestsController, makeProjectsController, makeProvidersController } from '@composition/factories/Controller.Factory'
import { useConnectedProjects } from '@composition/factories/Projects.Factory'
import { AUTO_TOOLS } from '@domain/Auto.Tools'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { SqliteProjectConnectionRepository } from '@infra/persistence/Sqlite.ProjectConnectionRepository'
import { HttpServer } from './Http.Server'
import { ProjectConnectionsController } from './ProjectConnections.Controller'

const PASSWORD = 'frase longa o bastante'
const AUTO = AUTO_TOOLS[0]
const LOCAL = '/connections/logiccus/agents/sre/local'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TEnvelope = { ok: boolean; result?: any; code?: string; message?: string; details?: any }

/**
 * 🔌 A CAMADA LOCAL: no projeto conectado, o que veio da origem não muda; modelos, ferramentas, delegação e permissões
 * desta máquina — e o que veio de lá e não vale aqui — ficam numa camada por agente, que entra no agente que RODA e
 * nunca no que está gravado.
 */
describe('projeto conectado: a camada local do agente (integração)', () => {
  let base: string
  let stop: () => void
  let admin = ''
  let jar = ''
  let csrf = ''

  const bearer = () => ({ 'X-Tool-Authorization': `Bearer ${admin}` })
  const origin = () => `http://${new URL(base).host}`
  const screen = () => ({ Cookie: jar, Origin: origin(), 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'X-CSRF': csrf })
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = bearer()) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as TEnvelope }
  }
  const agent = (input: Partial<IAgent> & { id: string }) =>
    makeAgents().save(
      { name: input.id, providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-5'] }], systemPrompt: 'faça', modes: [EMode.AGENT], allowedTools: [], ...input },
      { rules: { knownTools: [], agentExists: () => true }, by: 'seed', creating: true },
    )
  const stored = () => makeAgents().entry('sre')!.agent
  const running = () => makeAgents().get('sre')!

  before(async () => {
    const repository = new SqliteProjectConnectionRepository(':memory:')
    const connections = new ProjectConnectionService({ repository, box: { seal: (plain: string) => plain, open: (box: string) => box }, layers: makeAgentLocalLayers() } as never)
    const u = undefined
    const server = new HttpServer(
      makeController(),
      makeAuthController(),
      makeProvidersController(),
      ...[u, u, u, u, u],
      makeProjectsController(),
      ...[u, u, u, u, u, u, u],
      makePermissionRequestsController(),
      u,
      u,
      u,
      new ProjectConnectionsController({ connections, layers: makeAgentLocalLayers(), proof: makeAuth().proof }),
    ).start(0)
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
      useConnectedProjects(() => undefined)
    }
    const setup = await call('POST', '/auth/setup', { code: makeAuth().accounts?.setupCode, email: 'root@x.test', name: 'Root', password: PASSWORD }, {})
    admin = setup.body.result.token
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gateway-Client': 'web', Origin: origin() },
      body: JSON.stringify({ email: 'root@x.test', password: PASSWORD }),
    })
    const cookies = login.headers.getSetCookie().map((line) => line.split(';')[0])
    jar = cookies.find((item) => item.startsWith('gw_session_')) ?? ''
    csrf = decodeURIComponent((cookies.find((item) => item.startsWith('gw_csrf_')) ?? '').split('=')[1] ?? '')
    // Delegar pede um alvo que RODA: provedor com chave (a de teste, no cofre em memória) e modelo ativo.
    assert.strictEqual((await call('PUT', '/providers/claude/key', { key: 'sk-ant-chave-de-teste-da-camada-local-0000' })).status, 200)
    for (const modelId of ['claude-sonnet-5', 'claude-haiku-5']) {
      await call('POST', '/providers/claude/models', { modelId })
      await call('PUT', '/providers/claude/models', { modelId, enabled: true })
    }
    for (const id of ['logiccus', 'outro']) assert.strictEqual((await call('POST', '/projects', { id, name: id })).status, 201)
    agent({ id: 'ajudante' })
    agent({ id: 'de-fora', projectId: 'outro' })
    agent({ id: 'ops', projectId: 'logiccus', allowedTools: ['agent:ajudante'] })
    agent({
      id: 'sre',
      projectId: 'logiccus',
      allowedTools: [`off:${AUTO}`],
      permissions: [{ category: 'terminal', pattern: 'git push *', decision: 'deny' }],
    })
    repository.insert(
      {
        projectId: 'logiccus',
        url: 'http://origem.test',
        remoteProjectId: 'logiccus',
        syncedVersion: 1,
        latestVersion: 1,
        state: 'ok',
        changes: [],
        skipped: [],
        secrets: [],
        modelMap: {},
        createdAt: new Date(),
        createdBy: 'dev',
      },
      'agc_x',
    )
    useConnectedProjects((projectId) => connections.get(projectId))
  })

  after(() => stop())

  it('grava a camada: o agente RODA com ela, e o gravado (a origem) não muda', async () => {
    const saved = await call('PUT', LOCAL, {
      providers: [{ provider: 'claude', models: ['claude-haiku-5'] }],
      allowedTools: ['agent:ajudante', AUTO],
      permissions: [{ category: 'terminal', pattern: 'npm test', decision: 'allow' }],
    })
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body))
    assert.deepStrictEqual(saved.body.result.layer.allowedTools, ['agent:ajudante', AUTO])
    assert.deepStrictEqual(saved.body.result.origin.allowedTools, [`off:${AUTO}`])

    assert.deepStrictEqual(running().providers, [{ provider: 'claude', models: ['claude-haiku-5'] }])
    assert.deepStrictEqual(running().allowedTools, ['agent:ajudante'])
    assert.deepStrictEqual(
      running().permissions?.map((rule) => rule.pattern),
      ['git push *', 'npm test'],
    )
    assert.deepStrictEqual(stored().providers, [{ provider: 'claude', models: ['claude-sonnet-5'] }])
    assert.deepStrictEqual(stored().allowedTools, [`off:${AUTO}`])
    assert.strictEqual(stored().permissions?.length, 1)

    const read = await call('GET', LOCAL)
    assert.deepStrictEqual(read.body.result.layer.providers, [{ provider: 'claude', models: ['claude-haiku-5'] }])
  })

  it('desliga o que veio da origem: o agente roda sem aquilo, o gravado não muda, e a atualização não religa', async () => {
    const OPS = '/connections/logiccus/agents/ops/local'
    const ops = () => makeAgents().get('ops')!
    const saved = await call('PUT', OPS, { allowedTools: [], disabledTools: ['agent:ajudante', AUTO_TOOLS[1], 'agent:fantasma'], permissions: [] })
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body))
    // Só fica o que a origem tem.
    assert.deepStrictEqual(saved.body.result.layer.disabledTools, ['agent:ajudante', AUTO_TOOLS[1]])
    assert.deepStrictEqual(saved.body.result.origin.allowedTools, ['agent:ajudante'])
    assert.deepStrictEqual(ops().allowedTools, [`off:${AUTO_TOOLS[1]}`])
    assert.deepStrictEqual(makeAgents().entry('ops')!.agent.allowedTools, ['agent:ajudante'])

    // A atualização regrava o agente como está na origem: a camada continua valendo.
    makeAgents().save(makeAgents().entry('ops')!.agent, { rules: { knownTools: [], agentExists: () => true }, by: 'sync', creating: false })
    assert.deepStrictEqual(ops().allowedTools, [`off:${AUTO_TOOLS[1]}`])
    assert.deepStrictEqual((await call('GET', OPS)).body.result.layer.disabledTools, ['agent:ajudante', AUTO_TOOLS[1]])

    // Religar a delegação: sai da lista, e ela volta a valer.
    const back = await call('PUT', OPS, { allowedTools: [], disabledTools: [AUTO_TOOLS[1]], permissions: [] })
    assert.deepStrictEqual(back.body.result.layer.disabledTools, [AUTO_TOOLS[1]])
    assert.deepStrictEqual(ops().allowedTools, ['agent:ajudante', `off:${AUTO_TOOLS[1]}`])
  })

  it('⛔ a camada passa pelas regras do cadastro, e o catálogo segue só leitura', async () => {
    const refused = async (layer: Record<string, unknown>, field: string, message: RegExp) => {
      const res = await call('PUT', LOCAL, { allowedTools: [], permissions: [], ...layer })
      assert.strictEqual(res.status, 422, JSON.stringify(res.body))
      const issue = (res.body.details as Array<{ field: string; message: string }>).find((item) => item.field === field)
      assert.match(issue?.message ?? '', message, JSON.stringify(res.body.details))
    }
    await refused({ allowedTools: ['mcp:nao-existe/*'] }, 'allowedTools', /unknown MCP server/)
    await refused({ allowedTools: ['agent:fantasma'] }, 'allowedTools', /unknown agent/)
    await refused({ allowedTools: ['agent:de-fora'] }, 'allowedTools', /de-fora/)
    await refused({ allowedTools: [`off:${AUTO_TOOLS[1]}`] }, 'allowedTools', /cannot turn off/)
    await refused({ providers: [{ provider: 'claude', models: ['claude-desligado'] }] }, 'models', /claude-desligado/)
    // O que não deu certo não gravou nada.
    assert.deepStrictEqual(running().allowedTools, ['agent:ajudante'])

    assert.strictEqual((await call('GET', '/connections/logiccus/agents/ajudante/local')).status, 404)
    assert.strictEqual((await call('PUT', '/connections/outro/agents/de-fora/local', { allowedTools: [], permissions: [] })).status, 404)
    const catalog = await call('PUT', '/agents/sre', { ...stored(), name: 'Outro nome' })
    assert.deepStrictEqual([catalog.status, catalog.body.code], [409, 'project_read_only'])
  })

  it('pedido de permissão: o que restringe e o que a tela aprova vão para a camada, não para o agente', async () => {
    const asked = await call('POST', '/agents/sre/permission-rules', {
      add: [
        { category: 'network', pattern: '*.evil.com', decision: 'deny' },
        { category: 'terminal', pattern: 'npm run build', decision: 'allow' },
      ],
      reason: 'rodar o build',
    })
    assert.strictEqual(asked.status, 200, JSON.stringify(asked.body))
    const [request] = asked.body.result.pending
    const approved = await call('POST', `/permission-requests/${request.id}/approve`, { confirm: request.widenings.map((item: { key: string }) => item.key) }, screen())
    assert.strictEqual(approved.status, 200, JSON.stringify(approved.body))

    const view = await call('GET', '/agents/sre/permission-rules')
    assert.deepStrictEqual(
      view.body.result.rules.map((rule: { pattern: string }) => rule.pattern),
      ['npm test', '*.evil.com', 'npm run build'],
    )
    assert.deepStrictEqual(
      view.body.result.origin.map((rule: { pattern: string }) => rule.pattern),
      ['git push *'],
    )
    assert.strictEqual(stored().permissions?.length, 1)
    // ⛔ A negação da origem não sai por aqui: ela não é uma regra local.
    const remove = await call('POST', '/agents/sre/permission-rules', { remove: [{ category: 'terminal', pattern: 'git push *', decision: 'deny' }], reason: 'liberar o push' })
    assert.strictEqual(remove.status, 422)
    // As regras do PROJETO conectado continuam da origem.
    const project = await call('POST', '/projects/logiccus/permission-rules', { add: [{ category: 'network', pattern: '*.x.com', decision: 'deny' }], reason: 'x' })
    assert.deepStrictEqual([project.status, project.body.code], [409, 'project_read_only'])
  })

  it('apagar a camada devolve o agente como veio; desconectar aplica a camada no agente', async () => {
    const before = await call('GET', LOCAL)
    assert.strictEqual((await call('DELETE', LOCAL)).status, 200)
    assert.deepStrictEqual(running(), stored())

    assert.strictEqual((await call('PUT', LOCAL, before.body.result.layer)).status, 200)
    assert.strictEqual((await call('DELETE', '/connections/logiccus')).status, 200)
    assert.deepStrictEqual(stored().providers, [{ provider: 'claude', models: ['claude-haiku-5'] }])
    assert.deepStrictEqual(stored().allowedTools, ['agent:ajudante'])
    assert.strictEqual(stored().permissions?.length, 4)
    assert.strictEqual(makeAgentLocalLayers().of(stored()), undefined)
    // O que estava desligado aqui sai do agente de vez.
    assert.deepStrictEqual(makeAgents().entry('ops')!.agent.allowedTools, ['agent:ajudante', `off:${AUTO_TOOLS[1]}`])
    // Projeto comum de novo: o agente é editável.
    assert.strictEqual((await call('GET', LOCAL)).status, 404)
  })
})
