import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { SessionStore } from '@infra/session/Session.Store'
import { adapterKey, AgentProvider } from './Agent.Provider'

/**
 * 🔑 A secreta criada DEPOIS que a conversa abriu: o valor já ia ao terminal a cada turno, mas a lista de nomes do prompt
 * era a da abertura, e o agente dizia que a variável não existia. Agora o turno seguinte leva o aviso — uma vez.
 */
describe('AgentProvider — variáveis secretas que mudam no meio da conversa', () => {
  const agent: IAgent = {
    id: 'zeus',
    name: 'Zeus',
    projectId: 'logiccus',
    providers: [{ provider: EProvider.GOOGLE, models: ['gemini-3.7-flash'] }],
    systemPrompt: 'Você orquestra.',
    modes: [EMode.CHAT],
    allowedTools: [],
  }

  it('o turno depois da secreta nova leva o aviso com o nome; o seguinte, não', async () => {
    const store = new SessionStore()
    const sent: string[] = []
    const adapter: IAgentAdapter = {
      async createSession(current, input) {
        const record = store.create({
          agentId: current.id,
          provider: EProvider.GOOGLE,
          protocol: EProvider.GOOGLE,
          mode: EMode.CHAT,
          model: 'gemini-3.7-flash',
          tools: false,
          systemPrompt: current.systemPrompt,
          metadata: input.metadata,
        })
        return { id: record.id, provider: EProvider.GOOGLE, mode: record.mode, createdAt: record.createdAt }
      },
      async *sendMessage(_agent, sessionId, input) {
        sent.push(input.text)
        yield { type: 'message.completed', sessionId, timestamp: new Date() } as IAgentEvent
      },
      async cancel() {},
    }
    const agents = { list: () => [agent], get: (id: string) => (id === agent.id ? agent : undefined) }
    const provider = new AgentProvider(new Map([[adapterKey(EProvider.GOOGLE, EMode.CHAT), adapter]]), store, undefined, agents)
    let project = ['LOGICCUS_CD_CI']
    provider.useSecrets({ envFor: () => ({ env: {} }), ambientFor: () => ({ agent: [], project, resources: [] }) })
    const turn = async (id: string) => {
      for await (const _event of provider.sendMessage(id, { text: 'oi' })) void _event
    }

    const session = await provider.createSession({ agentId: 'zeus', metadata: { project: 'logiccus' } })
    await turn(session.id)
    assert.doesNotMatch(sent.at(-1)!, /variáveis secretas/i, 'nada mudou: sem aviso')

    project = ['E2E_PROVIDER_PASSWORD', 'LOGICCUS_CD_CI']
    await turn(session.id)
    assert.match(sent.at(-1)!, /novas, já no ambiente dos seus comandos.*`E2E_PROVIDER_PASSWORD`/)

    await turn(session.id)
    assert.doesNotMatch(sent.at(-1)!, /variáveis secretas/i, 'avisado uma vez')
  })
})
