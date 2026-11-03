import { randomUUID } from 'node:crypto'
import { IMPORT_PREFIX_PATTERN, itemClosure, planSelectionBatch } from '@domain/Import.Order'
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
  /** Com as DEPENDÊNCIAS: cada chave traz o fecho dela (o agente com os triggers e o que citam, transitivo). */
  closure?: boolean
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
 * ⚖️ O lote sobrevive à reanálise. A chave cujo item SAIU DA FONTE continua no lote (`gone`), fora do cálculo: não
 * entra na ordem nem nas dependências.
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

  /** Salva o lote da seleção na importação. */
  create(projectId: string, jobId: string, selection: IImportSelection & { name: string }, by: string): IImportBatchView {
    const record = this.record(projectId, jobId)
    const name = selection.name.trim()
    if (!name) throw new ImportJobError('invalid', 'name is required', 'name')
    const entries = this.deps.repository.items(record.id)
    const plan = this.compute(record, entries, selection)
    const keys = withGone(plan.keys, selection.keys, entries)
    const batch: IImportBatch = {
      id: (this.deps.newId ?? randomUUID)(),
      jobId: record.id,
      name: name.slice(0, IMPORT_BATCH_NAME_MAX),
      prefix: plan.prefix,
      keys,
      order: plan.steps.map((step) => step.key),
      by,
      at: (this.deps.now ?? (() => new Date()))(),
    }
    this.deps.repository.createBatch(batch)
    return { ...batch, gone: goneKeys(keys, entries), plan }
  }

  /**
   * ACRESCENTA itens a um lote salvo (o "gravar junto" do passo Gravar, ou mais itens do inventário), com as
   * dependências deles quando `closure`: a ordem é recalculada sobre todos. A chave que saiu da fonte fica no lote.
   */
  addItems(projectId: string, jobId: string, batchId: string, input: { keys: readonly string[]; closure?: boolean }): IImportBatchView {
    const record = this.record(projectId, jobId)
    const batch = this.deps.repository.batch(record.id, batchId)
    if (!batch) throw new ImportJobError('not_found', `import batch not found: ${batchId}`)
    const entries = this.deps.repository.items(record.id)
    const added = this.compute(record, entries, { keys: input.keys, ...(input.closure ? { closure: true } : {}), prefix: batch.prefix }, batch.id, true).keys
    const keys = [...new Set([...batch.keys, ...added])]
    const plan = this.compute(record, entries, { keys, prefix: batch.prefix }, batch.id)
    const order = plan.steps.map((step) => step.key)
    const kept = withGone(plan.keys, keys, entries)
    this.deps.repository.updateBatchItems(record.id, batch.id, kept, order)
    return { ...batch, keys: kept, order, gone: goneKeys(kept, entries), plan }
  }

  /** Os lotes, cada um com as chaves que saíram da fonte. */
  list(projectId: string, jobId: string): IImportBatch[] {
    const record = this.record(projectId, jobId)
    const entries = this.deps.repository.items(record.id)
    return this.deps.repository.batches(record.id).map((batch) => ({ ...batch, gone: goneKeys(batch.keys, entries) }))
  }

  /** O lote salvo, com o lote recalculado sobre o estado de agora (aprovado, aplicado, outros lotes). */
  get(projectId: string, jobId: string, batchId: string): IImportBatchView {
    const record = this.record(projectId, jobId)
    const batch = this.deps.repository.batch(record.id, batchId)
    if (!batch) throw new ImportJobError('not_found', `import batch not found: ${batchId}`)
    const entries = this.deps.repository.items(record.id)
    return { ...batch, gone: goneKeys(batch.keys, entries), plan: this.compute(record, entries, batch, batch.id) }
  }

  /** `strict`: a chave que não é da importação é recusada (a seleção nova); no lote salvo ela só fica de fora (`gone`). */
  private compute(record: IImportJobRecord, entries: readonly IImportJobItem[], selection: IImportSelection, self?: string, strict = self === undefined): ISelectionPlan {
    const prefix = (selection.prefix ?? '').trim().toLowerCase()
    if (prefix && !IMPORT_PREFIX_PATTERN.test(prefix)) throw new ImportJobError('invalid', 'prefix: lowercase letters, digits and "-", up to 16 characters', 'prefix')
    const projectId = record.projectId
    const catalog = (query: { kind: TInventoryKind; id: string; parent?: string; title?: string }) => this.deps.catalogState({ ...query, projectId })
    // ⚖️ O que saiu da fonte fica fora do cálculo (ordem, dependências, estimativa); o lote guarda a chave.
    const live = entries.filter((entry) => !entry.goneAt)
    const items = live.map((entry) => effective(entry, catalog))
    const keys = selection.closure ? withClosure(items, selection.keys) : [...new Set(selection.keys)]
    if (!keys.length) throw new ImportJobError('invalid', 'select at least one item', 'keys')
    if (keys.length > IMPORT_BATCH_MAX) throw new ImportJobError('invalid', `at most ${IMPORT_BATCH_MAX} items in a batch`, 'keys')
    const known = new Set(entries.map((entry) => entry.key))
    const unknown = keys.filter((key) => !known.has(key))
    if (unknown.length && strict) throw new ImportJobError('invalid', `not in this import job: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}`, 'keys')

    const batchOf = new Map<string, { id: string; name: string }>()
    for (const other of this.deps.repository.batches(record.id)) {
      if (other.id === self) continue
      for (const key of other.keys) if (!batchOf.has(key)) batchOf.set(key, { id: other.id, name: other.name })
    }
    return planSelectionBatch({
      items,
      keys,
      prefix,
      catalog,
      protocolTokens: this.protocolTokens,
      states: new Map(live.map((entry) => [entry.key, entry.state])),
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

/** As chaves do lote cujo item saiu da fonte (ou não está mais na importação). */
function goneKeys(keys: readonly string[], entries: readonly IImportJobItem[]): string[] {
  const live = new Set(entries.filter((entry) => !entry.goneAt).map((entry) => entry.key))
  return keys.filter((key) => !live.has(key))
}

/** As chaves calculadas e, depois, as escolhidas que saíram da fonte (o cálculo as deixa de fora; o lote não). */
function withGone(planned: readonly string[], chosen: readonly string[], entries: readonly IImportJobItem[]): string[] {
  const gone = new Set(goneKeys(chosen, entries))
  return [...new Set([...planned, ...chosen.filter((key) => gone.has(key))])]
}

/** As chaves com o fecho de cada uma, na ordem em que aparecem (a escolhida primeiro). */
function withClosure(items: readonly IInventoryItem[], keys: readonly string[]): string[] {
  const all = new Set<string>()
  for (const key of keys) {
    all.add(key)
    for (const member of itemClosure(items, key).members.keys()) all.add(member)
  }
  return [...all]
}
