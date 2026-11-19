import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { ModelDisabledError } from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { SessionStore } from '@infra/session/Session.Store'
import { adapterKey, AgentProvider } from './Agent.Provider'

/**
 * 🔐 Os modelos do projeto e da pessoa (ver `ModelAccess.Policy`) valem na EXECUÇÃO: a conversa nova nasce num modelo que
 * a pessoa pode usar, o pedido fora disso é recusado, a troca também, e o modelo tirado no meio da conversa sai no turno.
 */
describe('AgentProvider — modelos liberados ao projeto e à pessoa', () => {
  const agent: IAgent = {
    id: 'zeus',
    name: 'Zeus',
    projectId: 'alfa',
    providers: [{ provider: EProvider.GOOGLE, models: ['gemini-pro', 'gemini-flash'] }],
    systemPrompt: 'Você orquestra.',
    modes: [EMode.CHAT],
    allowedTools: [],
  }

  function setup(allowed: () => string[] | undefined) {
    const store = new SessionStore()
    const turns: string[] = []
    const adapter: IAgentAdapter = {
      async createSession(current, input) {
        const record = store.create({
          agentId: current.id,
          provider: EProvider.GOOGLE,
          protocol: EProvider.GOOGLE,
          mode: EMode.CHAT,
          model: input.model ?? 'x',
          tools: false,
          systemPrompt: '',
          metadata: input.metadata,
        })
        return { id: record.id, provider: EProvider.GOOGLE, mode: record.mode, createdAt: record.createdAt }
      },
      async *sendMessage(_agent, sessionId) {
        turns.push(store.get(sessionId)!.model)
        yield { type: 'message.completed', sessionId, timestamp: new Date() } as IAgentEvent
      },
      async cancel() {},
    }
    const agents = { list: () => [agent], get: (id: string) => (id === agent.id ? agent : undefined) }
    const provider = new AgentProvider(new Map([[adapterKey(EProvider.GOOGLE, EMode.CHAT), adapter]]), store, undefined, agents)
    const asked: Array<[string | undefined, string | undefined]> = []
    provider.useModelAccess((projectId, ownerId) => {
      asked.push([projectId, ownerId])
      const list = allowed()
      return projectId === 'alfa' && list ? (p, m) => list.includes(`${p}/${m}`) : undefined
    })
    return { provider, store, turns, asked }
  }
  const meta = { project: 'alfa', owner: { id: 'u_ana' } }

  it('sem escolha, nasce no primeiro modelo que a pessoa pode usar; o filtro recebe o projeto e a dona da conversa', async () => {
    const { provider, asked, store } = setup(() => ['google/gemini-flash'])
    const session = await provider.createSession({ agentId: 'zeus', metadata: meta })
    assert.strictEqual(store.get(session.id)?.model, 'gemini-flash')
    assert.deepStrictEqual(asked.at(-1), ['alfa', 'u_ana'])
  })

  it('⛔ pedir modelo fora do que a pessoa pode é recusado; trocar para ele também', async () => {
    const { provider } = setup(() => ['google/gemini-flash'])
    await assert.rejects(provider.createSession({ agentId: 'zeus', provider: EProvider.GOOGLE, model: 'gemini-pro', metadata: meta }), ModelDisabledError)
    const session = await provider.createSession({ agentId: 'zeus', metadata: meta })
    assert.throws(() => provider.reconfigure(session.id, { model: 'gemini-pro' }), /not offered by zeus/)
  })

  it('o modelo tirado do projeto no meio da conversa sai no turno seguinte, com aviso', async () => {
    let list = ['google/gemini-pro', 'google/gemini-flash']
    const { provider, turns } = setup(() => list)
    const session = await provider.createSession({ agentId: 'zeus', provider: EProvider.GOOGLE, model: 'gemini-pro', metadata: meta })
    list = ['google/gemini-flash']
    const events: IAgentEvent[] = []
    for await (const event of provider.sendMessage(session.id, { text: 'oi' })) events.push(event)
    assert.deepStrictEqual(turns, ['gemini-flash'])
    assert.ok(events.some((event) => event.type === 'warning' && /não está mais disponível; a conversa segue em google · gemini-flash/.test(JSON.stringify(event.payload))))
  })

  it('⚖️ projeto sem lista: tudo como antes', async () => {
    const { provider, store } = setup(() => undefined)
    const session = await provider.createSession({ agentId: 'zeus', provider: EProvider.GOOGLE, model: 'gemini-pro', metadata: meta })
    assert.strictEqual(store.get(session.id)?.model, 'gemini-pro')
  })
})
