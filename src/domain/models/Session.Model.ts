import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IUsage } from '@domain/models/AgentEvent.Model'

export type TSessionStatus = 'idle' | 'running'

/**
 * A sessão como o domínio a conhece: identidade, configuração e estado observável.
 *
 * Deliberadamente sem `systemPrompt`, `abort` e `native` — esses são maquinário do adapter
 * (o prompt já composto, o AbortController do turno em curso e o estado interno da SDK). O
 * registro completo vive em `@infra/session/Session.Store`, e é o adapter que mapeia um no
 * outro. Foi confundir os dois que inverteu a seta da dependência aqui antes.
 */
export interface ISession {
  id: string
  agentId: string
  provider: EProvider
  mode: EMode
  model: string
  reasoning?: string
  language?: string
  /** Só na lane chat: o loop de tools feito à mão está ligado. */
  tools: boolean
  status: TSessionStatus
  turns: number
  /** Acumulado da sessão inteira. */
  usage: IUsage
  createdAt: Date
  lastActivityAt: Date
  metadata?: Record<string, unknown>
}
