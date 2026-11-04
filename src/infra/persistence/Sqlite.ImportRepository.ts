import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { consolidatedItem, isProcessed } from '@domain/Import.Job'
import {
  IImportAnalysis,
  IImportBatch,
  IImportedBy,
  IImportJobItem,
  IImportJobSummary,
  IImportReanalysis,
  INewImportJob,
  TImportItemPatch,
  TImportItemState,
} from '@domain/models/ImportJob.Model'
import { IImportScan, IInventoryItem, TInventoryKind } from '@domain/models/ImportInventory.Model'
import { IImportConsolidation, IImportJobRecord, IImportRepository } from '@domain/ports/ImportRepository.Port'

/**
 * ⚖️ QUATRO TABELAS: a importação (UMA ativa por projeto + repositório, com o inventário da última análise), os itens
 * dela, os lotes que a pessoa montou nela e o registro de cada análise. Reanalisar atualiza a mesma linha e os itens no
 * lugar; o item que saiu da fonte fica, com `gone_at`. O inventário vai como JSON (o que a tela lê inteiro); o que se
 * consulta e se muda (estado, tipo, autor) vai em coluna. O lote guarda as chaves e a ordem como JSON: ele é lido
 * inteiro. `previous_id`/`reuse` são do tempo de "um trabalho por análise": ficam, sem uso; `archived_at` marca a
 * análise antiga que a consolidação juntou na que ficou (registro, fora de toda leitura).
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
    reuse       TEXT,
    archived_at TEXT
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
    gone_at           TEXT,
    PRIMARY KEY (scan_id, key)
  );
  CREATE TABLE IF NOT EXISTS import_batches (
    id          TEXT    PRIMARY KEY,
    scan_id     TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    prefix      TEXT    NOT NULL DEFAULT '',
    keys        TEXT    NOT NULL,
    item_order  TEXT    NOT NULL,
    created_by  TEXT    NOT NULL,
    created_at  TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS import_batches_scan ON import_batches (scan_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS import_analyses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id     TEXT    NOT NULL,
    analyzed_at TEXT    NOT NULL,
    by          TEXT    NOT NULL,
    head        TEXT,
    dirty       INTEGER,
    kept        INTEGER NOT NULL DEFAULT 0,
    changes     TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS import_analyses_scan ON import_analyses (scan_id, analyzed_at DESC);
`

/** As colunas que vieram depois: o arquivo antigo as ganha no boot (o SQLite não tem `ADD COLUMN IF NOT EXISTS`). */
const ADDED_COLUMNS: ReadonlyArray<[table: string, column: string, definition: string]> = [
  ['import_scans', 'archived_at', 'TEXT'],
  ['import_items', 'gone_at', 'TEXT'],
  // Gravado no catálogo por um agente, fora do importador (ver `IImportedBy`), em JSON.
  ['import_items', 'imported_by', 'TEXT'],
]

/** Quantas análises a importação mostra. */
const ANALYSES_SHOWN = 20

type TRow = Record<string, unknown>

const SCAN_COLUMNS = 'id, project_id, repository, head, dirty, scanned_at, by, previous_id, inventory, reuse'
const ITEM_COLUMNS = `scan_id, key, kind, reclassified_kind, candidate_id, item, fingerprint, basis, state, stale_from, target_id,
  conversation_id, drafts, review, approved_by, approved_at, batch_id, updated_by, updated_at, gone_at`

/** Os trabalhos de importação, no mesmo arquivo das conversas. Sem arquivo, em memória. */
export class SqliteImportRepository implements IImportRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(SCHEMA)
    for (const [table, column, definition] of ADDED_COLUMNS) {
      const existing = this.db.prepare(`PRAGMA table_info(${table})`).all() as TRow[]
      if (!existing.some((row) => row.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
    const done = this.consolidate()
    for (const one of done.kept)
      console.info(`[import] consolidado ${one.jobId}: ${one.archived.length} análise(s) arquivada(s), ${one.batches} lote(s) e ${one.items} item(ns) trazidos`)
  }

  create(job: INewImportJob): void {
    this.transaction(() => {
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
          null,
          JSON.stringify(job.inventory),
          null,
        )
      for (const entry of job.items) this.putItem(job.id, entry, false)
      if (job.analysis) this.insertAnalysis(job.id, job.analysis)
    })
  }

  reanalyze(update: IImportReanalysis): void {
    const upsert = this.db.prepare(
      `INSERT INTO import_items (scan_id, key, kind, candidate_id, item, fingerprint, state) VALUES (?, ?, ?, ?, ?, ?, 'pending')
       ON CONFLICT (scan_id, key) DO UPDATE SET kind = excluded.kind, candidate_id = excluded.candidate_id, item = excluded.item,
         fingerprint = excluded.fingerprint, gone_at = NULL`,
    )
    const setState = this.db.prepare('UPDATE import_items SET state = ?, stale_from = ? WHERE scan_id = ? AND key = ?')
    const markGone = this.db.prepare('UPDATE import_items SET gone_at = ? WHERE scan_id = ? AND key = ? AND gone_at IS NULL')
    this.transaction(() => {
      this.db
        .prepare('UPDATE import_scans SET head = ?, dirty = ?, scanned_at = ?, by = ?, inventory = ? WHERE id = ?')
        .run(
          update.head ?? null,
          update.dirty === undefined ? null : update.dirty ? 1 : 0,
          update.scannedAt.toISOString(),
          update.by,
          JSON.stringify(update.inventory),
          update.jobId,
        )
      for (const entry of update.present) {
        upsert.run(update.jobId, entry.key, entry.item.kind, entry.item.candidateId, JSON.stringify(entry.item), entry.fingerprint)
        if (entry.state !== undefined) setState.run(entry.state, entry.staleFrom ?? null, update.jobId, entry.key)
      }
      for (const key of update.gone) markGone.run(update.scannedAt.toISOString(), update.jobId, key)
      this.insertAnalysis(update.jobId, update.analysis)
    })
  }

  analyses(jobId: string, limit = ANALYSES_SHOWN): IImportAnalysis[] {
    return (this.db.prepare('SELECT * FROM import_analyses WHERE scan_id = ? ORDER BY analyzed_at DESC, id DESC LIMIT ?').all(jobId, limit) as TRow[]).map(toAnalysis)
  }

  /** ⚖️ A analisada por último primeiro e, no empate, pela ordem de gravação (`rowid`). A arquivada não aparece. */
  list(projectId: string): IImportJobSummary[] {
    const scans = (
      this.db.prepare(`SELECT ${SCAN_COLUMNS} FROM import_scans WHERE project_id = ? AND archived_at IS NULL ORDER BY scanned_at DESC, rowid DESC`).all(projectId) as TRow[]
    ).map(toRecord)
    const counts = this.db
      .prepare(
        `SELECT i.scan_id, i.state, COUNT(*) AS total, SUM(CASE WHEN i.gone_at IS NULL THEN 0 ELSE 1 END) AS gone FROM import_items i
         JOIN import_scans s ON s.id = i.scan_id WHERE s.project_id = ? AND s.archived_at IS NULL GROUP BY i.scan_id, i.state`,
      )
      .all(projectId) as TRow[]
    const byScan = new Map<string, Partial<Record<TImportItemState, number>>>()
    const goneOf = new Map<string, number>()
    for (const row of counts) {
      const entry = byScan.get(row.scan_id as string) ?? {}
      entry[row.state as TImportItemState] = Number(row.total)
      byScan.set(row.scan_id as string, entry)
      goneOf.set(row.scan_id as string, (goneOf.get(row.scan_id as string) ?? 0) + Number(row.gone ?? 0))
    }
    const seen = new Set<string>()
    return scans.map(({ inventory: _inventory, ...record }) => {
      const byState = byScan.get(record.id) ?? {}
      const latest = !seen.has(record.repository)
      seen.add(record.repository)
      return {
        ...record,
        items: Object.values(byState).reduce((sum, value) => sum + (value ?? 0), 0),
        byState,
        gone: goneOf.get(record.id) ?? 0,
        latest,
        analyses: this.analyses(record.id),
      }
    })
  }

  get(projectId: string, jobId: string): IImportJobRecord | undefined {
    const row = this.db.prepare(`SELECT ${SCAN_COLUMNS} FROM import_scans WHERE project_id = ? AND id = ? AND archived_at IS NULL`).get(projectId, jobId) as TRow | undefined
    if (row) return toRecord(row)
    // ⚖️ O id de uma análise ARQUIVADA (a consolidação) leva à importação que ficou no lugar: a conversa do construtor
    // e o link antigos guardam o id de antes.
    const archived = this.db.prepare('SELECT repository FROM import_scans WHERE project_id = ? AND id = ? AND archived_at IS NOT NULL').get(projectId, jobId) as
      { repository: string } | undefined
    return archived ? this.latest(projectId, archived.repository) : undefined
  }

  latest(projectId: string, repository: string): IImportJobRecord | undefined {
    const row = this.db
      .prepare(`SELECT ${SCAN_COLUMNS} FROM import_scans WHERE project_id = ? AND repository = ? AND archived_at IS NULL ORDER BY scanned_at DESC, rowid DESC LIMIT 1`)
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
    if (patch.conversationId !== undefined) set('conversation_id', patch.conversationId)
    if (patch.drafts !== undefined) set('drafts', JSON.stringify(patch.drafts))
    if (patch.review !== undefined) set('review', patch.review === null ? null : JSON.stringify(patch.review))
    if (patch.approvedBy !== undefined) set('approved_by', patch.approvedBy)
    if (patch.approvedAt !== undefined) set('approved_at', patch.approvedAt.toISOString())
    if (patch.batchId !== undefined) set('batch_id', patch.batchId)
    if (patch.importedBy !== undefined) set('imported_by', JSON.stringify(patch.importedBy))
    if (patch.by !== undefined) set('updated_by', patch.by)
    if (patch.at !== undefined) set('updated_at', patch.at.toISOString())
    if (sets.length) this.db.prepare(`UPDATE import_items SET ${sets.join(', ')} WHERE scan_id = ? AND key = ?`).run(...params, jobId, key)
    return this.item(jobId, key)
  }

  /** ⚖️ A importação (não arquivada; a mais nova, no empate) que tem itens desta conversa. */
  byConversation(conversationId: string): { job: IImportJobRecord; items: IImportJobItem[] } | undefined {
    const row = this.db
      .prepare(
        `SELECT s.${SCAN_COLUMNS.split(', ').join(', s.')} FROM import_scans s
         WHERE s.archived_at IS NULL AND s.id IN (SELECT scan_id FROM import_items WHERE conversation_id = ?) ORDER BY s.scanned_at DESC, s.rowid DESC LIMIT 1`,
      )
      .get(conversationId) as TRow | undefined
    if (!row) return undefined
    const job = toRecord(row)
    const items = (this.db.prepare('SELECT * FROM import_items WHERE scan_id = ? AND conversation_id = ? ORDER BY key').all(job.id, conversationId) as TRow[]).map(toItem)
    return { job, items }
  }

  createBatch(batch: IImportBatch): void {
    this.db
      .prepare('INSERT INTO import_batches (id, scan_id, name, prefix, keys, item_order, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(batch.id, batch.jobId, batch.name, batch.prefix, JSON.stringify(batch.keys), JSON.stringify(batch.order), batch.by, batch.at.toISOString())
  }

  /** ⚖️ O mais novo pela data e, no empate, pela ordem de gravação (`rowid`). */
  batches(jobId: string): IImportBatch[] {
    return (this.db.prepare('SELECT * FROM import_batches WHERE scan_id = ? ORDER BY created_at DESC, rowid DESC').all(jobId) as TRow[]).map(toBatch)
  }

  batch(jobId: string, batchId: string): IImportBatch | undefined {
    const row = this.db.prepare('SELECT * FROM import_batches WHERE scan_id = ? AND id = ?').get(jobId, batchId) as TRow | undefined
    return row ? toBatch(row) : undefined
  }

  updateBatchItems(jobId: string, batchId: string, keys: readonly string[], order: readonly string[]): void {
    this.db.prepare('UPDATE import_batches SET keys = ?, item_order = ? WHERE scan_id = ? AND id = ?').run(JSON.stringify(keys), JSON.stringify(order), jobId, batchId)
  }

  deleteProject(projectId: string): void {
    this.transaction(() => {
      for (const table of ['import_batches', 'import_items', 'import_analyses'])
        this.db.prepare(`DELETE FROM ${table} WHERE scan_id IN (SELECT id FROM import_scans WHERE project_id = ?)`).run(projectId)
      this.db.prepare('DELETE FROM import_scans WHERE project_id = ?').run(projectId)
    })
  }

  /**
   * A CONSOLIDAÇÃO (boot, idempotente): de "um trabalho por análise" para "uma importação por repositório". Para cada
   * projeto + repositório com mais de um trabalho ativo, o MAIS NOVO fica e os outros viram registro ARQUIVADO.
   * ⛔ Nada é apagado:
   * - os lotes dos antigos MUDAM para o que fica (mesmo nome, prefixo, ordem, autor e data; nome repetido ganha
   *   "(análise de DD/MM)"); a chave que não está no que fica continua no lote, marcada como saída da fonte;
   * - o item que o antigo processou e o que fica não (`consolidatedItem`) leva o processado, com as regras de `carryOver`;
   *   o processado do que fica nunca é sobrescrito;
   * - o item que só o antigo tem entra no que fica marcado como saído da fonte (`gone_at`), como estava;
   * - as análises de cada um entram no registro do que fica.
   * Toda importação ativa sem registro de análise ganha o da própria (a primeira vez que o boot roda com esta tabela).
   */
  consolidate(): IImportConsolidation {
    const out: IImportConsolidation = { kept: [] }
    this.transaction(() => {
      const groups = this.db
        .prepare('SELECT project_id, repository FROM import_scans WHERE archived_at IS NULL GROUP BY project_id, repository HAVING COUNT(*) > 1')
        .all() as TRow[]
      for (const group of groups) {
        const jobs = (
          this.db
            .prepare(`SELECT ${SCAN_COLUMNS} FROM import_scans WHERE project_id = ? AND repository = ? AND archived_at IS NULL ORDER BY scanned_at DESC, rowid DESC`)
            .all(group.project_id as string, group.repository as string) as TRow[]
        ).map(toLegacyRecord)
        const [newest, ...older] = jobs
        const itemsOf = new Map(older.map((job) => [job.id, new Map(this.items(job.id).map((entry) => [entry.key, entry]))]))
        const versions = (key: string) => older.flatMap((job) => itemsOf.get(job.id)!.get(key) ?? [])
        let moved = 0
        const current = this.items(newest.id)
        const here = new Set(current.map((entry) => entry.key))
        for (const entry of current) {
          const merged = consolidatedItem(entry, versions(entry.key))
          if (!merged) continue
          this.putItem(newest.id, merged)
          moved++
        }
        const goneAt = newest.scannedAt
        for (const job of older)
          for (const [key] of itemsOf.get(job.id)!) {
            if (here.has(key)) continue
            here.add(key)
            const all = versions(key)
            const source = all.find(isProcessed) ?? all[0]
            this.putItem(newest.id, { ...source, goneAt })
            moved++
          }

        const names = new Set(this.batches(newest.id).map((batch) => batch.name))
        let batches = 0
        for (const job of older)
          for (const batch of this.batches(job.id)) {
            const name = names.has(batch.name) ? `${batch.name} (análise de ${dayMonth(job.scannedAt)})` : batch.name
            names.add(name)
            this.db.prepare('UPDATE import_batches SET scan_id = ?, name = ? WHERE id = ?').run(newest.id, name, batch.id)
            batches++
          }

        // O registro: as análises antigas (da mais velha à mais nova) e, por fim, a do que fica.
        const logged = (scanId: string) => !!this.db.prepare('SELECT 1 FROM import_analyses WHERE scan_id = ? LIMIT 1').get(scanId)
        const unlogged = [...older].reverse().filter((job) => !logged(job.id))
        const newestLogged = logged(newest.id)
        this.db.prepare(`UPDATE import_analyses SET scan_id = ? WHERE scan_id IN (${older.map(() => '?').join(', ')})`).run(newest.id, ...older.map((job) => job.id))
        for (const job of unlogged) this.seedAnalysis(newest.id, job, [...itemsOf.get(job.id)!.keys()])
        if (!newestLogged)
          this.seedAnalysis(
            newest.id,
            newest,
            current.map((one) => one.key),
          )
        const archivedAt = new Date().toISOString()
        for (const job of older) this.db.prepare('UPDATE import_scans SET archived_at = ? WHERE id = ?').run(archivedAt, job.id)
        out.kept.push({ jobId: newest.id, archived: older.map((job) => job.id), batches, items: moved })
      }
      const bare = (
        this.db
          .prepare(`SELECT ${SCAN_COLUMNS} FROM import_scans s WHERE archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM import_analyses a WHERE a.scan_id = s.id)`)
          .all() as TRow[]
      ).map(toLegacyRecord)
      for (const job of bare)
        this.seedAnalysis(
          job.id,
          job,
          this.items(job.id).map((entry) => entry.key),
        )
    })
    return out
  }

  /** O registro de uma análise antiga, do cabeçalho dela e do `reuse` (sem `reuse`: a primeira, tudo novo). */
  private seedAnalysis(scanId: string, job: IImportJobRecord & { reuse?: ILegacyReuse }, keys: readonly string[]): void {
    const reuse = job.reuse
    this.insertAnalysis(scanId, {
      at: job.scannedAt,
      by: job.by,
      ...(job.head ? { head: job.head } : {}),
      ...(job.dirty !== undefined ? { dirty: job.dirty } : {}),
      kept: reuse?.kept ?? 0,
      stale: reuse?.stale ?? [],
      added: reuse?.added ?? [...keys],
      gone: reuse?.gone ?? [],
      restored: reuse?.restored ?? [],
      returned: [],
    })
  }

  private insertAnalysis(scanId: string, analysis: IImportAnalysis): void {
    const { at, by, head, dirty, kept, ...changes } = analysis
    this.db
      .prepare('INSERT INTO import_analyses (scan_id, analyzed_at, by, head, dirty, kept, changes) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(scanId, at.toISOString(), by, head ?? null, dirty === undefined ? null : dirty ? 1 : 0, kept, JSON.stringify(changes))
  }

  /** Grava o item inteiro: o novo (`replace: false`: chave repetida é erro) ou o que a consolidação trouxe. */
  private putItem(scanId: string, entry: IImportJobItem, replace = true): void {
    this.db
      .prepare(`INSERT ${replace ? 'OR REPLACE ' : ''}INTO import_items (${ITEM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        scanId,
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
        entry.goneAt?.toISOString() ?? null,
      )
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN')
    try {
      work()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

/** O resumo da reanálise do tempo de "um trabalho por análise" (coluna `reuse`): só a consolidação o lê. */
interface ILegacyReuse {
  kept: number
  stale: string[]
  restored: string[]
  added: string[]
  gone: string[]
}

/** `DD/MM` da data (UTC). */
function dayMonth(date: Date): string {
  const iso = date.toISOString()
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
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
    inventory: { ...(JSON.parse(row.inventory as string) as Omit<IImportScan, 'items' | 'scannedAt'>), scannedAt: new Date(row.scanned_at as string) },
  }
}

/** O cabeçalho com o `reuse` antigo, para a consolidação. */
function toLegacyRecord(row: TRow): IImportJobRecord & { reuse?: ILegacyReuse } {
  return { ...toRecord(row), ...(typeof row.reuse === 'string' ? { reuse: JSON.parse(row.reuse) as ILegacyReuse } : {}) }
}

function toAnalysis(row: TRow): IImportAnalysis {
  const changes = JSON.parse(row.changes as string) as Partial<Pick<IImportAnalysis, 'stale' | 'added' | 'gone' | 'restored' | 'returned'>>
  return {
    at: new Date(row.analyzed_at as string),
    by: row.by as string,
    ...(typeof row.head === 'string' ? { head: row.head } : {}),
    ...(row.dirty === null || row.dirty === undefined ? {} : { dirty: Number(row.dirty) === 1 }),
    kept: Number(row.kept),
    stale: changes.stale ?? [],
    added: changes.added ?? [],
    gone: changes.gone ?? [],
    restored: changes.restored ?? [],
    returned: changes.returned ?? [],
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
    ...optional('goneAt', text(row.gone_at) ? new Date(row.gone_at as string) : undefined),
    ...optional('importedBy', typeof row.imported_by === 'string' ? (JSON.parse(row.imported_by) as IImportedBy) : undefined),
  }
}

function toBatch(row: TRow): IImportBatch {
  return {
    id: row.id as string,
    jobId: row.scan_id as string,
    name: row.name as string,
    prefix: row.prefix as string,
    keys: JSON.parse(row.keys as string) as string[],
    order: JSON.parse(row.item_order as string) as string[],
    by: row.created_by as string,
    at: new Date(row.created_at as string),
  }
}
