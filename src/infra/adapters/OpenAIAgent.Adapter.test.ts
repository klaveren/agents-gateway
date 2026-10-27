import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { Agent, AgentInputItem, MCPServer, run } from '@openai/agents'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { fakeMcpRegistry } from '@infra/mcp/Mcp.Fake'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { OPENAI_TEST_AGENT } from '../../testing/Agents.Fixture'
import { ILocalTool } from '@infra/tools/Tool.Types'
import { hostedName, OpenAIAgentAdapter } from './OpenAIAgent.Adapter'

type TRun = typeof run

interface ICall {
  agent: Agent
  input: AgentInputItem[]
  maxTurns?: number | null
  signal?: AbortSignal
}

describe('OpenAIAgentAdapter', () => {
  const getAgent = (): IAgent => ({ ...OPENAI_TEST_AGENT, providers: [{ provider: EProvider.OPENAI, models: ['gpt-5.6-sol'] }], allowedTools: ['search_web', 'mcp:crm/*'] })

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

  const catalog = new ToolCatalog(fakeMcpRegistry(), [
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
  ])

  it('creates a session on the agent lane', async () => {
    const adapter = new OpenAIAgentAdapter({ run: runWith(() => []) })
    const session = await adapter.createSession(getAgent(), { agentId: OPENAI_TEST_AGENT.id })

    assert.ok(session.id.startsWith('openai-agent-'))
    assert.strictEqual(session.mode, EMode.AGENT)
  })

  it('translates the run stream into gateway events', async () => {
    const adapter = new OpenAIAgentAdapter({ run: runWith(turn) })
    const session = await adapter.createSession(getAgent(), { agentId: OPENAI_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'qual a selic?' }, {}))

    assert.ok(events.find((e) => e.type === 'text.delta' && e.payload.text === 'Searching'))
    assert.ok(events.find((e) => e.type === 'tool.started' && e.payload.tool === 'search_web' && e.payload.args.query === 'selic'))
    assert.ok(events.find((e) => e.type === 'tool.result' && e.payload.result === '15%'))
    assert.ok(events.find((e) => e.type === 'usage' && e.payload.inputTokens === 8))
    assert.strictEqual(events[events.length - 1].type, 'message.completed')
  })

  it('hands the loop to the SDK with a turn cap and an abort signal', async () => {
    const calls: ICall[] = []
    const adapter = new OpenAIAgentAdapter({ run: runWith(turn, calls) })
    const session = await adapter.createSession(getAgent(), { agentId: OPENAI_TEST_AGENT.id, reasoning: 'medium' })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.ok((calls[0].maxTurns ?? 0) > 0)
    assert.ok(calls[0].signal instanceof AbortSignal)
    assert.strictEqual(calls[0].agent.modelSettings.reasoning?.effort, 'medium')
    assert.strictEqual(calls[0].agent.instructions, OPENAI_TEST_AGENT.systemPrompt)
  })

  it('carries the history from one turn into the next', async () => {
    const calls: ICall[] = []
    const adapter = new OpenAIAgentAdapter({ run: runWith(turn, calls) })
    const session = await adapter.createSession(getAgent(), { agentId: OPENAI_TEST_AGENT.id })

    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'first' }, {}))
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'second' }, {}))

    assert.strictEqual(calls[0].input.length, 1)
    assert.strictEqual(calls[1].input.length, 2)
  })

  it('sends attachments as input_image and input_file parts', async () => {
    const calls: ICall[] = []
    const adapter = new OpenAIAgentAdapter({ run: runWith(turn, calls) })
    const session = await adapter.createSession(getAgent(), { agentId: OPENAI_TEST_AGENT.id })

    await drain(
      adapter.sendMessage(
        getAgent(),
        session.id,
        {
          text: 'look',
          files: [
            { name: 'a.png', mimeType: 'image/png', data: 'aaa' },
            { name: 'b.pdf', mimeType: 'application/pdf', data: 'bbb' },
          ],
        },
        {},
      ),
    )

    const message = calls[0].input[0]
    assert.ok('content' in message && Array.isArray(message.content))
    assert.deepStrictEqual(
      message.content.map((part) => part.type),
      ['input_text', 'input_image', 'input_file'],
    )
  })

  it('acrescenta as hospedadas no oficial; num compatível, ignora com aviso', async () => {
    const agent = { ...getAgent(), allowedTools: ['search_web', 'sdk:openai:web_search', 'sdk:openai:code_interpreter'] }

    const official: ICall[] = []
    const adapter = new OpenAIAgentAdapter({ run: runWith(turn, official), catalog })
    const session = await adapter.createSession(agent, { agentId: OPENAI_TEST_AGENT.id })
    await drain(adapter.sendMessage(agent, session.id, { text: 'hi' }, {}))
    assert.deepStrictEqual(
      official[0].agent.tools.map((tool) => tool.name),
      ['search_web', 'web_search', 'code_interpreter'],
    )

    const viaCompatible: ICall[] = []
    const compatible = new OpenAIAgentAdapter({
      run: runWith(turn, viaCompatible),
      catalog,
      connections: { connection: (id) => ({ providerId: id, name: 'Compatível', protocol: EProvider.OPENAI, baseUrl: 'https://api.compativel.example/v1', key: 'k' }) },
    })
    const other = await compatible.createSession({ ...agent, providers: [{ provider: 'compat', models: ['gpt-5.6-sol'] }] }, { agentId: OPENAI_TEST_AGENT.id })
    const events = await drain(compatible.sendMessage(agent, other.id, { text: 'hi' }, {}))
    assert.deepStrictEqual(
      viaCompatible[0].agent.tools.map((tool) => tool.name),
      ['search_web'],
    )
    assert.ok(events.find((event) => event.type === 'warning' && String(event.payload.message).includes('compatível')))
  })

  it('registers the local toolset on the SDK agent', async () => {
    const calls: ICall[] = []
    const adapter = new OpenAIAgentAdapter({ run: runWith(turn, calls), catalog })
    const session = await adapter.createSession(getAgent(), { agentId: OPENAI_TEST_AGENT.id })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.deepStrictEqual(
      calls[0].agent.tools.map((tool) => tool.name),
      ['search_web'],
    )
    // MCP fora do ar: o agente segue de pé só com as tools locais.
    assert.deepStrictEqual(calls[0].agent.mcpServers, [])
  })

  const mcpCatalog = (isUp: () => boolean) => new ToolCatalog(fakeMcpRegistry([{ id: 'crm', connected: isUp }]), [])

  const trackedServer = (token: string | undefined, log: { opened: string[]; closed: string[] }) =>
    ({
      name: `mcp-${token}`,
      async connect() {
        log.opened.push(String(token))
      },
      async close() {
        log.closed.push(String(token))
      },
    }) as unknown as MCPServer

  it('opens the MCP connection per turn and closes it when the turn ends', async () => {
    let up = false
    const log = { opened: [] as string[], closed: [] as string[] }
    const calls: ICall[] = []
    const adapter = new OpenAIAgentAdapter({
      run: runWith(turn, calls),
      catalog: mcpCatalog(() => up),
      buildMcpServers: (_remotes, token) => [trackedServer(token, log)],
    })
    const session = await adapter.createSession(getAgent(), { agentId: OPENAI_TEST_AGENT.id })

    // MCP fora do ar: só as tools locais.
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'um' }, {}))
    assert.deepStrictEqual(calls[0].agent.mcpServers, [])

    // MCP sobe: o turno seguinte enxerga, sem reiniciar — e devolve a conexão ao terminar.
    up = true
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'dois' }, { token: 'a' }))
    assert.strictEqual(calls[1].agent.mcpServers.length, 1)
    assert.deepStrictEqual(log, { opened: ['a'], closed: ['a'] })
  })

  it('never lets one caller close the MCP connection another caller is using', async () => {
    const log = { opened: [] as string[], closed: [] as string[] }
    let releaseA: () => void = () => {}
    const gateA = new Promise<void>((resolve) => (releaseA = resolve))

    // O turno de A fica preso no meio do stream até B terminar o dele inteiro.
    const run = (async (_agent: Agent, input: AgentInputItem[]) => ({
      async *[Symbol.asyncIterator]() {
        const text = JSON.stringify(input.at(-1))
        if (text.includes('de A')) await gateA
        yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'ok' } }
      },
      completed: Promise.resolve(),
      history: input,
    })) as unknown as TRun

    const adapter = new OpenAIAgentAdapter({
      run,
      catalog: mcpCatalog(() => true),
      buildMcpServers: (_remotes, token) => [trackedServer(token, log)],
    })
    const sessionA = await adapter.createSession(getAgent(), { agentId: OPENAI_TEST_AGENT.id })
    const sessionB = await adapter.createSession(getAgent(), { agentId: OPENAI_TEST_AGENT.id })

    const turnA = drain(adapter.sendMessage(getAgent(), sessionA.id, { text: 'de A' }, { token: 'a' }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await drain(adapter.sendMessage(getAgent(), sessionB.id, { text: 'de B' }, { token: 'b' }))

    // B entrou e saiu enquanto A ainda rodava: só a conexão de B pode ter sido fechada.
    assert.deepStrictEqual(log.closed, ['b'])

    releaseA()
    await turnA
    assert.deepStrictEqual(log.closed.sort(), ['a', 'b'])
  })

  it('surfaces run failures as a normalized error event', async () => {
    const adapter = new OpenAIAgentAdapter({
      run: (async () => {
        throw new Error('API down')
      }) as unknown as TRun,
    })

    const session = await adapter.createSession(getAgent(), { agentId: OPENAI_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))
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

    const session = await adapter.createSession(getAgent(), { agentId: OPENAI_TEST_AGENT.id })
    const events: IAgentEvent[] = []

    for await (const event of adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {})) {
      events.push(event)
      if (event.type === 'text.delta') await adapter.cancel(session.id)
    }

    assert.strictEqual(events[events.length - 1].type, 'message.aborted')
  })

  it('reports the reasoning apart from the visible output, as every provider does', async () => {
    // ⚠️ Aqui o raciocínio JÁ ESTÁ dentro de `outputTokens` da API. O contrato do gateway é uma saída
    // só com o visível e o raciocínio à parte: 30 de saída crua com 10 de raciocínio vira 20 + 10.
    const adapter = new OpenAIAgentAdapter({
      run: runWith(() => [
        {
          type: 'raw_model_stream_event',
          data: { type: 'response_done', response: { usage: { inputTokens: 8, outputTokens: 30, outputTokensDetails: { reasoningTokens: 10 } } } },
        },
      ]),
    })
    const session = await adapter.createSession(getAgent(), { agentId: OPENAI_TEST_AGENT.id })

    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))
    const usage = events.find((event) => event.type === 'usage')

    assert.deepStrictEqual(usage?.payload, { inputTokens: 8, contextTokens: 8, outputTokens: 20, reasoningTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 })
  })

  it('reads the cache parcels from an object, a list of objects, snake or camel case', async () => {
    const usageOf = async (inputTokensDetails: unknown) => {
      const adapter = new OpenAIAgentAdapter({
        run: runWith(() => [{ type: 'raw_model_stream_event', data: { type: 'response_done', response: { usage: { inputTokens: 100, outputTokens: 5, inputTokensDetails } } } }]),
      })
      const session = await adapter.createSession(getAgent(), { agentId: OPENAI_TEST_AGENT.id })
      const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

      return events.find((event) => event.type === 'usage')?.payload
    }

    const expected = { inputTokens: 100, contextTokens: 100, outputTokens: 5, reasoningTokens: undefined, cacheReadTokens: 60, cacheWriteTokens: 10 }

    assert.deepStrictEqual(await usageOf({ cached_tokens: 60, cache_write_tokens: 10 }), expected)
    assert.deepStrictEqual(await usageOf([{ cached_tokens: 40, cache_write_tokens: 10 }, { cached_tokens: 20 }]), expected)
    assert.deepStrictEqual(await usageOf({ cachedTokens: 60, cacheWriteTokens: 10 }), expected)
    assert.deepStrictEqual(await usageOf(undefined), { ...expected, cacheReadTokens: 0, cacheWriteTokens: 0 })
  })

  it('sends an attachment with no text without an empty input_text part', async () => {
    const calls: ICall[] = []
    const adapter = new OpenAIAgentAdapter({ run: runWith(turn, calls) })
    const session = await adapter.createSession(getAgent(), { agentId: OPENAI_TEST_AGENT.id })

    await drain(adapter.sendMessage(getAgent(), session.id, { text: '  ', files: [{ name: 'b.pdf', mimeType: 'application/pdf', data: 'bbb' }] }, {}))

    const message = calls[0].input[0]
    assert.ok('content' in message && Array.isArray(message.content))
    assert.deepStrictEqual(
      message.content.map((part) => part.type),
      ['input_file'],
    )
  })

  it('o nome das hospedadas no histórico é o do catálogo, não o tipo do item da API', () => {
    assert.strictEqual(hostedName('web_search_call'), 'web_search')
    assert.strictEqual(hostedName('code_interpreter_call'), 'code_interpreter')
    assert.strictEqual(hostedName('search_web'), 'search_web')
    assert.strictEqual(hostedName('algo_call'), 'algo_call')
  })
})
