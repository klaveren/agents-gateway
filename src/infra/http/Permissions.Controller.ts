import { Request, Response } from 'express'
import { z } from 'zod'
import { PermissionsService } from '@application/Permissions.Service'
import { IPermissionSubject, PERMISSION_CATEGORIES, SYSTEM_RULES, TPermissionCategory } from '@domain/Permission.Policy'
import { analyzeShell } from '@infra/permissions/Shell.Parse'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'

export interface IPermissionsControllerDeps {
  permissions: PermissionsService
  projectExists: (projectId: string) => boolean
  agentExists: (agentId: string) => boolean
  /** As regras de sistema da instalação (a pasta de dados), para a tela mostrar o piso inteiro. */
  installationRules: () => ReturnType<PermissionsService['projectRules']>['rules']
  proof?: ICallerProof
}

const ruleSchema = z.object({
  category: z.enum(PERMISSION_CATEGORIES as [TPermissionCategory, ...TPermissionCategory[]]),
  pattern: z.string().trim().min(1).max(300),
  decision: z.enum(['allow', 'deny']),
  note: z.string().max(200).optional(),
})
const saveSchema = z.object({ rules: z.array(ruleSchema).max(300) })
const testSchema = z.object({
  agentId: z.string().max(64).optional(),
  category: z.enum(PERMISSION_CATEGORIES as [TPermissionCategory, ...TPermissionCategory[]]),
  value: z.string().min(1).max(4000),
})

/**
 * As permissões de um projeto (só admin; 404 para os demais): as regras, o testador e as últimas decisões. As do agente
 * vêm no cadastro dele (`permissions`).
 */
export class PermissionsController {
  constructor(private readonly deps: IPermissionsControllerDeps) {
    for (const name of ['get', 'save', 'test', 'decisions'] as const) this[name] = this[name].bind(this)
  }

  async get(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const projectId = await this.project(req, 'getPermissions')
      const stored = this.deps.permissions.projectRules(projectId)
      return { projectId, ...stored, system: [...SYSTEM_RULES, ...this.deps.installationRules()] }
    })
  }

  async save(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { projectId, by } = await this.admin(req, 'savePermissions')
      const { rules } = parseBody(saveSchema, req.body)
      const saved = this.deps.permissions.saveProjectRules(projectId, rules, by)
      return { projectId, rules: saved }
    })
  }

  /**
   * O testador: a decisão para um pedido, sem registrar. Comando é analisado como o terminal analisa — cada parte, e os
   * redirecionamentos como leitura ou escrita — e a resposta diz o que decidiu cada uma.
   */
  async test(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const projectId = await this.project(req, 'testPermissions')
      const body = parseBody(testSchema, req.body)
      if (body.agentId && !this.deps.agentExists(body.agentId)) throw new HttpError(404, 'not_found', `Agent not found: ${body.agentId}`)
      const asker = { projectId, ...(body.agentId ? { agentId: body.agentId } : {}) }
      if (body.category !== 'terminal') {
        const verdict = this.deps.permissions.test(asker, { category: body.category, value: body.value.trim() })
        return { allowed: verdict.allowed, parts: [{ category: body.category, value: body.value.trim(), ...verdict }] }
      }
      const analysis = await analyzeShell(body.value)
      const subjects: IPermissionSubject[] = [
        ...analysis.commands.map((command) => ({ category: 'terminal' as const, value: command.text, argv: command.argv })),
        ...analysis.redirects.map((redirect) => ({ category: redirect.kind, value: redirect.target })),
      ]
      const parts = subjects.map((subject) => ({ category: subject.category, value: subject.value, ...this.deps.permissions.test(asker, subject) }))
      const opaque = analysis.opaque.map((reason) => ({
        category: 'terminal' as const,
        value: reason,
        allowed: false,
        layer: 'system' as const,
        reason: `não dá para analisar com segurança (${reason})`,
      }))
      const all = [...parts, ...opaque]
      return { allowed: all.length > 0 && all.every((part) => part.allowed), parts: all }
    })
  }

  async decisions(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const projectId = await this.project(req, 'listPermissionDecisions')
      const agentId = typeof req.query.agentId === 'string' && req.query.agentId ? req.query.agentId : undefined
      return this.deps.permissions.decisions(projectId, { ...(agentId ? { agentId } : {}), limit: 200 })
    })
  }

  /** O projeto da rota, depois de provar que quem chama é admin — e quem é (para o `updatedBy`). */
  private async project(req: Request, operation: string): Promise<string> {
    return (await this.admin(req, operation)).projectId
  }

  private async admin(req: Request, operation: string): Promise<{ projectId: string; by: string }> {
    const access = await checkAdminAccess(this.deps.proof)
    if (!access.allowed) {
      console.warn(`[admin] acesso negado a ${operation}:`, access.reason)
      throw new HttpError(404, 'not_found', 'Not found')
    }
    const projectId = req.params.projectId as string
    if (!this.deps.projectExists(projectId)) throw new HttpError(404, 'not_found', `Project not found: ${projectId}`)
    return { projectId, by: access.identity?.email ?? access.identity?.id ?? 'admin' }
  }

  private async respond<T>(res: Response, work: () => Promise<T>) {
    try {
      res.status(200).json(ok(await work()))
    } catch (error: unknown) {
      const failure = toHttpFailure(error)
      if (failure.status >= 500) console.error('[PermissionsController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}
