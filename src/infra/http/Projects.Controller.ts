import { Request, Response } from 'express'
import { z } from 'zod'
import { IProjectCaller, ProjectsService } from '@application/Projects.Service'
import { IProject, PROJECT_ENV_LIMITS, PROJECT_ROLES, TProjectRole } from '@domain/models/Project.Model'
import { resolveCaller } from './Caller.Access'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { requireProjectAdmin } from './Project.Access'
import { parseBody } from './Request.Parser'
import { IRepositoryEntry, listRepositories } from '@infra/workspace/Work.Folder'
import { cloneRepository, initRepository, removeRepository, repositoriesInSetup, RepositorySetupError } from '@infra/workspace/Repository.Setup'

export interface IProjectsControllerDeps {
  projects: ProjectsService
  proof?: ICallerProof
  /** ⛔ A credencial de UMA conta do projeto para o `git clone` (só o ambiente; nunca vai à resposta). `undefined` = não é conta de git. */
  gitCredentials?: (projectId: string, accountId: string) => Promise<{ env: Record<string, string>; host?: string } | undefined>
  /** Há conversa em turno neste repositório? Remover no meio do turno é 409. */
  busy?: (projectId: string, repository: string) => boolean
  /** A branch base e o nome desta instalação (Configurações), para o git local. */
  installation?: () => Promise<{ baseBranch?: string; name?: string }>
}

const createSchema = z.object({ id: z.string().max(64), name: z.string().max(200), description: z.string().max(4000).optional() })
const updateSchema = z.object({
  name: z.string().max(200).optional(),
  description: z.string().max(4000).optional(),
  /** As variáveis fixas, a lista inteira (ver `IProject.env`). */
  env: z.record(z.string().max(64), z.string().max(PROJECT_ENV_LIMITS.value)).optional(),
  /** Os valores visíveis dos MCPs, a lista inteira (ver `IProject.mcpEnv`). */
  mcpEnv: z
    .array(z.object({ server: z.string().max(64), name: z.string().max(64), value: z.string().max(PROJECT_ENV_LIMITS.value) }))
    .max(PROJECT_ENV_LIMITS.mcp)
    .optional(),
})
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
/** Com `url`, clona (a `account` dá a credencial); sem ela, cria um git local, sem remoto (`name` obrigatório). */
const repositorySchema = z.object({
  url: z.string().max(2000).optional(),
  name: z.string().max(100).optional(),
  account: z.string().max(64).optional(),
  branch: z.string().max(200).optional(),
})

type TRepositoryDto = IRepositoryEntry & { cloning?: boolean }

const invalid = (field: string, message: string) => new HttpError(422, 'validation_error', 'Request body is invalid', [{ field, message }])

/** O erro de preparar o repositório, como a resposta o conta: o campo no 422, o conflito no 409, a falha do git no 502. */
function setupFailure(error: unknown): unknown {
  if (!(error instanceof RepositorySetupError)) return error
  if (error.code === 'invalid') return invalid(error.field ?? '_', error.message)
  if (error.code === 'exists') return invalid('name', error.message)
  if (error.code === 'busy') return new HttpError(409, 'repository_busy', error.message)
  if (error.code === 'not_found') return new HttpError(404, 'not_found', error.message)
  return new HttpError(502, 'upstream_error', error.message)
}

/**
 * Os projetos: a lista é dos projetos de que a pessoa é membro (o administrador do gateway também), com o papel dela.
 * Criar e apagar são do administrador do gateway (quem cria vira o primeiro administrador do projeto); o nome e os
 * repositórios, do administrador do projeto; os membros, dele ou do administrador do gateway — o resgate (404 para os
 * demais). ⛔ O resgate é só dos membros: o administrador do gateway que não é do projeto não mexe nos repositórios dele.
 */
export class ProjectsController {
  constructor(private readonly deps: IProjectsControllerDeps) {
    for (const name of ['list', 'create', 'update', 'remove', 'members', 'setMembers', 'repositories', 'addRepository', 'removeRepository'] as const)
      this[name] = this[name].bind(this)
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
      return this.repositoriesOf(id)
    })
  }

  /**
   * `POST /projects/:id/repositories` — um repositório novo em `repositories/<nome>`: clonado de uma URL https (com a
   * credencial de uma Conta do projeto, se o servidor pedir) ou criado aqui, só local, sem remoto. Do administrador do
   * projeto. ⚖️ A resposta espera o clone acabar; enquanto isso a lista o mostra com `cloning`.
   */
  async addRepository(req: Request, res: Response): Promise<void> {
    await this.respond(
      res,
      async () => {
        const id = req.params.id as string
        await this.requireProjectRole(id, 'addRepository')
        if (!this.deps.projects.exists(id)) throw new HttpError(404, 'not_found', `Project not found: ${id}`)
        const body = parseBody(repositorySchema, req.body)
        const folder = this.deps.projects.folderOf(id)
        const url = body.url?.trim()
        const name = body.name?.trim()
        const branch = body.branch?.trim()
        let created: string
        if (url) {
          const credentials = body.account ? await this.gitCredentials(id, body.account) : undefined
          created = await cloneRepository(folder, {
            source: url,
            ...(name ? { name } : {}),
            ...(branch ? { branch } : {}),
            ...(credentials ? { env: credentials.env } : {}),
            ...(credentials?.host ? { privateHost: credentials.host } : {}),
          }).catch((error: unknown) => Promise.reject(setupFailure(error)))
        } else {
          if (body.account) throw invalid('account', 'account: a conta só entra no clone por URL')
          if (!name) throw invalid('name', 'name: o git local precisa de um nome')
          const installation = (await this.deps.installation?.()) ?? {}
          const base = branch || installation.baseBranch
          created = await initRepository(folder, { name, ...(base ? { branch: base } : {}), ...(installation.name ? { author: installation.name } : {}) }).catch((error: unknown) =>
            Promise.reject(setupFailure(error)),
          )
        }
        return this.repositoriesOf(id).find((item) => item.name === created) ?? { name: created, worktrees: [] }
      },
      { status: 201, message: 'Repository created' },
    )
  }

  /**
   * `DELETE /projects/:id/repositories/:name` — apaga a pasta do repositório e as worktrees dele dentro de
   * `repositories/`. Do administrador do projeto. ⛔ Com conversa em turno nele, 409; a worktree fora de `repositories/`
   * (ou que guarda a de outro repositório) fica no disco e volta em `kept`.
   */
  async removeRepository(req: Request, res: Response): Promise<void> {
    await this.respond(
      res,
      async () => {
        const id = req.params.id as string
        const name = req.params.name as string
        await this.requireProjectRole(id, 'removeRepository')
        if (!this.deps.projects.exists(id)) throw new HttpError(404, 'not_found', `Project not found: ${id}`)
        if (this.deps.busy?.(id, name)) throw new HttpError(409, 'repository_busy', `Há conversa em andamento em ${name}: espere o turno acabar ou pare a conversa`)
        return removeRepository(this.deps.projects.folderOf(id), name).catch((error: unknown) => Promise.reject(setupFailure(error)))
      },
      { message: 'Repository removed' },
    )
  }

  async list(_req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const caller = await this.caller()
      return this.deps.projects.list(caller).map((project) => this.toDto(project, this.deps.projects.roleOf(project.id, caller.userId)))
    })
  }

  async create(req: Request, res: Response): Promise<void> {
    await this.respond(
      res,
      async () => {
        const by = await this.requireAdmin('createProject')
        const creator = (await this.caller()).userId
        return this.toDto(this.deps.projects.create(parseBody(createSchema, req.body), by, 'api', creator), 'admin')
      },
      { status: 201, message: 'Project created' },
    )
  }

  async update(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      // O nome e a descrição: o admin do projeto (o do gateway só se for admin dele).
      const by = await requireProjectAdmin(this.deps.proof, req.params.id as string, 'updateProject')
      return this.toDto(this.deps.projects.update(req.params.id as string, parseBody(updateSchema, req.body), by), 'admin')
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
      await this.requireMembersAdmin(req.params.id as string, 'listProjectMembers')
      return this.deps.projects.members(req.params.id as string)
    })
  }

  /** A lista INTEIRA de membros (quem não está nela sai). */
  async setMembers(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const by = await this.requireMembersAdmin(req.params.id as string, 'setProjectMembers')
      const body = parseBody(membersSchema, req.body)
      return this.deps.projects.setMembers(req.params.id as string, body.members ?? body.userIds ?? [], by)
    })
  }

  /** O papel de quem pede vai junto (a tela libera o que o projeto deixa). ⛔ A pasta (caminho no servidor) só para o admin dele. */
  private toDto(project: IProject, role: TProjectRole | undefined) {
    const admin = role === 'admin'
    return {
      id: project.id,
      name: project.name,
      ...(role ? { role } : {}),
      ...(project.description ? { description: project.description } : {}),
      ...(admin ? { folder: this.deps.projects.folderOf(project.id), members: this.deps.projects.members(project.id).length } : {}),
      // As fixas e os valores visíveis dos MCPs são configuração de quem administra: o membro não lê.
      ...(admin ? { env: project.env ?? {}, mcpEnv: project.mcpEnv ?? [] } : {}),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      ...(admin && project.updatedBy ? { updatedBy: project.updatedBy } : {}),
    }
  }

  /** A lista como a tela a lê: o que está sendo clonado entra com `cloning` (a pasta ainda não é um repositório inteiro). */
  private repositoriesOf(projectId: string): TRepositoryDto[] {
    const folder = this.deps.projects.folderOf(projectId)
    const setup = repositoriesInSetup(folder)
    const ready: TRepositoryDto[] = listRepositories(folder).filter((item) => !setup.includes(item.name))
    return [...ready, ...setup.map((name) => ({ name, cloning: true, worktrees: [] }))].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** ⛔ A conta tem de ser deste projeto e do git; o problema dela (segredo ausente) sai no campo, sem o segredo. */
  private async gitCredentials(projectId: string, accountId: string): Promise<{ env: Record<string, string>; host?: string }> {
    let credentials: { env: Record<string, string>; host?: string } | undefined
    try {
      credentials = await this.deps.gitCredentials?.(projectId, accountId)
    } catch (error: unknown) {
      throw invalid('account', `account: ${error instanceof Error ? error.message : 'a conta não pôde ser usada'}`)
    }
    if (!credentials) throw invalid('account', 'account: escolha uma conta de git deste projeto (GitHub ou Git por https)')
    return credentials
  }

  private async caller(): Promise<IProjectCaller> {
    const resolved = await resolveCaller(this.deps.proof)
    if (!resolved) throw new HttpError(401, 'unauthorized', 'Missing or unverifiable caller credential')
    return { userId: resolved.identity?.id, admin: (await checkAdminAccess(this.deps.proof)).allowed }
  }

  /** Os membros: o administrador do gateway (o resgate) ou o administrador DESTE projeto; os demais, 404. */
  private async requireMembersAdmin(projectId: string, operation: string): Promise<string> {
    const access = await checkAdminAccess(this.deps.proof)
    if (access.allowed) return access.identity?.email ?? access.identity?.id ?? 'admin'
    return this.requireProjectRole(projectId, operation)
  }

  /**
   * Só quem tem o papel de administrador DESTE projeto; os demais, 404 (como projeto inexistente) — o administrador do
   * gateway também: para entrar, põe-se nos membros. ⚖️ Não passa pela trava do projeto conectado: o repositório é a
   * cópia de trabalho desta máquina, não o catálogo que vem da origem.
   */
  private async requireProjectRole(projectId: string, operation: string): Promise<string> {
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
