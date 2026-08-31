import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { IConversationSession, IConversationStats, IConversationTurn, IStoredUsage } from '@domain/models/Conversation.Model'
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
    metadata         TEXT,
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations (updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_conversations_model ON conversations (provider, model);

  CREATE TABLE IF NOT EXISTS conversation_turns (
    conversation_id  TEXT    NOT NULL,
    idx              INTEGER NOT NULL,
    at               TEXT    NOT NULL,
    request          TEXT    NOT NULL,
    response         TEXT    NOT NULL,
    reasoning        TEXT,
    tool_calls       TEXT,
    warnings         TEXT,
    input_tokens     INTEGER NOT NULL DEFAULT 0,
    output_tokens    INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens     INTEGER NOT NULL DEFAULT 0,
    aborted          INTEGER NOT NULL DEFAULT 0,
    error            TEXT,
    PRIMARY KEY (conversation_id, idx),
    FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
  );
`

/** Só identificador simples vira caminho JSON. Ver `listSessions`. */
const SAFE_KEY = /^[A-Za-z0-9_]+$/

type TRow = Record<string, unknown>

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function count(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0)
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
  }
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
          `INSERT INTO conversations (id, agent_id, provider, mode, model, title, turns, input_tokens, output_tokens, reasoning_tokens, total_tokens, metadata, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          session.metadata ? JSON.stringify(session.metadata) : null,
          session.createdAt.toISOString(),
          session.updatedAt.toISOString(),
        )
    })
  }

  async appendTurn(turn: IConversationTurn): Promise<void> {
    this.guard('appendTurn', () => {
      // `INSERT OR REPLACE`: um turno reenviado com o mesmo índice corrige o anterior em vez de
      // estourar por chave duplicada e derrubar o registro inteiro.
      this.db
        .prepare(
          `INSERT OR REPLACE INTO conversation_turns
             (conversation_id, idx, at, request, response, reasoning, tool_calls, warnings, input_tokens, output_tokens, reasoning_tokens, total_tokens, aborted, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          turn.sessionId,
          turn.index,
          turn.at.toISOString(),
          turn.request,
          turn.text,
          turn.reasoning ?? null,
          turn.toolCalls?.length ? JSON.stringify(turn.toolCalls) : null,
          turn.warnings?.length ? JSON.stringify(turn.warnings) : null,
          turn.usage?.inputTokens ?? 0,
          turn.usage?.outputTokens ?? 0,
          turn.usage?.reasoningTokens ?? 0,
          turn.usage?.totalTokens ?? 0,
          // O driver aceita number, não boolean.
          turn.aborted ? 1 : 0,
          turn.error ?? null,
        )
    })
  }

  async listSessions(options: { limit?: number; filter?: Record<string, unknown> } = {}): Promise<IConversationSession[]> {
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

        const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''

        const rows = this.db.prepare(`SELECT * FROM conversations ${clause} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit) as TRow[]

        return rows.map((row) => this.toSession(row))
      }) ?? []
    )
  }

  async listTurns(sessionId: string): Promise<IConversationTurn[]> {
    return (
      this.guard('listTurns', () => {
        const rows = this.db.prepare('SELECT * FROM conversation_turns WHERE conversation_id = ? ORDER BY idx ASC').all(sessionId) as TRow[]

        return rows.map((row) => ({
          sessionId: text(row.conversation_id),
          index: count(row.idx),
          at: new Date(text(row.at)),
          request: text(row.request),
          text: text(row.response),
          reasoning: typeof row.reasoning === 'string' ? row.reasoning : undefined,
          toolCalls: json<IConversationTurn['toolCalls']>(row.tool_calls, []),
          usage: usageOf(row),
          warnings: json<string[] | undefined>(row.warnings, undefined),
          aborted: count(row.aborted) === 1 || undefined,
          error: typeof row.error === 'string' ? row.error : undefined,
        }))
      }) ?? []
    )
  }

  async findSession(sessionId: string): Promise<IConversationSession | undefined> {
    return this.guard('findSession', () => {
      const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(sessionId) as TRow | undefined

      return row ? this.toSession(row) : undefined
    })
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
  async stats(): Promise<IConversationStats> {
    const empty: IConversationStats = { conversations: 0, turns: 0, usage: {}, byModel: [] }

    return (
      this.guard('stats', () => {
        const totals = this.db
          .prepare(
            `SELECT COUNT(*) AS conversations, COALESCE(SUM(turns), 0) AS turns,
                    COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
                    COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens, COALESCE(SUM(total_tokens), 0) AS total_tokens
             FROM conversations`,
          )
          .get() as TRow

        const byModel = this.db
          .prepare(
            `SELECT provider, model, COUNT(*) AS conversations,
                    COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
                    COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens, COALESCE(SUM(total_tokens), 0) AS total_tokens
             FROM conversations GROUP BY provider, model ORDER BY total_tokens DESC`,
          )
          .all() as TRow[]

        return {
          conversations: count(totals.conversations),
          turns: count(totals.turns),
          usage: usageOf(totals),
          byModel: byModel.map((row) => ({ provider: text(row.provider), model: text(row.model), conversations: count(row.conversations), usage: usageOf(row) })),
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
      usage: usageOf(row),
      metadata: json<Record<string, unknown> | undefined>(row.metadata, undefined),
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
