import { EMode } from '@domain/enums/EMode.Enum'
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
  /** O provider configurado (`claude`, `openai`, `google` ou o id de um compatível). */
  provider: string
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
  /**
   * O mesmo acumulado, por provider + modelo (`usageKey`): com troca no meio da conversa, é o que deixa
   * o custo certo — o mesmo modelo custa diferente na API e na assinatura.
   */
  usageByModel?: Record<string, IUsage>
  /** A sessão trocou de provider e o próximo turno leva a transcrição (ver `Handoff.Policy`). */
  handoff?: boolean
  createdAt: Date
  lastActivityAt: Date
  metadata?: Record<string, unknown>
}

/**
 * A chave do uso por modelo: `provider|modelo`. ⚖️ `|`, e não `/`: id de modelo de compatível tem barra
 * (`anthropic/claude-…` no OpenRouter). Chave sem `|` é do formato de antes — só o modelo, do provider
 * da conversa.
 */
export function usageKey(provider: string, model: string): string {
  return `${provider}|${model}`
}

export function parseUsageKey(key: string, fallbackProvider: string): { provider: string; model: string } {
  const at = key.indexOf('|')
  return at < 0 ? { provider: fallbackProvider, model: key } : { provider: key.slice(0, at), model: key.slice(at + 1) }
}
