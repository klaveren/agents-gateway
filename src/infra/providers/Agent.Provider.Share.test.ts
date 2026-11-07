import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { AgentNotFoundError } from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { SessionStore } from '@infra/session/Session.Store'
import { adapterKey, AgentProvider } from './Agent.Provider'

/**
 * ⛔ Agente COMPARTILHADO (ver `Share.Policy`): na conversa do projeto que o recebe, o adapter o vê como o agente GLOBAL naquele
 * projeto (sem o projeto de origem: a pasta, o cerco, as contas e os MCPs são os da conversa). Parou de compartilhar, a conversa
 * antiga não continua.
 */
describe('AgentProvider — agente compartilhado entre projetos', () => {
  const base: IAgent = {
    id: 'dev-alfa',
    name: 'Dev',
    projectId: 'alfa',
    sharedWith: ['beta'],
    providers: [{ provider: EProvider.GOOGLE, models: ['gemini-3.7-flash'] }],
    systemPrompt: 'Você escreve código.',
    modes: [EMode.CHAT],
    allowedTools: ['search_web'],
  }
  let current: IAgent = base

  function setup() {
    const store = new SessionStore()
    const seen: { created: IAgent[]; turn: IAgent[]; context: IExecutionContext[]; ambient: unknown[] } = { created: [], turn: [], context: [], ambient: [] }
    const adapter: IAgentAdapter = {
      async createSession(agent, input) {
        seen.created.push(agent)
        seen.ambient.push(input.ambient)
        const record = store.create({
          agentId: agent.id,
          provider: EProvider.GOOGLE,
          protocol: EProvider.GOOGLE,
          mode: EMode.CHAT,
          model: input.model ?? 'gemini-3.7-flash',
          tools: false,
          systemPrompt: agent.systemPrompt,
          metadata: input.metadata,
        })
        return { id: record.id, provider: EProvider.GOOGLE, mode: record.mode, createdAt: record.createdAt }
      },
      async *sendMessage(agent, sessionId, _input, context) {
        seen.turn.push(agent)
        if (context) seen.context.push(context)
        yield { type: 'message.completed', sessionId, timestamp: new Date() } as IAgentEvent
      },
      async cancel() {},
    }
    const agents = { list: () => [current], get: (id: string) => (id === current.id ? current : undefined) }
    const secretsAsked: Array<{ agentId: string; project?: string }> = []
    const provider = new AgentProvider(new Map([[adapterKey(EProvider.GOOGLE, EMode.CHAT), adapter]]), store, undefined, agents)
    provider.useSecrets({
      envFor: (agentId, _session, project) => (secretsAsked.push({ agentId, ...(project ? { project } : {}) }), { env: {} }),
      ambientFor: () => undefined,
    })
    return { provider, seen, secretsAsked }
  }
  const turn = async (provider: AgentProvider, sessionId: string) => {
    for await (const _event of provider.sendMessage(sessionId, { text: 'oi' })) void _event
  }

  it('⛔ na conversa do beta o adapter recebe o agente SEM o projeto de origem (como o global); na do alfa, o de sempre', async () => {
    current = base
    const { provider, seen, secretsAsked } = setup()
    const inBeta = await provider.createSession({ agentId: 'dev-alfa', metadata: { project: 'beta' } })
    assert.strictEqual(seen.created.at(-1)?.projectId, undefined)
    assert.strictEqual(seen.created.at(-1)?.sharedWith, undefined)
    await turn(provider, inBeta.id)
    assert.strictEqual(seen.turn.at(-1)?.projectId, undefined)
    assert.deepStrictEqual([seen.context.at(-1)?.projectId, seen.context.at(-1)?.conversationProjectId], [undefined, 'beta'])
    // ⛔ O segredo da conversa é pedido com o projeto DELA (o do beta, nunca o da origem).
    assert.deepStrictEqual(secretsAsked.at(-1), { agentId: 'dev-alfa', project: 'beta' })
    // O ambiente do prompt: o projeto é o do beta e não "é o dele"; nada da pasta do alfa.
    assert.deepStrictEqual((seen.ambient.at(-1) as { project?: { id: string; own: boolean }; directory?: string }).project, { id: 'beta', own: false })
    assert.strictEqual((seen.ambient.at(-1) as { directory?: string }).directory, undefined)

    const inAlfa = await provider.createSession({ agentId: 'dev-alfa', metadata: { project: 'alfa' } })
    assert.strictEqual(seen.created.at(-1)?.projectId, 'alfa')
    await turn(provider, inAlfa.id)
    assert.deepStrictEqual([seen.context.at(-1)?.projectId, seen.context.at(-1)?.conversationProjectId], ['alfa', 'alfa'])
  })

  it('⛔ projeto que não recebeu o agente não abre conversa com ele; o global e o do próprio projeto seguem', async () => {
    current = base
    const { provider } = setup()
    await assert.rejects(provider.createSession({ agentId: 'dev-alfa', metadata: { project: 'gama' } }), AgentNotFoundError)
    await provider.createSession({ agentId: 'dev-alfa', metadata: { project: 'alfa' } })
    await provider.createSession({ agentId: 'dev-alfa' })
    current = { ...base, projectId: undefined, sharedWith: undefined }
    await provider.createSession({ agentId: 'dev-alfa', metadata: { project: 'gama' } })
  })

  it('⛔ parou de compartilhar: a conversa antiga do beta fica no histórico, mas não continua', async () => {
    current = base
    const { provider } = setup()
    const inBeta = await provider.createSession({ agentId: 'dev-alfa', metadata: { project: 'beta' } })
    await turn(provider, inBeta.id)
    current = { ...base, sharedWith: undefined }
    await assert.rejects(turn(provider, inBeta.id), AgentNotFoundError)
    current = base
  })
})
