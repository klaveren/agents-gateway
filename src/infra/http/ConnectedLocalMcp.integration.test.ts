import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { ProjectConnectionService } from '@application/ProjectConnection.Service'
import { makeAgentLocalLayers } from '@composition/factories/AgentLocalLayers.Factory'
import { makeAgents } from '@composition/factories/Agents.Factory'
import { makeAuth } from '@composition/factories/Auth.Factory'
import { makeAuthController, makeController, makeMcpServersController, makeProjectsController, makeProvidersController } from '@composition/factories/Controller.Factory'
import { makeMcpServers } from '@composition/factories/McpServers.Factory'
import { useConnectedProjects } from '@composition/factories/Projects.Factory'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { SqliteProjectConnectionRepository } from '@infra/persistence/Sqlite.ProjectConnectionRepository'
import { HttpServer } from './Http.Server'
import { ProjectConnectionsController } from './ProjectConnections.Controller'

const URL = 'https://mcp.exemplo.com/mcp'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TEnvelope = { ok: boolean; result?: any; code?: string; message?: string; details?: any }

/**
 * 🔌 O MCP DESTA MÁQUINA: no projeto conectado, o servidor que veio da origem é só leitura; o cadastrado aqui é
 * configuração do ambiente — nasce marcado (`local`), segue editável, e o agente o usa pela camada local.
 */
describe('projeto conectado: o MCP desta máquina (integração)', () => {
  let base: string
  let stop: () => void
  let admin = ''

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), 'X-Tool-Authorization': `Bearer ${admin}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as TEnvelope }
  }
  const readOnly = (res: { status: number; body: TEnvelope }) => assert.deepStrictEqual([res.status, res.body.code], [409, 'project_read_only'], JSON.stringify(res.body))
  const listed = async (key: string) => (await call('GET', '/mcp-servers?project=logiccus')).body.result.find((server: { key: string }) => server.key === key)

  before(async () => {
    process.env.MCP_SERVER_URL = ''
    const repository = new SqliteProjectConnectionRepository(':memory:')
    const connections = new ProjectConnectionService({
      repository,
      box: { seal: (plain: string) => plain, open: (box: string) => box },
      layers: makeAgentLocalLayers(),
      localMcps: { ids: (projectId: string) => makeMcpServers().localIn(projectId), release: (projectId: string) => makeMcpServers().releaseLocal(projectId) },
    } as never)
    const u = undefined
    const server = new HttpServer(
      makeController(),
      makeAuthController(),
      makeProvidersController(),
      u,
      makeMcpServersController(),
      ...[u, u, u],
      makeProjectsController(),
      ...[u, u, u, u, u, u, u, u, u, u, u],
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
    const setup = await fetch(`${base}/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: makeAuth().accounts?.setupCode, email: 'root@x.test', name: 'Root', password: 'frase longa o bastante' }),
    })
    const made = (await setup.json()) as TEnvelope
    assert.ok(made.result, JSON.stringify(made))
    admin = made.result.token
    for (const id of ['logiccus', 'outro']) assert.strictEqual((await call('POST', '/projects', { id, name: id })).status, 201)
    // O que "veio da origem": cadastrado ANTES de o projeto ser conectado (sem a marca).
    assert.strictEqual((await call('POST', '/mcp-servers', { id: 'agents', projectId: 'logiccus', name: 'Agents MCP', url: URL })).status, 201)
    makeAgents().save(
      {
        id: 'sre',
        name: 'sre',
        projectId: 'logiccus',
        providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-5'] }],
        systemPrompt: 'faça',
        modes: [EMode.AGENT],
        allowedTools: [],
      },
      { rules: { knownTools: [] }, by: 'seed', creating: true },
    )
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

  it('cadastra no projeto conectado: nasce "desta máquina" e segue editável; o da origem continua só leitura', async () => {
    const created = await call('POST', '/mcp-servers', { id: 'meu', projectId: 'logiccus', name: 'Meu MCP', url: URL })
    assert.strictEqual(created.status, 201, JSON.stringify(created.body))
    assert.strictEqual(created.body.result.local, true)
    const edited = await call('PUT', '/mcp-servers/logiccus.meu', { name: 'Meu MCP local', enabled: true })
    assert.deepStrictEqual([edited.status, edited.body.result.name, edited.body.result.local], [200, 'Meu MCP local', true])

    assert.strictEqual((await listed('logiccus.meu')).local, true)
    assert.strictEqual((await listed('logiccus.agents')).local, undefined)
    readOnly(await call('PUT', '/mcp-servers/logiccus.agents', { name: 'Outro nome' }))
    readOnly(await call('PUT', '/mcp-servers/logiccus.agents', { projectId: null }))
    readOnly(await call('DELETE', '/mcp-servers/logiccus.agents'))
    assert.strictEqual(makeMcpServers().get('logiccus.agents').name, 'Agents MCP')
  })

  it('o agente usa o MCP daqui pela camada local; em uso por ela, não se apaga', async () => {
    const layer = await call('PUT', '/connections/logiccus/agents/sre/local', { allowedTools: ['mcp:meu/*'], permissions: [] })
    assert.strictEqual(layer.status, 200, JSON.stringify(layer.body))
    assert.deepStrictEqual(makeAgents().get('sre')!.allowedTools, ['mcp:meu/*'])
    assert.deepStrictEqual(
      (await listed('logiccus.meu')).agents.map((agent: { id: string }) => agent.id),
      ['sre'],
    )
    const inUse = await call('DELETE', '/mcp-servers/logiccus.meu')
    assert.deepStrictEqual([inUse.status, inUse.body.code], [409, 'mcp_server_in_use'], JSON.stringify(inUse.body))
    assert.strictEqual((await call('DELETE', '/connections/logiccus/agents/sre/local')).status, 200)
  })

  it('troca de escopo: entra no projeto conectado como "desta máquina"; ao sair, deixa de ser', async () => {
    assert.strictEqual((await call('POST', '/mcp-servers', { id: 'solto', name: 'Solto', url: URL })).body.result.local, undefined)
    const entered = await call('PUT', '/mcp-servers/solto', { projectId: 'logiccus' })
    assert.deepStrictEqual([entered.status, entered.body.result.key, entered.body.result.local], [200, 'logiccus.solto', true], JSON.stringify(entered.body))
    const left = await call('PUT', '/mcp-servers/logiccus.solto', { projectId: 'outro' })
    assert.deepStrictEqual([left.status, left.body.result.key, left.body.result.local], [200, 'outro.solto', undefined], JSON.stringify(left.body))
  })

  it('apaga o MCP daqui; desconectar solta a marca, e o projeto volta a ser comum', async () => {
    assert.strictEqual((await call('POST', '/mcp-servers', { id: 'some', projectId: 'logiccus', name: 'Some', url: URL })).status, 201)
    assert.strictEqual((await call('DELETE', '/mcp-servers/logiccus.some')).status, 200)
    assert.strictEqual(await listed('logiccus.some'), undefined)

    assert.strictEqual((await call('DELETE', '/connections/logiccus')).status, 200)
    assert.strictEqual((await listed('logiccus.meu')).local, undefined)
    assert.strictEqual((await call('PUT', '/mcp-servers/logiccus.agents', { name: 'Editável de novo' })).status, 200)
  })
})
