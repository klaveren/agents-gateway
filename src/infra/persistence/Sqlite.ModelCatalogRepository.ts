import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ICatalogModel, IModelReasoning, TPriceSource } from '@domain/models/ModelCatalog.Model'
import { IModelPrice } from '@domain/models/Model.Pricing'
import { IModelCatalogRepository, TCatalogPatch } from '@domain/ports/ModelCatalogRepository.Port'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS provider_models (
    provider_id     TEXT    NOT NULL,
    model_id        TEXT    NOT NULL,
    label           TEXT,
    enabled         INTEGER NOT NULL DEFAULT 0,
    available       INTEGER NOT NULL DEFAULT 1,
    context_length  INTEGER,
    price           TEXT,
    price_source    TEXT,
    reasoning       TEXT,
    synced_at       TEXT,
    updated_at      TEXT    NOT NULL,
    updated_by      TEXT,
    PRIMARY KEY (provider_id, model_id)
  );
`

type TRow = Record<string, unknown>

/** Colunas que um arquivo antigo ainda não tem. `ALTER ADD COLUMN` só acrescenta; nunca reescreve. */
const ADDED_COLUMNS: Array<{ column: string; definition: string }> = [{ column: 'reasoning', definition: 'TEXT' }]

const COLUMNS: Record<keyof TCatalogPatch, string> = {
  label: 'label',
  enabled: 'enabled',
  available: 'available',
  contextLength: 'context_length',
  price: 'price',
  priceSource: 'price_source',
  reasoning: 'reasoning',
  syncedAt: 'synced_at',
  updatedAt: 'updated_at',
  updatedBy: 'updated_by',
}

/** O catálogo de modelos, no mesmo arquivo das conversas. O preço vai como JSON (os campos de `IModelPrice`). */
export class SqliteModelCatalogRepository implements IModelCatalogRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    this.migrate()
  }

  private migrate(): void {
    const existing = this.db.prepare('PRAGMA table_info(provider_models)').all() as TRow[]
    for (const { column, definition } of ADDED_COLUMNS) {
      if (!existing.some((row) => row.name === column)) this.db.exec(`ALTER TABLE provider_models ADD COLUMN ${column} ${definition}`)
    }
  }

  list(providerId?: string): ICatalogModel[] {
    const rows = providerId
      ? this.db.prepare('SELECT * FROM provider_models WHERE provider_id = ? ORDER BY enabled DESC, model_id ASC').all(providerId)
      : this.db.prepare('SELECT * FROM provider_models ORDER BY provider_id ASC, enabled DESC, model_id ASC').all()
    return (rows as TRow[]).map(toModel)
  }

  get(providerId: string, modelId: string): ICatalogModel | undefined {
    const row = this.db.prepare('SELECT * FROM provider_models WHERE provider_id = ? AND model_id = ?').get(providerId, modelId) as TRow | undefined
    return row ? toModel(row) : undefined
  }

  insert(model: ICatalogModel): void {
    this.db
      .prepare(
        `INSERT INTO provider_models (provider_id, model_id, label, enabled, available, context_length, price, price_source, reasoning, synced_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        model.providerId,
        model.modelId,
        model.label ?? null,
        model.enabled ? 1 : 0,
        model.available ? 1 : 0,
        model.contextLength ?? null,
        model.price ? JSON.stringify(model.price) : null,
        model.priceSource ?? null,
        model.reasoning ? JSON.stringify(model.reasoning) : null,
        model.syncedAt?.toISOString() ?? null,
        model.updatedAt.toISOString(),
        model.updatedBy ?? null,
      )
  }

  update(providerId: string, modelId: string, patch: TCatalogPatch): ICatalogModel | undefined {
    // `price`/`priceSource` podem vir `undefined` DE PROPÓSITO (apagar o preço): presença da chave decide.
    const entries = (Object.keys(patch) as Array<keyof TCatalogPatch>).filter((key) => key in COLUMNS && (patch[key] !== undefined || key === 'price' || key === 'priceSource'))
    if (entries.length) {
      const values = entries.map((key) => toColumn(patch[key]))
      this.db
        .prepare(`UPDATE provider_models SET ${entries.map((key) => `${COLUMNS[key]} = ?`).join(', ')} WHERE provider_id = ? AND model_id = ?`)
        .run(...values, providerId, modelId)
    }
    return this.get(providerId, modelId)
  }

  clear(providerId: string): void {
    this.db.prepare('DELETE FROM provider_models WHERE provider_id = ?').run(providerId)
  }
}

function toColumn(value: unknown): string | number | null {
  if (value === undefined || value === null) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'object') return JSON.stringify(value)
  return value as string | number
}

function json<T>(value: unknown): T | undefined {
  try {
    return typeof value === 'string' ? (JSON.parse(value) as T) : undefined
  } catch {
    return undefined
  }
}

function toModel(row: TRow): ICatalogModel {
  const price = json<IModelPrice>(row.price)

  return {
    providerId: String(row.provider_id),
    modelId: String(row.model_id),
    label: typeof row.label === 'string' ? row.label : undefined,
    enabled: Number(row.enabled) === 1,
    available: Number(row.available) === 1,
    contextLength: typeof row.context_length === 'number' ? row.context_length : undefined,
    price,
    priceSource: typeof row.price_source === 'string' ? (row.price_source as TPriceSource) : undefined,
    reasoning: json<IModelReasoning>(row.reasoning),
    syncedAt: typeof row.synced_at === 'string' ? new Date(row.synced_at) : undefined,
    updatedAt: new Date(String(row.updated_at)),
    updatedBy: typeof row.updated_by === 'string' ? row.updated_by : undefined,
  }
}
