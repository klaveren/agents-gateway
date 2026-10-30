import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgentFallback } from '@domain/Fallback.Policy'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { SessionStore } from '@infra/session/Session.Store'
import { adapterKey, AgentProvider } from './Agent.Provider'
import { ProviderBench } from './Provider.Bench'

/** A troca de provedor quando a cota acaba (ver `Fallback.Policy`), com adapters falsos. */
describe('AgentProvider — troca de provedor quando a cota acaba', () => {
  const PROTOCOL: Record<string, EProvider> = { claude: EProvider.CLAUDE, openai: EProvider.OPENAI, google: EProvider.GOOGLE }

  function setup(options: { quota?: Set<string>; fallback?: IAgentFallback; chain?: Array<{ provider: string; model: string }>; bench?: ProviderBench } = {}) {
    const agent: IAgent = {
      id: 'reserva',
      name: 'Reserva',
      providers: [
        { provider: 'claude', models: ['claude-sonnet-5'] },
        { provider: 'openai', models: ['gpt-5.6-sol'] },
      ],
      systemPrompt: 'p',
      modes: [EMode.CHAT],
      allowedTools: [],
      ...(options.fallback ? { fallback: options.fallback } : {}),
    }
    const store = new SessionStore()
    const seen: Array<{ provider: string; text: string; native: unknown }> = []
    const answer = (protocol: EProvider): IAgentAdapter => ({
      async createSession(created, input) {
        const record = store.create(protocol, {
          agentId: created.id,
          provider: input.provider!,
          protocol,
          mode: EMode.CHAT,
          model: input.model!,
          tools: false,
          systemPrompt: created.systemPrompt,
          native: { from: protocol },
        })
        return { id: record.id, provider: protocol, mode: record.mode, createdAt: record.createdAt }
      },
      async *sendMessage(_agent, sessionId, input): AsyncIterable<IAgentEvent> {
        const record = store.get(sessionId)!
        seen.push({ provider: record.provider, text: input.text, native: record.native })
        yield { type: 'text.delta', sessionId, timestamp: new Date(), payload: { text: `parte de ${record.provider}` } }
        yield { type: 'tool.started', sessionId, timestamp: new Date(), payload: { tool: 'run_bash', args: {} } }
        if (options.quota?.has(record.provider)) {
          yield { type: 'error', sessionId, timestamp: new Date(), payload: { message: 'You exceeded your current quota', kind: 'quota' } }
          return
        }
        yield { type: 'message.completed', sessionId, timestamp: new Date() }
      },
      async cancel() {},
    })
    const config = (id: string) =>
      PROTOCOL[id] ? { id, name: id, protocol: PROTOCOL[id], official: true, enabled: true, createdAt: new Date(), updatedAt: new Date() } : undefined
    const bench = options.bench ?? new ProviderBench()
    const provider = new AgentProvider(
      new Map([
        [adapterKey(EProvider.CLAUDE, EMode.CHAT), answer(EProvider.CLAUDE)],
        [adapterKey(EProvider.OPENAI, EMode.CHAT), answer(EProvider.OPENAI)],
        [adapterKey(EProvider.GOOGLE, EMode.CHAT), answer(EProvider.GOOGLE)],
      ]),
      store,
      new NullSettingsRepository({ audience: 'all', ...(options.chain ? { fallback: { chain: options.chain } } : {}) }),
      { list: () => [agent], get: (id) => (id === agent.id ? agent : undefined) },
      { list: () => [], get: config, connection: (id) => (config(id) ? { providerId: id, name: id, protocol: PROTOCOL[id], key: 'k' } : undefined) },
      undefined,
      bench,
    )
    return { provider, seen, bench }
  }

  const run = async (stream: AsyncIterable<IAgentEvent>) => {
    const events: IAgentEvent[] = []
    for await (const event of stream) events.push(event)
    return events
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  const CHAIN = [
    { provider: 'claude', model: 'claude-sonnet-5' },
    { provider: 'openai', model: 'gpt-5.6-sol' },
  ]

  it('a cota acaba no meio do turno: o erro não sai, o turno segue no próximo, com o que já foi feito', async () => {
    const { provider, seen, bench } = setup({ quota: new Set(['claude']), chain: CHAIN })
    await settle()
    const session = await provider.createSession({ agentId: 'reserva' })
    const events = await run(provider.sendMessage(session.id, { text: 'rode os testes' }))

    assert.ok(!events.some((event) => event.type === 'error'))
    const warning = events.find((event) => event.type === 'warning')
    assert.match(warning?.type === 'warning' ? warning.payload.message : '', /Cota de claude · claude-sonnet-5 esgotada.*segue em openai · gpt-5\.6-sol/)
    assert.ok(events.some((event) => event.type === 'message.completed'))

    assert.deepStrictEqual(
      seen.map((call) => call.provider),
      ['claude', 'openai'],
    )
    // O provider novo começa do zero (sem o estado nativo do anterior), com a transcrição do que já rodou.
    assert.strictEqual(seen[1].native, undefined)
    assert.match(seen[1].text, /cota do modelo anterior acabou/)
    assert.match(seen[1].text, /Assistente: parte de claude/)
    assert.match(seen[1].text, /Ferramentas usadas: run_bash/)
    assert.match(seen[1].text, /rode os testes$/)

    const after = provider.describe(session.id)
    assert.deepStrictEqual([after.provider, after.model, after.handoff], ['openai', 'gpt-5.6-sol', undefined])
    assert.ok(bench.isBenched('claude'))
  })

  it('a próxima conversa já nasce fora do provedor sem cota; e a que estava nele troca antes de tentar', async () => {
    const bench = new ProviderBench()
    const { provider, seen } = setup({ chain: CHAIN, bench })
    await settle()
    const old = await provider.createSession({ agentId: 'reserva' })
    bench.bench('claude', Date.now() + 60_000)

    assert.strictEqual(provider.describe((await provider.createSession({ agentId: 'reserva' })).id).provider, 'openai')
    const events = await run(provider.sendMessage(old.id, { text: 'oi' }))
    assert.deepStrictEqual(
      seen.map((call) => call.provider),
      ['openai'],
    )
    assert.ok(events.some((event) => event.type === 'warning' && /sem cota agora/.test(event.payload.message)))
  })

  it('sem próximo que rode, o erro sai como sempre; cada provedor é tentado uma vez por turno', async () => {
    const { provider, seen } = setup({ quota: new Set(['claude', 'openai']), chain: CHAIN })
    await settle()
    const session = await provider.createSession({ agentId: 'reserva' })
    const events = await run(provider.sendMessage(session.id, { text: 'oi' }))

    assert.deepStrictEqual(
      seen.map((call) => call.provider),
      ['claude', 'openai'],
    )
    assert.ok(events.some((event) => event.type === 'error' && event.payload.kind === 'quota'))
  })

  it('⛔ passo que o agente não oferece nunca roda; `off` desliga; `own` usa a cadeia do agente', async () => {
    const outside = setup({ quota: new Set(['claude']), chain: [CHAIN[0], { provider: 'google', model: 'gemini-x' }] })
    await settle()
    const one = await outside.provider.createSession({ agentId: 'reserva' })
    assert.ok((await run(outside.provider.sendMessage(one.id, { text: 'oi' }))).some((event) => event.type === 'error'))
    assert.deepStrictEqual(
      outside.seen.map((call) => call.provider),
      ['claude'],
    )

    const off = setup({ quota: new Set(['claude']), chain: CHAIN, fallback: { mode: 'off' } })
    await settle()
    const two = await off.provider.createSession({ agentId: 'reserva' })
    assert.ok((await run(off.provider.sendMessage(two.id, { text: 'oi' }))).some((event) => event.type === 'error'))

    const own = setup({ quota: new Set(['claude']), fallback: { mode: 'own', chain: CHAIN } })
    await settle()
    const three = await own.provider.createSession({ agentId: 'reserva' })
    assert.ok(!(await run(own.provider.sendMessage(three.id, { text: 'oi' }))).some((event) => event.type === 'error'))
    assert.strictEqual(own.provider.describe(three.id).provider, 'openai')
  })

  it('o banco de reservas devolve o provedor quando a cota volta', () => {
    let now = 1_000
    const bench = new ProviderBench(() => now)
    bench.bench('claude', 5_000)
    assert.ok(bench.isBenched('claude'))
    now = 5_001
    assert.ok(!bench.isBenched('claude'))
    assert.deepStrictEqual(bench.list(), [])
  })
})
