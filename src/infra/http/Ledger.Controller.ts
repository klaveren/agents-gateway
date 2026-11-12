import { Request, Response } from 'express'
import { z } from 'zod'
import { LedgerService } from '@application/Ledger.Service'
import { InvalidLedgerError } from '@domain/errors/Domain.Error'
import { playbookIssues } from '@domain/Ledger.Policy'
import { ILedgerWrite, TLedgerAuthor } from '@domain/models/Ledger.Model'
import { tarGz } from '@infra/catalog/Tar.Archive'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { requireAgentAdmin, requireProjectAdmin } from './Project.Access'
import { ledgerOwnerKey } from '@domain/models/Ledger.Model'
import { parseBody } from './Request.Parser'

export interface ILedgerControllerDeps {
  /** Ausente (o servidor de teste sem banco): as rotas respondem 404. */
  service?: LedgerService
  proof?: ICallerProof
}

// ⚖️ Só o formato de fora: as regras (gatilho com substância, uma linha, tamanho) são as do `Ledger.Policy`, as mesmas da ferramenta.
const contextSchema = z.object({ topic: z.string().max(200), trigger: z.string().max(2000), playbook: z.string().max(50_000).optional() })
const contextChangeSchema = z.object({ trigger: z.string().max(2000).optional(), playbook: z.string().max(50_000).optional() })
const lineFields = {
  type: z.string().max(40),
  trigger: z.string().max(2000),
  learning: z.string().max(2000),
  ref: z.string().max(2000).optional(),
  date: z.string().max(20).optional(),
}
const lineSchema = z.object(lineFields)
const lineChangeSchema = z.object(lineFields).partial()

/**
 * O LEDGER DOS AGENTES na tela (a guia Memória do agente). Tudo só admin do projeto do agente (o agente global, o do gateway; 404 para os demais).
 *
 * ⚖️ A edição do admin passa pela MESMA regra e pelo mesmo serviço da ferramenta `ledger_write`, e vira revisão com o
 * admin como autor. Toda escrita devolve o contexto e o índice de depois: a tela troca o que mostra sem reler.
 */
export class LedgerController {
  constructor(private readonly deps: ILedgerControllerDeps) {
    for (const name of [
      'index',
      'search',
      'exportLedger',
      'createContext',
      'context',
      'updateContext',
      'deleteContext',
      'revisions',
      'addLine',
      'updateLine',
      'deleteLine',
    ] as const)
      this[name] = this[name].bind(this)
  }

  /** `GET /agents/:agentId/ledger` — os contextos (sem o conteúdo), a contagem de linhas e os avisos de saúde. */
  async index(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service, agentId } = await this.admin(req, 'getLedger')
      return service.index(agentId)
    })
  }

  /** `GET /agents/:agentId/ledger/search?q=` — as linhas e os contextos que casam com todas as palavras. */
  async search(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service, agentId } = await this.admin(req, 'searchLedger')
      const query = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : ''
      return service.search(agentId, query)
    })
  }

  /** `GET /agents/:agentId/ledger/contexts/:topic` — o contexto inteiro: gatilho, playbook e linhas. */
  async context(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service, agentId } = await this.admin(req, 'getLedgerContext')
      return service.context(agentId, req.params.topic as string)
    })
  }

  /** `GET /agents/:agentId/ledger/contexts/:topic/revisions` — as mudanças do tema (também as de antes de uma exclusão). */
  async revisions(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service, agentId } = await this.admin(req, 'getLedgerRevisions')
      return service.revisions(agentId, req.params.topic as string)
    })
  }

  /** `POST /agents/:agentId/ledger/contexts { topic, trigger, playbook? }` */
  async createContext(req: Request, res: Response): Promise<void> {
    await this.respond(
      res,
      async () => {
        const { service, agentId, by } = await this.admin(req, 'createLedgerContext')
        const body = parseBody(contextSchema, req.body)
        return service.write(agentId, { action: 'criar', topic: body.topic, trigger: body.trigger, ...(body.playbook !== undefined ? { playbook: body.playbook } : {}) }, by)
      },
      201,
    )
  }

  /** `PUT /agents/:agentId/ledger/contexts/:topic { trigger?, playbook? }` — uma revisão por campo que mudou. */
  async updateContext(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service, agentId, by } = await this.admin(req, 'updateLedgerContext')
      const body = parseBody(contextChangeSchema, req.body)
      const topic = req.params.topic as string
      if (body.trigger === undefined && body.playbook === undefined) throw new InvalidLedgerError([{ field: 'trigger', message: 'nothing to change: send trigger or playbook' }])
      // O playbook conferido ANTES do gatilho gravar: um campo inválido não deixa o outro pela metade.
      const problems = playbookIssues(body.playbook)
      if (problems.length) throw new InvalidLedgerError(problems)
      let result = body.trigger !== undefined ? service.write(agentId, { action: 'gatilho', topic, trigger: body.trigger }, by) : undefined
      if (body.playbook !== undefined) {
        const playbook = service.write(agentId, { action: 'playbook', topic, playbook: body.playbook }, by)
        result = { ...playbook, changed: playbook.changed || !!result?.changed }
      }
      return result
    })
  }

  /** `DELETE /agents/:agentId/ledger/contexts/:topic` — o contexto e as linhas dele (a revisão guarda o que saiu). */
  async deleteContext(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service, agentId, by } = await this.admin(req, 'deleteLedgerContext')
      return service.write(agentId, { action: 'excluir', topic: req.params.topic as string }, by)
    })
  }

  /** `POST /agents/:agentId/ledger/contexts/:topic/lines { type, trigger, learning, ref?, date? }` */
  async addLine(req: Request, res: Response): Promise<void> {
    await this.respond(
      res,
      async () => {
        const { service, agentId, by } = await this.admin(req, 'addLedgerLine')
        const line = parseBody(lineSchema, req.body) as NonNullable<ILedgerWrite['line']>
        return service.write(agentId, { action: 'linha_nova', topic: req.params.topic as string, line }, by)
      },
      201,
    )
  }

  /** `PUT /agents/:agentId/ledger/contexts/:topic/lines/:lineId` — só os campos que vieram. */
  async updateLine(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service, agentId, by } = await this.admin(req, 'updateLedgerLine')
      const line = parseBody(lineChangeSchema, req.body) as NonNullable<ILedgerWrite['line']>
      return service.write(agentId, { action: 'linha_editar', topic: req.params.topic as string, lineId: lineIdOf(req), line }, by)
    })
  }

  /** `DELETE /agents/:agentId/ledger/contexts/:topic/lines/:lineId` */
  async deleteLine(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service, agentId, by } = await this.admin(req, 'deleteLedgerLine')
      return service.write(agentId, { action: 'linha_apagar', topic: req.params.topic as string, lineId: lineIdOf(req) }, by)
    })
  }

  /**
   * `GET /agents/:agentId/ledger/export?format=tar|json` — o formato das pastas antigas: `<agente>-ledger/index.md` e
   * `contextos/<tema>.md` (com o `@trigger` no stamp). `tar` (o padrão) devolve um `.tar.gz`; `json`, `{ files }`.
   */
  async exportLedger(req: Request, res: Response): Promise<void> {
    try {
      const { service, agentId } = await this.admin(req, 'exportLedger')
      const format = req.query.format === undefined ? 'tar' : req.query.format
      if (format !== 'tar' && format !== 'json') throw new HttpError(422, 'validation_error', 'Invalid format: expected tar or json')
      const files = service.exportFiles(agentId)
      if (format === 'json') {
        res.status(200).json(ok({ files }))
        return
      }
      const now = new Date()
      const archive = tarGz(
        Object.entries(files).map(([path, content]) => ({ path, content })),
        now,
      )
      res
        .status(200)
        .set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${agentId}-ledger-${now.toISOString().slice(0, 10)}.tar.gz"` })
        .send(archive)
    } catch (error: unknown) {
      this.failed(res, error)
    }
  }

  /** ⛔ Só o admin do projeto do agente (o agente global, o do gateway); o agente da rota tem de existir. O autor das revisões é o admin. */
  private async admin(req: Request, operation: string): Promise<{ service: LedgerService; agentId: string; by: TLedgerAuthor }> {
    const id = req.params.agentId as string
    // ⚖️ `?project=`: o ledger do agente GLOBAL naquele projeto (quem mexe é o admin do projeto); sem ele, a base.
    const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined
    const email = project ? await requireProjectAdmin(this.deps.proof, project, operation) : await requireAgentAdmin(this.deps.proof, id, operation)
    if (!this.deps.service) throw new HttpError(404, 'not_found', 'Not found')
    const agentId = project ? ledgerOwnerKey(id, project) : id
    this.deps.service.requireAgent(agentId)
    return { service: this.deps.service, agentId, by: { kind: 'admin', email } }
  }

  private async respond<T>(res: Response, work: () => Promise<T>, status = 200) {
    try {
      res.status(status).json(ok(await work()))
    } catch (error: unknown) {
      this.failed(res, error)
    }
  }

  private failed(res: Response, error: unknown): void {
    const failure = toHttpFailure(error)
    if (failure.status >= 500) console.error('[LedgerController] Error:', failure.message)
    res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
  }
}

function lineIdOf(req: Request): number {
  const raw = req.params.lineId as string
  if (!/^\d+$/.test(raw)) throw new HttpError(404, 'not_found', `Ledger line not found: ${raw}`)
  return Number(raw)
}
