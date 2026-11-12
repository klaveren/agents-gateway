import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { ISession } from '@domain/models/Session.Model'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { NullConversationRepository } from '@infra/persistence/Null.ConversationRepository'
import { CreateSessionUseCase } from './CreateSession.Usecase'
import { DelegationService, IStoredConversation, ownIssue } from './Delegation.Service'
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
    assert.match(late[0].text, /Resposta de tradutor \(conversation filha-2\), que chegou depois do fim do seu turno[\s\S]*\[tradutor\] dois/)
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
  it('⚖️ continua a conversa da PESSOA com o agente: mensagem com cabeçalho, e a conversa viva não sai da memória', async () => {
    const { sessions, service: base } = build({ owner: { id: 'ana' }, project: 'bh' })
    const internals = base as unknown as { provider: IAgentProvider; createSession: CreateSessionUseCase; sendMessage: SendMessageUseCase }
    const released: string[] = []
    const service = new DelegationService(
      internals.provider,
      internals.createSession,
      internals.sendMessage,
      () => 2,
      () => [EMode.CHAT],
      undefined,
      (id) => released.push(id),
    )
    sessions.set('da-ana', session('da-ana', 'integra', { owner: { id: 'ana' }, project: 'bh' }))
    const result = await service.delegate({ allowed: ['integra'], agentId: 'integra', sessionId: 'da-ana', message: 'oi' }, { sessionId: 'pai' })
    assert.ok(result.ok)
    assert.match(result.reply, /^\[integra\] \[Mensagem do agente redator \(conversa pai\), em nome da mesma pessoa/)
    assert.match(result.reply, /\n\noi$/)
    assert.deepStrictEqual(released, [])

    sessions.set('rodando', { ...session('rodando', 'integra', { owner: { id: 'ana' }, project: 'bh' }), status: 'running' })
    assert.match(JSON.stringify(await service.delegate({ allowed: ['integra'], agentId: 'integra', sessionId: 'rodando', message: 'x' }, { sessionId: 'pai' })), /running a turn/)
  })

  it('⛔ a conversa que não é filha: só da mesma pessoa e conta, no mesmo projeto, com o agente pedido, e nunca a filha de outra', () => {
    const parent = { id: 'pai', agentId: 'atlas', metadata: { owner: { id: 'ana', account: 'c1' }, project: 'bh' } }
    const target = (metadata: Record<string, unknown>, agentId = 'integra'): IStoredConversation => ({ agentId, metadata })
    assert.strictEqual(ownIssue(parent, target({ owner: { id: 'ana', account: 'c1' }, project: 'bh' }), 's', 'integra'), undefined)
    assert.match(ownIssue(parent, target({ owner: { id: 'bia', account: 'c1' }, project: 'bh' }), 's', 'integra') ?? '', /another person/)
    assert.match(ownIssue(parent, target({ owner: { id: 'ana', account: 'c2' }, project: 'bh' }), 's', 'integra') ?? '', /another person/)
    assert.match(ownIssue(parent, target({ project: 'bh' }), 's', 'integra') ?? '', /another person/)
    assert.match(ownIssue(parent, target({ owner: { id: 'ana', account: 'c1' }, project: 'xpto' }), 's', 'integra') ?? '', /another project/)
    assert.match(ownIssue(parent, target({ owner: { id: 'ana', account: 'c1' }, project: 'bh' }, 'outro'), 's', 'integra') ?? '', /is with outro/)
    assert.match(ownIssue(parent, target({ owner: { id: 'ana', account: 'c1' }, project: 'bh', delegatedBy: 'x' }), 's', 'integra') ?? '', /not a delegation/)
    // Sem dono na conversa que chama, nada continua.
    assert.match(ownIssue({ ...parent, metadata: {} }, target({}), 's', 'integra') ?? '', /another person/)
  })

  it('⚖️ a conversa da pessoa que não está viva volta pelo histórico (e sai ao fim); a recusada não volta', async () => {
    const { sessions, service: base } = build({ owner: { id: 'ana' }, project: 'bh' })
    const internals = base as unknown as { provider: IAgentProvider; createSession: CreateSessionUseCase; sendMessage: SendMessageUseCase }
    const stored = new Map<string, IStoredConversation>([
      ['gravada', { agentId: 'integra', metadata: { owner: { id: 'ana' }, project: 'bh' } }],
      ['de-outro', { agentId: 'integra', metadata: { owner: { id: 'bia' }, project: 'bh' } }],
    ])
    const resumed: Array<[string, string]> = []
    const released: string[] = []
    const service = new DelegationService(
      internals.provider,
      internals.createSession,
      internals.sendMessage,
      () => 2,
      () => [EMode.CHAT],
      async (id) => {
        const found = stored.get(id)
        return found && { agentId: found.agentId, delegatedBy: found.metadata?.delegatedBy }
      },
      (id) => released.push(id),
      async (id, accept, via) => {
        const found = stored.get(id)!
        const issue = accept(found)
        if (issue) return issue
        resumed.push([id, via])
        sessions.set(id, session(id, found.agentId, found.metadata))
        return undefined
      },
    )
    const back = await service.delegate({ allowed: ['integra'], agentId: 'integra', sessionId: 'gravada', message: 'oi' }, { sessionId: 'pai' })
    assert.deepStrictEqual([back.ok, resumed, released], [true, [['gravada', 'pai']], ['gravada']])
    const other = await service.delegate({ allowed: ['integra'], agentId: 'integra', sessionId: 'de-outro', message: 'x' }, { sessionId: 'pai' })
    assert.match(other.ok ? '' : other.error, /another person/)
    assert.strictEqual(resumed.length, 1)
  })

  it('⚖️ `wait: false` não espera: volta pendente, e a resposta entra depois — num turno novo, ou na fila do turno que roda', async () => {
    const { service, sessions } = build()
    const late: string[] = []
    service.useLateDelivery((_parent, text) => void late.push(text))
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 50 && !done(); i++) await new Promise((resolve) => setImmediate(resolve))
    }
    const result = await service.delegate({ allowed: ['tradutor'], agentId: 'tradutor', message: 'um', wait: false }, { sessionId: 'pai' })
    assert.deepStrictEqual(result, { ok: true, agentId: 'tradutor', sessionId: 'filha-1', reply: '', pending: true })
    await until(() => late.length > 0)
    assert.match(late[0], /^\[Resposta de tradutor \(conversation filha-1\), que você pediu sem esperar[\s\S]*\[tradutor\] um$/)

    const queued: string[] = []
    const internals = service as unknown as { provider: IAgentProvider }
    internals.provider.enqueue = (_id, text) => queued.push(text)
    sessions.get('pai')!.status = 'running'
    await service.delegate({ allowed: ['tradutor'], agentId: 'tradutor', message: 'dois', wait: false }, { sessionId: 'pai' })
    await until(() => queued.length > 0)
    assert.match(queued[0], /que você pediu sem esperar[\s\S]*\[tradutor\] dois$/)
    assert.strictEqual(late.length, 1)
  })

  describe('o `talk` sem mensagem: com quem falar e o estado de uma conversa', () => {
    const lookupFor = (stored: Array<IStoredConversation & { id: string; title?: string }>, replies: Record<string, string> = {}) => ({
      name: (id: string) => ({ integra: 'Integra' })[id],
      find: async (id: string) => stored.find((item) => item.id === id),
      conversations: async () => stored,
      lastReply: async (id: string) => replies[id],
    })

    it('lista os agentes que ele chama e as conversas abertas: as filhas dele e as da pessoa no mesmo projeto', async () => {
      const { service } = build({ owner: { id: 'ana' }, project: 'bh' })
      service.useLookup(
        lookupFor([
          { id: 'pai', agentId: 'redator', metadata: { owner: { id: 'ana' }, project: 'bh' } },
          { id: 'filha', agentId: 'tradutor', metadata: { owner: { id: 'ana' }, project: 'bh', delegatedBy: 'pai' } },
          { id: 'da-ana', agentId: 'integra', title: 'Notas', metadata: { owner: { id: 'ana' }, project: 'bh' } },
          { id: 'outro-projeto', agentId: 'integra', metadata: { owner: { id: 'ana' }, project: 'xpto' } },
          { id: 'filha-de-outra', agentId: 'integra', metadata: { owner: { id: 'ana' }, project: 'bh', delegatedBy: 'outra' } },
          { id: 'fora-da-lista', agentId: 'secreto', metadata: { owner: { id: 'ana' }, project: 'bh' } },
        ]),
      )
      assert.deepStrictEqual(await service.directory(['tradutor', 'integra'], { sessionId: 'pai' }), {
        agents: [{ id: 'tradutor' }, { id: 'integra', name: 'Integra' }],
        conversations: [
          { conversation: 'filha', to: 'tradutor', kind: 'child' },
          { conversation: 'da-ana', to: 'integra', kind: 'person', title: 'Notas' },
        ],
      })
      // Sem a conversa que chama, só os agentes.
      assert.deepStrictEqual((await service.directory(['integra'], {})).conversations, [])
    })

    it('⛔ o estado só da conversa que ele alcançaria: a filha ou a da mesma pessoa; a de outra pessoa e fora da lista, não', async () => {
      const { service, sessions } = build({ owner: { id: 'ana' }, project: 'bh' })
      service.useLookup(
        lookupFor(
          [
            { id: 'gravada', agentId: 'integra', metadata: { owner: { id: 'ana' }, project: 'bh' } },
            { id: 'da-bia', agentId: 'integra', metadata: { owner: { id: 'bia' }, project: 'bh' } },
          ],
          { gravada: 'pronto' },
        ),
      )
      sessions.set('viva', { ...session('viva', 'integra', { owner: { id: 'ana' }, project: 'bh' }), status: 'running' })
      assert.deepStrictEqual(await service.status(['integra'], 'gravada', { sessionId: 'pai' }), {
        ok: true,
        status: { conversation: 'gravada', to: 'integra', running: false, reply: 'pronto' },
      })
      assert.deepStrictEqual(await service.status(['integra'], 'viva', { sessionId: 'pai' }), { ok: true, status: { conversation: 'viva', to: 'integra', running: true } })
      assert.match(JSON.stringify(await service.status(['integra'], 'da-bia', { sessionId: 'pai' })), /another person/)
      assert.match(JSON.stringify(await service.status(['tradutor'], 'gravada', { sessionId: 'pai' })), /not allowed to talk to integra/)
      assert.match(JSON.stringify(await service.status(['integra'], 'sumiu', { sessionId: 'pai' })), /was deleted or does not exist/)
      assert.match(JSON.stringify(await service.status(['integra'], 'gravada', {})), /needs the calling conversation/)
    })
  })
})
