import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import type { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { IToolDefinition, IToolResult } from '@infra/tools/Tool.Types'
import { IManualLoopProvider, IManualToolCall, IManualTurnOutcome, runManualToolLoop } from './ManualTool.Loop'

/** Um history de mentira: strings, para o teste ler o transcript a olho nu. */
type TMessage = string

const tool = (name: string): IToolDefinition => ({
  origin: 'local',
  name,
  description: name,
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
})

const call = (name: string, args: Record<string, unknown> = {}): IManualToolCall => ({ id: `${name}-1`, name, args })

function fakeProvider(turns: IManualTurnOutcome[], log: { sawTools: IToolDefinition[][] } = { sawTools: [] }) {
  let index = 0

  const provider: IManualLoopProvider<TMessage> = {
    // eslint-disable-next-line require-yield
    async *runTurn(_history, tools): AsyncGenerator<IAgentEvent, IManualTurnOutcome> {
      log.sawTools.push(tools)
      return turns[index++] ?? { text: '', calls: [] }
    },
    appendAssistant(history, outcome) {
      history.push(`assistant:${outcome.text}|${outcome.calls.map((c) => c.name).join(',')}`)
    },
    appendToolResults(history, results) {
      history.push(`tools:${results.map((r) => `${r.call.name}=${r.outcome.result}`).join(',')}`)
    },
  }

  return { provider, log }
}

const fakeCatalog = (invoke: (name: string) => IToolResult): ToolCatalog => ({ invoke: async (name: string) => invoke(name) }) as unknown as ToolCatalog

const drain = async (stream: AsyncGenerator<IAgentEvent, string>) => {
  const events: IAgentEvent[] = []
  let next = await stream.next()
  while (!next.done) {
    events.push(next.value)
    next = await stream.next()
  }
  return { events, answer: next.value }
}

describe('runManualToolLoop', () => {
  const base = {
    sessionId: 's1',
    signal: new AbortController().signal,
    maxTurns: 5,
  }

  it('does exactly one turn when there are no tools', async () => {
    const history: TMessage[] = []
    const { provider, log } = fakeProvider([{ text: 'olá', calls: [] }])

    const { events, answer } = await drain(runManualToolLoop<TMessage>({ ...base, history, tools: [], catalog: undefined, provider }))

    assert.strictEqual(answer, 'olá')
    assert.deepStrictEqual(history, ['assistant:olá|'])
    assert.deepStrictEqual(log.sawTools, [[]])
    assert.deepStrictEqual(events, [])
  })

  it('runs the tool and feeds the result back for a second turn', async () => {
    const history: TMessage[] = []
    const { provider } = fakeProvider([
      { text: 'vou olhar. ', calls: [call('run_bash', { command: 'ls' })] },
      { text: 'achei', calls: [] },
    ])

    const { events, answer } = await drain(
      runManualToolLoop<TMessage>({
        ...base,
        history,
        tools: [tool('run_bash')],
        catalog: fakeCatalog(() => ({ status: 'success', result: 'a.txt' })),
        provider,
      }),
    )

    assert.strictEqual(answer, 'vou olhar. achei')
    assert.deepStrictEqual(history, ['assistant:vou olhar. |run_bash', 'tools:run_bash=a.txt', 'assistant:achei|'])
    assert.deepStrictEqual(
      events.map((e) => e.type),
      ['tool.started', 'tool.result'],
    )
    const started = events[0]
    assert.ok(started.type === 'tool.started' && started.payload.args.command === 'ls')
  })

  it('reports a failed tool without killing the turn, and still tells the model', async () => {
    const history: TMessage[] = []
    const { provider } = fakeProvider([
      { text: '', calls: [call('run_bash')] },
      { text: 'entendi, não deu', calls: [] },
    ])

    const { events, answer } = await drain(
      runManualToolLoop<TMessage>({
        ...base,
        history,
        tools: [tool('run_bash')],
        catalog: fakeCatalog(() => ({ status: 'error', result: 'Refused by the gateway tool policy' })),
        provider,
      }),
    )

    assert.strictEqual(answer, 'entendi, não deu')
    const failure = events.find((e) => e.type === 'tool.error')
    assert.ok(failure && failure.type === 'tool.error')
    assert.match(failure.payload.message, /Refused by the gateway tool policy/)
    // O modelo precisa ver a falha para poder corrigir o rumo.
    assert.ok(history.includes('tools:run_bash=Refused by the gateway tool policy'))
  })

  it('stops at the turn cap and says so instead of looping forever', async () => {
    const history: TMessage[] = []
    const forever = Array.from({ length: 10 }, () => ({ text: 'x', calls: [call('run_bash')] }))
    const { provider } = fakeProvider(forever)

    const { events } = await drain(
      runManualToolLoop<TMessage>({
        ...base,
        maxTurns: 3,
        history,
        tools: [tool('run_bash')],
        catalog: fakeCatalog(() => ({ status: 'success', result: 'ok' })),
        provider,
      }),
    )

    assert.strictEqual(events.filter((e) => e.type === 'tool.started').length, 3)
    const warning = events.at(-1)
    assert.ok(warning && warning.type === 'warning')
    assert.match(warning.payload.message, /Stopped after 3 tool turns/)
  })

  it('stops as soon as the turn is cancelled', async () => {
    const abort = new AbortController()
    const history: TMessage[] = []
    const { provider } = fakeProvider([
      { text: 'primeiro', calls: [call('run_bash')] },
      { text: 'nunca', calls: [] },
    ])

    const { answer } = await drain(
      runManualToolLoop<TMessage>({
        ...base,
        signal: abort.signal,
        history,
        tools: [tool('run_bash')],
        catalog: fakeCatalog(() => {
          abort.abort()
          return { status: 'success', result: 'ok' }
        }),
        provider,
      }),
    )

    assert.strictEqual(answer, 'primeiro')
    assert.ok(!history.includes('assistant:nunca|'))
  })

  it('says plainly when there is no catalog wired', async () => {
    const history: TMessage[] = []
    const { provider } = fakeProvider([
      { text: '', calls: [call('run_bash')] },
      { text: 'ok', calls: [] },
    ])

    const { events } = await drain(runManualToolLoop<TMessage>({ ...base, history, tools: [tool('run_bash')], catalog: undefined, provider }))

    const failure = events.find((e) => e.type === 'tool.error')
    assert.ok(failure && failure.type === 'tool.error')
    assert.match(failure.payload.message, /No tool catalog is wired/)
  })
})
