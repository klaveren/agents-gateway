import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    assert.deepStrictEqual(found?.usage, { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, totalTokens: 125, cacheReadTokens: 0, cacheWriteTokens: 0 })
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

    assert.deepStrictEqual(stored.usage, { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, totalTokens: 125, cacheReadTokens: 0, cacheWriteTokens: 0 })
  })

  it('stores the cache parcels and the timing, per turn and in the conversation', async () => {
    const repo = repository()
    const usage = { inputTokens: 1000, outputTokens: 20, reasoningTokens: 0, totalTokens: 1020, cacheReadTokens: 700, cacheWriteTokens: 100 }
    await repo.saveSession(session({ usage }))
    await repo.appendTurn(turn({ usage, durationMs: 1200, firstTextMs: 400 }))

    const [stored] = await repo.listTurns('s1')
    const found = await repo.findSession('s1')

    assert.deepStrictEqual(stored.usage, usage)
    assert.strictEqual(stored.durationMs, 1200)
    assert.strictEqual(stored.firstTextMs, 400)
    assert.deepStrictEqual(found?.usage, usage)
  })

  it('leaves the timing absent, not zero, when the turn has none', async () => {
    const repo = repository()
    await repo.saveSession(session())
    await repo.appendTurn(turn())

    const [stored] = await repo.listTurns('s1')

    assert.strictEqual(stored.durationMs, undefined)
    assert.strictEqual(stored.firstTextMs, undefined)
  })

  it('adds the new columns to an existing file without losing what it holds', async () => {
    // O arquivo nasceu antes de cache e tempo existirem: o esquema antigo, uma conversa e um turno.
    const dir = mkdtempSync(join(tmpdir(), 'gateway-db-'))
    const path = join(dir, 'old.db')

    try {
      const legacy = new DatabaseSync(path)
      legacy.exec(`
        CREATE TABLE conversations (
          id TEXT NOT NULL PRIMARY KEY, agent_id TEXT NOT NULL, provider TEXT NOT NULL, mode TEXT NOT NULL, model TEXT NOT NULL, title TEXT,
          turns INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
          reasoning_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE conversation_turns (
          conversation_id TEXT NOT NULL, idx INTEGER NOT NULL, at TEXT NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL, reasoning TEXT, tool_calls TEXT,
          warnings TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0, aborted INTEGER NOT NULL DEFAULT 0, error TEXT, PRIMARY KEY (conversation_id, idx)
        );
        INSERT INTO conversations (id, agent_id, provider, mode, model, title, turns, input_tokens, output_tokens, reasoning_tokens, total_tokens, created_at, updated_at)
          VALUES ('old', 'a', 'google', 'chat', 'm', 'antiga', 1, 10, 5, 0, 15, '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z');
        INSERT INTO conversation_turns (conversation_id, idx, at, request, response, input_tokens, output_tokens, total_tokens)
          VALUES ('old', 0, '2026-08-01T10:00:00.000Z', 'oi', 'olá', 10, 5, 15);
      `)
      legacy.close()

      const repo = new SqliteConversationRepository(path)
      const [oldTurn] = await repo.listTurns('old')

      assert.strictEqual((await repo.findSession('old'))?.title, 'antiga')
      assert.deepStrictEqual(oldTurn.usage, { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 })
      assert.strictEqual(oldTurn.durationMs, undefined)

      // E o arquivo migrado já aceita o formato novo.
      await repo.appendTurn(turn({ sessionId: 'old', index: 1, durationMs: 50, usage: { cacheReadTokens: 3 } }))
      assert.strictEqual((await repo.listTurns('old'))[1].usage?.cacheReadTokens, 3)
      repo.close()

      // Abrir de novo não tenta recriar coluna que já existe.
      assert.doesNotThrow(() => new SqliteConversationRepository(path).close())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sums the cache parcels in the aggregate', async () => {
    const repo = repository()
    const usage = { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, totalTokens: 125, cacheReadTokens: 60, cacheWriteTokens: 10 }
    await repo.saveSession(session({ id: 's1', usage }))
    await repo.saveSession(session({ id: 's2', usage }))

    const stats = await repo.stats()

    assert.strictEqual(stats.usage.cacheReadTokens, 120)
    assert.strictEqual(stats.usage.cacheWriteTokens, 20)
    assert.strictEqual(stats.byModel[0].usage.cacheReadTokens, 120)
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
