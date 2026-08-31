import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IConversationSession, IConversationTurn } from '@domain/models/Conversation.Model'
import { SqliteConversationRepository } from './Sqlite.ConversationRepository'

const session = (over: Partial<IConversationSession> = {}): IConversationSession => ({
  id: 's1',
  agentId: 'researcher-agent',
  provider: 'google',
  mode: 'chat',
  model: 'gemini-3.7-flash',
  title: 'primeira pergunta',
  createdAt: new Date('2026-08-30T10:00:00.000Z'),
  updatedAt: new Date('2026-08-30T10:00:00.000Z'),
  turns: 1,
  usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, totalTokens: 125 },
  ...over,
})

const turn = (over: Partial<IConversationTurn> = {}): IConversationTurn => ({
  sessionId: 's1',
  index: 0,
  at: new Date('2026-08-30T10:00:00.000Z'),
  request: 'quanto custou?',
  text: 'custou pouco',
  toolCalls: [],
  usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, totalTokens: 125 },
  ...over,
})

/** Cada teste com o seu banco em memória: nenhum arquivo, nenhuma ordem entre testes. */
const repository = () => new SqliteConversationRepository(':memory:')

describe('SqliteConversationRepository', () => {
  it('stores a conversation and reads it back whole', async () => {
    const repo = repository()
    await repo.saveSession(session({ metadata: { user: 'u1' } }))

    const found = await repo.findSession('s1')

    assert.strictEqual(found?.title, 'primeira pergunta')
    assert.deepStrictEqual(found?.usage, { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, totalTokens: 125 })
    assert.deepStrictEqual(found?.metadata, { user: 'u1' })
    assert.strictEqual(found?.createdAt.toISOString(), '2026-08-30T10:00:00.000Z')
  })

  it('keeps the three token fields apart across a round trip', async () => {
    // ⚠️ É a razão de os campos existirem separados: guardar o raciocínio dentro da saída daria o
    // total certo e apagaria quanto do gasto foi o modelo pensando.
    const repo = repository()
    await repo.saveSession(session())
    await repo.appendTurn(turn())

    const [stored] = await repo.listTurns('s1')

    assert.deepStrictEqual(stored.usage, { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, totalTokens: 125 })
  })

  it('does not lose the title when a later turn saves the header without one', async () => {
    // ⚠️ O cabeçalho é regravado a cada turno e o título só vem no primeiro. Sem o COALESCE, o
    // segundo turno apagaria o rótulo da conversa.
    const repo = repository()
    await repo.saveSession(session())
    await repo.saveSession(session({ title: undefined, turns: 2, updatedAt: new Date('2026-08-30T11:00:00.000Z') }))

    const found = await repo.findSession('s1')

    assert.strictEqual(found?.title, 'primeira pergunta')
    assert.strictEqual(found?.turns, 2)
    assert.strictEqual(found?.createdAt.toISOString(), '2026-08-30T10:00:00.000Z')
  })

  it('lists the most recent first', async () => {
    const repo = repository()
    await repo.saveSession(session({ id: 'velha', updatedAt: new Date('2026-08-29T10:00:00.000Z') }))
    await repo.saveSession(session({ id: 'nova', updatedAt: new Date('2026-08-30T10:00:00.000Z') }))

    const listed = await repo.listSessions()

    assert.deepStrictEqual(
      listed.map((item) => item.id),
      ['nova', 'velha'],
    )
  })

  it('filters by metadata', async () => {
    const repo = repository()
    await repo.saveSession(session({ id: 'do-ana', metadata: { user: 'ana' } }))
    await repo.saveSession(session({ id: 'do-bia', metadata: { user: 'bia' } }))

    const listed = await repo.listSessions({ filter: { user: 'ana' } })

    assert.deepStrictEqual(
      listed.map((item) => item.id),
      ['do-ana'],
    )
  })

  it('ignores a filter key that is not a plain identifier, instead of building it into the SQL', async () => {
    // ⛔ A chave vai para dentro do caminho JSON, que não é parametrizável. Uma chave arbitrária
    // seria injeção; ignorar ALARGA o resultado, e por isso o descarte é registrado no log.
    const repo = repository()
    await repo.saveSession(session({ id: 'do-ana', metadata: { user: 'ana' } }))

    const listed = await repo.listSessions({ filter: { "user') = 'ana' OR '1": 'x' } })

    assert.deepStrictEqual(
      listed.map((item) => item.id),
      ['do-ana'],
    )
  })

  it('aggregates in the database, not over the listed page', async () => {
    const repo = repository()
    await repo.saveSession(session({ id: 's1', model: 'gemini-3.7-flash' }))
    await repo.saveSession(session({ id: 's2', model: 'gemini-3.7-flash', turns: 3 }))
    await repo.saveSession(session({ id: 's3', provider: 'openai', model: 'gpt-6' }))

    const stats = await repo.stats()

    assert.strictEqual(stats.conversations, 3)
    assert.strictEqual(stats.turns, 5)
    assert.strictEqual(stats.usage.totalTokens, 375)
    assert.deepStrictEqual(
      stats.byModel.map((item) => [item.model, item.conversations, item.usage.totalTokens]),
      [
        ['gemini-3.7-flash', 2, 250],
        ['gpt-6', 1, 125],
      ],
    )
  })

  it('takes the turns with the conversation when it is deleted', async () => {
    const repo = repository()
    await repo.saveSession(session())
    await repo.appendTurn(turn())

    await repo.deleteSession('s1')

    assert.strictEqual(await repo.findSession('s1'), undefined)
    assert.deepStrictEqual(await repo.listTurns('s1'), [])
  })

  it('swallows a database failure instead of taking the turn down with it', async () => {
    // ⛔ O contrato do port: perder o registro é ruim, perder o turno de quem estava trabalhando é
    // pior. Com o banco fechado, gravar não pode lançar.
    const repo = repository()
    repo.close()

    await assert.doesNotReject(() => repo.appendTurn(turn()))
    assert.deepStrictEqual(await repo.listSessions(), [])
    assert.deepStrictEqual((await repo.stats()).byModel, [])
  })
})
