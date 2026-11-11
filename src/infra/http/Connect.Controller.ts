import { Request, Response } from 'express'
import type { ConnectService } from '@application/Connect.Service'
import type { ICatalogEvents } from '@domain/ports/CatalogEvents.Port'
import { CALLER_HEADER } from './Security.Middleware'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { SseStream } from './Sse.Stream'

/** Quem está conectado: a conta dona do token e o projeto dele. */
export interface IConnection {
  tokenId: string
  userId: string
  email: string
  projectId: string
}

export interface IConnectControllerDeps {
  /** Ausente (o servidor de teste sem banco): as rotas respondem 404. */
  connect?: ConnectService
  /** O token de conexão → a conta e o projeto (`AccessTokensService.connection`). */
  connection?: (raw: string) => IConnection | undefined
  /** O papel da conta no projeto: sem papel, a conta saiu do projeto e o token deixa de valer. */
  projectRole?: (projectId: string, userId: string) => string | undefined
  events?: ICatalogEvents
}

const SHA256 = /^[a-f0-9]{64}$/
/** Quantos streams de aviso um token mantém abertos (o vigia reconecta; mais que isso é laço). */
const STREAMS_PER_TOKEN = 3

/**
 * 🔌 AS ROTAS DA ORIGEM (`/connect/:projectId/*`): o gateway de um dev, com o token de conexão (`agc_`), lê o catálogo do
 * projeto, a versão e o aviso de mudança.
 *
 * ⛔ PORTÃO PRÓPRIO: o token de conexão não vira sessão e não passa pelo portão de sempre — vale só aqui, só para o
 * projeto dele, e só enquanto a conta for do projeto. Projeto de outro token, ou conta que saiu, ouve 404.
 */
export class ConnectController {
  private readonly streams = new Map<string, number>()

  constructor(private readonly deps: IConnectControllerDeps) {
    for (const name of ['version', 'events', 'catalogPackage', 'file'] as const) this[name] = this[name].bind(this)
  }

  /** `GET /connect/:projectId/version` — a versão do catálogo do projeto. */
  async version(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { connect, connection } = this.gate(req)
      return connect.version(connection.projectId)
    })
  }

  /** `GET /connect/:projectId/package?since=N` — o catálogo inteiro, os arquivos citados, as variáveis e o que mudou desde N. */
  async catalogPackage(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { connect, connection } = this.gate(req)
      const raw = (req.query as Record<string, unknown>).since
      const since = raw === undefined ? undefined : Number(raw)
      if (since !== undefined && (!Number.isInteger(since) || since < 0)) throw new HttpError(400, 'validation_error', 'since must be a non-negative integer')
      return connect.package(connection.projectId, connection.email, since)
    })
  }

  /** `GET /connect/:projectId/files/:sha256` — um arquivo de recurso citado pelo projeto, em base64. */
  async file(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { connect, connection } = this.gate(req)
      const sha256 = String(req.params.sha256 ?? '')
      const content = SHA256.test(sha256) ? connect.file(connection.projectId, sha256) : undefined
      if (!content) throw new HttpError(404, 'not_found', `File not found: ${sha256}`)
      return { sha256, bytes: content.length, base64: content.toString('base64') }
    })
  }

  /** `GET /connect/:projectId/events` — SSE: `catalog.version` com a versão a cada mudança do projeto (e uma ao abrir). */
  async events(req: Request, res: Response): Promise<void> {
    let gate: ReturnType<ConnectController['gate']>
    try {
      gate = this.gate(req)
    } catch (error: unknown) {
      return this.failed(res, error)
    }
    const { connect, connection } = gate
    const open = this.streams.get(connection.tokenId) ?? 0
    if (open >= STREAMS_PER_TOKEN) return this.failed(res, new HttpError(429, 'rate_limited', 'Too many open event streams'))
    this.streams.set(connection.tokenId, open + 1)

    const stream = new SseStream(res)
    stream.open()
    let last = connect.version(connection.projectId).version
    stream.emit('catalog.version', { version: last })
    const unsubscribe =
      this.deps.events?.subscribe((changes) => {
        if (!changes.some((change) => change.projectId === connection.projectId && change.kind !== 'permission-request')) return
        // ⛔ A conta que saiu do projeto para de ouvir na mudança seguinte.
        if (!this.deps.projectRole?.(connection.projectId, connection.userId)) return stream.close()
        const { version } = connect.version(connection.projectId)
        if (version === last) return
        last = version
        stream.emit('catalog.version', { version })
      }) ?? (() => undefined)
    // Em `res`, não em `req` (ver `AgentController.sendMessageAsStream`).
    res.on('close', () => {
      unsubscribe()
      stream.close()
      const count = (this.streams.get(connection.tokenId) ?? 1) - 1
      if (count > 0) this.streams.set(connection.tokenId, count)
      else this.streams.delete(connection.tokenId)
    })
  }

  /** ⛔ O token de conexão, o projeto DELE na rota e a conta ainda no projeto. */
  private gate(req: Request): { connect: ConnectService; connection: IConnection } {
    const connect = this.deps.connect
    if (!connect || !this.deps.connection) throw new HttpError(404, 'not_found', 'Connections are not enabled')
    const header = req.headers[CALLER_HEADER] ?? req.headers.authorization
    const raw = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : ''
    const connection = raw ? this.deps.connection(raw) : undefined
    if (!connection) throw new HttpError(401, 'unauthorized', 'Connection token is invalid, expired or revoked')
    const projectId = String(req.params.projectId ?? '')
    if (projectId !== connection.projectId || !this.deps.projectRole?.(projectId, connection.userId)) throw new HttpError(404, 'not_found', `Project not found: ${projectId}`)
    return { connect, connection }
  }

  private async respond<T>(res: Response, work: () => Promise<T>) {
    try {
      res.status(200).json(ok(await work()))
    } catch (error: unknown) {
      this.failed(res, error)
    }
  }

  private failed(res: Response, error: unknown): void {
    const failure = toHttpFailure(error)
    if (failure.status >= 500) console.error('[ConnectController] Error:', failure.message)
    res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
  }
}
