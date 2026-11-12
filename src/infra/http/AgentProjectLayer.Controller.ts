import { Request, Response } from 'express'
import { AgentProjectLayerService } from '@application/AgentProjectLayer.Service'
import { TAgentLocalLayerInput } from '@domain/models/AgentLocalLayer.Model'
import { viaAccessToken } from './Auth.Controller'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { requireProjectAdmin } from './Project.Access'
import { localSchema } from './ProjectConnections.Controller'
import { parseBody } from './Request.Parser'
import { viaSessionCookie } from './Session.Cookie'

export interface IAgentProjectLayerControllerDeps {
  layers?: AgentProjectLayerService
  proof?: ICallerProof
}

/**
 * `/projects/:projectId/agents/:agentId/layer` — a camada do projeto de um agente GLOBAL (ver `AgentProjectLayer.Service`).
 * Ler e gravar: o admin DO PROJETO (os demais ouvem 404).
 * ⛔ GRAVAR SÓ PELA TELA: a camada amplia o agente (ferramenta, MCP, delegação, modelo) — agente nenhum, nem token de
 * acesso, amplia um agente por aqui. 🔌 Num projeto conectado, a camada é desta máquina.
 */
export class AgentProjectLayerController {
  constructor(private readonly deps: IAgentProjectLayerControllerDeps) {
    for (const name of ['get', 'save', 'remove'] as const) this[name] = this[name].bind(this)
  }

  async get(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const projectId = String(req.params.projectId ?? '')
      await requireProjectAdmin(this.deps.proof, projectId, 'getAgentProjectLayer')
      return this.layers().get(projectId, String(req.params.agentId ?? ''))
    })
  }

  /** `PUT` — a camada inteira (vazia = apaga). A base do agente não muda. */
  async save(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const projectId = String(req.params.projectId ?? '')
      const by = await requireProjectAdmin(this.deps.proof, projectId, 'saveAgentProjectLayer')
      this.screenOnly(res)
      return this.layers().save(projectId, String(req.params.agentId ?? ''), parseBody(localSchema, req.body) as TAgentLocalLayerInput, by)
    })
  }

  /** `DELETE` — o agente volta a rodar no projeto como a base. */
  async remove(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const projectId = String(req.params.projectId ?? '')
      await requireProjectAdmin(this.deps.proof, projectId, 'removeAgentProjectLayer')
      this.screenOnly(res)
      return this.layers().remove(projectId, String(req.params.agentId ?? ''))
    })
  }

  private screenOnly(res: Response): void {
    if (!(viaSessionCookie(res) && !viaAccessToken(res))) throw new HttpError(403, 'forbidden', 'Só quem administra o projeto, entrando pela tela, muda a camada do agente.')
  }

  private layers(): AgentProjectLayerService {
    if (!this.deps.layers) throw new HttpError(404, 'not_found', 'Not found')
    return this.deps.layers
  }

  private async respond<T>(res: Response, work: () => Promise<T>) {
    try {
      res.status(200).json(ok(await work()))
    } catch (error: unknown) {
      const failure = toHttpFailure(error)
      if (failure.status >= 500) console.error('[AgentProjectLayerController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}
