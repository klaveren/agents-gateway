import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { HOOK_DELIVERIES_KEPT, IAgentHook, IHookDelivery } from '@domain/models/AgentHook.Model'
import { IAgentHookRepository, TAgentHookPatch } from '@domain/ports/AgentHookRepository.Port'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_hooks (
    agent_id            TEXT    NOT NULL,
    name                TEXT    NOT NULL,
    prompt              TEXT    NOT NULL,
    enabled             INTEGER NOT NULL DEFAULT 1,
    verify              TEXT    NOT NULL DEFAULT 'key',
    signature_header    TEXT    NOT NULL,
    signature_prefix    TEXT    NOT NULL,
    signature_encoding  TEXT    NOT NULL,
    session             TEXT    NOT NULL DEFAULT 'new',
    session_id          TEXT,
    run_as              TEXT    NOT NULL,
    created_at          TEXT    NOT NULL,
    updated_at          TEXT    NOT NULL,
    updated_by          TEXT,
    PRIMARY KEY (agent_id, name)
  );
  CREATE TABLE IF NOT EXISTS agent_hook_deliveries (
    id           TEXT NOT NULL PRIMARY KEY,
    agent_id     TEXT NOT NULL,
    hook_name    TEXT NOT NULL,
    received_at  TEXT NOT NULL,
    status       TEXT NOT NULL,
    session_id   TEXT,
    error        TEXT
  );
  CREATE INDEX IF NOT EXISTS agent_hook_deliveries_hook ON agent_hook_deliveries (agent_id, hook_name, received_at);
`

type TRow = Record<string, unknown>

const COLUMNS: Record<keyof TAgentHookPatch, string> = {
  prompt: 'prompt',
  enabled: 'enabled',
  verify: 'verify',
  signatureHeader: 'signature_header',
  signaturePrefix: 'signature_prefix',
  signatureEncoding: 'signature_encoding',
  session: 'session',
  sessionId: 'session_id',
  updatedAt: 'updated_at',
  updatedBy: 'updated_by',
}

/** Os hooks dos agentes, no mesmo arquivo das conversas. Sem arquivo, em memória (`:memory:`). */
export class SqliteAgentHookRepository implements IAgentHookRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  list(agentId: string): IAgentHook[] {
    return (this.db.prepare('SELECT * FROM agent_hooks WHERE agent_id = ? ORDER BY created_at ASC, name ASC').all(agentId) as TRow[]).map(toHook)
  }

  get(agentId: string, name: string): IAgentHook | undefined {
    const row = this.db.prepare('SELECT * FROM agent_hooks WHERE agent_id = ? AND name = ?').get(agentId, name) as TRow | undefined
    return row ? toHook(row) : undefined
  }

  insert(hook: IAgentHook): void {
    this.db
      .prepare(
        `INSERT INTO agent_hooks (agent_id, name, prompt, enabled, verify, signature_header, signature_prefix, signature_encoding, session, session_id, run_as, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hook.agentId,
        hook.name,
        hook.prompt,
        hook.enabled ? 1 : 0,
        hook.verify,
        hook.signatureHeader,
        hook.signaturePrefix,
        hook.signatureEncoding,
        hook.session,
        hook.sessionId ?? null,
        hook.runAs,
        hook.createdAt.toISOString(),
        hook.updatedAt.toISOString(),
        hook.updatedBy ?? null,
      )
  }

  update(agentId: string, name: string, patch: TAgentHookPatch): IAgentHook | undefined {
    const keys = (Object.keys(patch) as Array<keyof TAgentHookPatch>).filter((key) => key in COLUMNS && (patch[key] !== undefined || key === 'sessionId'))
    if (keys.length) {
      const values = keys.map((key) => {
        const value = patch[key]
        if (value === undefined || value === null) return null
        if (value instanceof Date) return value.toISOString()
        if (typeof value === 'boolean') return value ? 1 : 0
        return value as string
      })
      this.db.prepare(`UPDATE agent_hooks SET ${keys.map((key) => `${COLUMNS[key]} = ?`).join(', ')} WHERE agent_id = ? AND name = ?`).run(...values, agentId, name)
    }
    return this.get(agentId, name)
  }

  delete(agentId: string, name: string): boolean {
    this.db.prepare('DELETE FROM agent_hook_deliveries WHERE agent_id = ? AND hook_name = ?').run(agentId, name)
    return this.db.prepare('DELETE FROM agent_hooks WHERE agent_id = ? AND name = ?').run(agentId, name).changes > 0
  }

  deleteAgent(agentId: string): string[] {
    const names = this.list(agentId).map((hook) => hook.name)
    this.db.prepare('DELETE FROM agent_hook_deliveries WHERE agent_id = ?').run(agentId)
    this.db.prepare('DELETE FROM agent_hooks WHERE agent_id = ?').run(agentId)
    return names
  }

  /** ⚖️ Guarda só as últimas `HOOK_DELIVERIES_KEPT` por hook: é para a tela, não um log de auditoria. */
  addDelivery(delivery: IHookDelivery): void {
    this.db
      .prepare('INSERT INTO agent_hook_deliveries (id, agent_id, hook_name, received_at, status, session_id, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(delivery.id, delivery.agentId, delivery.hookName, delivery.receivedAt.toISOString(), delivery.status, delivery.sessionId ?? null, delivery.error ?? null)
    this.db
      .prepare(
        `DELETE FROM agent_hook_deliveries WHERE agent_id = ? AND hook_name = ? AND id NOT IN (
           SELECT id FROM agent_hook_deliveries WHERE agent_id = ? AND hook_name = ? ORDER BY received_at DESC, rowid DESC LIMIT ?)`,
      )
      .run(delivery.agentId, delivery.hookName, delivery.agentId, delivery.hookName, HOOK_DELIVERIES_KEPT)
  }

  updateDelivery(id: string, patch: Partial<Pick<IHookDelivery, 'status' | 'sessionId' | 'error'>>): void {
    if (patch.status) this.db.prepare('UPDATE agent_hook_deliveries SET status = ? WHERE id = ?').run(patch.status, id)
    if (patch.sessionId) this.db.prepare('UPDATE agent_hook_deliveries SET session_id = ? WHERE id = ?').run(patch.sessionId, id)
    if (patch.error !== undefined) this.db.prepare('UPDATE agent_hook_deliveries SET error = ? WHERE id = ?').run(patch.error, id)
  }

  deliveries(agentId: string, name: string, limit = HOOK_DELIVERIES_KEPT): IHookDelivery[] {
    return (
      this.db.prepare('SELECT * FROM agent_hook_deliveries WHERE agent_id = ? AND hook_name = ? ORDER BY received_at DESC, rowid DESC LIMIT ?').all(agentId, name, limit) as TRow[]
    ).map((row) => ({
      id: String(row.id),
      agentId: String(row.agent_id),
      hookName: String(row.hook_name),
      receivedAt: new Date(String(row.received_at)),
      status: String(row.status) as IHookDelivery['status'],
      ...(typeof row.session_id === 'string' ? { sessionId: row.session_id } : {}),
      ...(typeof row.error === 'string' ? { error: row.error } : {}),
    }))
  }
}

function toHook(row: TRow): IAgentHook {
  return {
    agentId: String(row.agent_id),
    name: String(row.name),
    prompt: String(row.prompt),
    enabled: Number(row.enabled) === 1,
    verify: String(row.verify) as IAgentHook['verify'],
    signatureHeader: String(row.signature_header),
    signaturePrefix: String(row.signature_prefix),
    signatureEncoding: String(row.signature_encoding) as IAgentHook['signatureEncoding'],
    session: String(row.session) as IAgentHook['session'],
    ...(typeof row.session_id === 'string' ? { sessionId: row.session_id } : {}),
    runAs: String(row.run_as),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    ...(typeof row.updated_by === 'string' ? { updatedBy: row.updated_by } : {}),
  }
}
