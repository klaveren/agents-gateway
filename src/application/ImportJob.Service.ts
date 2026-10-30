import { randomUUID } from 'node:crypto'
import { canReclassify, canTransition, carryOver, countByState, reuseSummary, sourceFingerprint, TCarryOutcome } from '@domain/Import.Job'
import { IImportJob, IImportJobItem, IImportJobSummary, TImportItemPatch, TImportManualState } from '@domain/models/ImportJob.Model'
import { IImportScan, TInventoryKind } from '@domain/models/ImportInventory.Model'
import { IImportJobRecord, IImportRepository } from '@domain/ports/ImportRepository.Port'
import { IImportScanOptions } from './ImportScan.Usecase'

/**
 * Por que o pedido não serve:
 * - `not_found`: o trabalho não é deste projeto (ou não existe), ou o item não está nele;
 * - `outdated`: há análise mais nova do repositório; o trabalho antigo é registro e não muda;
 * - `transition`: o estado do item não vai para o pedido;
 * - `reclassify`: o item tem rascunho no caminho (construtor, revisão, aprovado, aplicado).
 */
export class ImportJobError extends Error {
  constructor(
    readonly code: 'not_found' | 'outdated' | 'transition' | 'reclassify',
    message: string,
    readonly field?: string,
  ) {
    super(message)
    this.name = 'ImportJobError'
  }
}

export interface IImportJobDeps {
  repository: IImportRepository
  /** A varredura (mesma contenção e mesmo ignorar da rota `/import/scan`). */
  scan: (projectId: string, repository: string, options: IImportScanOptions) => IImportScan
  now?: () => Date
  newId?: () => string
}

/** A mudança que a pessoa pede num item: excluir/incluir e reclassificar (`null` volta ao tipo detectado). */
export interface IImportItemChange {
  state?: TImportManualState
  kind?: TInventoryKind | null
}

/**
 * O TRABALHO DE IMPORTAÇÃO (`docs/integration/plano-importador.md`, PR 6): a varredura salva, com o estado de cada item.
 *
 * - Analisar = um trabalho novo, que reaproveita pela chave o estado do trabalho mais novo do mesmo repositório
 *   (`carryOver`): fonte igual mantém, fonte mudada depois da decisão vira `stale`.
 * - Só o trabalho mais novo do repositório muda; os anteriores ficam como registro.
 * - A pessoa exclui/inclui e reclassifica, item a item. O autor e a hora ficam no item.
 *
 * ⛔ Nada daqui grava no catálogo nem dispara construtor.
 */
export class ImportJobService {
  constructor(private readonly deps: IImportJobDeps) {}

  /** Analisa o repositório e salva o trabalho. Lança o erro da varredura (repositório fora do projeto…). */
  create(projectId: string, repository: string, by: string, options: IImportScanOptions = {}): IImportJob {
    const scan = this.deps.scan(projectId, repository, options)
    const previous = this.deps.repository.latest(projectId, repository)
    const before = new Map((previous ? this.deps.repository.items(previous.id) : []).map((entry) => [entry.key, entry]))
    const outcomes: Array<{ key: string; outcome: TCarryOutcome }> = []
    const items: IImportJobItem[] = scan.items.map((item) => {
      const fingerprint = sourceFingerprint(item)
      const old = before.get(item.key)
      const carried = carryOver(old, fingerprint)
      outcomes.push({ key: item.key, outcome: carried.outcome })
      if (!old) return { key: item.key, item, state: 'pending', fingerprint, drafts: [] }
      const { item: _old, state: _state, staleFrom: _staleFrom, fingerprint: _fingerprint, ...kept } = old
      return { ...kept, key: item.key, item, fingerprint, state: carried.state, ...(carried.staleFrom ? { staleFrom: carried.staleFrom } : {}) }
    })
    const keys = new Set(scan.items.map((item) => item.key))
    const gone = [...before.keys()].filter((key) => !keys.has(key))
    const { items: _items, ...inventory } = scan
    const id = (this.deps.newId ?? randomUUID)()
    this.deps.repository.create({
      id,
      projectId,
      repository,
      ...(scan.head ? { head: scan.head } : {}),
      ...(scan.dirty !== undefined ? { dirty: scan.dirty } : {}),
      scannedAt: scan.scannedAt,
      by,
      ...(previous ? { previousId: previous.id, reuse: reuseSummary(previous.id, outcomes, gone) } : {}),
      inventory,
      items,
    })
    return this.get(projectId, id)
  }

  list(projectId: string): IImportJobSummary[] {
    return this.deps.repository.list(projectId)
  }

  get(projectId: string, jobId: string): IImportJob {
    const record = this.record(projectId, jobId)
    const items = this.deps.repository.items(record.id)
    return {
      ...this.summary(record, items),
      scan: { ...record.inventory, items: items.map((entry) => entry.item) },
      states: items.map(({ item: _item, basis: _basis, ...state }) => state),
    }
  }

  /**
   * Excluir (`skipped`), incluir (`pending`) e reclassificar um item do trabalho mais novo. Mudar o estado é uma
   * DECISÃO: as fontes de agora viram a base que a próxima reanálise compara.
   */
  updateItem(projectId: string, jobId: string, key: string, change: IImportItemChange, by: string): Omit<IImportJobItem, 'basis'> {
    const record = this.record(projectId, jobId)
    const latest = this.deps.repository.latest(projectId, record.repository)
    if (latest?.id !== record.id) throw new ImportJobError('outdated', 'there is a newer analysis of this repository: open it to change items')
    const current = this.deps.repository.item(record.id, key)
    if (!current) throw new ImportJobError('not_found', `item not found in this import job: ${key}`, 'key')

    const patch: TImportItemPatch = {}
    if (change.kind !== undefined) {
      if (!canReclassify(current.state)) throw new ImportJobError('reclassify', `an item in state ${current.state} cannot be reclassified`, 'kind')
      const kind = change.kind === null || change.kind === current.item.kind ? null : change.kind
      if (kind !== (current.kind ?? null)) patch.kind = kind
    }
    if (change.state !== undefined && change.state !== current.state) {
      if (!canTransition(current.state, change.state)) throw new ImportJobError('transition', `an item in state ${current.state} cannot go to ${change.state}`, 'state')
      patch.state = change.state
      patch.staleFrom = null
      patch.basis = current.fingerprint
    }
    if (patch.kind === undefined && patch.state === undefined) return strip(current)
    const updated = this.deps.repository.updateItem(record.id, key, { ...patch, by, at: (this.deps.now ?? (() => new Date()))() })
    return strip(updated!)
  }

  /** Apagar o projeto apaga os trabalhos dele. */
  removeProject(projectId: string): void {
    this.deps.repository.deleteProject(projectId)
  }

  private record(projectId: string, jobId: string): IImportJobRecord {
    const record = this.deps.repository.get(projectId, jobId)
    if (!record) throw new ImportJobError('not_found', `import job not found: ${jobId}`)
    return record
  }

  private summary(record: IImportJobRecord, items: readonly IImportJobItem[]): IImportJobSummary {
    const { inventory: _inventory, ...rest } = record
    const latest = this.deps.repository.latest(record.projectId, record.repository)
    return { ...rest, items: items.length, byState: countByState(items), latest: latest?.id === record.id }
  }
}

function strip({ basis: _basis, ...item }: IImportJobItem): Omit<IImportJobItem, 'basis'> {
  return item
}
