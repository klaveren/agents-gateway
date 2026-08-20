import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { query } from '@anthropic-ai/claude-agent-sdk'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import type { McpServerClient } from '@infra/mcp/McpServer.Client'
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
    allowedTools: ['run_bash'],
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

  const catalogWith = (connected: boolean) =>
    new ToolCatalog(
      {
        serverUrl: 'http://localhost:8000/mcp',
        isConnected: () => connected,
        ensureConnected: async () => connected,
        connectionGeneration: connected ? 1 : 0,
        listTools: async () => [],
        callTool: async () => ({ status: 'success' as const, result: '' }),
      } as unknown as McpServerClient,
      [localTool('run_bash')],
    )

  it('creates a session on the agent lane', async () => {
    const adapter = new ClaudeAgentAdapter({ query: queryWith(() => []) })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })

    assert.ok(session.id.startsWith('claude-agent-'))
    assert.strictEqual(session.mode, EMode.AGENT)
  })

  it('translates the SDK message stream into gateway events', async () => {
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn) })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'list files' }))

    assert.ok(events.find((e) => e.type === 'text.delta' && e.payload.text === 'Listing'))
    assert.ok(events.find((e) => e.type === 'reasoning.delta' && e.payload.text === 'hmm'))
    assert.ok(events.find((e) => e.type === 'tool.started' && e.payload.tool === 'run_bash' && e.payload.args.command === 'ls'))
    assert.ok(events.find((e) => e.type === 'tool.result'))
    assert.ok(events.find((e) => e.type === 'usage' && e.payload.outputTokens === 34))
    assert.strictEqual(events[events.length - 1].type, 'message.completed')
  })

  it('never runs a hand-rolled tool loop: no tools and no host settings leak in', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen) })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent', reasoning: 'high' })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }))

    assert.deepStrictEqual(seen[0].options?.tools, [])
    assert.deepStrictEqual(seen[0].options?.settingSources, [])
    assert.strictEqual(seen[0].options?.effort, 'high')
    assert.ok(seen[0].options?.abortController instanceof AbortController)
  })

  it('plants a uuid on the first turn and resumes the CLI session afterwards', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen) })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })

    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'first' }))
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'second' }))

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

    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'plain' }))
    await drain(
      adapter.sendMessage(getAgent(), session.id, {
        text: 'look',
        files: [{ name: 'a.png', mimeType: 'image/png', data: 'aaa' }],
      }),
    )

    assert.strictEqual(typeof seen[0].prompt, 'string')
    assert.strictEqual(typeof seen[1].prompt, 'object')
  })

  it('hands tools to the SDK as MCP servers, local and remote', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), catalog: catalogWith(true) })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }))

    const servers = seen[0].options?.mcpServers ?? {}
    assert.deepStrictEqual(Object.keys(servers).sort(), ['gateway', 'mcp'])
    // Built-ins seguem desligados: o agente não ganha Bash/Read sobre a máquina do host.
    assert.deepStrictEqual(seen[0].options?.tools, [])
  })

  it('omits the remote server when no MCP is connected', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), catalog: catalogWith(false) })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }))

    assert.deepStrictEqual(Object.keys(seen[0].options?.mcpServers ?? {}), ['gateway'])
  })

  it('gates tool use through canUseTool instead of allowedTools', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), catalog: catalogWith(true) })
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }))

    const gate = seen[0].options?.canUseTool
    assert.ok(gate)
    // `allowedTools` com nome solto sombrearia o callback, então tem de ficar ausente.
    assert.strictEqual(seen[0].options?.allowedTools, undefined)

    const options = { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1' }
    assert.strictEqual((await gate('mcp__gateway__run_bash', {}, options))?.behavior, 'allow')
    assert.strictEqual((await gate('mcp__mcp__read_file', {}, options))?.behavior, 'allow')
    assert.strictEqual((await gate('Bash', {}, options))?.behavior, 'deny')
    assert.strictEqual((await gate('mcp__gateway__search_web', {}, options))?.behavior, 'deny')
  })

  it('reports an error result from the SDK', async () => {
    const adapter = new ClaudeAgentAdapter({
      query: queryWith(() => [{ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many turns'], usage: {} }]),
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }))
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

    for await (const event of adapter.sendMessage(getAgent(), session.id, { text: 'hi' })) {
      events.push(event)
      if (event.type === 'text.delta') await adapter.cancel(session.id)
    }

    assert.strictEqual(events[events.length - 1].type, 'message.aborted')
  })
})
