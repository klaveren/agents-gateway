import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import {
  AdapterNotFoundError,
  AgentNotFoundError,
  AgentUnavailableError,
  InvalidSessionChangeError,
  ModelDisabledError,
  NoAgentAvailableError,
  ModeNotSupportedError,
  ProviderNotOfferedError,
  SessionBusyError,
  SessionNotFoundError,
  AgentAdminOnlyError,
  ConversationNotResumableError,
  SubagentOnlyError,
  ToolsNotSupportedError,
} from '@domain/errors/Domain.Error'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { withCaller } from '@infra/mcp/Caller.Identity'
import { normalizeSettings } from '@domain/models/Settings.Model'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { SessionStore } from '@infra/session/Session.Store'
import { TEST_AGENT_DIRECTORY } from '../../testing/Agents.Fixture'
import { adapterKey, AgentProvider } from './Agent.Provider'

/** Os agentes de teste como diretório: no teste, eles fazem o papel do banco. */
const SEED = TEST_AGENT_DIRECTORY

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
      undefined,
      SEED,
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
      SEED,
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
    const created = {
      id: 'juridico',
      name: 'Jurídico',
      providers: [{ provider: EProvider.GOOGLE, models: ['gemini-3.7-flash'] }],
      systemPrompt: 'p',
      modes: [EMode.CHAT],
      allowedTools: [],
    }
    const provider = new AgentProvider(new Map([[adapterKey(EProvider.GOOGLE, EMode.CHAT), chat.adapter]]), store, undefined, {
      list: () => [created],
      get: (id) => (id === created.id ? created : undefined),
    })

    const session = await provider.createSession({ agentId: 'juridico' })

    assert.strictEqual(session.mode, EMode.CHAT)
    assert.deepStrictEqual(chat.calls, ['createSession'])
    await assert.rejects(provider.createSession({ agentId: 'pesquisa-teste' }), /pesquisa-teste/)
  })

  it('routes an agent on a compatible provider (OpenRouter speaking OpenAI) to the OpenAI adapter; a disabled provider opens nothing', async () => {
    const store = new SessionStore()
    const openai = spyAdapter(store, EProvider.OPENAI, EMode.CHAT, [])
    const agent = {
      id: 'roteado',
      name: 'Roteado',
      providers: [{ provider: 'openrouter', models: ['meta-llama/llama-4'] }],
      systemPrompt: 'p',
      modes: [EMode.CHAT],
      allowedTools: [],
    }
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
    const empty = { id: 'vazio', name: 'Vazio', providers: [{ provider: 'google', models: [] }], systemPrompt: 'p', modes: [EMode.CHAT], allowedTools: [] }
    const provider = new AgentProvider(new Map([[adapterKey(EProvider.GOOGLE, EMode.CHAT), chat.adapter]]), store, undefined, { list: () => [empty], get: () => empty })

    await assert.rejects(provider.createSession({ agentId: 'vazio' }), /Providers → Models/)
    assert.deepStrictEqual(chat.calls, [])
  })

  it('⛔ modelo pedido que o agente não oferece: model_disabled, e não a troca muda pelo primeiro', async () => {
    const store = new SessionStore()
    const chat = spyAdapter(store, EProvider.GOOGLE, EMode.CHAT, [])
    const agent = { id: 'm', name: 'M', providers: [{ provider: 'google', models: ['gemini-a', 'gemini-b'] }], systemPrompt: 'p', modes: [EMode.CHAT], allowedTools: [] }
    const provider = new AgentProvider(new Map([[adapterKey(EProvider.GOOGLE, EMode.CHAT), chat.adapter]]), store, undefined, { list: () => [agent], get: () => agent })

    await assert.rejects(provider.createSession({ agentId: 'm', model: 'gemini-z' }), ModelDisabledError)
    assert.deepStrictEqual(chat.calls, [])
  })

  it('⛔ modelo da conversa desativado no meio dela: a mensagem seguinte é model_disabled', async () => {
    const store = new SessionStore()
    const chat = spyAdapter(store, EProvider.GOOGLE, EMode.CHAT, [])
    const agent = { id: 'm', name: 'M', providers: [{ provider: 'google', models: ['gemini-a', 'gemini-b'] }], systemPrompt: 'p', modes: [EMode.CHAT], allowedTools: [] }
    const provider = new AgentProvider(new Map([[adapterKey(EProvider.GOOGLE, EMode.CHAT), chat.adapter]]), store, undefined, { list: () => [agent], get: () => agent })

    const session = await provider.createSession({ agentId: 'm', model: 'gemini-b' })
    agent.providers[0].models = ['gemini-a']

    await assert.rejects(drain(provider.sendMessage(session.id, { text: 'oi' })), ModelDisabledError)
    assert.deepStrictEqual(chat.calls, ['createSession'])
  })

  it('sem agente pedido e sem nenhum ativo: nenhum agente disponível', async () => {
    const provider = new AgentProvider(new Map(), new SessionStore(), undefined, { list: () => [], get: () => undefined, fallback: () => undefined })

    await assert.rejects(provider.createSession({}), NoAgentAvailableError)
  })

  it('⛔ agente de assinatura: só com acesso de administrador, e cai na lane agent sem pedir', async () => {
    const store = new SessionStore()
    const lane = spyAdapter(store, EProvider.CODEX, EMode.AGENT, [])
    const codex = { id: 'cx', name: 'Cx', providers: [{ provider: 'codex', models: ['gpt-6.1-sol'] }], systemPrompt: 'p', modes: [EMode.AGENT], allowedTools: [] }
    const directory = {
      get: (id: string) =>
        id === 'codex' ? { id, name: 'ChatGPT', protocol: EProvider.CODEX, official: true, enabled: true, createdAt: new Date(), updatedAt: new Date() } : undefined,
      list: () => [],
    }
    const provider = new AgentProvider(
      new Map([[adapterKey(EProvider.CODEX, EMode.AGENT), lane.adapter]]),
      store,
      undefined,
      { list: () => [codex], get: () => codex },
      directory as never,
    )

    // ⚖️ Assinatura não fecha o agente: quem não administra conversa com ele.
    const session = await provider.createSession({ agentId: 'cx' })
    assert.strictEqual(session.mode, EMode.AGENT)
    assert.deepStrictEqual(lane.calls, ['createSession'])
  })

  it('⛔ subagente: conversa direta é recusada; pela delegação, abre', async () => {
    const store = new SessionStore()
    const lane = spyAdapter(store, EProvider.GOOGLE, EMode.CHAT, [])
    const sub = {
      id: 'tradutor',
      name: 'Tradutor',
      providers: [{ provider: 'google', models: ['gemini-x'] }],
      systemPrompt: 'p',
      modes: [EMode.CHAT],
      allowedTools: [],
      role: 'subagent' as const,
    }
    const provider = new AgentProvider(new Map([[adapterKey(EProvider.GOOGLE, EMode.CHAT), lane.adapter]]), store, undefined, { list: () => [sub], get: () => sub })

    await assert.rejects(provider.createSession({ agentId: 'tradutor' }), SubagentOnlyError)
    assert.deepStrictEqual(lane.calls, [])
    await provider.createSession({ agentId: 'tradutor', delegated: true })
    assert.deepStrictEqual(lane.calls, ['createSession'])
  })

  it('defaults to the chat lane when no mode is given', async () => {
    const { provider, chat, agent } = setup()
    const session = await provider.createSession({ agentId: 'pesquisa-teste' })

    assert.strictEqual(session.mode, EMode.CHAT)
    assert.deepStrictEqual(chat.calls, ['createSession'])
    assert.deepStrictEqual(agent.calls, [])
  })

  it('routes the turn by the session itself, with no agentId from the caller', async () => {
    const { provider, chat, agent } = setup()
    const session = await provider.createSession({ agentId: 'pesquisa-teste', mode: EMode.AGENT })

    await drain(provider.sendMessage(session.id, { text: 'hi' }))
    await provider.cancel(session.id)

    assert.deepStrictEqual(agent.calls, ['createSession', 'sendMessage', 'cancel'])
    assert.deepStrictEqual(chat.calls, [])
    assert.strictEqual(agent.seenSessionId, session.id)
  })

  it('counts turns and accumulates usage in one place for every lane', async () => {
    const usage: IAgentEvent[] = [{ type: 'usage', sessionId: 'x', timestamp: new Date(), payload: { inputTokens: 4, outputTokens: 6 } }]
    const { provider } = setup(usage)
    const session = await provider.createSession({ agentId: 'pesquisa-teste' })

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
        providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-5', 'claude-opus-5'] }],
        systemPrompt: 'p',
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
        'claude|claude-sonnet-5': { inputTokens: 10, outputTokens: 1 },
        'claude|claude-opus-5': { inputTokens: 10, outputTokens: 1 },
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
      const session = await provider.createSession({ agentId: 'pesquisa-teste' })

      assert.throws(() => provider.reconfigure(session.id, { reasoning: 'low' }), InvalidSessionChangeError)
      assert.strictEqual(provider.reconfigure(session.id, { model: 'gemini-3.6-flash' }).model, 'gemini-3.6-flash')

      store.get(session.id)!.status = 'running'
      assert.throws(() => provider.reconfigure(session.id, { model: 'gemini-3.7-flash' }), SessionBusyError)
    })
  })

  it('lists and disposes sessions', async () => {
    const { provider } = setup()
    const session = await provider.createSession({ agentId: 'pesquisa-teste' })

    assert.strictEqual(provider.list().length, 1)

    await provider.dispose(session.id)

    assert.strictEqual(provider.list().length, 0)
    await assert.rejects(provider.dispose(session.id), SessionNotFoundError)
  })

  it('rejects a lane the agent does not declare', async () => {
    const { provider } = setup()

    await assert.rejects(provider.createSession({ agentId: 'pesquisa-teste', mode: 'telepathy' as EMode }), ModeNotSupportedError)
  })

  it('refuses the manual tool loop outside the chat lane', async () => {
    const { provider } = setup()

    // Na lane agent quem conduz o loop é o SDK; ligar o nosso por cima seria pedir duas
    // orquestrações para o mesmo turno.
    await assert.rejects(provider.createSession({ agentId: 'pesquisa-teste', mode: EMode.AGENT, tools: true }), ToolsNotSupportedError)

    const allowed = await provider.createSession({ agentId: 'pesquisa-teste', tools: true })
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
    const provider = new AgentProvider(new Map(), store, undefined, SEED)

    await assert.rejects(provider.createSession({ agentId: 'pesquisa-teste' }), AdapterNotFoundError)
  })

  it('resolves the caller credential once, in the provider, and hands it to the adapter', async () => {
    const { provider, chat } = setup()
    const session = await provider.createSession({ agentId: 'pesquisa-teste' })

    await withCaller({ token: 'do-usuario' }, () => drain(provider.sendMessage(session.id, { text: 'hi' })))

    assert.strictEqual(chat.seenToken, 'do-usuario')
  })

  it('hands the adapter no credential when the request carried none', async () => {
    // ⛔ Falha aberta é o risco aqui: sem credencial a chamada segue, e é o MCP que decide. O que
    // não pode é ela aparecer com a credencial de outra pessoa.
    const { provider, chat } = setup()
    const session = await provider.createSession({ agentId: 'pesquisa-teste' })

    await drain(provider.sendMessage(session.id, { text: 'hi' }))

    assert.strictEqual(chat.seenToken, undefined)
  })

  it('refuses a new session while the audience is off, and says it is unavailable — not missing', async () => {
    const { provider } = setupWithSettings(new NullSettingsRepository({ audience: 'off' }))

    await assert.rejects(() => provider.createSession({ agentId: 'pesquisa-teste' }), AgentUnavailableError)
  })

  it('lets a conversation already open finish its turn after the audience closes', async () => {
    // ⛔ Fechar impede sessão NOVA. Matar o turno em curso deixaria meia resposta na tela e
    // registraria um erro que não foi erro.
    const settings = new NullSettingsRepository({ audience: 'all' })
    const { provider } = setupWithSettings(settings)
    const session = await provider.createSession({ agentId: 'pesquisa-teste' })

    await settings.save({ audience: 'off' })

    await assert.doesNotReject(() => drain(provider.sendMessage(session.id, { text: 'hi' })))
  })

  it('picks up a settings change without a restart', async () => {
    // ⚖️ É o `subscribe` fazendo efeito: sem ele, a alteração só valeria depois de um cache expirar.
    const settings = new NullSettingsRepository({ audience: 'all' })
    const { provider } = setupWithSettings(settings)

    await assert.doesNotReject(() => provider.createSession({ agentId: 'pesquisa-teste' }))

    await settings.save({ audience: 'off' })

    await assert.rejects(() => provider.createSession({ agentId: 'pesquisa-teste' }), AgentUnavailableError)
  })

  it('lets the configured agent answer when the caller did not pick one', async () => {
    // ⚠️ A REGRESSÃO: enquanto `agentId` era obrigatório no transporte, este caminho era inalcançável
    // — trocava-se o agente na configuração e a conversa continuava no mesmo, sem nada avisar. E o
    // tipo não denunciava: `input.agentId ?? settings.agentId` compila quando o primeiro nunca falta.
    const { provider } = setupWithSettings(new NullSettingsRepository({ audience: 'all', agentId: 'pesquisa-teste' }))

    const session = await provider.createSession({})

    assert.strictEqual(provider.describe(session.id).agentId, 'pesquisa-teste')
  })

  it('⚖️ ferramenta que alcança o servidor (run_bash) não fecha o agente: quem decide é quem o criou', async () => {
    const { provider } = setupWithSettings(new NullSettingsRepository({ audience: 'all', agentId: 'pesquisa-teste' }))

    const session = await provider.createSession({ agentId: 'operador-teste' })
    assert.strictEqual(provider.describe(session.id).agentId, 'operador-teste')
  })

  it('⛔ agente marcado só para admin: recusa quem não administra; a filha herda da mãe', async () => {
    const store = new SessionStore()
    const lane = spyAdapter(store, EProvider.CLAUDE, EMode.AGENT, [])
    const closed = {
      id: 'fechado',
      name: 'F',
      providers: [{ provider: 'claude', models: ['claude-sonnet-5'] }],
      systemPrompt: 'p',
      modes: [EMode.AGENT],
      allowedTools: [],
      adminOnly: true,
    }
    const provider = new AgentProvider(new Map([[adapterKey(EProvider.CLAUDE, EMode.AGENT), lane.adapter]]), store, undefined, { list: () => [closed], get: () => closed })

    await assert.rejects(provider.createSession({ agentId: 'fechado' }), AgentAdminOnlyError)
    await assert.rejects(provider.createSession({ agentId: 'fechado', delegated: true, parentSessionId: 'qualquer' }), AgentAdminOnlyError)
    assert.deepStrictEqual(lane.calls, [])

    const parent = await provider.createSession({ agentId: 'fechado', adminAccess: true })
    const child = await provider.createSession({ agentId: 'fechado', delegated: true, parentSessionId: parent.id })
    assert.strictEqual(provider.describe(child.id).agentId, 'fechado')
  })

  it('lets the caller override the configured agent', async () => {
    // Quem chama a API direto para comparar dois providers continua mandando no que quer.
    const { provider } = setupWithSettings(new NullSettingsRepository({ audience: 'all', agentId: 'pesquisa-teste' }))

    const session = await provider.createSession({ agentId: 'operador-teste', adminAccess: true })

    assert.strictEqual(provider.describe(session.id).agentId, 'operador-teste')
    assert.strictEqual(provider.describe(session.id).provider, EProvider.CLAUDE)
  })
  it('treats a stored `enabled: false` as off, so an agent recalled before the upgrade stays recalled', async () => {
    const stored = normalizeSettings({ enabled: false })
    const { provider } = setupWithSettings(new NullSettingsRepository(stored))

    await assert.rejects(() => provider.createSession({ agentId: 'pesquisa-teste' }), AgentUnavailableError)
  })

  it('does not decide `restricted` itself: that needs the proven identity, which the controller resolves', async () => {
    const { provider } = setupWithSettings(new NullSettingsRepository({ audience: 'restricted' }))

    await assert.doesNotReject(() => provider.createSession({ agentId: 'pesquisa-teste' }))
  })

  it("resolves the model: body, then settings, then the agent's default", async () => {
    const { provider } = setupWithSettings(new NullSettingsRepository({ audience: 'all', agentId: 'pesquisa-teste', model: 'gemini-3.6-flash' }))

    assert.strictEqual(provider.describe((await provider.createSession({})).id).model, 'gemini-3.6-flash')
    assert.strictEqual(provider.describe((await provider.createSession({ model: 'gemini-3.1-pro-preview' })).id).model, 'gemini-3.1-pro-preview')

    const bare = setupWithSettings(new NullSettingsRepository({ audience: 'all', agentId: 'pesquisa-teste' }))
    assert.strictEqual(bare.provider.describe((await bare.provider.createSession({})).id).model, 'gemini-3.7-flash')
  })

  it('does not ship the configured model of one provider to another agent', async () => {
    // A regressão: trocar o agente para o Claude com um modelo do Google gravado quebrava a sessão.
    const { provider } = setupWithSettings(new NullSettingsRepository({ audience: 'all', model: 'gemini-3.6-flash' }))

    const session = await provider.createSession({ agentId: 'operador-teste', adminAccess: true })

    assert.strictEqual(provider.describe(session.id).model, 'claude-sonnet-5')
  })
})

describe('AgentProvider — agente com vários providers', () => {
  interface ISeen {
    provider: string
    text: string
    nativeBefore: unknown
  }

  /** Um agente em três providers: Claude e OpenAI pela API, Codex pela assinatura (só a lane agent). */
  const HYBRID = {
    id: 'hibrido',
    name: 'Híbrido',
    providers: [
      { provider: 'claude', models: ['claude-sonnet-5'] },
      { provider: 'openai', models: ['gpt-5.6-sol'] },
      { provider: 'codex', models: ['gpt-6.1-sol'] },
      { provider: 'semchave', models: ['gpt-x'] },
    ],
    systemPrompt: 'p',
    modes: [EMode.CHAT, EMode.AGENT],
    allowedTools: [],
  }
  const PROTOCOL: Record<string, EProvider> = { claude: EProvider.CLAUDE, openai: EProvider.OPENAI, codex: EProvider.CODEX, semchave: EProvider.OPENAI }

  function setup(options: { completes?: boolean; runnable?: (provider: string) => boolean } = {}) {
    const store = new SessionStore()
    const seen: ISeen[] = []
    const answer = (protocol: EProvider): IAgentAdapter => ({
      async createSession(agent, input) {
        const record = store.create(protocol, {
          agentId: agent.id,
          provider: input.provider!,
          protocol,
          mode: input.mode ?? EMode.CHAT,
          model: input.model!,
          reasoning: input.reasoning,
          tools: false,
          systemPrompt: agent.systemPrompt,
          native: { from: protocol },
        })
        return { id: record.id, provider: protocol, mode: record.mode, createdAt: record.createdAt }
      },
      async *sendMessage(_agent, sessionId, input) {
        const record = store.get(sessionId)!
        seen.push({ provider: record.provider, text: input.text, nativeBefore: record.native })
        record.native = { from: record.protocol }
        yield { type: 'text.delta', sessionId, timestamp: new Date(), payload: { text: `resposta de ${record.provider}` } }
        yield { type: 'tool.started', sessionId, timestamp: new Date(), payload: { tool: 'search_web', args: {} } }
        yield { type: 'usage', sessionId, timestamp: new Date(), payload: { inputTokens: 10, outputTokens: 1 } }
        if (options.completes !== false) yield { type: 'message.completed', sessionId, timestamp: new Date() }
      },
      async cancel() {},
    })
    const config = (id: string) =>
      PROTOCOL[id] ? { id, name: id, protocol: PROTOCOL[id], official: id === PROTOCOL[id], enabled: true, createdAt: new Date(), updatedAt: new Date() } : undefined
    const provider = new AgentProvider(
      new Map([
        [adapterKey(EProvider.CLAUDE, EMode.CHAT), answer(EProvider.CLAUDE)],
        [adapterKey(EProvider.CLAUDE, EMode.AGENT), answer(EProvider.CLAUDE)],
        [adapterKey(EProvider.OPENAI, EMode.CHAT), answer(EProvider.OPENAI)],
        [adapterKey(EProvider.CODEX, EMode.AGENT), answer(EProvider.CODEX)],
      ]),
      store,
      undefined,
      {
        list: () => [HYBRID],
        get: (id) => (id === HYBRID.id ? HYBRID : undefined),
        isTargetRunnable: (_agent, target) => options.runnable?.(target.provider) ?? true,
      },
      {
        list: () => [],
        get: config,
        connection: (id) => {
          const found = config(id)
          return found ? { providerId: id, name: id, protocol: found.protocol, ...(id === 'semchave' ? {} : { key: 'k' }) } : undefined
        },
      },
    )
    return { provider, store, seen }
  }

  const drain = async (stream: AsyncIterable<IAgentEvent>) => {
    for await (const _event of stream) void _event
  }

  it('abre no provider pedido; sem pedido, no padrão — pulando o que não roda agora', async () => {
    const { provider } = setup({ runnable: (id) => id !== 'claude' })

    assert.strictEqual(provider.describe((await provider.createSession({ agentId: 'hibrido', provider: 'claude' })).id).provider, 'claude')
    assert.strictEqual(provider.describe((await provider.createSession({ agentId: 'hibrido', model: 'gpt-5.6-sol' })).id).provider, 'openai')
    const fallback = provider.describe((await provider.createSession({ agentId: 'hibrido' })).id)
    assert.deepStrictEqual([fallback.provider, fallback.model], ['openai', 'gpt-5.6-sol'])

    await assert.rejects(provider.createSession({ agentId: 'hibrido', provider: 'google' }), ProviderNotOfferedError)
    await assert.rejects(provider.createSession({ agentId: 'hibrido', provider: 'claude', model: 'gpt-5.6-sol' }), ModelDisabledError)
  })

  it('assinatura abre na lane agent, mesmo com chat no agente', async () => {
    const { provider } = setup()
    const session = await provider.createSession({ agentId: 'hibrido', provider: 'codex', adminAccess: true })

    assert.strictEqual(provider.describe(session.id).mode, EMode.AGENT)
    await assert.rejects(provider.createSession({ agentId: 'hibrido', provider: 'codex', mode: EMode.CHAT, adminAccess: true }), ModeNotSupportedError)
  })

  it('troca de provider no meio: zera o estado nativo, leva a transcrição UMA vez e conta o uso por provider', async () => {
    const { provider, seen } = setup()
    const session = await provider.createSession({ agentId: 'hibrido', provider: 'openai', reasoning: 'none' })
    await drain(provider.sendMessage(session.id, { text: 'meu nome é Ana' }))

    const changed = provider.reconfigure(session.id, { provider: 'claude' })
    assert.deepStrictEqual([changed.provider, changed.model, changed.reasoning, changed.handoff], ['claude', 'claude-sonnet-5', undefined, true])

    await drain(provider.sendMessage(session.id, { text: 'qual é o meu nome?' }))
    await drain(provider.sendMessage(session.id, { text: 'e agora?' }))

    const [, handed, after] = seen
    assert.strictEqual(handed.provider, 'claude')
    assert.strictEqual(handed.nativeBefore, undefined)
    assert.match(handed.text, /Pessoa: meu nome é Ana/)
    assert.match(handed.text, /Assistente: resposta de openai/)
    assert.match(handed.text, /Ferramentas usadas: search_web/)
    assert.match(handed.text, /qual é o meu nome\?$/)
    assert.strictEqual(after.text, 'e agora?')
    assert.strictEqual(provider.describe(session.id).handoff, undefined)
    assert.deepStrictEqual(provider.describe(session.id).usageByModel, {
      'openai|gpt-5.6-sol': { inputTokens: 10, outputTokens: 1 },
      'claude|claude-sonnet-5': { inputTokens: 20, outputTokens: 2 },
    })
  })

  it('o turno que não concluiu no provider novo não dá o repasse por entregue: o próximo recomeça com a transcrição de agora', async () => {
    const { provider, seen } = setup({ completes: false })
    const session = await provider.createSession({ agentId: 'hibrido', provider: 'openai' })
    await drain(provider.sendMessage(session.id, { text: 'um' }))
    provider.reconfigure(session.id, { provider: 'claude' })

    await drain(provider.sendMessage(session.id, { text: 'dois' }))
    await drain(provider.sendMessage(session.id, { text: 'três' }))

    assert.match(seen[2].text, /Pessoa: um/)
    assert.match(seen[2].text, /Pessoa: dois/)
    assert.strictEqual(seen[2].nativeBefore, undefined)
  })

  it('⛔ recusa provider fora do agente, sem chave ou que não roda a lane; assinatura vale para todos', async () => {
    const { provider } = setup()
    const chat = await provider.createSession({ agentId: 'hibrido', provider: 'claude' })

    assert.throws(() => provider.reconfigure(chat.id, { provider: 'google' }), ProviderNotOfferedError)
    assert.throws(
      () => provider.reconfigure(chat.id, { provider: 'semchave' }),
      (error: InvalidSessionChangeError) => error instanceof InvalidSessionChangeError && /no API key/.test(error.message),
    )
    assert.throws(
      () => provider.reconfigure(chat.id, { provider: 'codex' }),
      (error: InvalidSessionChangeError) => error instanceof InvalidSessionChangeError && /agent lane|does not run the chat lane/.test(error.message),
    )
    assert.throws(() => provider.reconfigure(chat.id, { provider: 'openai', model: 'claude-sonnet-5' }), InvalidSessionChangeError)
    assert.strictEqual(provider.describe(chat.id).provider, 'claude')

    const lane = await provider.createSession({ agentId: 'hibrido', provider: 'claude', mode: EMode.AGENT })
    assert.strictEqual(provider.reconfigure(lane.id, { provider: 'codex' }).provider, 'codex')
  })
})

describe('AgentProvider — rules e documentos', () => {
  it('⚖️ o prompt recebe o ambiente do projeto DA CONVERSA, e o read_doc entra quando há documento', async () => {
    const store = new SessionStore()
    const seen: { environment?: string; created: string[]; turn: string[]; project?: string } = { created: [], turn: [] }
    const adapter: IAgentAdapter = {
      async createSession(agent, input) {
        seen.environment = input.environment
        seen.created = agent.allowedTools
        const record = store.create('g', {
          agentId: agent.id,
          provider: EProvider.GOOGLE,
          protocol: EProvider.GOOGLE,
          mode: EMode.CHAT,
          model: input.model ?? 'model-x',
          tools: false,
          systemPrompt: agent.systemPrompt,
          metadata: input.metadata,
        })
        return { id: record.id, provider: EProvider.GOOGLE, mode: record.mode, createdAt: record.createdAt }
      },
      async *sendMessage(agent, sessionId, _input, context) {
        seen.turn = agent.allowedTools
        seen.project = context?.conversationProjectId
        yield { type: 'message.completed', sessionId, timestamp: new Date() } as IAgentEvent
      },
      async cancel() {},
    }
    const asked: string[] = []
    const guidance = {
      environmentFor: (projectId?: string, agentId?: string) => (asked.push(`${projectId}/${agentId}`), `## Regras do ambiente\n1. **de ${projectId}**`),
      hasDocs: (projectId?: string) => projectId === 'xpto',
    }
    const provider = new AgentProvider(new Map([[adapterKey(EProvider.GOOGLE, EMode.CHAT), adapter]]), store, undefined, SEED, undefined, guidance)

    const session = await provider.createSession({ agentId: SEED.list()[0].id, environment: 'forjado pelo corpo', metadata: { project: 'xpto' } })
    for await (const _event of provider.sendMessage(session.id, { text: 'oi' })) void _event

    assert.deepStrictEqual(asked, [`xpto/${SEED.list()[0].id}`])
    assert.strictEqual(seen.environment, '## Regras do ambiente\n1. **de xpto**')
    assert.ok(seen.created.includes('read_doc') && seen.turn.includes('read_doc'))
    assert.ok(seen.created.includes('search_docs') && seen.turn.includes('search_docs'))
    assert.strictEqual(seen.project, 'xpto')

    await provider.createSession({ agentId: SEED.list()[0].id, metadata: { project: 'crm' } })
    assert.ok(!seen.created.includes('read_doc'))
  })
})

describe('AgentProvider — retomar a conversa gravada', () => {
  const agentId = SEED.list()[0].id
  const stored = {
    id: 'google-chat-antiga',
    agentId,
    provider: EProvider.GOOGLE,
    mode: EMode.CHAT,
    model: 'gemini-3.7-flash',
    createdAt: new Date(),
    updatedAt: new Date(),
    turns: 2,
    usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 },
    metadata: { owner: 'u_ana' },
  }
  const turns = [
    { sessionId: stored.id, index: 0, at: new Date(), request: 'Qual é a capital da França?', text: 'Paris.', toolCalls: [] },
    { sessionId: stored.id, index: 1, at: new Date(), request: 'E da Itália?', text: 'Roma.', toolCalls: [{ tool: 'search_web' }] },
  ]

  function build() {
    const store = new SessionStore()
    const sent: string[] = []
    const adapter: IAgentAdapter = {
      async createSession(agent, input) {
        const record = store.create('google-chat', {
          agentId: agent.id,
          provider: EProvider.GOOGLE,
          protocol: EProvider.GOOGLE,
          mode: EMode.CHAT,
          model: input.model ?? 'm',
          tools: false,
          systemPrompt: agent.systemPrompt,
          metadata: input.metadata,
        })
        return { id: record.id, provider: EProvider.GOOGLE, mode: record.mode, createdAt: record.createdAt }
      },
      async *sendMessage(_agent, sessionId, input) {
        sent.push(input.text)
        yield { type: 'usage', sessionId, timestamp: new Date(), payload: { inputTokens: 50, outputTokens: 5 } } as IAgentEvent
        yield { type: 'message.completed', sessionId, timestamp: new Date() } as IAgentEvent
      },
      async cancel() {},
    }
    const provider = new AgentProvider(new Map([[adapterKey(EProvider.GOOGLE, EMode.CHAT), adapter]]), store, undefined, SEED)
    return { provider, store, sent }
  }

  it('⚖️ volta com o MESMO id, leva a transcrição no próximo turno, e o consumo soma sobre o gravado', async () => {
    const { provider, store, sent } = build()
    await provider.resume({ session: stored, turns })

    const record = store.get(stored.id)!
    assert.deepStrictEqual([record.turns, record.usage.inputTokens, record.metadata?.owner], [2, 900, 'u_ana'])
    assert.strictEqual(store.size, 1, 'a sessão nova não fica sob outro id')

    for await (const _event of provider.sendMessage(stored.id, { text: 'E da Espanha?' })) void _event
    assert.match(
      sent[0],
      /^\[Contexto do sistema: esta conversa foi retomada[\s\S]*E da Itália\?[\s\S]*Ferramentas usadas: search_web[\s\S]*\[Fim da transcrição\. Mensagem nova:\]\n\nE da Espanha\?$/,
    )
    assert.deepStrictEqual([store.get(stored.id)!.turns, store.get(stored.id)!.usage.inputTokens], [3, 950])

    for await (const _event of provider.sendMessage(stored.id, { text: 'Obrigado' })) void _event
    assert.strictEqual(sent[1], 'Obrigado', 'a transcrição vai uma vez só')
  })

  it('sessão ainda viva: nada muda; ⛔ conversa de subagente e agente apagado não voltam', async () => {
    const { provider, store } = build()
    await provider.resume({ session: stored, turns })
    await provider.resume({ session: stored, turns })
    assert.strictEqual(store.size, 1)

    await assert.rejects(() => provider.resume({ session: { ...stored, id: 'filha', metadata: { delegatedBy: { sessionId: 'mae' } } }, turns }), ConversationNotResumableError)
    await assert.rejects(() => provider.resume({ session: { ...stored, id: 'orfa', agentId: 'nao-existe' }, turns }), AgentNotFoundError)
  })
})

describe('AgentProvider — retomar com a memória do SDK', () => {
  const agentId = SEED.list()[0].id
  const stored = {
    id: 'google-chat-com-memoria',
    agentId,
    provider: EProvider.GOOGLE,
    mode: EMode.CHAT,
    model: 'gemini-3.7-flash',
    createdAt: new Date(),
    updatedAt: new Date(),
    turns: 1,
    usage: { inputTokens: 10, outputTokens: 1 },
  }
  const turns = [{ sessionId: stored.id, index: 0, at: new Date(), request: 'Guarde o número 42.', text: 'Guardado.', toolCalls: [] }]

  function build(restores: boolean) {
    const store = new SessionStore()
    const sent: string[] = []
    const restored: unknown[] = []
    const adapter: IAgentAdapter = {
      async createSession(agent, input) {
        const record = store.create('google-chat', {
          agentId: agent.id,
          provider: EProvider.GOOGLE,
          protocol: EProvider.GOOGLE,
          mode: EMode.CHAT,
          model: input.model ?? 'm',
          tools: false,
          systemPrompt: '',
        })
        return { id: record.id, provider: EProvider.GOOGLE, mode: record.mode, createdAt: record.createdAt }
      },
      async *sendMessage(_agent, sessionId, input) {
        sent.push(input.text)
        store.get(sessionId)!.native = { memoria: 'viva' }
        yield { type: 'message.completed', sessionId, timestamp: new Date() } as IAgentEvent
      },
      async cancel() {},
      exportNative: (sessionId) => store.get(sessionId)?.native,
      restoreNative: (_sessionId, data) => (restored.push(data), restores),
    }
    const provider = new AgentProvider(new Map([[adapterKey(EProvider.GOOGLE, EMode.CHAT), adapter]]), store, undefined, SEED)
    return { provider, sent, restored }
  }

  it('⚖️ estado da mesma lane, e o adapter confirma: segue com a memória do SDK, SEM a transcrição', async () => {
    const { provider, sent, restored } = build(true)
    await provider.resume({ session: stored, turns, native: { protocol: EProvider.GOOGLE, mode: EMode.CHAT, data: { id: 'x' } } })
    for await (const _event of provider.sendMessage(stored.id, { text: 'Qual número?' })) void _event
    assert.deepStrictEqual([restored, sent], [[{ id: 'x' }], ['Qual número?']])
    assert.deepStrictEqual(provider.nativeSnapshot(stored.id), { protocol: EProvider.GOOGLE, mode: EMode.CHAT, data: { memoria: 'viva' } })
  })

  it('estado de outra lane, ou que não serve mais: a transcrição entra', async () => {
    const other = build(true)
    await other.provider.resume({ session: stored, turns, native: { protocol: EProvider.CLAUDE, mode: EMode.AGENT, data: {} } })
    for await (const _event of other.provider.sendMessage(stored.id, { text: 'Qual número?' })) void _event
    assert.deepStrictEqual(other.restored, [], 'de outra lane, nem se pergunta ao adapter')
    assert.match(other.sent[0], /esta conversa foi retomada[\s\S]*Guarde o número 42/)

    const stale = build(false)
    await stale.provider.resume({ session: stored, turns, native: { protocol: EProvider.GOOGLE, mode: EMode.CHAT, data: {} } })
    for await (const _event of stale.provider.sendMessage(stored.id, { text: 'Qual número?' })) void _event
    assert.match(stale.sent[0], /esta conversa foi retomada/)
  })
})
