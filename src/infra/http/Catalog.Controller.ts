import { Request, Response } from 'express'
import { z } from 'zod'
import type { TCatalogScope } from '@application/Catalog.Reader'
import { CatalogExportUseCase } from '@application/CatalogExport.Usecase'
import type { CatalogImportApplier, TImportSource } from '@application/CatalogImport.Apply'
import { CatalogImportPlanner, IPackageInput, scopeOfManifest } from '@application/CatalogImport.Plan'
import { CatalogRestoreUseCase, IRestoreCaller } from '@application/CatalogRestore.Usecase'
import { CatalogHistoryQuery, IHistoryItem, IHistoryPaging, THistoryScope, TRevisionRef } from '@application/CatalogHistory.Query'
import type { IProjectCaller } from '@application/Projects.Service'
import { CATALOG_KINDS, catalogHash, ICatalogDocument, parseProtocolItemId, protocolItemId, stableJson, TCanonicalBody, TCatalogKind } from '@domain/Catalog.Document'
import { MANIFEST_PATH } from '@domain/Catalog.Files'
import { mcpServerKey, parseMcpServerKey } from '@domain/models/McpServer.Model'
import { PROJECT_ID_PATTERN } from '@domain/models/Project.Model'
import type { ICatalogBatch, ICatalogBatchRepository, TBatchKind, TRevisionSummary } from '@domain/ports/CatalogHistoryRepository.Port'
import { TProtocolKind } from '@domain/models/Protocol.Model'
import { tarGz, untarGz } from '@infra/catalog/Tar.Archive'
import { viaAccessToken } from './Auth.Controller'
import { resolveCaller } from './Caller.Access'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { administers, administersEverything, adminView, IAdminView, requireAnyAdmin, requireProjectAdmin, requireProjectsAdmin, requireScopeReader } from './Project.Access'
import { parseBody } from './Request.Parser'
import { CATALOG_IMPORT_UNPACK_FACTOR, catalogImportLimit, limitBytes } from './Security.Middleware'

export interface ICatalogControllerDeps {
  history: CatalogHistoryQuery
  proof?: ICallerProof
  /** Quem é membro de quê (a regra única dos projetos). Ausente = sem projetos: só o admin lê o histórico. ⛔ `canUse` é só membro. */
  projects?: { canUse(caller: IProjectCaller, projectId: string): boolean }
  /** O rollback (restaurar, reverter lote). Ausente = sem escrita: as rotas respondem 404. */
  restore?: CatalogRestoreUseCase
  /** O export do pacote. Ausente = a rota responde 404. */
  exporter?: CatalogExportUseCase
  /** O plano de import (dry-run). Ausente = a rota responde 404. */
  importPlanner?: Pick<CatalogImportPlanner, 'planPackage' | 'planDocuments'>
  /** Aplicar o import. Ausente = a rota responde 404. */
  importApplier?: Pick<CatalogImportApplier, 'apply'>
  /** A leitura dos lotes (import, reversão). Ausente = as rotas respondem 404. */
  batches?: Pick<ICatalogBatchRepository, 'batches' | 'batch' | 'batchRevisions'>
}

/** A pasta raiz dentro do `.tar.gz`: `tar -xzf` cria `catalog/` com o pacote. */
export const EXPORT_ROOT = 'catalog'

export const HISTORY_PAGE_SIZE_DEFAULT = 20
export const HISTORY_PAGE_SIZE_MAX = 100
const CONTEXT_MAX = 50
const ID_MAX = 200
/** Teto das listas do pedido (`confirm`, `overwrite`): um lote grande ainda cabe; um corpo absurdo, não. */
const KEYS_MAX = 5000

const keyList = z.array(z.string().min(1).max(2000)).max(KEYS_MAX)

const restoreSchema = z.object({
  kind: z.string(),
  id: z.string(),
  project: z.string().optional(),
  revision: z.number().int().min(1),
  expectedRevision: z.number().int().min(0),
  confirm: keyList.optional(),
})

const revertSchema = z.object({ confirm: keyList.optional(), overwrite: keyList.optional() })

/** O pacote em JSON: o mesmo do `GET /catalog/export?format=json` (`catalog.json` dentro de `files` ou à parte). */
const packageSchema = z.object({ manifest: z.unknown().optional(), files: z.record(z.string(), z.string()) })

/** Um documento canônico de fora (o importador, ou quem monta os documentos sem arquivos): a chave e o corpo. */
const documentSchema = z.object({
  kind: z.string().min(1).max(40),
  id: z.string().min(1).max(ID_MAX),
  projectId: z.string().max(ID_MAX).optional(),
  body: z.record(z.string(), z.unknown()),
})
const documentsSchema = z.array(documentSchema).max(KEYS_MAX)

/** O plano em JSON: o pacote do export (como antes) OU os documentos canônicos. */
const planSchema = z.union([packageSchema, z.object({ documents: documentsSchema })])

/** Aplicar: o pacote OU os documentos, o escopo, o `planHash` do plano visto e as ampliações aceitas. */
const applySchema = z.object({
  package: packageSchema.optional(),
  documents: documentsSchema.optional(),
  scope: z.string().max(ID_MAX).optional(),
  planHash: z.string().regex(/^[a-f0-9]{64}$/, 'expected the planHash of the plan (64 hex)'),
  confirm: keyList.optional(),
})

/**
 * ⛔ O que o MEMBRO de um projeto lê do histórico: só o que ele já vê hoje do projeto dele, por inteiro. É só o MCP do
 * projeto (`GET /mcp-servers?project=`). O resto não: o agente sai para ele sem o prompt (`GET /agents/:id` é de admin),
 * e rules, docs, skills, commands, complementos, permissões e o contexto inicial do projeto são todos de admin.
 */
const MEMBER_KINDS: readonly TCatalogKind[] = ['mcp']

/** Quem lê o histórico: o que administra (se administra algo) e a conta (que pode ser membro de um projeto). */
interface IViewer {
  view?: IAdminView
  userId?: string
}

/** Quem administra o gateway e todos os projetos (ou, sem os papéis registrados, o admin do gateway de antes): vale tudo. */
const unrestricted = (view: IAdminView): boolean => administersEverything(view)

/** O admin lê o escopo: o projeto, o admin dele; o global, qualquer admin. */
const reads = (view: IAdminView, projectId: string | null | undefined): boolean => !projectId || administers(view, projectId)

/** O projeto de um item pelo id, quando o id o carrega (o MCP e o complemento); o resto não traz. */
function projectOfId(item: IHistoryItem): string | null {
  if (item.kind === 'mcp') return parseMcpServerKey(item.itemId)?.projectId ?? null
  if (item.kind === 'protocol') return parseProtocolItemId(item.itemId)?.projectId ?? null
  return null
}

/** O escopo do pacote: o do manifesto (`catalog.json`, dentro de `files` ou à parte). */
function packageScope(input: IPackageInput): TCatalogScope | undefined {
  let raw: unknown = (input.manifest as { scope?: unknown } | undefined)?.scope
  if (raw === undefined) {
    try {
      raw = (JSON.parse(input.files[MANIFEST_PATH] ?? 'null') as { scope?: unknown } | null)?.scope
    } catch {
      raw = undefined
    }
  }
  return typeof raw === 'string' ? scopeOfManifest(raw) : undefined
}

/**
 * O HISTÓRICO DO CATÁLOGO: as revisões de um item ou de um escopo, uma revisão inteira, o diff de linhas e o rollback
 * (ver docs/integration/plano-catalogo-historico.md §3, PRs 3 e 5).
 *
 * ⚖️ O ITEM VAI NA QUERY (`kind` + `id`), não no caminho: o id do complemento de protocolo tem barra (`<projeto>/<tipo>`).
 * `project` completa a chave quando precisa: no MCP, `id=n8n&project=cliente-a` é `cliente-a.n8n` (que também vale
 * direto em `id`); no complemento, `id=skill&project=cliente-a` é `cliente-a/skill`. Os outros tipos têm id único.
 *
 * ⛔ O admin lê o escopo que administra (ver `Project.Access`): o projeto dele e o global; o admin do gateway não lê o
 * projeto de que não é admin. O membro, só o MCP dos projetos dele (`MEMBER_KINDS`). Os demais recebem 404, como nas
 * outras rotas de admin: a resposta não confirma que o item existe. ⚖️ Escrever (restaurar, reverter, importar) é do admin
 * do escopo do item; o global, do gateway. O escopo `all` (export, import) só vale para quem administra TUDO.
 */
export class CatalogController {
  constructor(private readonly deps: ICatalogControllerDeps) {
    for (const name of ['history', 'revision', 'diff', 'restore', 'revertBatch', 'exportCatalog', 'importPlan', 'importApply', 'batchList', 'batchDetail'] as const)
      this[name] = this[name].bind(this)
  }

  /**
   * O EXPORT do catálogo (§2.5): `scope=all|global|project` (`project=<id>` com `project`; `scope=project:<id>` também
   * vale; sem escopo, `all`). `format=tar` (o padrão) devolve um `.tar.gz` com a pasta `catalog/`; `format=json`, o pacote
   * `{ manifest, files }` no envelope de sempre (é o que a CLI e a tela usam). ⛔ Só o admin do escopo (o global, qualquer admin
   * lê; `all`, só quem administra tudo); os outros, 404. Ler não
   * amplia nada: o token de acesso (o CI) também exporta.
   */
  async exportCatalog(req: Request, res: Response): Promise<void> {
    try {
      await requireAnyAdmin(this.deps.proof, 'catalogExport')
      const query = req.query as Record<string, unknown>
      const scope = exportScopeOf(query)
      const by = await this.requireScope('catalogExport', scope, false)
      if (!this.deps.exporter) throw this.deny('catalogExport', 'export is not wired')
      const format = query.format === undefined ? 'tar' : query.format
      if (format !== 'tar' && format !== 'json') throw invalid('Invalid format: expected tar or json')
      const pack = this.deps.exporter.run(scope, by)
      if (format === 'json') {
        res.status(200).json(ok(pack))
        return
      }
      const label = scope.kind === 'project' ? `project-${scope.projectId}` : scope.kind
      const stamp = pack.manifest.exportedAt.replace(/[:.]/g, '-')
      const archive = tarGz(
        Object.entries(pack.files).map(([path, content]) => ({ path: `${EXPORT_ROOT}/${path}`, content })),
        new Date(pack.manifest.exportedAt),
      )
      res
        .status(200)
        .set({
          'Content-Type': 'application/gzip',
          'Content-Disposition': `attachment; filename="catalog-${label}-${stamp}.tar.gz"`,
          'X-Catalog-Masked': String(pack.manifest.masked.length),
        })
        .send(archive)
    } catch (error: unknown) {
      const failure = toHttpFailure(error)
      if (failure.status >= 500) console.error('[CatalogController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }

  /**
   * O PLANO DE IMPORT (dry-run, §2.6): o pacote no corpo — o `.tar.gz` do export (`Content-Type: application/gzip`) ou
   * `{ manifest, files }` em JSON — e devolve, sem gravar nada, as operações, os diffs, as ampliações, as atenções, as
   * referências quebradas, os segredos que faltam, a ordem e o `planHash`. O escopo vem da query (`scope`/`project`, como
   * no export) ou do manifesto; sem nenhum, `all`. ⛔ Só o admin do escopo (o global, o do gateway; `all`, só quem administra
   * tudo, ou com documentos todos de escopos dele); os outros, 404. O token de acesso (CI) também planeja,
   * mas o plano marca que a ampliação não se aplica por token (`caller.wideningsApplicable: false`).
   */
  async importPlan(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await requireAnyAdmin(this.deps.proof, 'catalogImportPlan')
      const query = req.query as Record<string, unknown>
      const scope = query.scope !== undefined || query.project !== undefined ? exportScopeOf(query) : undefined
      const options = { viaAccessToken: viaAccessToken(res) }
      if (!Buffer.isBuffer(req.body) && req.body && typeof req.body === 'object' && 'documents' in req.body) {
        const body = parseBody(planSchema, req.body) as { documents: z.infer<typeof documentsSchema> }
        const documents = documentsOf(body.documents)
        await this.requireScope('catalogImportPlan', scope ?? { kind: 'all' }, true, documents)
        return this.importPlanner('catalogImportPlan').planDocuments(documents, scope ?? { kind: 'all' }, options)
      }
      const input = packageOf(req.body)
      const effective = scope ?? packageScope(input)
      await this.requireScope('catalogImportPlan', effective ?? { kind: 'all' }, true)
      return this.importPlanner('catalogImportPlan').planPackage(input, { ...(effective ? { scope: effective } : {}), ...options })
    })
  }

  /**
   * APLICAR O IMPORT (§2.6, PR 9): `{ package | documents, scope?, planHash, confirm? }`. O servidor refaz o plano:
   * `planHash` diferente = 409 com o plano novo; item `error`/`conflict` = 422 (nada é gravado); ampliação só com
   * `confirm` igual ao conjunto do plano (409 com a lista) e só por admin na tela (403 para token de acesso). Grava na
   * ordem do plano, num lote (`kind: import`); parou no meio = lote `partial`, com `failed`, `pending` e `revert`.
   * ⛔ Só o admin do escopo (como o plano); os outros, 404.
   */
  async importApply(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await requireAnyAdmin(this.deps.proof, 'catalogImportApply')
      if (Buffer.isBuffer(req.body)) throw invalid('Apply takes JSON: { package | documents, scope?, planHash, confirm? }')
      const body = parseBody(applySchema, req.body ?? {})
      if (!body.package === !body.documents) throw invalid('Send either package or documents')
      const query = req.query as Record<string, unknown>
      const scope = body.scope !== undefined ? applyScopeOf(body.scope) : query.scope !== undefined || query.project !== undefined ? exportScopeOf(query) : undefined
      const source: TImportSource = body.package ? { package: body.package } : { documents: documentsOf(body.documents!) }
      const effective = scope ?? (body.package ? packageScope(body.package) : undefined)
      const by = await this.requireScope('catalogImportApply', effective ?? { kind: 'all' }, true, 'documents' in source ? source.documents : undefined)
      if (!this.deps.importApplier) throw this.deny('catalogImportApply', 'import apply is not wired')
      return this.deps.importApplier.apply(
        { ...source, ...(effective ? { scope: effective } : {}), planHash: body.planHash, ...(body.confirm ? { confirm: body.confirm } : {}) },
        { by, viaAccessToken: viaAccessToken(res), administers: await this.administered() },
      )
    })
  }

  /**
   * OS LOTES (import e reversão), do mais novo para o mais velho: estado, resumo, ampliações aceitas e quantos itens.
   * `project=<id>`: os do projeto (o escopo dele, ou que gravaram nele); `project=global`; ausente: todos. `kind`:
   * `import` ou `revert`. ⛔ Só admin; os outros, 404.
   */
  async batchList(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { batches, view } = await this.batchReader('catalogBatches')
      const query = req.query as Record<string, unknown>
      const paging = pagingOf(query)
      const project = text(query.project, 'project')
      const kind = text(query.kind, 'kind')
      if (kind !== undefined && kind !== 'import' && kind !== 'revert') throw invalid('Invalid kind: expected import or revert')
      const kindFilter = kind ? { kind: kind as TBatchKind } : {}
      const page = (filter: { projectId?: string }, window: { offset: number; limit: number }) => batches.batches({ ...filter, ...kindFilter }, window)
      if (project !== undefined) {
        if (!reads(view, project === 'global' ? null : project)) throw this.deny('catalogBatches', 'project outside the administered scopes')
        const found = page({ projectId: project === 'global' ? '' : project }, { offset: (paging.page - 1) * paging.pageSize, limit: paging.pageSize })
        return { ...found, batches: found.batches.map((batch) => this.shaped(view, batch)), ...paging }
      }
      if (unrestricted(view)) return { ...page({}, { offset: (paging.page - 1) * paging.pageSize, limit: paging.pageSize }), ...paging }
      // ⛔ Sem projeto: só os lotes do global e dos projetos que administra, juntos, do mais novo para o mais velho.
      const take = paging.page * paging.pageSize
      const parts = ['', ...(view.projects as ReadonlySet<string>)].map((projectId) => page({ projectId }, { offset: 0, limit: take }))
      const seen = new Set<string>()
      const merged = parts
        .flatMap((part) => part.batches)
        .filter((batch) => !seen.has(batch.id) && !!seen.add(batch.id))
        .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1))
      const from = (paging.page - 1) * paging.pageSize
      return { batches: merged.slice(from, from + paging.pageSize).map((batch) => this.shaped(view, batch)), total: merged.length, ...paging }
    })
  }

  /** UM LOTE: o registro inteiro e as revisões dele (sem o documento), na ordem em que foram gravadas. ⛔ Só as do escopo do admin. */
  async batchDetail(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { batches, view } = await this.batchReader('catalogBatch')
      const batchId = text(req.params.batchId, 'batchId')!
      const batch = batches.batch(batchId)
      if (!batch) throw notFound(`Batch not found: ${batchId}`)
      const all = batches.batchRevisions(batchId)
      const revisions = all.filter((revision) => unrestricted(view) || reads(view, revision.projectId)).map(({ document: _document, ...summary }) => summary)
      // Lote sem nada do escopo dele (ou vazio, de um escopo que ele não lê) não existe para ele.
      if (!unrestricted(view) && !revisions.length && !reads(view, this.scopeOfBatch(batch))) throw notFound(`Batch not found: ${batchId}`)
      return { batch: this.shaped(view, batch), revisions }
    })
  }

  /** O escopo do lote: `null` = o global; `undefined` = `all` (não é de um escopo só). */
  private scopeOfBatch(batch: ICatalogBatch): string | null | undefined {
    if (batch.scope === 'all') return undefined
    return batch.scope.startsWith('project:') ? batch.scope.slice('project:'.length) : null
  }

  /** ⛔ O resumo e as ampliações de um lote de vários escopos (`all`) ou de um escopo fora do alcance não saem: levam itens de outros. */
  private shaped<T extends ICatalogBatch>(view: IAdminView, batch: T): T {
    const scope = this.scopeOfBatch(batch)
    if (unrestricted(view) || (scope !== undefined && reads(view, scope))) return batch
    return { ...batch, summary: {}, widenings: [] }
  }

  private async batchReader(operation: string): Promise<{ batches: NonNullable<ICatalogControllerDeps['batches']>; view: IAdminView }> {
    const view = await requireAnyAdmin(this.deps.proof, operation)
    if (!this.deps.batches) throw this.deny(operation, 'batches are not wired')
    return { batches: this.deps.batches, view }
  }

  /**
   * RESTAURA uma revisão do item: grava uma revisão NOVA com o conteúdo dela (`op = restore`), nunca apaga revisão.
   * `expectedRevision` é a última que a pessoa viu (409 se alguém mexeu); a ampliação de permissão pede `confirm`
   * (409 com a lista certa) e só por admin na tela (403 para token de acesso). ⛔ Só o admin do escopo do item; os outros, 404.
   */
  async restore(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const body = parseBody(restoreSchema, req.body)
      const item = requiredItem({ kind: body.kind, id: body.id, ...(body.project !== undefined ? { project: body.project } : {}) })
      // ⛔ Restaurar grava no escopo do item e, se a revisão é de outro escopo (a rule mudou de lugar), nos dois.
      const target = this.deps.history.revision(item, body.revision)
      const { restore, caller } = await this.writer('catalogRestore', res, [this.scopeOfItem(item), target ? (target.projectId ?? null) : this.scopeOfItem(item)])
      return restore.restore({ item, revision: body.revision, expectedRevision: body.expectedRevision, ...(body.confirm ? { confirm: body.confirm } : {}) }, caller)
    })
  }

  /**
   * REVERTE UM LOTE: cada item volta ao estado de antes do lote, em ordem inversa e segura, como um lote novo. Item que
   * mudou depois do lote é pulado (`conflicts`) a não ser que venha em `overwrite`. Mesma trava de ampliação, sobre o
   * conjunto. ⛔ Só o admin dos escopos do lote; os outros, 404.
   */
  async revertBatch(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const body = parseBody(revertSchema, req.body ?? {})
      const batchId = text(req.params.batchId, 'batchId')!
      // ⛔ Reverter grava em cada item do lote: o admin de todos os escopos que o lote tocou.
      const touched = this.deps.batches?.batchRevisions(batchId).map((revision) => revision.projectId ?? null) ?? []
      const { restore, caller } = await this.writer('catalogRevertBatch', res, touched)
      return restore.revert({ batchId, ...(body.confirm ? { confirm: body.confirm } : {}), ...(body.overwrite ? { overwrite: body.overwrite } : {}) }, caller)
    })
  }

  /**
   * ⛔ Escrita: só o admin de TODOS os escopos tocados (o global, o do gateway). Quem aceita a ampliação é ele — e só pela
   * tela (`viaAccessToken` recusa). Lote vazio (ou que não existe): vale o global, e o caso de uso responde o 404.
   */
  private async writer(operation: string, res: Response, scopes: ReadonlyArray<string | null>): Promise<{ restore: CatalogRestoreUseCase; caller: IRestoreCaller }> {
    const by = await requireProjectsAdmin(this.deps.proof, scopes.length ? scopes : [null], operation)
    if (!this.deps.restore) throw this.deny(operation, 'restore is not wired')
    return { restore: this.deps.restore, caller: { by, viaAccessToken: viaAccessToken(res), administers: await this.administered() } }
  }

  /** ⛔ Os projetos que quem pede administra: a trava de `sharedWith` (ver `gateShares`) só deixa acrescentar esses. */
  private async administered(): Promise<(projectId: string) => boolean> {
    const view = await adminView(this.deps.proof)
    return (projectId) => !!view && administers(view, projectId)
  }

  /** Com `kind` e `id`: as revisões do item. Sem eles: as do escopo (`project=<id>`, `project=global`, ou tudo). */
  async history(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const query = req.query as Record<string, unknown>
      const viewer = await this.viewer('catalogHistory')
      const paging = pagingOf(query)
      const item = itemOf(query)
      if (item) {
        const restrict = this.restrict(viewer, item)
        if (!this.deps.history.known(item)) throw notFound('Catalog item not found')
        return { ...item, current: this.deps.history.currentState(item), ...this.deps.history.itemRevisions(item, paging, restrict) }
      }
      const scope = scopeOf(query)
      const view = viewer.view
      if (view && scope.kind === 'all') {
        if (unrestricted(view)) return { scope: scopeLabel(scope), ...this.deps.history.scopeRevisions(scope, paging) }
        // ⛔ Tudo, para quem não administra tudo: o global e os projetos que administra, juntos.
        return { scope: scopeLabel(scope), ...this.mergedScopes(view, paging) }
      }
      if (view && scope.kind !== 'all' && (scope.kind === 'global' || administers(view, scope.projectId)))
        return { scope: scopeLabel(scope), ...this.deps.history.scopeRevisions(scope, paging) }
      if (scope.kind !== 'project' || !this.canUse(viewer, scope.projectId)) throw this.deny('catalogHistory', 'not an administrator or a member of the scope')
      return { scope: scopeLabel(scope), ...this.deps.history.scopeRevisions(scope, paging, MEMBER_KINDS) }
    })
  }

  /** As revisões do global e de cada projeto administrado, intercaladas da mais nova para a mais velha. */
  private mergedScopes(view: IAdminView, paging: IHistoryPaging) {
    const scopes: THistoryScope[] = [{ kind: 'global' }, ...[...(view.projects as ReadonlySet<string>)].map((projectId): THistoryScope => ({ kind: 'project', projectId }))]
    const parts = scopes.map((scope) => this.deps.history.scopeRevisions(scope, { page: 1, pageSize: paging.page * paging.pageSize }))
    const newest = (a: TRevisionSummary, b: TRevisionSummary) => b.at.getTime() - a.at.getTime() || b.id - a.id
    const from = (paging.page - 1) * paging.pageSize
    return {
      revisions: parts
        .flatMap((part) => part.revisions)
        .sort(newest)
        .slice(from, from + paging.pageSize),
      total: parts.reduce((sum, part) => sum + part.total, 0),
      ...paging,
    }
  }

  /** Uma revisão inteira, com o documento canônico (`document`, ausente na revisão de `delete`). */
  async revision(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const viewer = await this.viewer('catalogRevision')
      const item = requiredItem(req.query as Record<string, unknown>)
      const restrict = this.restrict(viewer, item)
      const number = positiveInt(req.params.revision, 'revision')
      const revision = this.deps.history.revision(item, number)
      if (!revision || (restrict.projectId !== undefined && (revision.projectId ?? '') !== restrict.projectId)) throw notFound(`Revision not found: ${number}`)
      return revision
    })
  }

  /** O diff de linhas entre duas revisões, ou entre uma e o atual (`to=current`, o padrão). Hunks com contexto e o texto unificado. */
  async diff(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const query = req.query as Record<string, unknown>
      const viewer = await this.viewer('catalogDiff')
      const item = requiredItem(query)
      // ⚖️ A chave do MCP leva o projeto, e toda revisão dela é daquele projeto: a checagem da chave basta para o membro.
      const restrict = this.restrict(viewer, item)
      if (!this.deps.history.known(item)) throw notFound('Catalog item not found')
      const from = refOf(query.from, 'from')
      const to = refOf(query.to, 'to')
      // ⛔ Cada revisão pedida tem de ser do escopo que o leitor enxerga (a rule pode ter mudado de projeto).
      if (restrict.projectId !== undefined)
        for (const ref of [from, to])
          if (typeof ref === 'number' && ref > 0 && (this.deps.history.revision(item, ref)?.projectId ?? '') !== restrict.projectId) throw notFound('Revision not found')
      const context = query.context === undefined ? undefined : boundedInt(query.context, 'context', 0, CONTEXT_MAX)
      const diff = this.deps.history.diff(item, { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), ...(context !== undefined ? { context } : {}) })
      if (!diff) throw notFound('Revision not found')
      return diff
    })
  }

  /** Admin (de algo) ou um chamador identificado (que pode ser membro de projeto); o resto, 404. */
  private async viewer(operation: string): Promise<IViewer> {
    const view = await adminView(this.deps.proof)
    if (view) return { view, ...(view.userId ? { userId: view.userId } : {}) }
    const resolved = this.deps.projects ? await resolveCaller(this.deps.proof) : undefined
    const userId = resolved?.identity?.id
    if (!userId) throw this.deny(operation, 'not an administrator')
    return { userId }
  }

  /** O escopo do item: o da última revisão dele; sem revisão, o que o id diz (o MCP e o complemento); o resto, o global. */
  private scopeOfItem(item: IHistoryItem): string | null {
    const latest = this.deps.history.itemRevisions(item, { page: 1, pageSize: 1 }).revisions[0]
    return latest ? (latest.projectId ?? null) : projectOfId(item)
  }

  /**
   * O que o leitor pode ver do item. Admin do escopo do item: as revisões desse escopo (`projectId: ''` = o global; a
   * rule que mudou de projeto não mostra o passado dela a quem não administra aquele projeto). Senão, o membro: só o MCP
   * de um projeto dele (e só as revisões daquele projeto). Sem nenhum dos dois, 404.
   */
  private restrict(viewer: IViewer, item: IHistoryItem): { projectId?: string } {
    const scope = this.scopeOfItem(item)
    if (viewer.view && reads(viewer.view, scope)) return unrestricted(viewer.view) ? {} : { projectId: scope ?? '' }
    const projectId = MEMBER_KINDS.includes(item.kind) ? parseMcpServerKey(item.itemId)?.projectId : undefined
    if (!projectId || !this.canUse(viewer, projectId)) throw this.deny('catalogHistory', 'item outside the caller scopes')
    return { projectId }
  }

  /** ⛔ `canUse` é só membro: o admin que não é membro do projeto não passa por aqui (ele passa por `view`). */
  private canUse(viewer: IViewer, projectId: string): boolean {
    return !!viewer.userId && !!this.deps.projects?.canUse({ userId: viewer.userId, admin: false }, projectId)
  }

  /**
   * O escopo de uma ação sobre pacote ou plano. Projeto: o admin dele; global: ler, qualquer admin, gravar, o do gateway;
   * `all`: só quem administra tudo — ou, com documentos, o admin de cada escopo que eles tocam. Devolve quem age (`by`).
   */
  private async requireScope(operation: string, scope: TCatalogScope, write: boolean, documents?: ReadonlyArray<Pick<ICatalogDocument, 'projectId'>>): Promise<string> {
    if (scope.kind === 'project') return requireProjectAdmin(this.deps.proof, scope.projectId, operation)
    if (scope.kind === 'global') return write ? requireProjectAdmin(this.deps.proof, null, operation) : requireScopeReader(this.deps.proof, null, operation)
    const view = await requireAnyAdmin(this.deps.proof, operation)
    if (unrestricted(view)) return view.by
    if (!documents) throw this.deny(operation, 'scope all needs an administrator of everything')
    return requireProjectsAdmin(this.deps.proof, [...new Set(documents.map((document) => document.projectId ?? null))], operation)
  }

  private importPlanner(operation: string): NonNullable<ICatalogControllerDeps['importPlanner']> {
    if (!this.deps.importPlanner) throw this.deny(operation, 'import plan is not wired')
    return this.deps.importPlanner
  }

  private deny(operation: string, reason: string | undefined): HttpError {
    console.warn(`[admin] acesso negado a ${operation}:`, reason)
    return notFound('Not found')
  }

  private async respond<T>(res: Response, work: () => Promise<T>) {
    try {
      res.status(200).json(ok(await work()))
    } catch (error: unknown) {
      const failure = toHttpFailure(error)
      if (failure.status >= 500) console.error('[CatalogController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}

const notFound = (message: string) => new HttpError(404, 'not_found', message)
const invalid = (message: string) => new HttpError(422, 'validation_error', message)

function text(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > ID_MAX) throw invalid(`Invalid ${name}`)
  return value.trim()
}

/** O item da query; `undefined` sem `kind` nem `id` (a lista do escopo). Só um dos dois é erro. */
function itemOf(query: Record<string, unknown>): IHistoryItem | undefined {
  const kind = text(query.kind, 'kind')
  const id = text(query.id, 'id')
  if (kind === undefined && id === undefined) return undefined
  if (kind === undefined || id === undefined) throw invalid('kind and id go together')
  if (!(CATALOG_KINDS as readonly string[]).includes(kind)) throw invalid(`Unknown kind: ${kind}. Expected one of: ${CATALOG_KINDS.join(', ')}`)
  const project = text(query.project, 'project')
  if (kind === 'mcp') {
    const key = project ? mcpServerKey({ id, projectId: project }) : id
    if (!parseMcpServerKey(key)) throw invalid(`Invalid MCP server key: ${key}`)
    return { kind, itemId: key }
  }
  if (kind === 'protocol' && project && !id.includes('/')) return { kind, itemId: protocolItemId(id as TProtocolKind, project) }
  return { kind: kind as TCatalogKind, itemId: id }
}

function requiredItem(query: Record<string, unknown>): IHistoryItem {
  const item = itemOf(query)
  if (!item) throw invalid('kind and id are required')
  return item
}

/** `project=<id>`: o projeto; `project=global`: só o global; ausente: tudo (só admin). */
function scopeOf(query: Record<string, unknown>): THistoryScope {
  const project = text(query.project, 'project')
  if (!project) return { kind: 'all' }
  return project === 'global' ? { kind: 'global' } : { kind: 'project', projectId: project }
}

/** O escopo do export: `scope=all|global|project` com `project=<id>`, ou `scope=project:<id>`. Padrão: tudo. */
function exportScopeOf(query: Record<string, unknown>): TCatalogScope {
  const raw = text(query.scope, 'scope') ?? (query.project !== undefined ? 'project' : 'all')
  const [kind, inline] = raw.startsWith('project:') ? ['project', raw.slice('project:'.length)] : [raw, undefined]
  if (kind === 'all' || kind === 'global') {
    if (query.project !== undefined) throw invalid(`project only goes with scope=project`)
    return { kind }
  }
  if (kind !== 'project') throw invalid('Invalid scope: expected all, global or project')
  const projectId = inline ?? text(query.project, 'project')
  if (!projectId || !PROJECT_ID_PATTERN.test(projectId)) throw invalid('scope=project needs a valid project id')
  return { kind: 'project', projectId }
}

/**
 * O pacote do corpo: o `.tar.gz` (chega como `Buffer`; a pasta `catalog/` do export sai do caminho) ou o JSON. ⛔ O
 * `.tar.gz` aberto tem teto (`CATALOG_IMPORT_UNPACK_FACTOR` × o limite do corpo): acima, 413.
 */
function packageOf(body: unknown): IPackageInput {
  if (!Buffer.isBuffer(body)) return parseBody(packageSchema, body ?? {})
  let entries: ReturnType<typeof untarGz>
  try {
    entries = untarGz(body, { maxBytes: limitBytes(catalogImportLimit()) * CATALOG_IMPORT_UNPACK_FACTOR })
  } catch (error: unknown) {
    if (error instanceof RangeError) throw new HttpError(413, 'payload_too_large', 'The package is too large once unpacked')
    throw invalid('Invalid package: expected the .tar.gz of the export')
  }
  const files: Record<string, string> = {}
  for (const entry of entries) {
    const path = entry.path.replace(/^\.\//, '')
    files[path.startsWith(`${EXPORT_ROOT}/`) ? path.slice(EXPORT_ROOT.length + 1) : path] = entry.content.toString('utf8')
  }
  return { files }
}

/** O escopo no corpo do apply: `all`, `global` ou `project:<id>` (o mesmo do manifesto). */
function applyScopeOf(raw: string): TCatalogScope {
  const scope = scopeOfManifest(raw)
  if (!scope) throw invalid('Invalid scope: expected all, global or project:<id>')
  return scope
}

/** Os documentos do corpo: a chave e o corpo; o texto e o hash saem daqui (o plano normaliza e confere a forma). */
function documentsOf(raw: ReadonlyArray<z.infer<typeof documentSchema>>): ICatalogDocument[] {
  return raw.map((item) => {
    const body = item.body as TCanonicalBody
    let text: string
    try {
      text = stableJson(body)
    } catch {
      text = JSON.stringify(body)
    }
    return { kind: item.kind as TCatalogKind, id: item.id, ...(item.projectId ? { projectId: item.projectId } : {}), body, text, hash: catalogHash(text) }
  })
}

function scopeLabel(scope: THistoryScope): string {
  return scope.kind === 'project' ? `project:${scope.projectId}` : scope.kind
}

/** ⚖️ Como o monitor: o que não serve vira o padrão (é uma tela de leitura); o teto de `pageSize` segura a página gigante. */
function pagingOf(query: Record<string, unknown>): IHistoryPaging {
  const page = Number.parseInt(String(query.page ?? ''), 10)
  const pageSize = Number.parseInt(String(query.pageSize ?? ''), 10)
  return {
    page: Number.isFinite(page) && page >= 1 ? page : 1,
    pageSize: Number.isFinite(pageSize) && pageSize >= 1 ? Math.min(pageSize, HISTORY_PAGE_SIZE_MAX) : HISTORY_PAGE_SIZE_DEFAULT,
  }
}

function boundedInt(value: unknown, name: string, min: number, max: number): number {
  const raw = String(value ?? '')
  const number = Number(raw)
  if (!/^\d+$/.test(raw) || number < min || number > max) throw invalid(`Invalid ${name}: expected an integer from ${min} to ${max}`)
  return number
}

function positiveInt(value: unknown, name: string): number {
  return boundedInt(value, name, 1, Number.MAX_SAFE_INTEGER)
}

/** Uma revisão (`0` = antes de existir) ou `current`; ausente = o padrão do diff. */
function refOf(value: unknown, name: string): TRevisionRef | undefined {
  if (value === undefined) return undefined
  if (value === 'current') return 'current'
  return boundedInt(value, name, 0, Number.MAX_SAFE_INTEGER)
}
