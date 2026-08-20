import { randomUUID } from 'node:crypto'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IUsage } from '@domain/models/AgentEvent.Model'

export type TSessionStatus = 'idle' | 'running'

/**
 * Tudo que uma sessão carrega, num lugar só.
 *
 * `native` é o slot opaco onde cada adapter guarda o estado da sua própria SDK: o history
 * do provider na lane chat, o `session_id` do CLI do Claude ou os itens do `@openai/agents`
 * na lane agent. É `unknown` de propósito — o store é compartilhado pelos seis adapters, e
 * cada um lê o seu com um cast isolado num helper privado.
 */
export interface ISessionRecord {
  id: string
  agentId: string
  provider: EProvider
  mode: EMode
  model: string
  reasoning?: string
  language?: string
  /** Só na lane chat: o loop de tools feito à mão está ligado. */
  tools: boolean
  /** System prompt já composto com a instrução de idioma. Composto uma vez, na criação. */
  systemPrompt: string
  createdAt: Date
  lastActivityAt: number
  status: TSessionStatus
  turns: number
  /** Acumulado da sessão inteira. Quem soma é o AgentProvider, ao repassar o stream. */
  usage: IUsage
  metadata?: Record<string, unknown>
  abort?: AbortController
  native?: unknown
}

export type TSessionSeed = Omit<ISessionRecord, 'id' | 'createdAt' | 'lastActivityAt' | 'status' | 'turns' | 'usage'>

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
 * É uma instância só para todo o gateway: é ela que sabe de que agente e de que lane é cada
 * sessão, e por isso o `agentId` não precisa mais viajar no path da requisição.
 *
 * Não há timer: a varredura acontece nas escritas e leituras, o que evita segurar o event
 * loop de pé só para expirar sessão.
 */
export class SessionStore {
  private readonly sessions = new Map<string, ISessionRecord>()
  private readonly ttlMs: number
  private readonly maxSessions: number

  constructor(options: ISessionStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
  }

  /**
   * O id combina um prefixo legível com um UUID. O prefixo é conforto humano no log e na
   * API; o roteamento vem do registro, não do texto do id.
   */
  create(prefix: string, seed: TSessionSeed): ISessionRecord {
    this.sweep()

    const record: ISessionRecord = {
      ...seed,
      id: `${prefix}-${randomUUID()}`,
      createdAt: new Date(),
      lastActivityAt: Date.now(),
      status: 'idle',
      turns: 0,
      usage: {},
    }

    this.sessions.set(record.id, record)
    this.evictOverflow()

    return record
  }

  get(id: string): ISessionRecord | undefined {
    const record = this.sessions.get(id)
    if (!record) return undefined

    if (this.isExpired(record)) {
      this.delete(id)
      return undefined
    }

    record.lastActivityAt = Date.now()
    return record
  }

  /** Lista as sessões vivas, da mais recente para a mais antiga. */
  list(): ISessionRecord[] {
    this.sweep()
    return [...this.sessions.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  }

  /** Encerra a sessão. Abortar o que estiver em curso faz parte de encerrar. */
  delete(id: string): boolean {
    const record = this.sessions.get(id)
    if (!record) return false

    record.abort?.abort()
    return this.sessions.delete(id)
  }

  /** Soma o usage de um turno ao acumulado da sessão. */
  addUsage(record: ISessionRecord, usage: IUsage): void {
    record.usage = {
      inputTokens: sum(record.usage.inputTokens, usage.inputTokens),
      outputTokens: sum(record.usage.outputTokens, usage.outputTokens),
      reasoningTokens: sum(record.usage.reasoningTokens, usage.reasoningTokens),
    }
  }

  get size(): number {
    return this.sessions.size
  }

  private isExpired(record: ISessionRecord): boolean {
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

function sum(current: number | undefined, addition: number | undefined): number | undefined {
  if (current === undefined && addition === undefined) return undefined
  return (current ?? 0) + (addition ?? 0)
}
