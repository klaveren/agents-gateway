import { ISessionRecord } from '@infra/session/Session.Store'

export interface ISessionDto {
  id: string
  agentId: string
  provider: string
  mode: string
  model: string
  reasoning?: string
  language?: string
  status: string
  turns: number
  usage: ISessionRecord['usage']
  createdAt: Date
  lastActivityAt: Date
  metadata?: Record<string, unknown>
}

/**
 * O que a API mostra de uma sessão.
 *
 * Deliberadamente sem `native` e sem `abort`: o primeiro é o estado interno da SDK (e pode
 * conter a conversa inteira), o segundo não é serializável.
 */
export function toSessionDto(record: ISessionRecord): ISessionDto {
  return {
    id: record.id,
    agentId: record.agentId,
    provider: record.provider,
    mode: record.mode,
    model: record.model,
    reasoning: record.reasoning,
    language: record.language,
    status: record.status,
    turns: record.turns,
    usage: record.usage,
    createdAt: record.createdAt,
    lastActivityAt: new Date(record.lastActivityAt),
    metadata: record.metadata,
  }
}
