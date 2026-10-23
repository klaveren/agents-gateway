import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { query } from '@anthropic-ai/claude-agent-sdk'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { fakeMcpRegistry, mcpTool } from '@infra/mcp/Mcp.Fake'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { ILocalTool } from '@infra/tools/Tool.Types'
import { ClaudeAgentAdapter } from './ClaudeAgent.Adapter'

type TQuery = typeof query
type TQueryParams = Parameters<TQuery>[0]

const CLI_SESSION_ID = '11111111-2222-4333-8444-555555555555'

describe('ClaudeAgentAdapter', () => {
  const getAgent = (): IAgent => ({
    id: 'sysops-agent',
    name: 'SysOps',
    provider: EProvider.CLAUDE,
    systemPrompt: 'You are a system operator.',
    models: ['claude-sonnet-5'],
    modes: [EMode.CHAT, EMode.AGENT],
    allowedTools: ['run_bash', 'mcp:crm/read_file'],
  })

  const turn = () => [
    { type: 'system', subtype: 'init', session_id: CLI_SESSION_ID },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Listing' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'run_bash', input: { command: 'ls' } }] },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] } },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      usage: { input_tokens: 12, output_tokens: 34 },
    },
  ]

  const queryWith = (messages: () => unknown[], seen: TQueryParams[] = []): TQuery =>
    ((params: TQueryParams) => {
      seen.push(params)
      return (async function* () {
        for (const message of messages()) yield message
      })()
    }) as unknown as TQuery

  const drain = async (events: AsyncIterable<IAgentEvent>): Promise<IAgentEvent[]> => {
    const collected: IAgentEvent[] = []
    for await (const event of events) collected.push(event)
    return collected
  }

  const localTool = (name: string): ILocalTool => ({
    origin: 'local',
    name,
    description: `local ${name}`,
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'cmd' } },
      required: ['command'],
      additionalProperties: false,
    },
    async execute() {
      return { status: 'success', result: 'ok' }
    },
  })

  const catalogWith = (connected: boolean) => new ToolCatalog(fakeMcpRegistry([{ id: 'crm', connected, tools: [mcpTool('read_file')] }]), [localTool('run_bash')])

  it('creates a session on the agent lane', async () => {
    const adapter = new ClaudeAgentAdapter({ query: queryWith(() => []) })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })

    assert.ok(session.id.startsWith('claude-agent-'))
    assert.strictEqual(session.mode, EMode.AGENT)
  })

  it('translates the SDK message stream into gateway events', async () => {
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn) })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'list files' }, {}))

    assert.ok(events.find((e) => e.type === 'text.delta' && e.payload.text === 'Listing'))
    assert.ok(events.find((e) => e.type === 'reasoning.delta' && e.payload.text === 'hmm'))
    assert.ok(events.find((e) => e.type === 'tool.started' && e.payload.tool === 'run_bash' && e.payload.args.command === 'ls'))
    // O bloco de resultado só carrega o tool_use_id; o evento tem de sair com o nome,
    // senão o agregador não consegue casar chamada e resultado.
    assert.ok(events.find((e) => e.type === 'tool.result' && e.payload.tool === 'run_bash'))
    assert.ok(events.find((e) => e.type === 'usage' && e.payload.outputTokens === 34))
    assert.strictEqual(events[events.length - 1].type, 'message.completed')
  })

  it('never runs a hand-rolled tool loop: no tools and no host settings leak in', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen) })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent', reasoning: 'high' })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.deepStrictEqual(seen[0].options?.tools, [])
    assert.deepStrictEqual(seen[0].options?.settingSources, [])
    assert.strictEqual(seen[0].options?.effort, 'high')
    assert.ok(seen[0].options?.abortController instanceof AbortController)
  })

  it('hands the key in effect to the CLI subprocess, read on every turn', async () => {
    const seen: TQueryParams[] = []
    let key = 'sk-ant-primeira'
    const adapter = new ClaudeAgentAdapter({
      query: queryWith(turn, seen),
      connections: { connection: (id) => ({ providerId: id, name: 'Claude', protocol: EProvider.CLAUDE, key }) },
    })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })

    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))
    key = 'sk-ant-segunda'
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.strictEqual(seen[0].options?.env?.ANTHROPIC_API_KEY, 'sk-ant-primeira')
    assert.strictEqual(seen[1].options?.env?.ANTHROPIC_API_KEY, 'sk-ant-segunda')
  })

  it('a compatible provider (OpenRouter) goes through ANTHROPIC_BASE_URL with the key as a bearer token, never as the Anthropic key', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({
      query: queryWith(turn, seen),
      connections: { connection: (id) => ({ providerId: id, name: 'OpenRouter', protocol: EProvider.CLAUDE, baseUrl: 'https://openrouter.ai/api', key: 'sk-or-123' }) },
    })
    const session = await adapter.createSession({ ...getAgent(), provider: 'openrouter' }, { agentId: 'sysops-agent' })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.strictEqual(seen[0].options?.env?.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api')
    assert.strictEqual(seen[0].options?.env?.ANTHROPIC_AUTH_TOKEN, 'sk-or-123')
    assert.strictEqual(seen[0].options?.env?.ANTHROPIC_API_KEY, '')
  })

  it('without any key, the turn ends with an error that says where to fix it — and the CLI never starts', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), connections: { connection: (id) => ({ providerId: id, name: 'Claude', protocol: EProvider.CLAUDE }) } })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.strictEqual(seen.length, 0)
    assert.ok(events.find((event) => event.type === 'error' && String(event.payload.message).includes('Providers')))
  })

  it('liga só as nativas do agente no CLI, o gate as aprova, e avisa quando o init não traz uma delas', async () => {
    const seen: TQueryParams[] = []
    const init = { type: 'system', subtype: 'init', session_id: 'cli-1', tools: ['WebSearch'] }
    const adapter = new ClaudeAgentAdapter({ query: queryWith(() => [init, ...turn()], seen) })
    const agent = { ...getAgent(), allowedTools: ['sdk:WebSearch', 'sdk:TodoWrite'] }
    const session = await adapter.createSession(agent, { agentId: 'sysops-agent' })
    const events = await drain(adapter.sendMessage(agent, session.id, { text: 'hi' }, {}))

    assert.deepStrictEqual(seen[0].options?.tools, ['WebSearch', 'TodoWrite'])
    const gate = seen[0].options?.canUseTool as (name: string, input: Record<string, unknown>, options: unknown) => Promise<{ behavior: string }>
    assert.strictEqual((await gate('WebSearch', {}, {})).behavior, 'allow')
    assert.strictEqual((await gate('Bash', {}, {})).behavior, 'deny')
    assert.ok(events.find((event) => event.type === 'warning' && String(event.payload.message).includes('TodoWrite')))
  })

  it('sem nativas, nenhum built-in: tools continua vazio', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen) })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.deepStrictEqual(seen[0].options?.tools, [])
  })

  it('plants a uuid on the first turn and resumes the CLI session afterwards', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen) })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })

    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'first' }, {}))
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'second' }, {}))

    // Turno 1: id nosso, em UUID limpo — o SDK recusa qualquer outro formato.
    const planted = seen[0].options?.sessionId
    assert.match(String(planted), /^[0-9a-f-]{36}$/)
    assert.strictEqual(seen[0].options?.resume, undefined)

    // Turno 2: retoma o id que o CLI reportou, não o id do gateway.
    assert.strictEqual(seen[1].options?.resume, CLI_SESSION_ID)
    assert.strictEqual(seen[1].options?.sessionId, undefined)
  })

  it('switches to streaming input when there are attachments', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen) })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })

    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'plain' }, {}))
    await drain(
      adapter.sendMessage(
        getAgent(),
        session.id,
        {
          text: 'look',
          files: [{ name: 'a.png', mimeType: 'image/png', data: 'aaa' }],
        },
        {},
      ),
    )

    assert.strictEqual(typeof seen[0].prompt, 'string')
    assert.strictEqual(typeof seen[1].prompt, 'object')
  })

  it('hands tools to the SDK as MCP servers, local and remote', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), catalog: catalogWith(true) })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    const servers = seen[0].options?.mcpServers ?? {}
    assert.deepStrictEqual(Object.keys(servers).sort(), ['gateway', 'mcp_crm'])
    // Built-ins seguem desligados: o agente não ganha Bash/Read sobre a máquina do host.
    assert.deepStrictEqual(seen[0].options?.tools, [])
  })

  it('omits the remote server when no MCP is connected', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), catalog: catalogWith(false) })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.deepStrictEqual(Object.keys(seen[0].options?.mcpServers ?? {}), ['gateway'])
  })

  it('gates tool use through canUseTool instead of allowedTools', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), catalog: catalogWith(true) })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    const gate = seen[0].options?.canUseTool
    assert.ok(gate)
    // `allowedTools` com nome solto sombrearia o callback, então tem de ficar ausente.
    assert.strictEqual(seen[0].options?.allowedTools, undefined)

    const options = { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1' }
    assert.strictEqual((await gate('mcp__gateway__run_bash', {}, options))?.behavior, 'allow')
    assert.strictEqual((await gate('mcp__mcp_crm__read_file', {}, options))?.behavior, 'allow')
    // ⛔ Do servidor escolhido, só a ferramenta escolhida; de servidor que o agente não tem, nada.
    assert.strictEqual((await gate('mcp__mcp_crm__delete_all', {}, options))?.behavior, 'deny')
    assert.strictEqual((await gate('mcp__mcp_outro__read_file', {}, options))?.behavior, 'deny')
    assert.strictEqual((await gate('Bash', {}, options))?.behavior, 'deny')
    assert.strictEqual((await gate('mcp__gateway__search_web', {}, options))?.behavior, 'deny')
  })

  it('libera a delegate_to_agent de quem pode delegar (ela vem de agent:<id>, não de um nome)', async () => {
    const seen: TQueryParams[] = []
    const catalog = new ToolCatalog(fakeMcpRegistry(), [localTool('run_bash')], () => localTool('delegate_to_agent'))
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), catalog })
    const agent = { ...getAgent(), allowedTools: ['agent:tradutor'] }
    const session = await adapter.createSession(agent, { agentId: 'sysops-agent' })
    await drain(adapter.sendMessage(agent, session.id, { text: 'hi' }, {}))

    const gate = seen[0].options?.canUseTool
    const options = { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1' }
    assert.strictEqual((await gate!('mcp__gateway__delegate_to_agent', {}, options))?.behavior, 'allow')
    assert.strictEqual((await gate!('mcp__gateway__run_bash', {}, options))?.behavior, 'deny')
  })

  it('reports an error result from the SDK', async () => {
    const adapter = new ClaudeAgentAdapter({
      query: queryWith(() => [{ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many turns'], usage: {} }]),
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))
    const error = events.find((e) => e.type === 'error')

    assert.ok(error && error.type === 'error')
    assert.strictEqual(error.payload.message, 'too many turns')
  })

  it('reports an aborted turn instead of an error', async () => {
    const adapter = new ClaudeAgentAdapter({
      query: ((params: TQueryParams) =>
        (async function* () {
          yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } }
          if (params.options?.abortController?.signal.aborted) throw new Error('aborted')
          yield { type: 'result', subtype: 'success', is_error: false, result: '', usage: {} }
        })()) as unknown as TQuery,
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })
    const events: IAgentEvent[] = []

    for await (const event of adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {})) {
      events.push(event)
      if (event.type === 'text.delta') await adapter.cancel(session.id)
    }

    assert.strictEqual(events[events.length - 1].type, 'message.aborted')
  })

  it('counts the cache in the input and reports its parcels', async () => {
    const adapter = new ClaudeAgentAdapter({
      query: queryWith(() => [
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          usage: { input_tokens: 10, cache_read_input_tokens: 800, cache_creation_input_tokens: 190, output_tokens: 7 },
        },
      ]),
    })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.deepStrictEqual(events.find((e) => e.type === 'usage')?.payload, { inputTokens: 1000, cacheReadTokens: 800, cacheWriteTokens: 190, outputTokens: 7 })
  })

  it('emits the tool name without the SDK mcp prefix, and keeps it on the result', async () => {
    const adapter = new ClaudeAgentAdapter({
      query: queryWith(() => [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__mcp__crm__stats', input: {} }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      ]),
    })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.ok(events.find((e) => e.type === 'tool.started' && e.payload.tool === 'crm__stats'))
    assert.ok(events.find((e) => e.type === 'tool.result' && e.payload.tool === 'crm__stats'))
  })

  it('sends an attachment with no text without an empty text block', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen) })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })

    await drain(adapter.sendMessage(getAgent(), session.id, { text: '', files: [{ name: 'a.png', mimeType: 'image/png', data: 'aaa' }] }, {}))

    const prompts: Array<{ message: { content: Array<{ type: string }> } }> = []
    for await (const message of seen[0].prompt as AsyncIterable<{ message: { content: Array<{ type: string }> } }>) prompts.push(message)

    assert.deepStrictEqual(
      prompts[0].message.content.map((block) => block.type),
      ['image'],
    )
  })
})
