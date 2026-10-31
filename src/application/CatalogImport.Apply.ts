import { randomUUID } from 'node:crypto'
import type { TCatalogScope } from '@application/Catalog.Reader'
import { ICatalogDocument } from '@domain/Catalog.Document'
import { ICatalogImportPlan, IImportPlanItem, IImportStep, IPackageInput, recordPart } from '@domain/Catalog.Import'
import { IWidening, wideningKeys } from '@domain/Catalog.Widening'
import { CatalogImportBlockedError, CatalogPlanChangedError, CatalogRestoreInvalidError, CatalogRevisionConflictError, IImportBlocker } from '@domain/errors/Domain.Error'
import { IBatchWidening, ICatalogBatch, ICatalogBatchRepository } from '@domain/ports/CatalogHistoryRepository.Port'
import type { CatalogReader } from './Catalog.Reader'
import type { ICatalogWriter, IPreparedWrite } from './Catalog.Writer'
import { catalogItemKey, CatalogHistoryService, ICatalogChange } from './CatalogHistory.Service'
import type { CatalogImportPlanner, IPlanOptions, IPlanWithTargets } from './CatalogImport.Plan'
import { gateWidenings, IRestoreCaller } from './CatalogRestore.Usecase'

/** O que se aplica: o pacote do export OU os documentos canônicos (o importador entra direto aqui, sem arquivos). */
export type TImportSource = { package: IPackageInput; documents?: undefined } | { documents: readonly ICatalogDocument[]; package?: undefined }

export type IImportApplyRequest = TImportSource & {
  /** O escopo do plano. Ausente: o do manifesto do pacote, senão `all`. */
  scope?: TCatalogScope
  /** O `planHash` do plano que a pessoa viu: o servidor recalcula e só aplica se for o mesmo. */
  planHash: string
  /** As chaves das ampliações aceitas: EXATAMENTE as do plano (ver `confirmsWidenings`). */
  confirm?: readonly string[]
  /** Vai no resumo do lote, sem passar pelo documento canônico (a proveniência do importador: repositório, HEAD, fontes). */
  provenance?: Record<string, unknown>
}

/** Um passo gravado: o item (ou a parte dele) e a revisão que ganhou. */
export interface IAppliedStep {
  ref: string
  op: IImportStep['op']
  phase: IImportStep['phase']
  part?: IImportStep['part']
  /** A revisão do item gravada neste passo (ausente: o passo não mudou o item — o `record` de um projeto igual). */
  revision?: number
}

export interface IImportApplyResult {
  planHash: string
  /** O lote (ausente quando o plano não grava nada: tudo `unchanged`). */
  batch?: ICatalogBatch
  applied: IAppliedStep[]
  /** Onde parou, e por quê. Os passos seguintes (`pending`) não foram tocados; o lote fica `partial`. */
  failed?: { ref: string; part?: IImportStep['part']; message: string; issues?: Array<{ field: string; message: string }> }
  pending: Array<{ ref: string; part?: IImportStep['part'] }>
  /** As ampliações aceitas (gravadas no lote e na revisão de cada item, com quem aceitou). */
  widenings: IWidening[]
  /** O MCP que entrou desligado por falta de segredo (ligar depois é outra ampliação, pela tela do MCP). */
  entersDisabled: string[]
  /** Os segredos que cada MCP gravado pede e o cofre não tem. */
  missingSecrets: Array<{ ref: string; secrets: string[] }>
  /** O lote parou no meio: reverter pela rota de sempre (`POST /v1/catalog/batches/:id/revert`). */
  revert?: { batchId: string; method: 'POST'; path: string }
}

export interface ICatalogImportApplyDeps {
  planner: Pick<CatalogImportPlanner, 'planWithTargets' | 'planPackageWithTargets'>
  repository: Pick<ICatalogBatchRepository, 'createBatch' | 'finishBatch' | 'batch'>
  history: Pick<CatalogHistoryService, 'within'>
  reader: Pick<CatalogReader, 'read'>
  writer: ICatalogWriter
  now?: () => Date
  newId?: () => string
}

/** A nota da revisão de cada parte de um item gravado em dois passos. */
const PART_NOTE: Readonly<Record<string, string>> = {
  record: 'o registro, sem o contexto inicial',
  links: 'o contexto inicial',
  'agent-record': 'o agente fechado, sem o alcance novo',
  'agent-reach': 'o alcance: ferramentas e permissões',
}

/** O que impede o apply: o item que não se aplica, e o arquivo fora do formato. */
function blockersOf(plan: ICatalogImportPlan): IImportBlocker[] {
  return [
    ...plan.items.filter((item) => item.op === 'error' || item.op === 'conflict').map((item) => ({ ref: item.ref, op: item.op, issues: item.issues })),
    ...plan.fileErrors.map((error) => ({ ref: error.path, op: 'file-error', issues: [{ field: 'file', message: error.message }] })),
  ]
}

/**
 * APLICAR O IMPORT (docs/integration/plano-catalogo-historico.md §2.6, PR 9). Refaz o plano e grava, na ORDEM dele, pelo
 * MESMO caminho de escrita das telas (`Catalog.Writer`: os serviços, com as validações de sempre), cada escrita com a
 * sua revisão (`op = import`, `source = import`) dentro de UM lote (`catalog_batches`, `kind = import`).
 *
 * ⛔ AS TRAVAS, nesta ordem (nada é gravado se uma recusa):
 * 1. o `planHash` do pedido é o do plano recalculado agora (409 com o plano novo);
 * 2. nenhum item `error`/`conflict` nem arquivo fora do formato (422 com os motivos): a pessoa corrige e replaneja;
 * 3. ampliação (`Catalog.Widening`): só com `confirm` IGUAL ao conjunto do plano, e só por admin na tela — token de
 *    acesso (o CI) recebe 403 mesmo com `confirm` (decisão do dono, 30/10).
 *
 * ⚖️ ATOMICIDADE = LOTE ORDENADO + REVERSÃO DE LOTE (decisão do dono): cada repositório tem a sua conexão. O lote nasce
 * `partial` ANTES da primeira escrita (se o processo cair, fica registrado assim) e cada revisão leva o `batchId`. A
 * ordem do plano põe o que restringe antes do que amplia: parar no meio nunca deixa o ambiente mais aberto. No primeiro
 * erro para, o lote fica `partial`, e a resposta aponta a reversão (`POST /v1/catalog/batches/:id/revert`).
 *
 * ⚖️ CONCORRÊNCIA: entre um passo e outro há espera (as regras do momento); antes de cada escrita o item tem de estar
 * como o plano o viu (ou como o próprio lote o deixou). Mudou por fora: para ali, como qualquer falha.
 */
export class CatalogImportApplier {
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(private readonly deps: ICatalogImportApplyDeps) {
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => randomUUID())
  }

  /** O plano do que se aplicaria (o mesmo do `POST /catalog/import/plan`), com os documentos a gravar. */
  async plan(source: TImportSource & { scope?: TCatalogScope }, options: IPlanOptions = {}): Promise<IPlanWithTargets> {
    if (source.package) return this.deps.planner.planPackageWithTargets(source.package, { ...options, ...(source.scope ? { scope: source.scope } : {}) })
    return this.deps.planner.planWithTargets(source.documents, source.scope ?? { kind: 'all' }, options)
  }

  async apply(request: IImportApplyRequest, caller: IRestoreCaller): Promise<IImportApplyResult> {
    const { plan, targets } = await this.plan(request, { viaAccessToken: caller.viaAccessToken })
    if (plan.planHash !== request.planHash) throw new CatalogPlanChangedError(plan)
    const blockers = blockersOf(plan)
    if (blockers.length) throw new CatalogImportBlockedError(blockers)
    gateWidenings(plan.widenings, request.confirm, caller)

    const result: IImportApplyResult = {
      planHash: plan.planHash,
      applied: [],
      pending: [],
      widenings: plan.widenings,
      entersDisabled: plan.items.filter((item) => item.entersDisabled).map((item) => item.ref),
      missingSecrets: [],
    }
    if (!plan.order.length) return result

    const items = new Map(plan.items.map((item) => [item.ref, item]))
    const batch = this.deps.repository.createBatch({
      id: this.newId(),
      at: this.now(),
      by: caller.by,
      kind: 'import',
      scope: plan.scope,
      summary: { planHash: plan.planHash, started: true },
      widenings: plan.items.flatMap((item) =>
        item.widenings.map((widening): IBatchWidening => ({
          kind: item.kind,
          itemId: catalogItemKey(targets.get(item.ref)!).id,
          key: widening.key,
          description: widening.description,
        })),
      ),
      status: 'partial',
    })

    /** O hash em que cada item tem de estar antes da escrita: o que o plano viu, depois o que o lote gravou. */
    const expected = new Map<string, string | undefined>(plan.items.map((item) => [item.ref, item.currentHash]))
    let failedAt = -1
    for (const [index, step] of plan.order.entries()) {
      const item = items.get(step.ref)!
      try {
        const applied = await this.step(step, item, targets.get(step.ref)!, expected, { by: caller.by, batchId: batch.id })
        result.applied.push(applied.step)
        if (applied.missingSecrets.length) result.missingSecrets.push({ ref: step.ref, secrets: applied.missingSecrets })
      } catch (error: unknown) {
        result.failed = {
          ref: step.ref,
          ...(step.part ? { part: step.part } : {}),
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof CatalogRestoreInvalidError ? { issues: error.issues } : issuesOf(error)),
        }
        failedAt = index
        break
      }
    }
    if (failedAt >= 0) result.pending = plan.order.slice(failedAt + 1).map((step) => ({ ref: step.ref, ...(step.part ? { part: step.part } : {}) }))

    this.deps.repository.finishBatch(batch.id, {
      status: result.failed ? 'partial' : 'applied',
      summary: {
        planHash: plan.planHash,
        counts: plan.summary,
        applied: result.applied.map((step) => (step.part ? `${step.ref}#${step.part}` : step.ref)),
        unchanged: plan.items.filter((item) => item.op === 'unchanged').map((item) => item.ref),
        ...(result.failed ? { failed: { ref: result.failed.ref, ...(result.failed.part ? { part: result.failed.part } : {}), message: result.failed.message } } : {}),
        ...(result.pending.length ? { pending: result.pending.map((step) => (step.part ? `${step.ref}#${step.part}` : step.ref)) } : {}),
        ...(result.entersDisabled.length ? { entersDisabled: result.entersDisabled } : {}),
        ...(result.missingSecrets.length ? { missingSecrets: result.missingSecrets } : {}),
        ...(request.provenance ? { provenance: request.provenance } : {}),
      },
    })
    result.batch = this.deps.repository.batch(batch.id)
    if (result.failed) result.revert = { batchId: batch.id, method: 'POST', path: `/v1/catalog/batches/${encodeURIComponent(batch.id)}/revert` }
    return result
  }

  /** Um passo: o item inteiro, ou uma parte do projeto (`record` sem o contexto inicial novo; `links`, o contexto). */
  private async step(
    step: IImportStep,
    item: IImportPlanItem,
    full: ICatalogDocument,
    expected: Map<string, string | undefined>,
    who: { by: string; batchId: string },
  ): Promise<{ step: IAppliedStep; missingSecrets: string[] }> {
    const current = this.fresh(step, expected)
    const target = step.part === 'record' ? recordPart(full, current) : full
    const prepared: IPreparedWrite = await this.deps.writer.prepare(target, current)
    // A preparação esperou (as regras do momento): confere de novo, já sem nada assíncrono até gravar.
    this.fresh(step, expected)
    const last = step.part !== 'record'
    const change: ICatalogChange = {
      by: who.by,
      source: 'import',
      op: 'import',
      batchId: who.batchId,
      note: `import do lote ${who.batchId}${step.part ? ` (${PART_NOTE[step.kind === 'agent' ? `agent-${step.part}` : step.part] ?? step.part})` : ''}`,
      // A aceitação vai na revisão que completa o item.
      ...(last && item.widenings.length ? { widenings: wideningKeys(item.widenings) } : {}),
    }
    const { revisions } = this.deps.history.within(catalogItemKey(target), change, () => prepared.commit(who.by))
    for (const revision of revisions) expected.set(`${revision.kind}/${revision.itemId}`, revision.hash)
    await prepared.after?.()
    const own = revisions.find((revision) => `${revision.kind}/${revision.itemId}` === step.ref)
    return {
      step: { ref: step.ref, op: step.op, phase: step.phase, ...(step.part ? { part: step.part } : {}), ...(own ? { revision: own.revision } : {}) },
      missingSecrets: prepared.missingSecrets?.() ?? [],
    }
  }

  /** ⛔ O item está como o plano viu (ou como o próprio lote o deixou)? Senão alguém mexeu no meio: para aqui. */
  private fresh(step: IImportStep, expected: ReadonlyMap<string, string | undefined>): ICatalogDocument | undefined {
    const current = this.deps.reader.read(step.kind, step.id, step.projectId)
    const want = expected.get(step.ref)
    if (current?.hash !== want)
      throw new CatalogRevisionConflictError(`${step.ref} changed while the import was running: plan it again`, { exists: !!current, ...(current ? { hash: current.hash } : {}) })
    return current
  }
}

/** O erro do serviço que traz os problemas campo a campo. */
function issuesOf(error: unknown): { issues?: Array<{ field: string; message: string }> } {
  const issues = (error as { issues?: unknown } | undefined)?.issues
  return Array.isArray(issues) ? { issues: issues as Array<{ field: string; message: string }> } : {}
}
