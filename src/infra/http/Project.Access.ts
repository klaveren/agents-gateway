import type { TProjectRole } from '@domain/models/Project.Model'
import { provenCaller } from './Caller.Access'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError } from './Http.Error'
import { currentRequest } from './Request.Scope'

/** O que a regra precisa dos projetos (o `ProjectsService`). */
export interface IProjectRoles {
  exists(projectId: string): boolean
  roleOf(projectId: string, userId: string | undefined): TProjectRole | undefined
  /** Os projetos de que a conta é membro. */
  projectsOf(userId: string): string[]
  /** Todos os projetos (para saber se alguém administra TUDO). Ausente = ninguém administra tudo. */
  all?(): ReadonlyArray<{ id: string }>
}

export interface IProjectAccessRegistry {
  roles: IProjectRoles
  /** O projeto de um agente: `null` = agente global; `undefined` = agente que não existe. */
  agentProject?: (agentId: string) => string | null | undefined
  /** 🔌 O projeto conectado (a cópia só de leitura do de outro gateway): a origem dele. Ausente = nenhum conectado. */
  connection?: (projectId: string) => { url: string } | undefined
}

/**
 * Quem administra o quê — o caminho de quem chama, decidido aqui e só aqui. DOIS NÍVEIS:
 *  · o administrador do GATEWAY (`checkAdminAccess`): o sistema (providers, contas, configurações), criar projeto,
 *    o item GLOBAL (sem projeto) e o resgate dos membros de um projeto (`/projects/:id/members`);
 *  · o administrador do PROJETO (papel `admin` em `project_members`): o catálogo e os agentes DAQUELE projeto.
 *
 * ⛔ O administrador do gateway NÃO entra no projeto de que não é admin: quer entrar, põe-se nos membros (o resgate).
 *
 * Sem os papéis registrados (`useProjectAccess`, na composição; os testes antigos), vale o nível do gateway para
 * tudo — como era antes dos papéis.
 */
let registry: IProjectAccessRegistry | undefined

export function useProjectAccess(next: IProjectAccessRegistry | undefined): void {
  registry = next
}

/** Quem administra alguma coisa, e o quê. `projects: 'all'` só sem os papéis registrados (o administrador de antes). */
export interface IAdminView {
  by: string
  userId?: string
  gateway: boolean
  projects: ReadonlySet<string> | 'all'
}

/** O que a conta administra; `undefined` = nada (nem o gateway, nem projeto nenhum). */
export async function adminView(proof: ICallerProof | undefined): Promise<IAdminView | undefined> {
  const identity = await provenCaller(proof)
  if (!identity?.id) return undefined
  const gateway = (await checkAdminAccess(proof)).allowed
  const by = identity.email ?? identity.id
  if (!registry) return gateway ? { by, userId: identity.id, gateway, projects: 'all' } : undefined
  const roles = registry.roles
  const projects = new Set(roles.projectsOf(identity.id).filter((projectId) => roles.roleOf(projectId, identity.id) === 'admin'))
  return gateway || projects.size ? { by, userId: identity.id, gateway, projects } : undefined
}

/** Se a visão administra o escopo: `null`/ausente = o global (só o gateway). */
export function administers(view: IAdminView, projectId: string | null | undefined): boolean {
  if (!projectId) return view.gateway
  return view.projects === 'all' || view.projects.has(projectId)
}

/**
 * Administra TUDO: o gateway e cada projeto que existe (o pacote inteiro do catálogo, o "tudo" do histórico). Sem os
 * papéis registrados, o administrador do gateway de antes.
 */
export function administersEverything(view: IAdminView): boolean {
  if (!view.gateway) return false
  if (view.projects === 'all') return true
  const projects = view.projects
  const all = registry?.roles.all?.()
  return !!all && all.every((project) => projects.has(project.id))
}

/** O sistema e o global: só o administrador do gateway. Devolve quem grava (`by`). */
export async function requireGatewayAdmin(proof: ICallerProof | undefined, operation: string): Promise<string> {
  const access = await checkAdminAccess(proof)
  if (!access.allowed) throw denied(operation, access.reason ?? 'not a gateway administrator')
  return access.identity?.email ?? access.identity?.id ?? 'admin'
}

/** O escopo do item: um projeto (o admin dele) ou, `null`/ausente, o global (o do gateway). Devolve `by`. */
export async function requireProjectAdmin(proof: ICallerProof | undefined, projectId: string | null | undefined, operation: string): Promise<string> {
  const view = await adminView(proof)
  if (!view || !administers(view, projectId)) throw denied(operation, projectId ? `not an administrator of project ${projectId}` : 'global item: gateway administrators only')
  guardConnected([projectId])
  return view.by
}

/** Ler um escopo: o projeto, o admin dele; o global, quem administra qualquer coisa (o projeto usa o global). */
export async function requireScopeReader(proof: ICallerProof | undefined, projectId: string | null | undefined, operation: string): Promise<string> {
  return projectId ? requireProjectAdmin(proof, projectId, operation) : (await requireAnyAdmin(proof, operation)).by
}

/** Todos os escopos dados (mover um item de projeto exige os dois). */
export async function requireProjectsAdmin(proof: ICallerProof | undefined, projectIds: ReadonlyArray<string | null | undefined>, operation: string): Promise<string> {
  const view = await adminView(proof)
  // ⚠️ `findIndex`, não `find`: o escopo negado pode ser o global (`undefined`), e `find` o confundiria com "nenhum".
  const outside = projectIds.findIndex((projectId) => !view || !administers(view, projectId))
  if (!view || outside >= 0) throw denied(operation, `not an administrator of ${projectIds[outside] ?? 'the global scope'}`)
  guardConnected(projectIds)
  return view.by
}

/** Quem administra o gateway ou algum projeto: ler o global, listar o que filtra por projeto. */
export async function requireAnyAdmin(proof: ICallerProof | undefined, operation: string): Promise<IAdminView> {
  const view = await adminView(proof)
  if (!view) throw denied(operation, 'not an administrator')
  return view
}

/**
 * O agente: o admin do projeto dele (o global, o do gateway). Agente que não existe passa pelo gateway: o serviço
 * responde o 404 de sempre, e quem não administra nada recebe o mesmo 404.
 */
export async function requireAgentAdmin(proof: ICallerProof | undefined, agentId: string, operation: string): Promise<string> {
  const projectId = agentProjectOf(agentId)
  return requireProjectAdmin(proof, projectId, operation)
}

/** O projeto do agente (`null` = global; `undefined` = não existe ou sem registro). */
export function agentProjectOf(agentId: string): string | null | undefined {
  return registry?.agentProject?.(agentId)
}

/**
 * 🔌 O que muda num projeto conectado SEM mexer no catálogo: os valores das variáveis, os hooks e os agendamentos (a
 * operação daqui), os membros, as contas, a própria conexão e o que só confere ou planeja. O ledger do agente conectado
 * mora na origem: a tela daqui não o edita.
 * As regras de permissão do AGENTE e a aprovação de um pedido entram: gravam na camada local dele (`AgentLocalLayer`),
 * nunca no agente; o pedido que mudaria o catálogo é recusado na própria rota (`refuseConnected`).
 */
const CONNECTED_WRITABLE: readonly RegExp[] = [
  /^\/connections(\/|$)/,
  /^\/(agents\/:agentId|resources\/:resourceId)\/secrets\//,
  /^\/agents\/:agentId\/(hooks|schedules)(\/|$)/,
  /^\/mcp-servers\/:id\/(env|secret|oauth|test|install|stop)(\/|$)/,
  /^\/projects\/:id\/members$/,
  /^\/projects\/:projectId\/(accounts|permissions\/test)(\/|$)/,
  /^\/catalog\/import\/plan$/,
  /^\/permission-requests\/:requestId\/(approve|reject)$/,
  /^\/agents\/:agentId\/permission-rules$/,
]

/**
 * ⛔ O PROJETO CONECTADO É SÓ LEITURA: o catálogo vem da origem (a .4), e mudar é lá — um ticket, que a esteira
 * implementa e chega a todos pela atualização. Vale para a tela, a API e as ferramentas dos agentes (que chamam a API).
 * Quem não administra o projeto já ouviu 404 antes; quem administra ouve o porquê. A sincronização não passa por aqui.
 */
function guardConnected(projectIds: ReadonlyArray<string | null | undefined>): void {
  const request = currentRequest()
  if (!request || request.method === 'GET' || CONNECTED_WRITABLE.some((pattern) => pattern.test(request.route))) return
  for (const projectId of projectIds) refuseConnected(projectId)
}

/** ⛔ Recusa o que mudaria o catálogo de um projeto conectado, em qualquer rota (a que passa pela lista acima confere aqui o caso que não pode). */
export function refuseConnected(projectId: string | null | undefined): void {
  const connection = projectId ? registry?.connection?.(projectId) : undefined
  if (connection)
    throw new HttpError(
      409,
      'project_read_only',
      `O projeto ${projectId} é conectado a ${connection.url}: o catálogo é só leitura aqui. Mudança é feita na origem (abra um ticket); para mexer localmente, desconecte o projeto.`,
    )
}

function denied(operation: string, reason: string): HttpError {
  // ⚠️ O motivo vai para o log, nunca para a resposta: 404 não distingue "não pode" de "não existe".
  console.warn(`[admin] acesso negado a ${operation}:`, reason)
  return new HttpError(404, 'not_found', 'Not found')
}
