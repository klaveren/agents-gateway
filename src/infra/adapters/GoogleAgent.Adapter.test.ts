import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { Event, FunctionTool } from '@google/adk'
import { EMode } from '@domain/enums/EMode.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { fakeMcpRegistry, mcpTool } from '@infra/mcp/Mcp.Fake'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { GOOGLE_TEST_AGENT } from '../../testing/Agents.Fixture'
import { ILocalTool } from '@infra/tools/Tool.Types'
import { GoogleAgentAdapter, assertNoAdkTemplateCollision, type IAdkRunParams, type IAdkRuntime, type IAdkRuntimeSpec } from './GoogleAgent.Adapter'

interface IRuntimeLog {
  specs: IAdkRuntimeSpec[]
  runs: IAdkRunParams[]
  ensured: string[]
}

/** Eventos no formato que o `toStructuredEvents` do ADK realmente sabe interpretar. */
function adkEvent(parts: unknown[], partial = false): Event {
  return { actions: {}, content: { parts }, partial } as unknown as Event
}

/**
 * O `Event` do ADK estende `LlmResponse`, e é ali que mora o `usageMetadata`. Um turno agêntico
 * passa pelo modelo uma vez por rodada de ferramenta, e cada passagem traz o seu.
 */
function adkEventWithUsage(parts: unknown[], usage: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }, partial = false): Event {
  return { actions: {}, content: { parts }, partial, usageMetadata: usage } as unknown as Event
}

describe('GoogleAgentAdapter', () => {
  const getAgent = (): IAgent => ({ ...GOOGLE_TEST_AGENT, models: ['gemini-3.7-flash'] })

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
    const adapter = new GoogleAgentAdapter({ createRuntime: runtimeWith(() => [], emptyLog()) })
    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })

    assert.ok(session.id.startsWith('google-agent-'))
    assert.strictEqual(session.mode, EMode.AGENT)
  })

  it('maps ADK structured events onto gateway events', async () => {
    const log = emptyLog()
    const adapter = new GoogleAgentAdapter({ createRuntime: runtimeWith(turn, log) })
    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'qual a selic?' }, {}))

    assert.ok(events.find((e) => e.type === 'reasoning.delta' && e.payload.text === 'thinking about it'))
    assert.ok(events.find((e) => e.type === 'text.delta' && e.payload.text === 'Searching'))
    assert.ok(events.find((e) => e.type === 'tool.started' && e.payload.tool === 'search_web' && e.payload.args.query === 'selic'))
    assert.ok(events.find((e) => e.type === 'tool.result' && e.payload.tool === 'search_web'))
    assert.strictEqual(events[events.length - 1].type, 'message.completed')
  })

  it('builds the ADK agent with instruction and model, and creates the session first', async () => {
    const log = emptyLog()
    const adapter = new GoogleAgentAdapter({ createRuntime: runtimeWith(turn, log) })
    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id, model: 'gemini-3.6-flash' })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.strictEqual(log.specs[0].instruction, GOOGLE_TEST_AGENT.systemPrompt)
    assert.strictEqual(log.specs[0].model, 'gemini-3.6-flash')
    // `runAsync` lança "Session not found" se a sessão não existir antes.
    assert.strictEqual(log.ensured.length, 1)
    assert.strictEqual(log.ensured[0], log.runs[0].sessionId)
    assert.ok(log.runs[0].abortSignal instanceof AbortSignal)
  })

  it('reuses one runtime per session so history survives the turn', async () => {
    const log = emptyLog()
    const adapter = new GoogleAgentAdapter({ createRuntime: runtimeWith(turn, log) })
    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })

    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'first' }, {}))
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'second' }, {}))

    assert.strictEqual(log.specs.length, 1)
    assert.strictEqual(log.runs[0].sessionId, log.runs[1].sessionId)
  })

  it('sends attachments as inlineData parts', async () => {
    const log = emptyLog()
    const adapter = new GoogleAgentAdapter({ createRuntime: runtimeWith(turn, log) })
    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })

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

    assert.deepStrictEqual(log.runs[0].newMessage.parts, [{ text: 'look' }, { inlineData: { data: 'aaa', mimeType: 'image/png' } }])
  })

  it('passa ao runtime as nativas do Gemini ligadas no agente, e só elas', async () => {
    const log = emptyLog()
    const adapter = new GoogleAgentAdapter({ createRuntime: runtimeWith(turn, log), catalog })
    const agent = { ...getAgent(), allowedTools: ['search_web', 'sdk:google:google_search', 'sdk:google:code_execution', 'sdk:WebSearch'] }
    const session = await adapter.createSession(agent, { agentId: GOOGLE_TEST_AGENT.id })
    await drain(adapter.sendMessage(agent, session.id, { text: 'hi' }, {}))

    assert.deepStrictEqual(log.specs[0].natives, ['google_search', 'code_execution'])
  })

  it('hands the local toolset to the ADK agent', async () => {
    const log = emptyLog()
    const adapter = new GoogleAgentAdapter({ createRuntime: runtimeWith(turn, log), catalog })
    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.strictEqual(log.specs[0].tools.length, 1)
    const [tool] = log.specs[0].tools
    assert.ok('name' in tool && tool.name === 'search_web')
  })

  it('sends each MCP call with the credential of the turn in progress, not of the first turn', async () => {
    const seen: Array<string | undefined> = []
    const remoteCatalog = new ToolCatalog(
      fakeMcpRegistry([
        {
          id: 'crm',
          tools: [mcpTool('run_bash', 'bash')],
          onCall: (_name, _args, context) => {
            seen.push(context?.token)
            return { status: 'success' as const, result: '' }
          },
        },
      ]),
      [],
    )
    const log = emptyLog()
    const adapter = new GoogleAgentAdapter({ createRuntime: runtimeWith(() => [], log), catalog: remoteCatalog })
    const agent = { ...getAgent(), allowedTools: ['mcp:crm/run_bash'] }
    const session = await adapter.createSession(agent, { agentId: GOOGLE_TEST_AGENT.id })
    const callBash = async () => {
      const tool = log.specs[0].tools.find((candidate) => 'name' in candidate && candidate.name === 'run_bash') as FunctionTool
      await tool.runAsync({ args: {}, toolContext: undefined as never })
    }

    await drain(adapter.sendMessage(agent, session.id, { text: 'first' }, { token: 'token-1' }))
    await callBash()
    await drain(adapter.sendMessage(agent, session.id, { text: 'second' }, { token: 'token-2' }))
    await callBash()

    assert.deepStrictEqual(seen, ['token-1', 'token-2'])
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

    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

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

    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.ok(events.find((e) => e.type === 'text.delta' && e.payload.text === 'Only once'))
  })

  it('warns that the ADK has no reasoning-effort knob', async () => {
    const adapter = new GoogleAgentAdapter({ createRuntime: runtimeWith(() => [], emptyLog()) })
    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id, reasoning: 'high' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

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

    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))
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

    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })
    const events: IAgentEvent[] = []

    for await (const event of adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {})) {
      events.push(event)
      if (event.type === 'text.delta') await adapter.cancel(session.id)
    }

    assert.strictEqual(events[events.length - 1].type, 'message.aborted')
  })

  it('counts each model call once, from its final response, with the cache', async () => {
    // Uma chamada que pede duas ferramentas chega em dois pedaços com o MESMO consumo acumulado, e o
    // pedaço final — o único com o cache — não vira evento. O consumo sai do `afterModelCallback`,
    // uma vez por chamada.
    const adapter = new GoogleAgentAdapter({
      createRuntime: (spec) => ({
        async ensureSession() {},
        async *runAsync() {
          const callUsage = { promptTokenCount: 22096, candidatesTokenCount: 26, thoughtsTokenCount: 131 }
          spec.onModelResponse?.({ partial: false, usageMetadata: callUsage })
          yield adkEvent([{ functionCall: { name: 'search_web', args: {} } }])
          spec.onModelResponse?.({ partial: false, usageMetadata: callUsage })
          yield adkEvent([{ functionCall: { name: 'search_web', args: {} } }])
          spec.onModelResponse?.({ partial: false, finishReason: 'STOP', usageMetadata: { ...callUsage, cachedContentTokenCount: 20000 } })
          yield adkEvent([{ functionResponse: { name: 'search_web', response: { result: 256 } } }])
          spec.onModelResponse?.({ partial: true, finishReason: 'STOP', usageMetadata: { promptTokenCount: 22603 } })
          spec.onModelResponse?.({
            partial: false,
            finishReason: 'STOP',
            usageMetadata: { promptTokenCount: 22603, cachedContentTokenCount: 20282, candidatesTokenCount: 134, thoughtsTokenCount: 81 },
          })
          yield adkEvent([{ text: 'done' }])
        },
      }),
    })
    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))
    const usage = events.filter((e) => e.type === 'usage').map((e) => e.type === 'usage' && e.payload)

    assert.deepStrictEqual(usage, [
      { inputTokens: 22096, outputTokens: 26, reasoningTokens: 131, cacheReadTokens: 20000, cacheWriteTokens: 0 },
      { inputTokens: 22603, outputTokens: 134, reasoningTokens: 81, cacheReadTokens: 20282, cacheWriteTokens: 0 },
    ])
  })

  it('reports the usage of a call that ends with no further event, at the end of the turn', async () => {
    const adapter = new GoogleAgentAdapter({
      createRuntime: (spec) => ({
        async ensureSession() {},
        async *runAsync() {
          yield adkEvent([{ text: 'done' }])
          spec.onModelResponse?.({ partial: false, finishReason: 'STOP', usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 4 } })
        },
      }),
    })
    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))
    const usage = events.filter((e) => e.type === 'usage').map((e) => e.type === 'usage' && e.payload)

    assert.deepStrictEqual(usage, [{ inputTokens: 50, outputTokens: 4, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }])
    assert.strictEqual(events[events.length - 1].type, 'message.completed')
  })

  it('does not read usage from the events themselves', async () => {
    const adapter = new GoogleAgentAdapter({
      createRuntime: runtimeWith(() => [adkEventWithUsage([{ text: 'done' }], { promptTokenCount: 120, candidatesTokenCount: 30 })], emptyLog()),
    })
    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.strictEqual(events.filter((e) => e.type === 'usage').length, 0)
  })

  it('drops usage left over from an interrupted turn at the start of the next', async () => {
    let call = 0
    const adapter = new GoogleAgentAdapter({
      createRuntime: (spec) => ({
        async ensureSession() {},
        async *runAsync() {
          call++
          // O consumo chega pelo callback, antes de o evento correspondente sair do stream.
          spec.onModelResponse?.({ partial: false, finishReason: 'STOP', usageMetadata: { promptTokenCount: call === 1 ? 999 : 10 } })
          if (call === 1) throw new Error('boom')
          yield adkEvent([{ text: 'ok' }])
        },
      }),
    })
    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })

    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'one' }, {}))
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'two' }, {}))
    const usage = events.filter((e) => e.type === 'usage').map((e) => e.type === 'usage' && e.payload)

    assert.deepStrictEqual(
      usage.map((payload) => payload && payload.inputTokens),
      [10],
    )
  })

  it('sends an attachment with no text without an empty text part, which the ADK would drop whole', async () => {
    const log = emptyLog()
    const adapter = new GoogleAgentAdapter({ createRuntime: runtimeWith(turn, log) })
    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })

    await drain(adapter.sendMessage(getAgent(), session.id, { text: '  ', files: [{ name: 'doc.pdf', mimeType: 'application/pdf', data: 'aaa' }] }, {}))

    assert.deepStrictEqual(log.runs[0].newMessage.parts, [{ inlineData: { data: 'aaa', mimeType: 'application/pdf' } }])
  })
})

describe('assertNoAdkTemplateCollision', () => {
  it('lets a prompt with no braces through untouched', () => {
    assert.strictEqual(assertNoAdkTemplateCollision('Use <id> when referring to the record.'), 'Use <id> when referring to the record.')
  })

  it('rejects a single brace, which the ADK reads as session state', () => {
    assert.throws(() => assertNoAdkTemplateCollision('Pass {id} to the tool.'), /\{id}/)
  })

  it('rejects a double brace too — the ADK has no escape, so `{{id}}` is not literal', () => {
    // Foi exatamente isto que fez a primeira "correção" não ter efeito nenhum.
    assert.throws(() => assertNoAdkTemplateCollision('Pass {{id}} to the tool.'), /\{\{id}}/)
  })

  it('names the patterns it found, so the fix does not need a hunt', () => {
    assert.throws(() => assertNoAdkTemplateCollision('{alias} and {sellerId}'), /\{alias}, \{sellerId}/)
  })
})
