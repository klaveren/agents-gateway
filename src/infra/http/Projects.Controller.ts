import { Request, Response } from 'express'
import { z } from 'zod'
import { IProjectCaller, ProjectsService } from '@application/Projects.Service'
import { IProject } from '@domain/models/Project.Model'
import { resolveCaller } from './Caller.Access'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'

export interface IProjectsControllerDeps {
  projects: ProjectsService
  proof?: ICallerProof
}

const createSchema = z.object({ id: z.string().max(64), name: z.string().max(200), description: z.string().max(4000).optional() })
const updateSchema = z.object({ name: z.string().max(200).optional(), description: z.string().max(4000).optional() })
const membersSchema = z.object({ userIds: z.array(z.string().max(64)).max(1000) })

/**
 * Os projetos: a lista é de quem pode usar (o admin vê todos; os demais, os seus), e o cadastro e os
 * membros são só de admin (404 para os demais, como `/mcp-servers`).
 */
export class ProjectsController {
  constructor(private readonly deps: IProjectsControllerDeps) {
    for (const name of ['list', 'create', 'update', 'remove', 'members', 'setMembers'] as const) this[name] = this[name].bind(this)
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
        return this.toDto(this.deps.projects.create(parseBody(createSchema, req.body), by), true)
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
        await this.requireAdmin('deleteProject')
        this.deps.projects.remove(req.params.id as string)
        return null
      },
      { message: 'Project deleted' },
    )
  }

  async members(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('listProjectMembers')
      return this.deps.projects.members(req.params.id as string)
    })
  }

  /** A lista INTEIRA de membros (quem não está nela sai). */
  async setMembers(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const by = await this.requireAdmin('setProjectMembers')
      return this.deps.projects.setMembers(req.params.id as string, parseBody(membersSchema, req.body).userIds, by)
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
