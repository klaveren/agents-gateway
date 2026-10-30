import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IImportJobItem, IImportJobSummary, IImportReuse, INewImportJob, TImportItemPatch, TImportItemState } from '@domain/models/ImportJob.Model'
import { IImportScan, IInventoryItem, TInventoryKind } from '@domain/models/ImportInventory.Model'
import { IImportJobRecord, IImportRepository } from '@domain/ports/ImportRepository.Port'

/**
 * ⚖️ DUAS TABELAS: o trabalho (uma varredura salva, num `HEAD`) e os itens dele. Reanalisar cria um trabalho novo (o
 * anterior fica como registro); o estado dos itens é copiado pela chave. O inventário vai como JSON (o que a tela lê
 * inteiro); o que se consulta e se muda (estado, tipo, autor) vai em coluna.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS import_scans (
    id          TEXT    PRIMARY KEY,
    project_id  TEXT    NOT NULL,
    repository  TEXT    NOT NULL,
    head        TEXT,
    dirty       INTEGER,
    scanned_at  TEXT    NOT NULL,
    by          TEXT    NOT NULL,
    previous_id TEXT,
    inventory   TEXT    NOT NULL,
    reuse       TEXT
  );
  CREATE INDEX IF NOT EXISTS import_scans_repository ON import_scans (project_id, repository, scanned_at DESC);
  CREATE TABLE IF NOT EXISTS import_items (
    scan_id           TEXT    NOT NULL,
    key               TEXT    NOT NULL,
    kind              TEXT    NOT NULL,
    reclassified_kind TEXT,
    candidate_id      TEXT    NOT NULL,
    item              TEXT    NOT NULL,
    fingerprint       TEXT    NOT NULL,
    basis             TEXT,
    state             TEXT    NOT NULL DEFAULT 'pending',
    stale_from        TEXT,
    target_id         TEXT,
    conversation_id   TEXT,
    drafts            TEXT    NOT NULL DEFAULT '[]',
    review            TEXT,
    approved_by       TEXT,
    approved_at       TEXT,
    batch_id          TEXT,
    updated_by        TEXT,
    updated_at        TEXT,
    PRIMARY KEY (scan_id, key)
  );
`

type TRow = Record<string, unknown>

const SCAN_COLUMNS = 'id, project_id, repository, head, dirty, scanned_at, by, previous_id, inventory, reuse'

/** Os trabalhos de importação, no mesmo arquivo das conversas. Sem arquivo, em memória. */
export class SqliteImportRepository implements IImportRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(SCHEMA)
  }

  create(job: INewImportJob): void {
    const insertItem = this.db.prepare(
      `INSERT INTO import_items (scan_id, key, kind, reclassified_kind, candidate_id, item, fingerprint, basis, state, stale_from, target_id,
         conversation_id, drafts, review, approved_by, approved_at, batch_id, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.db.exec('BEGIN')
    try {
      this.db
        .prepare(`INSERT INTO import_scans (${SCAN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          job.id,
          job.projectId,
          job.repository,
          job.head ?? null,
          job.dirty === undefined ? null : job.dirty ? 1 : 0,
          job.scannedAt.toISOString(),
          job.by,
          job.previousId ?? null,
          JSON.stringify(job.inventory),
          job.reuse ? JSON.stringify(job.reuse) : null,
        )
      for (const entry of job.items)
        insertItem.run(
          job.id,
          entry.key,
          entry.item.kind,
          entry.kind ?? null,
          entry.item.candidateId,
          JSON.stringify(entry.item),
          entry.fingerprint,
          entry.basis ?? null,
          entry.state,
          entry.staleFrom ?? null,
          entry.targetId ?? null,
          entry.conversationId ?? null,
          JSON.stringify(entry.drafts),
          entry.review === undefined ? null : JSON.stringify(entry.review),
          entry.approvedBy ?? null,
          entry.approvedAt?.toISOString() ?? null,
          entry.batchId ?? null,
          entry.by ?? null,
          entry.at?.toISOString() ?? null,
        )
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** ⚖️ O mais novo pela data e, no empate, pela ordem de gravação (`rowid`). */
  list(projectId: string): IImportJobSummary[] {
    const scans = (this.db.prepare(`SELECT ${SCAN_COLUMNS} FROM import_scans WHERE project_id = ? ORDER BY scanned_at DESC, rowid DESC`).all(projectId) as TRow[]).map(toRecord)
    const counts = this.db
      .prepare('SELECT i.scan_id, i.state, COUNT(*) AS total FROM import_items i JOIN import_scans s ON s.id = i.scan_id WHERE s.project_id = ? GROUP BY i.scan_id, i.state')
      .all(projectId) as TRow[]
    const byScan = new Map<string, Partial<Record<TImportItemState, number>>>()
    for (const row of counts) {
      const entry = byScan.get(row.scan_id as string) ?? {}
      entry[row.state as TImportItemState] = Number(row.total)
      byScan.set(row.scan_id as string, entry)
    }
    const seen = new Set<string>()
    return scans.map(({ inventory: _inventory, ...record }) => {
      const byState = byScan.get(record.id) ?? {}
      const latest = !seen.has(record.repository)
      seen.add(record.repository)
      return { ...record, items: Object.values(byState).reduce((sum, value) => sum + (value ?? 0), 0), byState, latest }
    })
  }

  get(projectId: string, jobId: string): IImportJobRecord | undefined {
    const row = this.db.prepare(`SELECT ${SCAN_COLUMNS} FROM import_scans WHERE project_id = ? AND id = ?`).get(projectId, jobId) as TRow | undefined
    return row ? toRecord(row) : undefined
  }

  latest(projectId: string, repository: string): IImportJobRecord | undefined {
    const row = this.db
      .prepare(`SELECT ${SCAN_COLUMNS} FROM import_scans WHERE project_id = ? AND repository = ? ORDER BY scanned_at DESC, rowid DESC LIMIT 1`)
      .get(projectId, repository) as TRow | undefined
    return row ? toRecord(row) : undefined
  }

  items(jobId: string): IImportJobItem[] {
    return (this.db.prepare('SELECT * FROM import_items WHERE scan_id = ? ORDER BY key').all(jobId) as TRow[]).map(toItem)
  }

  item(jobId: string, key: string): IImportJobItem | undefined {
    const row = this.db.prepare('SELECT * FROM import_items WHERE scan_id = ? AND key = ?').get(jobId, key) as TRow | undefined
    return row ? toItem(row) : undefined
  }

  updateItem(jobId: string, key: string, patch: TImportItemPatch): IImportJobItem | undefined {
    const sets: string[] = []
    const params: Array<string | null> = []
    const set = (column: string, value: string | null) => {
      sets.push(`${column} = ?`)
      params.push(value)
    }
    if (patch.state !== undefined) set('state', patch.state)
    if (patch.staleFrom !== undefined) set('stale_from', patch.staleFrom)
    if (patch.kind !== undefined) set('reclassified_kind', patch.kind)
    if (patch.basis !== undefined) set('basis', patch.basis)
    if (patch.by !== undefined) set('updated_by', patch.by)
    if (patch.at !== undefined) set('updated_at', patch.at.toISOString())
    if (sets.length) this.db.prepare(`UPDATE import_items SET ${sets.join(', ')} WHERE scan_id = ? AND key = ?`).run(...params, jobId, key)
    return this.item(jobId, key)
  }

  deleteProject(projectId: string): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM import_items WHERE scan_id IN (SELECT id FROM import_scans WHERE project_id = ?)').run(projectId)
      this.db.prepare('DELETE FROM import_scans WHERE project_id = ?').run(projectId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

function toRecord(row: TRow): IImportJobRecord {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    repository: row.repository as string,
    ...(typeof row.head === 'string' ? { head: row.head } : {}),
    ...(row.dirty === null || row.dirty === undefined ? {} : { dirty: Number(row.dirty) === 1 }),
    scannedAt: new Date(row.scanned_at as string),
    by: row.by as string,
    ...(typeof row.previous_id === 'string' ? { previousId: row.previous_id } : {}),
    inventory: { ...(JSON.parse(row.inventory as string) as Omit<IImportScan, 'items' | 'scannedAt'>), scannedAt: new Date(row.scanned_at as string) },
    ...(typeof row.reuse === 'string' ? { reuse: JSON.parse(row.reuse) as IImportReuse } : {}),
  }
}

function toItem(row: TRow): IImportJobItem {
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
  const optional = <K extends string, V>(key: K, value: V | undefined) => (value === undefined ? {} : ({ [key]: value } as Record<K, V>))
  return {
    key: row.key as string,
    item: JSON.parse(row.item as string) as IInventoryItem,
    state: row.state as TImportItemState,
    ...optional('staleFrom', text(row.stale_from) as TImportItemState | undefined),
    ...optional('kind', text(row.reclassified_kind) as TInventoryKind | undefined),
    fingerprint: row.fingerprint as string,
    ...optional('basis', text(row.basis)),
    ...optional('targetId', text(row.target_id)),
    ...optional('conversationId', text(row.conversation_id)),
    drafts: JSON.parse(row.drafts as string) as unknown[],
    ...optional('review', typeof row.review === 'string' ? (JSON.parse(row.review) as unknown) : undefined),
    ...optional('approvedBy', text(row.approved_by)),
    ...optional('approvedAt', text(row.approved_at) ? new Date(row.approved_at as string) : undefined),
    ...optional('batchId', text(row.batch_id)),
    ...optional('by', text(row.updated_by)),
    ...optional('at', text(row.updated_at) ? new Date(row.updated_at as string) : undefined),
  }
}
