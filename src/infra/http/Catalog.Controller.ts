import { Request, Response } from 'express'
import { z } from 'zod'
import type { TCatalogScope } from '@application/Catalog.Reader'
import { CatalogExportUseCase } from '@application/CatalogExport.Usecase'
import type { CatalogImportPlanner, IPackageInput } from '@application/CatalogImport.Plan'
import { CatalogRestoreUseCase, IRestoreCaller } from '@application/CatalogRestore.Usecase'
import { CatalogHistoryQuery, IHistoryItem, IHistoryPaging, THistoryScope, TRevisionRef } from '@application/CatalogHistory.Query'
import type { IProjectCaller } from '@application/Projects.Service'
import { CATALOG_KINDS, protocolItemId, TCatalogKind } from '@domain/Catalog.Document'
import { mcpServerKey, parseMcpServerKey } from '@domain/models/McpServer.Model'
import { PROJECT_ID_PATTERN } from '@domain/models/Project.Model'
import { TProtocolKind } from '@domain/models/Protocol.Model'
import { tarGz, untarGz } from '@infra/catalog/Tar.Archive'
import { viaAccessToken } from './Auth.Controller'
import { resolveCaller } from './Caller.Access'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'
import { CATALOG_IMPORT_UNPACK_FACTOR, catalogImportLimit, limitBytes } from './Security.Middleware'

export interface ICatalogControllerDeps {
  history: CatalogHistoryQuery
  proof?: ICallerProof
  /** Quem é membro de quê (a regra única dos projetos). Ausente = sem projetos: só o admin lê o histórico. */
  projects?: { canUse(caller: IProjectCaller, projectId: string): boolean }
  /** O rollback (restaurar, reverter lote). Ausente = sem escrita: as rotas respondem 404. */
  restore?: CatalogRestoreUseCase
  /** O export do pacote. Ausente = a rota responde 404. */
  exporter?: CatalogExportUseCase
  /** O plano de import (dry-run). Ausente = a rota responde 404. */
  importPlanner?: Pick<CatalogImportPlanner, 'planPackage'>
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

/**
 * ⛔ O que o MEMBRO de um projeto lê do histórico: só o que ele já vê hoje do projeto dele, por inteiro. É só o MCP do
 * projeto (`GET /mcp-servers?project=`). O resto não: o agente sai para ele sem o prompt (`GET /agents/:id` é de admin),
 * e rules, docs, skills, commands, complementos, permissões e o contexto inicial do projeto são todos de admin.
 */
const MEMBER_KINDS: readonly TCatalogKind[] = ['mcp']

type TViewer = { admin: true } | { admin: false; userId: string }

/**
 * O HISTÓRICO DO CATÁLOGO: as revisões de um item ou de um escopo, uma revisão inteira, o diff de linhas e o rollback
 * (ver docs/integration/plano-catalogo-historico.md §3, PRs 3 e 5).
 *
 * ⚖️ O ITEM VAI NA QUERY (`kind` + `id`), não no caminho: o id do complemento de protocolo tem barra (`<projeto>/<tipo>`).
 * `project` completa a chave quando precisa: no MCP, `id=n8n&project=cliente-a` é `cliente-a.n8n` (que também vale
 * direto em `id`); no complemento, `id=skill&project=cliente-a` é `cliente-a/skill`. Os outros tipos têm id único.
 *
 * ⛔ Admin lê tudo. O membro, só o MCP dos projetos dele (`MEMBER_KINDS`). Os demais recebem 404, como nas outras
 * rotas de admin: a resposta não confirma que o item existe.
 */
export class CatalogController {
  constructor(private readonly deps: ICatalogControllerDeps) {
    for (const name of ['history', 'revision', 'diff', 'restore', 'revertBatch', 'exportCatalog', 'importPlan'] as const) this[name] = this[name].bind(this)
  }

  /**
   * O EXPORT do catálogo (§2.5): `scope=all|global|project` (`project=<id>` com `project`; `scope=project:<id>` também
   * vale). `format=tar` (o padrão) devolve um `.tar.gz` com a pasta `catalog/`; `format=json`, o pacote
   * `{ manifest, files }` no envelope de sempre (é o que a CLI e a tela usam). ⛔ Só admin; os outros, 404. Ler não
   * amplia nada: o token de acesso (o CI) também exporta.
   */
  async exportCatalog(req: Request, res: Response): Promise<void> {
    try {
      const access = await checkAdminAccess(this.deps.proof)
      if (!access.allowed || !this.deps.exporter) throw this.deny('catalogExport', access.reason ?? 'export is not wired')
      const query = req.query as Record<string, unknown>
      const scope = exportScopeOf(query)
      const format = query.format === undefined ? 'tar' : query.format
      if (format !== 'tar' && format !== 'json') throw invalid('Invalid format: expected tar or json')
      const pack = this.deps.exporter.run(scope, access.identity?.email ?? access.identity?.id)
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
   * no export) ou do manifesto; sem nenhum, `all`. ⛔ Só admin; os outros, 404. O token de acesso (CI) também planeja,
   * mas o plano marca que a ampliação não se aplica por token (`caller.wideningsApplicable: false`).
   */
  async importPlan(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const access = await checkAdminAccess(this.deps.proof)
      if (!access.allowed || !this.deps.importPlanner) throw this.deny('catalogImportPlan', access.reason ?? 'import plan is not wired')
      const query = req.query as Record<string, unknown>
      const scope = query.scope !== undefined || query.project !== undefined ? exportScopeOf(query) : undefined
      return this.deps.importPlanner.planPackage(packageOf(req.body), { ...(scope ? { scope } : {}), viaAccessToken: viaAccessToken(res) })
    })
  }

  /**
   * RESTAURA uma revisão do item: grava uma revisão NOVA com o conteúdo dela (`op = restore`), nunca apaga revisão.
   * `expectedRevision` é a última que a pessoa viu (409 se alguém mexeu); a ampliação de permissão pede `confirm`
   * (409 com a lista certa) e só por admin na tela (403 para token de acesso). ⛔ Só admin; os outros, 404.
   */
  async restore(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { restore, caller } = await this.writer('catalogRestore', res)
      const body = parseBody(restoreSchema, req.body)
      const item = requiredItem({ kind: body.kind, id: body.id, ...(body.project !== undefined ? { project: body.project } : {}) })
      return restore.restore({ item, revision: body.revision, expectedRevision: body.expectedRevision, ...(body.confirm ? { confirm: body.confirm } : {}) }, caller)
    })
  }

  /**
   * REVERTE UM LOTE: cada item volta ao estado de antes do lote, em ordem inversa e segura, como um lote novo. Item que
   * mudou depois do lote é pulado (`conflicts`) a não ser que venha em `overwrite`. Mesma trava de ampliação, sobre o
   * conjunto. ⛔ Só admin; os outros, 404.
   */
  async revertBatch(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { restore, caller } = await this.writer('catalogRevertBatch', res)
      const body = parseBody(revertSchema, req.body ?? {})
      const batchId = text(req.params.batchId, 'batchId')!
      return restore.revert({ batchId, ...(body.confirm ? { confirm: body.confirm } : {}), ...(body.overwrite ? { overwrite: body.overwrite } : {}) }, caller)
    })
  }

  /** ⛔ Escrita: só admin provado. Quem aceita a ampliação é ele — e só pela tela (`viaAccessToken` recusa). */
  private async writer(operation: string, res: Response): Promise<{ restore: CatalogRestoreUseCase; caller: IRestoreCaller }> {
    const access = await checkAdminAccess(this.deps.proof)
    if (!access.allowed || !this.deps.restore) throw this.deny(operation, access.reason ?? 'restore is not wired')
    const by = access.identity?.email ?? access.identity?.id ?? 'admin'
    return { restore: this.deps.restore, caller: { by, viaAccessToken: viaAccessToken(res) } }
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
      if (viewer.admin) return { scope: scopeLabel(scope), ...this.deps.history.scopeRevisions(scope, paging) }
      if (scope.kind !== 'project' || !this.canUse(viewer, scope.projectId)) throw this.deny('catalogHistory', 'not a member of the scope')
      return { scope: scopeLabel(scope), ...this.deps.history.scopeRevisions(scope, paging, MEMBER_KINDS) }
    })
  }

  /** Uma revisão inteira, com o documento canônico (`document`, ausente na revisão de `delete`). */
  async revision(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const viewer = await this.viewer('catalogRevision')
      const item = requiredItem(req.query as Record<string, unknown>)
      const restrict = this.restrict(viewer, item)
      const number = positiveInt(req.params.revision, 'revision')
      const revision = this.deps.history.revision(item, number)
      if (!revision || (restrict.projectId !== undefined && revision.projectId !== restrict.projectId)) throw notFound(`Revision not found: ${number}`)
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
      this.restrict(viewer, item)
      if (!this.deps.history.known(item)) throw notFound('Catalog item not found')
      const from = refOf(query.from, 'from')
      const to = refOf(query.to, 'to')
      const context = query.context === undefined ? undefined : boundedInt(query.context, 'context', 0, CONTEXT_MAX)
      const diff = this.deps.history.diff(item, { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), ...(context !== undefined ? { context } : {}) })
      if (!diff) throw notFound('Revision not found')
      return diff
    })
  }

  /** Admin ou um chamador identificado (que pode ser membro de projeto); o resto, 404. */
  private async viewer(operation: string): Promise<TViewer> {
    const access = await checkAdminAccess(this.deps.proof)
    if (access.allowed) return { admin: true }
    const resolved = this.deps.projects ? await resolveCaller(this.deps.proof) : undefined
    const userId = resolved?.identity?.id
    if (!userId) throw this.deny(operation, access.reason)
    return { admin: false, userId }
  }

  /** O que o leitor pode ver do item: admin, tudo; o membro, só o MCP de um projeto dele (e só as revisões daquele projeto). */
  private restrict(viewer: TViewer, item: IHistoryItem): { projectId?: string } {
    if (viewer.admin) return {}
    const projectId = MEMBER_KINDS.includes(item.kind) ? parseMcpServerKey(item.itemId)?.projectId : undefined
    if (!projectId || !this.canUse(viewer, projectId)) throw this.deny('catalogHistory', 'item outside the caller projects')
    return { projectId }
  }

  private canUse(viewer: TViewer, projectId: string): boolean {
    return !!this.deps.projects?.canUse(viewer.admin ? { admin: true } : { userId: viewer.userId, admin: false }, projectId)
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
