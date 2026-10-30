import assert from 'node:assert'
import { describe, it } from 'node:test'
import { aggregateTurn } from '@application/Turn.Aggregator'
import { INTERJECTION_QUEUE_MAX } from '@domain/Interjection.Policy'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { InterjectionQueueFullError } from '@domain/errors/Domain.Error'
import { runManualToolLoop } from '@infra/adapters/support/ManualTool.Loop'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { SessionStore } from '@infra/session/Session.Store'
import { adapterKey, AgentProvider } from './Agent.Provider'

/** A mensagem mandada com o turno rodando (ver `Interjection.Policy`), com um adapter falso que espera um sinal no meio. */
describe('AgentProvider — mensagem durante o turno', () => {
  function setup(options: { takes: boolean; ending?: 'error' | 'aborted' }) {
    const agent: IAgent = {
      id: 'dev',
      name: 'Dev',
      providers: [{ provider: 'claude', models: ['claude-sonnet-5'] }],
      systemPrompt: 'p',
      modes: [EMode.CHAT],
      allowedTools: [],
    }
    const store = new SessionStore()
    const seen: string[] = []
    let release: () => void = () => undefined
    let reached: () => void = () => undefined
    const atTool = new Promise<void>((resolve) => (reached = resolve))
    const adapter: IAgentAdapter = {
      async createSession(created, input) {
        const record = store.create(EProvider.CLAUDE, {
          agentId: created.id,
          provider: input.provider!,
          protocol: EProvider.CLAUDE,
          mode: EMode.CHAT,
          model: input.model!,
          tools: false,
          systemPrompt: created.systemPrompt,
        })
        return { id: record.id, provider: EProvider.CLAUDE, mode: record.mode, createdAt: record.createdAt }
      },
      async *sendMessage(_agent, sessionId, input): AsyncIterable<IAgentEvent> {
        seen.push(input.text)
        const now = () => new Date()
        yield { type: 'message.started', sessionId, timestamp: now() }
        if (seen.length === 1) {
          yield { type: 'tool.started', sessionId, timestamp: now(), payload: { tool: 'run_bash', args: {} } }
          await new Promise<void>((resolve) => {
            release = resolve
            reached()
          })
          yield { type: 'tool.result', sessionId, timestamp: now(), payload: { tool: 'run_bash', result: 'ok' } }
          // A lane com onde pôr: entre a ferramenta e a próxima chamada ao modelo.
          const arrived = options.takes ? (input.interjections?.() ?? []) : []
          yield { type: 'text.delta', sessionId, timestamp: now(), payload: { text: arrived.length ? `vi: ${arrived.join('+')}. ` : 'feito. ' } }
          if (options.ending === 'error') {
            yield { type: 'error', sessionId, timestamp: now(), payload: { message: 'caiu' } }
            return
          }
          if (options.ending === 'aborted') {
            yield { type: 'message.aborted', sessionId, timestamp: now() }
            return
          }
        } else yield { type: 'text.delta', sessionId, timestamp: now(), payload: { text: `rodada: ${input.text}` } }
        yield { type: 'message.completed', sessionId, timestamp: now() }
      },
      async cancel() {},
    }
    const config = (id: string) =>
      id === 'claude' ? { id, name: id, protocol: EProvider.CLAUDE, official: true, enabled: true, createdAt: new Date(), updatedAt: new Date() } : undefined
    const provider = new AgentProvider(
      new Map([[adapterKey(EProvider.CLAUDE, EMode.CHAT), adapter]]),
      store,
      new NullSettingsRepository({ audience: 'all' }),
      { list: () => [agent], get: (id) => (id === agent.id ? agent : undefined) },
      { list: () => [], get: config, connection: (id) => (config(id) ? { providerId: id, name: id, protocol: EProvider.CLAUDE, key: 'k' } : undefined) },
    )
    return { provider, seen, store, atTool, release: () => release() }
  }

  /** Roda o turno; quando o adapter chega na ferramenta, `during` age (manda mensagens) e o turno segue. */
  async function turn(env: ReturnType<typeof setup>, sessionId: string, during: () => void) {
    const events: IAgentEvent[] = []
    const running = (async () => {
      for await (const event of env.provider.sendMessage(sessionId, { text: 'migre' })) events.push(event)
    })()
    await env.atTool
    during()
    env.release()
    await running
    return events
  }
  const kinds = (events: IAgentEvent[]) => events.map((event) => (event.type === 'text.delta' ? `text:${event.payload.text.trim()}` : event.type))

  it('a lane que tem onde pôr: a mensagem entra entre a ferramenta e a próxima chamada, e o evento sai antes da resposta', async () => {
    const env = setup({ takes: true })
    const session = await env.provider.createSession({ agentId: 'dev' })
    const events = await turn(env, session.id, () => {
      assert.strictEqual(env.provider.enqueue(session.id, 'use o banco B'), 1)
      assert.strictEqual(env.provider.enqueue(session.id, 'e sem pressa'), 2)
    })
    assert.deepStrictEqual(kinds(events), [
      'message.started',
      'tool.started',
      'tool.result',
      'message.injected',
      'message.injected',
      'text:vi: use o banco B+e sem pressa.',
      'message.completed',
    ])
    assert.deepStrictEqual(env.seen, ['migre'], 'nenhuma rodada a mais')
    const record = env.store.get(session.id)!
    assert.deepStrictEqual(record.transcript?.[0].interjections, ['use o banco B', 'e sem pressa'])
    assert.strictEqual(record.queued, undefined)
    assert.strictEqual(record.turns, 1)

    const recorded = aggregateTurn(session.id, events)
    assert.deepStrictEqual(recorded.interjections, [
      { at: 0, text: 'use o banco B' },
      { at: 0, text: 'e sem pressa' },
    ])
  })

  it('a lane sem onde pôr (Codex, Antigravity): uma rodada a mais no mesmo turno, com um só fim', async () => {
    const env = setup({ takes: false })
    const session = await env.provider.createSession({ agentId: 'dev' })
    const events = await turn(env, session.id, () => env.provider.enqueue(session.id, 'agora o teste'))
    assert.deepStrictEqual(env.seen, ['migre', 'agora o teste'])
    // Um só começo e um só fim: a rodada a mais é do mesmo turno.
    assert.deepStrictEqual(kinds(events), ['message.started', 'tool.started', 'tool.result', 'text:feito.', 'message.injected', 'text:rodada: agora o teste', 'message.completed'])
    assert.deepStrictEqual(aggregateTurn(session.id, events).interjections, [{ at: 'feito. '.length, text: 'agora o teste' }])
    assert.strictEqual(env.store.get(session.id)!.turns, 1)
  })

  for (const ending of ['error', 'aborted'] as const) {
    it(`⛔ o turno que parou (${ending}) descarta a fila, com aviso, e não roda a rodada`, async () => {
      const env = setup({ takes: false, ending })
      const session = await env.provider.createSession({ agentId: 'dev' })
      const events = await turn(env, session.id, () => env.provider.enqueue(session.id, 'e mais isto'))
      assert.deepStrictEqual(env.seen, ['migre'])
      assert.ok(events.some((event) => event.type === 'warning' && /1 mensagem\(ns\) que esperavam o turno não entraram/.test(event.payload.message)))
      assert.ok(!events.some((event) => event.type === 'message.injected' || event.type === 'message.completed'))
      assert.strictEqual(env.store.get(session.id)!.queued, undefined)
    })
  }

  it('conversa parada não enfileira (vira turno normal); a fila tem teto', async () => {
    const env = setup({ takes: false })
    const session = await env.provider.createSession({ agentId: 'dev' })
    assert.strictEqual(env.provider.enqueue(session.id, 'oi'), undefined)
    await turn(env, session.id, () => {
      for (let index = 0; index < INTERJECTION_QUEUE_MAX; index++) env.provider.enqueue(session.id, `m${index}`)
      assert.throws(() => env.provider.enqueue(session.id, 'demais'), InterjectionQueueFullError)
    })
    assert.strictEqual(env.seen[1].split('\n\n').length, INTERJECTION_QUEUE_MAX, 'as da fila entram juntas na rodada')
  })

  it('o loop das lanes de chat: o que chegou vai junto dos resultados, antes da próxima chamada ao modelo', async () => {
    const appended: Array<string | undefined> = []
    let calls = 0
    const queue = ['pare no passo 2']
    const loop = runManualToolLoop<string>({
      sessionId: 's',
      history: [],
      tools: [{ origin: 'local', name: 'ls', description: 'd', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
      catalog: { invoke: async () => ({ status: 'success', result: 'x' }) } as never,
      context: {},
      signal: new AbortController().signal,
      maxTurns: 3,
      interjections: () => queue.splice(0),
      provider: {
        // eslint-disable-next-line require-yield
        async *runTurn() {
          calls += 1
          return { text: '', calls: calls === 1 ? [{ id: '1', name: 'ls', args: {} }] : [] }
        },
        appendAssistant() {},
        appendToolResults(_history, _results, note) {
          appended.push(note)
        },
      },
    })
    for await (const _event of loop) void _event
    assert.strictEqual(appended.length, 1)
    assert.match(appended[0]!, /^\[Mensagem nova da pessoa[^\]]*\]\n\npare no passo 2$/)
  })
})
