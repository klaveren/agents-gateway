import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { SessionStore } from '@infra/session/Session.Store'
import { LoopGuard } from '@infra/tools/Loop.Guard'
import { adapterKey, AgentProvider } from './Agent.Provider'

/** O detector de laço no turno (ver `Loop.Policy`): o fluxo de eventos de qualquer lane para o turno. */
describe('AgentProvider — detector de laço', () => {
  function setup(calls: (index: number) => { args: Record<string, unknown>; error?: boolean }, total = 20) {
    const agent: IAgent = {
      id: 'teimoso',
      name: 'Teimoso',
      providers: [{ provider: 'claude', models: ['claude-sonnet-5'] }],
      systemPrompt: 'p',
      modes: [EMode.CHAT],
      allowedTools: [],
    }
    const store = new SessionStore()
    const state = { cancelled: 0, ran: 0 }
    const adapter: IAgentAdapter = {
      async createSession(created, input) {
        const record = store.create({
          agentId: created.id,
          provider: input.provider!,
          protocol: EProvider.CLAUDE,
          mode: EMode.CHAT,
          model: input.model!,
          tools: true,
          systemPrompt: created.systemPrompt,
        })
        return { id: record.id, provider: EProvider.CLAUDE, mode: record.mode, createdAt: record.createdAt }
      },
      async *sendMessage(_agent, sessionId): AsyncIterable<IAgentEvent> {
        for (let index = 0; index < total; index += 1) {
          const call = calls(index)
          state.ran += 1
          yield { type: 'tool.started', sessionId, timestamp: new Date(), payload: { tool: 'run_bash', args: call.args } }
          yield call.error
            ? { type: 'tool.error', sessionId, timestamp: new Date(), payload: { tool: 'run_bash', message: 'falhou' } }
            : { type: 'tool.result', sessionId, timestamp: new Date(), payload: { tool: 'run_bash', result: 'igual' } }
        }
        yield { type: 'text.delta', sessionId, timestamp: new Date(), payload: { text: 'pronto' } }
        yield { type: 'message.completed', sessionId, timestamp: new Date() }
      },
      async cancel() {
        state.cancelled += 1
      },
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
      undefined,
      new LoopGuard(() => ({ refuseAt: 4, stopAt: 6, maxErrors: 8 })),
    )
    return { provider, state }
  }

  const run = async (stream: AsyncIterable<IAgentEvent>) => {
    const events: IAgentEvent[] = []
    for await (const event of stream) events.push(event)
    return events
  }

  it('a 6ª chamada idêntica para o turno: aviso, interrompido, adapter cancelado', async () => {
    const { provider, state } = setup(() => ({ args: { command: 'cat x' } }))
    const session = await provider.createSession({ agentId: 'teimoso' })
    const events = await run(provider.sendMessage(session.id, { text: 'rode até mudar' }))

    assert.strictEqual(state.ran, 6)
    assert.strictEqual(state.cancelled, 1)
    const warning = events.find((event) => event.type === 'warning')
    assert.match(warning?.type === 'warning' ? warning.payload.message : '', /Laço: run_bash \{"command":"cat x"\} repetido 6 vezes; turno parado/)
    assert.strictEqual(events[events.length - 1].type, 'message.aborted')
    assert.ok(!events.some((event) => event.type === 'message.completed'))
    assert.strictEqual(provider.describe(session.id).status, 'idle')
  })

  it('8 erros seguidos param o turno; chamadas diferentes sem erro, não', async () => {
    const failing = setup((index) => ({ args: { command: `ls ${index}` }, error: true }))
    const one = await failing.provider.createSession({ agentId: 'teimoso' })
    const events = await run(failing.provider.sendMessage(one.id, { text: 'oi' }))
    assert.strictEqual(failing.state.ran, 8)
    assert.ok(events.some((event) => event.type === 'warning' && /8 erros de ferramenta seguidos/.test(event.payload.message)))

    const varied = setup((index) => ({ args: { command: `ls ${index}` } }))
    const two = await varied.provider.createSession({ agentId: 'teimoso' })
    const fine = await run(varied.provider.sendMessage(two.id, { text: 'oi' }))
    assert.ok(fine.some((event) => event.type === 'message.completed'))
    assert.ok(!fine.some((event) => event.type === 'warning'))
  })

  it('o turno seguinte começa do zero', async () => {
    const { provider, state } = setup(() => ({ args: { command: 'cat x' } }), 5)
    const session = await provider.createSession({ agentId: 'teimoso' })
    await run(provider.sendMessage(session.id, { text: 'um' }))
    const second = await run(provider.sendMessage(session.id, { text: 'dois' }))
    assert.strictEqual(state.ran, 10)
    assert.ok(second.some((event) => event.type === 'message.completed'))
  })
})
