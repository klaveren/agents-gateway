import { randomUUID } from 'node:crypto'
import { IMPORT_PREFIX_PATTERN, planSelectionBatch } from '@domain/Import.Order'
import { IImportBatch, IImportJobItem } from '@domain/models/ImportJob.Model'
import { CATALOG_KINDS, IInventoryItem, TCatalogState, TInventoryKind } from '@domain/models/ImportInventory.Model'
import { ISelectionPlan } from '@domain/models/ImportPlan.Model'
import { IImportJobRecord, IImportRepository } from '@domain/ports/ImportRepository.Port'
import { ImportJobError } from './ImportJob.Service'
import { builderProtocolTokens } from './ImportPlan.Usecase'
import { IImportCatalogQuery } from './ImportScan.Usecase'

/** O máximo de itens num lote (um repositório grande dá ~730 itens). */
export const IMPORT_BATCH_MAX = 5_000
export const IMPORT_BATCH_NAME_MAX = 120

export interface IImportBatchDeps {
  repository: IImportRepository
  /** O estado no catálogo de um id (o mesmo da varredura: `ImportScanUseCase.catalogState`). */
  catalogState: (query: IImportCatalogQuery) => TCatalogState
  protocolTokens?: (kind: TInventoryKind) => number
  now?: () => Date
  newId?: () => string
}

/** A seleção: as chaves dos itens do trabalho e o prefixo opcional dos ids. */
export interface IImportSelection {
  keys: readonly string[]
  prefix?: string
}

/** O lote salvo, aberto: o registro e o lote calculado agora (estado e catálogo de agora). */
export interface IImportBatchView extends IImportBatch {
  plan: ISelectionPlan
}

/**
 * Os LOTES POR SELEÇÃO de um trabalho de importação (`docs/integration/plano-importador.md`, decisão de 30/10): a
 * pessoa escolhe itens do trabalho (todas as knowledge, as specs de uma pasta…), vê a ordem só entre eles, as citações
 * para fora e a estimativa, e salva o lote com um nome.
 *
 * ⛔ Nada daqui grava no catálogo, chama modelo ou dispara construtor. Salvar o lote é só o registro no trabalho.
 * Só o trabalho mais novo do repositório ganha lote; o antigo é registro.
 */
export class ImportBatchService {
  private readonly protocolTokens: (kind: TInventoryKind) => number

  constructor(private readonly deps: IImportBatchDeps) {
    this.protocolTokens = deps.protocolTokens ?? builderProtocolTokens()
  }

  /** O lote da seleção, sem salvar (a prévia da tela). */
  plan(projectId: string, jobId: string, selection: IImportSelection): ISelectionPlan {
    const record = this.record(projectId, jobId)
    return this.compute(record, this.deps.repository.items(record.id), selection)
  }

  /** Salva o lote da seleção no trabalho mais novo do repositório. */
  create(projectId: string, jobId: string, selection: IImportSelection & { name: string }, by: string): IImportBatchView {
    const record = this.record(projectId, jobId)
    const latest = this.deps.repository.latest(projectId, record.repository)
    if (latest?.id !== record.id) throw new ImportJobError('outdated', 'there is a newer analysis of this repository: open it to build batches')
    const name = selection.name.trim()
    if (!name) throw new ImportJobError('invalid', 'name is required', 'name')
    const plan = this.compute(record, this.deps.repository.items(record.id), selection)
    const batch: IImportBatch = {
      id: (this.deps.newId ?? randomUUID)(),
      jobId: record.id,
      name: name.slice(0, IMPORT_BATCH_NAME_MAX),
      prefix: plan.prefix,
      keys: plan.keys,
      order: plan.steps.map((step) => step.key),
      by,
      at: (this.deps.now ?? (() => new Date()))(),
    }
    this.deps.repository.createBatch(batch)
    return { ...batch, plan }
  }

  list(projectId: string, jobId: string): IImportBatch[] {
    return this.deps.repository.batches(this.record(projectId, jobId).id)
  }

  /** O lote salvo, com o lote recalculado sobre o estado de agora (aprovado, aplicado, outros lotes). */
  get(projectId: string, jobId: string, batchId: string): IImportBatchView {
    const record = this.record(projectId, jobId)
    const batch = this.deps.repository.batch(record.id, batchId)
    if (!batch) throw new ImportJobError('not_found', `import batch not found: ${batchId}`)
    return { ...batch, plan: this.compute(record, this.deps.repository.items(record.id), batch, batch.id) }
  }

  private compute(record: IImportJobRecord, entries: readonly IImportJobItem[], selection: IImportSelection, self?: string): ISelectionPlan {
    const prefix = (selection.prefix ?? '').trim().toLowerCase()
    if (prefix && !IMPORT_PREFIX_PATTERN.test(prefix)) throw new ImportJobError('invalid', 'prefix: lowercase letters, digits and "-", up to 16 characters', 'prefix')
    const keys = [...new Set(selection.keys)]
    if (!keys.length) throw new ImportJobError('invalid', 'select at least one item', 'keys')
    if (keys.length > IMPORT_BATCH_MAX) throw new ImportJobError('invalid', `at most ${IMPORT_BATCH_MAX} items in a batch`, 'keys')
    const known = new Set(entries.map((entry) => entry.key))
    const unknown = keys.filter((key) => !known.has(key))
    if (unknown.length) throw new ImportJobError('invalid', `not in this import job: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}`, 'keys')

    const projectId = record.projectId
    const catalog = (query: { kind: TInventoryKind; id: string; parent?: string; title?: string }) => this.deps.catalogState({ ...query, projectId })
    const batchOf = new Map<string, { id: string; name: string }>()
    for (const other of this.deps.repository.batches(record.id)) {
      if (other.id === self) continue
      for (const key of other.keys) if (!batchOf.has(key)) batchOf.set(key, { id: other.id, name: other.name })
    }
    return planSelectionBatch({
      items: entries.map((entry) => effective(entry, catalog)),
      keys,
      prefix,
      catalog,
      protocolTokens: this.protocolTokens,
      states: new Map(entries.map((entry) => [entry.key, entry.state])),
      batchOf,
    })
  }

  private record(projectId: string, jobId: string): IImportJobRecord {
    const record = this.deps.repository.get(projectId, jobId)
    if (!record) throw new ImportJobError('not_found', `import job not found: ${jobId}`)
    return record
  }
}

/** O item com o tipo que a pessoa escolheu; reclassificado para um tipo do catálogo, o estado no catálogo é consultado. */
function effective(entry: IImportJobItem, catalog: (query: { kind: TInventoryKind; id: string; title?: string }) => TCatalogState): IInventoryItem {
  if (!entry.kind || entry.kind === entry.item.kind) return entry.item
  const { catalog: _catalog, ...item } = entry.item
  const state =
    CATALOG_KINDS.includes(entry.kind) && entry.kind !== 'trigger' ? catalog({ kind: entry.kind, id: item.candidateId, ...(item.title ? { title: item.title } : {}) }) : undefined
  return { ...item, kind: entry.kind, ...(state ? { catalog: state } : {}) }
}
