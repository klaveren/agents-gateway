import { randomUUID } from 'node:crypto'
import { documentFromText, ICatalogDocument, TCatalogKind } from '@domain/Catalog.Document'
import { confirmsWidenings, IWidening, wideningKeys, wideningsOf } from '@domain/Catalog.Widening'
import {
  CatalogRestoreInvalidError,
  CatalogRevisionConflictError,
  CatalogRevisionNotFoundError,
  CatalogWideningConfirmationError,
  CatalogWideningForbiddenError,
  IWideningRef,
} from '@domain/errors/Domain.Error'
import { parseMcpServerKey } from '@domain/models/McpServer.Model'
import { IBatchWidening, ICatalogBatch, ICatalogBatchRepository, ICatalogHistoryRepository, ICatalogRevision, TRevisionSummary } from '@domain/ports/CatalogHistoryRepository.Port'
import type { CatalogReader } from './Catalog.Reader'
import type { ICatalogWriter, IPreparedWrite } from './Catalog.Writer'
import type { CatalogHistoryService, ICatalogChange, ICatalogItemKey } from './CatalogHistory.Service'

/** Um item do histórico: `itemId` é o `item_id` gravado (no MCP, a chave com o projeto). */
export interface IRestoreItem {
  kind: TCatalogKind
  itemId: string
}

/**
 * Quem pede. ⛔ `viaAccessToken`: o pedido chegou com um token de acesso (CI), e não com a sessão de login de uma pessoa
 * na tela — ampliação de permissão é recusada mesmo com `confirm` (decisão do dono, 30/10).
 */
export interface IRestoreCaller {
  by: string
  viaAccessToken: boolean
}

export interface IRestoreRequest {
  item: IRestoreItem
  /** A revisão cujo documento volta. */
  revision: number
  /** A última revisão que a pessoa viu (`0` = nenhuma). Outra = alguém mexeu no meio: 409. */
  expectedRevision: number
  /** As chaves das ampliações que a pessoa aceita: EXATAMENTE as calculadas aqui (ver `confirmsWidenings`). */
  confirm?: readonly string[]
}

export interface IRestoreResult {
  kind: TCatalogKind
  itemId: string
  restoredFrom: number
  /** A versão já era a atual: nada foi gravado. */
  unchanged: boolean
  /** O item existe depois do rollback (a revisão restaurada podia ser a de um `delete`). */
  exists: boolean
  /** A revisão nova do item (ausente quando nada mudou). */
  revision?: TRevisionSummary
  /** As revisões dos outros itens que mudaram junto (a cascata, a renumeração das rules). */
  alsoChanged: TRevisionSummary[]
  /** As ampliações aceitas (vão gravadas na revisão, com quem aceitou). */
  widenings: IWidening[]
  /** Os segredos que o item pede e o cofre não tem: cadastrar pela tela do MCP. ⛔ O rollback não mexe no cofre. */
  missingSecrets: string[]
}

export interface IRevertRequest {
  batchId: string
  /** As chaves de TODAS as ampliações do conjunto: exatamente as calculadas aqui. */
  confirm?: readonly string[]
  /** Os itens (`<kind>/<itemId>`) que mudaram depois do lote e que a pessoa decidiu reverter assim mesmo, um a um. */
  overwrite?: readonly string[]
}

/** Um item na reversão: a referência `<kind>/<itemId>`. */
export interface IRevertItem {
  ref: string
  kind: TCatalogKind
  itemId: string
  /** A revisão de antes do lote (`0` = o item não existia: a reversão o apaga). */
  toRevision: number
}

export interface IRevertResult {
  /** O lote NOVO (a reversão), com o estado final. */
  batch: ICatalogBatch
  reverted: Array<IRevertItem & { revision?: number; missingSecrets: string[] }>
  /** Já estavam como antes do lote: nada a gravar. */
  unchanged: IRevertItem[]
  /** Mudaram depois do lote e não vieram em `overwrite`: pulados (o lote fica `partial`). */
  conflicts: Array<IRevertItem & { currentRevision: number }>
  /** O item em que a reversão parou, e por quê. Os seguintes não foram tocados. */
  failed?: IRevertItem & { message: string; issues?: Array<{ field: string; message: string }> }
}

export interface ICatalogRestoreDeps {
  repository: Pick<ICatalogHistoryRepository, 'latest' | 'revision'> & ICatalogBatchRepository
  history: Pick<CatalogHistoryService, 'within'>
  reader: Pick<CatalogReader, 'read'>
  writer: ICatalogWriter
  now?: () => Date
  newId?: () => string
}

/** Um item pronto para voltar: o que é, o que vai ser, e as ampliações da troca. */
interface IPlannedItem extends IRevertItem {
  current: ICatalogDocument | undefined
  target: ICatalogDocument | undefined
  widenings: IWidening[]
  /** A última revisão do item quando o plano foi feito (concorrência otimista). */
  expected: number
  /** A ordem em que o lote o gravou (o id da primeira revisão dele no lote). */
  order: number
}

/**
 * O ROLLBACK DO CATÁLOGO: restaurar uma revisão de um item e reverter um lote (ver
 * docs/integration/plano-catalogo-historico.md §2.3 e §3, PR 5).
 *
 * ⚖️ NUNCA REESCREVE O PASSADO: restaurar grava uma revisão NOVA (`op = restore`) com o conteúdo da antiga; o que veio
 * depois continua no histórico. Vários agentes e pessoas mexem ao mesmo tempo — apagar revisão apagaria o trabalho deles.
 *
 * ⛔ AS TRÊS TRAVAS, nesta ordem:
 * 1. concorrência otimista: `expectedRevision` é a última que a pessoa viu; outra (ou o item mudou fora do histórico)
 *    é 409 com o estado atual;
 * 2. ampliação de permissão (`Catalog.Widening`): só aplica com `confirm` IGUAL ao conjunto calculado aqui, e só por
 *    um admin na tela — token de acesso recebe recusa mesmo com `confirm`;
 * 3. as regras de hoje: o documento volta pelos serviços de escrita (`Catalog.Writer`), com as validações de sempre.
 *
 * ⚖️ ATOMICIDADE = LOTE ORDENADO + REVERSÃO DE LOTE (decisão do dono): cada repositório tem a sua conexão, então não há
 * transação. A reversão grava item a item, na ordem inversa da do lote e, dentro de um mesmo tipo, o que restringe antes
 * do que amplia — se parar no meio, o ambiente nunca fica mais aberto do que estava. Para no primeiro erro e fica
 * `partial`; o que já foi gravado está no histórico com o `batchId` novo.
 */
export class CatalogRestoreUseCase {
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(private readonly deps: ICatalogRestoreDeps) {
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => randomUUID())
  }

  async restore(request: IRestoreRequest, caller: IRestoreCaller): Promise<IRestoreResult> {
    const { kind, itemId } = request.item
    const old = this.deps.repository.revision(kind, itemId, request.revision)
    if (!old) throw new CatalogRevisionNotFoundError(`revision ${request.revision} of ${kind}/${itemId}`)
    const current = this.fresh(request.item, request.expectedRevision)
    const target = this.documentOf(old)
    const base = { kind, itemId, restoredFrom: request.revision, alsoChanged: [], missingSecrets: [] }
    if (current?.hash === target?.hash) return { ...base, unchanged: true, exists: !!current, widenings: [] }

    const widenings = wideningsOf(current, target)
    gate(widenings, request.confirm, caller)
    const prepared = await this.prepare(target, current)
    // A preparação esperou (as regras do momento): confere de novo, já sem nada assíncrono até gravar.
    this.fresh(request.item, request.expectedRevision)
    const note = target ? `restaurado da rev ${request.revision}` : `restaurado da rev ${request.revision} (o item não existia)`
    const revisions = this.apply(prepared, this.keyOf(request.item, current ?? target), {
      by: caller.by,
      source: 'restore',
      op: 'restore',
      note,
      widenings: wideningKeys(widenings),
    })
    await prepared.after?.()
    const own = revisions.find((revision) => revision.kind === kind && revision.itemId === itemId)
    return {
      ...base,
      unchanged: !own,
      exists: !!target,
      ...(own ? { revision: summary(own) } : {}),
      alsoChanged: revisions.filter((revision) => revision !== own).map(summary),
      widenings,
      missingSecrets: prepared.missingSecrets?.() ?? [],
    }
  }

  async revert(request: IRevertRequest, caller: IRestoreCaller): Promise<IRevertResult> {
    const { repository } = this.deps
    const original = repository.batch(request.batchId)
    if (!original) throw new CatalogRevisionNotFoundError(`batch ${request.batchId}`)
    if (original.status === 'reverted') throw new CatalogRevisionConflictError(`Batch ${original.id} was already reverted`, { batch: original.id, status: original.status })

    // Item a item: a primeira e a última revisão dele no lote.
    const touched = new Map<string, { first: ICatalogRevision; last: ICatalogRevision }>()
    for (const revision of repository.batchRevisions(original.id)) {
      const ref = refOf(revision)
      const seen = touched.get(ref)
      touched.set(ref, { first: seen?.first ?? revision, last: revision })
    }

    const overwrite = new Set(request.overwrite ?? [])
    const planned: IPlannedItem[] = []
    const unchanged: IRevertItem[] = []
    const conflicts: IRevertResult['conflicts'] = []
    for (const [ref, { first, last }] of touched) {
      const item: IRevertItem = { ref, kind: first.kind, itemId: first.itemId, toRevision: first.revision - 1 }
      const before = item.toRevision > 0 ? repository.revision(item.kind, item.itemId, item.toRevision) : undefined
      const latest = repository.latest(item.kind, item.itemId)
      const current = this.read(item)
      const target = before ? this.documentOf(before) : undefined
      // Já está como antes do lote (uma reversão anterior que parou no meio, ou alguém já desfez): nada a fazer.
      if (current?.hash === target?.hash) {
        unchanged.push(item)
        continue
      }
      const changedAfter = latest?.revision !== last.revision || current?.hash !== latestHash(latest)
      if (changedAfter && !overwrite.has(ref)) {
        conflicts.push({ ...item, currentRevision: latest?.revision ?? 0 })
        continue
      }
      planned.push({ ...item, current, target, widenings: wideningsOf(current, target), expected: latest?.revision ?? 0, order: first.id })
    }

    const widenings = planned.flatMap((item) => item.widenings)
    gate(widenings, request.confirm, caller)

    const batch = repository.createBatch({
      id: this.newId(),
      at: this.now(),
      by: caller.by,
      kind: 'revert',
      scope: original.scope,
      summary: { reverts: original.id },
      widenings: planned.flatMap((item) =>
        item.widenings.map((widening): IBatchWidening => ({ kind: item.kind, itemId: item.itemId, key: widening.key, description: widening.description })),
      ),
      status: 'partial',
    })

    const reverted: IRevertResult['reverted'] = []
    let failed: IRevertResult['failed']
    for (const item of safeOrder(planned)) {
      const { ref, kind, itemId, toRevision } = item
      try {
        const current = this.fresh(item, item.expected, batch.id)
        const prepared = await this.prepare(item.target, current)
        this.fresh(item, item.expected, batch.id)
        const note = `reversão do lote ${original.id}: volta à rev ${toRevision}${toRevision ? '' : ' (o item não existia)'}`
        const change: ICatalogChange = { by: caller.by, source: 'restore', op: 'restore', batchId: batch.id, note, widenings: wideningKeys(item.widenings) }
        const revisions = this.apply(prepared, this.keyOf(item, current ?? item.target), change)
        await prepared.after?.()
        const own = revisions.find((revision) => revision.kind === kind && revision.itemId === itemId)
        reverted.push({ ref, kind, itemId, toRevision, ...(own ? { revision: own.revision } : {}), missingSecrets: prepared.missingSecrets?.() ?? [] })
      } catch (error: unknown) {
        failed = {
          ref,
          kind,
          itemId,
          toRevision,
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof CatalogRestoreInvalidError ? { issues: error.issues } : {}),
        }
        break
      }
    }

    const status = failed || conflicts.length ? 'partial' : 'applied'
    repository.finishBatch(batch.id, {
      status,
      summary: {
        reverts: original.id,
        reverted: reverted.map((item) => item.ref),
        unchanged: unchanged.map((item) => item.ref),
        conflicts: conflicts.map((item) => item.ref),
        ...(failed ? { failed: { ref: failed.ref, message: failed.message } } : {}),
      },
    })
    if (status === 'applied') repository.markReverted(original.id)
    return { batch: repository.batch(batch.id)!, reverted, unchanged, conflicts, ...(failed ? { failed } : {}) }
  }

  /**
   * ⛔ A CONCORRÊNCIA OTIMISTA: a última revisão é a esperada E o item está como ela diz (senão mudou fora do histórico,
   * e quem pede não viu). `ownBatch` (na reversão): as revisões que a PRÓPRIA reversão gravou depois (a cascata de um
   * item anterior dela, a renumeração das rules) não contam como "alguém mexeu".
   */
  private fresh(item: IRestoreItem, expected: number, ownBatch?: string): ICatalogDocument | undefined {
    const { repository } = this.deps
    const latest = repository.latest(item.kind, item.itemId)
    const current = this.read(item)
    const state = { revision: latest?.revision ?? 0, exists: !!current, ...(current ? { hash: current.hash } : {}) }
    const ours = (number: number) => ownBatch !== undefined && repository.revision(item.kind, item.itemId, number)?.batchId === ownBatch
    let moved = state.revision !== expected
    if (moved && ownBatch !== undefined && state.revision > expected) {
      moved = false
      for (let number = expected + 1; number <= state.revision && !moved; number++) moved = !ours(number)
    }
    if (moved)
      throw new CatalogRevisionConflictError(`${item.kind}/${item.itemId} changed: it is at revision ${state.revision}, not ${expected}. Review the diff and try again`, state)
    if (current?.hash !== latestHash(latest))
      throw new CatalogRevisionConflictError(`${item.kind}/${item.itemId} changed outside the history. Review the diff and try again`, state)
    return current
  }

  /** Os problemas da versão nas regras de hoje voltam juntos, como os da tela. */
  private async prepare(target: ICatalogDocument | undefined, current: ICatalogDocument | undefined): Promise<IPreparedWrite> {
    try {
      return await this.deps.writer.prepare(target, current)
    } catch (error: unknown) {
      throw asRestoreError(error)
    }
  }

  /** Grava pela escrita preparada, com UMA revisão por item (ver `CatalogHistoryService.within`). */
  private apply(prepared: IPreparedWrite, key: ICatalogItemKey, change: ICatalogChange): ICatalogRevision[] {
    try {
      return this.deps.history.within(key, change, () => prepared.commit(change.by)).revisions
    } catch (error: unknown) {
      throw asRestoreError(error)
    }
  }

  private keyOf(item: IRestoreItem, document: ICatalogDocument | undefined): ICatalogItemKey {
    return { kind: item.kind, id: item.itemId, ...(document?.projectId ? { projectId: document.projectId } : {}) }
  }

  /** O documento da revisão (`undefined` na de `delete`). No MCP o id do documento é o do servidor, não a chave. */
  private documentOf(revision: ICatalogRevision): ICatalogDocument | undefined {
    if (revision.document === undefined) return undefined
    const id = revision.kind === 'mcp' ? (parseMcpServerKey(revision.itemId)?.id ?? revision.itemId) : revision.itemId
    return documentFromText(revision.kind, id, revision.projectId, revision.document)
  }

  private read(item: IRestoreItem): ICatalogDocument | undefined {
    if (item.kind !== 'mcp') return this.deps.reader.read(item.kind, item.itemId)
    const parsed = parseMcpServerKey(item.itemId)
    return parsed ? this.deps.reader.read('mcp', parsed.id, parsed.projectId) : undefined
  }
}

/**
 * ⛔ A TRAVA DE AMPLIAÇÃO. Sem ampliação, `confirm` tem de vir vazio (ou não vir): confirmação que não bate com nada é
 * sinal de que a pessoa viu outra coisa. Com ampliação: token de acesso nunca; sessão de admin, só com o conjunto exato.
 */
function gate(widenings: readonly IWidening[], confirm: readonly string[] | undefined, caller: IRestoreCaller): void {
  const refs: IWideningRef[] = widenings.map((item) => ({ key: item.key, description: item.description }))
  if (!widenings.length) {
    if (confirm?.length) throw new CatalogWideningConfirmationError(refs)
    return
  }
  if (caller.viaAccessToken) throw new CatalogWideningForbiddenError(refs)
  if (!confirm || !confirmsWidenings(confirm, widenings)) throw new CatalogWideningConfirmationError(refs)
}

/**
 * ⚖️ A ORDEM DA REVERSÃO: a inversa da do lote (quem citava sai antes de quem era citado: a skill antes do doc que ela
 * anexa) e, num trecho do mesmo tipo, o que restringe antes do que amplia.
 */
function safeOrder(items: readonly IPlannedItem[]): IPlannedItem[] {
  const reversed = [...items].sort((a, b) => b.order - a.order)
  const ordered: IPlannedItem[] = []
  let run: IPlannedItem[] = []
  const flush = () => {
    ordered.push(...run.filter((item) => !item.widenings.length), ...run.filter((item) => item.widenings.length))
    run = []
  }
  for (const item of reversed) {
    if (run.length && run[0].kind !== item.kind) flush()
    run.push(item)
  }
  flush()
  return ordered
}

/** O erro do serviço que traz os problemas campo a campo vira o do rollback (422 com os problemas); o resto passa. */
function asRestoreError(error: unknown): unknown {
  if (error instanceof CatalogRestoreInvalidError) return error
  const issues = (error as { issues?: unknown } | undefined)?.issues
  return Array.isArray(issues) ? new CatalogRestoreInvalidError(issues as Array<{ field: string; message: string }>) : error
}

const refOf = (revision: { kind: TCatalogKind; itemId: string }) => `${revision.kind}/${revision.itemId}`

const latestHash = (latest: ICatalogRevision | undefined) => (latest?.document !== undefined ? latest.hash : undefined)

function summary(revision: ICatalogRevision): TRevisionSummary {
  const { document: _document, ...rest } = revision
  return rest
}
