import { Request, Response } from 'express'
import { z } from 'zod'
import type { ProjectConnectionService } from '@application/ProjectConnection.Service'
import { hasUpdate, IProjectConnection } from '@domain/models/ProjectConnection.Model'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { adminView, administers, requireGatewayAdmin, requireProjectAdmin } from './Project.Access'
import { parseBody } from './Request.Parser'

export interface IProjectConnectionsControllerDeps {
  /** Ausente (o servidor de teste sem banco): as rotas respondem 404. */
  connections?: ProjectConnectionService
  proof?: ICallerProof
}

const connectSchema = z.object({ url: z.string().min(1).max(500), projectId: z.string().min(1).max(64), token: z.string().min(1).max(200) })
const tokenSchema = z.object({ token: z.string().min(1).max(200) })
const modelsSchema = z.object({ map: z.record(z.string().max(300), z.string().max(300)) })

/**
 * 🔌 OS PROJETOS CONECTADOS, do lado do dev (`/connections`): conectar um projeto de outro gateway, o aviso de
 * atualização, atualizar, trocar o token, o mapa de modelos e desconectar.
 *
 * ⛔ Conectar cria um projeto: só o admin do gateway. O resto, o admin do projeto (o do gateway só se for admin dele).
 * O token nunca volta: a resposta diz só o estado.
 */
export class ProjectConnectionsController {
  constructor(private readonly deps: IProjectConnectionsControllerDeps) {
    for (const name of ['list', 'connect', 'get', 'check', 'sync', 'replaceToken', 'setModels', 'disconnect'] as const) this[name] = this[name].bind(this)
  }

  /** `GET /connections` — as conexões dos projetos que a pessoa administra (o aviso da tela). */
  async list(_req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const view = await adminView(this.deps.proof)
      if (!view) return []
      return this.service()
        .list()
        .filter((connection) => administers(view, connection.projectId))
        .map(toDto)
    })
  }

  /** `POST /connections` — conecta: confere o token na origem, cria o projeto e traz a última versão. */
  async connect(req: Request, res: Response): Promise<void> {
    await this.respond(
      res,
      async () => {
        const by = await requireGatewayAdmin(this.deps.proof, 'connectProject')
        const view = await adminView(this.deps.proof)
        const connection = await this.service().connect(parseBody(connectSchema, req.body), { email: by, ...(view?.userId ? { userId: view.userId } : {}) })
        this.service().follow(connection.projectId)
        return toDto(connection)
      },
      201,
    )
  }

  async get(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => toDto(await this.owned(req, 'getConnection')))
  }

  /** `POST /connections/:projectId/check` — pergunta à origem agora (sem esperar o vigia). */
  async check(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { projectId } = await this.owned(req, 'checkConnection')
      return toDto(await this.service().check(projectId))
    })
  }

  /** `POST /connections/:projectId/sync` — atualiza para a ÚLTIMA versão, em espelho. */
  async sync(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const connection = await this.owned(req, 'syncConnection')
      const by = await requireProjectAdmin(this.deps.proof, connection.projectId, 'syncConnection')
      const result = await this.service().sync(connection.projectId, by)
      return { result, connection: toDto(this.service().get(connection.projectId)!) }
    })
  }

  async replaceToken(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { projectId } = await this.owned(req, 'replaceConnectionToken')
      return toDto(await this.service().replaceToken(projectId, parseBody(tokenSchema, req.body).token))
    })
  }

  async setModels(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { projectId } = await this.owned(req, 'setConnectionModels')
      return toDto(this.service().setModelMap(projectId, parseBody(modelsSchema, req.body).map))
    })
  }

  /** `DELETE /connections/:projectId` — o projeto fica, como um projeto comum daqui; o token é esquecido. */
  async disconnect(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { projectId } = await this.owned(req, 'disconnectProject')
      this.service().disconnect(projectId)
      return null
    })
  }

  /** ⛔ A conexão de um projeto que a pessoa administra; o resto ouve 404, como inexistente. */
  private async owned(req: Request, operation: string): Promise<IProjectConnection> {
    const projectId = String(req.params.projectId ?? '')
    await requireProjectAdmin(this.deps.proof, projectId, operation)
    const connection = this.service().get(projectId)
    if (!connection) throw new HttpError(404, 'not_found', `${projectId} is not a connected project`)
    return connection
  }

  private service(): ProjectConnectionService {
    if (!this.deps.connections) throw new HttpError(404, 'not_found', 'Connections are not enabled')
    return this.deps.connections
  }

  private async respond<T>(res: Response, work: () => Promise<T>, status = 200) {
    try {
      res.status(status).json(ok(await work()))
    } catch (error: unknown) {
      const failure = toHttpFailure(error)
      if (failure.status >= 500 && failure.status !== 502) console.error('[ProjectConnectionsController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}

function toDto(connection: IProjectConnection) {
  return { ...connection, updateAvailable: hasUpdate(connection) }
}
