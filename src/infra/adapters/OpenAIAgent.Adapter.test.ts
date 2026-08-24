import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { Agent, AgentInputItem, MCPServer, run } from '@openai/agents'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import type { McpServerClient } from '@infra/mcp/McpServer.Client'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { ILocalTool } from '@infra/tools/Tool.Types'
import { OpenAIAgentAdapter } from './OpenAIAgent.Adapter'

type TRun = typeof run

interface ICall {
  agent: Agent
  input: AgentInputItem[]
  maxTurns?: number | null
  signal?: AbortSignal
}

describe('OpenAIAgentAdapter', () => {
  const getAgent = (): IAgent => ({
    id: 'analyst-agent',
    name: 'Data Analyst',
    provider: EProvider.OPENAI,
    systemPrompt: 'You are a Data Analyst Agent.',
    models: ['gpt-5.6-sol'],
    modes: [EMode.CHAT, EMode.AGENT],
    allowedTools: ['search_web'],
  })

  const turn = () => [
    { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'Searching' } },
    {
      type: 'run_item_stream_event',
      name: 'tool_called',
      item: { type: 'tool_call_item', rawItem: { name: 'search_web', arguments: '{"query":"selic"}' } },
    },
    {
      type: 'run_item_stream_event',
      name: 'tool_output',
      item: { type: 'tool_call_output_item', rawItem: { name: 'search_web' }, output: '15%' },
    },
    {
      type: 'raw_model_stream_event',
      data: { type: 'response_done', response: { usage: { inputTokens: 8, outputTokens: 16 } } },
    },
  ]

  const runWith = (events: () => unknown[], calls: ICall[] = [], history: AgentInputItem[] = []): TRun =>
    (async (agent: Agent, input: AgentInputItem[], options: { maxTurns?: number; signal?: AbortSignal }) => {
      calls.push({ agent, input, maxTurns: options?.maxTurns, signal: options?.signal })
      return {
        async *[Symbol.asyncIterator]() {
          for (const event of events()) yield event
        },
        completed: Promise.resolve(),
        history: [...input, ...history],
      }
    }) as unknown as TRun

  const drain = async (stream: AsyncIterable<IAgentEvent>): Promise<IAgentEvent[]> => {
    const collected: IAgentEvent[] = []
    for await (const event of stream) collected.push(event)
    return collected
  }

  const catalog = new ToolCatalog(
    {
      serverUrl: 'http://localhost:8000/mcp',
      isConnected: () => false,
      ensureConnected: async () => false,
      connectionGeneration: 0,
      listTools: async () => [],
      callTool: async () => ({ status: 'success' as const, result: '' }),
    } as unknown as McpServerClient,
    [
      {
        origin: 'local',
        name: 'search_web',
        description: 'local search',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'q' } },
          required: ['query'],
          additionalProperties: false,
        },
        async execute() {
          return { status: 'success', result: 'ok' }
        },
      } satisfies ILocalTool,
    ],
  )

  it('creates a session on the agent lane', async () => {
    const adapter = new OpenAIAgentAdapter({ run: runWith(() => []) })
    const session = await adapter.createSession(getAgent(), { agentId: 'analyst-agent' })

    assert.ok(session.id.startsWith('openai-agent-'))
    assert.strictEqual(session.mode, EMode.AGENT)
  })

  it('translates the run stream into gateway events', async () => {
    const adapter = new OpenAIAgentAdapter({ run: runWith(turn) })
    const session = await adapter.createSession(getAgent(), { agentId: 'analyst-agent' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'qual a selic?' }))

    assert.ok(events.find((e) => e.type === 'text.delta' && e.payload.text === 'Searching'))
    assert.ok(events.find((e) => e.type === 'tool.started' && e.payload.tool === 'search_web' && e.payload.args.query === 'selic'))
    assert.ok(events.find((e) => e.type === 'tool.result' && e.payload.result === '15%'))
    assert.ok(events.find((e) => e.type === 'usage' && e.payload.inputTokens === 8))
    assert.strictEqual(events[events.length - 1].type, 'message.completed')
  })

  it('hands the loop to the SDK with a turn cap and an abort signal', async () => {
    const calls: ICall[] = []
    const adapter = new OpenAIAgentAdapter({ run: runWith(turn, calls) })
    const session = await adapter.createSession(getAgent(), { agentId: 'analyst-agent', reasoning: 'medium' })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }))

    assert.ok((calls[0].maxTurns ?? 0) > 0)
    assert.ok(calls[0].signal instanceof AbortSignal)
    assert.strictEqual(calls[0].agent.modelSettings.reasoning?.effort, 'medium')
    assert.strictEqual(calls[0].agent.instructions, 'You are a Data Analyst Agent.')
  })

  it('carries the history from one turn into the next', async () => {
    const calls: ICall[] = []
    const adapter = new OpenAIAgentAdapter({ run: runWith(turn, calls) })
    const session = await adapter.createSession(getAgent(), { agentId: 'analyst-agent' })

    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'first' }))
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'second' }))

    assert.strictEqual(calls[0].input.length, 1)
    assert.strictEqual(calls[1].input.length, 2)
  })

  it('sends attachments as input_image and input_file parts', async () => {
    const calls: ICall[] = []
    const adapter = new OpenAIAgentAdapter({ run: runWith(turn, calls) })
    const session = await adapter.createSession(getAgent(), { agentId: 'analyst-agent' })

    await drain(
      adapter.sendMessage(getAgent(), session.id, {
        text: 'look',
        files: [
          { name: 'a.png', mimeType: 'image/png', data: 'aaa' },
          { name: 'b.pdf', mimeType: 'application/pdf', data: 'bbb' },
        ],
      }),
    )

    const message = calls[0].input[0]
    assert.ok('content' in message && Array.isArray(message.content))
    assert.deepStrictEqual(
      message.content.map((part) => part.type),
      ['input_text', 'input_image', 'input_file'],
    )
  })

  it('registers the local toolset on the SDK agent', async () => {
    const calls: ICall[] = []
    const adapter = new OpenAIAgentAdapter({ run: runWith(turn, calls), catalog })
    const session = await adapter.createSession(getAgent(), { agentId: 'analyst-agent' })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }))

    assert.deepStrictEqual(
      calls[0].agent.tools.map((tool) => tool.name),
      ['search_web'],
    )
    // MCP fora do ar: o agente segue de pé só com as tools locais.
    assert.deepStrictEqual(calls[0].agent.mcpServers, [])
  })

  it('rebuilds the MCP servers when the connection generation changes', async () => {
    let generation = 0
    let connected = false
    const closed: string[] = []

    const catalogWithClock = new ToolCatalog(
      {
        serverUrl: 'http://localhost:8000/mcp',
        isConnected: () => connected,
        ensureConnected: async () => connected,
        get connectionGeneration() {
          return generation
        },
        listTools: async () => [],
        callTool: async () => ({ status: 'success' as const, result: '' }),
      } as unknown as McpServerClient,
      [],
    )

    const fakeServer = (name: string) =>
      ({
        name,
        async connect() {},
        async close() {
          closed.push(name)
        },
      }) as unknown as MCPServer

    const calls: ICall[] = []
    const adapter = new OpenAIAgentAdapter({
      run: runWith(turn, calls),
      catalog: catalogWithClock,
      buildMcpServers: () => [fakeServer('gen-' + generation)],
    })
    const session = await adapter.createSession(getAgent(), { agentId: 'analyst-agent' })

    // Turno 1: MCP fora do ar, o agente roda só com o que é local.
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'um' }))
    assert.deepStrictEqual(calls[0].agent.mcpServers, [])

    // O server sobe: a geração muda e o turno seguinte passa a enxergá-lo, sem reiniciar.
    connected = true
    generation = 1
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'dois' }))
    assert.strictEqual(calls[1].agent.mcpServers.length, 1)

    // Reconectar de novo troca a geração: os servers antigos são fechados, não vazados.
    generation = 2
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'tres' }))
    assert.deepStrictEqual(closed, ['gen-1'])
    assert.strictEqual(calls[2].agent.mcpServers.length, 1)
  })

  it('surfaces run failures as a normalized error event', async () => {
    const adapter = new OpenAIAgentAdapter({
      run: (async () => {
        throw new Error('API down')
      }) as unknown as TRun,
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'analyst-agent' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }))
    const error = events.find((e) => e.type === 'error')

    assert.ok(error && error.type === 'error')
    assert.strictEqual(error.payload.message, 'API down')
  })

  it('reports an aborted turn instead of an error', async () => {
    const adapter = new OpenAIAgentAdapter({
      run: (async (_agent: Agent, _input: AgentInputItem[], options: { signal?: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'partial' } }
          if (options?.signal?.aborted) throw new Error('aborted')
        },
        completed: Promise.resolve(),
        history: [],
      })) as unknown as TRun,
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'analyst-agent' })
    const events: IAgentEvent[] = []

    for await (const event of adapter.sendMessage(getAgent(), session.id, { text: 'hi' })) {
      events.push(event)
      if (event.type === 'text.delta') await adapter.cancel(session.id)
    }

    assert.strictEqual(events[events.length - 1].type, 'message.aborted')
  })
})
