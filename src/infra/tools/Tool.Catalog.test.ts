import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { fakeMcpRegistry, mcpTool } from '@infra/mcp/Mcp.Fake'
import { ToolCatalog } from './Tool.Catalog'
import { ILocalTool, IToolResult } from './Tool.Types'

function localTool(name: string, result: string): ILocalTool {
  return {
    origin: 'local',
    name,
    description: `local ${name}`,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute(): Promise<IToolResult> {
      return { status: 'success', result }
    },
  }
}

describe('ToolCatalog', () => {
  const contexts: Array<IExecutionContext | undefined> = []
  const registry = () =>
    fakeMcpRegistry([
      {
        id: 'crm',
        tools: [mcpTool('stats'), mcpTool('search'), mcpTool('run_bash')],
        onCall: (name, _args, context) => (contexts.push(context), { status: 'success', result: `crm:${name}` }),
      },
      { id: 'docs', tools: [mcpTool('search'), mcpTool('read')] },
      { id: 'fora', connected: false, tools: [mcpTool('nada')] },
    ])
  const catalog = () => new ToolCatalog(registry(), [localTool('run_bash', 'local bash'), localTool('search_web', 'web')])

  it('filtra as locais pelo que o agente declarou', () => {
    assert.deepStrictEqual(
      catalog()
        .localFor(['search_web'])
        .map((tool) => tool.name),
      ['search_web'],
    )
  })

  it('⛔ o agente só vê o MCP que escolheu: nada de MCP sem `mcp:` e, de um servidor, só as escolhidas', async () => {
    assert.deepStrictEqual(
      (await catalog().toolbox(['search_web'])).tools.map((tool) => tool.name),
      ['search_web'],
    )
    assert.deepStrictEqual(
      (await catalog().toolbox(['mcp:crm/stats'])).tools.map((tool) => tool.name),
      ['stats'],
    )
    assert.deepStrictEqual((await catalog().toolbox(['mcp:docs/*'])).tools.map((tool) => tool.name).sort(), ['read', 'search'])
  })

  it('⚖️ nome repetido entre servidores (ou igual a uma local) ganha o prefixo do servidor; a local vence', async () => {
    const box = await catalog().toolbox(['run_bash', 'mcp:crm/*', 'mcp:docs/search'])

    assert.deepStrictEqual(box.tools.map((tool) => tool.name).sort(), ['crm__run_bash', 'crm__search', 'docs__search', 'run_bash', 'stats'])
    assert.deepStrictEqual(await box.invoke('run_bash', {}), { status: 'success', result: 'local bash' })
    assert.deepStrictEqual(await box.invoke('crm__search', {}), { status: 'success', result: 'crm:search' })
    assert.deepStrictEqual(await box.invoke('docs__search', {}), { status: 'success', result: 'docs:search' })
    assert.strictEqual((await box.invoke('read', {})).status, 'error')
  })

  it('servidor fora do ar não derruba a caixa: o agente segue com o resto', async () => {
    assert.deepStrictEqual(
      (await catalog().toolbox(['mcp:fora/*', 'mcp:crm/stats'])).tools.map((tool) => tool.name),
      ['stats'],
    )
  })

  it('os SDKs agênticos recebem só os servidores do agente que estão de pé, com o filtro de ferramentas', async () => {
    const servers = await catalog().mcpServersFor(['mcp:crm/stats', 'mcp:docs/*', 'mcp:fora/*', 'search_web'])

    assert.deepStrictEqual(
      servers.map((server) => [server.config.id, server.tools]),
      [
        ['crm', ['stats']],
        ['docs', undefined],
      ],
    )
  })

  it('⚖️ servidor `caller` que recusa a conexão anônima (o MCP do gateway) chega ao SDK com a credencial de quem conversa', async () => {
    const withSelf = new ToolCatalog(fakeMcpRegistry([{ id: 'gateway', connected: false, acceptsToken: 'tok-admin', tools: [mcpTool('save_agent')] }]), [])
    assert.deepStrictEqual(
      (await withSelf.mcpServersFor(['mcp:gateway/*'], { token: 'tok-admin' } as IExecutionContext)).map((server) => server.config.id),
      ['gateway'],
    )
    assert.deepStrictEqual(await withSelf.mcpServersFor(['mcp:gateway/*']), [])
  })

  it('⚖️ na lane chat, a caixa lista as ferramentas do MCP `caller` com a credencial de quem conversa', async () => {
    const withSelf = new ToolCatalog(fakeMcpRegistry([{ id: 'gateway', connected: false, acceptsToken: 'tok-admin', tools: [mcpTool('save_agent')] }]), [])
    assert.deepStrictEqual(
      (await withSelf.toolbox(['mcp:gateway/*'], { token: 'tok-admin' } as IExecutionContext)).tools.map((tool) => tool.name),
      ['save_agent'],
    )
    assert.deepStrictEqual((await withSelf.toolbox(['mcp:gateway/*'])).tools, [])
  })

  it('leva a credencial da chamada até o cliente MCP', async () => {
    contexts.length = 0
    const box = await catalog().toolbox(['mcp:crm/stats'])
    await box.invoke('stats', {}, { token: 'abc' })
    await box.invoke('stats', {})

    assert.deepStrictEqual(contexts, [{ token: 'abc' }, undefined])
  })

  it('invoke por nome: local, `servidor/ferramenta`, e nome solto no servidor `default`', async () => {
    const withDefault = new ToolCatalog(fakeMcpRegistry([{ id: 'default', tools: [mcpTool('whoami')] }, { id: 'crm' }]), [localTool('run_bash', 'local bash')])

    assert.deepStrictEqual(await withDefault.invoke('run_bash', {}), { status: 'success', result: 'local bash' })
    assert.deepStrictEqual(await withDefault.invoke('crm/stats', {}), { status: 'success', result: 'crm:stats' })
    assert.deepStrictEqual(await withDefault.invoke('whoami', {}), { status: 'success', result: 'default:whoami' })
    assert.strictEqual((await withDefault.invoke('nao-existe/x', {})).status, 'error')
  })

  it('quem pode delegar (`agent:<id>`) ganha a delegate_to_agent, só com os escolhidos; e ela recebe o contexto', async () => {
    const seen: unknown[] = []
    const withDelegation = new ToolCatalog(fakeMcpRegistry(), [localTool('run_bash', 'bash')], (allowed) => ({
      ...localTool('delegate_to_agent', 'ok'),
      inputSchema: { type: 'object', properties: { agentId: { type: 'string', enum: [...allowed] } }, required: [], additionalProperties: false },
      execute: async (_args, context) => (seen.push(context), { status: 'success', result: 'ok' }),
    }))

    assert.deepStrictEqual(
      withDelegation.localFor(['run_bash']).map((tool) => tool.name),
      ['run_bash'],
    )
    const box = await withDelegation.toolbox(['agent:tradutor', 'agent:pesquisa'])
    assert.deepStrictEqual(
      box.tools.map((tool) => [tool.name, tool.inputSchema.properties.agentId?.enum]),
      [['delegate_to_agent', ['tradutor', 'pesquisa']]],
    )
    await box.invoke('delegate_to_agent', {}, { sessionId: 'pai', token: 't' })
    assert.deepStrictEqual(seen, [{ sessionId: 'pai', token: 't' }])
  })
})
