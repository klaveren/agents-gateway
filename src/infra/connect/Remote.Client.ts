import type { ILedgerWrite } from '@domain/models/Ledger.Model'
import type { TRemoteUsageInput } from '@domain/models/RemoteUsage.Model'
import type { IPersonMessage, IPersonThread } from '@domain/models/PersonMessage.Model'
import {
  IRemoteCatalog,
  IRemoteChanges,
  IRemoteEventHandlers,
  IRemoteMessageNew,
  IRemoteLedger,
  IRemotePackage,
  RemoteRequestError,
  RemoteUnauthorizedError,
  RemoteUnavailableError,
} from '@domain/ports/RemoteCatalog.Port'

const TIMEOUT_MS = 30_000
/** Os campos de data das respostas do ledger: chegam como texto e voltam a ser `Date` (as ferramentas formatam). */
const DATE_KEYS = new Set(['createdAt', 'updatedAt', 'at', 'readAt', 'archivedAt', 'answeredAt'])
const PACKAGE_TIMEOUT_MS = 120_000
const MAX_EVENT_FRAME = 1_000_000
/** A caixa de mensagens é lida pela tela: a origem que demora não pode prender a lista. */
const MESSAGES_TIMEOUT_MS = 3_000

/**
 * 🔌 O CLIENTE DA ORIGEM (as rotas `/connect/<projeto>/*` do outro gateway), com o token de conexão no
 * `X-Tool-Authorization`. A conexão sai DAQUI: a origem (a .4) não alcança a máquina do dev.
 */
export class RemoteClient implements IRemoteCatalog {
  private readonly base: string

  constructor(
    url: string,
    private readonly projectId: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = `${apiBase(url)}/connect/${encodeURIComponent(projectId)}`
  }

  async version(): Promise<number> {
    return (await this.get<{ version: number }>('/version')).version
  }

  changes(since: number): Promise<IRemoteChanges> {
    return this.get(`/changes?since=${since}`)
  }

  package(since?: number): Promise<IRemotePackage> {
    return this.get(`/package${since === undefined ? '' : `?since=${since}`}`, PACKAGE_TIMEOUT_MS)
  }

  async file(sha256: string): Promise<Buffer> {
    // O nome vem do pacote da origem e entra no caminho do pedido: só o que é um sha256.
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new RemoteRequestError(422, 'a origem mandou um arquivo com identificador inválido')
    const { base64 } = await this.get<{ base64: string }>(`/files/${sha256}`)
    return Buffer.from(base64, 'base64')
  }

  ledger(agentId: string): IRemoteLedger {
    const base = `/ledger/${encodeURIComponent(agentId)}`
    return {
      index: () => this.get(base),
      context: (topic) => this.get(`${base}/contexts/${encodeURIComponent(topic)}`),
      search: (query) => this.get(`${base}/search?q=${encodeURIComponent(query)}`),
      write: (change: ILedgerWrite, conversationId?: string) => this.get(`${base}/write`, TIMEOUT_MS, { change, ...(conversationId ? { conversationId } : {}) }),
    }
  }

  usage(rows: readonly TRemoteUsageInput[]): Promise<{ received: number }> {
    return this.get('/usage', TIMEOUT_MS, { rows })
  }

  messages(archived = false): Promise<{ threads: IPersonThread[]; unread: number; pending: number }> {
    return this.call('GET', `/messages${archived ? '?archived=1' : ''}`, MESSAGES_TIMEOUT_MS)
  }

  message(key: string): Promise<{ messages: IPersonMessage[] }> {
    return this.call('GET', `/messages/${encodeURIComponent(key)}`, MESSAGES_TIMEOUT_MS)
  }

  readMessage(key: string): Promise<{ unread: number }> {
    return this.call('POST', `/messages/${encodeURIComponent(key)}/read`, MESSAGES_TIMEOUT_MS, {})
  }

  archiveMessage(key: string, archived: boolean): Promise<{ unread: number }> {
    return this.call('PUT', `/messages/${encodeURIComponent(key)}/archive`, MESSAGES_TIMEOUT_MS, { archived })
  }

  setMessageStatus(key: string, messageId: string, status: 'resolved' | 'pending'): Promise<{ status: string; pending: number }> {
    return this.call('PUT', `/messages/${encodeURIComponent(key)}/${encodeURIComponent(messageId)}/status`, MESSAGES_TIMEOUT_MS, { status })
  }

  replyMessage(key: string, message: string, replyTo?: string): Promise<{ queued: boolean }> {
    return this.call('POST', `/messages/${encodeURIComponent(key)}/reply`, TIMEOUT_MS, { message, ...(replyTo ? { replyTo } : {}) })
  }

  async events(handlers: ((version: number) => void) | IRemoteEventHandlers, signal: AbortSignal): Promise<void> {
    const on: IRemoteEventHandlers = typeof handlers === 'function' ? { onVersion: handlers } : handlers
    const res = await this.request('/events', signal)
    if (!res.body) throw new RemoteUnavailableError('a origem fechou o aviso ao vivo')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let end = buffer.indexOf('\n\n')
      while (end >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = /^data: (.*)$/m.exec(frame)?.[1]
        if (data) dispatch(frame, data, on)
        end = buffer.indexOf('\n\n')
      }
      // ⛔ Um aviso tem dezenas de bytes: o fluxo que nunca fecha um quadro não cresce na memória daqui.
      if (buffer.length > MAX_EVENT_FRAME) {
        await reader.cancel().catch(() => undefined)
        throw new RemoteUnavailableError('a origem mandou um aviso ao vivo inválido')
      }
    }
  }

  private get<T>(path: string, timeoutMs = TIMEOUT_MS, body?: unknown): Promise<T> {
    return this.call(body === undefined ? 'GET' : 'POST', path, timeoutMs, body)
  }

  private async call<T>(method: 'GET' | 'POST' | 'PUT', path: string, timeoutMs: number, body?: unknown): Promise<T> {
    const res = await this.request(path, AbortSignal.timeout(timeoutMs), body, method)
    const text = await res.text().catch(() => '')
    let envelope: { ok?: boolean; result?: T; message?: string; code?: string; details?: unknown } | undefined
    try {
      envelope = JSON.parse(text, (key, value) => (DATE_KEYS.has(key) && typeof value === 'string' ? new Date(value) : value))
    } catch {
      envelope = undefined
    }
    // ⚖️ O 404 do portão da origem tem o código da conexão: é credencial, não "não achei".
    if (envelope?.code === 'connection_unauthorized')
      throw new RemoteUnauthorizedError(`a origem não libera o projeto ${this.projectId} para este token (a conta saiu do projeto?)`)
    if (envelope?.ok) return envelope.result as T
    if (!envelope || res.status >= 500) throw new RemoteUnavailableError(envelope?.message ?? `a origem respondeu ${res.status}`)
    throw new RemoteRequestError(res.status, envelope.message ?? `a origem respondeu ${res.status}`, envelope.details)
  }

  private async request(path: string, signal: AbortSignal, body?: unknown, method: 'GET' | 'POST' | 'PUT' = body === undefined ? 'GET' : 'POST'): Promise<Response> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          'X-Tool-Authorization': `Bearer ${this.token}`,
          Accept: path === '/events' ? 'text/event-stream' : 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // ⛔ O token vai num cabeçalho nosso, que o `fetch` NÃO tira ao seguir um redirecionamento: não segue.
        redirect: 'manual',
        signal,
      })
    } catch (error) {
      throw new RemoteUnavailableError(`a origem não respondeu (${error instanceof Error ? error.message : String(error)})`)
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined)
      throw new RemoteUnavailableError('a origem redirecionou para outro endereço: use o endereço final dela na conexão')
    }
    if (res.status === 401) {
      await res.body?.cancel().catch(() => undefined)
      throw new RemoteUnauthorizedError('o token de conexão não vale mais (revogado, vencido ou inválido): crie outro na origem e troque aqui')
    }
    if (path === '/events' && !res.ok) {
      await res.body?.cancel().catch(() => undefined)
      if (res.status === 404) throw new RemoteUnauthorizedError(`a origem não libera o projeto ${this.projectId} para este token (a conta saiu do projeto?)`)
      throw new RemoteUnavailableError(`a origem respondeu ${res.status}`)
    }
    return res
  }
}

/** Um quadro do aviso ao vivo → o ouvinte do tipo dele (o que não é conhecido, ou veio torto, é ignorado). */
function dispatch(frame: string, data: string, on: IRemoteEventHandlers): void {
  const type = /^event: (.+)$/m.exec(frame)?.[1]
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(data) as Record<string, unknown>
  } catch {
    return
  }
  if (type === 'catalog.version') {
    const version = Number(payload.version)
    if (Number.isInteger(version)) on.onVersion?.(version)
  } else if (type === 'messages.changed') {
    const unread = Number(payload.unread)
    if (Number.isInteger(unread)) on.onMessagesChanged?.({ unread })
  } else if (type === 'message.new' && typeof payload.id === 'string' && typeof payload.key === 'string' && typeof payload.body === 'string') {
    on.onMessageNew?.(payload as unknown as IRemoteMessageNew)
  }
}

/** A URL do gateway (com ou sem `/v1`, com ou sem barra no fim) → a base da API. */
export function apiBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}
