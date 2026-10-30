import { Request, Response } from 'express'
import { CatalogHistoryQuery, IHistoryItem, IHistoryPaging, THistoryScope, TRevisionRef } from '@application/CatalogHistory.Query'
import type { IProjectCaller } from '@application/Projects.Service'
import { CATALOG_KINDS, protocolItemId, TCatalogKind } from '@domain/Catalog.Document'
import { mcpServerKey, parseMcpServerKey } from '@domain/models/McpServer.Model'
import { TProtocolKind } from '@domain/models/Protocol.Model'
import { resolveCaller } from './Caller.Access'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'

export interface ICatalogControllerDeps {
  history: CatalogHistoryQuery
  proof?: ICallerProof
  /** Quem é membro de quê (a regra única dos projetos). Ausente = sem projetos: só o admin lê o histórico. */
  projects?: { canUse(caller: IProjectCaller, projectId: string): boolean }
}

export const HISTORY_PAGE_SIZE_DEFAULT = 20
export const HISTORY_PAGE_SIZE_MAX = 100
const CONTEXT_MAX = 50
const ID_MAX = 200

/**
 * ⛔ O que o MEMBRO de um projeto lê do histórico: só o que ele já vê hoje do projeto dele, por inteiro. É só o MCP do
 * projeto (`GET /mcp-servers?project=`). O resto não: o agente sai para ele sem o prompt (`GET /agents/:id` é de admin),
 * e rules, docs, skills, commands, complementos, permissões e o contexto inicial do projeto são todos de admin.
 */
const MEMBER_KINDS: readonly TCatalogKind[] = ['mcp']

type TViewer = { admin: true } | { admin: false; userId: string }

/**
 * O HISTÓRICO DO CATÁLOGO, só leitura: as revisões de um item ou de um escopo, uma revisão inteira e o diff de linhas
 * (ver docs/integration/plano-catalogo-historico.md §3, PR 3).
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
    for (const name of ['history', 'revision', 'diff'] as const) this[name] = this[name].bind(this)
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
