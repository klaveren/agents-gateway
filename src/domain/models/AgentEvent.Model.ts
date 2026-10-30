import type { TProviderFailure } from '@domain/Provider.Failure'

export type TAgentEventType =
  | 'session.created'
  | 'message.started'
  | 'text.delta'
  | 'reasoning.delta'
  | 'tool.started'
  | 'tool.result'
  | 'tool.error'
  | 'usage'
  | 'warning'
  | 'message.completed'
  | 'message.aborted'
  | 'message.injected'
  | 'session.completed'
  | 'error'

export interface IUsage {
  /** TODA a entrada do turno, cache incluído — o mesmo significado em todos os providers. */
  inputTokens?: number
  /** Só a saída VISÍVEL. O raciocínio vem à parte, em `reasoningTokens`, em todos os providers. */
  outputTokens?: number
  reasoningTokens?: number
  /** Parcela de `inputTokens` lida do cache — em geral cobrada a uma fração do preço de entrada. */
  cacheReadTokens?: number
  /** Parcela de `inputTokens` gravada no cache neste turno — em alguns providers, cobrada ACIMA da entrada. */
  cacheWriteTokens?: number
  /**
   * O CONTEXTO EM USO: a entrada (cache incluído) da chamada ao modelo que gerou este consumo.
   *
   * ⚠️ NÃO SE SOMA: um turno agêntico com cinco ferramentas faz cinco chamadas, e a soma das cinco entradas
   * não é o tamanho de contexto nenhum. No turno e na sessão vale o da ÚLTIMA chamada (`addUsage`).
   */
  contextTokens?: number
}

const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const

/**
 * Soma dois consumos, campo a campo — a mesma conta no turno e no acumulado da sessão.
 *
 * Campo que nenhum dos dois traz fica de fora, em vez de virar `undefined` ou zero: um provider
 * que não informa raciocínio não passa a ter "0 de raciocínio".
 */
export function addUsage(current: IUsage, addition: IUsage): IUsage {
  const total: IUsage = {}

  for (const field of USAGE_FIELDS) {
    if (current[field] === undefined && addition[field] === undefined) continue
    total[field] = (current[field] ?? 0) + (addition[field] ?? 0)
  }
  // O contexto é o da chamada mais recente que o informou, nunca a soma.
  const context = addition.contextTokens ?? current.contextTokens
  if (context !== undefined) total.contextTokens = context

  return total
}

export type IAgentEvent =
  | { type: 'session.created'; sessionId: string; timestamp: Date; payload?: never }
  | { type: 'message.started'; sessionId: string; timestamp: Date; payload?: never }
  | { type: 'text.delta'; sessionId: string; timestamp: Date; payload: { text: string } }
  | { type: 'reasoning.delta'; sessionId: string; timestamp: Date; payload: { text: string } }
  | { type: 'tool.started'; sessionId: string; timestamp: Date; payload: { tool: string; args: Record<string, unknown> } }
  | { type: 'tool.result'; sessionId: string; timestamp: Date; payload: { tool: string; result: unknown } }
  | { type: 'tool.error'; sessionId: string; timestamp: Date; payload: { tool: string; message: string } }
  | { type: 'usage'; sessionId: string; timestamp: Date; payload: IUsage }
  | { type: 'warning'; sessionId: string; timestamp: Date; payload: { message: string } }
  | { type: 'message.completed'; sessionId: string; timestamp: Date; payload?: never }
  | { type: 'message.aborted'; sessionId: string; timestamp: Date; payload?: never }
  /** Uma mensagem que a pessoa mandou com o turno rodando entrou nele (ver `Interjection.Policy`). */
  | { type: 'message.injected'; sessionId: string; timestamp: Date; payload: { text: string } }
  | { type: 'session.completed'; sessionId: string; timestamp: Date; payload?: never }
  /** `kind`: por que o provedor falhou (ver `Provider.Failure`); cota e limite levam ao próximo da cadeia. */
  | { type: 'error'; sessionId: string; timestamp: Date; payload: { message: string; kind?: TProviderFailure; resetsAt?: string } }
