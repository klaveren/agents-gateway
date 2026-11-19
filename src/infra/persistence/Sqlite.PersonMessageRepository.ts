import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IPersonMessage, IPersonThread, TPersonMessageLevel } from '@domain/models/PersonMessage.Model'
import { IPersonMessageRepository } from '@domain/ports/PersonMessageRepository.Port'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS person_messages (
    id               TEXT NOT NULL PRIMARY KEY,
    recipient_id     TEXT NOT NULL,
    conversation_id  TEXT NOT NULL,
    project_id       TEXT,
    agent_id         TEXT NOT NULL,
    sender           TEXT NOT NULL,
    author_id        TEXT,
    title            TEXT,
    body             TEXT NOT NULL,
    level            TEXT NOT NULL,
    turn             INTEGER,
    created_at       TEXT NOT NULL,
    read_at          TEXT,
    archived_at      TEXT
  );
  CREATE INDEX IF NOT EXISTS person_messages_thread ON person_messages (recipient_id, conversation_id, created_at);
`

type TRow = Record<string, unknown>

/** 💬 As mensagens das pessoas, no mesmo arquivo das conversas. Sem arquivo, em memória. */
export class SqlitePersonMessageRepository implements IPersonMessageRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  insert(message: IPersonMessage): void {
    this.db
      .prepare(
        'INSERT INTO person_messages (id, recipient_id, conversation_id, project_id, agent_id, sender, author_id, title, body, level, turn, created_at, read_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      )
      .run(
        message.id,
        message.recipientId,
        message.conversationId,
        message.projectId ?? null,
        message.agentId,
        message.from,
        message.authorId ?? null,
        message.title ?? null,
        message.body,
        message.level,
        message.turn ?? null,
        message.createdAt.toISOString(),
        message.readAt?.toISOString() ?? null,
      )
    // Mensagem nova reabre o fio arquivado: quem arquivou volta a vê-lo.
    this.db.prepare('UPDATE person_messages SET archived_at = NULL WHERE recipient_id = ? AND conversation_id = ?').run(message.recipientId, message.conversationId)
  }

  threads(recipientId: string, options: { archived?: boolean } = {}): IPersonThread[] {
    const rows = this.db.prepare('SELECT * FROM person_messages WHERE recipient_id = ? ORDER BY created_at DESC, rowid DESC').all(recipientId) as TRow[]
    const threads = new Map<string, IPersonThread>()
    for (const row of rows) {
      const message = toMessage(row)
      const current = threads.get(message.conversationId)
      if (!current) {
        threads.set(message.conversationId, {
          conversationId: message.conversationId,
          agentId: message.agentId,
          ...(message.projectId ? { projectId: message.projectId } : {}),
          last: message,
          unread: message.from === 'agent' && !message.readAt ? 1 : 0,
          archived: !!message.archivedAt,
        })
      } else if (message.from === 'agent' && !message.readAt) current.unread += 1
      const thread = threads.get(message.conversationId)!
      // O assunto do fio: o título mais recente que o agente deu.
      if (!thread.title && message.title) thread.title = message.title
    }
    return [...threads.values()].filter((thread) => thread.archived === !!options.archived)
  }

  thread(recipientId: string, conversationId: string): IPersonMessage[] {
    return (
      this.db.prepare('SELECT * FROM person_messages WHERE recipient_id = ? AND conversation_id = ? ORDER BY created_at ASC, rowid ASC').all(recipientId, conversationId) as TRow[]
    ).map(toMessage)
  }

  markRead(recipientId: string, conversationId: string, at: Date): number {
    return Number(
      this.db
        .prepare('UPDATE person_messages SET read_at = ? WHERE recipient_id = ? AND conversation_id = ? AND read_at IS NULL')
        .run(at.toISOString(), recipientId, conversationId).changes,
    )
  }

  setArchived(recipientId: string, conversationId: string, archived: boolean, at: Date): number {
    return Number(
      this.db
        .prepare('UPDATE person_messages SET archived_at = ? WHERE recipient_id = ? AND conversation_id = ?')
        .run(archived ? at.toISOString() : null, recipientId, conversationId).changes,
    )
  }

  unread(recipientId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS total FROM person_messages WHERE recipient_id = ? AND sender = 'agent' AND read_at IS NULL AND archived_at IS NULL")
      .get(recipientId) as TRow
    return Number(row.total ?? 0)
  }

  recipientsOf(conversationId: string): string[] {
    return (this.db.prepare('SELECT DISTINCT recipient_id FROM person_messages WHERE conversation_id = ?').all(conversationId) as TRow[]).map((row) => String(row.recipient_id))
  }
}

function toMessage(row: TRow): IPersonMessage {
  const date = (value: unknown) => (typeof value === 'string' ? new Date(value) : undefined)
  return {
    id: String(row.id),
    recipientId: String(row.recipient_id),
    conversationId: String(row.conversation_id),
    ...(typeof row.project_id === 'string' ? { projectId: row.project_id } : {}),
    agentId: String(row.agent_id),
    from: row.sender === 'person' ? 'person' : 'agent',
    ...(typeof row.author_id === 'string' ? { authorId: row.author_id } : {}),
    ...(typeof row.title === 'string' ? { title: row.title } : {}),
    body: String(row.body),
    level: String(row.level) as TPersonMessageLevel,
    ...(typeof row.turn === 'number' ? { turn: row.turn } : {}),
    createdAt: new Date(String(row.created_at)),
    ...(date(row.read_at) ? { readAt: date(row.read_at) } : {}),
    ...(date(row.archived_at) ? { archivedAt: date(row.archived_at) } : {}),
  }
}
