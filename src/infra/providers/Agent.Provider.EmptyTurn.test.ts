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

type TScript = (sessionId: string) => IAgentEvent[]

async function turnOf(script: TScript): Promise<IAgentEvent[]> {
  const agent: IAgent = { id: 'vera', name: 'Vera', providers: [{ provider: 'claude', models: ['claude-sonnet-5'] }], systemPrompt: 'p', modes: [EMode.CHAT], allowedTools: [] }
  const store = new SessionStore()
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
    async *sendMessage(_agent, sessionId): AsyncIterable<IAgentEvent> {
      yield* script(sessionId)
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
  const session = await provider.createSession({ agentId: 'vera' })
  const events: IAgentEvent[] = []
  for await (const event of provider.sendMessage(session.id, { text: 'rode os testes' })) events.push(event)
  return events
}

const at = new Date()
const failed = (sessionId: string): IAgentEvent[] => [
  { type: 'tool.started', sessionId, timestamp: at, payload: { tool: 'run_bash', args: {} } },
  { type: 'tool.error', sessionId, timestamp: at, payload: { tool: 'run_bash', message: 'Exit code 127: sh: vitest: not found' } },
]
const completed = (sessionId: string): IAgentEvent => ({ type: 'message.completed', sessionId, timestamp: at })
const gatewayText = (events: IAgentEvent[]) => events.filter((event) => event.type === 'text.delta' && event.payload.text.startsWith('[gateway]'))

/** ⛔ O turno que acaba vazio depois de uma ferramenta que falhou, em qualquer lane: o gateway fecha com o que falhou. */
describe('AgentProvider — turno vazio depois de ferramenta que falhou', () => {
  it('⛔ sem texto do agente: o resumo do gateway entra antes do fim', async () => {
    const events = await turnOf((id) => [...failed(id), completed(id)])
    const texts = gatewayText(events)
    assert.strictEqual(texts.length, 1)
    assert.match(JSON.stringify(texts[0].payload), /Parou em `run_bash`: Exit code 127: sh: vitest: not found\./)
    assert.strictEqual(events.at(-1)?.type, 'message.completed')
  })

  it('com texto do agente, ou a última ferramenta deu certo: nada do gateway', async () => {
    const spoke = await turnOf((id) => [...failed(id), { type: 'text.delta', sessionId: id, timestamp: at, payload: { text: 'O vitest não está instalado.' } }, completed(id)])
    assert.strictEqual(gatewayText(spoke).length, 0)
    const recovered = await turnOf((id) => [
      ...failed(id),
      { type: 'tool.started', sessionId: id, timestamp: at, payload: { tool: 'run_bash', args: {} } },
      { type: 'tool.result', sessionId: id, timestamp: at, payload: { tool: 'run_bash', result: 'ok' } },
      completed(id),
    ])
    assert.strictEqual(gatewayText(recovered).length, 0)
  })
})
