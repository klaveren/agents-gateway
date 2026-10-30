import { IAgentEvent } from '@domain/models/AgentEvent.Model'

/** O turno em curso, para quem chega no meio: a pergunta e o que já saiu (os pedaços de texto já juntados). */
export interface ILiveTurnSnapshot {
  request: string
  startedAt: Date
  events: IAgentEvent[]
}

export type TLiveTurnSignal = { type: 'turn.started'; turn: ILiveTurnSnapshot } | { type: 'turn.event'; event: IAgentEvent } | { type: 'turn.finished' }

/**
 * O TURNO AO VIVO, por conversa: venha da tela, da API, de um agendamento ou de uma delegação, quem abre a conversa
 * vê o turno andando. Os eventos chegam aqui já mascarados (ver `SendMessage.Usecase`).
 *
 * ⛔ NÃO FILTRA POR DONO, como o barramento das conversas: quem repassa para fora (a rota SSE) decide.
 */
export interface ITurnLive {
  /** Começa o turno. Devolve a ficha que o encerra: o fim atrasado de um turno não encerra o seguinte. */
  start(sessionId: string, request: string, metadata?: Record<string, unknown>): number
  push(sessionId: string, event: IAgentEvent): void
  finish(sessionId: string, ticket: number): void
  snapshot(sessionId: string): ILiveTurnSnapshot | undefined
  /** Devolve quem cancela a assinatura. */
  subscribe(sessionId: string, listener: (signal: TLiveTurnSignal) => void): () => void
  /** As conversas com turno em curso, com o `metadata` (para a caixa de entrada filtrar por dono). */
  running(): Array<{ sessionId: string; metadata?: Record<string, unknown> }>
}
