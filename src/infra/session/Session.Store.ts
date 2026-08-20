import { randomUUID } from 'node:crypto'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'

/**
 * Tudo que uma sessão precisa carregar, em um lugar só.
 *
 * `native` é o slot opaco onde cada adapter guarda o estado da sua própria SDK:
 * o history do provider na lane chat, o `session_id` do CLI do Claude ou a lista
 * de itens do `@openai/agents` na lane agent.
 */
export interface ISessionRecord<TNative = unknown> {
  id: string
  agentId: string
  provider: EProvider
  mode: EMode
  model: string
  reasoning?: string
  /** System prompt já composto com a instrução de idioma. Composto uma vez, na criação. */
  systemPrompt: string
  createdAt: Date
  lastActivityAt: number
  metadata?: Record<string, unknown>
  abort?: AbortController
  native?: TNative
}

export type TSessionSeed<TNative> = Omit<ISessionRecord<TNative>, 'id' | 'createdAt' | 'lastActivityAt'>

export interface ISessionStoreOptions {
  /** Tempo sem atividade após o qual a sessão é descartada. Default: 1h. */
  ttlMs?: number
  /** Teto de sessões vivas; ao estourar, a menos ativa sai. Default: 500. */
  maxSessions?: number
}

const DEFAULT_TTL_MS = 60 * 60 * 1000
const DEFAULT_MAX_SESSIONS = 500

/**
 * Guarda de sessões em memória, com TTL e teto.
 *
 * Não há timer: a varredura acontece nas escritas e leituras, o que evita segurar
 * o event loop de pé só para expirar sessão.
 */
export class SessionStore<TNative = unknown> {
  private readonly sessions = new Map<string, ISessionRecord<TNative>>()
  private readonly ttlMs: number
  private readonly maxSessions: number

  constructor(options: ISessionStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
  }

  /**
   * O id combina um prefixo legível com um UUID. O prefixo mantém o log e a API
   * inteligíveis; o UUID mata a colisão que `Date.now()` produzia quando duas
   * sessões nasciam no mesmo milissegundo.
   */
  create(prefix: string, seed: TSessionSeed<TNative>): ISessionRecord<TNative> {
    this.sweep()

    const record: ISessionRecord<TNative> = {
      ...seed,
      id: `${prefix}-${randomUUID()}`,
      createdAt: new Date(),
      lastActivityAt: Date.now(),
    }

    this.sessions.set(record.id, record)
    this.evictOverflow()

    return record
  }

  get(id: string): ISessionRecord<TNative> | undefined {
    const record = this.sessions.get(id)
    if (!record) return undefined

    if (this.isExpired(record)) {
      this.delete(id)
      return undefined
    }

    record.lastActivityAt = Date.now()
    return record
  }

  /** Igual ao `get`, mas falha alto — os adapters não têm o que fazer sem a sessão. */
  require(id: string): ISessionRecord<TNative> {
    const record = this.get(id)
    if (!record) throw new Error(`Session not found: ${id}`)
    return record
  }

  delete(id: string): void {
    const record = this.sessions.get(id)
    record?.abort?.abort()
    this.sessions.delete(id)
  }

  get size(): number {
    return this.sessions.size
  }

  private isExpired(record: ISessionRecord<TNative>): boolean {
    return Date.now() - record.lastActivityAt > this.ttlMs
  }

  private sweep(): void {
    for (const [id, record] of this.sessions) {
      if (this.isExpired(record)) this.delete(id)
    }
  }

  private evictOverflow(): void {
    if (this.sessions.size <= this.maxSessions) return

    const byActivity = [...this.sessions.values()].sort((a, b) => a.lastActivityAt - b.lastActivityAt)
    for (const record of byActivity.slice(0, this.sessions.size - this.maxSessions)) {
      this.delete(record.id)
    }
  }
}
