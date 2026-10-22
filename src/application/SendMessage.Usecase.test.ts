import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { IConversationSession, IConversationTurn } from '@domain/models/Conversation.Model'
import { ISession } from '@domain/models/Session.Model'
import { NullConversationRepository } from '@infra/persistence/Null.ConversationRepository'
import { SendMessageUseCase } from './SendMessage.Usecase'

/** Repositório que só anota o que recebeu, e avisa quando a gravação terminou. */
class RecordingRepository extends NullConversationRepository {
  readonly turns: IConversationTurn[] = []
  readonly sessions: IConversationSession[] = []
  private resolve?: () => void

  /** A gravação é disparada com `void` no `finally`; sem isto o teste assertaria antes dela. */
  recorded(): Promise<void> {
    return new Promise((resolve) => {
      this.resolve = resolve
    })
  }

  async saveSession(session: IConversationSession): Promise<void> {
    this.sessions.push(session)
  }

  async appendTurn(turn: IConversationTurn): Promise<void> {
    this.turns.push(turn)
    this.resolve?.()
  }
}

const session = (over: Partial<ISession> = {}): ISession =>
  ({
    id: 's',
    agentId: 'researcher-agent',
    provider: EProvider.OPENAI,
    mode: EMode.CHAT,
    model: 'model-x',
    turns: 1,
    usage: { inputTokens: 8, outputTokens: 16, reasoningTokens: 4 },
    createdAt: new Date(),
    ...over,
  }) as ISession

const stubProvider = (overrides: Partial<IAgentProvider> = {}): IAgentProvider => ({
  createSession: async () => ({ id: 's', provider: EProvider.OPENAI, mode: EMode.CHAT, createdAt: new Date() }),
  sendMessage: async function* () {},
  cancel: async () => {},
  dispose: async () => {},
  describe: () => ({}) as ISession,
  list: () => [],
  ...overrides,
})

describe('SendMessageUseCase', () => {
  it('passes the stream through in order, keyed only by session id', async () => {
    let seenSessionId: string | undefined

    const usecase = new SendMessageUseCase(
      stubProvider({
        sendMessage: async function* (sessionId) {
          seenSessionId = sessionId
          yield { type: 'message.started', sessionId, timestamp: new Date() }
          yield { type: 'text.delta', sessionId, payload: { text: 'Hello' }, timestamp: new Date() }
          yield { type: 'message.completed', sessionId, timestamp: new Date() }
        },
      }),
      new NullConversationRepository(),
    )

    const events = []
    for await (const event of usecase.execute('sess-1', { text: 'Hi' })) events.push(event)

    assert.strictEqual(seenSessionId, 'sess-1')
    assert.strictEqual(events.length, 3)
    assert.strictEqual(events[0].type, 'message.started')
    assert.strictEqual(events[1].type, 'text.delta')
    assert.strictEqual(events[1].payload.text, 'Hello')
    assert.strictEqual(events[2].type, 'message.completed')
  })

  it('records the turn with the three token fields kept apart, plus their total', async () => {
    // ⚠️ Os três SEPARADOS. Guardar o raciocínio dentro da saída daria o total certo e apagaria a
    // informação que interessa: quanto do gasto foi o modelo pensando.
    const repository = new RecordingRepository()
    const usecase = new SendMessageUseCase(
      stubProvider({
        describe: () => session(),
        sendMessage: async function* () {
          yield { type: 'usage' as const, sessionId: 's', timestamp: new Date(), payload: { inputTokens: 100, outputTokens: 20, reasoningTokens: 5 } }
        },
      }),
      repository,
    )

    const done = repository.recorded()
    for await (const _event of usecase.execute('s', { text: 'quanto custou?' })) void _event
    await done

    assert.deepStrictEqual(repository.turns[0].usage, { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, totalTokens: 125, cacheReadTokens: 0, cacheWriteTokens: 0 })
    assert.strictEqual(repository.turns[0].request, 'quanto custou?')
  })

  it('records how long the turn took and the cache apart from the input', async () => {
    const repository = new RecordingRepository()
    const at = (ms: number) => new Date(Date.now() + ms)
    const usecase = new SendMessageUseCase(
      stubProvider({
        describe: () => session(),
        sendMessage: async function* (sessionId) {
          yield { type: 'message.started' as const, sessionId, timestamp: at(0) }
          yield { type: 'text.delta' as const, sessionId, payload: { text: 'Oi' }, timestamp: at(400) }
          yield { type: 'usage' as const, sessionId, payload: { inputTokens: 1000, cacheReadTokens: 700, outputTokens: 20 }, timestamp: at(900) }
          yield { type: 'message.completed' as const, sessionId, timestamp: at(1000) }
        },
      }),
      repository,
    )

    const done = repository.recorded()
    for await (const _event of usecase.execute('s', { text: 'Oi' })) void _event
    await done

    const turn = repository.turns[0]
    assert.ok(turn.firstTextMs !== undefined && turn.durationMs !== undefined)
    assert.ok(turn.firstTextMs >= 400 && turn.firstTextMs < turn.durationMs)
    assert.ok(turn.durationMs >= 1000 && turn.durationMs < 1500)
    // O cache é parcela da entrada: o total não muda, e as parcelas aparecem — zero quando não vêm.
    assert.deepStrictEqual(turn.usage, { inputTokens: 1000, outputTokens: 20, reasoningTokens: 0, totalTokens: 1020, cacheReadTokens: 700, cacheWriteTokens: 0 })
  })

  it('records the turn even when the reader walks away mid-stream', async () => {
    // ⚠️ É o `finally` fazendo efeito: fechar a aba encerra o gerador por fora, e o turno
    // interrompido é justamente o que alguém vai querer investigar depois.
    const repository = new RecordingRepository()
    const usecase = new SendMessageUseCase(
      stubProvider({
        describe: () => session(),
        sendMessage: async function* () {
          yield { type: 'text.delta' as const, sessionId: 's', timestamp: new Date(), payload: { text: 'come' } }
          yield { type: 'text.delta' as const, sessionId: 's', timestamp: new Date(), payload: { text: 'ço' } }
        },
      }),
      repository,
    )

    const done = repository.recorded()
    // O `break` no primeiro evento é o teste: quem lê some no meio, e o turno tem que ficar.
    for await (const first of usecase.execute('s', { text: 'oi' })) {
      assert.strictEqual(first.type, 'text.delta')
      break
    }
    await done

    assert.strictEqual(repository.turns.length, 1)
    assert.strictEqual(repository.turns[0].text, 'come')
  })

  it('titles the conversation from the first question, and only that once', async () => {
    const repository = new RecordingRepository()
    const build = (turns: number) =>
      new SendMessageUseCase(
        stubProvider({
          describe: () => session({ turns }),
          sendMessage: async function* () {
            yield { type: 'text.delta' as const, sessionId: 's', timestamp: new Date(), payload: { text: 'ok' } }
          },
        }),
        repository,
      )

    let done = repository.recorded()
    for await (const _event of build(1).execute('s', { text: 'primeira pergunta' })) void _event
    await done

    done = repository.recorded()
    for await (const _event of build(2).execute('s', { text: 'segunda pergunta' })) void _event
    await done

    assert.deepStrictEqual(
      repository.sessions.map((item) => item.title),
      ['primeira pergunta', undefined],
    )
  })

  describe('contexto da primeira mensagem', () => {
    const CONTEXT = '[contexto do sistema]'

    /** Provider que anota o texto recebido e conta turnos como o real: o turno soma ao começar. */
    const counting = (sent: string[], turns = { n: 0 }) =>
      stubProvider({
        describe: () => session({ turns: turns.n }),
        sendMessage: async function* (_id, input) {
          turns.n += 1
          sent.push(input.text)
          yield { type: 'text.delta' as const, sessionId: 's', timestamp: new Date(), payload: { text: 'ok' } }
        },
      })

    it('goes before the text on the first message only', async () => {
      const sent: string[] = []
      const usecase = new SendMessageUseCase(counting(sent), new NullConversationRepository())

      for await (const _ of usecase.execute('s', { text: 'Quantos pedidos?', context: CONTEXT })) void _
      for await (const _ of usecase.execute('s', { text: 'E clientes?', context: CONTEXT })) void _

      assert.deepStrictEqual(sent, [`${CONTEXT}\n\nQuantos pedidos?`, 'E clientes?'])
    })

    it('never reaches the adapter as a field, and is not recorded in the turn or the title', async () => {
      const repository = new RecordingRepository()
      const seen: Array<Record<string, unknown>> = []
      const turns = { n: 0 }
      const provider = counting([], turns)
      const usecase = new SendMessageUseCase({ ...provider, sendMessage: (id, input) => (seen.push({ ...input }), provider.sendMessage(id, input)) }, repository)

      const done = repository.recorded()
      for await (const _ of usecase.execute('s', { text: 'Quantos pedidos?', context: CONTEXT })) void _
      await done

      assert.strictEqual('context' in seen[0], false)
      assert.strictEqual(repository.turns[0].request, 'Quantos pedidos?')
      assert.strictEqual(repository.sessions[0].title, 'Quantos pedidos?')
    })

    it('an attachment with no text still carries the context', async () => {
      const sent: string[] = []
      const usecase = new SendMessageUseCase(counting(sent), new NullConversationRepository())

      for await (const _ of usecase.execute('s', { text: '', files: [{ name: 'a.png', mimeType: 'image/png', data: 'AA==' }], context: CONTEXT })) void _

      assert.deepStrictEqual(sent, [CONTEXT])
    })

    it('no context, no change', async () => {
      const sent: string[] = []
      const usecase = new SendMessageUseCase(counting(sent), new NullConversationRepository())

      for await (const _ of usecase.execute('s', { text: 'oi' })) void _

      assert.deepStrictEqual(sent, ['oi'])
    })
  })
})
