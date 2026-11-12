import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { SessionStore } from '@infra/session/Session.Store'
import { adapterKey, AgentProvider } from './Agent.Provider'

/** A delegação cortada pelo cliente do modelo (o "interrupted" do CLI): o agente fica sabendo que a conversa segue. */
describe('AgentProvider — delegação cortada pelo cliente do modelo', () => {
  it('⚖️ o "interrupted" no talk põe o aviso no turno: a outra conversa segue e a resposta chega aqui', async () => {
    const agent: IAgent = { id: 'maya', name: 'Maya', providers: [{ provider: 'claude', models: ['claude-sonnet-5'] }], systemPrompt: 'p', modes: [EMode.CHAT], allowedTools: [] }
    const store = new SessionStore()
    const seen: string[] = []
    const adapter: IAgentAdapter = {
      async createSession(created, input) {
        const record = store.create({
          agentId: created.id,
          provider: input.provider!,
          protocol: EProvider.CLAUDE,
          mode: EMode.CHAT,
          model: input.model!,
          tools: false,
          systemPrompt: 'p',
        })
        return { id: record.id, provider: EProvider.CLAUDE, mode: record.mode, createdAt: record.createdAt }
      },
      async *sendMessage(_agent, sessionId, input): AsyncIterable<IAgentEvent> {
        seen.push(input.text)
        if (seen.length === 1) {
          yield { type: 'tool.started', sessionId, timestamp: new Date(), payload: { tool: 'talk', args: {} } }
          yield {
            type: 'tool.error',
            sessionId,
            timestamp: new Date(),
            payload: { tool: 'talk', message: 'The tool call was interrupted before a result was received.' },
          }
        }
        yield { type: 'message.completed', sessionId, timestamp: new Date() }
      },
      async cancel() {},
    }
    const provider = new AgentProvider(
      new Map([[adapterKey(EProvider.CLAUDE, EMode.CHAT), adapter]]),
      store,
      new NullSettingsRepository({ audience: 'all' }),
      { list: () => [agent], get: (id) => (id === agent.id ? agent : undefined) },
      {
        list: () => [],
        get: (id) => (id === 'claude' ? { id, name: id, protocol: EProvider.CLAUDE, official: true, enabled: true, createdAt: new Date(), updatedAt: new Date() } : undefined),
        connection: (id) => (id === 'claude' ? { providerId: id, name: id, protocol: EProvider.CLAUDE, key: 'k' } : undefined),
      },
    )
    await new Promise((resolve) => setImmediate(resolve))
    const session = await provider.createSession({ agentId: 'maya' })
    const events: IAgentEvent[] = []
    for await (const event of provider.sendMessage(session.id, { text: 'delegue ao Zeus' })) events.push(event)

    // O aviso entra no MESMO turno (a rodada a mais com a fila), e aparece como mensagem injetada.
    assert.strictEqual(seen.length, 2)
    assert.match(seen[1], /conversa com o outro agente CONTINUA no gateway/)
    assert.ok(events.some((event) => event.type === 'message.injected' && /CONTINUA no gateway/.test(event.payload.text)))
  })
})
