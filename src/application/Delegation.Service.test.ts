import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { ISession } from '@domain/models/Session.Model'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { NullConversationRepository } from '@infra/persistence/Null.ConversationRepository'
import { CreateSessionUseCase } from './CreateSession.Usecase'
import { DelegationService } from './Delegation.Service'
import { SendMessageUseCase } from './SendMessage.Usecase'

describe('DelegationService', () => {
  const session = (id: string, agentId: string, metadata?: Record<string, unknown>): ISession =>
    ({
      id,
      agentId,
      provider: 'claude',
      mode: EMode.CHAT,
      model: 'm',
      tools: false,
      status: 'idle',
      turns: 0,
      usage: {},
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata,
    }) as ISession

  const build = (parentMetadata: Record<string, unknown> = { owner: { id: 'ana' } }) => {
    const sessions = new Map<string, ISession>([['pai', session('pai', 'redator', parentMetadata)]])
    const created: ICreateSessionInput[] = []
    let next = 0
    const provider: IAgentProvider = {
      createSession: async (input) => {
        created.push(input)
        const id = `filha-${++next}`
        sessions.set(id, session(id, input.agentId ?? '', input.metadata))
        return { id, provider: EProvider.CLAUDE, mode: EMode.CHAT, createdAt: new Date() }
      },
      sendMessage: async function* (sessionId, input) {
        yield { type: 'text.delta', sessionId, timestamp: new Date(), payload: { text: `[${sessions.get(sessionId)?.agentId}] ${input.text}` } }
      },
      cancel: async () => {},
      dispose: async () => {},
      describe: (id) => {
        const found = sessions.get(id)
        if (!found) throw new Error('not found')
        return found
      },
      list: () => [...sessions.values()],
      reconfigure: () => {
        throw new Error('not used')
      },
    }
    const service = new DelegationService(
      provider,
      new CreateSessionUseCase(provider),
      new SendMessageUseCase(provider, new NullConversationRepository()),
      () => 2,
      (id) => (id === 'pong' ? [EMode.AGENT] : [EMode.CHAT]),
    )
    return { service, created, sessions }
  }

  it('abre a filha com o mesmo dono e os metadados da delegação, e devolve a resposta', async () => {
    const { service, created } = build()
    const result = await service.delegate({ allowed: ['tradutor'], agentId: 'tradutor', message: 'traduza oi' }, { sessionId: 'pai' })

    assert.deepStrictEqual(result, { ok: true, agentId: 'tradutor', sessionId: 'filha-1', reply: '[tradutor] traduza oi' })
    assert.deepStrictEqual(created[0].metadata, {
      owner: { id: 'ana' },
      delegatedBy: 'pai',
      delegatedFrom: 'redator',
      delegationDepth: 1,
      delegationChain: ['redator', 'tradutor'],
    })
  })

  it('⛔ recusa: fora da lista, ciclo (inclusive o próprio agente) e acima da profundidade', async () => {
    const { service } = build()
    assert.match(JSON.stringify(await service.delegate({ allowed: ['tradutor'], agentId: 'outro', message: 'x' }, { sessionId: 'pai' })), /not allowed/)
    assert.match(JSON.stringify(await service.delegate({ allowed: ['redator'], agentId: 'redator', message: 'x' }, { sessionId: 'pai' })), /no cycles/)

    const deep = build({ delegationDepth: 2, delegationChain: ['a', 'b', 'redator'] })
    assert.match(JSON.stringify(await deep.service.delegate({ allowed: ['tradutor'], agentId: 'tradutor', message: 'x' }, { sessionId: 'pai' })), /depth limit/)
    assert.match(JSON.stringify(await deep.service.delegate({ allowed: ['a'], agentId: 'a', message: 'x' }, { sessionId: 'pai' })), /no cycles/)
  })

  it('continua a filha desta conversa; recusa a de outra conversa e chamada sem sessão', async () => {
    const { service, sessions } = build()
    const first = await service.delegate({ allowed: ['tradutor'], agentId: 'tradutor', message: 'um' }, { sessionId: 'pai' })
    const childId = first.ok ? first.sessionId : ''
    const again = await service.delegate({ allowed: ['tradutor'], agentId: 'tradutor', message: 'dois', sessionId: childId }, { sessionId: 'pai' })
    assert.deepStrictEqual(again.ok && again.sessionId, childId)

    sessions.set('estranha', session('estranha', 'tradutor', { delegatedBy: 'outra-pai' }))
    assert.match(
      JSON.stringify(await service.delegate({ allowed: ['tradutor'], agentId: 'tradutor', message: 'x', sessionId: 'estranha' }, { sessionId: 'pai' })),
      /not a delegation/,
    )
    assert.match(JSON.stringify(await service.delegate({ allowed: ['tradutor'], agentId: 'tradutor', message: 'x' }, {})), /needs the calling conversation/)
  })
})
