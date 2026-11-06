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
    // É a marca que deixa abrir um subagente (ver `AgentProvider.createSession`).
    assert.strictEqual(created[0].delegated, true)
  })

  it('⚖️ a resposta não se perde: chegou depois do turno da mãe, vira um turno novo dela; noutro turno dela, entra na fila', async () => {
    const { service, sessions } = build()
    const late: Array<{ parent: string; text: string }> = []
    service.useLateDelivery((parent, text) => void late.push({ parent, text }))
    const parent = sessions.get('pai')!
    // A mãe no mesmo turno que delegou: a resposta volta pela ferramenta, nada a mais.
    parent.status = 'running'
    parent.turns = 3
    await service.delegate({ allowed: ['tradutor'], agentId: 'tradutor', message: 'um' }, { sessionId: 'pai' })
    assert.strictEqual(late.length, 0)

    // A chamada caiu e o turno da mãe acabou enquanto a filha trabalhava.
    const original = (service as unknown as { sendMessage: { execute: (id: string, input: { text: string }) => AsyncIterable<unknown> } }).sendMessage
    const execute = original.execute.bind(original)
    original.execute = async function* (id: string, input: { text: string }) {
      parent.status = 'idle'
      yield* execute(id, input)
    }
    await service.delegate({ allowed: ['tradutor'], agentId: 'tradutor', message: 'dois' }, { sessionId: 'pai' })
    assert.strictEqual(late.length, 1)
    assert.strictEqual(late[0].parent, 'pai')
    assert.match(late[0].text, /Resposta de tradutor à sua delegação \(sessionId filha-2\)[\s\S]*\[tradutor\] dois/)
  })

  it('⚖️ a filha sai da memória ao fim do turno dela (não ocupa a vaga de conversa viva); a mãe, não', async () => {
    const { service: base } = build()
    const internals = base as unknown as { provider: IAgentProvider; createSession: CreateSessionUseCase; sendMessage: SendMessageUseCase }
    const released: string[] = []
    const service = new DelegationService(
      internals.provider,
      internals.createSession,
      internals.sendMessage,
      () => 2,
      () => [EMode.CHAT],
      undefined,
      (id) => void released.push(id),
    )
    const result = await service.delegate({ allowed: ['tradutor'], agentId: 'tradutor', message: 'oi' }, { sessionId: 'pai' })
    assert.ok(result.ok)
    assert.deepStrictEqual(released, [result.sessionId])
  })

  it('⚖️ a filha encerrada (o gateway reiniciou) volta pelo histórico; a de outra mãe e a apagada, não', async () => {
    const { sessions, service: base } = build()
    const internals = base as unknown as { provider: IAgentProvider; createSession: CreateSessionUseCase; sendMessage: SendMessageUseCase }
    const stored = new Map<string, { agentId: string; delegatedBy?: unknown }>([
      ['filha-velha', { agentId: 'tradutor', delegatedBy: 'pai' }],
      ['de-outra', { agentId: 'tradutor', delegatedBy: 'outra-mae' }],
    ])
    const resumed: string[] = []
    const service = new DelegationService(
      internals.provider,
      internals.createSession,
      internals.sendMessage,
      () => 2,
      () => [EMode.CHAT],
      async (id, parentId) => {
        const found = stored.get(id)
        if (found && found.delegatedBy === parentId) {
          resumed.push(id)
          // A retomada põe a filha de volta na memória do provider.
          sessions.set(id, session(id, found.agentId, { delegatedBy: parentId }))
        }
        return found
      },
    )
    const back = await service.delegate({ allowed: ['tradutor'], agentId: 'tradutor', sessionId: 'filha-velha', message: 'continue' }, { sessionId: 'pai' })
    assert.deepStrictEqual([back.ok, resumed], [true, ['filha-velha']])
    const other = await service.delegate({ allowed: ['tradutor'], agentId: 'tradutor', sessionId: 'de-outra', message: 'x' }, { sessionId: 'pai' })
    assert.deepStrictEqual(other, { ok: false, error: 'conversation de-outra is not a delegation of this conversation to tradutor' })
    const gone = await service.delegate({ allowed: ['tradutor'], agentId: 'tradutor', sessionId: 'apagada', message: 'x' }, { sessionId: 'pai' })
    assert.match(gone.ok ? '' : gone.error, /was deleted or does not exist/)
  })

  it('a filha trabalha no projeto da conversa-mãe (o construtor grava nele)', async () => {
    const { service, created } = build({ owner: { id: 'ana' }, project: 'xpto' })
    await service.delegate({ allowed: ['tradutor'], agentId: 'tradutor', message: 'x' }, { sessionId: 'pai' })
    assert.strictEqual(created[0].metadata?.project, 'xpto')
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
