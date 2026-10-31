import { ignoreIssues, normalizeIgnore } from '@domain/Import.Ignore'
import { InvalidProjectError, ProjectInUseError, ProjectNotFoundError } from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { DEFAULT_PROJECT_ID, IProject, IProjectMember, PROJECT_ID_PATTERN } from '@domain/models/Project.Model'
import { IConversationRepository } from '@domain/ports/ConversationRepository.Port'
import { IProjectRepository } from '@domain/ports/ProjectRepository.Port'
import { TRevisionSource } from '@domain/ports/CatalogHistoryRepository.Port'
import { CatalogHistoryHook } from './CatalogHistory.Service'

/** Quem pergunta: a conta (id) e se é administrador provado. */
export interface IProjectCaller {
  userId?: string
  admin: boolean
}

const NAME_MAX = 80
const DESCRIPTION_MAX = 2_000

/**
 * O cadastro dos projetos e de quem é membro de cada um.
 *
 * ⛔ UMA REGRA SÓ PARA O ACESSO (`canUse`): admin usa todos; os demais, só os projetos de que são membros. A
 * lista de agentes, a de conversas, abrir conversa e o hook passam todos por aqui.
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

  /** Os projetos que a pessoa pode usar: todos para o admin. */
  list(caller: IProjectCaller): IProject[] {
    const all = this.projects.list()
    if (caller.admin) return all
    if (!caller.userId) return []
    const mine = new Set(this.projects.projectsOf(caller.userId))
    return all.filter((project) => mine.has(project.id))
  }

  get(id: string): IProject {
    const project = this.projects.get(id)
    if (!project) throw new ProjectNotFoundError(id)
    return project
  }

  exists(id: string): boolean {
    return !!this.projects.get(id)
  }

  canUse(caller: IProjectCaller, projectId: string): boolean {
    if (!this.projects.get(projectId)) return false
    if (caller.admin) return true
    return !!caller.userId && this.projects.projectsOf(caller.userId).includes(projectId)
  }

  folderOf(projectId: string): string {
    return this.workspace.create(projectId)
  }

  create(input: { id: string; name: string; description?: string }, by: string, source: TRevisionSource = 'api'): IProject {
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

  members(id: string): IProjectMember[] {
    this.get(id)
    return this.projects.members(id)
  }

  setMembers(id: string, userIds: readonly string[], by: string): IProjectMember[] {
    this.get(id)
    const unique = [...new Set(userIds.map((userId) => userId.trim()).filter(Boolean))]
    const unknown = unique.filter((userId) => !this.userExists(userId))
    if (unknown.length) throw new InvalidProjectError([{ field: 'members', message: `no such account: ${unknown.join(', ')}` }])
    this.projects.setMembers(id, unique, by)
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
    deps.service.setMembers(DEFAULT_PROJECT_ID, deps.userIds(), 'migração')
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
