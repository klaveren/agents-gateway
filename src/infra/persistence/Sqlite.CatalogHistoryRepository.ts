import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { TCatalogKind } from '@domain/Catalog.Document'
import { ICatalogHistoryRepository, ICatalogRevision, TNewRevision, TRevisionOp, TRevisionSource } from '@domain/ports/CatalogHistoryRepository.Port'

/**
 * ⚖️ UMA TABELA para todos os tipos: uma consulta responde "o que mudou no projeto X hoje", e o rollback é um caminho
 * só. O global é `project_id = ''`. Sem teto de retenção: guarda tudo.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS catalog_revisions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT    NOT NULL,
    item_id     TEXT    NOT NULL,
    project_id  TEXT    NOT NULL DEFAULT '',
    revision    INTEGER NOT NULL,
    op          TEXT    NOT NULL,
    document    TEXT,
    hash        TEXT,
    at          TEXT    NOT NULL,
    by          TEXT    NOT NULL,
    source      TEXT    NOT NULL,
    batch_id    TEXT,
    note        TEXT,
    UNIQUE (kind, item_id, revision)
  );
  CREATE INDEX IF NOT EXISTS catalog_revisions_scope ON catalog_revisions (project_id, at DESC);
`

type TRow = Record<string, unknown>

/** O histórico do catálogo, no mesmo arquivo das conversas. Sem arquivo, em memória. */
export class SqliteCatalogHistoryRepository implements ICatalogHistoryRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(SCHEMA)
  }

  latest(kind: TCatalogKind, itemId: string): ICatalogRevision | undefined {
    const row = this.db.prepare('SELECT * FROM catalog_revisions WHERE kind = ? AND item_id = ? ORDER BY revision DESC LIMIT 1').get(kind, itemId) as TRow | undefined
    return row ? toRevision(row) : undefined
  }

  latestAll(): ICatalogRevision[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM catalog_revisions r
         JOIN (SELECT kind, item_id, MAX(revision) AS revision FROM catalog_revisions GROUP BY kind, item_id) last
           ON last.kind = r.kind AND last.item_id = r.item_id AND last.revision = r.revision
         ORDER BY r.kind, r.item_id`,
      )
      .all() as TRow[]
    return rows.map(toRevision)
  }

  revisions(kind: TCatalogKind, itemId: string): ICatalogRevision[] {
    return (this.db.prepare('SELECT * FROM catalog_revisions WHERE kind = ? AND item_id = ? ORDER BY revision').all(kind, itemId) as TRow[]).map(toRevision)
  }

  /** ⚖️ A próxima revisão é calculada no próprio INSERT: duas gravações do mesmo item não pegam o mesmo número. */
  append(revision: TNewRevision): ICatalogRevision {
    const row = this.db
      .prepare(
        `INSERT INTO catalog_revisions (kind, item_id, project_id, revision, op, document, hash, at, by, source, batch_id, note)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(revision), 0) + 1 FROM catalog_revisions WHERE kind = ? AND item_id = ?), ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        revision.kind,
        revision.itemId,
        revision.projectId ?? '',
        revision.kind,
        revision.itemId,
        revision.op,
        revision.document ?? null,
        revision.hash ?? null,
        revision.at.toISOString(),
        revision.by,
        revision.source,
        revision.batchId ?? null,
        revision.note ?? null,
      ) as TRow
    return toRevision(row)
  }
}

function toRevision(row: TRow): ICatalogRevision {
  return {
    id: Number(row.id),
    kind: row.kind as TCatalogKind,
    itemId: row.item_id as string,
    ...(row.project_id ? { projectId: row.project_id as string } : {}),
    revision: Number(row.revision),
    op: row.op as TRevisionOp,
    ...(typeof row.document === 'string' ? { document: row.document } : {}),
    ...(typeof row.hash === 'string' ? { hash: row.hash } : {}),
    at: new Date(row.at as string),
    by: row.by as string,
    source: row.source as TRevisionSource,
    ...(typeof row.batch_id === 'string' ? { batchId: row.batch_id } : {}),
    ...(typeof row.note === 'string' ? { note: row.note } : {}),
  }
}
