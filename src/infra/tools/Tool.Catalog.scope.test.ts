import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import express from 'express'
import { agentIssues, IAgentRules } from '@domain/Agent.Policy'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IMcpServerRepository } from '@domain/ports/McpServerRepository.Port'
import { McpProxyController } from '@infra/http/McpProxy.Controller'
import { fakeMcpRegistry, mcpTool } from '@infra/mcp/Mcp.Fake'
import { McpRegistry } from '@infra/mcp/Mcp.Registry'
import { codexMcpServers } from '@infra/adapters/CodexAgent.Adapter'
import { buildClaudeMcpServers } from './bridges/Claude.ToolBridge'
import { ToolCatalog } from './Tool.Catalog'

const A = { projectId: 'cliente-a', sessionId: 's-a' }
const B = { projectId: 'cliente-b', sessionId: 's-b' }
const GLOBAL = { sessionId: 's-g' }

/** Dois projetos com o MESMO `n8n` (cada um com a sua chave) e um `pw` global. */
const registry = () =>
  fakeMcpRegistry([
    { id: 'n8n', projectId: 'cliente-a', auth: 'header', secret: 'chave-de-a', tools: [mcpTool('fluxo_a')] },
    { id: 'n8n', projectId: 'cliente-b', auth: 'header', secret: 'chave-de-b', tools: [mcpTool('fluxo_b')] },
    { id: 'pw', tools: [mcpTool('snap')] },
  ])
const repositoryOf = (mcp: McpRegistry) => (mcp as unknown as { servers: IMcpServerRepository }).servers

describe('MCP de projeto — isolamento em tempo de execução', () => {
  it('toolbox (lanes chat, ADK, Antigravity): cada agente resolve o n8n do SEU projeto; o global, só o global', async () => {
    const catalog = new ToolCatalog(registry(), [])
    const names = async (allowed: string[], context: object) => (await catalog.toolbox(allowed, context)).tools.map((tool) => tool.name).sort()

    assert.deepStrictEqual(await names(['mcp:n8n/*', 'mcp:pw/*'], A), ['fluxo_a', 'snap'])
    assert.deepStrictEqual(await names(['mcp:n8n/*', 'mcp:pw/*'], B), ['fluxo_b', 'snap'])
    // ⛔ Agente global não usa MCP de projeto; agente de outro projeto, também não.
    assert.deepStrictEqual(await names(['mcp:n8n/*', 'mcp:pw/*'], GLOBAL), ['snap'])
    assert.deepStrictEqual(await names(['mcp:n8n/*'], { projectId: 'cliente-c' }), [])

    const boxA = await catalog.toolbox(['mcp:n8n/*'], A)
    assert.deepStrictEqual(await boxA.invoke('fluxo_a', {}, A), { status: 'success', result: 'cliente-a.n8n:fluxo_a' })
    // O nome de B não existe na caixa de A.
    assert.strictEqual((await boxA.invoke('fluxo_b', {}, A)).status, 'error')
  })

  it('⛔ invoke pelo nome: resolve no escopo do contexto, nunca no de outro projeto', async () => {
    const catalog = new ToolCatalog(registry(), [])
    assert.deepStrictEqual(await catalog.invoke('mcp:n8n/fluxo_b', {}, A), { status: 'success', result: 'cliente-a.n8n:fluxo_b' })
    assert.deepStrictEqual(await catalog.invoke('mcp:n8n/fluxo_b', {}, B), { status: 'success', result: 'cliente-b.n8n:fluxo_b' })
    assert.strictEqual((await catalog.invoke('mcp:n8n/fluxo_a', {}, GLOBAL)).status, 'error')
    assert.strictEqual((await catalog.invoke('n8n/fluxo_a', {})).status, 'error')
  })

  it('⛔ a caixa montada não chama o servidor que mudou de projeto depois (defesa em profundidade)', async () => {
    const mcp = registry()
    const catalog = new ToolCatalog(mcp, [])
    const box = await catalog.toolbox(['mcp:n8n/*'], A)
    repositoryOf(mcp).move('cliente-a.n8n', 'cliente-c', new Date(), 'root')
    assert.match((await box.invoke('fluxo_a', {}, A)).result, /unavailable/)
  })

  it('mcpServersFor (SDK do Claude, Codex, OpenAI): config, URL e credencial só do escopo do agente', async () => {
    const catalog = new ToolCatalog(registry(), [])
    const ofA = await catalog.mcpServersFor(['mcp:n8n/*', 'mcp:pw/*'], A)
    assert.deepStrictEqual(
      ofA.map((remote) => [remote.config.id, remote.config.projectId, remote.config.url, remote.header?.value]),
      [
        ['n8n', 'cliente-a', 'http://localhost:8000/cliente-a.n8n/mcp', 'chave-de-a'],
        ['pw', undefined, 'http://localhost:8000/pw/mcp', undefined],
      ],
    )
    const ofB = await catalog.mcpServersFor(['mcp:n8n/*'], B)
    assert.deepStrictEqual(
      ofB.map((remote) => remote.header?.value),
      ['chave-de-b'],
    )
    assert.deepStrictEqual(
      (await catalog.mcpServersFor(['mcp:n8n/*', 'mcp:pw/*'], GLOBAL)).map((remote) => remote.config.id),
      ['pw'],
    )

    // O que cada lane recebe de fato: nenhuma traz a chave do outro projeto.
    const codex = JSON.stringify(codexMcpServers(ofA, 'tk', A))
    const claude = JSON.stringify(buildClaudeMcpServers([], ofA, 'tk', A))
    for (const lane of [codex, claude]) {
      assert.ok(lane.includes('chave-de-a'))
      assert.ok(!lane.includes('chave-de-b'))
      assert.ok(!lane.includes('cliente-b'))
    }
  })

  it('contêiner de projeto: o SDK chega pelo proxy com a CHAVE na URL', async () => {
    const mcp = registry()
    const now = new Date()
    repositoryOf(mcp).insert({
      id: 'browser',
      projectId: 'cliente-a',
      name: 'Browser',
      kind: 'container',
      container: { image: 'x/y:1', args: [], writable: [], memoryMb: 256, cpus: 1, network: 'none', allowedHosts: [], env: [] },
      url: '',
      transport: 'auto',
      auth: 'none',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })
    const catalog = new ToolCatalog(mcp, [], undefined, { base: 'http://127.0.0.1:3000/v1/mcp-proxy' })
    assert.deepStrictEqual(
      (await catalog.mcpServersFor(['mcp:browser/*'], A)).map((remote) => remote.config.url),
      ['http://127.0.0.1:3000/v1/mcp-proxy/cliente-a.browser'],
    )
    assert.deepStrictEqual(await catalog.mcpServersFor(['mcp:browser/*'], B), [])
  })
})

describe('MCP de projeto — o proxy confere o projeto do agente da conversa', () => {
  const agents: Record<string, { allowedTools: string[]; projectId?: string }> = {
    'de-a': { allowedTools: ['mcp:n8n/*'], projectId: 'cliente-a' },
    'de-b': { allowedTools: ['mcp:n8n/*'], projectId: 'cliente-b' },
    global: { allowedTools: ['mcp:n8n/*', 'mcp:pw/*'] },
  }
  const sessions: Record<string, string> = { 's-a': 'de-a', 's-b': 'de-b', 's-g': 'global' }

  async function post(serverKey: string, sessionId: string): Promise<number> {
    const controller = new McpProxyController({
      registry: registry(),
      session: (id) => (sessions[id] ? { agentId: sessions[id] } : undefined),
      agent: (id) => agents[id],
    })
    const app = express()
    app.post('/p/:serverId', express.json(), controller.handle)
    const server = app.listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/p/${serverKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-Gateway-Session': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      })
      await res.text()
      return res.status
    } finally {
      server.close()
    }
  }

  it('⛔ agente de B não alcança o n8n de A; agente global não alcança MCP de projeto', async () => {
    assert.strictEqual(await post('cliente-a.n8n', 's-a'), 200)
    assert.strictEqual(await post('cliente-a.n8n', 's-b'), 404)
    assert.strictEqual(await post('cliente-b.n8n', 's-g'), 404)
    assert.strictEqual(await post('pw', 's-g'), 200)
  })
})

describe('MCP de projeto — validação ao salvar o agente', () => {
  const agent = (allowedTools: string[], projectId?: string): IAgent => ({
    id: 'x',
    name: 'X',
    ...(projectId ? { projectId } : {}),
    providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-4-5'] }],
    systemPrompt: 'p',
    modes: [EMode.CHAT],
    allowedTools,
  })

  it('⛔ mcp:<id>/… tem de existir no escopo visível ao agente', () => {
    const mcp = registry()
    const rules: IAgentRules = { takenIds: [], knownTools: [], mcpServerExists: (id, projectId) => !!mcp.resolve(id, projectId) }
    const mcpIssues = (allowed: string[], projectId?: string) => agentIssues(agent(allowed, projectId), rules).filter((issue) => issue.field === 'allowedTools')

    assert.deepStrictEqual(mcpIssues(['mcp:n8n/*', 'mcp:pw/*'], 'cliente-a'), [])
    assert.deepStrictEqual(mcpIssues(['mcp:n8n/*'], 'cliente-b'), [])
    assert.strictEqual(mcpIssues(['mcp:n8n/*'], 'cliente-c').length, 1)
    assert.match(mcpIssues(['mcp:n8n/*'])[0]?.message ?? '', /unknown MCP server: n8n/)
    assert.deepStrictEqual(mcpIssues(['mcp:pw/*']), [])
  })
})
