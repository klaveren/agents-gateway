import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { IConversationSession, IConversationTurn, PREVIEW_MAX } from '@domain/models/Conversation.Model'
import { SqliteConversationRepository } from './Sqlite.ConversationRepository'

const session = (over: Partial<IConversationSession> = {}): IConversationSession => ({
  id: 's1',
  agentId: 'pesquisa-teste',
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
  it('a tabela antiga das tarefas (com FK) é recriada sem ela, com o que havia', () => {
    const dir = mkdtempSync(join(tmpdir(), 'todos-fk-'))
    const path = join(dir, 'gateway.db')
    try {
      new SqliteConversationRepository(path)
      const old = new DatabaseSync(path)
      old.exec(`PRAGMA foreign_keys = OFF; DROP TABLE conversation_todos;
        CREATE TABLE conversation_todos (conversation_id TEXT NOT NULL PRIMARY KEY, items TEXT NOT NULL, updated_at TEXT NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE);
        INSERT INTO conversation_todos VALUES ('c1', '[]', '2026-10-28T00:00:00.000Z');`)
      old.close()
      new SqliteConversationRepository(path)
      const db = new DatabaseSync(path)
      assert.strictEqual((db.prepare("SELECT count(*) AS n FROM pragma_foreign_key_list('conversation_todos')").get() as { n: number }).n, 0)
      assert.strictEqual((db.prepare('SELECT count(*) AS n FROM conversation_todos').get() as { n: number }).n, 1)
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a lista de tarefas: grava trocando a inteira, lê de volta, e some com a conversa', async () => {
    const repo = repository()
    await repo.saveSession(session())
    const id = session().id
    assert.deepStrictEqual(await repo.todos(id), { items: [] })
    await repo.saveTodos(id, [{ title: 'Ler', status: 'done' }])
    await repo.saveTodos(id, [
      { title: 'Ler', status: 'done' },
      { title: 'Escrever', status: 'in_progress' },
    ])
    const saved = await repo.todos(id)
    assert.deepStrictEqual(saved.items, [
      { title: 'Ler', status: 'done' },
      { title: 'Escrever', status: 'in_progress' },
    ])
    assert.ok(saved.updatedAt instanceof Date)
    await repo.deleteSession(id)
    assert.deepStrictEqual(await repo.todos(id), { items: [] })
    // A lista nasce no primeiro turno, antes de a conversa ser gravada: grava mesmo assim.
    await repo.saveTodos('ainda-sem-conversa', [{ title: 'x', status: 'pending' }])
    assert.deepStrictEqual((await repo.todos('ainda-sem-conversa')).items, [{ title: 'x', status: 'pending' }])
  })

  it('stores a conversation and reads it back whole', async () => {
    const repo = repository()
    await repo.saveSession(session({ metadata: { user: 'u1' } }))

    const found = await repo.findSession('s1')

    assert.strictEqual(found?.title, 'primeira pergunta')
    assert.deepStrictEqual(found?.usage, { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, totalTokens: 125, cacheReadTokens: 0, cacheWriteTokens: 0 })
    assert.deepStrictEqual(found?.metadata, { user: 'u1' })
    assert.strictEqual(found?.createdAt.toISOString(), '2026-08-30T10:00:00.000Z')
  })

  it('troca de modelo: o turno guarda o seu modelo e nível; a conversa, o consumo por modelo; stats e uso separam', async () => {
    const repo = repository()
    const usageByModel = { 'gemini-3.7-flash': { inputTokens: 100, totalTokens: 100 }, 'gemini-3.1-pro': { inputTokens: 50, totalTokens: 50 } }
    await repo.saveSession(session({ usageByModel, usage: { inputTokens: 150, totalTokens: 150 } }))
    await repo.appendTurn(turn({ index: 0, model: 'gemini-3.7-flash', usage: { inputTokens: 100, totalTokens: 100 } }))
    await repo.appendTurn(turn({ index: 1, model: 'gemini-3.1-pro', effort: 'high', usage: { inputTokens: 50, totalTokens: 50 } }))
    // Um cabeçalho regravado sem o consumo por modelo não o apaga.
    await repo.saveSession(session({ usage: { inputTokens: 150, totalTokens: 150 } }))

    const [first, second] = await repo.listTurns('s1')
    assert.deepStrictEqual([first.model, first.effort, second.model, second.effort], ['gemini-3.7-flash', undefined, 'gemini-3.1-pro', 'high'])
    assert.deepStrictEqual((await repo.findSession('s1'))?.usageByModel, usageByModel)

    const stats = await repo.stats()
    assert.deepStrictEqual(
      stats.byModel.map((item) => [item.model, item.usage.inputTokens]),
      [
        ['gemini-3.7-flash', 100],
        ['gemini-3.1-pro', 50],
      ],
    )

    const rows = await repo.usage({ since: new Date('2026-08-01T00:00:00.000Z'), tzOffsetMinutes: 0 })
    assert.deepStrictEqual(rows.map((row) => [row.model, row.turns]).sort(), [
      ['gemini-3.1-pro', 1],
      ['gemini-3.7-flash', 1],
    ])
  })

  it('never overwrites a turn: a repeated index goes to the next free one', async () => {
    const repo = repository()
    await repo.saveSession(session())
    assert.strictEqual(await repo.appendTurn(turn({ index: 0, request: 'primeira' })), 0)
    await repo.classifyTurn('s1', 0, 'green')

    // Índice repetido (turnos concorrentes, sessão perdida): antes o INSERT OR REPLACE apagava o
    // turno 0 — e a classificação dele. E devolve onde ficou, para o rótulo não cair no turno 0.
    assert.strictEqual(await repo.appendTurn(turn({ index: 0, request: 'segunda' })), 1)

    const turns = await repo.listTurns('s1')
    assert.deepStrictEqual(
      turns.map((item) => [item.index, item.request, item.classification]),
      [
        [0, 'primeira', 'green'],
        [1, 'segunda', undefined],
      ],
    )
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

describe('SqliteConversationRepository — monitor, rótulos e compartilhamento', () => {
  const owner = (id: string, extra: Record<string, string> = {}) => ({ owner: { id, ...extra } })

  describe('classifyTurn', () => {
    it('grava o rótulo no turno e a conversa fica com o PIOR entre os turnos', async () => {
      const repo = repository()
      await repo.saveSession(session({ turns: 3 }))
      for (const index of [0, 1, 2]) await repo.appendTurn(turn({ index }))

      await repo.classifyTurn('s1', 0, 'green')
      assert.strictEqual((await repo.findSession('s1'))?.classification, 'green')

      await repo.classifyTurn('s1', 1, 'red')
      await repo.classifyTurn('s1', 2, 'green')

      // O último turno é `green` e a conversa continua `red`.
      assert.strictEqual((await repo.findSession('s1'))?.classification, 'red')
      assert.deepStrictEqual(
        (await repo.listTurns('s1')).map((stored) => stored.classification),
        ['green', 'red', 'green'],
      )
    })

    it('reclassificar o pior turno para baixo baixa a conversa — o pior é o de hoje', async () => {
      const repo = repository()
      await repo.saveSession(session({ turns: 2 }))
      await repo.appendTurn(turn({ index: 0 }))
      await repo.appendTurn(turn({ index: 1 }))

      await repo.classifyTurn('s1', 0, 'amber')
      await repo.classifyTurn('s1', 1, 'red')
      await repo.classifyTurn('s1', 1, 'blue')

      assert.strictEqual((await repo.findSession('s1'))?.classification, 'amber')
    })

    it('turno inexistente não muda nada, e rótulo desconhecido é recusado sem lançar', async () => {
      const repo = repository()
      await repo.saveSession(session())
      await repo.appendTurn(turn())

      await assert.doesNotReject(() => repo.classifyTurn('s1', 9, 'red'))
      await assert.doesNotReject(() => repo.classifyTurn('s1', 0, 'purple' as never))
      await assert.doesNotReject(() => repo.classifyTurn('nao-existe', 0, 'red'))

      assert.strictEqual((await repo.findSession('s1'))?.classification, undefined)
      assert.strictEqual(await repo.findSession('nao-existe'), undefined)
    })

    it('regravar o cabeçalho a cada turno não apaga o rótulo', async () => {
      const repo = repository()
      await repo.saveSession(session())
      await repo.appendTurn(turn())
      await repo.classifyTurn('s1', 0, 'red')

      await repo.saveSession(session({ turns: 2, updatedAt: new Date('2026-08-30T11:00:00.000Z') }))

      assert.strictEqual((await repo.findSession('s1'))?.classification, 'red')
    })
  })

  describe('pageSessions', () => {
    const seed = async () => {
      const repo = repository()
      const rows: Array<[string, Partial<IConversationSession>, 'green' | 'red' | 'amber' | undefined]> = [
        [
          'a',
          { title: 'Pedido do Cliente Azul', provider: 'google', metadata: owner('u1', { email: 'ana@x.test', account: 'acme' }), updatedAt: new Date('2026-08-30T10:05:00Z') },
          'red',
        ],
        [
          'b',
          { title: 'Estoque baixo', provider: 'google', metadata: owner('u2', { email: 'bia@x.test', account: 'acme' }), updatedAt: new Date('2026-08-30T10:04:00Z') },
          'green',
        ],
        [
          'c',
          { title: 'Preço promocional', provider: 'openai', metadata: owner('u3', { email: 'caio@x.test', account: 'zeta' }), updatedAt: new Date('2026-08-30T10:03:00Z') },
          'red',
        ],
        [
          'd',
          { title: 'Sem rótulo ainda', provider: 'claude', metadata: owner('u1', { email: 'ana@x.test', account: 'acme' }), updatedAt: new Date('2026-08-30T10:02:00Z') },
          undefined,
        ],
        ['e', { title: '100% desconto', provider: 'openai', updatedAt: new Date('2026-08-30T10:01:00Z') }, 'amber'],
      ]

      for (const [id, over, label] of rows) {
        await repo.saveSession(session({ id, ...over }))
        if (label) {
          await repo.appendTurn(turn({ sessionId: id }))
          await repo.classifyTurn(id, 0, label)
        }
      }

      return repo
    }

    it('pagina no banco: o total é de tudo e a página vem em ordem de atualização', async () => {
      const repo = await seed()

      const first = await repo.pageSessions({ page: 1, pageSize: 2 })
      const last = await repo.pageSessions({ page: 3, pageSize: 2 })

      assert.strictEqual(first.total, 5)
      assert.deepStrictEqual(
        first.sessions.map((item) => item.id),
        ['a', 'b'],
      )
      assert.deepStrictEqual(
        last.sessions.map((item) => item.id),
        ['e'],
      )
    })

    it('desempata pelo id: conversas com o mesmo updated_at não repetem nem somem entre páginas', async () => {
      const repo = repository()
      const tied = new Date('2026-08-30T10:00:00Z')
      for (const id of ['m', 'x', 'b', 'q', 'f']) await repo.saveSession(session({ id, updatedAt: tied }))

      const pages = await Promise.all([1, 2, 3].map((page) => repo.pageSessions({ page, pageSize: 2 })))

      assert.deepStrictEqual(
        pages.flatMap((page) => page.sessions.map((item) => item.id)),
        ['x', 'q', 'm', 'f', 'b'],
      )
      assert.deepStrictEqual(
        (await repo.listSessions({})).map((item) => item.id),
        ['x', 'q', 'm', 'f', 'b'],
      )
    })

    it('busca o título, o e-mail, o id e a conta do dono, sem diferenciar caixa', async () => {
      const repo = await seed()
      const ids = async (q: string) => (await repo.pageSessions({ page: 1, pageSize: 10, q })).sessions.map((item) => item.id)

      assert.deepStrictEqual(await ids('CLIENTE azul'), ['a'])
      assert.deepStrictEqual(await ids('bia@'), ['b'])
      assert.deepStrictEqual(await ids('u3'), ['c'])
      assert.deepStrictEqual(await ids('ZETA'), ['c'])
      assert.deepStrictEqual(await ids('acme'), ['a', 'b', 'd'])
    })

    it('o termo digitado é literal: % e _ não viram padrão', async () => {
      const repo = await seed()

      assert.deepStrictEqual(
        (await repo.pageSessions({ page: 1, pageSize: 10, q: '%' })).sessions.map((item) => item.id),
        ['e'],
      )
      assert.deepStrictEqual((await repo.pageSessions({ page: 1, pageSize: 10, q: '_' })).sessions, [])
    })

    it('a aba recorta a lista e o total, mas as contagens são sobre a BUSCA', async () => {
      const repo = await seed()

      const page = await repo.pageSessions({ page: 1, pageSize: 10, q: 'acme', classification: 'red' })

      assert.deepStrictEqual(
        page.sessions.map((item) => item.id),
        ['a'],
      )
      assert.strictEqual(page.total, 1)
      // Com a aba `red` aberta, `green` continua dizendo quantas há dentro da busca; `d` (sem rótulo) não conta.
      assert.deepStrictEqual(page.facets.classification, { red: 1, green: 1 })
      assert.deepStrictEqual(page.facets.provider, { google: 2, claude: 1 })
    })

    it('sem busca as contagens cobrem tudo, e o provider também recorta', async () => {
      const repo = await seed()

      const page = await repo.pageSessions({ page: 1, pageSize: 10, provider: 'openai' })

      assert.deepStrictEqual(
        page.sessions.map((item) => item.id),
        ['c', 'e'],
      )
      assert.deepStrictEqual(page.facets.classification, { red: 2, green: 1, amber: 1 })
      assert.deepStrictEqual(page.facets.provider, { google: 2, openai: 2, claude: 1 })
    })

    it('o agente recorta a lista, e a contagem por agente é sobre a busca', async () => {
      const repo = await seed()
      await repo.saveSession(session({ id: 'z', agentId: 'operador-teste', updatedAt: new Date('2026-08-30T09:00:00Z') }))

      const page = await repo.pageSessions({ page: 1, pageSize: 10, agentId: 'operador-teste' })

      assert.deepStrictEqual(
        page.sessions.map((item) => item.id),
        ['z'],
      )
      assert.strictEqual(page.facets.agent['operador-teste'], 1)
      assert.ok(page.facets.agent[session().agentId] >= 5)
    })

    it('a prévia é o ÚLTIMO turno, encurtada, e some quando não há turno', async () => {
      const repo = repository()
      await repo.saveSession(session({ id: 'p' }))
      assert.strictEqual((await repo.findSession('p'))?.preview, undefined)

      await repo.appendTurn(turn({ sessionId: 'p', index: 0, request: 'primeira', text: 'um' }))
      await repo.appendTurn(turn({ sessionId: 'p', index: 1, request: 'segunda', text: 'x'.repeat(500), at: new Date('2026-08-30T10:09:00Z') }))

      const [listed] = await repo.listSessions({})
      const preview = (await repo.findSession('p'))?.preview
      assert.strictEqual(preview?.request, 'segunda')
      assert.strictEqual(preview?.text.length, PREVIEW_MAX)
      assert.strictEqual(preview?.at.toISOString(), '2026-08-30T10:09:00.000Z')
      assert.deepStrictEqual(listed.preview, preview)
      assert.deepStrictEqual((await repo.pageSessions({ page: 1, pageSize: 1 })).sessions[0].preview, preview)
    })

    it('banco vazio e banco fechado devolvem uma página vazia, não um erro', async () => {
      const repo = repository()
      assert.deepStrictEqual(await repo.pageSessions({ page: 1, pageSize: 10 }), { sessions: [], total: 0, facets: { classification: {}, provider: {}, agent: {} } })

      repo.close()
      assert.strictEqual((await repo.pageSessions({ page: 1, pageSize: 10 })).total, 0)
    })
  })

  describe('listSessions por dono', () => {
    it('devolve só as do dono; conversa com conta exige a mesma conta', async () => {
      const repo = repository()
      await repo.saveSession(session({ id: 'mine', metadata: owner('u1', { account: 'acme' }) }))
      await repo.saveSession(session({ id: 'other-account', metadata: owner('u1', { account: 'zeta' }) }))
      await repo.saveSession(session({ id: 'no-account', metadata: owner('u1') }))
      await repo.saveSession(session({ id: 'bob', metadata: owner('u2', { account: 'acme' }) }))
      await repo.saveSession(session({ id: 'orphan' }))

      const ids = async (filter: Parameters<typeof repo.listSessions>[0]) => (await repo.listSessions(filter)).map((item) => item.id).sort()

      assert.deepStrictEqual(await ids({ owner: { id: 'u1', account: 'acme' } }), ['mine', 'no-account'])
      assert.deepStrictEqual(await ids({ owner: { id: 'u1' } }), ['no-account'])
      assert.deepStrictEqual(await ids({ owner: null }), ['orphan'])
      assert.deepStrictEqual((await ids({})).length, 5)
    })

    it('o limite vale depois do recorte por dono', async () => {
      const repo = repository()
      for (let i = 0; i < 5; i++) await repo.saveSession(session({ id: `bob-${i}`, metadata: owner('bob'), updatedAt: new Date(2026, 7, 30, 12, i) }))
      await repo.saveSession(session({ id: 'mine', metadata: owner('u1'), updatedAt: new Date(2026, 7, 30, 9) }))

      assert.deepStrictEqual(
        (await repo.listSessions({ owner: { id: 'u1' }, limit: 1 })).map((item) => item.id),
        ['mine'],
      )
    })
  })

  describe('compartilhamento', () => {
    it('abre, acha pelo shareId, fecha e reabre com o MESMO link', async () => {
      const repo = repository()
      await repo.saveSession(session())

      assert.strictEqual((await repo.findSession('s1'))?.shared, false, 'ausente é fechado')

      await repo.setShared('s1', true, 'abc123')
      assert.strictEqual((await repo.findByShareId('abc123'))?.id, 's1')
      assert.strictEqual((await repo.findByShareId('abc123'))?.shared, true)

      // Fechar não apaga o shareId: a leitura pública é que passa a recusar.
      await repo.setShared('s1', false)
      const closed = await repo.findByShareId('abc123')
      assert.strictEqual(closed?.shared, false)
      assert.strictEqual(closed?.shareId, 'abc123')

      await repo.setShared('s1', true)
      assert.strictEqual((await repo.findByShareId('abc123'))?.shared, true)
    })

    it('shareId desconhecido ou vazio não acha nada, e o id da sessão não vale como shareId', async () => {
      const repo = repository()
      await repo.saveSession(session())
      await repo.setShared('s1', true, 'abc123')

      assert.strictEqual(await repo.findByShareId('nope'), undefined)
      assert.strictEqual(await repo.findByShareId(''), undefined)
      assert.strictEqual(await repo.findByShareId('s1'), undefined)
    })

    it('regravar o cabeçalho a cada turno não fecha a conversa', async () => {
      const repo = repository()
      await repo.saveSession(session())
      await repo.setShared('s1', true, 'abc123')

      await repo.saveSession(session({ turns: 2 }))

      assert.strictEqual((await repo.findByShareId('abc123'))?.shared, true)
    })

    it('o shareId é único, e a falha de escrita SOBE (é a ação pedida, não o registro)', async () => {
      const repo = repository()
      await repo.saveSession(session({ id: 'a' }))
      await repo.saveSession(session({ id: 'b' }))
      await repo.setShared('a', true, 'same')

      await assert.rejects(() => repo.setShared('b', true, 'same'))

      repo.close()
      await assert.rejects(() => repo.setShared('a', false))
    })
  })

  describe('anexos e agregado', () => {
    it('o turno guarda só o descritivo dos anexos', async () => {
      const repo = repository()
      await repo.saveSession(session())
      await repo.appendTurn(turn({ files: [{ name: 'a.png', mimeType: 'image/png', size: 1234 }] }))
      await repo.appendTurn(turn({ index: 1 }))

      const [first, second] = await repo.listTurns('s1')

      assert.deepStrictEqual(first.files, [{ name: 'a.png', mimeType: 'image/png', size: 1234 }])
      assert.strictEqual(second.files, undefined)
    })

    it('stats traz pessoas e contas distintas e as conversas por sinal', async () => {
      const repo = repository()
      await repo.saveSession(session({ id: 'a', metadata: owner('u1', { account: 'acme' }) }))
      await repo.saveSession(session({ id: 'b', metadata: owner('u1', { account: 'acme' }) }))
      await repo.saveSession(session({ id: 'c', metadata: owner('u2', { account: 'zeta' }) }))
      await repo.saveSession(session({ id: 'd' }))
      await repo.appendTurn(turn({ sessionId: 'a' }))
      await repo.classifyTurn('a', 0, 'red')

      const stats = await repo.stats()

      assert.strictEqual(stats.conversations, 4)
      assert.strictEqual(stats.users, 2, 'conversa sem dono não é um usuário')
      assert.strictEqual(stats.accounts, 2)
      assert.deepStrictEqual(stats.byClassification, { red: 1 })
    })
  })

  it('um arquivo da fase anterior (com cache e tempo, sem rótulo, anexo nem link) migra sem perder nada, e nada nasce aberto', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-db-'))
    const path = join(dir, 'previous.db')

    try {
      const previous = new DatabaseSync(path)
      previous.exec(`
        CREATE TABLE conversations (
          id TEXT NOT NULL PRIMARY KEY, agent_id TEXT NOT NULL, provider TEXT NOT NULL, mode TEXT NOT NULL, model TEXT NOT NULL, title TEXT,
          turns INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
          reasoning_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0, metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE conversation_turns (
          conversation_id TEXT NOT NULL, idx INTEGER NOT NULL, at TEXT NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL, reasoning TEXT, tool_calls TEXT,
          warnings TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER, first_text_ms INTEGER, aborted INTEGER NOT NULL DEFAULT 0, error TEXT, PRIMARY KEY (conversation_id, idx)
        );
        INSERT INTO conversations (id, agent_id, provider, mode, model, title, turns, input_tokens, output_tokens, reasoning_tokens, total_tokens, cache_read_tokens, metadata, created_at, updated_at)
          VALUES ('old', 'a', 'google', 'chat', 'm', 'antiga', 1, 10, 5, 0, 15, 4, '{"owner":{"id":"u1","email":"ana@x.test"}}', '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z');
        INSERT INTO conversation_turns (conversation_id, idx, at, request, response, input_tokens, output_tokens, total_tokens, cache_read_tokens, duration_ms)
          VALUES ('old', 0, '2026-08-01T10:00:00.000Z', 'oi', 'olá', 10, 5, 15, 4, 120);
      `)
      previous.close()

      const repo = new SqliteConversationRepository(path)
      const migrated = await repo.findSession('old')
      const [oldTurn] = await repo.listTurns('old')

      // O que existia continua igual...
      assert.strictEqual(migrated?.title, 'antiga')
      assert.deepStrictEqual(migrated?.metadata, { owner: { id: 'u1', email: 'ana@x.test' } })
      assert.strictEqual(migrated?.usage.cacheReadTokens, 4)
      assert.strictEqual(oldTurn.text, 'olá')
      assert.strictEqual(oldTurn.durationMs, 120)

      // ...e o que é novo começa ausente — e FECHADO, nunca público.
      assert.strictEqual(migrated?.classification, undefined)
      assert.strictEqual(migrated?.shared, false)
      assert.strictEqual(migrated?.shareId, undefined)
      assert.strictEqual(oldTurn.files, undefined)
      assert.strictEqual(await repo.findByShareId('qualquer'), undefined)

      // O arquivo migrado já serve às consultas novas...
      assert.deepStrictEqual(
        (await repo.pageSessions({ page: 1, pageSize: 10, q: 'ana@' })).sessions.map((item) => item.id),
        ['old'],
      )
      assert.deepStrictEqual(
        (await repo.listSessions({ owner: { id: 'u1' } })).map((item) => item.id),
        ['old'],
      )

      // ...e às escritas novas.
      await repo.classifyTurn('old', 0, 'amber')
      await repo.setShared('old', true, 'link-1')
      assert.strictEqual((await repo.findByShareId('link-1'))?.classification, 'amber')
      repo.close()

      // Abrir de novo não tenta recriar coluna nem índice que já existem.
      assert.doesNotThrow(() => new SqliteConversationRepository(path).close())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('usage', () => {
    it('⛔ o recorte por dono isola: o uso de A não soma as conversas de B; o dia sai do turno, no fuso pedido', async () => {
      const repo = repository()
      await repo.saveSession(session({ id: 'da-ana', metadata: { owner: { id: 'ana' } } }))
      await repo.saveSession(session({ id: 'da-bia', metadata: { owner: { id: 'bia' } } }))
      await repo.appendTurn(turn({ sessionId: 'da-ana', index: 0, at: new Date('2026-10-22T01:30:00Z') }))
      await repo.appendTurn(turn({ sessionId: 'da-bia', index: 0, at: new Date('2026-10-22T12:00:00Z') }))

      const mine = await repo.usage({ since: new Date('2026-10-01T00:00:00Z'), tzOffsetMinutes: -180, owner: { id: 'ana' } })
      assert.deepStrictEqual(
        mine.map((item) => [item.conversationId, item.day]),
        [['da-ana', '2026-10-21']],
      )

      const all = await repo.usage({ since: new Date('2026-10-01T00:00:00Z'), tzOffsetMinutes: 0 })
      assert.deepStrictEqual(all.map((item) => item.ownerId).sort(), ['ana', 'bia'])
      assert.deepStrictEqual(await repo.usage({ since: new Date('2026-10-23T00:00:00Z'), tzOffsetMinutes: 0 }), [])
    })
  })

  it('o contexto em uso: o turno e a conversa guardam o da última chamada; um turno sem o dado não apaga o da conversa', async () => {
    const repo = repository()
    await repo.saveSession(session({ usage: { inputTokens: 900, totalTokens: 900, contextTokens: 600 } }))
    await repo.appendTurn(turn({ index: 0, usage: { inputTokens: 900, totalTokens: 900, contextTokens: 600 } }))
    assert.strictEqual((await repo.findSession('s1'))?.usage.contextTokens, 600)
    assert.strictEqual((await repo.listTurns('s1'))[0].usage?.contextTokens, 600)

    // Codex e Antigravity não informam: a conversa segue com o último que se soube.
    await repo.saveSession(session({ usage: { inputTokens: 1500, totalTokens: 1500 } }))
    assert.strictEqual((await repo.findSession('s1'))?.usage.contextTokens, 600)
  })

  it('guarda, lê e limpa o estado do SDK da conversa', async () => {
    const repo = new SqliteConversationRepository(':memory:')
    const now = new Date()
    await repo.saveSession({ id: 'c1', agentId: 'a', provider: 'claude', mode: 'agent', model: 'm', createdAt: now, updatedAt: now, turns: 1, usage: {} })
    assert.strictEqual(await repo.findNative('c1'), undefined)
    await repo.saveNative('c1', { protocol: 'claude', mode: 'agent', data: { sdkSessionId: 'abc' } })
    assert.deepStrictEqual(await repo.findNative('c1'), { protocol: 'claude', mode: 'agent', data: { sdkSessionId: 'abc' } })
    await repo.saveSession({ id: 'c1', agentId: 'a', provider: 'claude', mode: 'agent', model: 'm', createdAt: now, updatedAt: now, turns: 2, usage: {} })
    assert.ok(await repo.findNative('c1'), 'regravar o cabeçalho não apaga o estado')
    await repo.saveNative('c1', null)
    assert.strictEqual(await repo.findNative('c1'), undefined)
  })
})
