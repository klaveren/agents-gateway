import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { Event } from '@google/adk'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import type { McpServerClient } from '@infra/mcp/McpServer.Client'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { ILocalTool } from '@infra/tools/Tool.Types'
import { GoogleAgentAdapter, type IAdkRunParams, type IAdkRuntime, type IAdkRuntimeSpec } from './GoogleAgent.Adapter'

interface IRuntimeLog {
  specs: IAdkRuntimeSpec[]
  runs: IAdkRunParams[]
  ensured: string[]
}

/** Eventos no formato que o `toStructuredEvents` do ADK realmente sabe interpretar. */
function adkEvent(parts: unknown[], partial = false): Event {
  return { actions: {}, content: { parts }, partial } as unknown as Event
}

describe('GoogleAgentAdapter', () => {
  const getAgent = (): IAgent => ({
    id: 'researcher-agent',
    name: 'Researcher',
    provider: EProvider.GOOGLE,
    systemPrompt: 'You are the Researcher Agent.',
    models: ['gemini-3.7-flash'],
    modes: [EMode.CHAT, EMode.AGENT],
    allowedTools: ['search_web'],
  })

  const turn = (): Event[] => [
    adkEvent([{ text: 'thinking about it', thought: true }]),
    adkEvent([{ text: 'Searching' }]),
    adkEvent([{ functionCall: { name: 'search_web', args: { query: 'selic' } } }]),
    adkEvent([{ functionResponse: { name: 'search_web', response: { result: '15%' } } }]),
  ]

  const runtimeWith =
    (events: () => Event[], log: IRuntimeLog) =>
    (spec: IAdkRuntimeSpec): IAdkRuntime => {
      log.specs.push(spec)
      return {
        async ensureSession(_userId, sessionId) {
          log.ensured.push(sessionId)
        },
        async *runAsync(params) {
          log.runs.push(params)
          for (const event of events()) yield event
        },
      }
    }

  const emptyLog = (): IRuntimeLog => ({ specs: [], runs: [], ensured: [] })

  const drain = async (stream: AsyncIterable<IAgentEvent>): Promise<IAgentEvent[]> => {
    const collected: IAgentEvent[] = []
    for await (const event of stream) collected.push(event)
    return collected
  }

  const catalog = new ToolCatalog(
    {
      serverUrl: 'http://localhost:8000/mcp',
      isConnected: () => false,
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
    const adapter = new GoogleAgentAdapter({ createRuntime: runtimeWith(() => [], emptyLog()) })
    const session = await adapter.createSession(getAgent(), { agentId: 'researcher-agent' })

    assert.ok(session.id.startsWith('google-agent-'))
    assert.strictEqual(session.mode, EMode.AGENT)
  })

  it('maps ADK structured events onto gateway events', async () => {
    const log = emptyLog()
    const adapter = new GoogleAgentAdapter({ createRuntime: runtimeWith(turn, log) })
    const session = await adapter.createSession(getAgent(), { agentId: 'researcher-agent' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'qual a selic?' }))

    assert.ok(events.find((e) => e.type === 'reasoning.delta' && e.payload.text === 'thinking about it'))
    assert.ok(events.find((e) => e.type === 'text.delta' && e.payload.text === 'Searching'))
    assert.ok(events.find((e) => e.type === 'tool.started' && e.payload.tool === 'search_web' && e.payload.args.query === 'selic'))
    assert.ok(events.find((e) => e.type === 'tool.result' && e.payload.tool === 'search_web'))
    assert.strictEqual(events[events.length - 1].type, 'message.completed')
  })

  it('builds the ADK agent with instruction and model, and creates the session first', async () => {
    const log = emptyLog()
    const adapter = new GoogleAgentAdapter({ createRuntime: runtimeWith(turn, log) })
    const session = await adapter.createSession(getAgent(), { agentId: 'researcher-agent', model: 'gemini-3.6-flash' })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }))

    assert.strictEqual(log.specs[0].instruction, 'You are the Researcher Agent.')
    assert.strictEqual(log.specs[0].model, 'gemini-3.6-flash')
    // `runAsync` lança "Session not found" se a sessão não existir antes.
    assert.strictEqual(log.ensured.length, 1)
    assert.strictEqual(log.ensured[0], log.runs[0].sessionId)
    assert.ok(log.runs[0].abortSignal instanceof AbortSignal)
  })

  it('reuses one runtime per session so history survives the turn', async () => {
    const log = emptyLog()
    const adapter = new GoogleAgentAdapter({ createRuntime: runtimeWith(turn, log) })
    const session = await adapter.createSession(getAgent(), { agentId: 'researcher-agent' })

    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'first' }))
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'second' }))

    assert.strictEqual(log.specs.length, 1)
    assert.strictEqual(log.runs[0].sessionId, log.runs[1].sessionId)
  })

  it('sends attachments as inlineData parts', async () => {
    const log = emptyLog()
    const adapter = new GoogleAgentAdapter({ createRuntime: runtimeWith(turn, log) })
    const session = await adapter.createSession(getAgent(), { agentId: 'researcher-agent' })

    await drain(
      adapter.sendMessage(getAgent(), session.id, {
        text: 'look',
        files: [{ name: 'a.png', mimeType: 'image/png', data: 'aaa' }],
      }),
    )

    assert.deepStrictEqual(log.runs[0].newMessage.parts, [{ text: 'look' }, { inlineData: { data: 'aaa', mimeType: 'image/png' } }])
  })

  it('hands the local toolset to the ADK agent', async () => {
    const log = emptyLog()
    const adapter = new GoogleAgentAdapter({ createRuntime: runtimeWith(turn, log), catalog })
    const session = await adapter.createSession(getAgent(), { agentId: 'researcher-agent' })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }))

    assert.strictEqual(log.specs[0].tools.length, 1)
    const [tool] = log.specs[0].tools
    assert.ok('name' in tool && tool.name === 'search_web')
  })

  it('does not repeat the answer when the ADK follows partials with an aggregate', async () => {
    const log = emptyLog()
    const adapter = new GoogleAgentAdapter({
      createRuntime: runtimeWith(
        () => [
          adkEvent([{ text: 'Hello' }], true),
          adkEvent([{ text: ' world' }], true),
          // O agregado final repete tudo que já saiu nos parciais.
          adkEvent([{ text: 'Hello world' }]),
        ],
        log,
      ),
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'researcher-agent' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }))

    const text = events
      .filter((e) => e.type === 'text.delta')
      .map((e) => e.payload.text)
      .join('')

    assert.strictEqual(text, 'Hello world')
  })

  it('still emits the text when the ADK sends only an aggregate', async () => {
    const log = emptyLog()
    const adapter = new GoogleAgentAdapter({
      createRuntime: runtimeWith(() => [adkEvent([{ text: 'Only once' }])], log),
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'researcher-agent' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }))

    assert.ok(events.find((e) => e.type === 'text.delta' && e.payload.text === 'Only once'))
  })

  it('warns that the ADK has no reasoning-effort knob', async () => {
    const adapter = new GoogleAgentAdapter({ createRuntime: runtimeWith(() => [], emptyLog()) })
    const session = await adapter.createSession(getAgent(), { agentId: 'researcher-agent', reasoning: 'high' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }))

    assert.ok(events.find((e) => e.type === 'warning' && e.payload.message.includes('reasoning-effort')))
  })

  it('surfaces runtime failures as a normalized error event', async () => {
    const adapter = new GoogleAgentAdapter({
      createRuntime: () => ({
        async ensureSession() {},
        // eslint-disable-next-line require-yield
        async *runAsync() {
          throw new Error('API down')
        },
      }),
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'researcher-agent' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }))
    const error = events.find((e) => e.type === 'error')

    assert.ok(error && error.type === 'error')
    assert.strictEqual(error.payload.message, 'API down')
  })

  it('reports an aborted turn instead of an error', async () => {
    const adapter = new GoogleAgentAdapter({
      createRuntime: () => ({
        async ensureSession() {},
        async *runAsync(params) {
          yield adkEvent([{ text: 'partial' }])
          if (params.abortSignal.aborted) throw new Error('aborted')
        },
      }),
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'researcher-agent' })
    const events: IAgentEvent[] = []

    for await (const event of adapter.sendMessage(getAgent(), session.id, { text: 'hi' })) {
      events.push(event)
      if (event.type === 'text.delta') await adapter.cancel(session.id)
    }

    assert.strictEqual(events[events.length - 1].type, 'message.aborted')
  })
})
