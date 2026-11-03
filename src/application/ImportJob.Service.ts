import { randomUUID } from 'node:crypto'
import { analysisOf, canReclassify, canTransition, carryOver, countByState, releasedFromBuilder, sourceFingerprint, TCarryOutcome } from '@domain/Import.Job'
import { IImportAnalysis, IImportItemRefresh, IImportJob, IImportJobItem, IImportJobSummary, TImportItemPatch, TImportManualState } from '@domain/models/ImportJob.Model'
import { IImportScan, TInventoryKind } from '@domain/models/ImportInventory.Model'
import { TItemStates } from '@domain/models/ImportPlan.Model'
import { IImportJobRecord, IImportRepository } from '@domain/ports/ImportRepository.Port'
import { draftKindForItem } from '@domain/Import.Draft'
import { lastDraft } from './ImportBuild.Service'
import { IImportScanOptions } from './ImportScan.Usecase'

/**
 * Por que o pedido não serve:
 * - `not_found`: o trabalho não é deste projeto (ou não existe), ou o item não está nele;
 * - `transition`: o estado do item não vai para o pedido;
 * - `reclassify`: o item tem rascunho no caminho (construtor, revisão, aprovado, aplicado);
 * - `invalid`: o pedido não serve no campo (`field`): seleção vazia ou fora do trabalho, prefixo inválido.
 */
export class ImportJobError extends Error {
  constructor(
    readonly code: 'not_found' | 'transition' | 'reclassify' | 'invalid',
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

/** A análise: a importação como ficou e o que mudou nesta análise. */
export interface IImportAnalyzed extends IImportJob {
  analysis: IImportAnalysis
}

/**
 * A IMPORTAÇÃO (`docs/integration/plano-importador.md`, PR 6): a varredura salva de um repositório, com o estado de cada
 * item. ⚖️ UMA por projeto + repositório, e o id não muda:
 * - Analisar a primeira vez cria a importação (tudo `pending`); analisar de novo ATUALIZA a mesma — inventário, `HEAD`,
 *   data — e cada item pela chave (`carryOver`): fonte igual fica como está (rascunho, aprovação, conversa, lote); fonte
 *   mudada depois da decisão vira `stale`, lembrando o estado de antes; o novo entra `pending`.
 * - O item que SAIU DA FONTE fica, marcado (`goneAt`), fora do construtor e da gravação; se voltar, a marca sai e o
 *   `carryOver` vale. O registro de cada análise fica em `analyses`.
 * - A pessoa exclui/inclui e reclassifica, item a item. O autor e a hora ficam no item.
 *
 * ⛔ Nada daqui grava no catálogo nem dispara construtor.
 */
export class ImportJobService {
  constructor(private readonly deps: IImportJobDeps) {}

  /** Analisa o repositório: cria a importação, ou a atualiza no lugar. Lança o erro da varredura (repositório fora do projeto…). */
  create(projectId: string, repository: string, by: string, options: IImportScanOptions = {}): IImportAnalyzed {
    const scan = this.deps.scan(projectId, repository, options)
    const current = this.deps.repository.latest(projectId, repository)
    const { items: _items, ...inventory } = scan
    const header = { at: scan.scannedAt, by, ...(scan.head ? { head: scan.head } : {}), ...(scan.dirty !== undefined ? { dirty: scan.dirty } : {}) }
    const meta = { ...(scan.head ? { head: scan.head } : {}), ...(scan.dirty !== undefined ? { dirty: scan.dirty } : {}), scannedAt: scan.scannedAt, by, inventory }

    if (!current) {
      const id = (this.deps.newId ?? randomUUID)()
      const items: IImportJobItem[] = scan.items.map((item) => ({ key: item.key, item, state: 'pending', fingerprint: sourceFingerprint(item), drafts: [] }))
      const analysis = analysisOf(
        header,
        items.map((entry) => ({ key: entry.key, outcome: 'added' as const })),
        [],
        [],
      )
      this.deps.repository.create({ id, projectId, repository, ...meta, items, analysis })
      return { ...this.get(projectId, id), analysis }
    }

    const before = new Map(this.deps.repository.items(current.id).map((entry) => [entry.key, entry]))
    const outcomes: Array<{ key: string; outcome: TCarryOutcome }> = []
    const returned: string[] = []
    const present: IImportItemRefresh[] = scan.items.map((item) => {
      const fingerprint = sourceFingerprint(item)
      const old = before.get(item.key)
      const carried = reopenedIfGone(carryOver(old, fingerprint), old, item)
      outcomes.push({ key: item.key, outcome: carried.outcome })
      if (old?.goneAt) returned.push(item.key)
      const changed = old && (carried.state !== old.state || (carried.staleFrom ?? null) !== (old.staleFrom ?? null))
      return { key: item.key, item, fingerprint, ...(changed ? { state: carried.state, staleFrom: carried.staleFrom ?? null } : {}) }
    })
    const keys = new Set(scan.items.map((item) => item.key))
    // Só os que saem AGORA: o que já tinha saído continua marcado com a data de quando saiu.
    const gone = [...before.values()].filter((entry) => !keys.has(entry.key) && !entry.goneAt).map((entry) => entry.key)
    const analysis = analysisOf(header, outcomes, gone, returned)
    this.deps.repository.reanalyze({ jobId: current.id, ...meta, present, gone, analysis })
    return { ...this.get(projectId, current.id), analysis }
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
   * Excluir (`skipped`), incluir (`pending`) e reclassificar um item (também o que saiu da fonte). Mudar o estado é uma
   * DECISÃO: as fontes de agora viram a base que a próxima reanálise compara.
   */
  updateItem(projectId: string, jobId: string, key: string, change: IImportItemChange, by: string): Omit<IImportJobItem, 'basis'> {
    const record = this.record(projectId, jobId)
    const current = this.deps.repository.item(record.id, key)
    if (!current) throw new ImportJobError('not_found', `item not found in this import job: ${key}`, 'key')

    const patch: TImportItemPatch = {}
    if (change.kind !== undefined) {
      if (!canReclassify(current.state, !!lastDraft(current)))
        throw new ImportJobError('reclassify', `an item in state ${current.state}${current.state === 'drafting' ? ' with a draft' : ''} cannot be reclassified`, 'kind')
      const kind = change.kind === null || change.kind === current.item.kind ? null : change.kind
      if (kind !== (current.kind ?? null)) patch.kind = kind
      // No construtor sem rascunho: sai da conversa e volta à fila, para o construtor do tipo novo.
      if (patch.kind !== undefined && current.state === 'drafting') Object.assign(patch, releasedFromBuilder(current.fingerprint))
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

  /**
   * O estado de ALGUNS itens do trabalho (o painel ao lado da conversa de importação), sem o inventário inteiro. A chave
   * que não é do trabalho fica de fora. `latest`: sempre `true` (uma importação por repositório; fica para quem o lê).
   */
  statesFor(projectId: string, jobId: string, keys: readonly string[]): { latest: boolean; states: IImportJob['states'] } {
    const record = this.record(projectId, jobId)
    const states = [...new Set(keys)].flatMap((key) => {
      const entry = this.deps.repository.item(record.id, key)
      if (!entry) return []
      const { item: _item, basis: _basis, ...state } = entry
      return [state]
    })
    return { latest: true, states }
  }

  /** O repositório e o estado de cada item do trabalho (o lote do agente marca o aprovado e o aplicado). Ausente = não é deste projeto. */
  statesOf(projectId: string, jobId: string): { repository: string; states: TItemStates } | undefined {
    const record = this.deps.repository.get(projectId, jobId)
    if (!record) return undefined
    return { repository: record.repository, states: new Map(this.deps.repository.items(record.id).map((entry) => [entry.key, entry.state])) }
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
    return {
      ...rest,
      items: items.length,
      byState: countByState(items),
      gone: items.filter((entry) => entry.goneAt).length,
      latest: true,
      analyses: this.deps.repository.analyses(record.id),
    }
  }
}

/**
 * ⚖️ GRAVADO QUE SAIU DO CATÁLOGO (alguém o apagou para processar de novo) ou que deixou de ser importável (o tipo
 * detectado mudou para um sem construtor, como a entrada de uma CLI): volta a PENDENTE. ⛔ Não volta à revisão com o
 * rascunho antigo — quem apagou quer processar de novo, e o rascunho de antes pode não passar nas regras de agora; o
 * Preparar abre uma conversa NOVA (com o protocolo de hoje).
 */
function reopenedIfGone(carried: ReturnType<typeof carryOver>, old: IImportJobItem | undefined, item: IImportScan['items'][number]): ReturnType<typeof carryOver> {
  if (!old || carried.state !== 'applied') return carried
  const kind = draftKindForItem(old.kind ?? item.kind)
  if (kind && item.catalog !== 'new') return carried
  return { ...carried, state: 'pending', staleFrom: undefined }
}

function strip({ basis: _basis, ...item }: IImportJobItem): Omit<IImportJobItem, 'basis'> {
  return item
}
