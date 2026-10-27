import { parseUsageKey } from '@domain/models/Session.Model'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { isClassification, TClassification, worstOf } from '@domain/models/Classification.Model'
import {
  IConversationPage,
  IConversationPageQuery,
  IConversationSession,
  IConversationStats,
  IConversationTurn,
  IOwnerFilter,
  IStoredUsage,
  PREVIEW_MAX,
} from '@domain/models/Conversation.Model'
import { IUsageQuery, IUsageRow, metadataKeyIssue } from '@domain/models/Usage.Model'
import { IConversationRepository } from '@domain/ports/ConversationRepository.Port'

/**
 * Onde o arquivo fica quando ninguém escolheu. Relativo ao processo, como o resto da configuração.
 */
export const DEFAULT_DB_PATH = 'data/gateway.db'

/**
 * O esquema, em UM lugar só: aqui.
 *
 * ⚖️ Um `schema.sql` ao lado seria mais legível e viraria mentira no primeiro `ALTER` feito só de um
 * lado. E carregá-lo em runtime traria de volta o problema de resolver caminho depois do build, que
 * é o tipo de defeito que só aparece dentro do container.
 *
 * ⚠️ Os três campos de token são SEPARADOS e `NOT NULL DEFAULT 0`. Separados porque o raciocínio é
 * cobrado como saída, e somá-lo ali daria o total certo apagando a informação que interessa: quanto
 * do gasto foi o modelo pensando. `NOT NULL` porque `NULL` em contador contamina toda soma feita em
 * cima dele depois — e o sintoma é um relatório com o número faltando, não um erro.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversations (
    id               TEXT    NOT NULL PRIMARY KEY,
    agent_id         TEXT    NOT NULL,
    provider         TEXT    NOT NULL,
    mode             TEXT    NOT NULL,
    model            TEXT    NOT NULL,
    title            TEXT,
    turns            INTEGER NOT NULL DEFAULT 0,
    input_tokens     INTEGER NOT NULL DEFAULT 0,
    output_tokens    INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    metadata         TEXT,
    classification   TEXT,
    shared           INTEGER NOT NULL DEFAULT 0,
    share_id         TEXT,
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_recent ON conversations (updated_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_conversations_model ON conversations (provider, model);

  CREATE TABLE IF NOT EXISTS conversation_turns (
    conversation_id  TEXT    NOT NULL,
    idx              INTEGER NOT NULL,
    at               TEXT    NOT NULL,
    request          TEXT    NOT NULL,
    response         TEXT    NOT NULL,
    files            TEXT,
    reasoning        TEXT,
    tool_calls       TEXT,
    warnings         TEXT,
    input_tokens     INTEGER NOT NULL DEFAULT 0,
    output_tokens    INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms      INTEGER,
    first_text_ms    INTEGER,
    aborted          INTEGER NOT NULL DEFAULT 0,
    error            TEXT,
    classification   TEXT,
    PRIMARY KEY (conversation_id, idx),
    FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
  );
`

/**
 * Colunas que nasceram depois da primeira versão do esquema.
 *
 * ⚖️ ADITIVO, e conferido antes: o `CREATE TABLE IF NOT EXISTS` não toca numa tabela que já existe,
 * então um arquivo criado antes destas colunas continuaria sem elas. `ALTER TABLE ADD COLUMN` não
 * apaga nem reescreve linha — o histórico fica como estava, com o default nas linhas antigas. O
 * SQLite não tem `ADD COLUMN IF NOT EXISTS`, por isso a checagem em `PRAGMA table_info`.
 *
 * Cache e tempo só existem nas conversas novas: as antigas contam zero de cache e ficam sem tempo.
 *
 * ⚠️ `shared` NASCE ZERO: toda conversa anterior continua FECHADA. É o padrão que o `ALTER` dá às
 * linhas antigas, e é o único que serve — um padrão que abrisse publicaria o histórico inteiro na
 * primeira subida. `classification` e `files` ficam `NULL`: sem rótulo e sem anexo registrado.
 */
const ADDED_COLUMNS: Array<{ table: string; column: string; definition: string }> = [
  { table: 'conversations', column: 'cache_read_tokens', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'conversations', column: 'cache_write_tokens', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'conversation_turns', column: 'cache_read_tokens', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'conversation_turns', column: 'cache_write_tokens', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'conversation_turns', column: 'duration_ms', definition: 'INTEGER' },
  { table: 'conversation_turns', column: 'first_text_ms', definition: 'INTEGER' },
  { table: 'conversations', column: 'classification', definition: 'TEXT' },
  { table: 'conversations', column: 'shared', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'conversations', column: 'share_id', definition: 'TEXT' },
  { table: 'conversation_turns', column: 'files', definition: 'TEXT' },
  { table: 'conversation_turns', column: 'classification', definition: 'TEXT' },
  { table: 'conversation_turns', column: 'model', definition: 'TEXT' },
  { table: 'conversation_turns', column: 'effort', definition: 'TEXT' },
  { table: 'conversations', column: 'usage_by_model', definition: 'TEXT' },
  { table: 'conversation_turns', column: 'provider', definition: 'TEXT' },
  // O contexto em uso na última chamada ao modelo (não se soma; `NULL` = o provider não informa).
  { table: 'conversations', column: 'context_tokens', definition: 'INTEGER' },
  { table: 'conversation_turns', column: 'context_tokens', definition: 'INTEGER' },
]

/**
 * Índices sobre colunas que podem ter nascido na migração.
 *
 * ⚠️ Rodam DEPOIS dela, e não junto do `SCHEMA`: num arquivo antigo o `CREATE INDEX` do esquema
 * apontaria para uma coluna que ainda não existe e derrubaria o boot. `share_id` é ÚNICO — é a chave
 * pública do link, e dois registros com o mesmo abririam a conversa errada; `NULL` não colide.
 */
const ADDED_INDEXES = [
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_share ON conversations (share_id)',
  'CREATE INDEX IF NOT EXISTS idx_conversations_classification ON conversations (classification)',
  // O uso recorta os turnos por período: sem índice em `at`, cada consulta leria a tabela inteira.
  'CREATE INDEX IF NOT EXISTS idx_turns_at ON conversation_turns (at)',
  // A caixa de entrada e o monitor recortam por projeto (a chave `project` do metadata).
  "CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations (json_extract(metadata, '$.project'))",
  // Substituído por `idx_conversations_recent`, que cobre o desempate por `id`.
  'DROP INDEX IF EXISTS idx_conversations_updated',
]

/**
 * A ordem das listagens. ⚠️ O `id` desempata: `updated_at` tem resolução de milissegundo e empata
 * fácil (importação, turnos simultâneos); sem desempate o SQLite devolve os empatados em qualquer
 * ordem, e o `OFFSET` repete uma conversa numa página e some com outra.
 */
const RECENT_FIRST = 'ORDER BY updated_at DESC, id DESC'

/**
 * O cabeçalho mais a prévia do último turno, lida na hora.
 *
 * ⚖️ Subconsulta e não coluna: a chave `(conversation_id, idx)` acha o último turno direto pelo
 * índice, e numa página de até 50 linhas isso é barato. Uma coluna copiada no cabeçalho seria mais
 * uma escrita por turno — e a primeira vez que divergisse, a lista mostraria o que a conversa não diz.
 */
const LAST_TURN = (expression: string, alias: string) =>
  `(SELECT ${expression} FROM conversation_turns WHERE conversation_turns.conversation_id = conversations.id ORDER BY idx DESC LIMIT 1) AS ${alias}`
const SESSION_COLUMNS = [
  'conversations.*',
  LAST_TURN(`substr(request, 1, ${PREVIEW_MAX})`, 'last_request'),
  LAST_TURN(`substr(response, 1, ${PREVIEW_MAX})`, 'last_response'),
  LAST_TURN('at', 'last_at'),
].join(', ')

/** Onde mora o dono dentro do `metadata`. Fixo e sem entrada de fora: vai para dentro do SQL. */
const OWNER_ID = "json_extract(metadata, '$.owner.id')"
const OWNER_EMAIL = "json_extract(metadata, '$.owner.email')"
const OWNER_ACCOUNT = "json_extract(metadata, '$.owner.account')"

/** O que a busca do monitor procura: o que a tela mostra na linha. */
const SEARCH_EXPRESSIONS = ['title', OWNER_EMAIL, OWNER_ID, OWNER_ACCOUNT]

/** Só identificador simples vira caminho JSON. Ver `listSessions`. */
const SAFE_KEY = /^[A-Za-z0-9_]+$/

type TRow = Record<string, unknown>

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function count(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0)
}

/** Coluna que aceita `NULL` (tempo): ausente continua ausente, em vez de virar zero. */
function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function usageOf(row: TRow): IStoredUsage {
  return {
    inputTokens: count(row.input_tokens),
    outputTokens: count(row.output_tokens),
    reasoningTokens: count(row.reasoning_tokens),
    totalTokens: count(row.total_tokens),
    cacheReadTokens: count(row.cache_read_tokens),
    cacheWriteTokens: count(row.cache_write_tokens),
    ...(typeof row.context_tokens === 'number' ? { contextTokens: row.context_tokens } : {}),
  }
}

/**
 * O recorte por dono, no mesmo critério de `ownsSession` no controller.
 *
 * ⚖️ `null` é "só as SEM dono" (o escopo do chamador anônimo); `{ id, account }` é "as dele", e quando a
 * conversa tem conta ela precisa ser a mesma — a mesma pessoa costuma ter acesso a mais de uma conta, e
 * trocar de conta não pode continuar mostrando as da anterior. Sempre parâmetro: o valor nunca vira texto
 * de SQL.
 */
function ownerClause(owner: IOwnerFilter | null): { sql: string; params: string[] } {
  if (owner === null) return { sql: `${OWNER_ID} IS NULL`, params: [] }

  return { sql: `(${OWNER_ID} = ? AND (COALESCE(${OWNER_ACCOUNT}, '') = '' OR ${OWNER_ACCOUNT} = ?))`, params: [owner.id, owner.account ?? ''] }
}

/**
 * A conversa gravada em SQLite — um arquivo, sem servidor e sem dependência.
 *
 * ⚖️ `node:sqlite` em vez de um pacote. Um driver de banco é a dependência que mais dá trabalho num
 * projeto pequeno: compila nativo, quebra em troca de versão do Node, e obriga a subir um servidor
 * para rodar um teste. Aqui é um arquivo e um `import`.
 *
 * ⛔ NENHUM MÉTODO AQUI PODE DERRUBAR UM TURNO. Toda operação engole o próprio erro e registra: se o
 * disco encher ou o arquivo travar, a conversa continua acontecendo e o registro é o que se perde.
 * Perder o registro de um turno é ruim; perder o turno de quem estava trabalhando é pior.
 */
export class SqliteConversationRepository implements IConversationRepository {
  private readonly db: DatabaseSync

  constructor(path: string = DEFAULT_DB_PATH) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })

    this.db = new DatabaseSync(path)

    // WAL para leitura não bloquear escrita: listar o histórico enquanto um turno grava é o uso
    // normal, não a exceção. `foreign_keys` porque no SQLite ele vem DESLIGADO — sem isto o
    // `ON DELETE CASCADE` declarado acima seria decorativo.
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
    this.migrate()
  }

  /** Acrescenta as colunas que um arquivo antigo ainda não tem. Nunca remove nem reescreve nada. */
  private migrate(): void {
    for (const { table, column, definition } of ADDED_COLUMNS) {
      const existing = this.db.prepare(`PRAGMA table_info(${table})`).all() as TRow[]
      if (existing.some((row) => row.name === column)) continue

      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }

    for (const statement of ADDED_INDEXES) this.db.exec(statement)
  }

  async saveSession(session: IConversationSession): Promise<void> {
    this.guard('saveSession', () => {
      /**
       * ⚠️ `COALESCE` no título e no `created_at`.
       *
       * O cabeçalho é regravado a cada turno, e a partir do segundo o título vem `undefined` de
       * propósito — quem grava não quer trocá-lo. Sem o `COALESCE`, o `excluded` sobrescreveria com
       * `NULL` e a conversa perderia o rótulo no segundo turno.
       */
      this.db
        .prepare(
          `INSERT INTO conversations (id, agent_id, provider, mode, model, title, turns, input_tokens, output_tokens, reasoning_tokens, total_tokens, cache_read_tokens, cache_write_tokens, context_tokens, usage_by_model, metadata, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             agent_id = excluded.agent_id,
             provider = excluded.provider,
             mode = excluded.mode,
             model = excluded.model,
             title = COALESCE(excluded.title, conversations.title),
             turns = excluded.turns,
             input_tokens = excluded.input_tokens,
             output_tokens = excluded.output_tokens,
             reasoning_tokens = excluded.reasoning_tokens,
             total_tokens = excluded.total_tokens,
             cache_read_tokens = excluded.cache_read_tokens,
             cache_write_tokens = excluded.cache_write_tokens,
             context_tokens = COALESCE(excluded.context_tokens, conversations.context_tokens),
             usage_by_model = COALESCE(excluded.usage_by_model, conversations.usage_by_model),
             metadata = COALESCE(excluded.metadata, conversations.metadata),
             created_at = COALESCE(conversations.created_at, excluded.created_at),
             updated_at = excluded.updated_at`,
        )
        .run(
          session.id,
          session.agentId,
          session.provider,
          session.mode,
          session.model,
          session.title ?? null,
          session.turns,
          session.usage.inputTokens ?? 0,
          session.usage.outputTokens ?? 0,
          session.usage.reasoningTokens ?? 0,
          session.usage.totalTokens ?? 0,
          session.usage.cacheReadTokens ?? 0,
          session.usage.cacheWriteTokens ?? 0,
          session.usage.contextTokens ?? null,
          session.usageByModel ? JSON.stringify(session.usageByModel) : null,
          session.metadata ? JSON.stringify(session.metadata) : null,
          session.createdAt.toISOString(),
          session.updatedAt.toISOString(),
        )
    })
  }

  async appendTurn(turn: IConversationTurn): Promise<number | undefined> {
    return this.guard('appendTurn', () => {
      /**
       * ⛔ NUNCA SOBRESCREVE. O índice pedido vale se estiver livre; se já existir turno ali, este vai
       * para o próximo índice livre. Antes era `INSERT OR REPLACE`: um índice repetido (turnos
       * concorrentes, sessão que saiu do store) apagava o turno anterior — e a classificação dele.
       * Uma instrução só: com o driver síncrono, a escolha do índice e a escrita não se separam.
       */
      const stored = this.db
        .prepare(
          `INSERT INTO conversation_turns
             (conversation_id, idx, at, request, files, response, reasoning, tool_calls, warnings, input_tokens, output_tokens, reasoning_tokens, total_tokens, cache_read_tokens, cache_write_tokens, context_tokens, duration_ms, first_text_ms, aborted, error, classification, model, effort, provider)
           VALUES (?, CASE WHEN EXISTS (SELECT 1 FROM conversation_turns WHERE conversation_id = ? AND idx = ?)
                        THEN (SELECT MAX(idx) + 1 FROM conversation_turns WHERE conversation_id = ?)
                        ELSE ? END,
                   ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING idx`,
        )
        .get(
          turn.sessionId,
          turn.sessionId,
          turn.index,
          turn.sessionId,
          turn.index,
          turn.at.toISOString(),
          turn.request,
          // Só o descritivo dos anexos. O base64 nunca chega aqui (ver `IConversationTurn.files`).
          turn.files?.length ? JSON.stringify(turn.files) : null,
          turn.text,
          turn.reasoning ?? null,
          turn.toolCalls?.length ? JSON.stringify(turn.toolCalls) : null,
          turn.warnings?.length ? JSON.stringify(turn.warnings) : null,
          turn.usage?.inputTokens ?? 0,
          turn.usage?.outputTokens ?? 0,
          turn.usage?.reasoningTokens ?? 0,
          turn.usage?.totalTokens ?? 0,
          turn.usage?.cacheReadTokens ?? 0,
          turn.usage?.cacheWriteTokens ?? 0,
          turn.usage?.contextTokens ?? null,
          turn.durationMs ?? null,
          turn.firstTextMs ?? null,
          // O driver aceita number, não boolean.
          turn.aborted ? 1 : 0,
          turn.error ?? null,
          turn.classification ?? null,
          turn.model ?? null,
          turn.effort ?? null,
          turn.provider ?? null,
        ) as TRow
      return Number(stored.idx)
    })
  }

  async assignProject(agentIds: readonly string[], projectId: string): Promise<number> {
    if (!agentIds.length) return 0
    return (
      this.guard('assignProject', () =>
        Number(
          this.db
            .prepare(`UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.project', ?) WHERE agent_id IN (${agentIds.map(() => '?').join(', ')})`)
            .run(projectId, ...agentIds).changes,
        ),
      ) ?? 0
    )
  }

  async listSessions(options: { limit?: number; filter?: Record<string, unknown>; owner?: IOwnerFilter | null } = {}): Promise<IConversationSession[]> {
    return (
      this.guard('listSessions', () => {
        const where: string[] = []
        const params: Array<string | number> = []

        for (const [key, value] of Object.entries(options.filter ?? {})) {
          /**
           * ⛔ A CHAVE VAI PARA DENTRO DO SQL, então ela é validada — o valor é sempre parâmetro.
           *
           * Não há como parametrizar um caminho JSON; ele é parte do texto da consulta. Uma chave
           * arbitrária vinda de fora seria injeção. Chave que não passa é IGNORADA, não descartada
           * em silêncio: ignorar um filtro alarga o resultado, então o registro fica no log.
           */
          if (!SAFE_KEY.test(key)) {
            console.warn(`[sqlite] filtro ignorado: "${key}" não é um identificador simples`)
            continue
          }

          where.push(`json_extract(metadata, '$.${key}') = ?`)
          params.push(typeof value === 'number' ? value : String(value))
        }

        if (options.owner !== undefined) {
          const owner = ownerClause(options.owner)
          where.push(owner.sql)
          params.push(...owner.params)
        }

        const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''

        const rows = this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM conversations ${clause} ${RECENT_FIRST} LIMIT ?`).all(...params, limit) as TRow[]

        return rows.map((row) => this.toSession(row))
      }) ?? []
    )
  }

  /**
   * Uma página de TODAS as conversas, com o total e as contagens das abas — tudo no banco.
   *
   * ⚖️ `facets` conta sobre a BUSCA e não sobre a aba (classificação e provider): com a aba "red"
   * aberta, as outras continuam dizendo quantas há. Contar sobre a página daria um número que muda ao
   * paginar. Paginação por `LIMIT/OFFSET`: a tela navega por número de página, e na escala de um
   * monitor o `OFFSET` sobre o índice de `updated_at` é barato.
   *
   * ⚠️ A busca é `instr(lower(campo), termo)`, não `LIKE`: o termo digitado nunca é padrão, então `%`
   * e `_` valem como o que são, sem escape. Em contrapartida o `lower` do SQLite só dobra ASCII —
   * "JOÃO" não acha "joão".
   */
  async pageSessions(query: IConversationPageQuery): Promise<IConversationPage> {
    const empty: IConversationPage = { sessions: [], total: 0, facets: { classification: {}, provider: {}, agent: {} } }

    return (
      this.guard('pageSessions', () => {
        const search: string[] = []
        const searchParams: string[] = []

        // O projeto recorta TUDO (a lista e as contagens das abas): é o espaço em que o monitor está.
        if (query.project) {
          search.push(`json_extract(metadata, '$.project') = ?`)
          searchParams.push(query.project)
        }

        const term = query.q?.trim().toLowerCase()
        if (term) {
          search.push(`(${SEARCH_EXPRESSIONS.map((expression) => `instr(lower(COALESCE(${expression}, '')), ?) > 0`).join(' OR ')})`)
          searchParams.push(...SEARCH_EXPRESSIONS.map(() => term))
        }

        const tab: string[] = []
        const tabParams: string[] = []
        if (query.classification) {
          tab.push('classification = ?')
          tabParams.push(query.classification)
        }
        if (query.provider) {
          tab.push('provider = ?')
          tabParams.push(query.provider)
        }
        if (query.agentId) {
          tab.push('agent_id = ?')
          tabParams.push(query.agentId)
        }

        const searchClause = search.length ? `WHERE ${search.join(' AND ')}` : ''
        const listClause = [...search, ...tab].length ? `WHERE ${[...search, ...tab].join(' AND ')}` : ''
        const listParams = [...searchParams, ...tabParams]

        const pageSize = Math.min(Math.max(Math.trunc(query.pageSize) || 1, 1), 500)
        const page = Math.max(Math.trunc(query.page) || 1, 1)

        const rows = this.db
          .prepare(`SELECT ${SESSION_COLUMNS} FROM conversations ${listClause} ${RECENT_FIRST} LIMIT ? OFFSET ?`)
          .all(...listParams, pageSize, (page - 1) * pageSize) as TRow[]
        const total = this.db.prepare(`SELECT COUNT(*) AS n FROM conversations ${listClause}`).get(...listParams) as TRow

        const facet = (column: string): Record<string, number> => {
          const grouped = this.db.prepare(`SELECT ${column} AS value, COUNT(*) AS n FROM conversations ${searchClause} GROUP BY ${column}`).all(...searchParams) as TRow[]

          // Sem rótulo (conversa ainda não classificada) não vira aba.
          return Object.fromEntries(grouped.filter((row) => typeof row.value === 'string' && row.value).map((row) => [row.value as string, count(row.n)]))
        }

        return {
          sessions: rows.map((row) => this.toSession(row)),
          total: count(total.n),
          facets: { classification: facet('classification'), provider: facet('provider'), agent: facet('agent_id') },
        }
      }) ?? empty
    )
  }

  /**
   * Rotula o turno e recalcula a conversa como o PIOR entre todos os turnos rotulados.
   *
   * ⚠️ Recalculado sobre os turnos, e não "pior entre o atual e o novo": reclassificar um turno para
   * baixo (um classificador melhor, uma correção manual) precisa poder baixar a conversa, e o único
   * jeito de saber o pior de hoje é olhar todos. Turno que não existe não muda nada — um rótulo que
   * chega depois de a conversa ser apagada não pode ressuscitá-la.
   */
  async classifyTurn(sessionId: string, index: number, classification: TClassification): Promise<void> {
    this.guard('classifyTurn', () => {
      if (!isClassification(classification)) throw new Error(`classificação desconhecida: ${String(classification)}`)

      const updated = this.db.prepare('UPDATE conversation_turns SET classification = ? WHERE conversation_id = ? AND idx = ?').run(classification, sessionId, index)
      if (!updated.changes) return

      const labels = this.db.prepare('SELECT classification FROM conversation_turns WHERE conversation_id = ? AND classification IS NOT NULL').all(sessionId) as TRow[]
      const worst = worstOf(labels.map((row) => row.classification as TClassification))

      this.db.prepare('UPDATE conversations SET classification = ? WHERE id = ?').run(worst ?? null, sessionId)
    })
  }

  async listTurns(sessionId: string): Promise<IConversationTurn[]> {
    return (
      this.guard('listTurns', () => {
        const rows = this.db.prepare('SELECT * FROM conversation_turns WHERE conversation_id = ? ORDER BY idx ASC').all(sessionId) as TRow[]

        return rows.map((row) => this.toTurn(row))
      }) ?? []
    )
  }

  async findSession(sessionId: string): Promise<IConversationSession | undefined> {
    return this.guard('findSession', () => {
      const row = this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM conversations WHERE id = ?`).get(sessionId) as TRow | undefined

      return row ? this.toSession(row) : undefined
    })
  }

  async findByShareId(shareId: string): Promise<IConversationSession | undefined> {
    return this.guard('findByShareId', () => {
      if (!shareId) return undefined

      const row = this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM conversations WHERE share_id = ?`).get(shareId) as TRow | undefined

      return row ? this.toSession(row) : undefined
    })
  }

  /**
   * ⛔ NÃO ENGOLE O ERRO, ao contrário do resto deste arquivo. Lá o princípio é não derrubar o turno
   * por causa do registro; aqui a escrita É a ação pedida, e falhar em silêncio diria "descompartilhado"
   * com o link ainda aberto. O `shareId` só é gravado quando vem: fechar não o apaga, para reabrir
   * devolver o MESMO link.
   */
  async setShared(sessionId: string, shared: boolean, shareId?: string): Promise<void> {
    if (shareId) this.db.prepare('UPDATE conversations SET shared = ?, share_id = ? WHERE id = ?').run(shared ? 1 : 0, shareId, sessionId)
    else this.db.prepare('UPDATE conversations SET shared = ? WHERE id = ?').run(shared ? 1 : 0, sessionId)
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.guard('deleteSession', () => {
      // Os turnos saem pelo `ON DELETE CASCADE` — que só funciona com `foreign_keys` ligado, feito
      // no construtor. NÃO encosta na sessão viva do provider: apagar histórico não para conversa.
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(sessionId)
    })
  }

  /**
   * ⚖️ SOMADO NO BANCO, não sobre a página listada. Somar em cima de uma listagem daria um número
   * que parece total e não é, e que muda de valor conforme a paginação — erro que não se denuncia,
   * porque o painel continua bonito com o número errado.
   */
  /**
   * O uso por dia de conversa, no fuso de quem pergunta.
   *
   * ⚠️ O DIA SAI DO `at` DO TURNO, não do `updated_at` da conversa: uma conversa de três dias soma em
   * cada dia o que gastou nele. O fuso vai como modificador do `datetime` do SQLite (`'-180 minutes'`),
   * sempre parâmetro.
   */
  async usage(query: IUsageQuery): Promise<IUsageRow[]> {
    return (
      this.guard('usage', () => {
        const where = ['t.at >= ?']
        const params: Array<string | number> = [`${Math.trunc(query.tzOffsetMinutes)} minutes`, query.since.toISOString()]

        if (query.owner !== undefined) {
          // O recorte de dono é escrito sobre `metadata` sem prefixo: aqui ela é a da conversa (`c`).
          const owner = ownerClause(query.owner)
          where.push(owner.sql.replaceAll('json_extract(metadata', 'json_extract(c.metadata'))
          params.push(...owner.params)
        }

        /**
         * ⛔ A chave vira caminho JSON DENTRO do SQL: só passa a que `metadataKeyIssue` aceita (lança, e o
         * `guard` devolve vazio — quem valida antes, com a mensagem, é o controller). O valor é parâmetro.
         */
        const path = (key: string) => {
          if (metadataKeyIssue(key)) throw new Error(`metadata key not allowed: ${key}`)
          return `CAST(json_extract(c.metadata, '$.${key}') AS TEXT)`
        }
        for (const [key, value] of Object.entries(query.metadata ?? {})) {
          where.push(`${path(key)} = ?`)
          params.push(value)
        }
        const group = query.groupBy ? `${path(query.groupBy)} AS group_value,` : ''

        const rows = this.db
          .prepare(
            `SELECT date(datetime(t.at, ?)) AS day, t.conversation_id AS conversation_id, c.title AS title, ${group}
                    json_extract(c.metadata, '$.owner.id') AS owner_id, json_extract(c.metadata, '$.owner.email') AS owner_email,
                    c.agent_id AS agent_id, COALESCE(t.provider, c.provider) AS provider, COALESCE(t.model, c.model) AS model, COUNT(*) AS turns,
                    SUM(t.input_tokens) AS input_tokens, SUM(t.output_tokens) AS output_tokens, SUM(t.reasoning_tokens) AS reasoning_tokens,
                    SUM(t.total_tokens) AS total_tokens, SUM(t.cache_read_tokens) AS cache_read_tokens, SUM(t.cache_write_tokens) AS cache_write_tokens
             FROM conversation_turns t JOIN conversations c ON c.id = t.conversation_id
             WHERE ${where.join(' AND ')}
             GROUP BY day, t.conversation_id, COALESCE(t.provider, c.provider), COALESCE(t.model, c.model)
             ORDER BY day ASC`,
          )
          .all(...params) as TRow[]

        return rows.map((row) => ({
          day: text(row.day),
          conversationId: text(row.conversation_id),
          title: typeof row.title === 'string' ? row.title : undefined,
          ownerId: typeof row.owner_id === 'string' ? row.owner_id : undefined,
          ownerEmail: typeof row.owner_email === 'string' ? row.owner_email : undefined,
          agentId: text(row.agent_id),
          provider: text(row.provider),
          model: text(row.model),
          ...(typeof row.group_value === 'string' ? { group: row.group_value } : {}),
          turns: count(row.turns),
          usage: usageOf(row),
        }))
      }) ?? []
    )
  }

  async stats(): Promise<IConversationStats> {
    const empty: IConversationStats = { conversations: 0, turns: 0, users: 0, accounts: 0, usage: {}, byModel: [], byClassification: {} }

    return (
      this.guard('stats', () => {
        const totals = this.db
          .prepare(
            `SELECT COUNT(*) AS conversations, COALESCE(SUM(turns), 0) AS turns,
                    COUNT(DISTINCT ${OWNER_ID}) AS users, COUNT(DISTINCT ${OWNER_ACCOUNT}) AS accounts,
                    COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
                    COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens, COALESCE(SUM(total_tokens), 0) AS total_tokens,
                    COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens, COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens
             FROM conversations`,
          )
          .get() as TRow

        /**
         * ⚖️ Por conversa, e — quando ela registra o consumo por modelo (trocou de modelo no meio) — por
         * cada modelo dela; as antigas contam inteiras no modelo da conversa. Somado aqui, e não em SQL,
         * porque o consumo por modelo é um JSON por linha.
         */
        const rows = this.db.prepare('SELECT * FROM conversations').all() as TRow[]
        const models = new Map<string, { provider: string; model: string; conversations: number; usage: Required<Omit<IStoredUsage, 'contextTokens'>> }>()
        for (const row of rows) {
          const byModel = json<Record<string, IStoredUsage> | undefined>(row.usage_by_model, undefined)
          const entries = byModel && Object.keys(byModel).length ? Object.entries(byModel) : [[text(row.model), usageOf(row)] as const]
          for (const [usageKey, usage] of entries) {
            // A chave é `provider|modelo` (a conversa pode ter trocado de provider); a antiga, só o modelo.
            const { provider, model } = parseUsageKey(usageKey, text(row.provider))
            const key = `${provider}\u0000${model}`
            const entry = models.get(key) ?? models.set(key, { provider, model, conversations: 0, usage: usageOf({}) as Required<Omit<IStoredUsage, 'contextTokens'>> }).get(key)!
            entry.conversations += 1
            for (const field of Object.keys(entry.usage) as Array<keyof typeof entry.usage>) entry.usage[field] += usage[field] ?? 0
          }
        }
        const byModel = [...models.values()].sort((a, b) => b.usage.totalTokens - a.usage.totalTokens)

        const bySignal = this.db.prepare('SELECT classification, COUNT(*) AS n FROM conversations WHERE classification IS NOT NULL GROUP BY classification').all() as TRow[]

        return {
          conversations: count(totals.conversations),
          turns: count(totals.turns),
          // `COUNT(DISTINCT)` ignora `NULL`: conversa sem dono não vira um "usuário" fantasma.
          users: count(totals.users),
          accounts: count(totals.accounts),
          usage: usageOf(totals),
          byModel,
          byClassification: Object.fromEntries(bySignal.map((row) => [text(row.classification), count(row.n)])),
        }
      }) ?? empty
    )
  }

  close(): void {
    this.guard('close', () => this.db.close())
  }

  private toSession(row: TRow): IConversationSession {
    return {
      id: text(row.id),
      agentId: text(row.agent_id),
      provider: text(row.provider),
      mode: text(row.mode),
      model: text(row.model),
      title: typeof row.title === 'string' ? row.title : undefined,
      createdAt: new Date(text(row.created_at)),
      updatedAt: new Date(text(row.updated_at)),
      turns: count(row.turns),
      classification: isClassification(row.classification) ? row.classification : undefined,
      usage: usageOf(row),
      usageByModel: json<Record<string, IStoredUsage> | undefined>(row.usage_by_model, undefined),
      metadata: json<Record<string, unknown> | undefined>(row.metadata, undefined),
      // Sempre booleano: a coluna é `NOT NULL DEFAULT 0`, então "ausente" é "fechada".
      shared: count(row.shared) === 1,
      shareId: typeof row.share_id === 'string' ? row.share_id : undefined,
      preview: typeof row.last_at === 'string' ? { at: new Date(row.last_at), request: text(row.last_request), text: text(row.last_response) } : undefined,
    }
  }

  private toTurn(row: TRow): IConversationTurn {
    return {
      sessionId: text(row.conversation_id),
      index: count(row.idx),
      at: new Date(text(row.at)),
      request: text(row.request),
      files: json<IConversationTurn['files']>(row.files, undefined),
      text: text(row.response),
      reasoning: typeof row.reasoning === 'string' ? row.reasoning : undefined,
      model: typeof row.model === 'string' ? row.model : undefined,
      ...(typeof row.provider === 'string' ? { provider: row.provider } : {}),
      effort: typeof row.effort === 'string' ? row.effort : undefined,
      toolCalls: json<IConversationTurn['toolCalls']>(row.tool_calls, []),
      usage: usageOf(row),
      durationMs: optionalCount(row.duration_ms),
      firstTextMs: optionalCount(row.first_text_ms),
      warnings: json<string[] | undefined>(row.warnings, undefined),
      aborted: count(row.aborted) === 1 || undefined,
      error: typeof row.error === 'string' ? row.error : undefined,
      classification: isClassification(row.classification) ? row.classification : undefined,
    }
  }

  /**
   * ⛔ O ponto onde o contrato do port é honrado: falha de banco NÃO sobe.
   *
   * Devolve `undefined` no erro para quem lê cair no próprio default. Silêncio total seria pior que
   * o erro — por isso registra, com o nome da operação.
   */
  private guard<T>(operation: string, work: () => T): T | undefined {
    try {
      return work()
    } catch (error) {
      console.warn(`[sqlite] ${operation} falhou; a conversa segue sem registro.`, error)
      return undefined
    }
  }
}
