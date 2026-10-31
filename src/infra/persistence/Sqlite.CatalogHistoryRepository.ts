import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { TCatalogKind } from '@domain/Catalog.Document'
import {
  IBatchFilter,
  IBatchWidening,
  ICatalogBatch,
  ICatalogBatchRepository,
  ICatalogHistoryRepository,
  ICatalogRevision,
  IRevisionFilter,
  IRevisionPage,
  TNewRevision,
  TRevisionOp,
  TBatchKind,
  TBatchListItem,
  TBatchStatus,
  TRevisionSource,
} from '@domain/ports/CatalogHistoryRepository.Port'

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
  CREATE INDEX IF NOT EXISTS catalog_revisions_batch ON catalog_revisions (batch_id) WHERE batch_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS catalog_batches (
    id          TEXT PRIMARY KEY,
    at          TEXT NOT NULL,
    by          TEXT NOT NULL,
    kind        TEXT NOT NULL,
    scope       TEXT NOT NULL,
    summary     TEXT NOT NULL,
    widenings   TEXT NOT NULL,
    status      TEXT NOT NULL
  );
`

/** As colunas que vieram depois da tabela (bancos antigos ganham na subida). */
const ADDED_COLUMNS: ReadonlyArray<[string, string]> = [['widenings', 'TEXT']]

type TRow = Record<string, unknown>
type TParam = string | number

/** As colunas da lista: tudo menos o documento (pode ter centenas de KB). */
const SUMMARY_COLUMNS = 'id, kind, item_id, project_id, revision, op, hash, at, by, source, batch_id, note, widenings'

/** O histórico do catálogo, no mesmo arquivo das conversas. Sem arquivo, em memória. */
export class SqliteCatalogHistoryRepository implements ICatalogHistoryRepository, ICatalogBatchRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(SCHEMA)
    const columns = new Set((this.db.prepare('PRAGMA table_info(catalog_revisions)').all() as TRow[]).map((row) => row.name as string))
    for (const [name, type] of ADDED_COLUMNS) if (!columns.has(name)) this.db.exec(`ALTER TABLE catalog_revisions ADD COLUMN ${name} ${type}`)
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

  revision(kind: TCatalogKind, itemId: string, revision: number): ICatalogRevision | undefined {
    const row = this.db.prepare('SELECT * FROM catalog_revisions WHERE kind = ? AND item_id = ? AND revision = ?').get(kind, itemId, revision) as TRow | undefined
    return row ? toRevision(row) : undefined
  }

  /** ⚖️ O item vai pela ordem das revisões; o escopo, pela data (o índice `catalog_revisions_scope`) e, no empate, pela ordem de gravação. */
  page(filter: IRevisionFilter, paging: { offset: number; limit: number }): IRevisionPage {
    const where: string[] = []
    const params: TParam[] = []
    const equals = (column: string, value: string | undefined) => {
      if (value === undefined) return
      where.push(`${column} = ?`)
      params.push(value)
    }
    equals('kind', filter.kind)
    equals('item_id', filter.itemId)
    equals('project_id', filter.projectId)
    if (filter.kinds) {
      if (!filter.kinds.length) return { revisions: [], total: 0 }
      where.push(`kind IN (${filter.kinds.map(() => '?').join(', ')})`)
      params.push(...filter.kinds)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const order = filter.itemId !== undefined ? 'revision DESC' : 'at DESC, id DESC'
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS total FROM catalog_revisions ${clause}`).get(...params) as TRow).total)
    const rows = this.db
      .prepare(`SELECT ${SUMMARY_COLUMNS} FROM catalog_revisions ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, paging.limit, paging.offset) as TRow[]
    return { revisions: rows.map(toRevision), total }
  }

  /** ⚖️ A próxima revisão é calculada no próprio INSERT: duas gravações do mesmo item não pegam o mesmo número. */
  append(revision: TNewRevision): ICatalogRevision {
    const row = this.db
      .prepare(
        `INSERT INTO catalog_revisions (kind, item_id, project_id, revision, op, document, hash, at, by, source, batch_id, note, widenings)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(revision), 0) + 1 FROM catalog_revisions WHERE kind = ? AND item_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        revision.widenings?.length ? JSON.stringify(revision.widenings) : null,
      ) as TRow
    return toRevision(row)
  }

  createBatch(batch: ICatalogBatch): ICatalogBatch {
    this.db
      .prepare('INSERT INTO catalog_batches (id, at, by, kind, scope, summary, widenings, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(batch.id, batch.at.toISOString(), batch.by, batch.kind, batch.scope, JSON.stringify(batch.summary), JSON.stringify(batch.widenings), batch.status)
    return batch
  }

  batch(id: string): ICatalogBatch | undefined {
    const row = this.db.prepare('SELECT * FROM catalog_batches WHERE id = ?').get(id) as TRow | undefined
    return row ? toBatch(row) : undefined
  }

  finishBatch(id: string, change: { status: TBatchStatus; summary: Record<string, unknown> }): void {
    this.db.prepare('UPDATE catalog_batches SET status = ?, summary = ? WHERE id = ?').run(change.status, JSON.stringify(change.summary), id)
  }

  markReverted(id: string): void {
    this.db.prepare("UPDATE catalog_batches SET status = 'reverted' WHERE id = ?").run(id)
  }

  batchRevisions(batchId: string): ICatalogRevision[] {
    return (this.db.prepare('SELECT * FROM catalog_revisions WHERE batch_id = ? ORDER BY id').all(batchId) as TRow[]).map(toRevision)
  }

  /** ⚖️ O lote de um projeto: o do escopo dele, ou o de escopo maior (`all`) que gravou revisão nele. */
  batches(filter: IBatchFilter, paging: { offset: number; limit: number }): { batches: TBatchListItem[]; total: number } {
    const where: string[] = []
    const params: TParam[] = []
    if (filter.kind !== undefined) {
      where.push('b.kind = ?')
      params.push(filter.kind)
    }
    if (filter.projectId !== undefined) {
      where.push('(b.scope = ? OR b.id IN (SELECT batch_id FROM catalog_revisions WHERE batch_id IS NOT NULL AND project_id = ?))')
      params.push(filter.projectId ? `project:${filter.projectId}` : 'global', filter.projectId)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS total FROM catalog_batches b ${clause}`).get(...params) as TRow).total)
    const rows = this.db
      .prepare(
        `SELECT b.*, (SELECT COUNT(DISTINCT r.kind || '/' || r.item_id) FROM catalog_revisions r WHERE r.batch_id = b.id) AS items
         FROM catalog_batches b ${clause} ORDER BY b.at DESC, b.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, paging.limit, paging.offset) as TRow[]
    return { batches: rows.map((row) => ({ ...toBatch(row), items: Number(row.items) })), total }
  }
}

function toBatch(row: TRow): ICatalogBatch {
  return {
    id: row.id as string,
    at: new Date(row.at as string),
    by: row.by as string,
    kind: row.kind as TBatchKind,
    scope: row.scope as string,
    summary: JSON.parse(row.summary as string) as Record<string, unknown>,
    widenings: JSON.parse(row.widenings as string) as IBatchWidening[],
    status: row.status as TBatchStatus,
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
    ...(typeof row.widenings === 'string' ? { widenings: JSON.parse(row.widenings) as string[] } : {}),
  }
}
