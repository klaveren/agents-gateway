import { Request, Response } from 'express'
import type { ConnectService } from '@application/Connect.Service'
import type { ICatalogEvents } from '@domain/ports/CatalogEvents.Port'
import type { ILedgerWrite } from '@domain/models/Ledger.Model'
import { REMOTE_USAGE_MAX_ROWS } from '@domain/models/RemoteUsage.Model'
import { messageKeyOf, type IPersonMessage, type IPersonThread } from '@domain/models/PersonMessage.Model'
import { PersonMessageError, type PersonMessagesService } from '@application/PersonMessages.Service'
import { CALLER_HEADER } from './Security.Middleware'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { SseStream } from './Sse.Stream'
import { parseBody, replyToOf } from './Request.Parser'
import { z } from 'zod'

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
  /** 💬 As mensagens da conta da conexão, só as do projeto dela (ausente: as rotas de mensagens respondem 404). */
  messages?: PersonMessagesService
  /** A resposta pela caixa, a mesma da rota normal (`AgentController.replyAs`). */
  reply?: (input: { recipientId: string; key: string; text: string; replyTo?: string; authorName: string }) => Promise<{ queued: boolean }>
  /** O nome da conta (para assinar a resposta); sem ele, o e-mail. */
  accountName?: (userId: string) => string | undefined
}

const SHA256 = /^[a-f0-9]{64}$/
/** Só o formato: as regras (tema, gatilho, linha) são as do `Ledger.Policy`, as mesmas da ferramenta. */
const ledgerWriteSchema = z.object({
  change: z.object({
    action: z.string().max(40),
    topic: z.string().max(200),
    trigger: z.string().max(2000).optional(),
    playbook: z.string().max(50_000).optional(),
    lineId: z.number().int().optional(),
    line: z.record(z.string(), z.string().max(2000)).optional(),
  }),
  conversationId: z.string().max(200).optional(),
}) as unknown as z.ZodType<{ change: ILedgerWrite; conversationId?: string }>
const tokens = z.number().int().min(0).optional()
const usageSchema = z.object({
  rows: z
    .array(
      z.object({
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        conversationId: z.string().min(1).max(200),
        agentId: z.string().min(1).max(200),
        provider: z.string().min(1).max(100),
        model: z.string().min(1).max(200),
        turns: z.number().int().min(0),
        usage: z.object({ inputTokens: tokens, outputTokens: tokens, reasoningTokens: tokens, totalTokens: tokens, cacheReadTokens: tokens, cacheWriteTokens: tokens }),
      }),
    )
    .max(REMOTE_USAGE_MAX_ROWS),
})
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
    for (const name of [
      'version',
      'changes',
      'events',
      'catalogPackage',
      'file',
      'ledgerIndex',
      'ledgerContext',
      'ledgerSearch',
      'ledgerWrite',
      'usage',
      'listMessages',
      'messageItem',
      'readMessage',
      'archiveMessage',
      'setMessageStatus',
      'replyMessage',
    ] as const)
      this[name] = this[name].bind(this)
  }

  /** `GET /connect/:projectId/version` — a versão do catálogo do projeto. */
  async version(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { connect, connection } = this.gate(req)
      return connect.version(connection.projectId)
    })
  }

  /** `GET /connect/:projectId/changes?since=N` — a versão e o que mudou desde N, uma linha por item (o aviso). */
  async changes(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { connect, connection } = this.gate(req)
      return connect.changes(connection.projectId, sinceOf(req) ?? 0)
    })
  }

  /** `GET /connect/:projectId/package?since=N` — o catálogo inteiro, os arquivos citados, as variáveis e o que mudou desde N. */
  async catalogPackage(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { connect, connection } = this.gate(req)
      return connect.package(connection.projectId, connection.email, sinceOf(req))
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
    // 💬 Só o PING (quantas não lidas) e a mensagem NOVA do agente deste projeto para esta conta — nada de outra conta nem projeto.
    const unwatch = this.deps.messages?.watch({
      changed: (recipientId) => {
        if (recipientId !== connection.userId) return
        if (!this.deps.projectRole?.(connection.projectId, connection.userId)) return stream.close()
        stream.emit('messages.changed', { unread: this.scoped(connection).unread })
      },
      sent: (message) => {
        if (message.recipientId !== connection.userId || message.from !== 'agent' || message.projectId !== connection.projectId) return
        stream.emit('message.new', {
          id: message.id,
          key: messageKeyOf(message),
          ...(message.title ? { title: message.title } : {}),
          body: message.body,
          level: message.level,
          agentId: message.agentId,
          conversationId: message.conversationId,
        })
      },
    })
    // Em `res`, não em `req` (ver `AgentController.sendMessageAsStream`).
    res.on('close', () => {
      unsubscribe()
      unwatch?.()
      stream.close()
      const count = (this.streams.get(connection.tokenId) ?? 1) - 1
      if (count > 0) this.streams.set(connection.tokenId, count)
      else this.streams.delete(connection.tokenId)
    })
  }

  /** `GET /connect/:projectId/ledger/:agentId` — o índice do ledger do agente e a seção dele no system prompt. */
  async ledgerIndex(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => this.ledgerOf(req).index())
  }

  /** `GET /connect/:projectId/ledger/:agentId/contexts/:topic` — um contexto inteiro. */
  async ledgerContext(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => this.ledgerOf(req).context(String(req.params.topic ?? '')))
  }

  /** `GET /connect/:projectId/ledger/:agentId/search?q=` — a busca nas linhas e nos contextos. */
  async ledgerSearch(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => this.ledgerOf(req).search(String((req.query as Record<string, unknown>).q ?? '')))
  }

  /** `POST /connect/:projectId/ledger/:agentId/write` — uma escrita, com o agente como autor e a conta da conexão no `via`. */
  async ledgerWrite(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { connection } = this.gate(req)
      const body = parseBody(ledgerWriteSchema, req.body)
      return this.ledgerOf(req).write(body.change, { via: connection.email, ...(body.conversationId ? { conversationId: body.conversationId } : {}) })
    })
  }

  /** `POST /connect/:projectId/usage` — o uso do gateway conectado neste projeto, por dia (reenviar substitui). */
  async usage(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { connect, connection } = this.gate(req)
      const { rows } = parseBody(usageSchema, req.body)
      return connect.receiveUsage(connection.projectId, { userId: connection.userId, email: connection.email }, rows)
    })
  }

  /** `GET /connect/:projectId/messages?archived=1` — 💬 os itens da conta neste projeto e os totais (só deste projeto). */
  async listMessages(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { connection } = this.gate(req)
      const archived = (req.query as Record<string, unknown>).archived === '1' || (req.query as Record<string, unknown>).archived === 'true'
      return this.scoped(connection, archived)
    })
  }

  /** `GET /connect/:projectId/messages/:key` — 💬 as mensagens de um item da conta (404 se for de outro projeto). */
  async messageItem(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { connection } = this.gate(req)
      return { messages: this.itemOf(connection, req) }
    })
  }

  /** `POST /connect/:projectId/messages/:key/read` — 💬 a conta abriu o item. */
  async readMessage(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { connection } = this.gate(req)
      this.itemOf(connection, req)
      this.messagesOf().markRead(connection.userId, String(req.params.key))
      return { unread: this.scoped(connection).unread }
    })
  }

  /** `PUT /connect/:projectId/messages/:key/archive { archived }` — 💬 arquiva (ou desarquiva) o item. */
  async archiveMessage(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { connection } = this.gate(req)
      this.itemOf(connection, req)
      this.messagesOf().setArchived(connection.userId, String(req.params.key), (req.body as { archived?: unknown } | undefined)?.archived !== false)
      return { unread: this.scoped(connection).unread }
    })
  }

  /** `PUT /connect/:projectId/messages/:key/:messageId/status { status }` — 📌 dá o pedido por tratado ou o reabre. */
  async setMessageStatus(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { connection } = this.gate(req)
      this.itemOf(connection, req)
      const status = (req.body as { status?: unknown } | undefined)?.status
      if (status !== 'resolved' && status !== 'pending')
        throw new HttpError(422, 'validation_error', 'status must be resolved or pending', [{ field: 'status', message: 'resolved or pending' }])
      try {
        this.messagesOf().setStatus(connection.userId, String(req.params.key), String(req.params.messageId), status)
      } catch (error: unknown) {
        if (!(error instanceof PersonMessageError)) throw error
        if (error.field) throw new HttpError(422, 'validation_error', error.message, [{ field: error.field, message: error.message }])
        throw new HttpError(404, 'not_found', 'Not found')
      }
      return { status, pending: this.scoped(connection).pending }
    })
  }

  /** `POST /connect/:projectId/messages/:key/reply { message, replyTo? }` — 💬 a resposta entra na conversa daqui, como na rota normal. */
  async replyMessage(req: Request, res: Response): Promise<void> {
    await this.respond(
      res,
      async () => {
        const { connection } = this.gate(req)
        this.itemOf(connection, req)
        if (!this.deps.reply) throw new HttpError(404, 'not_found', 'Not found')
        return this.deps.reply({
          recipientId: connection.userId,
          key: String(req.params.key),
          text: String((req.body as { message?: unknown } | undefined)?.message ?? ''),
          replyTo: replyToOf(req.body),
          authorName: this.deps.accountName?.(connection.userId) || connection.email,
        })
      },
      202,
    )
  }

  private messagesOf(): PersonMessagesService {
    if (!this.deps.messages) throw new HttpError(404, 'not_found', 'Not found')
    return this.deps.messages
  }

  /** ⛔ O ESCOPO: só mensagens da conta da conexão E deste projeto; qualquer outra coisa é 404 (não diz se existe). */
  private itemOf(connection: IConnection, req: Request): IPersonMessage[] {
    const messages = this.messagesOf().thread(connection.userId, String(req.params.key ?? ''))
    if (!messages.length || messages.some((message) => message.projectId !== connection.projectId)) throw new HttpError(404, 'not_found', 'Not found')
    return messages
  }

  /** Os itens da conta DESTE projeto, e o que há de não lido e pendente neles (as não arquivadas). */
  private scoped(connection: IConnection, archived = false): { threads: IPersonThread[]; unread: number; pending: number } {
    const service = this.messagesOf()
    const threads = service.threads(connection.userId, archived).filter((thread) => thread.projectId === connection.projectId)
    const open = archived ? service.threads(connection.userId, false).filter((thread) => thread.projectId === connection.projectId) : threads
    return {
      threads,
      unread: open.reduce((total, thread) => total + thread.unread, 0),
      pending: open.reduce((total, thread) => total + thread.pending, 0),
    }
  }

  private ledgerOf(req: Request) {
    const { connect, connection } = this.gate(req)
    return connect.ledger(connection.projectId, String(req.params.agentId ?? ''), this.deps.projectRole?.(connection.projectId, connection.userId))
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
    // ⚖️ 404 (não diz se o projeto existe), com o código da conexão: quem conecta distingue do "não achei" do ledger.
    if (projectId !== connection.projectId || !this.deps.projectRole?.(projectId, connection.userId))
      throw new HttpError(404, 'connection_unauthorized', `Project not found: ${projectId}`)
    return { connect, connection }
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
    if (failure.status >= 500) console.error('[ConnectController] Error:', failure.message)
    res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
  }
}

/** `?since=N`: a versão que quem pergunta tem (inteiro ≥ 0). */
function sinceOf(req: Request): number | undefined {
  const raw = (req.query as Record<string, unknown>).since
  if (raw === undefined) return undefined
  const since = Number(raw)
  if (!Number.isInteger(since) || since < 0) throw new HttpError(400, 'validation_error', 'since must be a non-negative integer')
  return since
}
