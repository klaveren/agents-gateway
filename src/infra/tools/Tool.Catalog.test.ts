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
      servers.map((server) => [server.config.id, server.tools, server.hidden]),
      [
        ['crm', ['stats'], ['search', 'run_bash']],
        ['docs', undefined, undefined],
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

  it('⛔ do MCP do gateway, agente nunca recebe as ferramentas de conversa: fala com outro só pelo `talk` local', async () => {
    const tools = [mcpTool('save_agent'), mcpTool('talk'), mcpTool('start_conversation'), mcpTool('send_message'), mcpTool('get_turn')]
    const withSelf = new ToolCatalog(fakeMcpRegistry([{ id: 'gateway', tools }]), [])
    assert.deepStrictEqual(
      (await withSelf.toolbox(['mcp:gateway/*'])).tools.map((tool) => tool.name),
      ['save_agent'],
    )
    assert.deepStrictEqual((await withSelf.toolbox(['mcp:gateway/talk'])).tools, [])
    const [sdk] = await withSelf.mcpServersFor(['mcp:gateway/*', 'mcp:gateway/talk'])
    assert.strictEqual(sdk.tools?.includes('talk') ?? false, false)
    assert.deepStrictEqual([...(sdk.hidden ?? [])].sort(), ['get_turn', 'send_message', 'start_conversation', 'talk'])
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

  it('quem pode delegar (`agent:<id>`) ganha o `talk`, só com os escolhidos; e ela recebe o contexto', async () => {
    const seen: unknown[] = []
    const withDelegation = new ToolCatalog(fakeMcpRegistry(), [localTool('run_bash', 'bash')], (allowed) => ({
      ...localTool('talk', 'ok'),
      inputSchema: { type: 'object', properties: { to: { type: 'string', enum: [...allowed] } }, required: [], additionalProperties: false },
      execute: async (_args, context) => (seen.push(context), { status: 'success', result: 'ok' }),
    }))

    assert.deepStrictEqual(
      withDelegation.localFor(['run_bash']).map((tool) => tool.name),
      ['run_bash'],
    )
    const box = await withDelegation.toolbox(['agent:tradutor', 'agent:pesquisa'])
    assert.deepStrictEqual(
      box.tools.map((tool) => [tool.name, tool.inputSchema.properties.to?.enum]),
      [['talk', ['tradutor', 'pesquisa']]],
    )
    await box.invoke('talk', {}, { sessionId: 'pai', token: 't' })
    assert.deepStrictEqual(seen, [{ sessionId: 'pai', token: 't' }])
  })
})

describe('ToolCatalog — a listagem do MCP falhou', () => {
  // A listagem vazia (o `socket hang up` do agents-mcp em 07/11): o servidor de pé, sem ferramenta listada.
  const mcp = () => fakeMcpRegistry([{ id: 'agents', tools: [] }])
  const permissions = {
    check: (_asker: unknown, subject: { value: string }) => ({ allowed: subject.value !== 'agents/story_block', reason: '' }),
    layers: () => ({ system: [], project: [] }),
  } as never

  it('a escolha explícita segue valendo, nome a nome pelas permissões', async () => {
    const [server] = await new ToolCatalog(mcp(), [], undefined, undefined, permissions).mcpServersFor(['mcp:agents/story_start', 'mcp:agents/story_block'])
    assert.deepStrictEqual(server?.tools, ['story_start'])
  })

  it('⛔ "todas" sem a lista fica sem nenhuma', async () => {
    const [server] = await new ToolCatalog(mcp(), [], undefined, undefined, permissions).mcpServersFor(['mcp:agents/*'])
    assert.deepStrictEqual(server?.tools, [])
  })
})
