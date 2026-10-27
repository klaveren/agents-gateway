import { Request, Response } from 'express'
import { z } from 'zod'
import { GuidanceService } from '@application/Guidance.Service'
import { DOC_KINDS, TDocKind } from '@domain/models/ProjectDoc.Model'
import { TGuidanceScope } from '@domain/ports/GuidanceRepository.Port'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'

export interface IGuidanceControllerDeps {
  guidance: GuidanceService
  proof?: ICallerProof
}

const project = z.string().max(64).nullable().optional()
const ruleSchema = z.object({ projectId: project, title: z.string().max(400).optional(), body: z.string().max(20_000).optional(), enabled: z.boolean().optional() })
const moveSchema = z.object({ direction: z.enum(['up', 'down']) })
const docSchema = z.object({
  id: z.string().max(80).optional(),
  kind: z.enum(DOC_KINDS as [TDocKind, ...TDocKind[]]).optional(),
  projectId: project,
  title: z.string().max(400).optional(),
  summary: z.string().max(1_000).optional(),
  body: z.string().max(400_000).optional(),
})

/**
 * As rules e os documentos (specs e ADRs). ⛔ TUDO de admin, até a leitura: quem só conversa nem sabe que
 * existem (404, como `/projects`). A conversa os recebe pelo prompt e pelo `read_doc`, não por aqui.
 */
export class GuidanceController {
  constructor(private readonly deps: IGuidanceControllerDeps) {
    for (const name of ['listRules', 'createRule', 'updateRule', 'deleteRule', 'moveRule', 'listDocs', 'getDoc', 'createDoc', 'updateDoc', 'deleteDoc'] as const)
      this[name] = this[name].bind(this)
  }

  async listRules(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('listRules')
      return this.deps.guidance.rules(scopeOf(req))
    })
  }

  async createRule(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => this.deps.guidance.createRule(parseBody(ruleSchema, req.body), await this.requireAdmin('createRule')), {
      status: 201,
      message: 'Rule created',
    })
  }

  async updateRule(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => this.deps.guidance.updateRule(req.params.id as string, parseBody(ruleSchema, req.body), await this.requireAdmin('updateRule')))
  }

  async deleteRule(req: Request, res: Response): Promise<void> {
    await this.respond(
      res,
      async () => {
        await this.requireAdmin('deleteRule')
        this.deps.guidance.deleteRule(req.params.id as string)
        return null
      },
      { message: 'Rule deleted' },
    )
  }

  /** Devolve a lista do escopo já na ordem nova. */
  async moveRule(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const by = await this.requireAdmin('moveRule')
      return this.deps.guidance.moveRule(req.params.id as string, parseBody(moveSchema, req.body).direction, by)
    })
  }

  /** A lista vai sem o corpo: o editor busca o documento inteiro (`GET /docs/:id`). */
  async listDocs(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('listDocs')
      const kind = typeof req.query.kind === 'string' && (DOC_KINDS as readonly string[]).includes(req.query.kind) ? (req.query.kind as TDocKind) : undefined
      return this.deps.guidance.docs(scopeOf(req), kind).map(({ body: _body, ...doc }) => doc)
    })
  }

  async getDoc(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('getDoc')
      return this.deps.guidance.doc(req.params.id as string)
    })
  }

  async createDoc(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => this.deps.guidance.createDoc(parseBody(docSchema, req.body), await this.requireAdmin('createDoc')), {
      status: 201,
      message: 'Document created',
    })
  }

  async updateDoc(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { id: _id, ...change } = parseBody(docSchema, req.body)
      return this.deps.guidance.updateDoc(req.params.id as string, change, await this.requireAdmin('updateDoc'))
    })
  }

  async deleteDoc(req: Request, res: Response): Promise<void> {
    await this.respond(
      res,
      async () => {
        await this.requireAdmin('deleteDoc')
        this.deps.guidance.deleteDoc(req.params.id as string)
        return null
      },
      { message: 'Document deleted' },
    )
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
      if (failure.status >= 500) console.error('[GuidanceController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}

/** `?project=<id>` ou, ausente ou `global`, o escopo global. */
function scopeOf(req: Request): TGuidanceScope {
  const value = typeof req.query.project === 'string' ? req.query.project.trim() : ''
  return value && value !== 'global' ? value : null
}
