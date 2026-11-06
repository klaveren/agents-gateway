import { Request, Response } from 'express'
import { z } from 'zod'
import { IProjectCaller, ProjectsService } from '@application/Projects.Service'
import { IProject, PROJECT_ROLES } from '@domain/models/Project.Model'
import { resolveCaller } from './Caller.Access'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'
import { listRepositories } from '@infra/workspace/Work.Folder'

export interface IProjectsControllerDeps {
  projects: ProjectsService
  proof?: ICallerProof
}

const createSchema = z.object({ id: z.string().max(64), name: z.string().max(200), description: z.string().max(4000).optional() })
const updateSchema = z.object({ name: z.string().max(200).optional(), description: z.string().max(4000).optional() })
/** A lista inteira de membros, com o papel (`members`); `userIds` (sem papel) segue aceito: cada um fica com o que tinha. */
const membersSchema = z
  .object({
    members: z
      .array(z.object({ userId: z.string().max(64), role: z.enum(PROJECT_ROLES) }))
      .max(1000)
      .optional(),
    userIds: z.array(z.string().max(64)).max(1000).optional(),
  })
  .refine((body) => body.members || body.userIds, { message: 'members (or userIds) is required' })

/**
 * Os projetos: a lista é dos projetos de que a pessoa é membro (o administrador do gateway também). Criar é do
 * administrador do gateway (quem cria vira o primeiro administrador do projeto); os membros, dele ou do administrador
 * do projeto (404 para os demais, como `/mcp-servers`).
 */
export class ProjectsController {
  constructor(private readonly deps: IProjectsControllerDeps) {
    for (const name of ['list', 'create', 'update', 'remove', 'members', 'setMembers', 'repositories'] as const) this[name] = this[name].bind(this)
  }

  /**
   * `GET /projects/:id/repositories` — os repositórios do projeto (`repositories/<nome>`) e as worktrees de cada um, para
   * abrir a conversa num deles. Para quem pode usar o projeto; para os demais, 404 como projeto inexistente.
   */
  async repositories(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const id = req.params.id as string
      const caller = await this.caller()
      if (!this.deps.projects.exists(id) || !this.deps.projects.canUse(caller, id)) throw new HttpError(404, 'not_found', `Project not found: ${id}`)
      return listRepositories(this.deps.projects.folderOf(id))
    })
  }

  async list(_req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const caller = await this.caller()
      return this.deps.projects.list(caller).map((project) => this.toDto(project, caller.admin))
    })
  }

  async create(req: Request, res: Response): Promise<void> {
    await this.respond(
      res,
      async () => {
        const by = await this.requireAdmin('createProject')
        const creator = (await this.caller()).userId
        return this.toDto(this.deps.projects.create(parseBody(createSchema, req.body), by, 'api', creator), true)
      },
      { status: 201, message: 'Project created' },
    )
  }

  async update(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const by = await this.requireAdmin('updateProject')
      return this.toDto(this.deps.projects.update(req.params.id as string, parseBody(updateSchema, req.body), by), true)
    })
  }

  async remove(req: Request, res: Response): Promise<void> {
    await this.respond(
      res,
      async () => {
        this.deps.projects.remove(req.params.id as string, await this.requireAdmin('deleteProject'))
        return null
      },
      { message: 'Project deleted' },
    )
  }

  async members(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireProjectAdmin(req.params.id as string, 'listProjectMembers')
      return this.deps.projects.members(req.params.id as string)
    })
  }

  /** A lista INTEIRA de membros (quem não está nela sai). */
  async setMembers(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const by = await this.requireProjectAdmin(req.params.id as string, 'setProjectMembers')
      const body = parseBody(membersSchema, req.body)
      return this.deps.projects.setMembers(req.params.id as string, body.members ?? body.userIds ?? [], by)
    })
  }

  /** ⛔ A pasta (caminho no servidor) só para o admin. */
  private toDto(project: IProject, admin: boolean) {
    return {
      id: project.id,
      name: project.name,
      ...(project.description ? { description: project.description } : {}),
      ...(admin ? { folder: this.deps.projects.folderOf(project.id), members: this.deps.projects.members(project.id).length } : {}),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      ...(admin && project.updatedBy ? { updatedBy: project.updatedBy } : {}),
    }
  }

  private async caller(): Promise<IProjectCaller> {
    const resolved = await resolveCaller(this.deps.proof)
    if (!resolved) throw new HttpError(401, 'unauthorized', 'Missing or unverifiable caller credential')
    return { userId: resolved.identity?.id, admin: (await checkAdminAccess(this.deps.proof)).allowed }
  }

  /** O administrador do gateway ou o administrador DESTE projeto; os demais, 404 (como projeto inexistente). */
  private async requireProjectAdmin(projectId: string, operation: string): Promise<string> {
    const access = await checkAdminAccess(this.deps.proof)
    if (access.allowed) return access.identity?.email ?? access.identity?.id ?? 'admin'
    const caller = await this.caller()
    if (this.deps.projects.exists(projectId) && this.deps.projects.roleOf(projectId, caller.userId) === 'admin') return caller.userId ?? 'admin'
    console.warn(`[admin] acesso negado a ${operation}: não administra o projeto ${projectId}`)
    throw new HttpError(404, 'not_found', 'Not found')
  }

  private async requireAdmin(operation: string): Promise<string> {
    const access = await checkAdminAccess(this.deps.proof)
    if (!access.allowed) {
      console.warn(`[admin] acesso negado a ${operation}:`, access.reason)
      throw new HttpError(404, 'not_found', 'Not found')
    }
    return access.identity?.email ?? access.identity?.id ?? 'admin'
  }

  private async respond<T>(res: Response, work: () => Promise<T>, options: { status?: number; message?: string } = {}) {
    try {
      res.status(options.status ?? 200).json(ok(await work(), options.message))
    } catch (error: unknown) {
      const failure = toHttpFailure(error)
      if (failure.status >= 500) console.error('[ProjectsController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}
