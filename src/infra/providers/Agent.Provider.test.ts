import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { AdapterNotFoundError, AgentNotFoundError, AgentUnavailableError, ModeNotSupportedError, SessionNotFoundError, ToolsNotSupportedError } from '@domain/errors/Domain.Error'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { withCaller } from '@infra/mcp/Caller.Identity'
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

    const provider = new AgentProvider(
      new Map([
        [adapterKey(EProvider.GOOGLE, EMode.CHAT), chat.adapter],
        [adapterKey(EProvider.GOOGLE, EMode.AGENT), agent.adapter],
      ]),
      store,
      settings,
    )

    return { provider, chat, agent }
  }

  const drain = async (stream: AsyncIterable<IAgentEvent>) => {
    const collected: IAgentEvent[] = []
    for await (const event of stream) collected.push(event)
    return collected
  }

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
    assert.deepStrictEqual(record.usage, { inputTokens: 8, outputTokens: 12, reasoningTokens: undefined })
    assert.strictEqual(record.status, 'idle')
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

  it('refuses a new session while disabled, and says it is unavailable — not missing', async () => {
    const { provider } = setupWithSettings(new NullSettingsRepository({ enabled: false }))

    await assert.rejects(() => provider.createSession({ agentId: 'researcher-agent' }), AgentUnavailableError)
  })

  it('lets a conversation already open finish its turn after being disabled', async () => {
    // ⛔ Fechar impede sessão NOVA. Matar o turno em curso deixaria meia resposta na tela e
    // registraria um erro que não foi erro.
    const settings = new NullSettingsRepository({ enabled: true })
    const { provider } = setupWithSettings(settings)
    const session = await provider.createSession({ agentId: 'researcher-agent' })

    await settings.save({ enabled: false })

    await assert.doesNotReject(() => drain(provider.sendMessage(session.id, { text: 'hi' })))
  })

  it('picks up a settings change without a restart', async () => {
    // ⚖️ É o `subscribe` fazendo efeito: sem ele, a alteração só valeria depois de um cache expirar.
    const settings = new NullSettingsRepository({ enabled: true })
    const { provider } = setupWithSettings(settings)

    await assert.doesNotReject(() => provider.createSession({ agentId: 'researcher-agent' }))

    await settings.save({ enabled: false })

    await assert.rejects(() => provider.createSession({ agentId: 'researcher-agent' }), AgentUnavailableError)
  })
})
