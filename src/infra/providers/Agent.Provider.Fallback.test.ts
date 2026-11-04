import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IModelGroup } from '@domain/Fallback.Policy'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { SessionStore } from '@infra/session/Session.Store'
import { adapterKey, AgentProvider } from './Agent.Provider'
import { ProviderBench } from './Provider.Bench'

/** O grupo de modelos quando o modelo falha (ver `Fallback.Policy`), com adapters falsos. */
describe('AgentProvider — grupo de modelos: troca quando o modelo falha', () => {
  const PROTOCOL: Record<string, EProvider> = { claude: EProvider.CLAUDE, openai: EProvider.OPENAI, google: EProvider.GOOGLE }

  function setup(
    options: {
      /** Os provedores sem cota. */
      quota?: Set<string>
      /** Os passos (`provedor/modelo`) cujo modelo está fora. */
      broken?: Set<string>
      /** O grupo do agente (`none` desliga). */
      modelGroup?: string
      groups?: IModelGroup[]
      defaultModelGroup?: string
      bench?: ProviderBench
      sandbox?: 'workspace-write'
    } = {},
  ) {
    const agent: IAgent = {
      id: 'reserva',
      name: 'Reserva',
      providers: [
        { provider: 'claude', models: ['claude-sonnet-5'], ...(options.sandbox ? { sandbox: options.sandbox } : {}) },
        { provider: 'openai', models: ['gpt-5.6-sol'] },
      ],
      systemPrompt: 'p',
      modes: [EMode.CHAT],
      allowedTools: [],
      ...(options.modelGroup ? { modelGroup: options.modelGroup } : {}),
    }
    const store = new SessionStore()
    const seen: Array<{ provider: string; model: string; text: string; native: unknown; sandbox?: string }> = []
    const answer = (protocol: EProvider): IAgentAdapter => ({
      async createSession(created, input) {
        const record = store.create({
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
      async *sendMessage(running, sessionId, input): AsyncIterable<IAgentEvent> {
        const record = store.get(sessionId)!
        const sandbox = running.providers.find((target) => target.provider === record.provider)?.sandbox
        seen.push({ provider: record.provider, model: record.model, text: input.text, native: record.native, ...(sandbox ? { sandbox } : {}) })
        yield { type: 'text.delta', sessionId, timestamp: new Date(), payload: { text: `parte de ${record.provider}` } }
        yield { type: 'tool.started', sessionId, timestamp: new Date(), payload: { tool: 'run_bash', args: {} } }
        if (options.quota?.has(record.provider)) {
          yield { type: 'error', sessionId, timestamp: new Date(), payload: { message: 'You exceeded your current quota', kind: 'quota' } }
          return
        }
        if (options.broken?.has(`${record.provider}/${record.model}`)) {
          yield { type: 'error', sessionId, timestamp: new Date(), payload: { message: `model ${record.model} does not exist`, kind: 'model' } }
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
      new NullSettingsRepository({
        audience: 'all',
        ...(options.groups ? { modelGroups: options.groups } : {}),
        ...(options.defaultModelGroup ? { defaultModelGroup: options.defaultModelGroup } : {}),
      }),
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
  const group = (id: string, steps: Array<[string, string]>, extra: Partial<IModelGroup> = {}): IModelGroup => ({
    id,
    name: id,
    steps: steps.map(([provider, model]) => ({ provider, model })),
    ...extra,
  })
  const PADRAO = group('padrao', [
    ['claude', 'claude-sonnet-5'],
    ['openai', 'gpt-5.6-sol'],
  ])
  const warningOf = (events: IAgentEvent[]) => events.filter((event) => event.type === 'warning').map((event) => (event.type === 'warning' ? event.payload.message : ''))

  it('a cota acaba no meio do turno: o erro não sai, o turno segue no próximo do grupo, com o que já foi feito', async () => {
    const { provider, seen, bench } = setup({ quota: new Set(['claude']), groups: [PADRAO], defaultModelGroup: 'padrao' })
    await settle()
    const session = await provider.createSession({ agentId: 'reserva' })
    const events = await run(provider.sendMessage(session.id, { text: 'rode os testes' }))

    assert.ok(!events.some((event) => event.type === 'error'))
    assert.match(warningOf(events).join('\n'), /Cota esgotada em claude · claude-sonnet-5.*segue em openai · gpt-5\.6-sol/)
    assert.ok(events.some((event) => event.type === 'message.completed'))
    assert.deepStrictEqual(
      seen.map((call) => call.provider),
      ['claude', 'openai'],
    )
    // O provider novo começa do zero (sem o estado nativo do anterior), com a transcrição do que já rodou.
    assert.strictEqual(seen[1].native, undefined)
    assert.match(seen[1].text, /cota do modelo anterior acabou/)
    assert.match(seen[1].text, /Assistente: parte de claude/)
    assert.match(seen[1].text, /rode os testes$/)

    const after = provider.describe(session.id)
    assert.deepStrictEqual([after.provider, after.model, after.handoff], ['openai', 'gpt-5.6-sol', undefined])
    assert.ok(bench.isBenched('claude'))
  })

  it('⚖️ a conversa FICA no passo que funcionou: o turno seguinte não volta ao primeiro, nem depois que ele se recupera', async () => {
    let now = Date.now()
    const bench = new ProviderBench(() => now)
    const quota = new Set(['claude'])
    const { provider, seen } = setup({ quota, groups: [PADRAO], defaultModelGroup: 'padrao', bench })
    await settle()
    const session = await provider.createSession({ agentId: 'reserva' })
    await run(provider.sendMessage(session.id, { text: 'um' }))
    quota.clear()
    now += 24 * 60 * 60_000
    await run(provider.sendMessage(session.id, { text: 'dois' }))
    assert.deepStrictEqual(
      seen.map((call) => call.provider),
      ['claude', 'openai', 'openai'],
    )
  })

  it('o erro do MODELO tira só ele: o próximo modelo do mesmo provedor segue', async () => {
    const groups = [
      group('claudes', [
        ['claude', 'claude-sonnet-5'],
        ['claude', 'claude-opus-5'],
        ['openai', 'gpt-5.6-sol'],
      ]),
    ]
    const { provider, seen, bench } = setup({ broken: new Set(['claude/claude-sonnet-5']), groups, modelGroup: 'claudes' })
    await settle()
    const session = await provider.createSession({ agentId: 'reserva' })
    const events = await run(provider.sendMessage(session.id, { text: 'oi' }))
    assert.match(warningOf(events).join('\n'), /Modelo indisponível em claude · claude-sonnet-5/)
    assert.deepStrictEqual(
      seen.map((call) => `${call.provider}/${call.model}`),
      ['claude/claude-sonnet-5', 'claude/claude-opus-5'],
    )
    assert.ok(bench.isBenched('claude/claude-sonnet-5'))
    assert.ok(!bench.isBenched('claude'))
  })

  it('sem modelo escolhido, a conversa nasce no primeiro passo disponível do grupo; a escolhida no chat vale como antes', async () => {
    const groups = [
      group('openai-antes', [
        ['openai', 'gpt-5.6-sol'],
        ['claude', 'claude-sonnet-5'],
      ]),
    ]
    const { provider } = setup({ groups, modelGroup: 'openai-antes' })
    await settle()
    assert.strictEqual(provider.describe((await provider.createSession({ agentId: 'reserva' })).id).provider, 'openai')
    assert.strictEqual(provider.describe((await provider.createSession({ agentId: 'reserva', provider: 'claude', model: 'claude-sonnet-5' })).id).provider, 'claude')
  })

  it('a próxima conversa já nasce fora do passo sem cota; e a que estava nele troca antes de tentar', async () => {
    const bench = new ProviderBench()
    const { provider, seen } = setup({ groups: [PADRAO], defaultModelGroup: 'padrao', bench })
    await settle()
    const old = await provider.createSession({ agentId: 'reserva' })
    bench.bench('claude', Date.now() + 60_000)

    assert.strictEqual(provider.describe((await provider.createSession({ agentId: 'reserva' })).id).provider, 'openai')
    const events = await run(provider.sendMessage(old.id, { text: 'oi' }))
    assert.deepStrictEqual(
      seen.map((call) => call.provider),
      ['openai'],
    )
    assert.ok(warningOf(events).some((message) => /sem cota agora/.test(message)))
  })

  it('sem próximo que rode, o erro sai como sempre; cada provedor é tentado uma vez por turno', async () => {
    const { provider, seen } = setup({ quota: new Set(['claude', 'openai']), groups: [PADRAO], defaultModelGroup: 'padrao' })
    await settle()
    const session = await provider.createSession({ agentId: 'reserva' })
    const events = await run(provider.sendMessage(session.id, { text: 'oi' }))
    assert.deepStrictEqual(
      seen.map((call) => call.provider),
      ['claude', 'openai'],
    )
    assert.ok(events.some((event) => event.type === 'error' && event.payload.kind === 'quota'))
  })

  it('⚖️ passo de um provedor que o agente não tem roda com o sandbox do agente; `none` desliga; a falha fora do `switchOn` sai', async () => {
    const outside = setup({
      quota: new Set(['claude']),
      sandbox: 'workspace-write',
      groups: [
        group('com-google', [
          ['claude', 'claude-sonnet-5'],
          ['google', 'gemini-x'],
        ]),
      ],
      defaultModelGroup: 'com-google',
    })
    await settle()
    const one = await outside.provider.createSession({ agentId: 'reserva' })
    assert.ok(!(await run(outside.provider.sendMessage(one.id, { text: 'oi' }))).some((event) => event.type === 'error'))
    assert.deepStrictEqual(
      outside.seen.map((call) => [call.provider, call.sandbox]),
      [
        ['claude', 'workspace-write'],
        ['google', 'workspace-write'],
      ],
    )

    const off = setup({ quota: new Set(['claude']), groups: [PADRAO], defaultModelGroup: 'padrao', modelGroup: 'none' })
    await settle()
    const two = await off.provider.createSession({ agentId: 'reserva' })
    assert.ok((await run(off.provider.sendMessage(two.id, { text: 'oi' }))).some((event) => event.type === 'error'))

    const strict = setup({ quota: new Set(['claude']), groups: [{ ...PADRAO, switchOn: ['model'] }], defaultModelGroup: 'padrao' })
    await settle()
    const three = await strict.provider.createSession({ agentId: 'reserva' })
    assert.ok((await run(strict.provider.sendMessage(three.id, { text: 'oi' }))).some((event) => event.type === 'error'))
    assert.deepStrictEqual(
      strict.seen.map((call) => call.provider),
      ['claude'],
    )
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
