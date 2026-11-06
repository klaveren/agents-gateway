import { ignoreIssues, normalizeIgnore } from '@domain/Import.Ignore'
import { IAgenticScope, normalizeScope, scopeIssues } from '@domain/Import.Scope'
import { InvalidProjectError, ProjectInUseError, ProjectNotFoundError } from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { DEFAULT_PROJECT_ID, IProject, IProjectMember, PROJECT_ID_PATTERN, PROJECT_ROLES, TProjectRole } from '@domain/models/Project.Model'
import { IConversationRepository } from '@domain/ports/ConversationRepository.Port'
import { IProjectRepository } from '@domain/ports/ProjectRepository.Port'
import { TRevisionSource } from '@domain/ports/CatalogHistoryRepository.Port'
import { CatalogHistoryHook } from './CatalogHistory.Service'

/** Quem pergunta: a conta (id) e se é administrador provado. */
export interface IProjectCaller {
  userId?: string
  admin: boolean
}

/** Um membro como chega na gravação: a conta e, se dito, o papel (sem papel, fica o que tinha, ou `member`). */
export type TMemberInput = string | { userId: string; role?: TProjectRole }

const NAME_MAX = 80
const DESCRIPTION_MAX = 2_000

/**
 * O cadastro dos projetos e de quem é membro de cada um.
 *
 * ⛔ UMA REGRA SÓ PARA O ACESSO (`canUse`): só os projetos de que a conta é MEMBRO — também o administrador do
 * gateway (ele cuida do sistema; para entrar num projeto, põe-se nos membros). A lista de agentes, a de conversas,
 * abrir conversa e o hook passam todos por aqui.
 */
export class ProjectsService {
  /** O histórico do catálogo: o projeto, as permissões dele e, ao apagar, tudo o que ia junto (ver `CatalogHistory.Service`). */
  readonly history = new CatalogHistoryHook()

  constructor(
    private readonly projects: IProjectRepository,
    /** Os agentes como gravados (para recusar apagar projeto que ainda tem agente). */
    private readonly agents: () => readonly IAgent[],
    /** A conta existe? (os membros são contas do gateway). */
    private readonly userExists: (userId: string) => boolean,
    /** Cria (e devolve) a pasta do projeto. */
    private readonly workspace: { create: (projectId: string) => string; remove: (projectId: string) => void },
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * ⛔ Os projetos de que a pessoa é MEMBRO — também o administrador do gateway: ele cuida do que não é de projeto, e
   * só vê os projetos em que entrou. (`all` é a lista inteira, para o trabalho do próprio gateway.)
   */
  list(caller: IProjectCaller): IProject[] {
    if (!caller.userId) return []
    const mine = new Set(this.projects.projectsOf(caller.userId))
    return this.projects.list().filter((project) => mine.has(project.id))
  }

  /** Todos os projetos, para o trabalho do próprio gateway (o boot, as migrações) — nunca para uma tela. */
  all(): IProject[] {
    return this.projects.list()
  }

  /** O papel da conta no projeto, ou nada se ela não é membro. */
  roleOf(projectId: string, userId: string | undefined): TProjectRole | undefined {
    return userId ? this.projects.members(projectId).find((member) => member.userId === userId)?.role : undefined
  }

  get(id: string): IProject {
    const project = this.projects.get(id)
    if (!project) throw new ProjectNotFoundError(id)
    return project
  }

  exists(id: string): boolean {
    return !!this.projects.get(id)
  }

  /** Os projetos de que a conta é membro (qualquer papel). */
  projectsOf(userId: string): string[] {
    return this.projects.projectsOf(userId)
  }

  canUse(caller: IProjectCaller, projectId: string): boolean {
    if (!this.projects.get(projectId)) return false
    return !!caller.userId && this.projects.projectsOf(caller.userId).includes(projectId)
  }

  folderOf(projectId: string): string {
    return this.workspace.create(projectId)
  }

  /** `creatorId`: a conta que criou vira o primeiro administrador do projeto (sem ela, o projeto nasce sem membros). */
  create(input: { id: string; name: string; description?: string }, by: string, source: TRevisionSource = 'api', creatorId?: string): IProject {
    const project: IProject = {
      id: input.id.trim(),
      name: input.name.trim(),
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      createdAt: this.now(),
      updatedAt: this.now(),
      updatedBy: by,
    }
    const issues = projectIssues(project)
    if (!PROJECT_ID_PATTERN.test(project.id)) issues.unshift({ field: 'id', message: 'use 2–32 lowercase letters, digits or hyphens' })
    else if (this.projects.get(project.id)) issues.unshift({ field: 'id', message: `already exists: ${project.id}` })
    if (issues.length) throw new InvalidProjectError(issues)
    this.projects.insert(project)
    this.workspace.create(project.id)
    if (creatorId && this.userExists(creatorId)) this.projects.setMembers(project.id, [{ userId: creatorId, role: 'admin' }], by)
    this.history.record(
      [
        { kind: 'project', id: project.id },
        { kind: 'project-permissions', id: project.id },
      ],
      { by, source },
    )
    return project
  }

  update(id: string, change: { name?: string; description?: string }, by: string): IProject {
    const current = this.get(id)
    const next: IProject = {
      ...current,
      ...(change.name !== undefined ? { name: change.name.trim() } : {}),
      ...(change.description !== undefined ? { description: change.description.trim() } : {}),
    }
    const issues = projectIssues(next)
    if (issues.length) throw new InvalidProjectError(issues)
    const saved = this.projects.update(id, {
      name: next.name,
      ...(change.description !== undefined ? { description: next.description || undefined } : {}),
      updatedAt: this.now(),
      updatedBy: by,
    })!
    this.history.record([{ kind: 'project', id }], { by })
    return saved
  }

  /**
   * ⛔ Com agente dentro, recusa e diz quais (409). Vazio, some com membros e pasta — e com as rules, os docs, os
   * recursos, os complementos, as permissões e os MCPs dele: cada um ganha a revisão de `delete`, com o mesmo autor.
   */
  remove(id: string, by: string): void {
    this.get(id)
    const using = this.agents().filter((agent) => agent.projectId === id)
    if (using.length)
      throw new ProjectInUseError(
        id,
        using.map((agent) => agent.name),
      )
    const touched = this.history.keysOf({ kind: 'project', projectId: id })
    this.projects.delete(id)
    this.workspace.remove(id)
    this.history.record(touched, { by })
  }

  /** Os padrões que a varredura do importador ignora neste projeto. */
  importIgnore(id: string): string[] {
    return this.get(id).importIgnore ?? []
  }

  /** ⛔ Troca a lista inteira (vazia apaga). Padrão absoluto ou com `..` é recusado: o ignorar é dentro do repositório. */
  setImportIgnore(id: string, patterns: readonly string[], by: string): string[] {
    this.get(id)
    const issues = ignoreIssues(patterns)
    if (issues.length) throw new InvalidProjectError(issues)
    const clean = normalizeIgnore(patterns)
    return this.projects.update(id, { importIgnore: clean, updatedAt: this.now(), updatedBy: by })?.importIgnore ?? []
  }

  /** O ambiente agêntico que a varredura do importador olha neste projeto (os lugares padrão desligados e os a mais). */
  importScope(id: string): IAgenticScope {
    return normalizeScope(this.get(id).importScope)
  }

  /** ⛔ Troca o ambiente inteiro. Lugar desconhecido, caminho absoluto ou com `..` é recusado: o ambiente é dentro do repositório. */
  setImportScope(id: string, scope: { disabled: readonly string[]; extra: readonly string[] }, by: string): IAgenticScope {
    this.get(id)
    const issues = scopeIssues(scope)
    if (issues.length) throw new InvalidProjectError(issues)
    return normalizeScope(this.projects.update(id, { importScope: normalizeScope(scope), updatedAt: this.now(), updatedBy: by })?.importScope)
  }

  members(id: string): IProjectMember[] {
    this.get(id)
    return this.projects.members(id)
  }

  /**
   * A lista INTEIRA de membros, com o papel. ⛔ Todo projeto fica com ao menos um administrador: a lista sem nenhum é
   * recusada (tirar ou rebaixar o último também). Sem papel dito, o membro fica com o que tinha (ou `member`).
   */
  setMembers(id: string, input: readonly TMemberInput[], by: string): IProjectMember[] {
    this.get(id)
    const before = new Map(this.projects.members(id).map((member) => [member.userId, member.role]))
    const wanted = new Map<string, TProjectRole>()
    for (const item of input) {
      const userId = (typeof item === 'string' ? item : item.userId).trim()
      if (!userId) continue
      const role = typeof item === 'string' ? undefined : item.role
      if (role !== undefined && !PROJECT_ROLES.includes(role)) throw new InvalidProjectError([{ field: 'members', message: `unknown role: ${String(role)}` }])
      wanted.set(userId, role ?? before.get(userId) ?? wanted.get(userId) ?? 'member')
    }
    const unknown = [...wanted.keys()].filter((userId) => !this.userExists(userId))
    if (unknown.length) throw new InvalidProjectError([{ field: 'members', message: `no such account: ${unknown.join(', ')}` }])
    if (![...wanted.values()].includes('admin')) throw new InvalidProjectError([{ field: 'members', message: 'a project needs at least one admin member' }])
    this.projects.setMembers(
      id,
      [...wanted].map(([userId, role]) => ({ userId, role })),
      by,
    )
    return this.projects.members(id)
  }
}

/** Os problemas dos campos do projeto (nome e descrição), SEM gravar: as regras de `create`/`update`. */
export function projectIssues(project: Pick<IProject, 'name' | 'description'>): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = []
  if (!project.name) issues.push({ field: 'name', message: 'required' })
  else if (project.name.length > NAME_MAX) issues.push({ field: 'name', message: `at most ${NAME_MAX} characters` })
  if ((project.description?.length ?? 0) > DESCRIPTION_MAX) issues.push({ field: 'description', message: `at most ${DESCRIPTION_MAX} characters` })
  return issues
}

const MIGRATION = 'migrated:default-project'

/**
 * ⚖️ A PASSAGEM PARA PROJETOS, UMA VEZ: o que existia antes (agentes criados e as conversas deles) vai para
 * o projeto `geral`, com todas as contas atuais como membros — ninguém perde acesso no deploy. A semente
 * (o Atlas) fica global. Banco sem agente criado não ganha projeto nenhum.
 */
export async function migrateLegacyToProjects(deps: {
  service: ProjectsService
  repository: Pick<IProjectRepository, 'done' | 'markDone'>
  agents: { rawEntries(): Array<{ agent: IAgent }>; moveToProject(id: string, projectId: string, by: string): void }
  conversations: Pick<IConversationRepository, 'assignProject'>
  userIds: () => string[]
  /** As contas que administram o gateway: viram administradoras do projeto `geral` (todo projeto tem uma). */
  adminIds?: () => string[]
  seedIds: readonly string[]
}): Promise<{ agents: number; conversations: number } | undefined> {
  if (deps.repository.done(MIGRATION)) return undefined
  const seeded = new Set(deps.seedIds)
  const legacy = deps.agents
    .rawEntries()
    .map((entry) => entry.agent)
    .filter((agent) => !seeded.has(agent.id) && !agent.projectId)
  let moved = 0
  if (legacy.length) {
    if (!deps.service.exists(DEFAULT_PROJECT_ID))
      deps.service.create({ id: DEFAULT_PROJECT_ID, name: 'Geral', description: 'O que existia antes dos projetos.' }, 'migração', 'migration')
    const admins = new Set(deps.adminIds?.() ?? [])
    const everyone = deps.userIds()
    deps.service.setMembers(
      DEFAULT_PROJECT_ID,
      everyone.map((userId, index) => ({ userId, role: admins.has(userId) || (!admins.size && index === 0) ? 'admin' : 'member' })),
      'migração',
    )
    for (const agent of legacy) deps.agents.moveToProject(agent.id, DEFAULT_PROJECT_ID, 'migração')
    moved = await deps.conversations.assignProject(
      legacy.map((agent) => agent.id),
      DEFAULT_PROJECT_ID,
    )
    console.log(`[projetos] ${legacy.length} agente(s) e ${moved} conversa(s) foram para o projeto "${DEFAULT_PROJECT_ID}"`)
  }
  deps.repository.markDone(MIGRATION)
  return { agents: legacy.length, conversations: moved }
}

const ROLES_MIGRATION = 'migrated:project-roles'

/**
 * ⚖️ OS PAPÉIS NO PROJETO, UMA VEZ: o membro que administra o gateway vira administrador do projeto; o projeto que
 * ainda ficar sem administrador ganha as contas administradoras do gateway como administradoras. Ninguém perde acesso.
 */
export function migrateProjectRoles(deps: {
  repository: Pick<IProjectRepository, 'list' | 'members' | 'setMembers' | 'done' | 'markDone'>
  /** As contas que administram o gateway (ativas). */
  adminIds: () => string[]
}): number {
  if (deps.repository.done(ROLES_MIGRATION)) return 0
  const admins = deps.adminIds()
  let changed = 0
  for (const project of deps.repository.list()) {
    const members = deps.repository.members(project.id)
    let next = members.map((member) => ({ userId: member.userId, role: admins.includes(member.userId) ? ('admin' as const) : member.role }))
    if (!next.some((member) => member.role === 'admin'))
      next = [...next.filter((member) => !admins.includes(member.userId)), ...admins.map((userId) => ({ userId, role: 'admin' as const }))]
    if (JSON.stringify(next) === JSON.stringify(members.map((member) => ({ userId: member.userId, role: member.role })))) continue
    deps.repository.setMembers(project.id, next, 'migração')
    changed += 1
  }
  deps.repository.markDone(ROLES_MIGRATION)
  if (changed) console.log(`[projetos] papéis: ${changed} projeto(s) com administradores definidos`)
  return changed
}
