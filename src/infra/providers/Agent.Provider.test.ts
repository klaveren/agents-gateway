import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import {
  AdapterNotFoundError,
  AgentNotFoundError,
  AgentUnavailableError,
  InvalidSessionChangeError,
  ModeNotSupportedError,
  SessionBusyError,
  SessionNotFoundError,
  ToolsNotSupportedError,
} from '@domain/errors/Domain.Error'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { withCaller } from '@infra/mcp/Caller.Identity'
import { normalizeSettings } from '@domain/models/Settings.Model'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { SessionStore } from '@infra/session/Session.Store'
import { adapterKey, AgentProvider } from './Agent.Provider'

interface ISpy {
  adapter: IAgentAdapter
  calls: string[]
  seenSessionId?: string
  seenToken?: string
}

describe('AgentProvider', () => {
  /**
   * O adapter falso escreve no store compartilhado como os reais fazem, para que o
   * roteamento por sessão seja exercido de verdade.
   */
  function spyAdapter(store: SessionStore, provider: EProvider, mode: EMode, events: IAgentEvent[] = []): ISpy {
    const calls: string[] = []
    const spy: ISpy = {
      calls,
      adapter: {
        async createSession(agent, input) {
          calls.push('createSession')
          const record = store.create(`${provider}-${mode}`, {
            agentId: agent.id,
            provider,
            protocol: provider,
            mode: input.mode ?? EMode.CHAT,
            model: input.model ?? 'model-x',
            tools: input.tools === true,
            systemPrompt: agent.systemPrompt,
          })
          return { id: record.id, provider, mode: record.mode, createdAt: record.createdAt }
        },
        async *sendMessage(_agent, sessionId, _input, context) {
          calls.push('sendMessage')
          spy.seenSessionId = sessionId
          spy.seenToken = context?.token
          for (const event of events) yield event
        },
        async cancel(sessionId) {
          calls.push('cancel')
          spy.seenSessionId = sessionId
        },
      },
    }
    return spy
  }

  function setup(events: IAgentEvent[] = []) {
    const store = new SessionStore()
    const chat = spyAdapter(store, EProvider.GOOGLE, EMode.CHAT, events)
    const agent = spyAdapter(store, EProvider.GOOGLE, EMode.AGENT, events)

    const provider = new AgentProvider(
      new Map([
        [adapterKey(EProvider.GOOGLE, EMode.CHAT), chat.adapter],
        [adapterKey(EProvider.GOOGLE, EMode.AGENT), agent.adapter],
      ]),
      store,
    )

    return { provider, store, chat, agent }
  }

  /** O mesmo `setup`, com um repositório de configuração plugado. */
  function setupWithSettings(settings: NullSettingsRepository) {
    const store = new SessionStore()
    const chat = spyAdapter(store, EProvider.GOOGLE, EMode.CHAT, [])
    const agent = spyAdapter(store, EProvider.GOOGLE, EMode.AGENT, [])

    // O agente do Claude entra para haver DOIS agentes de verdade — sem isso não dá para provar que
    // a escolha de quem chama vence a da configuração.
    const claude = spyAdapter(store, EProvider.CLAUDE, EMode.CHAT, [])

    const provider = new AgentProvider(
      new Map([
        [adapterKey(EProvider.GOOGLE, EMode.CHAT), chat.adapter],
        [adapterKey(EProvider.GOOGLE, EMode.AGENT), agent.adapter],
        [adapterKey(EProvider.CLAUDE, EMode.CHAT), claude.adapter],
      ]),
      store,
      settings,
    )

    return { provider, chat, agent, claude }
  }

  const drain = async (stream: AsyncIterable<IAgentEvent>) => {
    const collected: IAgentEvent[] = []
    for await (const event of stream) collected.push(event)
    return collected
  }

  it('opens a session on an agent created through the API, looked up in the directory', async () => {
    const store = new SessionStore()
    const chat = spyAdapter(store, EProvider.GOOGLE, EMode.CHAT, [])
    const created = { id: 'juridico', name: 'Jurídico', provider: EProvider.GOOGLE, systemPrompt: 'p', models: ['gemini-3.7-flash'], modes: [EMode.CHAT], allowedTools: [] }
    const provider = new AgentProvider(new Map([[adapterKey(EProvider.GOOGLE, EMode.CHAT), chat.adapter]]), store, undefined, {
      list: () => [created],
      get: (id) => (id === created.id ? created : undefined),
    })

    const session = await provider.createSession({ agentId: 'juridico' })

    assert.strictEqual(session.mode, EMode.CHAT)
    assert.deepStrictEqual(chat.calls, ['createSession'])
    await assert.rejects(provider.createSession({ agentId: 'researcher-agent' }), /researcher-agent/)
  })

  it('routes an agent on a compatible provider (OpenRouter speaking OpenAI) to the OpenAI adapter; a disabled provider opens nothing', async () => {
    const store = new SessionStore()
    const openai = spyAdapter(store, EProvider.OPENAI, EMode.CHAT, [])
    const agent = { id: 'roteado', name: 'Roteado', provider: 'openrouter', systemPrompt: 'p', models: ['meta-llama/llama-4'], modes: [EMode.CHAT], allowedTools: [] }
    let enabled = true
    const providers = {
      list: () => [],
      get: (id: string) =>
        id === 'openrouter'
          ? { id, name: 'OpenRouter', protocol: EProvider.OPENAI, baseUrl: 'https://openrouter.ai/api/v1', official: false, enabled, createdAt: new Date(), updatedAt: new Date() }
          : undefined,
      connection: () => undefined,
    }
    const provider = new AgentProvider(
      new Map([[adapterKey(EProvider.OPENAI, EMode.CHAT), openai.adapter]]),
      store,
      undefined,
      { list: () => [agent], get: (id) => (id === agent.id ? agent : undefined) },
      providers,
    )

    await provider.createSession({ agentId: 'roteado' })
    assert.deepStrictEqual(openai.calls, ['createSession'])

    enabled = false
    await assert.rejects(provider.createSession({ agentId: 'roteado' }), /openrouter/)
  })

  it('refuses a session on an agent with no enabled model, saying where to fix it', async () => {
    const store = new SessionStore()
    const chat = spyAdapter(store, EProvider.GOOGLE, EMode.CHAT, [])
    const empty = { id: 'vazio', name: 'Vazio', provider: 'google', systemPrompt: 'p', models: [], modes: [EMode.CHAT], allowedTools: [] }
    const provider = new AgentProvider(new Map([[adapterKey(EProvider.GOOGLE, EMode.CHAT), chat.adapter]]), store, undefined, { list: () => [empty], get: () => empty })

    await assert.rejects(provider.createSession({ agentId: 'vazio' }), /Providers → Models/)
    assert.deepStrictEqual(chat.calls, [])
  })

  it('defaults to the chat lane when no mode is given', async () => {
    const { provider, chat, agent } = setup()
    const session = await provider.createSession({ agentId: 'researcher-agent' })

    assert.strictEqual(session.mode, EMode.CHAT)
    assert.deepStrictEqual(chat.calls, ['createSession'])
    assert.deepStrictEqual(agent.calls, [])
  })

  it('routes the turn by the session itself, with no agentId from the caller', async () => {
    const { provider, chat, agent } = setup()
    const session = await provider.createSession({ agentId: 'researcher-agent', mode: EMode.AGENT })

    await drain(provider.sendMessage(session.id, { text: 'hi' }))
    await provider.cancel(session.id)

    assert.deepStrictEqual(agent.calls, ['createSession', 'sendMessage', 'cancel'])
    assert.deepStrictEqual(chat.calls, [])
    assert.strictEqual(agent.seenSessionId, session.id)
  })

  it('counts turns and accumulates usage in one place for every lane', async () => {
    const usage: IAgentEvent[] = [{ type: 'usage', sessionId: 'x', timestamp: new Date(), payload: { inputTokens: 4, outputTokens: 6 } }]
    const { provider } = setup(usage)
    const session = await provider.createSession({ agentId: 'researcher-agent' })

    await drain(provider.sendMessage(session.id, { text: 'one' }))
    await drain(provider.sendMessage(session.id, { text: 'two' }))

    const record = provider.describe(session.id)
    assert.strictEqual(record.turns, 2)
    // Campo que o provider não informa fica de fora, em vez de virar `undefined` ou zero.
    assert.deepStrictEqual(record.usage, { inputTokens: 8, outputTokens: 12 })
    assert.strictEqual(record.status, 'idle')
  })

  describe('reconfigure — trocar modelo e raciocínio no meio da conversa', () => {
    function claudeSetup(usage: IAgentEvent[] = []) {
      const store = new SessionStore()
      const chat = spyAdapter(store, EProvider.CLAUDE, EMode.CHAT, usage)
      const agent = {
        id: 'escritor',
        name: 'Escritor',
        provider: EProvider.CLAUDE,
        systemPrompt: 'p',
        models: ['claude-sonnet-5', 'claude-opus-5'],
        modes: [EMode.CHAT],
        allowedTools: [],
      }
      const provider = new AgentProvider(new Map([[adapterKey(EProvider.CLAUDE, EMode.CHAT), chat.adapter]]), store, undefined, {
        list: () => [agent],
        get: (id) => (id === agent.id ? agent : undefined),
      })
      return { provider, store }
    }

    it('troca o modelo e o nível; o próximo turno soma o consumo no modelo novo', async () => {
      const usage: IAgentEvent[] = [{ type: 'usage', sessionId: 'x', timestamp: new Date(), payload: { inputTokens: 10, outputTokens: 1 } }]
      const { provider } = claudeSetup(usage)
      const session = await provider.createSession({ agentId: 'escritor', model: 'claude-sonnet-5' })
      await drain(provider.sendMessage(session.id, { text: 'um' }))

      const changed = provider.reconfigure(session.id, { model: 'claude-opus-5', reasoning: 'high' })
      await drain(provider.sendMessage(session.id, { text: 'dois' }))

      assert.deepStrictEqual([changed.model, changed.reasoning], ['claude-opus-5', 'high'])
      assert.deepStrictEqual(provider.describe(session.id).usageByModel, {
        'claude-sonnet-5': { inputTokens: 10, outputTokens: 1 },
        'claude-opus-5': { inputTokens: 10, outputTokens: 1 },
      })
      assert.strictEqual(provider.reconfigure(session.id, { reasoning: null }).reasoning, undefined)
    })

    it('⛔ recusa modelo fora do agente e nível fora do protocolo, sem mudar nada', async () => {
      const { provider } = claudeSetup()
      const session = await provider.createSession({ agentId: 'escritor' })

      assert.throws(
        () => provider.reconfigure(session.id, { model: 'gpt-6', reasoning: 'minimal' }),
        (error: InvalidSessionChangeError) => error instanceof InvalidSessionChangeError && error.issues.map((issue) => issue.field).join() === 'model,reasoning',
      )
      assert.strictEqual(provider.describe(session.id).model, 'claude-sonnet-5')
    })

    it('⛔ no Google não há nível; e no meio de um turno não se troca nada', async () => {
      const { provider, store } = setup()
      const session = await provider.createSession({ agentId: 'researcher-agent' })

      assert.throws(() => provider.reconfigure(session.id, { reasoning: 'low' }), InvalidSessionChangeError)
      assert.strictEqual(provider.reconfigure(session.id, { model: 'gemini-3.6-flash' }).model, 'gemini-3.6-flash')

      store.get(session.id)!.status = 'running'
      assert.throws(() => provider.reconfigure(session.id, { model: 'gemini-3.7-flash' }), SessionBusyError)
    })
  })

  it('lists and disposes sessions', async () => {
    const { provider } = setup()
    const session = await provider.createSession({ agentId: 'researcher-agent' })

    assert.strictEqual(provider.list().length, 1)

    await provider.dispose(session.id)

    assert.strictEqual(provider.list().length, 0)
    await assert.rejects(provider.dispose(session.id), SessionNotFoundError)
  })

  it('rejects a lane the agent does not declare', async () => {
    const { provider } = setup()

    await assert.rejects(provider.createSession({ agentId: 'researcher-agent', mode: 'telepathy' as EMode }), ModeNotSupportedError)
  })

  it('refuses the manual tool loop outside the chat lane', async () => {
    const { provider } = setup()

    // Na lane agent quem conduz o loop é o SDK; ligar o nosso por cima seria pedir duas
    // orquestrações para o mesmo turno.
    await assert.rejects(provider.createSession({ agentId: 'researcher-agent', mode: EMode.AGENT, tools: true }), ToolsNotSupportedError)

    const allowed = await provider.createSession({ agentId: 'researcher-agent', tools: true })
    assert.strictEqual(allowed.mode, EMode.CHAT)
  })

  it('names the failure instead of throwing a generic error', async () => {
    const { provider } = setup()

    await assert.rejects(provider.createSession({ agentId: 'nope' }), AgentNotFoundError)
    await assert.rejects(provider.cancel('unknown-session'), SessionNotFoundError)

    const stream = provider.sendMessage('unknown-session', { text: 'hi' })
    await assert.rejects(stream[Symbol.asyncIterator]().next(), SessionNotFoundError)
  })

  it('reports a missing adapter for the lane', async () => {
    const store = new SessionStore()
    const provider = new AgentProvider(new Map(), store)

    await assert.rejects(provider.createSession({ agentId: 'researcher-agent' }), AdapterNotFoundError)
  })

  it('resolves the caller credential once, in the provider, and hands it to the adapter', async () => {
    const { provider, chat } = setup()
    const session = await provider.createSession({ agentId: 'researcher-agent' })

    await withCaller({ token: 'do-usuario' }, () => drain(provider.sendMessage(session.id, { text: 'hi' })))

    assert.strictEqual(chat.seenToken, 'do-usuario')
  })

  it('hands the adapter no credential when the request carried none', async () => {
    // ⛔ Falha aberta é o risco aqui: sem credencial a chamada segue, e é o MCP que decide. O que
    // não pode é ela aparecer com a credencial de outra pessoa.
    const { provider, chat } = setup()
    const session = await provider.createSession({ agentId: 'researcher-agent' })

    await drain(provider.sendMessage(session.id, { text: 'hi' }))

    assert.strictEqual(chat.seenToken, undefined)
  })

  it('refuses a new session while the audience is off, and says it is unavailable — not missing', async () => {
    const { provider } = setupWithSettings(new NullSettingsRepository({ audience: 'off' }))

    await assert.rejects(() => provider.createSession({ agentId: 'researcher-agent' }), AgentUnavailableError)
  })

  it('lets a conversation already open finish its turn after the audience closes', async () => {
    // ⛔ Fechar impede sessão NOVA. Matar o turno em curso deixaria meia resposta na tela e
    // registraria um erro que não foi erro.
    const settings = new NullSettingsRepository({ audience: 'all' })
    const { provider } = setupWithSettings(settings)
    const session = await provider.createSession({ agentId: 'researcher-agent' })

    await settings.save({ audience: 'off' })

    await assert.doesNotReject(() => drain(provider.sendMessage(session.id, { text: 'hi' })))
  })

  it('picks up a settings change without a restart', async () => {
    // ⚖️ É o `subscribe` fazendo efeito: sem ele, a alteração só valeria depois de um cache expirar.
    const settings = new NullSettingsRepository({ audience: 'all' })
    const { provider } = setupWithSettings(settings)

    await assert.doesNotReject(() => provider.createSession({ agentId: 'researcher-agent' }))

    await settings.save({ audience: 'off' })

    await assert.rejects(() => provider.createSession({ agentId: 'researcher-agent' }), AgentUnavailableError)
  })

  it('lets the configured agent answer when the caller did not pick one', async () => {
    // ⚠️ A REGRESSÃO: enquanto `agentId` era obrigatório no transporte, este caminho era inalcançável
    // — trocava-se o agente na configuração e a conversa continuava no mesmo, sem nada avisar. E o
    // tipo não denunciava: `input.agentId ?? settings.agentId` compila quando o primeiro nunca falta.
    const { provider } = setupWithSettings(new NullSettingsRepository({ audience: 'all', agentId: 'researcher-agent' }))

    const session = await provider.createSession({})

    assert.strictEqual(provider.describe(session.id).agentId, 'researcher-agent')
  })

  it('lets the caller override the configured agent', async () => {
    // Quem chama a API direto para comparar dois providers continua mandando no que quer.
    const { provider } = setupWithSettings(new NullSettingsRepository({ audience: 'all', agentId: 'researcher-agent' }))

    const session = await provider.createSession({ agentId: 'sysops-agent' })

    assert.strictEqual(provider.describe(session.id).agentId, 'sysops-agent')
    assert.strictEqual(provider.describe(session.id).provider, EProvider.CLAUDE)
  })
  it('treats a stored `enabled: false` as off, so an agent recalled before the upgrade stays recalled', async () => {
    const stored = normalizeSettings({ enabled: false })
    const { provider } = setupWithSettings(new NullSettingsRepository(stored))

    await assert.rejects(() => provider.createSession({ agentId: 'researcher-agent' }), AgentUnavailableError)
  })

  it('does not decide `restricted` itself: that needs the proven identity, which the controller resolves', async () => {
    const { provider } = setupWithSettings(new NullSettingsRepository({ audience: 'restricted' }))

    await assert.doesNotReject(() => provider.createSession({ agentId: 'researcher-agent' }))
  })

  it("resolves the model: body, then settings, then the agent's default", async () => {
    const { provider } = setupWithSettings(new NullSettingsRepository({ audience: 'all', agentId: 'researcher-agent', model: 'gemini-3.6-flash' }))

    assert.strictEqual(provider.describe((await provider.createSession({})).id).model, 'gemini-3.6-flash')
    assert.strictEqual(provider.describe((await provider.createSession({ model: 'gemini-3.1-pro-preview' })).id).model, 'gemini-3.1-pro-preview')

    const bare = setupWithSettings(new NullSettingsRepository({ audience: 'all', agentId: 'researcher-agent' }))
    assert.strictEqual(bare.provider.describe((await bare.provider.createSession({})).id).model, 'gemini-3.7-flash')
  })

  it('does not ship the configured model of one provider to another agent', async () => {
    // A regressão: trocar o agente para o Claude com um modelo do Google gravado quebrava a sessão.
    const { provider } = setupWithSettings(new NullSettingsRepository({ audience: 'all', model: 'gemini-3.6-flash' }))

    const session = await provider.createSession({ agentId: 'sysops-agent' })

    assert.strictEqual(provider.describe(session.id).model, 'claude-sonnet-5')
  })
})
