import { ISession } from '@domain/models/Session.Model'

export interface ISessionDto {
  id: string
  agentId: string
  provider: string
  mode: string
  model: string
  reasoning?: string
  language?: string
  tools: boolean
  status: string
  turns: number
  usage: ISession['usage']
  createdAt: Date
  lastActivityAt: Date
  metadata?: Record<string, unknown>
}

/**
 * O que a API mostra de uma sessão.
 *
 * Parte de `ISession`, que já exclui o maquinário do adapter (`native`, `abort`, o prompt
 * composto). Aqui só resta a forma de saída da API.
 */
export function toSessionDto(record: ISession): ISessionDto {
  return {
    id: record.id,
    agentId: record.agentId,
    provider: record.provider,
    mode: record.mode,
    model: record.model,
    reasoning: record.reasoning,
    language: record.language,
    tools: record.tools,
    status: record.status,
    turns: record.turns,
    usage: record.usage,
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
    metadata: record.metadata,
  }
}
