import assert from 'node:assert'
import { describe, it } from 'node:test'
import { COMPACT_REQUEST, compactHandoff, shouldCompact } from '@domain/Compaction.Policy'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { SessionStore } from '@infra/session/Session.Store'
import { adapterKey, AgentProvider } from './Agent.Provider'

/** A compactação do contexto (ver `Compaction.Policy`), com um adapter falso que informa o contexto em uso. */
describe('AgentProvider — compactação do contexto', () => {
  function setup(options: { context: number; summary?: 'ok' | 'tool'; compactsItself?: boolean; failAfter?: boolean }) {
    const agent: IAgent = {
      id: 'longo',
      name: 'Longo',
      providers: [{ provider: 'claude', models: ['claude-sonnet-5'] }],
      systemPrompt: 'p',
      modes: [EMode.CHAT],
      allowedTools: [],
    }
    const store = new SessionStore()
    const seen: Array<{ text: string; native: unknown; context?: string }> = []
    let failing = false
    const adapter: IAgentAdapter = {
      ...(options.compactsItself ? { compactsItself: true } : {}),
      async createSession(created, input) {
        const record = store.create({
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
        const record = store.get(sessionId)!
        seen.push({ text: input.text, native: record.native, ...(input.context ? { context: input.context } : {}) })
        record.native ??= { history: [] }
        if (input.text === COMPACT_REQUEST) {
          if (options.summary === 'tool') {
            yield { type: 'tool.started', sessionId, timestamp: new Date(), payload: { tool: 'run_bash', args: {} } }
            yield { type: 'text.delta', sessionId, timestamp: new Date(), payload: { text: 'não deveria ser lido' } }
            return
          }
          yield { type: 'text.delta', sessionId, timestamp: new Date(), payload: { text: 'RESUMO: a pessoa quer migrar o banco; falta o passo 3.' } }
          yield { type: 'usage', sessionId, timestamp: new Date(), payload: { inputTokens: options.context, outputTokens: 50, contextTokens: options.context } }
          yield { type: 'message.completed', sessionId, timestamp: new Date() }
          return
        }
        if (failing) {
          yield { type: 'error', sessionId, timestamp: new Date(), payload: { message: 'caiu' } }
          return
        }
        yield { type: 'text.delta', sessionId, timestamp: new Date(), payload: { text: `resposta a ${input.text.slice(-12)}` } }
        yield { type: 'usage', sessionId, timestamp: new Date(), payload: { inputTokens: options.context, outputTokens: 10, contextTokens: options.context } }
        yield { type: 'message.completed', sessionId, timestamp: new Date() }
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
      undefined,
      undefined,
      () => 1_000,
    )
    return { provider, seen, store, fail: () => (failing = true) }
  }

  const run = async (stream: AsyncIterable<IAgentEvent>) => {
    const events: IAgentEvent[] = []
    for await (const event of stream) events.push(event)
    return events
  }
  const warnings = (events: IAgentEvent[]) => events.flatMap((event) => (event.type === 'warning' ? [event.payload.message] : []))

  it('passou do gatilho: o turno seguinte começa com o resumo, num SDK zerado, e o resumo não sai como texto', async () => {
    const { provider, seen } = setup({ context: 850, summary: 'ok' })
    const session = await provider.createSession({ agentId: 'longo' })
    await run(provider.sendMessage(session.id, { text: 'migre o banco' }))
    const events = await run(provider.sendMessage(session.id, { text: 'e o passo 3?', context: 'Projeto atual: XPTO.' }))

    assert.deepStrictEqual(
      seen.map((call) => call.text === COMPACT_REQUEST),
      [false, true, false],
    )
    assert.ok(seen[1].native, 'o resumo é pedido com o histórico inteiro')
    assert.strictEqual(seen[2].native, undefined, 'e a conversa recomeça sem ele')
    assert.match(seen[2].text, /## Resumo\nRESUMO: a pessoa quer migrar o banco/)
    assert.match(seen[2].text, /Pessoa: migre o banco/)
    assert.match(seen[2].text, /e o passo 3\?$/)
    // O contexto do sistema (projeto, identidade) volta junto do resumo, e nunca chega solto ao adapter.
    assert.match(seen[2].text, /Projeto atual: XPTO\.\n\ne o passo 3/)
    assert.ok(seen.every((call) => call.context === undefined))

    assert.ok(!events.some((event) => event.type === 'text.delta' && /RESUMO/.test(event.payload.text)))
    assert.match(warnings(events).join(' | '), /Compactando o contexto \(85% da janela de 1000 tokens\).*Contexto compactado/)
    assert.strictEqual(events.filter((event) => event.type === 'usage').length, 2, 'o consumo do resumo conta')
    assert.strictEqual(provider.describe(session.id).handoff, undefined, 'o repasse foi entregue')
  })

  it('abaixo do gatilho não compacta; pedido à mão, compacta no próximo turno', async () => {
    const { provider, seen } = setup({ context: 500, summary: 'ok' })
    const session = await provider.createSession({ agentId: 'longo' })
    await run(provider.sendMessage(session.id, { text: 'um' }))
    await run(provider.sendMessage(session.id, { text: 'dois' }))
    assert.ok(!seen.some((call) => call.text === COMPACT_REQUEST))

    assert.strictEqual(provider.requestCompaction(session.id).compactNext, true)
    await run(provider.sendMessage(session.id, { text: 'três' }))
    assert.strictEqual(seen.filter((call) => call.text === COMPACT_REQUEST).length, 1)
    assert.strictEqual(provider.describe(session.id).compactNext, undefined)
  })

  it('⛔ resumo que chama ferramenta é abandonado: vale a transcrição recortada', async () => {
    const { provider, seen } = setup({ context: 900, summary: 'tool' })
    const session = await provider.createSession({ agentId: 'longo' })
    await run(provider.sendMessage(session.id, { text: 'migre o banco' }))
    const events = await run(provider.sendMessage(session.id, { text: 'segue' }))

    assert.match(seen[2].text, /contexto foi compactado — o que você lembrava/)
    assert.ok(!seen[2].text.includes('não deveria ser lido'))
    assert.match(warnings(events).join(' | '), /resumo do contexto falhou/)
    assert.ok(!events.some((event) => event.type === 'tool.started'))
  })

  it('a lane que compacta sozinha fica de fora, e recusa o pedido à mão', async () => {
    const { provider, seen } = setup({ context: 990, summary: 'ok', compactsItself: true })
    const session = await provider.createSession({ agentId: 'longo' })
    await run(provider.sendMessage(session.id, { text: 'um' }))
    await run(provider.sendMessage(session.id, { text: 'dois' }))
    assert.ok(!seen.some((call) => call.text === COMPACT_REQUEST))
    assert.strictEqual(provider.describe(session.id).compactsItself, true)
    assert.throws(() => provider.requestCompaction(session.id), /compacts its own context/)
  })

  it('o turno que falha depois da compactação refaz o repasse com o mesmo resumo', async () => {
    const { provider, seen, fail } = setup({ context: 900, summary: 'ok' })
    const session = await provider.createSession({ agentId: 'longo' })
    await run(provider.sendMessage(session.id, { text: 'migre o banco' }))
    fail()
    await run(provider.sendMessage(session.id, { text: 'segue' }))
    await run(provider.sendMessage(session.id, { text: 'de novo' }))

    assert.strictEqual(seen.filter((call) => call.text === COMPACT_REQUEST).length, 1, 'não resume duas vezes')
    assert.match(seen[3].text, /## Resumo\nRESUMO/)
    assert.match(seen[3].text, /de novo$/)
  })

  it('a regra: o gatilho em % da janela, e o repasse com o resumo e só os últimos turnos', () => {
    assert.ok(shouldCompact(800, 1_000, 80))
    assert.ok(!shouldCompact(799, 1_000, 80))
    assert.ok(!shouldCompact(900, undefined, 80), 'janela desconhecida não compacta')

    const turns = ['um', 'dois', 'três'].map((request) => ({ request, text: `r ${request}` }))
    const text = compactHandoff('o resumo', turns)
    assert.match(text, /## Resumo\no resumo/)
    assert.ok(!text.includes('Pessoa: um'))
    assert.match(text, /Pessoa: dois[\s\S]*Pessoa: três/)
  })
})
