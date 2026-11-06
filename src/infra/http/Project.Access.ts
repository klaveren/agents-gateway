import type { TProjectRole } from '@domain/models/Project.Model'
import { provenCaller } from './Caller.Access'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError } from './Http.Error'

/** O que a regra precisa dos projetos (o `ProjectsService`). */
export interface IProjectRoles {
  exists(projectId: string): boolean
  roleOf(projectId: string, userId: string | undefined): TProjectRole | undefined
  /** Os projetos de que a conta é membro. */
  projectsOf(userId: string): string[]
}

export interface IProjectAccessRegistry {
  roles: IProjectRoles
  /** O projeto de um agente: `null` = agente global; `undefined` = agente que não existe. */
  agentProject?: (agentId: string) => string | null | undefined
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
  return view.by
}

/** Ler um escopo: o projeto, o admin dele; o global, quem administra qualquer coisa (o projeto usa o global). */
export async function requireScopeReader(proof: ICallerProof | undefined, projectId: string | null | undefined, operation: string): Promise<string> {
  return projectId ? requireProjectAdmin(proof, projectId, operation) : (await requireAnyAdmin(proof, operation)).by
}

/** Todos os escopos dados (mover um item de projeto exige os dois). */
export async function requireProjectsAdmin(proof: ICallerProof | undefined, projectIds: ReadonlyArray<string | null | undefined>, operation: string): Promise<string> {
  const view = await adminView(proof)
  const outside = projectIds.find((projectId) => !view || !administers(view, projectId))
  if (!view || outside !== undefined) throw denied(operation, `not an administrator of ${outside ?? 'the global scope'}`)
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

function denied(operation: string, reason: string): HttpError {
  // ⚠️ O motivo vai para o log, nunca para a resposta: 404 não distingue "não pode" de "não existe".
  console.warn(`[admin] acesso negado a ${operation}:`, reason)
  return new HttpError(404, 'not_found', 'Not found')
}
