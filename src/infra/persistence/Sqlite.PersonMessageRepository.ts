import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IPersonMessage, IPersonThread, isRequestKey, messageKeyOf, TPersonMessageLevel, TPersonMessageStatus } from '@domain/models/PersonMessage.Model'
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
    this.migrate()
  }

  /**
   * 🔧 Bancos antigos não têm `status`, `answered_at` e `reply_to`: entram com ALTER TABLE quando faltam. ⚖️ REGRA DAS
   * LINHAS ANTIGAS (roda uma vez, só na hora em que `status` nasce): todo pedido do agente (`attention`/`urgent`) vira
   * `answered` se o fio daquele destinatário tem mensagem da pessoa depois dele, senão `pending`. `info` fica sem estado.
   */
  private migrate(): void {
    const columns = new Set((this.db.prepare('PRAGMA table_info(person_messages)').all() as TRow[]).map((column) => String(column.name)))
    for (const [name, type] of [
      ['status', 'TEXT'],
      ['answered_at', 'TEXT'],
      ['reply_to', 'TEXT'],
    ] as const) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE person_messages ADD COLUMN ${name} ${type}`)
    }
    if (columns.has('status')) return
    const answered = `EXISTS (SELECT 1 FROM person_messages later WHERE later.recipient_id = person_messages.recipient_id AND later.conversation_id = person_messages.conversation_id AND later.sender = 'person' AND later.created_at > person_messages.created_at)`
    this.db.exec(
      `UPDATE person_messages SET status = 'answered', answered_at = (SELECT MIN(later.created_at) FROM person_messages later WHERE later.recipient_id = person_messages.recipient_id AND later.conversation_id = person_messages.conversation_id AND later.sender = 'person' AND later.created_at > person_messages.created_at) WHERE sender = 'agent' AND level IN ('attention', 'urgent') AND ${answered}`,
    )
    this.db.exec("UPDATE person_messages SET status = 'pending' WHERE sender = 'agent' AND level IN ('attention', 'urgent') AND status IS NULL")
  }

  insert(message: IPersonMessage): void {
    this.db
      .prepare(
        'INSERT INTO person_messages (id, recipient_id, conversation_id, project_id, agent_id, sender, author_id, title, body, level, turn, created_at, read_at, archived_at, status, answered_at, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)',
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
        message.status ?? null,
        message.answeredAt?.toISOString() ?? null,
        message.replyTo ?? null,
      )
    // Mensagem nova reabre o item arquivado: quem arquivou volta a vê-lo.
    this.update(message.recipientId, messageKeyOf(message), 'archived_at = NULL', [])
  }

  threads(recipientId: string, options: { archived?: boolean } = {}): IPersonThread[] {
    const rows = this.db.prepare('SELECT * FROM person_messages WHERE recipient_id = ? ORDER BY created_at DESC, rowid DESC').all(recipientId) as TRow[]
    const threads = new Map<string, IPersonThread>()
    for (const row of rows) {
      const message = toMessage(row)
      const key = messageKeyOf(message)
      const current = threads.get(key)
      if (!current) {
        threads.set(key, {
          id: key,
          ...(isRequestKey(key) ? { requestId: key } : {}),
          conversationId: message.conversationId,
          agentId: message.agentId,
          ...(message.projectId ? { projectId: message.projectId } : {}),
          last: message,
          unread: message.from === 'agent' && !message.readAt ? 1 : 0,
          pending: message.status === 'pending' ? 1 : 0,
          open: isOpen(message) ? 1 : 0,
          archived: !!message.archivedAt,
        })
      } else {
        if (message.from === 'agent' && !message.readAt) current.unread += 1
        if (message.status === 'pending') current.pending += 1
        if (isOpen(message)) current.open = (current.open ?? 0) + 1
      }
      const thread = threads.get(key)!
      // O assunto do item: o título mais recente que o agente deu (no pedido, o dele).
      if (!thread.title && message.title) thread.title = message.title
    }
    return [...threads.values()].filter((thread) => thread.archived === !!options.archived)
  }

  thread(recipientId: string, conversationId: string): IPersonMessage[] {
    return (
      this.db.prepare('SELECT * FROM person_messages WHERE recipient_id = ? AND conversation_id = ? ORDER BY created_at ASC, rowid ASC').all(recipientId, conversationId) as TRow[]
    ).map(toMessage)
  }

  item(recipientId: string, key: string): IPersonMessage[] {
    const conversationId = isRequestKey(key)
      ? (this.db.prepare('SELECT conversation_id FROM person_messages WHERE recipient_id = ? AND id = ?').get(recipientId, key) as TRow | undefined)?.conversation_id
      : key
    if (typeof conversationId !== 'string') return []
    return this.thread(recipientId, conversationId).filter((message) => messageKeyOf(message) === key)
  }

  markRead(recipientId: string, key: string, at: Date): number {
    return this.update(recipientId, key, 'read_at = ?', [at.toISOString()], 'read_at IS NULL')
  }

  setArchived(recipientId: string, key: string, archived: boolean, at: Date): number {
    return this.update(recipientId, key, 'archived_at = ?', [archived ? at.toISOString() : null])
  }

  /** Aplica `set` às mensagens de um item da pessoa; devolve quantas mudaram. */
  private update(recipientId: string, key: string, set: string, params: Array<string | null>, where?: string): number {
    const ids = this.item(recipientId, key).map((message) => message.id)
    if (!ids.length) return 0
    return Number(
      this.db
        .prepare(`UPDATE person_messages SET ${set} WHERE recipient_id = ? AND id IN (${ids.map(() => '?').join(', ')})${where ? ` AND ${where}` : ''}`)
        .run(...params, recipientId, ...ids).changes,
    )
  }

  unread(recipientId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS total FROM person_messages WHERE recipient_id = ? AND sender = 'agent' AND read_at IS NULL AND archived_at IS NULL")
      .get(recipientId) as TRow
    return Number(row.total ?? 0)
  }

  pending(recipientId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS total FROM person_messages WHERE recipient_id = ? AND sender = 'agent' AND status = 'pending' AND archived_at IS NULL")
      .get(recipientId) as TRow
    return Number(row.total ?? 0)
  }

  setStatus(recipientId: string, conversationId: string, messageId: string, status: TPersonMessageStatus, at: Date): number {
    return Number(
      this.db
        .prepare(
          `UPDATE person_messages SET status = ?, answered_at = ${status === 'resolved' ? 'answered_at' : '?'} WHERE id = ? AND recipient_id = ? AND conversation_id = ? AND sender = 'agent' AND status IS NOT NULL`,
        )
        .run(...(status === 'resolved' ? [status] : [status, status === 'answered' ? at.toISOString() : null]), messageId, recipientId, conversationId).changes,
    )
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
    ...(row.status === 'pending' || row.status === 'answered' || row.status === 'resolved' ? { status: row.status } : {}),
    ...(date(row.answered_at) ? { answeredAt: date(row.answered_at) } : {}),
    ...(typeof row.reply_to === 'string' ? { replyTo: row.reply_to } : {}),
  }
}

/** Pedido ainda em aberto: pendente ou respondido sem ter sido dado por resolvido. */
function isOpen(message: IPersonMessage): boolean {
  return message.status === 'pending' || message.status === 'answered'
}
